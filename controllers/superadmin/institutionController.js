const Institution = require("../../models/InstitutionModal");
const User = require("../../models/UserModel");
const CourseStructure = require("../../models/Courses/courseStructureModal");
const Subscription = require("../../models/superadmin/SubscriptionModel");
const InstitutionPermission = require("../../models/superadmin/InstitutionPermissionModel");

// Coerce the permission modal's payload into the embedded shape stored on the
// institution allow-list. Keeps the catalog `id` (used for client filtering).
const sanitizeInstitutionPermissions = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .filter((p) => p && p.permissionKey && p.permissionName)
    .map((p, i) => ({
      id: p.id ? String(p.id) : undefined,
      permissionName: String(p.permissionName),
      permissionKey: String(p.permissionKey),
      permissionFunctionality: Array.isArray(p.permissionFunctionality) ? p.permissionFunctionality.map(String) : [],
      icon: p.icon || "Shield",
      color: p.color || "blue",
      description: p.description || "",
      isActive: p.isActive !== false,
      order: typeof p.order === "number" ? p.order : i,
    }));

// Builds the same INSxxx sequence the existing LMS create-institution flow uses
// (controllers/institution.js) so both entry points share one id space.
const nextInstitutionId = async () => {
  const last = await Institution.findOne().sort({ inst_id: -1 }).limit(1);
  let inst_id = "INS001";
  if (last && last.inst_id) {
    const match = last.inst_id.match(/INS(\d+)/);
    if (match && match[1]) {
      inst_id = "INS" + String(parseInt(match[1], 10) + 1).padStart(3, "0");
    }
  }
  return inst_id;
};

exports.createInstitution = async (req, res) => {
  try {
    const { inst_name, inst_owner, phone, address, basedOn } = req.body;

    // address is required by the LMS-Institution schema — validate here so a
    // missing value returns a clear 400 rather than a schema-level 500.
    if (!inst_name || !inst_owner || !phone || !address) {
      return res.status(400).json({ message: [{ key: "error", value: "Name, owner, phone and address are required" }] });
    }

    const existing = await Institution.findOne({ inst_name });
    if (existing) {
      return res.status(403).json({ message: [{ key: "error", value: "Institution name already exists" }] });
    }

    const inst_id = await nextInstitutionId();
    const institution = new Institution({
      inst_id,
      inst_name,
      inst_owner,
      phone,
      address,
      basedOn,
      createdBy: req.superAdmin?.email || "superadmin",
    });
    await institution.save();

    return res.status(201).json({
      message: [{ key: "success", value: "Institution created successfully" }],
      institution,
    });
  } catch (error) {
    console.error("superadmin createInstitution error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// List + per-institution usage counts (users, courses) and subscription/status,
// computed at read time — LMS-Institution itself is never given new fields.
exports.getAllInstitutions = async (req, res) => {
  try {
    const institutions = await Institution.find().sort({ createdAt: -1 }).lean();

    const [userCounts, courseCounts, subscriptions, instPerms] = await Promise.all([
      User.aggregate([{ $group: { _id: "$institution", count: { $sum: 1 } } }]),
      CourseStructure.aggregate([{ $group: { _id: "$institution", count: { $sum: 1 } } }]),
      Subscription.find().lean(),
      InstitutionPermission.find().select("institution permissions").lean(),
    ]);

    const userCountMap = new Map(userCounts.map((u) => [String(u._id), u.count]));
    const courseCountMap = new Map(courseCounts.map((c) => [String(c._id), c.count]));
    const subscriptionMap = new Map(subscriptions.map((s) => [String(s.institution), s]));
    // Whether the institution has a permission allow-list set — gates the
    // User/Resource Management actions on the Clients page.
    const hasPermMap = new Map(instPerms.map((p) => [String(p.institution), (p.permissions || []).length > 0]));

    const enriched = institutions.map((inst) => ({
      ...inst,
      userCount: userCountMap.get(String(inst._id)) || 0,
      courseCount: courseCountMap.get(String(inst._id)) || 0,
      subscription: subscriptionMap.get(String(inst._id)) || null,
      status: subscriptionMap.get(String(inst._id))?.status || "active",
      hasPermissions: hasPermMap.get(String(inst._id)) || false,
    }));

    return res.status(200).json({
      message: [{ key: "success", value: "Institutions retrieved successfully" }],
      institutions: enriched,
    });
  } catch (error) {
    console.error("superadmin getAllInstitutions error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.getInstitutionById = async (req, res) => {
  try {
    const institution = await Institution.findById(req.params.id).lean();
    if (!institution) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }

    const [userCount, courseCount, subscription] = await Promise.all([
      User.countDocuments({ institution: institution._id }),
      CourseStructure.countDocuments({ institution: institution._id }),
      Subscription.findOne({ institution: institution._id }).lean(),
    ]);

    return res.status(200).json({
      message: [{ key: "success", value: "Institution retrieved successfully" }],
      institution: {
        ...institution,
        userCount,
        courseCount,
        subscription: subscription || null,
        status: subscription?.status || "active",
      },
    });
  } catch (error) {
    console.error("superadmin getInstitutionById error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.deleteInstitution = async (req, res) => {
  try {
    const institution = await Institution.findById(req.params.id);
    if (!institution) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }

    const userCount = await User.countDocuments({ institution: institution._id });
    if (userCount > 0) {
      return res.status(409).json({
        message: [{ key: "error", value: `Cannot delete: ${userCount} user(s) still belong to this institution` }],
      });
    }

    await Institution.findByIdAndDelete(req.params.id);
    await Subscription.deleteOne({ institution: req.params.id });

    return res.status(200).json({ message: [{ key: "success", value: "Institution deleted successfully" }] });
  } catch (error) {
    console.error("superadmin deleteInstitution error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// Active/suspended toggle — stored in the new Subscription doc, never on
// LMS-Institution itself (see architecture doc, section 4).
exports.updateInstitutionStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["active", "suspended"].includes(status)) {
      return res.status(400).json({ message: [{ key: "error", value: "status must be active or suspended" }] });
    }

    const institution = await Institution.findById(req.params.id);
    if (!institution) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }

    const subscription = await Subscription.findOneAndUpdate(
      { institution: institution._id },
      { status, institution: institution._id },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      message: [{ key: "success", value: "Institution status updated successfully" }],
      subscription,
    });
  } catch (error) {
    console.error("superadmin updateInstitutionStatus error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// GET /superadmin/institutions/:id/permissions
// Returns the institution's permission allow-list ([] if never set) so the
// Permission Management modal can preselect it and the Add User / Assign
// Permission modals can limit what they offer.
exports.getInstitutionPermissions = async (req, res) => {
  try {
    const doc = await InstitutionPermission.findOne({ institution: req.params.id }).lean();
    return res.status(200).json({
      message: [{ key: "success", value: "Institution permissions retrieved" }],
      permissions: doc?.permissions || [],
    });
  } catch (error) {
    console.error("superadmin getInstitutionPermissions error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// PUT /superadmin/institutions/:id/permissions   body: { permissions: [...] }
// Overwrites the institution's allow-list with the Permission Management
// modal's selection.
exports.updateInstitutionPermissions = async (req, res) => {
  try {
    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ message: [{ key: "error", value: "permissions[] is required" }] });
    }
    const institution = await Institution.findById(req.params.id);
    if (!institution) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }
    const doc = await InstitutionPermission.findOneAndUpdate(
      { institution: req.params.id },
      { $set: { permissions: sanitizeInstitutionPermissions(permissions), updatedBy: req.superAdmin?.email || "superadmin" } },
      { upsert: true, new: true }
    );
    return res.status(200).json({
      message: [{ key: "success", value: "Institution permissions updated" }],
      permissions: doc.permissions,
    });
  } catch (error) {
    console.error("superadmin updateInstitutionPermissions error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
