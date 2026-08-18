const crypto = require("crypto");
const InstituteHolidayCalendar = require("../models/InstituteHolidayCalendarModel");
const Institution = require("../models/InstitutionModal");

const HOLIDAY_TYPES = [
  "public",
  "optional",
  "institute",
  "exam",
  "festival",
  "other",
];
const HOLIDAY_DURATIONS = ["full", "first-half", "second-half"];

// Dates are stored as "YYYY-MM-DD" STRINGS (see the model comment: keeping them
// as strings avoids TZ shifts). Zero-padded ISO dates sort and compare
// lexicographically exactly as they do chronologically, which is what lets the
// range filter below use plain $gte/$lte string comparison.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Normalize the holidays array coming from the client (it uses `id` for the uid).
const normalizeHolidays = (holidays = []) =>
  (Array.isArray(holidays) ? holidays : []).map((h) => ({
    holidayId: h.holidayId || h.id || "",
    name: h.name || "Holiday",
    date: h.date || "",
    type: [
      "public",
      "optional",
      "institute",
      "exam",
      "festival",
      "other",
    ].includes(h.type)
      ? h.type
      : "institute",
    duration: ["full", "first-half", "second-half"].includes(h.duration)
      ? h.duration
      : "full",
    note: h.note || "",
  }));

// ─────────────────────────────────────────────────────────────────────────────
// Per-holiday write path
//
// The whole-array save above REPLACES `holidays` with whatever it receives, so
// every caller must hold the complete list in memory to save one holiday. That
// coupling is what made this document impossible to page: a partially loaded
// list plus one save silently deletes everything that wasn't loaded.
//
// The handlers below mutate ONE entry at a time with positional/$pull operators,
// so the server never needs — and never trusts — the caller's copy of the rest
// of the array. That is the precondition for scoping the read.
// ─────────────────────────────────────────────────────────────────────────────

const newHolidayId = () => crypto.randomBytes(6).toString("hex");

// The client calls the uid `id`; the stored sub-document calls it `holidayId`.
// Both spellings are accepted on the way in.
const suppliedIdOf = (h = {}) => h.holidayId || h.id || "";

const normalizeOneHoliday = (h = {}) => ({
  holidayId: suppliedIdOf(h) || newHolidayId(),
  name: h.name || "Holiday",
  date: h.date || "",
  type: HOLIDAY_TYPES.includes(h.type) ? h.type : "institute",
  duration: HOLIDAY_DURATIONS.includes(h.duration) ? h.duration : "full",
  note: h.note || "",
});

/**
 * Make sure the scope's calendar document exists and carries a current identity
 * snapshot, WITHOUT touching `holidays`.
 *
 * Same atomic upsert the whole-array save uses (concurrent first-writes for a
 * brand-new scope must not race each other into a duplicate-key 500), minus the
 * holiday write. The name/code snapshot is only $set when it actually resolved
 * to something — a failed Institution lookup must not blank an existing snapshot.
 */
const ensureCalendarDoc = async (instituteId, req) => {
  // Per-client calendars live under "<institutionId>__client__<clientId>";
  // strip the suffix before the ObjectId lookup (a no-op for institute-wide keys).
  const baseInstitutionId = String(instituteId).split("__client__")[0];

  let institute = null;
  try {
    institute = await Institution.findById(baseInstitutionId).lean();
  } catch (_) {
    institute = null;
  }

  const who = req.user?.email || req.user?.name || req.body?.createdBy || "";
  const set = { instituteId, updatedBy: who };
  const instituteName = institute?.inst_name || req.body?.instituteName || "";
  const instituteCode = institute?.inst_id || req.body?.instituteCode || "";
  if (instituteName) set.instituteName = instituteName;
  if (instituteCode) set.instituteCode = instituteCode;

  const raw = await InstituteHolidayCalendar.findOneAndUpdate(
    { instituteId },
    { $set: set, $setOnInsert: { createdBy: who } },
    { upsert: true, new: true, rawResult: true }
  );
  return raw.value;
};

// Current holiday count for a scope, read straight off the server rather than
// inferred by the client from its own (possibly range-scoped) copy.
const holidayTotalOf = async (instituteId) => {
  const [agg] = await InstituteHolidayCalendar.aggregate([
    { $match: { instituteId } },
    { $project: { total: { $size: { $ifNull: ["$holidays", []] } } } },
  ]);
  return agg?.total ?? 0;
};

/**
 * Add (or merge over) one or more holidays for a scope — never a replacement.
 *
 * Accepts `{ holiday: {...} }` or `{ holidays: [...] }` so the single-date modal
 * and the bulk-date modal share one endpoint and one round trip. Merge is keyed
 * by DATE, matching the UI's rule that a date carries at most one holiday: an
 * incoming date that already exists is updated in place, a new one is pushed.
 *
 * Each date becomes an ordered pair of ops in a single bulkWrite:
 *   1. positional $set — fires only if that date is already present
 *   2. $push guarded by `date: { $ne }` — fires only if it is not
 * Exactly one of the pair can match, so the write can neither duplicate a date
 * nor drop an entry it did not mention.
 */
exports.addInstituteHolidays = async (req, res) => {
  try {
    const { instituteId } = req.params;
    if (!instituteId) {
      return res
        .status(400)
        .json({ success: false, message: "instituteId is required" });
    }

    const incoming = Array.isArray(req.body?.holidays)
      ? req.body.holidays
      : req.body?.holiday
      ? [req.body.holiday]
      : [];

    // Later entries win, mirroring the client's own sequential upsert loop.
    const byDate = new Map();
    for (const raw of incoming) {
      const holiday = normalizeOneHoliday(raw);
      if (!ISO_DATE.test(holiday.date)) continue;
      byDate.set(holiday.date, {
        holiday,
        // An absent id means "keep whatever this date already has" — regenerating
        // one on every merge would churn the id the delete path keys on.
        hasSuppliedId: Boolean(suppliedIdOf(raw)),
      });
    }

    if (!byDate.size) {
      return res.status(400).json({
        success: false,
        message: "At least one holiday with a valid YYYY-MM-DD date is required",
      });
    }

    await ensureCalendarDoc(instituteId, req);

    const ops = [];
    for (const { holiday, hasSuppliedId } of byDate.values()) {
      const fields = {
        "holidays.$.name": holiday.name,
        "holidays.$.date": holiday.date,
        "holidays.$.type": holiday.type,
        "holidays.$.duration": holiday.duration,
        "holidays.$.note": holiday.note,
      };
      // Backfills a stable id onto legacy rows that were stored with none.
      if (hasSuppliedId) fields["holidays.$.holidayId"] = holiday.holidayId;

      ops.push({
        updateOne: {
          filter: { instituteId, "holidays.date": holiday.date },
          update: { $set: fields },
        },
      });
      ops.push({
        updateOne: {
          filter: { instituteId, "holidays.date": { $ne: holiday.date } },
          update: { $push: { holidays: holiday } },
        },
      });
    }

    await InstituteHolidayCalendar.bulkWrite(ops, { ordered: true });

    const holidays = [...byDate.values()].map((v) => v.holiday);
    return res.status(200).json({
      success: true,
      message: `${holidays.length} holiday${
        holidays.length === 1 ? "" : "s"
      } saved successfully`,
      data: { instituteId, holidays, holidayTotal: await holidayTotalOf(instituteId) },
    });
  } catch (error) {
    console.error("Error adding institute holidays:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Update ONE holiday in place, addressed by its holidayId.
 *
 * Falls back to matching on `?date=` when the id misses: rows written before
 * ids were persisted carry `holidayId: ""`, and the client mints a throwaway
 * uid for those on load, so an id-only match would 404 on exactly the oldest
 * data. A date-matched update also backfills the id it was given.
 */
exports.updateInstituteHoliday = async (req, res) => {
  try {
    const { instituteId, holidayId } = req.params;
    if (!instituteId || !holidayId) {
      return res.status(400).json({
        success: false,
        message: "instituteId and holidayId are required",
      });
    }

    const body = req.body || {};
    const fields = {};
    if (body.name !== undefined) fields.name = body.name || "Holiday";
    if (body.note !== undefined) fields.note = body.note || "";
    if (body.type !== undefined)
      fields.type = HOLIDAY_TYPES.includes(body.type) ? body.type : "institute";
    if (body.duration !== undefined)
      fields.duration = HOLIDAY_DURATIONS.includes(body.duration)
        ? body.duration
        : "full";
    if (body.date !== undefined) {
      if (!ISO_DATE.test(body.date)) {
        return res.status(400).json({
          success: false,
          message: "date must be a YYYY-MM-DD string",
        });
      }
      fields.date = body.date;
    }

    if (!Object.keys(fields).length) {
      return res
        .status(400)
        .json({ success: false, message: "No updatable fields provided" });
    }

    const positional = {};
    for (const [k, v] of Object.entries(fields)) positional[`holidays.$.${k}`] = v;

    let updated = await InstituteHolidayCalendar.findOneAndUpdate(
      { instituteId, "holidays.holidayId": holidayId },
      { $set: { ...positional, updatedBy: req.user?.email || req.user?.name || "" } },
      { new: true, projection: { holidays: 1, instituteId: 1 } }
    ).lean();

    // Legacy fallback: address the entry by the date it currently sits on.
    const fallbackDate = req.query.date || body.currentDate || "";
    if (!updated && ISO_DATE.test(fallbackDate)) {
      updated = await InstituteHolidayCalendar.findOneAndUpdate(
        { instituteId, "holidays.date": fallbackDate },
        {
          $set: {
            ...positional,
            "holidays.$.holidayId": holidayId,
            updatedBy: req.user?.email || req.user?.name || "",
          },
        },
        { new: true, projection: { holidays: 1, instituteId: 1 } }
      ).lean();
    }

    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Holiday not found on this calendar" });
    }

    const holiday =
      (updated.holidays || []).find((h) => h.holidayId === holidayId) || null;

    return res.status(200).json({
      success: true,
      message: "Holiday updated successfully",
      data: {
        instituteId,
        holiday,
        holidayTotal: (updated.holidays || []).length,
      },
    });
  } catch (error) {
    console.error("Error updating institute holiday:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Remove ONE holiday by id (with the same `?date=` fallback as the update path).
 *
 * $pull addresses the single entry directly, so the rest of the array is never
 * read, sent or rewritten — a delete cannot take anything else with it.
 */
exports.deleteInstituteHoliday = async (req, res) => {
  try {
    const { instituteId, holidayId } = req.params;
    if (!instituteId || !holidayId) {
      return res.status(400).json({
        success: false,
        message: "instituteId and holidayId are required",
      });
    }

    const who = req.user?.email || req.user?.name || "";

    // The filter must REQUIRE the element, so `matchedCount` reports whether
    // this holiday actually existed. Filtering on `instituteId` alone and
    // reading `modifiedCount` does not work: `timestamps` makes Mongoose add
    // its own `updatedAt` $set, so every call modifies the document and reports
    // a hit even when the $pull removed nothing — which would silently mean
    // misses look like successes and the date fallback below never fires.
    let result = await InstituteHolidayCalendar.updateOne(
      { instituteId, "holidays.holidayId": holidayId },
      { $pull: { holidays: { holidayId } }, $set: { updatedBy: who } }
    );

    const fallbackDate = req.query.date || "";
    if (!result.matchedCount && ISO_DATE.test(fallbackDate)) {
      result = await InstituteHolidayCalendar.updateOne(
        { instituteId, "holidays.date": fallbackDate },
        { $pull: { holidays: { date: fallbackDate } }, $set: { updatedBy: who } }
      );
    }

    if (!result.matchedCount) {
      return res
        .status(404)
        .json({ success: false, message: "Holiday not found on this calendar" });
    }

    return res.status(200).json({
      success: true,
      message: "Holiday deleted successfully",
      data: { instituteId, holidayTotal: await holidayTotalOf(instituteId) },
    });
  } catch (error) {
    console.error("Error deleting institute holiday:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Remove every holiday sitting on one date (`?date=YYYY-MM-DD`).
 *
 * The single-date modal's Delete clears the day rather than one entry, and
 * legacy data can hold more than one row per date, so this is a date-scoped
 * $pull rather than a loop of id deletes.
 */
exports.deleteInstituteHolidaysByDate = async (req, res) => {
  try {
    const { instituteId } = req.params;
    const date = req.query.date || "";

    if (!instituteId) {
      return res
        .status(400)
        .json({ success: false, message: "instituteId is required" });
    }
    if (!ISO_DATE.test(date)) {
      return res.status(400).json({
        success: false,
        message: "A ?date=YYYY-MM-DD query parameter is required",
      });
    }

    // Matched on the element, not just the calendar — see the note in
    // deleteInstituteHoliday on why `modifiedCount` cannot report a miss here.
    const result = await InstituteHolidayCalendar.updateOne(
      { instituteId, "holidays.date": date },
      {
        $pull: { holidays: { date } },
        $set: { updatedBy: req.user?.email || req.user?.name || "" },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "No holiday on that date for this calendar",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Holiday deleted successfully",
      data: { instituteId, date, holidayTotal: await holidayTotalOf(instituteId) },
    });
  } catch (error) {
    console.error("Error deleting institute holidays by date:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Create or update an institute's holiday calendar (upsert by instituteId).
 * One calendar per institute — saving again overwrites the holiday set.
 */
exports.saveInstituteHolidayCalendar = async (req, res) => {
  try {
    const { instituteId, holidays, year } = req.body;

    if (!instituteId) {
      return res.status(400).json({
        success: false,
        message: "instituteId is required",
      });
    }

    // Per-client calendars share this collection under a composite key
    // ("<institutionId>__client__<clientId>") stored in the same string field.
    // The identity snapshot must come from the real Institution document, so
    // strip the client suffix before the ObjectId lookup; for legacy
    // institute-wide keys the split is a no-op.
    const baseInstitutionId = String(instituteId).split("__client__")[0];

    // Pull a fresh snapshot of institute identity so the calendar is
    // self-describing even when the institute list isn't loaded. The lookup is
    // best-effort: a malformed id or db error must never fail the save, so any
    // failure falls back to the client-provided name/code below.
    let institute = null;
    try {
      institute = await Institution.findById(baseInstitutionId).lean();
    } catch (_) {
      institute = null;
    }

    const who = req.user?.email || req.user?.name || req.body.createdBy || "";

    const update = {
      instituteId,
      instituteName: institute?.inst_name || req.body.instituteName || "",
      instituteCode: institute?.inst_id || req.body.instituteCode || "",
      year: Number(year) || 0,
      holidays: normalizeHolidays(holidays),
      updatedBy: who,
    };

    // One atomic upsert, not find-then-create: two concurrent FIRST saves for a
    // brand-new scope (a single add racing a bulk add) both missed the findOne
    // and both created — the loser died on the unique index with a 500. The
    // upsert makes Mongo arbitrate; createdBy only lands on the insert.
    //
    // rawResult surfaces whether the upsert updated an existing doc or
    // inserted a new one directly off the write — this used to be a separate
    // `.exists({instituteId})` read purely to pick the 200/201 status code,
    // a second round trip on EVERY holiday add/edit/delete (the client
    // autosaves the whole calendar on each one). One write now covers both.
    const rawResult = await InstituteHolidayCalendar.findOneAndUpdate(
      { instituteId },
      { $set: update, $setOnInsert: { createdBy: who } },
      { upsert: true, new: true, rawResult: true }
    );
    const existed = Boolean(rawResult.lastErrorObject?.updatedExisting);
    const calendar = rawResult.value;

    return res.status(existed ? 200 : 201).json({
      success: true,
      message: existed
        ? "Holiday calendar updated successfully"
        : "Holiday calendar created successfully",
      data: calendar,
    });
  } catch (error) {
    console.error("Error saving institute holiday calendar:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Get the holiday calendar for a single institute.
 *
 * Two modes, and the legacy one is untouched:
 *
 *   (no query)            → the whole document, byte-identical to before.
 *   ?from=&to=            → the same document with `holidays` narrowed to the
 *                           dates in [from, to], plus `holidayTotal` (the count
 *                           across ALL dates) and a `range` echo.
 *
 * A calendar is bounded by the period on screen, not by a page number: the
 * month grid needs every holiday in the visible weeks, so page 2 of an
 * arbitrary sort is the wrong unit. This mirrors the attendance report, which
 * is likewise bounded by its from/to window.
 *
 * Either bound may be given alone (open-ended range). `holidays` stores dates
 * as zero-padded "YYYY-MM-DD" strings, so $gte/$lte compare them chronologically.
 */
exports.getInstituteHolidayCalendarByInstitute = async (req, res) => {
  try {
    const { instituteId } = req.params;

    if (!instituteId) {
      return res
        .status(400)
        .json({ success: false, message: "instituteId is required" });
    }

    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    const hasFrom = ISO_DATE.test(from);
    const hasTo = ISO_DATE.test(to);

    // Opt-in only. An unparseable from/to falls through to the legacy path
    // rather than silently returning a window nobody asked for.
    if (hasFrom || hasTo) {
      const bounds = [];
      if (hasFrom) bounds.push({ $gte: ["$$h.date", from] });
      if (hasTo) bounds.push({ $lte: ["$$h.date", to] });

      const [scoped] = await InstituteHolidayCalendar.aggregate([
        { $match: { instituteId } },
        {
          $addFields: {
            holidayTotal: { $size: { $ifNull: ["$holidays", []] } },
            holidays: {
              $filter: {
                input: { $ifNull: ["$holidays", []] },
                as: "h",
                cond: { $and: bounds },
              },
            },
          },
        },
      ]);

      if (!scoped) {
        return res.status(200).json({
          success: true,
          message: "No holiday calendar saved for this institute yet",
          data: null,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Holiday calendar fetched successfully",
        data: {
          ...scoped,
          rangeScoped: true,
          range: { from: hasFrom ? from : null, to: hasTo ? to : null },
        },
      });
    }

    const calendar = await InstituteHolidayCalendar.findOne({
      instituteId,
    }).lean();

    // Not an error — the institute simply has no saved calendar yet.
    if (!calendar) {
      return res.status(200).json({
        success: true,
        message: "No holiday calendar saved for this institute yet",
        data: null,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Holiday calendar fetched successfully",
      data: calendar,
    });
  } catch (error) {
    console.error("Error fetching institute holiday calendar:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Get all saved institute holiday calendars (list view).
 */
exports.getAllInstituteHolidayCalendars = async (req, res) => {
  try {
    // ?counts=1 → every record minus its `holidays[]` array, carrying a
    // `holidayCount` instead. The only consumer (the client listing) renders a
    // count per scope and nothing else, so shipping every holiday of every
    // scope to draw a number is the whole payload for none of the value.
    // Opt-in: the default response is unchanged.
    if (req.query.counts === "1" || req.query.counts === "true") {
      const calendars = await InstituteHolidayCalendar.aggregate([
        {
          $project: {
            instituteId: 1,
            instituteName: 1,
            instituteCode: 1,
            year: 1,
            createdBy: 1,
            updatedBy: 1,
            createdAt: 1,
            updatedAt: 1,
            holidayCount: { $size: { $ifNull: ["$holidays", []] } },
          },
        },
        { $sort: { updatedAt: -1 } },
      ]);

      return res.status(200).json({
        success: true,
        message: "Holiday calendars fetched successfully",
        data: calendars,
      });
    }

    const calendars = await InstituteHolidayCalendar.find()
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Holiday calendars fetched successfully",
      data: calendars,
    });
  } catch (error) {
    console.error("Error fetching institute holiday calendars:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

/**
 * Delete an institute's holiday calendar.
 */
exports.deleteInstituteHolidayCalendar = async (req, res) => {
  try {
    const { instituteId } = req.params;

    const deleted = await InstituteHolidayCalendar.findOneAndDelete({
      instituteId,
    });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Holiday calendar not found for this institute",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Holiday calendar deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting institute holiday calendar:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};
