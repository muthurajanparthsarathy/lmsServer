const Subscription = require("../../models/superadmin/SubscriptionModel");
const Institution = require("../../models/InstitutionModal");
const { isHiddenInstitution } = require("../../config/superadmin/hiddenInstitutions");

// Lists every visible institution alongside its subscription. Clients without
// a subscription record return subscription: null (no default is created) — the
// UI shows them as "Not subscribed" until one is added manually.
exports.getSubscriptions = async (req, res) => {
  try {
    const institutions = (await Institution.find().sort({ createdAt: -1 }).lean())
      .filter((inst) => !isHiddenInstitution(inst._id));

    const subs = await Subscription.find().lean();
    const subByInst = new Map(subs.map((s) => [String(s.institution), s]));

    const rows = institutions.map((inst) => ({
      institution: { _id: inst._id, inst_id: inst.inst_id, inst_name: inst.inst_name },
      subscription: subByInst.get(String(inst._id)) || null,
    }));

    return res.status(200).json({
      message: [{ key: "success", value: "Subscriptions retrieved" }],
      rows,
    });
  } catch (error) {
    console.error("superadmin getSubscriptions error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.upsertSubscription = async (req, res) => {
  try {
    const { institution, plan, status, storageQuotaMB, maxUsers, amount, expiryDate } = req.body;
    if (!institution) {
      return res.status(400).json({ message: [{ key: "error", value: "institution is required" }] });
    }
    if (isHiddenInstitution(institution)) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }

    const inst = await Institution.findById(institution);
    if (!inst) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }

    const update = { institution, updatedBy: req.superAdmin?.email || "superadmin" };
    if (plan !== undefined) update.plan = plan;
    if (status !== undefined) update.status = status;
    if (storageQuotaMB !== undefined) update.storageQuotaMB = storageQuotaMB;
    if (maxUsers !== undefined) update.maxUsers = maxUsers;
    if (amount !== undefined) update.amount = amount;
    if (expiryDate !== undefined) update.expiryDate = expiryDate;

    const subscription = await Subscription.findOneAndUpdate(
      { institution },
      { $set: update },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      message: [{ key: "success", value: "Subscription saved" }],
      subscription,
    });
  } catch (error) {
    console.error("superadmin upsertSubscription error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
