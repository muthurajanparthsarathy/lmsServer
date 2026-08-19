const { resolvePocScope, scopeHasCourse, scopeHasClient, scopeHasMapping } = require("../utils/pocScope");

// Populates `req.pocScope` for a request that has already been through
// `userAuth`. Mount at router level (`router.use(path, userAuth, attachPocScope)`)
// so a route added to that file later inherits scoping instead of silently
// shipping unscoped.
//
// Fails CLOSED. On a read this is the only thing standing between a POC and
// another client's data, and an unresolvable scope must never be mistaken for
// "not a POC".
const attachPocScope = async (req, res, next) => {
  try {
    if (!req._pocScope) req._pocScope = await resolvePocScope(req.user);
    req.pocScope = req._pocScope;
    return next();
  } catch (error) {
    console.error("attachPocScope: refusing request —", error.message);
    return res.status(500).json({
      success: false,
      message: [{ key: "error", value: "Could not resolve access scope" }],
    });
  }
};

// ── Write authorization ─────────────────────────────────────────────────────
//
// A POC has the SAME actions an admin has — course setup, participants,
// batches, attendance marking, client and service edits — but only on the
// courses it is enrolled in and on those courses' clients and services.
//
// So writes are not banned; their TARGET is checked. Everything a POC may edit
// is something it can already see, which makes the rule easy to state: if the
// record is not in `req.pocScope`, the write is refused exactly as the read
// would have been.
const forbidden = (res, what) =>
  res.status(403).json({
    success: false,
    message: [{ key: "error", value: `Not authorized for this ${what}` }],
  });

const guardTarget = (kind, param) => (req, res, next) => {
  const scope = req.pocScope;
  if (!scope?.isPoc) return next();

  const id = req.params[param];
  // No id in the path means a CREATE. There is no existing record to test, so
  // the check moves to the payload: a POC may create under a client it already
  // works with, but must not attach new work to somebody else's client.
  if (!id) {
    const clientId = req.body?.clientId || req.body?.client;
    if (clientId && !scopeHasClient(scope, clientId)) return forbidden(res, "client");
    return next();
  }

  const has =
    kind === "course" ? scopeHasCourse(scope, id)
      : kind === "client" ? scopeHasClient(scope, id)
        : scopeHasMapping(scope, id);
  if (!has) return forbidden(res, kind);
  return next();
};

// Convenience wrappers naming the path parameter each family uses.
const guardCourseWrite = (param = "courseId") => guardTarget("course", param);
const guardClientWrite = (param = "clientId") => guardTarget("client", param);
const guardMappingWrite = (param = "mappingId") => guardTarget("mapping", param);

module.exports = {
  attachPocScope,
  guardCourseWrite,
  guardClientWrite,
  guardMappingWrite,
};
