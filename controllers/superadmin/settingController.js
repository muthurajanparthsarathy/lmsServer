const SystemSetting = require("../../models/superadmin/SystemSettingModel");

const getOrCreate = async () => {
  let doc = await SystemSetting.findOne({ scope: "global" });
  if (!doc) doc = await SystemSetting.create({ scope: "global" });
  return doc;
};

exports.getSystemSettings = async (req, res) => {
  try {
    const settings = await getOrCreate();
    return res.status(200).json({
      message: [{ key: "success", value: "System settings retrieved" }],
      settings,
    });
  } catch (error) {
    console.error("superadmin getSystemSettings error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.updateSystemSettings = async (req, res) => {
  try {
    const allowed = [
      "platformName", "supportEmail", "maintenanceMode", "allowInstitutionSelfSignup",
      "sessionTimeoutMinutes", "passwordMinLength", "enforceStrongPassword", "emailNotificationsEnabled",
    ];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    update.updatedBy = req.superAdmin?.email || "superadmin";

    await getOrCreate();
    const settings = await SystemSetting.findOneAndUpdate({ scope: "global" }, { $set: update }, { new: true });

    return res.status(200).json({
      message: [{ key: "success", value: "System settings updated" }],
      settings,
    });
  } catch (error) {
    console.error("superadmin updateSystemSettings error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
