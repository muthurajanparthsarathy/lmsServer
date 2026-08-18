const express = require("express");
const { userAuth } = require("../../middlewares/userAuth");
const {
  createPrintSetting,
  getPrintSettings,
  getPrintSettingById,
  updatePrintSetting,
  deletePrintSetting,
} = require("../../controllers/dynamicContent/printSetting");
const router = express.Router();

router.post("/print-setting/create", userAuth, createPrintSetting);

router.get("/print-setting/getAll", getPrintSettings);

router.get("/print-setting/getById/:id", userAuth, getPrintSettingById);

router.put("/print-setting/update/:id", userAuth, updatePrintSetting);

router.delete("/print-setting/delete/:id", userAuth, deletePrintSetting);

module.exports = router;
