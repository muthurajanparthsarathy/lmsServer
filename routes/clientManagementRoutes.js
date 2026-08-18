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

const router = express.Router();

// Standalone Client Management routes (independent of course-structure clients)
router.post("/client-management/create", userAuth, createClient);
router.get("/client-management/getAll", userAuth, getAllClients);
router.get("/client-management/getById/:clientId", userAuth, getClientById);
router.put("/client-management/update/:clientId", userAuth, updateClient);
router.delete("/client-management/delete/:clientId", userAuth, deleteClient);
router.put("/client-management/toggle-status/:clientId", userAuth, toggleClientStatus);

module.exports = router;
