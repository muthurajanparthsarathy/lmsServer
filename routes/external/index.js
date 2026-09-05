// External Assessment module — route aggregator.
//
// Self-namespaced, mounted with a bare `app.use(require("./routes/external"))`
// in server.js, following the Super Admin module's pattern. Two namespaces:
//
//   /api/admin/external/*   — admin CRUD, userAuth required
//   /api/external/*         — participant access by token, NO auth
//
// The split is deliberate and load-bearing: everything under /api/external is
// reachable by anyone holding a link, so it must be impossible to add an admin
// route there by accident.

const express = require("express");
const router = express.Router();

router.use("/api/admin/external", require("./adminRoutes"));
router.use("/api/external", require("./publicRoutes"));

module.exports = router;
