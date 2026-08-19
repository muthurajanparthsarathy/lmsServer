const express = require("express");
const {
  createClient,
  getAllClients,
  getClientById,
  updateClient,
  deleteClient,
  toggleClientStatus,
} = require("../controllers/clientManagementController");
const { userAuth } = require("../middlewares/userAuth");
const { attachPocScope, guardClientWrite } = require("../middlewares/pocScope");

const router = express.Router();

// Auth + POC scoping for the whole module. Bound to the path PREFIX rather
// than pathless (every router in this app is mounted at "/", so a bare
// `router.use` would run for every request in the application).
router.use("/client-management", userAuth, attachPocScope);

// Standalone Client Management routes (independent of course-structure clients).
// Writes go through `guardClientWrite`, which lets a POC create/update/delete
// only for clients that are already in its scope (create checks req.body.clientId
// — CREATE of a wholly new client is admin-only in practice, but the guard
// enforces it structurally rather than by role name).
router.post("/client-management/create", guardClientWrite(), createClient);
router.get("/client-management/getAll", getAllClients);
router.get("/client-management/getById/:clientId", getClientById);
router.put("/client-management/update/:clientId", guardClientWrite(), updateClient);
router.delete("/client-management/delete/:clientId", guardClientWrite(), deleteClient);
router.put("/client-management/toggle-status/:clientId", guardClientWrite(), toggleClientStatus);

module.exports = router;
