const mongoose = require("mongoose");
const ClientManagement = require("../models/ClientManagementModel");
const { pocClientFilter, scopeHasClient } = require("../utils/pocScope");

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The business models a client can be engaged under (mirrors the frontend list).
// CSR is NOT a business model — it's a service model under B2B.
const BUSINESS_MODELS = ["B2B", "B2I", "B2C"];

// ── Paginated client list ────────────────────────────────────────────────────
// A port of ClientManagementPage's own `filteredClients` / `sortedClients`
// memos, so a given filter set selects the rows it always did.
//
// The page compares with `localeCompare(undefined, { numeric: true,
// sensitivity: 'base' })`. 'base' ignores case AND accents, which is collation
// strength ONE — not the strength 2 used for the user directory, where the
// page lowercased first and accents still counted.
const CLIENT_COLLATION = { locale: "en", strength: 1, numericOrdering: true };

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `scopeMatch` is `{}` for every role except a POC, for whom it is
// `{ _id: { $in: [...] } }`. It is applied to the row filter AND to the facet
// counts below — the facets are computed over the whole institution, so
// omitting them there would leak the true client total even though the rows
// were scoped.
async function getClientsPaginated(req, res, institutionId, scopeMatch = {}) {
  const {
    page, limit, search, status, businessModel, type, since, sortKey, sortDir,
  } = req.query;

  const isExport = req.query.export === "1" || req.query.export === "true";
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const perPage = Math.min(isExport ? 5000 : 200, Math.max(1, parseInt(limit, 10) || 10));

  const filter = { institution: institutionId, ...scopeMatch };
  if (status) filter.status = status;
  if (businessModel) filter.businessModel = businessModel;
  // `type` is an array on the document; an equality match on an array field
  // matches when ANY element equals — the same as the page's `.some()`.
  if (type) filter.type = type;
  // The cutoff is computed in the BROWSER (local-time "this year" etc.) and
  // sent as an absolute instant. `$gte` also excludes documents with no
  // createdAt, matching the page's `if (!created || created < cut)`.
  const sinceMs = Number(since);
  if (Number.isFinite(sinceMs) && sinceMs > 0) {
    filter.createdAt = { $gte: new Date(sinceMs) };
  }
  const searchTerm = search ? String(search).trim() : "";

  // The page sorts a list that is ALREADY newest-first and negates the
  // comparator for descending (rather than reversing the array), so equal keys
  // keep newest-first in BOTH directions — hence a fixed tie-break here.
  const dir = sortDir === "desc" ? -1 : 1;
  const tie = { createdAt: -1, _id: -1 };
  const SORTABLE = {
    company: { clientCompany: dir, ...tie },
    model: { businessModel: dir, ...tie },
    status: { status: dir, ...tie },
  };
  // No sortKey is a real state the page returns to — the server's own order.
  const sort = SORTABLE[sortKey] || tie;

  let data;
  let total;

  if (searchTerm) {
    // The page searched a SINGLE joined string:
    //   [clientCompany, clientAddress, ...contacts(name,email,phone)]
    //     .filter(Boolean).join(' ').toLowerCase().includes(q)
    // so a query straddling two fields ("jamocha coimbatore" = company +
    // address) matched. A per-field $or cannot reproduce that — measured on
    // live data, 3 of 5 real cross-field probes returned 0 instead of 1.
    // The haystack is therefore assembled in Mongo, exactly as the page
    // assembled it, and matched as one string.
    //
    // This costs no index: an UNANCHORED regex cannot use one in either form,
    // so the per-field version was already a collection scan.
    const rx = new RegExp(escapeRegex(searchTerm), "i");
    const contactFields = {
      $reduce: {
        input: { $ifNull: ["$contactPersons", []] },
        initialValue: [],
        in: {
          $concatArrays: [
            "$$value",
            ["$$this.name", "$$this.email", "$$this.phoneNumber"],
          ],
        },
      },
    };
    const haystack = {
      $toLower: {
        $reduce: {
          input: {
            $filter: {
              input: {
                $concatArrays: [["$clientCompany", "$clientAddress"], contactFields],
              },
              // `filter(Boolean)` — drops null, undefined and "".
              cond: {
                $and: [
                  { $ne: ["$$this", null] },
                  { $ne: ["$$this", ""] },
                ],
              },
            },
          },
          initialValue: "",
          in: {
            $cond: [
              { $eq: ["$$value", ""] },
              { $toString: "$$this" },
              { $concat: ["$$value", " ", { $toString: "$$this" }] },
            ],
          },
        },
      },
    };

    // `aggregate()` does not cast a filter the way `find()` does.
    const match = ClientManagement.find(filter).cast(ClientManagement);
    const pipeline = [
      { $match: match },
      { $addFields: { _hay: haystack } },
      { $match: { _hay: rx } },
      {
        $facet: {
          rows: [
            { $sort: sort },
            { $skip: (pageNum - 1) * perPage },
            { $limit: perPage },
            { $project: { _hay: 0 } },
          ],
          count: [{ $count: "n" }],
        },
      },
    ];
    const agg = ClientManagement.aggregate(pipeline);
    if (SORTABLE[sortKey]) agg.collation(CLIENT_COLLATION);
    const [out] = await agg;
    data = out?.rows || [];
    total = out?.count?.[0]?.n || 0;
  } else {
    const query = ClientManagement.find(filter).sort(sort);
    if (SORTABLE[sortKey]) query.collation(CLIENT_COLLATION);

    [data, total] = await Promise.all([
      query.skip((pageNum - 1) * perPage).limit(perPage).lean(),
      ClientManagement.countDocuments(filter),
    ]);
  }

  if (isExport) {
    return res.status(200).json({
      success: true, count: data.length, data, total,
      page: pageNum, limit: perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  }

  // Facets the page derived from the full list: the business-model filter
  // options, and the four header chips. Both are over EVERY client in the
  // institution, not the current filter, which is what the page showed.
  const base = { institution: institutionId, ...scopeMatch };
  const [models, totalAll, activeAll] = await Promise.all([
    ClientManagement.distinct("businessModel", base),
    ClientManagement.countDocuments(base),
    ClientManagement.countDocuments({ ...base, status: "active" }),
  ]);
  const presentModels = models.filter(Boolean).sort();

  return res.status(200).json({
    success: true,
    count: data.length,
    data,
    total,
    page: pageNum,
    limit: perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    facets: {
      businessModels: presentModels,
      counts: {
        total: totalAll,
        active: activeAll,
        inactive: totalAll - activeAll,
        models: presentModels.length,
      },
    },
  });
}

// Normalize the services array coming from the client — keep only entries with a
// service name, and coerce serviceModals into a clean string array.
const normalizeServices = (services) => {
  if (!Array.isArray(services)) return [];
  const cleanStrArray = (arr) =>
    Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter(Boolean) : [];

  const str = (v) => (v ? String(v).trim() : "");

  const cleanDepartments = (departments) => {
    if (!Array.isArray(departments)) return [];
    return departments
      .map((d) => ({
        department: str(d && d.department),
        sections: cleanStrArray(d && d.sections),
        semesters: cleanStrArray(d && d.semesters),
      }))
      .filter((d) => d.department || d.sections.length || d.semesters.length);
  };

  // Each block: batch + degree + departments (each with sections + semester)
  const cleanDegreePrograms = (programs) => {
    if (!Array.isArray(programs)) return [];
    return programs
      .map((p) => ({
        batch: str(p && p.batch),
        degree: str(p && p.degree),
        departments: cleanDepartments(p && p.departments),
      }))
      .filter((p) => p.batch || p.degree || p.departments.length);
  };

  return services
    .filter((s) => s && String(s.service || "").trim())
    .map((s) => ({
      service: String(s.service).trim(),
      year: str(s.year),
      serviceModals: cleanStrArray(s.serviceModals),
      batches: cleanStrArray(s.batches),
      degreePrograms: cleanDegreePrograms(s.degreePrograms),
    }));
};

// Shared validation for contact persons
const validateContactPersons = (contactPersons) => {
  if (!Array.isArray(contactPersons) || contactPersons.length === 0) {
    return "At least one contact person is required";
  }

  const emailSet = new Set();
  for (const person of contactPersons) {
    if (!person.name || !person.email || !person.phoneNumber) {
      return "Each contact person must have name, email, and phone number";
    }
    if (!emailRegex.test(person.email)) {
      return `Invalid email format for ${person.name}`;
    }
    if (emailSet.has(person.email.toLowerCase())) {
      return `Duplicate email ${person.email} in contact persons`;
    }
    emailSet.add(person.email.toLowerCase());
  }
  return null;
};

const clientManagementController = {
  // Create a new standalone client
  createClient: async (req, res) => {
    try {
      const institutionId = req.user.institution;

      const {
        clientCompany,
        description,
        clientAddress,
        clientLogo,
        status,
        type,
        businessModel,
        services,
        contactPersons,
      } = req.body;

      if (!clientCompany || !String(clientCompany).trim()) {
        return res.status(400).json({
          success: false,
          message: "Client company name is required",
        });
      }

      if (!businessModel || !BUSINESS_MODELS.includes(businessModel)) {
        return res.status(400).json({
          success: false,
          message: "Business model is required (B2B, B2I or B2C)",
        });
      }

      const contactError = validateContactPersons(contactPersons);
      if (contactError) {
        return res.status(400).json({ success: false, message: contactError });
      }

      const typeArray = Array.isArray(type) ? type : type ? [type] : [];

      // Prevent duplicate company within the same institution
      const existing = await ClientManagement.findOne({
        institution: institutionId,
        clientCompany: new RegExp(`^${String(clientCompany).trim()}$`, "i"),
      });
      if (existing) {
        return res.status(400).json({
          success: false,
          message: `A client named "${clientCompany}" already exists`,
        });
      }

      const client = await ClientManagement.create({
        institution: institutionId,
        clientCompany: String(clientCompany).trim(),
        description: description || "",
        clientAddress: clientAddress || "",
        clientLogo: clientLogo || "",
        status: status === "inactive" ? "inactive" : "active",
        type: typeArray,
        businessModel,
        services: normalizeServices(services),
        contactPersons,
        createdBy: req.user.email,
      });

      res.status(201).json({
        success: true,
        message: "Client added successfully",
        data: client,
      });
    } catch (error) {
      console.error("Error adding client:", error);
      res.status(500).json({
        success: false,
        message: "Error adding client",
        error: error.message,
      });
    }
  },

  // Get all clients for the current institution
  getAllClients: async (req, res) => {
    try {
      const institutionId = req.user.institution;
      // `{}` for every role except a POC, which gets `{ _id: { $in: [...] } }`
      // — the clients reachable from the courses it is enrolled in. An empty
      // scope yields `$in: []`, i.e. no rows: a POC enrolled in nothing sees
      // nothing rather than the institution list.
      const scopeMatch = pocClientFilter(req.pocScope);

      // ── Paginated mode (opt-in via `page`) ────────────────────────────────
      // Without `page` this returns the whole list exactly as it always has,
      // so every other consumer is untouched. With `page`, the search, the
      // four filters and the sort all run in Mongo and one page crosses the
      // wire — the page's own predicate, ported field for field.
      if (req.query.page !== undefined) {
        return await getClientsPaginated(req, res, institutionId, scopeMatch);
      }

      // Names only. The Add/Edit form warns inline when a company name is
      // already taken, which it did by scanning the full list it happened to
      // hold. With the list paginated that check would only see one page, so
      // the form asks for just the names — two fields per client instead of a
      // whole document. (The server enforces the same rule on create/update
      // regardless; this keeps the error appearing on blur rather than only
      // after submit.)
      if (req.query.names === "1" || req.query.names === "true") {
        const names = await ClientManagement.find({ institution: institutionId, ...scopeMatch })
          .select("clientCompany")
          .lean();
        return res.status(200).json({ success: true, count: names.length, data: names });
      }

      // Read-only path — .lean() halves serialization + memory overhead on
      // the BM list; res.json only ever inspects plain values.
      const clients = await ClientManagement.find({ institution: institutionId, ...scopeMatch })
        .sort({ createdAt: -1 })
        .lean();

      res.status(200).json({
        success: true,
        count: clients.length,
        data: clients,
      });
    } catch (error) {
      console.error("Error fetching clients:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching clients",
        error: error.message,
      });
    }
  },

  // Get a single client by id
  getClientById: async (req, res) => {
    try {
      const institutionId = req.user.institution;
      const { clientId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(clientId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid client ID format",
        });
      }

      // Membership test rather than merging a filter: spreading the scope into
      // the query below would produce `{ _id: clientId, ..., _id: { $in } }`,
      // where the second key silently overwrites the first. The reply reuses
      // the existing 404 so an out-of-scope id is indistinguishable from a
      // missing one — a POC cannot probe for which clients exist.
      if (!scopeHasClient(req.pocScope, clientId)) {
        return res.status(404).json({ success: false, message: "Client not found" });
      }

      const client = await ClientManagement.findOne({
        _id: clientId,
        institution: institutionId,
      });

      if (!client) {
        return res.status(404).json({ success: false, message: "Client not found" });
      }

      res.status(200).json({ success: true, data: client });
    } catch (error) {
      console.error("Error fetching client:", error);
      res.status(500).json({
        success: false,
        message: "Error fetching client",
        error: error.message,
      });
    }
  },

  // Update a client
  updateClient: async (req, res) => {
    try {
      const institutionId = req.user.institution;
      const { clientId } = req.params;
      const updateData = req.body;

      if (!mongoose.Types.ObjectId.isValid(clientId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid client ID format",
        });
      }

      const client = await ClientManagement.findOne({
        _id: clientId,
        institution: institutionId,
      });

      if (!client) {
        return res.status(404).json({ success: false, message: "Client not found" });
      }

      if (updateData.contactPersons !== undefined) {
        const contactError = validateContactPersons(updateData.contactPersons);
        if (contactError) {
          return res.status(400).json({ success: false, message: contactError });
        }
        client.contactPersons = updateData.contactPersons;
      }

      if (updateData.clientCompany !== undefined) {
        if (!String(updateData.clientCompany).trim()) {
          return res.status(400).json({
            success: false,
            message: "Client company name is required",
          });
        }

        // Ensure no other client in this institution uses the new name
        const duplicate = await ClientManagement.findOne({
          _id: { $ne: clientId },
          institution: institutionId,
          clientCompany: new RegExp(`^${String(updateData.clientCompany).trim()}$`, "i"),
        });
        if (duplicate) {
          return res.status(400).json({
            success: false,
            message: `A client named "${updateData.clientCompany}" already exists`,
          });
        }
        client.clientCompany = String(updateData.clientCompany).trim();
      }

      if (updateData.type !== undefined) {
        client.type = Array.isArray(updateData.type)
          ? updateData.type
          : updateData.type
          ? [updateData.type]
          : [];
      }

      if (updateData.businessModel !== undefined) {
        if (!BUSINESS_MODELS.includes(updateData.businessModel)) {
          return res.status(400).json({
            success: false,
            message: "Business model must be one of B2B, B2I or B2C",
          });
        }
        client.businessModel = updateData.businessModel;
      }

      if (updateData.services !== undefined) {
        client.services = normalizeServices(updateData.services);
      }

      const editableFields = [
        "description",
        "clientAddress",
        "clientLogo",
        "status",
      ];
      editableFields.forEach((field) => {
        if (updateData[field] !== undefined) {
          client[field] = updateData[field];
        }
      });

      client.updatedBy = req.user.email;
      await client.save();

      res.status(200).json({
        success: true,
        message: "Client updated successfully",
        data: client,
      });
    } catch (error) {
      console.error("Error updating client:", error);
      res.status(500).json({
        success: false,
        message: "Error updating client",
        error: error.message,
      });
    }
  },

  // Delete a client
  deleteClient: async (req, res) => {
    try {
      const institutionId = req.user.institution;
      const { clientId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(clientId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid client ID format",
        });
      }

      const client = await ClientManagement.findOneAndDelete({
        _id: clientId,
        institution: institutionId,
      });

      if (!client) {
        return res.status(404).json({ success: false, message: "Client not found" });
      }

      res.status(200).json({ success: true, message: "Client deleted successfully" });
    } catch (error) {
      console.error("Error deleting client:", error);
      res.status(500).json({
        success: false,
        message: "Error deleting client",
        error: error.message,
      });
    }
  },

  // Toggle active / inactive status
  toggleClientStatus: async (req, res) => {
    try {
      const institutionId = req.user.institution;
      const { clientId } = req.params;

      if (!mongoose.Types.ObjectId.isValid(clientId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid client ID format",
        });
      }

      const client = await ClientManagement.findOne({
        _id: clientId,
        institution: institutionId,
      });

      if (!client) {
        return res.status(404).json({ success: false, message: "Client not found" });
      }

      client.status = client.status === "active" ? "inactive" : "active";
      client.updatedBy = req.user.email;
      await client.save();

      res.status(200).json({
        success: true,
        message: `Client ${client.status === "active" ? "activated" : "deactivated"} successfully`,
        data: {
          clientId: client._id,
          clientCompany: client.clientCompany,
          status: client.status,
        },
      });
    } catch (error) {
      console.error("Error toggling client status:", error);
      res.status(500).json({
        success: false,
        message: "Error toggling client status",
        error: error.message,
      });
    }
  },
};

module.exports = clientManagementController;
