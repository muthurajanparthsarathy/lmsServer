const ResourceSetting = require("../../models/superadmin/ResourceSettingModel");
const Subscription = require("../../models/superadmin/SubscriptionModel");

// Subscription.storageQuotaMB default (5 GB) — used when an institution has no
// subscription record yet, so the derived storage figure is never blank.
const DEFAULT_STORAGE_QUOTA_MB = 5000;

// The institution's storage allowance is owned by its subscription/plan
// (SubscriptionModel.storageQuotaMB). Resource Management no longer stores its
// own separate GB value; it derives the figure from the subscription so there
// is a single source of truth. Returns the effective quota in GB.
const deriveStorageGB = async (institutionId) => {
  const sub = await Subscription.findOne({ institution: institutionId }).lean();
  const quotaMB = sub?.storageQuotaMB ?? DEFAULT_STORAGE_QUOTA_MB;
  return quotaMB / 1000;
};

// Returns the settings doc for a given institution, creating it (with schema
// defaults) on first read. Each institution is keyed by its id in `scope`.
const getOrCreate = async (institutionId) => {
  const scope = String(institutionId);
  let doc = await ResourceSetting.findOne({ scope });
  if (!doc) doc = await ResourceSetting.create({ scope, institution: institutionId });
  return doc;
};

exports.getResourceSettings = async (req, res) => {
  try {
    const institution = req.query.institution;
    if (!institution) {
      return res.status(400).json({ message: [{ key: "error", value: "institution is required" }] });
    }
    const doc = await getOrCreate(institution);
    // Overlay the storage figure derived from the subscription so the Resource
    // Management screen always agrees with the Subscription quota.
    const settings = { ...doc.toObject(), maxInstitutionStorageGB: await deriveStorageGB(institution) };
    return res.status(200).json({
      message: [{ key: "success", value: "Resource settings retrieved" }],
      settings,
    });
  } catch (error) {
    console.error("superadmin getResourceSettings error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.updateResourceSettings = async (req, res) => {
  try {
    const institution = req.body.institution || req.query.institution;
    if (!institution) {
      return res.status(400).json({ message: [{ key: "error", value: "institution is required" }] });
    }

    // Only the two fields the Resource Management screen edits are writable.
    // The storage quota is derived from the subscription (see deriveStorageGB),
    // never written here, so the two screens can't drift apart.
    const allowed = ["resourcePedagogy", "storageAlertThresholdPercent"];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    update.updatedBy = req.superAdmin?.email || "superadmin";

    await getOrCreate(institution);
    const doc = await ResourceSetting.findOneAndUpdate(
      { scope: String(institution) },
      { $set: update },
      { new: true }
    );
    const settings = { ...doc.toObject(), maxInstitutionStorageGB: await deriveStorageGB(institution) };

    return res.status(200).json({
      message: [{ key: "success", value: "Resource settings updated" }],
      settings,
    });
  } catch (error) {
    console.error("superadmin updateResourceSettings error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
