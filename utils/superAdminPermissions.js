// Full super-admin permission catalog — the complete set of sidebar modules.
//
// Single source of truth shared by:
//   • controllers/userAuth.js  → getDefaultPermissions("super admin" …)
//   • scripts/seedSuperAdmin.js → seeding/upgrading the super admin user
//
// permissionKey MUST match the Client page folder under /lms/pages/<key>
// (the sidebar routes to /lms/pages/${permissionKey.toLowerCase()}).
// Note: "instutionmanagement" and "programcalender" match the existing
// folder spellings — do not "fix" them here without renaming the folders.
//
// order 0 must stay on the dashboard: the login flow redirects to the
// lowest-order active permission (smartcliff_firstPermissionKey).

const SUPER_ADMIN_PERMISSIONS = [
  {
    permissionName: "Admin Dashboard",
    permissionKey: "admindashboard",
    permissionFunctionality: ["view_users", "add_users", "edit_users", "delete_users"],
    icon: "Home",
    color: "green",
    description: "Admin Dashboard Management",
    isActive: true,
    order: 0,
  },
  {
    permissionName: "User Management",
    permissionKey: "usermanagement",
    // Exact strings checked by hasPermission() in the usermanagement page
    permissionFunctionality: [
      "Add User", "View Full Details", "Bulk Upload", "Bulk Permission",
      "Edit", "Permissions", "Delete", "Toggle User Status", "Duplicate User",
    ],
    icon: "Users",
    color: "blue",
    description: "Manage users and access",
    isActive: true,
    order: 1,
  },
  {
    permissionName: "Institution Management",
    permissionKey: "instutionmanagement",
    permissionFunctionality: ["Add Institution", "Edit Institution", "Delete Institution"],
    icon: "Landmark",
    color: "indigo",
    description: "Manage institutions (tenants)",
    isActive: true,
    order: 2,
  },
  {
    permissionName: "Client Management",
    permissionKey: "clientmanagement",
    permissionFunctionality: [
      "Add Client", "View Full Details", "Edit", "Delete", "Toggle Client Status",
    ],
    icon: "Building",
    color: "blue",
    description: "Manage client information (details, status, contacts)",
    isActive: true,
    order: 3,
  },
  {
    // Sits directly below Client Management in the sidebar
    permissionName: "Service Mapping",
    permissionKey: "servicemapping",
    permissionFunctionality: [
      "Map Service", "View Full Details", "Edit", "Delete",
    ],
    icon: "Layers",
    color: "blue",
    description: "Configure client ↔ service mappings, hierarchy and master data",
    isActive: true,
    order: 4,
  },
  {
    permissionName: "Course Management",
    permissionKey: "coursestructure",
    // Exact strings checked by hasPermission() in the coursestructure pages
    // ("Dublicate" / "Upload Resourses" typos are what the UI checks — keep them)
    permissionFunctionality: [
      "Add Course Structure", "View Full Details", "Add Course", "Add Participants",
      "Upload Resourses", "Edit Course", "Delete Course", "Dublicate",
      "Program Calendar", "Add Feedback",
    ],
    icon: "BookOpen",
    color: "purple",
    description: "Manage courses and course structure",
    isActive: true,
    order: 5,
  },
  {
    permissionName: "Calendar",
    permissionKey: "calendar",
    permissionFunctionality: ["Add", "Edit", "Delete"],
    icon: "Calendar",
    color: "green",
    description: "Manage calendar and scheduling",
    isActive: true,
    order: 6,
  },
  {
    permissionName: "Program Calendar",
    permissionKey: "programcalender",
    permissionFunctionality: ["Add", "Edit", "Delete"],
    icon: "CalendarDays",
    color: "orange",
    description: "Manage program and holiday calendars",
    isActive: true,
    order: 7,
  },
  {
    // Question Bank ▸ Internal. Keeps the original `questionbanks` key, so
    // every already-issued grant and every route/link is untouched — only the
    // display name narrowed from "Question Banks" now that External is its own
    // grantable page below. Functions match `admin-question-banks` in the
    // client's config/permissions.tree.ts, which is what the UI checks.
    permissionName: "Internal Questions",
    permissionKey: "questionbanks",
    permissionFunctionality: [
      "Create Question", "View Details", "Edit", "Delete", "Deactivate",
    ],
    icon: "Library",
    color: "cyan",
    description: "Institution's own question bank — one document per tenant",
    isActive: true,
    order: 8,
  },
  {
    // Question Bank ▸ External — the shared, platform-imported library
    // (~5k Exercism/CP questions) that every tenant reads. No functions: the
    // page role-gates its own writes to admin / super_admin in-file, so this
    // permission decides only whether the rail entry appears.
    //
    // NOT at /lms/pages/questionbanksexternal — see PERMISSION_ROUTES in
    // client/src/app/lms/shared/navRoutes.ts, which maps it to
    // /lms/pages/questionbanks/external for every shell and the route gate.
    permissionName: "External Questions",
    permissionKey: "questionbanksexternal",
    permissionFunctionality: [],
    icon: "Globe",
    color: "cyan",
    description: "Shared platform-imported bank, common to every institution",
    isActive: true,
    order: 9,
  },
  {
    permissionName: "Grades",
    permissionKey: "grades",
    permissionFunctionality: ["View Grades", "Edit Grades", "Export"],
    icon: "GraduationCap",
    color: "yellow",
    description: "Manage grades",
    isActive: true,
    order: 10,
  },
  {
    permissionName: "Attendance Management",
    permissionKey: "attendancemanagement",
    permissionFunctionality: [
      "view_attendance", "mark_attendance", "edit_attendance",
      "generate_reports", "export_data",
    ],
    icon: "UserCheck",
    color: "purple",
    description: "Manage attendance records",
    isActive: true,
    order: 11,
  },
  {
    permissionName: "Notifications",
    permissionKey: "notifications",
    permissionFunctionality: ["view_notifications", "edit_notifications"],
    icon: "Bell",
    color: "red",
    description: "Manage notifications",
    isActive: true,
    order: 12,
  },
  {
    permissionName: "Audit Logs",
    permissionKey: "logs",
    permissionFunctionality: ["View Logs", "Login Report", "Export"],
    icon: "Activity",
    color: "gray",
    description: "View activity and login logs",
    isActive: true,
    order: 13,
  },
  {
    permissionName: "Dynamic Field Settings",
    permissionKey: "dynamicfieldsettings",
    permissionFunctionality: [
      "Service Modal", "Course Category", "Pedagogy", "Degree Management",
    ],
    icon: "Settings",
    color: "gray",
    description: "Configure dynamic fields",
    isActive: true,
    order: 14,
  },
  {
    permissionName: "Profiles",
    permissionKey: "profile",
    permissionFunctionality: [],
    icon: "UserCircle",
    color: "pink",
    description: "Profile management",
    isActive: true,
    order: 15,
  },
  {
    // Admin-side review queue for assessments/assignments that require approval
    // before students can see them. Sidebar position is fixed by
    // ADMIN_SIDEBAR_KEYS in the client (client/src/app/lms/shared/ui/navItems.ts);
    // this order only affects non-whitelisted sort and the grant script fallback.
    permissionName: "Approvals",
    permissionKey: "approvals",
    permissionFunctionality: ["View Approvals", "Approve", "Reject"],
    icon: "ShieldCheck",
    color: "orange",
    description: "Review and approve assessments and assignments before students see them",
    isActive: true,
    order: 16,
  },
  {
    // Point-of-Contact console. UNLIKE every other entry here, its page is NOT
    // at /lms/pages/<permissionKey> — it lives at /lms/pages/poc/dashboard.
    // The client maps the key to that route in ONE place (PERMISSION_ROUTES in
    // client/src/app/lms/shared/ui/navItems.ts), which the sidebar, the
    // command palette and the route gate all read.
    //
    // The key ends in "dashboard", so saveRolePermissions treats it as
    // dashboard-family: the institution/role matrix never propagates it, and
    // each user keeps whichever dashboard they already hold. Granting it is a
    // per-user action through the LMS Assign Permission modal
    // (Admin ▸ POC Dashboard), which is where a POC gets it.
    permissionName: "POC Dashboard",
    permissionKey: "pocdashboard",
    // Intentionally empty, matching `admin-poc-dashboard` in the client's
    // config/permissions.tree.ts: the dashboard is granted whole, so it has no
    // per-function toggles — the same shape as Admin Dashboard.
    permissionFunctionality: [],
    icon: "LayoutDashboard",
    color: "orange",
    description: "Point-of-Contact console — courses, learners, clients and services inside the POC's own scope",
    isActive: true,
    order: 17,
  },
];

// Returns a deep copy so callers can safely assign it to a mongoose doc
// without sharing subdocument state between users.
const getSuperAdminPermissions = () =>
  SUPER_ADMIN_PERMISSIONS.map((p) => ({
    ...p,
    permissionFunctionality: [...p.permissionFunctionality],
  }));

// A role name counts as super admin regardless of separator/casing:
// "Super Admin", "super_admin", "superadmin", "Super Administrator", …
const isSuperAdminRoleName = (roleName) =>
  String(roleName || "").toLowerCase().replace(/[\s_-]+/g, "").includes("superadmin");

module.exports = { SUPER_ADMIN_PERMISSIONS, getSuperAdminPermissions, isSuperAdminRoleName };
