// One-time backfill of `serviceCode` on Service Mappings that predate the field.
// Those rows render as "—" in the Service Mapping and Course Setup lists.
//
// Ids are minted by the controller's own ensureServiceCode, so a backfilled code is
// indistinguishable from one Map Service would have produced:
//
//     <business model>-<service model>-<degree>-<n>     e.g. b2i-deg-be-1
//
// Numbering is per-prefix and institution-scoped, continuing from the highest index
// already stored. Existing codes are never touched, renumbered, or reused.
//
// Mappings are processed oldest-first and written one at a time, so each new code is
// visible to the next lookup and two mappings can never claim the same index.
//
// Only the serviceCode field is written (updateOne + $set, timestamps off), so legacy
// records missing unrelated required fields can't fail validation and updatedAt does
// not move — the backfill is invisible apart from the new id.
//
// Run from the server folder. Dry run first — it writes nothing:
//     node scripts/backfillServiceCodes.js
//     node scripts/backfillServiceCodes.js --apply
//     node scripts/backfillServiceCodes.js --apply --institution=<objectId>

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const ServiceMapping = require("../models/ServiceMappingModel");
const { ensureServiceCode } = require("../controllers/serviceMappingController");

const APPLY = process.argv.includes("--apply");
const INSTITUTION = (process.argv.find((a) => a.startsWith("--institution=")) || "").split("=")[1] || "";

// A dry run writes nothing, so the stored max never moves — without simulating the
// increments in memory every mapping sharing a prefix would preview the same index.
// Keyed by institution too, since each institution numbers its prefixes separately.
const previewed = new Map();
const simulateWrite = (institutionId, code) => {
  const parsed = /^(.*)-(\d+)$/.exec(code);
  if (!parsed) return code;
  const [, prefix, n] = parsed;
  const key = `${institutionId || "none"}|${prefix}`;
  const bump = previewed.get(key) || 0;
  previewed.set(key, bump + 1);
  return `${prefix}-${Number(n) + bump}`;
};

const run = async () => {
  if (!process.env.MONGOURI) throw new Error("MONGOURI not found in server/.env");
  await mongoose.connect(process.env.MONGOURI);

  const filter = {
    $or: [{ serviceCode: { $exists: false } }, { serviceCode: "" }, { serviceCode: null }],
  };
  if (INSTITUTION) filter.institution = new mongoose.Types.ObjectId(INSTITUTION);

  // Oldest first, so the lowest index goes to the oldest mapping. _id breaks ties
  // between mappings created in the same millisecond, keeping the run repeatable.
  const mappings = await ServiceMapping.find(filter, {
    institution: 1,
    client: 1,
    service: 1,
    serviceModels: 1,
    masterData: 1,
    serviceCode: 1,
    createdAt: 1,
  })
    .populate("client", "clientCompany")
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN — nothing will be written"}`);
  console.log(`${mappings.length} mapping(s) without a service id${INSTITUTION ? ` in institution ${INSTITUTION}` : ""}\n`);
  if (!mappings.length) {
    await mongoose.disconnect();
    return;
  }

  let assigned = 0;
  const unresolved = [];

  for (const m of mappings) {
    const code = await ensureServiceCode({
      institutionId: m.institution,
      existingCode: "",
      service: m.service,
      serviceModels: m.serviceModels,
      masterData: m.masterData,
    });

    // "" means no prefix could be derived — the mapping has neither a recognisable
    // service name nor a service model, so there is nothing to build an id from.
    if (!code) {
      unresolved.push(m);
      continue;
    }

    const client = (m.client && m.client.clientCompany) || "(client missing)";
    if (APPLY) {
      await ServiceMapping.updateOne({ _id: m._id }, { $set: { serviceCode: code } }, { timestamps: false });
      console.log(`  ${code.padEnd(20)} ${client}`);
    } else {
      console.log(`  ${simulateWrite(m.institution, code).padEnd(20)} ${client}`);
    }
    assigned += 1;
  }

  console.log(`\n${assigned} assigned${APPLY ? "" : " (preview)"}, ${unresolved.length} skipped`);
  if (unresolved.length) {
    console.log("\nSkipped — no service name or service model to build an id from:");
    unresolved.forEach((m) => {
      console.log(`  ${String(m._id)}  service=${JSON.stringify(m.service || "")}  models=${JSON.stringify(m.serviceModels || [])}`);
    });
    console.log("\nGive these a service model in Map Service and re-run, or leave them at '—'.");
  }
  if (!APPLY) console.log("\nRe-run with --apply to write.");

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error("\nBackfill failed:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
