const ActivityLog = require('../models/ActivityLog');
const User = require('../models/UserModel');
const mongoose = require('mongoose');
const config = require('config');
const jwt = require('jsonwebtoken');
const JWT_TOKEN_KEY = config.get('JWT_TOKEN_KEY');

/**
 * POST /activity-logs/login-session
 * Called by the frontend after geo lookup to update the most recent login log
 * with real IP address, location, device, browser, and OS.
 */
exports.postLoginSession = async (req, res) => {
  try {
    // Decode user from Bearer token
    const bearerHeader = req.headers['authorization'] || '';
    const token = bearerHeader.startsWith('Bearer ') ? bearerHeader.slice(7) : '';
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorised' });

    let userId;
    try {
      const decoded = jwt.verify(token, JWT_TOKEN_KEY);
      userId = decoded.id;
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    const { details = {} } = req.body;

    // Build update — only overwrite fields that are actually provided
    const set = {};
    if (details.ipAddress) set['details.ipAddress'] = details.ipAddress;
    if (details.location)  set['details.location']  = details.location;
    if (details.device)    set['details.device']    = details.device;
    if (details.browser)   set['details.browser']   = details.browser;
    if (details.os)        set['details.os']        = details.os;
    if (details.userAgent) set['details.userAgent'] = details.userAgent;

    if (Object.keys(set).length === 0) {
      return res.status(200).json({ success: true, message: 'Nothing to update' });
    }

    // Update the most recent login log for this user (within the last 10 minutes)
    const since = new Date(Date.now() - 10 * 60 * 1000);
    await ActivityLog.findOneAndUpdate(
      { userId: new mongoose.Types.ObjectId(userId), action: 'login', createdAt: { $gte: since } },
      { $set: set },
      { sort: { createdAt: -1 } }
    );

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error updating login session:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /activity-logs/logout
 * Stamps logoutTime + sessionDuration on the user's most recent OPEN login
 * session (one that has no logoutTime yet). Called from every sign-out button.
 */
exports.postLogout = async (req, res) => {
  try {
    const bearerHeader = req.headers['authorization'] || '';
    const token = bearerHeader.startsWith('Bearer ') ? bearerHeader.slice(7) : '';
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorised' });

    let userId;
    try {
      const decoded = jwt.verify(token, JWT_TOKEN_KEY);
      userId = decoded.id;
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    const logoutTime = req.body && req.body.logoutTime ? new Date(req.body.logoutTime) : new Date();

    // Most recent login session for this user that hasn't been closed yet.
    // { logoutTime: null } also matches docs where the field is absent.
    const session = await ActivityLog.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      action: 'login',
      logoutTime: null,
    }).sort({ createdAt: -1 });

    if (!session) {
      return res.status(200).json({ success: true, message: 'No open session found' });
    }

    const sessionDuration = Math.max(
      0,
      Math.round((logoutTime.getTime() - new Date(session.createdAt).getTime()) / 1000)
    );

    session.logoutTime = logoutTime;
    session.sessionDuration = sessionDuration;
    await session.save();

    res.status(200).json({ success: true, data: { logoutTime, sessionDuration } });
  } catch (error) {
    console.error('Error recording logout:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const LOGIN_FIELDS = 'userName userEmail userRole details logoutTime sessionDuration createdAt';

/** Escape a user-supplied search term so it is matched literally. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The Logs page's own login filter, ported field for field.
 *
 * `from`/`to` arrive as epoch milliseconds ALREADY resolved to day boundaries
 * by the browser, because the page computed them with local-time
 * `setHours(0,0,0,0)` / `setHours(23,59,59,999)`. Sending absolute instants
 * rather than date strings keeps the selection identical no matter which
 * timezone the server runs in.
 */
const buildLoginFilter = (query) => {
  const filter = { action: 'login' };

  const from = Number(query.from);
  const to = Number(query.to);
  if (Number.isFinite(from) || Number.isFinite(to)) {
    filter.createdAt = {};
    if (Number.isFinite(from)) filter.createdAt.$gte = new Date(from);
    if (Number.isFinite(to)) filter.createdAt.$lte = new Date(to);
  }

  const search = String(query.search || '').trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ userName: rx }, { userEmail: rx }];
  }
  return filter;
};

/**
 * GET /activity-logs/logins
 * Login events, most recent first.
 *
 * Without `page` this is the ORIGINAL response — the 500 most recent events,
 * unfiltered — so any caller that has not opted in sees no change.
 *
 * With `page` the date range and the search run in Mongo and one page comes
 * back. That is not only cheaper, it is the only way to reach most of the
 * data: the collection holds 20,797 login events and the 500-row cap meant the
 * page could not show anything older than the last three days. An audit log
 * that silently hides 97% of its history is a correctness problem, not just a
 * performance one — paginating is what makes the older rows reachable at all.
 */
exports.getLoginLogs = async (req, res) => {
  try {
    if (req.query.page === undefined) {
      const logs = await ActivityLog.find({ action: 'login' })
        .select(LOGIN_FIELDS)
        .sort({ createdAt: -1 })
        .limit(500)
        .lean();

      return res.status(200).json({ success: true, data: logs });
    }

    // Export pulls every row matching the filter, in large chunks, so the
    // spreadsheet still covers the whole selection and not just one page.
    const isExport = req.query.export === '1' || req.query.export === 'true';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(isExport ? 5000 : 200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = buildLoginFilter(req.query);

    // `_id` breaks ties so paging is stable when two events share a timestamp
    // (bulk-seeded rows do). The compound index in the model covers the whole
    // sort, so a page reads its own rows and no more.
    const [data, total] = await Promise.all([
      ActivityLog.find(filter)
        .select(LOGIN_FIELDS)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ActivityLog.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error('Error fetching login logs:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /activity-logs/courses/:courseId
 * Returns per-student activity for a course:
 *   nodeVisits, methodSelections, resourceOpens, exerciseSubmissions
 */
exports.getCourseActivityLogs = async (req, res) => {
  try {
    const { courseId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid courseId' });
    }

    // ── Part A: ActivityLog events for this course ────────────────────────────
    const logs = await ActivityLog.find({
      courseId: new mongoose.Types.ObjectId(courseId),
      action: { $in: ['node_visit', 'resource_open', 'method_select', 'activity_select'] },
    })
      .sort({ createdAt: 1 })
      .lean();

    // Group activity logs by userId
    const logsByUser = {};
    for (const log of logs) {
      const uid = log.userId.toString();
      if (!logsByUser[uid]) {
        logsByUser[uid] = {
          userId: uid,
          userName: log.userName,
          userEmail: log.userEmail,
          nodeVisits: [],
          methodSelections: [],
          resourceOpens: [],
        };
      }
      if (log.action === 'node_visit') {
        logsByUser[uid].nodeVisits.push({
          nodeId: log.details.nodeId,
          nodeName: log.details.nodeName,
          nodeType: log.details.nodeType,
          visitedAt: log.createdAt,
        });
      } else if (log.action === 'resource_open') {
        logsByUser[uid].resourceOpens.push({
          resourceId: log.details.resourceId,
          resourceName: log.details.resourceName,
          resourceType: log.details.resourceType,
          openedAt: log.createdAt,
        });
      } else if (log.action === 'method_select' || log.action === 'activity_select') {
        logsByUser[uid].methodSelections.push({
          action: log.action,
          method: log.details.method,
          activity: log.details.activity,
          nodeName: log.details.nodeName,
          selectedAt: log.createdAt,
        });
      }
    }

    // ── Part B: Exercise submissions from UserModel answers ───────────────────
    const users = await User.find(
      { 'courses.courseId': new mongoose.Types.ObjectId(courseId) },
      { firstName: 1, lastName: 1, email: 1, courses: 1 }
    ).lean();

    const studentMap = {};

    for (const user of users) {
      const uid = user._id.toString();
      const courseEntry = (user.courses || []).find(
        c => c.courseId && c.courseId.toString() === courseId
      );

      // Collect exercise submissions across I_Do, We_Do, You_Do
      const exerciseSubmissions = [];
      if (courseEntry?.answers) {
        for (const method of ['I_Do', 'We_Do', 'You_Do']) {
          const methodMap = courseEntry.answers[method];
          if (!methodMap) continue;

          // answers[method] is a Mongoose Map — iterate entries
          const entries = methodMap instanceof Map
            ? Array.from(methodMap.entries())
            : Object.entries(methodMap);

          for (const [activity, progressList] of entries) {
            if (!Array.isArray(progressList)) continue;
            for (const ep of progressList) {
              const submittedAt = ep.lastTestSubmittedAt || ep.updatedAt || ep.createdAt;
              if (!submittedAt) continue;
              exerciseSubmissions.push({
                exerciseId: ep.exerciseId ? ep.exerciseId.toString() : null,
                exerciseName: ep.exerciseName || 'Exercise',
                method,
                activity,
                status: ep.status || 'in-progress',
                submittedAt,
              });
            }
          }
        }
      }

      studentMap[uid] = {
        userId: uid,
        userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        userEmail: user.email,
        lastActive: courseEntry?.lastAccessed || null,
        exerciseSubmissions,
      };
    }

    // ── Merge A + B ───────────────────────────────────────────────────────────
    const allUserIds = new Set([...Object.keys(logsByUser), ...Object.keys(studentMap)]);
    const result = [];

    for (const uid of allUserIds) {
      const activityData = logsByUser[uid] || {};
      const userData = studentMap[uid] || {};
      result.push({
        userId: uid,
        userName: userData.userName || activityData.userName || '',
        userEmail: userData.userEmail || activityData.userEmail || '',
        lastActive: userData.lastActive || null,
        nodeVisits: activityData.nodeVisits || [],
        methodSelections: activityData.methodSelections || [],
        resourceOpens: activityData.resourceOpens || [],
        exerciseSubmissions: userData.exerciseSubmissions || [],
      });
    }

    // Sort by most recently active
    result.sort((a, b) => {
      const aTime = a.lastActive ? new Date(a.lastActive).getTime() : 0;
      const bTime = b.lastActive ? new Date(b.lastActive).getTime() : 0;
      return bTime - aTime;
    });

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error fetching course activity logs:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Course report — one shared description of the row, the filter and the derived
// fields, used by the list, the count, the facets and the stats so those four
// can never drift apart.
//
// A report row is a 1:1 transform of ONE activity log: no grouping, no
// cross-document arithmetic. That is what makes the endpoint paginatable at
// all — a page of rows is exactly a page of documents.
//
// Three of the row's fields are DERIVED rather than stored (`pedagogy`, `type`,
// `title`), and the page filters and searches on them. `pedagogy` is reproduced
// below as a predicate over the RAW fields so Mongo can still use an index;
// only the search, which reads the two fully computed strings, needs the values
// materialised inside the pipeline.
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_ACTIONS = ['resource_open', 'exercise_start'];
const REPORT_SELECT = 'userId userName userEmail action details createdAt';

const reportBase = (courseId) => ({
  courseId: new mongoose.Types.ObjectId(courseId),
  action: { $in: REPORT_ACTIONS },
  'details.duration': { $ne: null }, // only completed, measured items
});

const RES_TYPE_LABEL = {
  pdf: 'PDF', video: 'Video', ppt: 'PPT', link: 'Link',
  image: 'Image', word: 'Word', zip: 'Zip', txt: 'Text',
};

/** The row transform — the ONLY place a stored log becomes a report row. */
const toSession = (l, withId = false) => {
  const d = l.details || {};
  const isResource = l.action === 'resource_open';
  const pedagogy = d.method || (isResource ? 'I_Do' : 'We_Do');

  let type;
  if (isResource) {
    const rt = String(d.resourceType || '').toLowerCase();
    type = RES_TYPE_LABEL[rt] || (d.resourceType ? String(d.resourceType).toUpperCase() : 'Resource');
  } else {
    type = pedagogy === 'You_Do' ? 'Assessment' : 'Assignment';
  }

  const title = isResource
    ? (d.resourceName || 'Resource')
    : (d.exerciseName || (pedagogy === 'You_Do' ? 'Assessment' : 'Assignment'));

  const row = {
    studentId: l.userId ? String(l.userId) : '',
    studentName: l.userName || '',
    studentEmail: l.userEmail || '',
    pedagogy,                                   // 'I_Do' | 'We_Do' | 'You_Do'
    type,                                       // 'PDF' | 'Video' | ... | 'Assignment' | 'Assessment'
    title,
    subCategory: d.activity || null,
    nodeName: d.nodeName || null,
    nodeType: d.nodeType || null,
    startTime: l.createdAt,
    endTime: d.closedAt || null,
    durationSec: typeof d.duration === 'number' ? d.duration : 0,
  };
  // Paginated callers get a stable row identity for React keys. The legacy
  // response must stay byte-identical, so it never carries this.
  if (withId) row._id = String(l._id);
  return row;
};

/**
 * `pedagogy` as a predicate over STORED fields.
 *
 * A row's value is `details.method || (resource_open ? 'I_Do' : 'We_Do')`, so it
 * lands in I_Do / We_Do either because it says so or because it carries no
 * method at all and its action decides. Expressing that on the raw fields —
 * rather than computing the value and matching it afterwards — is what keeps
 * this filter index-served.
 */
const pedagogyMatch = (p) => {
  // `d.method || …` is JS-falsy for null, missing and ''. A Mongo equality
  // against null matches missing too, so both spellings are covered.
  const noMethod = { 'details.method': { $in: [null, ''] } };
  if (p === 'I_Do') {
    return { $or: [{ 'details.method': 'I_Do' }, { $and: [noMethod, { action: 'resource_open' }] }] };
  }
  if (p === 'We_Do') {
    return { $or: [{ 'details.method': 'We_Do' }, { $and: [noMethod, { action: 'exercise_start' }] }] };
  }
  // You_Do is never produced by the fallback, so only an explicit method reaches it.
  return { 'details.method': p };
};

/** `pedagogy` as a VALUE, for the stages that need the computed row. */
const PEDAGOGY_EXPR = {
  $let: {
    vars: { m: { $ifNull: ['$details.method', ''] } },
    in: {
      $cond: [
        { $ne: ['$$m', ''] },
        '$$m',
        { $cond: [{ $eq: ['$action', 'resource_open'] }, 'I_Do', 'We_Do'] },
      ],
    },
  },
};

const nonEmpty = (path) => ({ $ne: [{ $ifNull: [path, ''] }, ''] });

/** `type`, computed — mirrors the `toSession` branch exactly. */
const TYPE_EXPR = {
  $cond: [
    { $eq: ['$action', 'resource_open'] },
    {
      $let: {
        vars: { rt: { $toLower: { $ifNull: ['$details.resourceType', ''] } } },
        in: {
          $switch: {
            branches: Object.entries(RES_TYPE_LABEL).map(([k, v]) => ({ case: { $eq: ['$$rt', k] }, then: v })),
            default: {
              $cond: [nonEmpty('$details.resourceType'), { $toUpper: '$details.resourceType' }, 'Resource'],
            },
          },
        },
      },
    },
    { $cond: [{ $eq: [PEDAGOGY_EXPR, 'You_Do'] }, 'Assessment', 'Assignment'] },
  ],
};

/** `title`, computed — mirrors the `toSession` branch exactly. */
const TITLE_EXPR = {
  $cond: [
    { $eq: ['$action', 'resource_open'] },
    { $cond: [nonEmpty('$details.resourceName'), '$details.resourceName', 'Resource'] },
    {
      $cond: [
        nonEmpty('$details.exerciseName'),
        '$details.exerciseName',
        { $cond: [{ $eq: [PEDAGOGY_EXPR, 'You_Do'] }, 'Assessment', 'Assignment'] },
      ],
    },
  ],
};

/** Duration as the row reports it — `typeof d.duration === 'number' ? … : 0`. */
const DURATION_EXPR = { $cond: [{ $isNumber: '$details.duration' }, '$details.duration', 0] };

/**
 * The pages' own course filter, ported field for field.
 *
 * `from`/`to` arrive as epoch milliseconds ALREADY resolved to day boundaries by
 * the browser — including the "From with no To means just that one day" rule —
 * because both pages computed them with local-time `setHours`. Resolving there
 * and sending absolute instants keeps the selection identical whatever timezone
 * the server runs in.
 */
const buildReportFilter = (courseId, query) => {
  const filter = reportBase(courseId);

  // aggregate() does NOT cast a filter the way find() does, so the ids are
  // built here and this object is safe to hand to either.
  const student = String(query.student || '').trim();
  if (student && student !== 'all' && mongoose.Types.ObjectId.isValid(student)) {
    filter.userId = new mongoose.Types.ObjectId(student);
  }

  const pedagogy = String(query.pedagogy || '').trim();
  if (pedagogy && pedagogy !== 'all') Object.assign(filter, pedagogyMatch(pedagogy));

  const subCat = String(query.subCat || '').trim();
  if (subCat && subCat !== 'all') filter['details.activity'] = subCat;

  const from = Number(query.from);
  const to = Number(query.to);
  if (Number.isFinite(from) || Number.isFinite(to)) {
    filter.createdAt = {};
    if (Number.isFinite(from)) filter.createdAt.$gte = new Date(from);
    if (Number.isFinite(to)) filter.createdAt.$lte = new Date(to);
  }
  return filter;
};

/** Escape a user-supplied search term so it is matched literally. */
const escapeSearch = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The search stages, or [] when there is no term.
 *
 * The page matches the two COMPUTED strings, `title` and `type`, so a per-raw-
 * field $or cannot stand in for it: a search for "PDF" has to reach a row whose
 * stored resourceType is "pdf", and one for "Assessment" a row that stores no
 * title at all and takes that word from its pedagogy. The values are therefore
 * materialised and matched as the page sees them. That costs no index — an
 * unanchored regex never used one.
 *
 * The term is NOT trimmed before matching, only before deciding whether to
 * match at all, because that is what the page does: it tests `search.trim()`
 * for emptiness but searches with the raw string, so a trailing space is part
 * of the needle.
 */
const searchStages = (raw) => {
  const term = String(raw == null ? '' : raw);
  if (!term.trim()) return [];
  const rx = new RegExp(escapeSearch(term), 'i');
  return [
    { $addFields: { __title: TITLE_EXPR, __type: TYPE_EXPR } },
    { $match: { $or: [{ __title: rx }, { __type: rx }] } },
  ];
};

/**
 * GET /activity-logs/courses/:courseId/report
 * Returns measured time "sessions" for the report — only items that actually have a
 * start→end duration:
 *   • resource_open (I Do) with a duration  → a viewed resource
 *   • exercise_start (We Do) with a duration → a submitted assignment
 *   • exercise_start (You Do) with a duration → a submitted assessment
 * Started-but-not-submitted (duration === null) and node visits are excluded.
 *
 * Plain, with no query string, this is the ORIGINAL response — every session for
 * the course in one array — so any caller that has not opted in sees no change.
 *
 * The opt-in modes each answer one question the pages used to answer by holding
 * the whole list in the browser:
 *   ?page=N   one page of rows, filtered and sorted in Mongo (+ `total`)
 *   ?export=1 every row matching the filters, for the spreadsheet and the print view
 *   ?facets=1 the filter dropdowns, over the WHOLE course rather than one page
 *   ?stats=1  the report's totals, donut and per-day series, over the whole selection
 */
exports.getCourseReport = async (req, res) => {
  try {
    const { courseId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: 'Invalid courseId' });
    }

    const wantsPage = req.query.page !== undefined;
    const wantsExport = req.query.export === '1' || req.query.export === 'true';
    const wantsFacets = req.query.facets === '1' || req.query.facets === 'true';
    const wantsStats = req.query.stats === '1' || req.query.stats === 'true';

    // ── Legacy: the whole course, untouched ──────────────────────────────────
    if (!wantsPage && !wantsExport && !wantsFacets && !wantsStats) {
      const logs = await ActivityLog.find(reportBase(courseId))
        .select(REPORT_SELECT)
        .sort({ createdAt: -1 })
        .lean();

      return res.status(200).json({ success: true, data: logs.map(l => toSession(l)) });
    }

    // ── Facets: the dropdowns, over the whole course ─────────────────────────
    // These describe the COURSE, not the current filter — a student who has no
    // rows left after filtering must still be selectable, or the filter that
    // hid them could never be undone.
    if (wantsFacets) {
      const [out] = await ActivityLog.aggregate([
        { $match: reportBase(courseId) },
        // $first inside $group takes the first row it sees, so ordering here is
        // what makes the dropdowns list students in the order the page did:
        // most recently active first.
        { $sort: { createdAt: -1, _id: -1 } },
        { $addFields: { __ped: PEDAGOGY_EXPR } },
        {
          $facet: {
            students: [
              { $group: { _id: '$userId', name: { $first: '$userName' }, email: { $first: '$userEmail' }, ord: { $first: '$createdAt' }, ordId: { $first: '$_id' } } },
              { $sort: { ord: -1, ordId: -1 } },
            ],
            subCats: [
              { $match: { 'details.activity': { $nin: [null, ''] } } },
              { $group: { _id: { ped: '$__ped', sub: '$details.activity' }, ord: { $first: '$createdAt' }, ordId: { $first: '$_id' } } },
              { $sort: { ord: -1, ordId: -1 } },
            ],
            total: [{ $count: 'n' }],
          },
        },
      ]);

      const subCategories = { I_Do: [], We_Do: [], You_Do: [] };
      for (const s of out.subCats || []) {
        const bucket = subCategories[s._id.ped];
        if (bucket && !bucket.includes(s._id.sub)) bucket.push(s._id.sub);
      }

      return res.status(200).json({
        success: true,
        students: (out.students || []).map(s => ({
          value: String(s._id),
          // The page labelled a student `name || email || id`, first row wins.
          label: s.name || s.email || String(s._id),
          // The report banner shows the selected student's address, which it
          // used to find by scanning the full list for their first row.
          email: s.email || '',
        })),
        subCategories,
        total: out.total?.[0]?.n || 0,
      });
    }

    const filter = buildReportFilter(courseId, req.query);
    const search = searchStages(req.query.search);

    // ── Stats: the report's aggregates, over the whole selection ─────────────
    // The report's totals, donut and trend are sums over every matching row, so
    // they cannot be computed from a page. They are computed in Mongo instead —
    // which is also the only reason the detail table below is safe to paginate.
    if (wantsStats) {
      // The page buckets days with local-time getFullYear/getMonth/getDate, so
      // the browser sends its own zone; bucketing in the server's zone would
      // move activity across midnight for anyone not sitting next to it.
      const tz = String(req.query.tz || '').trim() || 'UTC';
      const dayExpr = { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: tz } };

      const [out] = await ActivityLog.aggregate([
        { $match: filter },
        ...search,
        { $addFields: { __ped: PEDAGOGY_EXPR, __day: dayExpr, __dur: DURATION_EXPR } },
        {
          $facet: {
            overall: [{
              $group: {
                _id: null,
                total: { $sum: '$__dur' },
                count: { $sum: 1 },
                first: { $min: '$createdAt' },
                last: { $max: '$createdAt' },
                students: { $addToSet: '$userId' },
                days: { $addToSet: '$__day' },
              },
            }],
            byPed: [{ $group: { _id: '$__ped', sum: { $sum: '$__dur' }, n: { $sum: 1 } } }],
            perDay: [
              { $group: { _id: { day: '$__day', ped: '$__ped' }, sum: { $sum: '$__dur' }, n: { $sum: 1 } } },
              { $sort: { '_id.day': 1 } },
            ],
          },
        },
      ]);

      const o = out.overall?.[0] || null;
      const byPed = { I_Do: 0, We_Do: 0, You_Do: 0 };
      const cntPed = { I_Do: 0, We_Do: 0, You_Do: 0 };
      for (const b of out.byPed || []) {
        if (b._id in byPed) { byPed[b._id] = b.sum; cntPed[b._id] = b.n; }
      }

      const perDayMap = new Map();
      for (const d of out.perDay || []) {
        const key = d._id.day;
        if (!perDayMap.has(key)) perDayMap.set(key, { key, total: 0, count: 0, byPed: { I_Do: 0, We_Do: 0, You_Do: 0 } });
        const row = perDayMap.get(key);
        row.total += d.sum;
        row.count += d.n;
        if (d._id.ped in row.byPed) row.byPed[d._id.ped] += d.sum;
      }

      return res.status(200).json({
        success: true,
        stats: {
          total: o?.total || 0,
          count: o?.count || 0,
          byPed,
          cntPed,
          activeDays: o?.days?.length || 0,
          students: o?.students?.length || 0,
          firstActivity: o?.first ? new Date(o.first).toISOString() : '',
          lastActivity: o?.last ? new Date(o.last).toISOString() : '',
        },
        // Ascending by day, as the page's own series was.
        perDay: Array.from(perDayMap.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      });
    }

    // ── Rows: one page, or the whole filtered selection for export ───────────
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    // An export that names no limit wants the whole selection, so its default is
    // the ceiling rather than the table's page size — defaulting to 10 here
    // truncated the spreadsheet to ten rows without erroring.
    const maxLimit = wantsExport ? 5000 : 200;
    const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || (wantsExport ? maxLimit : 10)));

    // `_id` breaks ties so paging is stable when two rows share a timestamp.
    const sort = { createdAt: -1, _id: -1 };

    let data;
    let total;

    if (search.length) {
      // Sorting BEFORE the computed fields keeps the index serving the sort;
      // $addFields adds columns without disturbing the order, and the search
      // that reads them cannot be pushed any earlier than the values it needs.
      const [rows, counted] = await Promise.all([
        ActivityLog.aggregate([
          { $match: filter },
          { $sort: sort },
          ...search,
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ]),
        ActivityLog.aggregate([{ $match: filter }, ...search, { $count: 'n' }]),
      ]);
      data = rows.map(l => toSession(l, true));
      total = counted[0]?.n || 0;
    } else {
      const [rows, counted] = await Promise.all([
        ActivityLog.find(filter)
          .select(REPORT_SELECT)
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        ActivityLog.countDocuments(filter),
      ]);
      data = rows.map(l => toSession(l, true));
      total = counted;
    }

    // Documented as a whole-COURSE count, so it is taken outside the filter —
    // it is what tells the page apart "this course has no measured activity"
    // from "this filter matched none of it", and a filtered count would make
    // the first message appear whenever the second was true.
    const unfilteredTotal = await ActivityLog.countDocuments(reportBase(courseId));

    return res.status(200).json({
      success: true,
      data,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      unfilteredTotal,
    });
  } catch (error) {
    console.error('Error building course report:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /activity-logs/me/learning-time
 *
 * The signed-in user's OWN measured time, aggregated from CLOSED activity logs.
 * Unlike the course report this never reads another user's rows, so it is safe
 * to call from the student dashboard.
 *
 *   · exercise_start + details.method 'We_Do'  → assignment working time
 *   · exercise_start + details.method 'You_Do' → assessment working time
 *   · resource_open                            → I Do content viewing time
 *
 * Only closed logs count. An `exercise_start` stays open (duration null) until
 * the student hits test-submit, and a `resource_open` until the viewer closes;
 * open rows have no end, so counting them would invent time.
 *
 * CAVEAT the caller should surface: a duration is wall-clock between first save
 * and submit, not focused effort. An assignment begun Monday and submitted
 * Friday records four days. Sessions longer than SESSION_CAP_SECONDS are
 * therefore clamped, and both the clamped total and the raw total are returned
 * so the adjustment is never hidden.
 */
const SESSION_CAP_SECONDS = 6 * 60 * 60; // 6h — longer than any configured exercise

exports.getMyLearningTime = async (req, res) => {
  try {
    const userId = req.user._id;

    const logs = await ActivityLog.find({
      userId,
      action: { $in: ['exercise_start', 'resource_open'] },
      'details.duration': { $ne: null },
    })
      .select('action courseId courseName details.duration details.method details.closedAt createdAt')
      .lean();

    const empty = () => ({ seconds: 0, sessions: 0 });
    const out = {
      weDo: empty(),
      youDo: empty(),
      content: empty(),
      other: empty(),
    };

    let rawSeconds = 0;
    let cappedSessions = 0;
    const byCourse = {};
    const daily = {};

    for (const log of logs) {
      const d = log.details || {};
      const raw = Number(d.duration);
      if (!isFinite(raw) || raw < 0) continue;

      rawSeconds += raw;
      const seconds = Math.min(raw, SESSION_CAP_SECONDS);
      if (raw > SESSION_CAP_SECONDS) cappedSessions++;

      let bucket;
      if (log.action === 'resource_open') bucket = out.content;
      else if (d.method === 'We_Do') bucket = out.weDo;
      else if (d.method === 'You_Do') bucket = out.youDo;
      else bucket = out.other; // legacy rows written before `method` was recorded

      bucket.seconds += seconds;
      bucket.sessions += 1;

      if (log.courseId) {
        const key = log.courseId.toString();
        if (!byCourse[key]) byCourse[key] = { courseId: key, courseName: log.courseName || '', seconds: 0 };
        byCourse[key].seconds += seconds;
      }

      const ended = d.closedAt ? new Date(d.closedAt) : new Date(log.createdAt);
      if (!isNaN(ended.getTime())) {
        const day = ended.toISOString().slice(0, 10);
        daily[day] = (daily[day] || 0) + seconds;
      }
    }

    const totalSeconds =
      out.weDo.seconds + out.youDo.seconds + out.content.seconds + out.other.seconds;

    return res.status(200).json({
      success: true,
      data: {
        totalSeconds,
        rawSeconds,
        cappedSessions,
        sessionCapSeconds: SESSION_CAP_SECONDS,
        weDo: out.weDo,
        youDo: out.youDo,
        content: out.content,
        other: out.other,
        byCourse: Object.values(byCourse).sort((a, b) => b.seconds - a.seconds),
        daily: Object.entries(daily)
          .map(([date, seconds]) => ({ date, seconds }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      },
    });
  } catch (error) {
    console.error('Error building learning time summary:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
