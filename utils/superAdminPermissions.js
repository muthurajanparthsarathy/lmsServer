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
    permissionName: "Question Banks",
    permissionKey: "questionbanks",
    permissionFunctionality: ["Add Question", "Edit Question", "Delete Question", "Approve"],
    icon: "FileText",
    color: "cyan",
    description: "Manage question banks",
    isActive: true,
    order: 8,
  },
  {
    permissionName: "Grades",
    permissionKey: "grades",
    permissionFunctionality: ["View Grades", "Edit Grades", "Export"],
    icon: "GraduationCap",
    color: "yellow",
    description: "Manage grades",
    isActive: true,
    order: 9,
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
    order: 10,
  },
  {
    permissionName: "Notifications",
    permissionKey: "notifications",
    permissionFunctionality: ["view_notifications", "edit_notifications"],
    icon: "Bell",
    color: "red",
    description: "Manage notifications",
    isActive: true,
    order: 11,
  },
  {
    permissionName: "Audit Logs",
    permissionKey: "logs",
    permissionFunctionality: ["View Logs", "Login Report", "Export"],
    icon: "Activity",
    color: "gray",
    description: "View activity and login logs",
    isActive: true,
    order: 12,
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
    order: 13,
  },
  {
    permissionName: "Profiles",
    permissionKey: "profile",
    permissionFunctionality: [],
    icon: "UserCircle",
    color: "pink",
    description: "Profile management",
    isActive: true,
    order: 14,
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
    order: 15,
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
