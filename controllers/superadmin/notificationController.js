const User = require("../../models/UserModel");
const Institution = require("../../models/InstitutionModal");
const { isHiddenInstitution, HIDDEN_INSTITUTION_IDS } = require("../../config/superadmin/hiddenInstitutions");
const mongoose = require("mongoose");

// Broadcast a platform notification into targeted users' embedded
// notifications[] (the same notificationSchema the LMS already renders in its
// notification bell). Target = one institution, or all visible institutions.
exports.broadcast = async (req, res) => {
  try {
    const { title, message, type, institution } = req.body;
    if (!title || !message) {
      return res.status(400).json({ message: [{ key: "error", value: "title and message are required" }] });
    }

    const notification = {
      title,
      message,
      type: ["info", "success", "warning", "error", "enrollment"].includes(type) ? type : "info",
      relatedEntity: "system",
      isRead: false,
    };

    let filter;
    if (institution) {
      if (isHiddenInstitution(institution)) {
        return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
      }
      filter = { institution };
    } else {
      const hidden = [...HIDDEN_INSTITUTION_IDS].map((id) => new mongoose.Types.ObjectId(id));
      filter = { institution: { $nin: hidden } };
    }

    const result = await User.updateMany(filter, { $push: { notifications: notification } });

    return res.status(200).json({
      message: [{ key: "success", value: "Notification broadcast successfully" }],
      recipients: result.modifiedCount ?? result.nModified ?? 0,
    });
  } catch (error) {
    console.error("superadmin broadcast error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// Recent recipients preview so the sender can see the audience size upfront.
exports.getAudienceCounts = async (req, res) => {
  try {
    const hidden = [...HIDDEN_INSTITUTION_IDS].map((id) => new mongoose.Types.ObjectId(id));
    const institutions = await Institution.find({ _id: { $nin: hidden } }).select("_id inst_name").lean();
    const counts = await User.aggregate([
      { $match: { institution: { $nin: hidden } } },
      { $group: { _id: "$institution", count: { $sum: 1 } } },
    ]);
    const countById = new Map(counts.map((c) => [String(c._id), c.count]));
    const rows = institutions.map((i) => ({ _id: i._id, inst_name: i.inst_name, userCount: countById.get(String(i._id)) || 0 }));
    const total = rows.reduce((s, r) => s + r.userCount, 0);

    return res.status(200).json({
      message: [{ key: "success", value: "Audience retrieved" }],
      institutions: rows,
      total,
    });
  } catch (error) {
    console.error("superadmin getAudienceCounts error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
