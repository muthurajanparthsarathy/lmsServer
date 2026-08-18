// Course Setup list — equivalence harness for the server-paginated mapping list.
//
//     node scripts/verifyCourseSetupPagination.js
//     node scripts/verifyCourseSetupPagination.js --institution=<objectId>
//     node scripts/verifyCourseSetupPagination.js --limit=10 --verbose
//
// Reads only. It rebuilds Course Setup's OWN client-side pipeline — groupCourses
// (components/mappingTree.ts), courseStatusFor / progressFor / configuredCount
// (coursestructure/page.tsx), and MappingList's `filtered` / `sorted` / slice
// memos — over the full legacy list, then calls getMappingsPaginated for the
// same filter set and asserts the two select the same rows.
//
// The predicate copied here is the one being REPLACED, so this file is the only
// remaining record of it. Every check compares:
//   • the row count for the filter (the list's `totalRows`)
//   • the id order of page 1 (and of a deep page, where the set is big enough)
//   • the four whole-set header numbers, which one page cannot produce
//
// Ordering mismatches are classified: an "order" failure means the rows differ,
// a "tie-order" note means the same rows came back in a different order WITHIN a
// group of equal sort values. Ties are expected on the derived sorts only if
// something has drifted — the ranking is positional and should be exact.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const ServiceMapping = require("../models/ServiceMappingModel");
const CourseStructure = require("../models/Courses/courseStructureModal");
require("../models/ClientManagementModel");
const {
  getMappingsPaginated,
  getSetupProgress,
} = require("../controllers/serviceMappingController");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const INSTITUTION = arg("institution", "");
const LIMIT = Number(arg("limit", 10)) || 10;
const VERBOSE = process.argv.includes("--verbose");

// ─── The client-side pipeline, transcribed ───────────────────────────────────

const PATH_SEP = " ▸ ";
const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

// components/mappingTree.ts — one group per (path, name); blank names dropped.
const groupCourses = (mapping) => {
  const byKey = new Map();
  (mapping.courses || []).forEach((c) => {
    const name = String((c && c.courseName) || "").trim();
    if (!name) return;
    const p = String((c && c.path) || "").trim();
    const key = `${p.toLowerCase()}::${name.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, { key, path: p, courseName: name });
  });
  return [...byKey.values()];
};

// page.tsx — courseStatusFor.
const makeCourseStatusFor = (records) => {
  const byKey = new Map();
  records.forEach((c) => {
    const name = norm(c.courseName);
    const id = String(c._id || c.id || "");
    if (!name || !id) return;
    const client = String(c.clientId || "").trim();
    const recordMappingId = String(c.mappingId || "").trim();
    const recordPath = norm(c.coursePath);
    if (recordMappingId && recordPath) {
      byKey.set(`${client}::${recordMappingId}::${recordPath}::${name}`, { id });
      return;
    }
    byKey.set(
      recordMappingId ? `${client}::${recordMappingId}::${name}` : `${client}::${name}`,
      { id }
    );
  });
  return (clientId, mappingId, courseName, coursePath = "") => {
    const name = norm(courseName);
    const p = norm(coursePath);
    return (
      (p ? byKey.get(`${clientId}::${mappingId}::${p}::${name}`) : undefined) ||
      byKey.get(`${clientId}::${mappingId}::${name}`) ||
      byKey.get(`${clientId}::${name}`) ||
      null
    );
  };
};

const clientIdOf = (m) => (typeof m.client === "string" ? m.client : String(m.client?._id || ""));
const clientNameOf = (m) => (typeof m.client === "string" ? "" : m.client?.clientCompany || "N/A");

// mappingPresentation.tsx — statusOf.
const statusOf = (configured, total) => {
  if (total === 0) return "no-courses";
  if (configured >= total) return "configured";
  if (configured === 0) return "not-started";
  return "in-progress";
};
const STATUS_ORDER = { "not-started": 0, "in-progress": 1, configured: 2, "no-courses": 3 };

// MappingList.tsx — dateCutoff. `now` is passed in so the harness and the
// request it checks use ONE clock; taken twice, a run straddling midnight (or
// just a slow request) would compare two different "last 7 days".
const dateCutoff = (d, now) => {
  const day = 86400000;
  if (d === "7") return now - 7 * day;
  if (d === "30") return now - 30 * day;
  if (d === "90") return now - 90 * day;
  if (d === "year") return new Date(new Date(now).getFullYear(), 0, 1).getTime();
  return 0;
};

// MappingList.tsx — `filtered`.
const applyFilters = (rowVMs, search, filters, now) => {
  const q = String(search || "").trim().toLowerCase();
  const cut = dateCutoff(filters.date || "", now);
  return rowVMs.filter((r) => {
    if (filters.client && clientIdOf(r.mapping) !== filters.client) return false;
    if (filters.service && r.service !== filters.service) return false;
    if (filters.model && !r.models.includes(filters.model)) return false;
    if (filters.course && !r.courses.some((c) => c.toLowerCase() === filters.course)) return false;
    if (filters.year && r.year !== filters.year) return false;
    if (filters.status && r.status !== filters.status) return false;
    if (cut) {
      const created = r.mapping.createdAt ? new Date(r.mapping.createdAt).getTime() : 0;
      if (!created || created < cut) return false;
    }
    if (q) {
      const hay = [r.clientName, r.serviceCode, r.service, r.year, ...r.models, ...r.courses]
        .filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
};

// MappingList.tsx — `sorted`. Note DESC reverses the array (ties included)
// rather than negating the comparator.
const sortValue = (r, sortKey) => {
  switch (sortKey) {
    case "client": return r.clientName.toLowerCase();
    case "model": return (r.models[0] || "").toLowerCase();
    case "year": return r.year;
    case "status": return STATUS_ORDER[r.status];
    case "progress": return r.total ? r.configured / r.total : -1;
    case "updated": return r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
    default: return "";
  }
};
const applySort = (filtered, sortKey, sortDir) => {
  if (!sortKey) return filtered;
  const arr = [...filtered].sort((a, b) => {
    const va = sortValue(a, sortKey), vb = sortValue(b, sortKey);
    if (typeof va === "number" && typeof vb === "number") return va - vb;
    return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
  });
  return sortDir === "asc" ? arr : arr.reverse();
};

// ─── Calling the endpoint without a server ───────────────────────────────────

const callEndpoint = async (institutionId, query) => {
  let captured = null;
  const res = {
    status() { return this; },
    json(body) { captured = body; return this; },
  };
  await getMappingsPaginated({ query }, res, institutionId);
  if (!captured) throw new Error("endpoint returned nothing");
  return captured;
};

// ─── Runner ──────────────────────────────────────────────────────────────────

const results = { pass: 0, fail: 0, notes: [] };

const idsOf = (rows) => rows.map((r) => String(r._id));

const check = (name, expected, actual, tieKeyOf) => {
  const same = expected.length === actual.length && expected.every((id, i) => id === actual[i]);
  if (same) {
    results.pass++;
    if (VERBOSE) console.log(`  ok   ${name}`);
    return true;
  }
  // Same rows, different order? Then say whether every disagreement sits
  // inside a run of equal sort values, which is a tie-break difference rather
  // than a wrong selection.
  const sameSet =
    expected.length === actual.length &&
    [...expected].sort().join() === [...actual].sort().join();
  if (sameSet && tieKeyOf) {
    const tiesOnly = expected.every((id, i) => tieKeyOf(id) === tieKeyOf(actual[i]));
    if (tiesOnly) {
      results.pass++;
      results.notes.push(`${name}: same rows, tie-order differs (equal sort values)`);
      if (VERBOSE) console.log(`  ok*  ${name} (tie-order)`);
      return true;
    }
  }
  results.fail++;
  console.log(`  FAIL ${name}`);
  console.log(`       client: ${expected.length} rows ${JSON.stringify(expected.slice(0, 6))}`);
  console.log(`       server: ${actual.length} rows ${JSON.stringify(actual.slice(0, 6))}`);
  return false;
};

const eq = (name, expected, actual) => {
  if (expected === actual) {
    results.pass++;
    if (VERBOSE) console.log(`  ok   ${name} = ${actual}`);
    return;
  }
  results.fail++;
  console.log(`  FAIL ${name}: client ${expected} vs server ${actual}`);
};

const run = async () => {
  if (!process.env.MONGOURI) throw new Error("MONGOURI not found in server/.env");
  await mongoose.connect(process.env.MONGOURI);

  let institutionId = INSTITUTION;
  if (!institutionId) {
    const [busiest] = await ServiceMapping.aggregate([
      { $group: { _id: "$institution", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ]);
    if (!busiest) throw new Error("no service mappings found in any institution");
    institutionId = String(busiest._id);
  }

  // ── The full list, exactly as the legacy path serves it ──
  const mappings = await ServiceMapping.find({ institution: institutionId })
    .populate("client", "clientCompany status type")
    .populate("partnerInstitutions", "clientCompany status type")
    .sort({ createdAt: -1 })
    .lean();

  // ── The course-structure summary the page pairs it with ──
  const records = await CourseStructure.find({ institution: institutionId })
    .select("courseName clientId mappingId coursePath")
    .lean();

  console.log(`\nInstitution ${institutionId}`);
  console.log(`${mappings.length} mapping(s), ${records.length} course-structure record(s)`);
  console.log(`legacy payload ${Buffer.byteLength(JSON.stringify(mappings))} bytes\n`);

  if (!mappings.length) {
    console.log("Nothing to compare.");
    await mongoose.disconnect();
    return;
  }

  const courseStatusFor = makeCourseStatusFor(records);

  // ── rowVMs, as MappingList builds them ──
  const rowVMs = mappings.map((m) => {
    const groups = groupCourses(m);
    const cid = clientIdOf(m);
    let configured = 0;
    groups.forEach((g) => {
      if (courseStatusFor(cid, String(m._id), g.courseName, g.path)) configured++;
    });
    const courses = [...new Set(groups.map((g) => g.courseName.trim()).filter(Boolean))];
    return {
      mapping: m,
      id: String(m._id),
      clientName: clientNameOf(m) || "N/A",
      serviceCode: m.serviceCode || "",
      service: m.service || "",
      models: (m.serviceModels || []).filter(Boolean),
      year: m.year || "",
      status: statusOf(configured, groups.length),
      configured,
      total: groups.length,
      updatedAt: m.updatedAt || m.createdAt,
      courses,
    };
  });
  const vmById = new Map(rowVMs.map((r) => [r.id, r]));

  // ── The four header numbers ──
  const clientTotalCourses = rowVMs.reduce((n, r) => n + r.total, 0);
  const clientConfigured = (() => {
    const seen = new Set();
    mappings.forEach((m) => {
      const cid = clientIdOf(m);
      groupCourses(m).forEach((g) => {
        const s = courseStatusFor(cid, String(m._id), g.courseName, g.path);
        if (s) seen.add(s.id);
      });
    });
    return seen.size;
  })();

  console.log("── whole-set totals ──");
  const progress = await getSetupProgress(institutionId);
  eq("stats.mappings", mappings.length, progress.byMapping.size);
  eq("stats.courses (totalCourses)", clientTotalCourses, progress.totalCourses);
  eq("stats.configured (configuredCount)", clientConfigured, progress.configuredCount);

  // Per-mapping progress, row by row — the thing every status and bar reads.
  let progressMismatches = 0;
  rowVMs.forEach((r) => {
    const p = progress.byMapping.get(r.id) || { configured: 0, total: 0 };
    if (p.configured !== r.configured || p.total !== r.total) {
      progressMismatches++;
      console.log(
        `  FAIL progress ${r.id} (${r.clientName} / ${r.service}): ` +
        `client ${r.configured}/${r.total} vs server ${p.configured}/${p.total}`
      );
    }
  });
  if (progressMismatches === 0) {
    results.pass++;
    console.log(`  ok   per-mapping progress identical across all ${rowVMs.length} rows`);
  } else {
    results.fail++;
  }

  // ── Filter values worth probing, taken from the live data ──
  const pick = (arr, n) => [...new Set(arr.filter(Boolean))].slice(0, n);
  const clients = pick(mappings.map(clientIdOf), 2);
  const services = pick(mappings.map((m) => m.service), 2);
  const models = pick(mappings.flatMap((m) => m.serviceModels || []), 2);
  const years = pick(mappings.map((m) => m.year), 2);
  const courseNames = pick(rowVMs.flatMap((r) => r.courses), 2);

  // Search probes: a fragment of each searchable field, plus one that
  // straddles two of them (client name + service), which a per-field $or
  // could not satisfy.
  const frag = (s, n = 4) => String(s || "").trim().slice(0, n);
  // Straddles — a query spanning the boundary between two adjacent fields of
  // the joined haystack. These are the ones a per-field $or could not match,
  // so they have to come back NON-EMPTY to prove anything; the pairs below are
  // built from a real row, in the order the page joins them
  // (clientName, serviceCode, service, year, …models, …courses).
  const straddles = [];
  const src = rowVMs.find((x) => x.serviceCode && x.service && x.year);
  if (src) {
    straddles.push(`${src.serviceCode.slice(-2)} ${src.service.slice(0, 3)}`);
    straddles.push(`${src.service.slice(-3)} ${src.year.slice(0, 2)}`);
  }
  const withModel = rowVMs.find((x) => x.year && x.models.length);
  if (withModel) straddles.push(`${withModel.year.slice(-2)} ${withModel.models[0].slice(0, 3)}`);

  const searches = pick([
    frag(rowVMs[0]?.clientName),
    frag(rowVMs.find((r) => r.serviceCode)?.serviceCode, 6),
    frag(rowVMs[0]?.service),
    frag(models[0]),
    frag(courseNames[0], 5),
    frag(rowVMs[0]?.year, 4),
    ...straddles,
  ], 10);

  const cases = [];
  const F = (over = {}) => ({ client: "", service: "", model: "", course: "", year: "", status: "", date: "", ...over });

  cases.push({ name: "baseline (no filter, no sort)", search: "", filters: F(), sortKey: null, sortDir: "asc" });
  clients.forEach((c, i) => cases.push({ name: `filter client #${i + 1}`, search: "", filters: F({ client: c }), sortKey: null, sortDir: "asc" }));
  services.forEach((s, i) => cases.push({ name: `filter service "${s}"`, search: "", filters: F({ service: s }), sortKey: null, sortDir: "asc" }));
  models.forEach((s, i) => cases.push({ name: `filter model "${s}"`, search: "", filters: F({ model: s }), sortKey: null, sortDir: "asc" }));
  years.forEach((y, i) => cases.push({ name: `filter year "${y}"`, search: "", filters: F({ year: y }), sortKey: null, sortDir: "asc" }));
  courseNames.forEach((c) => cases.push({ name: `filter course "${c}"`, search: "", filters: F({ course: c.toLowerCase() }), sortKey: null, sortDir: "asc" }));
  ["configured", "in-progress", "not-started", "no-courses"].forEach((s) =>
    cases.push({ name: `filter setup status "${s}"`, search: "", filters: F({ status: s }), sortKey: null, sortDir: "asc" }));
  ["7", "30", "90", "year"].forEach((d) =>
    cases.push({ name: `filter created "${d}"`, search: "", filters: F({ date: d }), sortKey: null, sortDir: "asc" }));
  searches.forEach((q, i) => cases.push({
    name: `search "${q}"`,
    search: q,
    filters: F(),
    sortKey: null,
    sortDir: "asc",
    // A straddle that matches nothing on BOTH sides agrees vacuously and
    // proves nothing about cross-field search, so it is called out.
    mustMatch: straddles.includes(q),
  }));

  ["client", "model", "year", "status", "progress", "updated"].forEach((k) => {
    ["asc", "desc"].forEach((d) =>
      cases.push({ name: `sort ${k} ${d}`, search: "", filters: F(), sortKey: k, sortDir: d }));
  });

  // Combinations — a filter and a sort together, and a search inside a filter.
  if (clients[0]) cases.push({ name: "client + sort status desc", search: "", filters: F({ client: clients[0] }), sortKey: "status", sortDir: "desc" });
  if (services[0] && searches[0]) cases.push({ name: "service + search", search: searches[0], filters: F({ service: services[0] }), sortKey: "client", sortDir: "asc" });
  if (courseNames[0]) cases.push({ name: "course + sort progress asc", search: "", filters: F({ course: courseNames[0].toLowerCase() }), sortKey: "progress", sortDir: "asc" });

  console.log("\n── filter / sort / page equivalence ──");
  for (const c of cases) {
    // ONE clock for both sides (see dateCutoff).
    const now = Date.now();
    const expected = applySort(applyFilters(rowVMs, c.search, c.filters, now), c.sortKey, c.sortDir);
    const cut = dateCutoff(c.filters.date || "", now);

    const query = { page: "1", limit: String(LIMIT), setup: "1" };
    if (c.search) { query.search = c.search; query.searchScope = "setup"; }
    if (c.filters.client) query.client = c.filters.client;
    if (c.filters.service) query.service = c.filters.service;
    if (c.filters.model) query.serviceModel = c.filters.model;
    if (c.filters.course) query.course = c.filters.course;
    if (c.filters.year) query.year = c.filters.year;
    if (c.filters.status) query.setupStatus = c.filters.status;
    if (cut) query.createdAfter = String(cut);
    if (c.sortKey) {
      query.sortKey = c.sortKey === "status" ? "setupStatus" : c.sortKey;
      query.sortDir = c.sortDir;
      // The list reverses the sorted array for descending, ties included.
      query.sortTies = "reverse";
    }

    const body = await callEndpoint(institutionId, query);
    eq(`${c.name} — total`, expected.length, body.total);
    if (c.mustMatch && expected.length === 0) {
      results.fail++;
      console.log(`  FAIL ${c.name}: cross-field probe matched nothing — proves nothing`);
    }

    const tieKeyOf = c.sortKey
      ? (id) => String(sortValue(vmById.get(id) || {}, c.sortKey))
      : null;
    check(
      `${c.name} — page 1`,
      expected.slice(0, LIMIT).map((r) => r.id),
      idsOf(body.data),
      tieKeyOf
    );

    // A deep page, where the set is deep enough to have one.
    const lastPage = Math.max(1, Math.ceil(expected.length / LIMIT));
    if (lastPage > 1) {
      const deep = await callEndpoint(institutionId, { ...query, page: String(lastPage) });
      check(
        `${c.name} — page ${lastPage} (last)`,
        expected.slice((lastPage - 1) * LIMIT, lastPage * LIMIT).map((r) => r.id),
        idsOf(deep.data),
        tieKeyOf
      );
    }
  }

  // ── The Course filter's own options ──
  console.log("\n── facets ──");
  const clientCourseOptions = (() => {
    const courses = new Map();
    rowVMs.forEach((r) => r.courses.forEach((c) => {
      const key = c.toLowerCase();
      if (!courses.has(key)) courses.set(key, c);
    }));
    return [...courses.values()].sort((a, b) => a.localeCompare(b));
  })();
  const body = await callEndpoint(institutionId, { page: "1", limit: "1", setup: "1" });
  eq("facets.courses length", clientCourseOptions.length, (body.facets?.courses || []).length);
  check("facets.courses order", clientCourseOptions, body.facets?.courses || [], null);
  eq("stats.courses (response)", clientTotalCourses, body.stats?.courses);
  eq("stats.configured (response)", clientConfigured, body.stats?.configured);
  eq("stats.pending (response)", Math.max(0, clientTotalCourses - clientConfigured), body.stats?.pending);

  // ── Payload size, the reason any of this exists ──
  const pageBody = await callEndpoint(institutionId, { page: "1", limit: String(LIMIT), setup: "1" });
  console.log(
    `\nfull list ${Buffer.byteLength(JSON.stringify(mappings))} bytes` +
    ` → ${LIMIT}-row page ${Buffer.byteLength(JSON.stringify(pageBody))} bytes`
  );

  // ── The legacy path must be untouched ──
  console.log("\n── legacy path ──");
  const legacy = await callEndpoint(institutionId, { page: "1", limit: "5000" });
  eq("no `setup` param → no setupProgress on rows",
    true, legacy.data.every((r) => r.setupProgress === undefined));
  eq("no `setup` param → no stats block", true, legacy.stats === undefined);
  eq("no `setup` param → no courses facet", true, legacy.facets?.courses === undefined);

  results.notes.forEach((n) => console.log(`note: ${n}`));
  console.log(`\n${results.pass} passed, ${results.fail} failed\n`);
  await mongoose.disconnect();
  process.exit(results.fail ? 1 : 0);
};

run().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
