const User = require("../../models/UserModel");
const Institution = require("../../models/InstitutionModal");
const CourseStructure = require("../../models/Courses/courseStructureModal");
const ActivityLog = require("../../models/ActivityLog");
const Role = require("../../models/RoleModel");
const Module1 = require("../../models/Courses/moduleStructure/moduleModal");
const SubModule1 = require("../../models/Courses/moduleStructure/subModuleModal");
const Topic1 = require("../../models/Courses/moduleStructure/topicModal");
const SubTopic1 = require("../../models/Courses/moduleStructure/subTopicModal");
const PedagogyView = require("../../models/Courses/moduleStructure/pedagogyViewModal");
const InstitutionPermission = require("../../models/superadmin/InstitutionPermissionModel");
const ResourceSetting = require("../../models/superadmin/ResourceSettingModel");
const Subscription = require("../../models/superadmin/SubscriptionModel");
const { HIDDEN_INSTITUTION_IDS } = require("../../config/superadmin/hiddenInstitutions");

const mongoose = require("mongoose");
const visibleInstitutionMatch = () => ({
  _id: { $nin: [...HIDDEN_INSTITUTION_IDS].map((id) => new mongoose.Types.ObjectId(id)) },
});

// Platform overview KPIs + simple breakdowns for the Reports dashboard.
exports.getOverview = async (req, res) => {
  try {
    const institutions = await Institution.find(visibleInstitutionMatch()).select("_id inst_name").lean();
    const visibleIds = institutions.map((i) => i._id);

    const [totalUsers, totalCourses, usersByInstitution, roleAgg] = await Promise.all([
      User.countDocuments({ institution: { $in: visibleIds } }),
      CourseStructure.countDocuments({ institution: { $in: visibleIds } }),
      User.aggregate([
        { $match: { institution: { $in: visibleIds } } },
        { $group: { _id: "$institution", count: { $sum: 1 } } },
      ]),
      User.aggregate([
        { $match: { institution: { $in: visibleIds } } },
        { $group: { _id: "$role", count: { $sum: 1 } } },
      ]),
    ]);

    const instNameById = new Map(institutions.map((i) => [String(i._id), i.inst_name]));
    const usersPerInstitution = usersByInstitution.map((u) => ({
      institution: instNameById.get(String(u._id)) || "Unknown",
      count: u.count,
    }));

    // Resolve role names for the role breakdown
    const roleIds = roleAgg.map((r) => r._id).filter(Boolean);
    const roles = await Role.find({ _id: { $in: roleIds } }).select("originalRole renameRole").lean();
    const roleNameById = new Map(roles.map((r) => [String(r._id), r.renameRole || r.originalRole]));
    const usersByRole = roleAgg
      .filter((r) => r._id)
      .map((r) => ({ role: roleNameById.get(String(r._id)) || "Unknown", count: r.count }));

    return res.status(200).json({
      message: [{ key: "success", value: "Overview retrieved" }],
      overview: {
        institutions: institutions.length,
        users: totalUsers,
        courses: totalCourses,
        usersPerInstitution,
        usersByRole,
      },
    });
  } catch (error) {
    console.error("superadmin getOverview error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// Per-institution deep analytics: users, courses, and the full course hierarchy
// (modules → sub-modules → topics → sub-topics) plus pedagogy resource usage
// (I Do / We Do / You Do items) for every visible institution.
exports.getInstitutionAnalytics = async (req, res) => {
  try {
    const institutions = await Institution.find(visibleInstitutionMatch())
      .select("_id inst_id inst_name")
      .lean();
    const visibleIds = institutions.map((i) => i._id);

    // Count documents of a model grouped by institution.
    const byInstitution = (Model) =>
      Model.aggregate([
        { $match: { institution: { $in: visibleIds } } },
        { $group: { _id: "$institution", count: { $sum: 1 } } },
      ]);

    const [users, courses, modules, subModules, topics, subTopics, pedagogy] = await Promise.all([
      byInstitution(User),
      byInstitution(CourseStructure),
      byInstitution(Module1),
      byInstitution(SubModule1),
      byInstitution(Topic1),
      byInstitution(SubTopic1),
      // Sum the I Do / We Do / You Do activity items across every pedagogy.
      PedagogyView.aggregate([
        { $match: { institution: { $in: visibleIds } } },
        { $unwind: { path: "$pedagogies", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: "$institution",
            iDo: { $sum: { $size: { $ifNull: ["$pedagogies.iDo", []] } } },
            weDo: { $sum: { $size: { $ifNull: ["$pedagogies.weDo", []] } } },
            youDo: { $sum: { $size: { $ifNull: ["$pedagogies.youDo", []] } } },
          },
        },
      ]),
    ]);

    const toMap = (agg) => new Map(agg.map((x) => [String(x._id), x.count]));
    const um = toMap(users), cm = toMap(courses), mm = toMap(modules),
      smm = toMap(subModules), tm = toMap(topics), stm = toMap(subTopics);
    const pm = new Map(pedagogy.map((p) => [String(p._id), p]));

    const rows = institutions.map((i) => {
      const id = String(i._id);
      const ped = pm.get(id) || { iDo: 0, weDo: 0, youDo: 0 };
      return {
        _id: id,
        inst_id: i.inst_id,
        inst_name: i.inst_name,
        users: um.get(id) || 0,
        courses: cm.get(id) || 0,
        modules: mm.get(id) || 0,
        subModules: smm.get(id) || 0,
        topics: tm.get(id) || 0,
        subTopics: stm.get(id) || 0,
        iDo: ped.iDo || 0,
        weDo: ped.weDo || 0,
        youDo: ped.youDo || 0,
      };
    });

    const totals = rows.reduce(
      (acc, r) => {
        for (const k of ["users", "courses", "modules", "subModules", "topics", "subTopics", "iDo", "weDo", "youDo"]) {
          acc[k] += r[k];
        }
        return acc;
      },
      { institutions: rows.length, users: 0, courses: 0, modules: 0, subModules: 0, topics: 0, subTopics: 0, iDo: 0, weDo: 0, youDo: 0 }
    );

    return res.status(200).json({
      message: [{ key: "success", value: "Analytics retrieved" }],
      totals,
      rows,
    });
  } catch (error) {
    console.error("superadmin getInstitutionAnalytics error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// Full detail for a single institution — used by the "click institution name"
// modal on Reports & Analytics. Returns roles (with user counts), courses,
// the permission allow-list, resource config and the content-hierarchy counts.
exports.getInstitutionDetails = async (req, res) => {
  try {
    const id = req.params.id;
    const institution = await Institution.findById(id)
      .select("_id inst_id inst_name inst_owner phone address status")
      .lean();
    if (!institution) {
      return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
    }

    const oid = new mongoose.Types.ObjectId(id);
    const pedagogyAgg = [
      { $match: { institution: oid } },
      { $unwind: { path: "$pedagogies", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: null,
          iDo: { $sum: { $size: { $ifNull: ["$pedagogies.iDo", []] } } },
          weDo: { $sum: { $size: { $ifNull: ["$pedagogies.weDo", []] } } },
          youDo: { $sum: { $size: { $ifNull: ["$pedagogies.youDo", []] } } },
        },
      },
    ];

    const [roles, usersByRole, courses, permDoc, resourceDoc, subscription,
      modules, subModules, topics, subTopics, pedagogy] = await Promise.all([
      Role.find({ institution: id }).select("originalRole renameRole roleValue").lean(),
      User.aggregate([{ $match: { institution: oid } }, { $group: { _id: "$role", count: { $sum: 1 } } }]),
      CourseStructure.find({ institution: id }).select("clientName serviceType serviceModal createdAt").sort({ createdAt: -1 }).lean(),
      InstitutionPermission.findOne({ institution: id }).lean(),
      ResourceSetting.findOne({ scope: String(id) }).lean(),
      Subscription.findOne({ institution: id }).lean(),
      Module1.countDocuments({ institution: id }),
      SubModule1.countDocuments({ institution: id }),
      Topic1.countDocuments({ institution: id }),
      SubTopic1.countDocuments({ institution: id }),
      PedagogyView.aggregate(pedagogyAgg),
    ]);

    const userCountByRole = new Map(usersByRole.map((u) => [String(u._id), u.count]));
    const totalUsers = usersByRole.reduce((s, u) => s + u.count, 0);
    const ped = pedagogy[0] || { iDo: 0, weDo: 0, youDo: 0 };

    return res.status(200).json({
      message: [{ key: "success", value: "Institution details retrieved" }],
      institution,
      subscription: subscription || null,
      counts: {
        users: totalUsers,
        courses: courses.length,
        modules, subModules, topics, subTopics,
        iDo: ped.iDo, weDo: ped.weDo, youDo: ped.youDo,
      },
      roles: roles.map((r) => ({
        _id: r._id,
        name: r.renameRole || r.originalRole,
        roleValue: r.roleValue,
        userCount: userCountByRole.get(String(r._id)) || 0,
      })),
      courses: courses.map((c) => ({
        _id: c._id,
        name: c.serviceModal || c.serviceType || "Course",
        clientName: c.clientName || "",
        serviceType: c.serviceType || "",
      })),
      permissions: (permDoc?.permissions || []).map((p) => ({
        permissionName: p.permissionName,
        permissionKey: p.permissionKey,
        functions: p.permissionFunctionality || [],
      })),
      resources: resourceDoc?.resourcePedagogy || null,
    });
  } catch (error) {
    console.error("superadmin getInstitutionDetails error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// Recent login history — reuses the existing ActivityLog collection (action:'login').
exports.getLoginReport = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const logins = await ActivityLog.find({ action: "login" })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("userName userEmail userRole details.ipAddress details.device details.browser createdAt")
      .lean();

    return res.status(200).json({
      message: [{ key: "success", value: "Login report retrieved" }],
      logins,
    });
  } catch (error) {
    console.error("superadmin getLoginReport error:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};
