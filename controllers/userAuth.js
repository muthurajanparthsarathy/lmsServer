const User = require("../models/UserModel");
const ActivityLog = require("../models/ActivityLog");
const Otp = require("../models/OTPModel");
const { createSecretToken } = require("../config/secretToken");
const config = require("config");
const BASE_URL = config.get("BASE_URL");
const mongoose = require("mongoose");
const Role = require("../models/RoleModel");

const bcrypt = require("bcryptjs");
const emailUtil = require("../utils/sendEmail");
const EmailService = require("../utils/sendEmail");
const jwt = require("jsonwebtoken");
const JWT_TOKEN_KEY = config.get("JWT_TOKEN_KEY");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const tokenModal = require("../models/tokenModal");
const xlsx = require("xlsx");
const { autoEnrollUser } = require("../utils/autoEnrollUser");

const { createClient } = require("@supabase/supabase-js");
const BulkSendMail = require("../models/BulkSendMailCount");
const InstitutionModal = require("../models/InstitutionModal");
const { getSuperAdminPermissions, isSuperAdminRoleName } = require("../utils/superAdminPermissions");
const roleModel = require("../models/RoleModel");
const supabaseKey = process.env.SUPABASE_KEY;
const supabaseUrl = process.env.SUPABASE_URL;

const supabase = createClient(supabaseUrl, supabaseKey);

// Build a 2-4 letter prefix from an institution name.
// Multi-word: first letter of each word ("Peelemedu Samanaidu Govindasamy" -> "PSG").
// Single-word: first 3 letters of the word ("Anna" -> "ANN").
// Falls back to "INS" if nothing usable is found.
const buildInstitutionPrefix = (instName) => {
  if (!instName || typeof instName !== "string") return "INS";
  const cleaned = instName.replace(/[^A-Za-z\s]/g, "").trim();
  if (!cleaned) return "INS";
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words.map((w) => w[0].toUpperCase()).join("").slice(0, 4);
  }
  return words[0].slice(0, 3).toUpperCase();
};

// Atomically reserve the next sequence number for this institution
// and return the formatted userId (e.g. "PSG0001").
const generateUserIdForInstitution = async (institutionId) => {
  if (!institutionId) return null;
  const updated = await InstitutionModal.findOneAndUpdate(
    { _id: institutionId },
    { $inc: { userIdCounter: 1 } },
    { new: true }
  );
  if (!updated) return null;
  const prefix = buildInstitutionPrefix(updated.inst_name);
  const seq = String(updated.userIdCounter).padStart(4, "0");
  return `${prefix}${seq}`;
};

const getDefaultPermissions = (roleName) => {
  // Super admin gets the full module catalog (matches "Super Admin",
  // "super_admin", "Super Administrator", etc.)
  if (isSuperAdminRoleName(roleName)) {
    return getSuperAdminPermissions();
  }

  // Student permissions
  if (roleName === 'student') {
    return [
      {
        permissionName: "Student Dashboard",
        permissionKey: "studentdashboard",
        permissionFunctionality: [
          "view_courses",
          "view_grades",
          "submit_assignments"
        ],
        icon: "Home",
        color: "green",
        description: "Student Dashboard Access",
        isActive: true,
        order: 0
      }
    ];
  }
  
  // Admin permissions
  if (roleName === 'admin') {
    return [
      {
        permissionName: "Admin Dashboard",
        permissionKey: "admindashboard",
        permissionFunctionality: [
          "view_users",
          "add_users",
          "edit_users",
          "delete_users"
        ],
        icon: "Home",
        color: "green",
        description: "Admin Dashboard Management",
        isActive: true,
        order: 0
      }
    ];
  }
  
  // Staff permissions - This will apply to ALL other roles (faculty, coordinator, manager, etc.)
  // Any role that is not 'student' or 'admin' will get these permissions
  return [
    {
      permissionName: "Staff Dashboard",
      permissionKey: "dashboard",
      permissionFunctionality: [
        "view_users",
        "add_users",
        "edit_users",
        "delete_users"
      ],
      icon: "Home",
      color: "green",
      description: "Staff Dashboard Management",
      isActive: true,
      order: 0
    }
  ];
};

// Updated addUser function
exports.Addusers = async (req, res) => {
  try {
    const {
      email,
      firstName,
      lastName,
      phone,
      role, // This is the role ID
      gender,
      password,
      status,
      course,
      degree,
      department,
      year,
      semester,
      section,
      rollNumber,
      batch,
      phase,
      studentType,
      serviceModel,
      serviceMappingId,
      clientName,
      clientId,
    } = req.body;

    if (!email || !firstName || !lastName || !password) {
      return res.status(400).json({
        message: [{ key: "error", value: "Missing required fields" }],
      });
    }
    
    // Validate email format
    if (!emailUtil.isValidEmail(email)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid email format" }],
      });
    }

    // Two independent lookups — run them concurrently.
    const [existingEmployee, roleDetails] = await Promise.all([
      User.findOne({ email }),
      Role.findById(role),
    ]);
    if (existingEmployee) {
      return res.status(403).json({
        message: [{ key: "error", value: "User already exists" }],
      });
    }

    if (!roleDetails) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid role selected" }],
      });
    }

    // Get role name from the role details (use renameRole or originalRole)
    const roleName = roleDetails.renameRole ? roleDetails.renameRole.toLowerCase() : 
                     roleDetails.originalRole ? roleDetails.originalRole.toLowerCase() : 
                     'staff'; // Default to staff if role name is not found
    
    // Get default permissions based on role
    // For student and admin, specific permissions will be returned
    // For any other role (faculty, coordinator, manager, etc.), staff permissions will be returned
    const defaultPermissions = getDefaultPermissions(roleName);

    let imageUrl;
    const imageFile = req.files?.profile;

    if (imageFile) {
      const uniqueFileName = `${Date.now()}_${imageFile.name}`;
      const { data, error } = await supabase.storage
        .from("smartlms")
        .upload(`users/profile/${uniqueFileName}`, imageFile.data);

      if (error) {
        console.error("Error uploading image to Supabase:", error);
        return res.status(500).json({
          message: [
            { key: "error", value: "Error uploading image to Supabase" },
          ],
        });
      }
      imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/users/profile/${uniqueFileName}`;
    } else {
      const currentDate = new Date();
      const defaultFileName = `default_profile_image_${currentDate.getTime()}.jpg`;
      const { data, error } = await supabase.storage
        .from("smartlms")
        .copy(
          "users/profile/default_profile_image.jpg",
          `users/profile/${defaultFileName}`
        );

      if (error) {
        console.error("Error copying default image in Supabase:", error);
        return res.status(500).json({
          message: [
            { key: "error", value: "Error setting up default profile image" },
          ],
        });
      }
      imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/users/profile/${defaultFileName}`;
    }

    // Generate institution-scoped human-readable userId (e.g. "PSG0001")
    const generatedUserId = await generateUserIdForInstitution(req.user.institution);

    const newUser = await User.create({
      email,
      firstName,
      lastName,
      phone,
      gender,
      password,
      profile: imageUrl,
      role: role,
      course,
      batch,
      degree,
      department,
      year,
      semester,
      section,
      rollNumber,
      phase,
      clientName,clientId,
      studentType,
      serviceModel,
      serviceMappingId: serviceMappingId || undefined,
      status: status || "active",
      permissions: defaultPermissions, // Assign default permissions
      institution: req.user.institution,
      userId: generatedUserId,
      createdBy: req.user.email,
    });

    const token = createSecretToken(newUser._id);

    // Auto-enrol into every course this user's client ▸ degree ▸ department ▸
    // section already maps to, so they appear under the course's Enrollment
    // immediately instead of waiting for someone to open it and pull them in.
    //
    // Awaited, but NEVER allowed to fail the request. The user exists by this
    // point; losing that to an enrolment error — over a course the admin has
    // probably never heard of — would be a far worse outcome than a student who
    // has to be enrolled by hand. autoEnrollUser reports rather than throws, and
    // this try/catch is the second belt on top of that.
    try {
      // The actor is an ObjectId ref on the batch, so pass the id — NOT the
      // email. A string here fails a Mongoose cast and takes the whole save
      // down, which the catch below would hide as a silent "0 enrolled".
      const actorId = req.user?.id || req.user?._id;
      const enrolment = await autoEnrollUser(newUser, req.user.institution, actorId);
      if (enrolment.error) {
        console.error(`Auto-enrol error for ${newUser.email}:`, enrolment.error);
      } else {
        console.log(
          `Auto-enrol ${newUser.email}: ${enrolment.enrolled.length} enrolled, ${enrolment.skipped.length} skipped`
        );
      }
    } catch (enrolErr) {
      console.error(`Auto-enrol threw for ${newUser.email}:`, enrolErr.message);
    }

    const emailSubject = `Welcome to smartlms LMS - Your Account Details`;
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Welcome to the smartlms Dashboard</h2>
        <p>You have been successfully added as a user to our system.</p>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
          <h3 style="color: #495057;">Your Account Details:</h3>
          <p><strong>Name:</strong> ${firstName} ${lastName}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Temporary Password:</strong> ${password}</p>
          <p><strong>Role:</strong> ${roleDetails.renameRole || roleDetails.originalRole}</p>
        </div>
        
        <p><strong>Important:</strong> Please change your password after your first login for security purposes.</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.BASE_URL || "http://localhost:3000"}/login" 
             style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
             Login to Your Account
          </a>
        </div>
        
        <p style="color: #6c757d; font-size: 14px;">
          If you have any questions, please contact your administrator.
        </p>
      </div>
    `;

    // Send email
    const emailResult = await emailUtil.sendEmail({
      receiverEmails: email,
      subject: emailSubject,
      body: emailBody,
    });

    if (emailResult.success) {
      res.status(201).json({
        message: [{ key: "success", value: "User registered successfully with welcome email" }],
        user: {
          _id: newUser._id,
          userId: newUser.userId,
          email: newUser.email,
          firstName: newUser.firstName,
          lastName: newUser.lastName,
          institution: newUser.institution,
          permissions: newUser.permissions,
          profile: newUser.profile,
          role: newUser.role,
        },
        token: token,
      });
    } else {
      res.status(201).json({
        message: [
          { key: "success", value: "User registered successfully" },
          {
            key: "warning",
            value: `Welcome email failed to send: ${emailResult.error || 'Unknown error'}`,
          },
        ],
        user: {
          _id: newUser._id,
          userId: newUser.userId,
          email: newUser.email,
          firstName: newUser.firstName,
          lastName: newUser.lastName,
          institution: newUser.institution,
          permissions: newUser.permissions,
          profile: newUser.profile,
          role: newUser.role,
        },
        token: token,
      });
    }
  } catch (error) {
    console.error("Error creating user:", error);

    if (error.name === "ValidationError") {
      const errors = Object.keys(error.errors).map((key) => ({
        key,
        value: error.errors[key].message,
      }));
      return res.status(400).json({ message: errors });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        message: [
          { key: "error", value: "User with this email already exists" },
        ],
      });
    }

    res.status(500).json({
      message: [
        { key: "error", value: "Internal server error while creating user" },
      ],
    });
  }
};


module.exports.UserSignIn = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: [{ key: "error", value: "All fields are required" }],
      });
    }

    const user = await User.findOne({ email }).populate('institution').populate('role'); // Make sure to populate role

    if (!user) {
      return res.status(400).json({
        message: [{ key: "error", value: "Email is invalid" }],
      });
    }

    if (user.status !== 'active') {
      let errorMessage = "Account is not active";
      
      if (user.status === 'inactive') {
        errorMessage = "Your account is inactive. Please contact administrator";
      } else if (user.status === 'suspended') {
        errorMessage = "Your account has been suspended. Please contact administrator";
      }
      
      return res.status(403).json({
        message: [{ key: "error", value: errorMessage }],
      });
    }

    const auth = await bcrypt.compare(password, user.password);
    if (!auth) {
      return res.status(400).json({
        message: [{ key: "error", value: "Password is incorrect" }],
      });
    }

    const isFirstTimeLogin = user.firstTimeLoginDone;

    if (isFirstTimeLogin) {
      await User.updateOne({ _id: user._id }, { firstTimeLoginDone: false });
    }

    const token = createSecretToken(user._id, "2d");

    const newToken = new tokenModal({
      token: token,
    });
    await newToken.save();

    // Fire-and-forget login activity log — never blocks the login response
    const clientInfo = req.body.clientInfo || {};
    const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress || req.ip || '';
    // Normalise IPv4-mapped IPv6 loopback (::1, ::ffff:127.0.0.1) to a clean value
    const resolvedIp = /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(rawIp) ? 'localhost' : rawIp;
    ActivityLog.create({
      userId: user._id,
      userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      userEmail: user.email,
      userRole: user.role?.originalRole || user.role?.renameRole || '',
      action: 'login',
      details: {
        // Prefer the real public IP the client resolved; fall back to the
        // server-derived IP (which is 'localhost' in local development).
        ipAddress: clientInfo.ipAddress || resolvedIp,
        location:  clientInfo.location  || null,
        device:    clientInfo.device    || null,
        browser:   clientInfo.browser   || null,
        os:        clientInfo.os        || null,
        userAgent: clientInfo.userAgent || null,
      },
    }).catch(() => {});

    const sanitizedUser = {
      _id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      firstTimeLoginDone: isFirstTimeLogin,
      institution: user.institution._id,
      status: user.status,
      permissions:user.permissions,
    };

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
      maxAge: 2 * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      message: [
        { key: "success", value: `${user.role.originalRole} logged in successfully` },
      ],
      user: sanitizedUser,
      token: token,
      institution: user.institution._id,
      institutionName: user.institution.inst_name,
            basedOn: user.institution.basedOn,

      userId: user._id,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal Server Error" }],
    });
  }
};

module.exports.verifyToken = async (req, res, next) => {
  try {
    const token = req.cookies.token || req.headers.authorization?.split(" ")[1];
    
    if (!token) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const decoded = jwt.verify(token, JWT_TOKEN_KEY);

    const user = await User.findOne({ _id: decoded.id }).populate('role');

    if (!user) {
      return res.status(401).json({ message: "Invalid token" });
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

module.exports.UserLogout = async (req, res) => {
  try {
    const token = req.cookies.token || req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        message: [{ key: "error", value: "No token provided" }],
      });
    }

    const user = await User.findOneAndUpdate(
      { _id: req.user._id },
      { $pull: { tokens: { token: token } } },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    res.clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
    });

    return res.status(200).json({
      message: [{ key: "success", value: "Logged out successfully" }],
    });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal Server Error" }],
    });
  }
};

module.exports.UserLogoutAll = async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { _id: req.user._id },
      { $set: { tokens: [] } },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    // Clear the cookie
    res.clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
    });

    return res.status(200).json({
      message: [
        { key: "success", value: "Logged out from all devices successfully" },
      ],
    });
  } catch (error) {
    console.error("Logout all error:", error);
    return res.status(500).json({
      message: [{ key: "error", value: "Internal Server Error" }],
    });
  }
};

module.exports.UserVerify = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    const sanitizedUser = {
      id: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      address: user.address,
      profile: user.profile,
      role: user.role.originalRole,
      designation: user.designation,
      institution: user.institution,
      permission: user.permission,
    };

    return res.status(200).json({
      user: sanitizedUser,
    });
  } catch (error) {
    return res.status(500).json({
      message: [
        { key: "error", value: "Internal Server Error", detail: error.message },
      ],
    });
  }
};
// Collation matching the page's `toLowerCase() + localeCompare(numeric:true)`.
const LIST_COLLATION = { locale: 'en', strength: 2, numericOrdering: true };

// Escape user input before it becomes a regex — without this a search for
// "a.b" or "c++" matches the wrong rows, and a pathological pattern is a
// denial-of-service against a 100k collection.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One page of the institution's users, filtered and sorted in Mongo.
 *
 * Kept separate from getUserAccess so the untouched full-list path stays
 * readable and its other three consumers keep the exact response they had.
 */
async function getUserAccessPaginated(req, res, baseFilter) {
  const {
    page, limit, search, roles, status, degree, department, year, batch,
    sortKey, sortDir,
  } = req.query;

  // Export mode. The page's "Export all" writes a CSV of every row matching the
  // current filters, not just the visible page — so it needs the whole result
  // set, which it pulls in large chunks of the THIRTEEN columns the CSV
  // actually has. Same filters, same sort, ~150 bytes a row instead of ~2.6 KB.
  const isExport = req.query.export === '1' || req.query.export === 'true';
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const perPage = Math.min(isExport ? 5000 : 200, Math.max(1, parseInt(limit, 10) || 25));

  const filter = { ...baseFilter };

  // Search — the same five fields the page matched on, all `contains`.
  if (search && String(search).trim()) {
    const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
    filter.$or = [
      { firstName: rx }, { lastName: rx }, { email: rx },
      { degree: rx }, { department: rx },
    ];
  }
  // Multi-select roles; the page compared against the user's role id.
  const roleIds = String(roles || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (roleIds.length) filter.role = { $in: roleIds };
  // The page treated "" and "all" as no filter for each of these.
  const eq = (v) => v && v !== 'all';
  // transformUser (queries/users.ts) does `status: user.status || "active"`,
  // so a document with NO status counts as active on the page. Matching only
  // `{status:'active'}` here silently dropped those users — caught by diffing
  // this against the client predicate (179 vs 174).
  if (eq(status)) {
    filter.status = status === 'active'
      ? { $in: ['active', null, ''] }
      : status;
  }
  if (eq(degree)) filter.degree = degree;
  if (eq(department)) filter.department = department;
  if (eq(year)) filter.year = year;
  if (eq(batch)) filter.batch = batch;

  // Sort. The page's default (no sortKey) is newest-first, which is what the
  // client-side transform applied; `_id` breaks ties so paging is stable.
  const dir = sortDir === 'desc' ? -1 : 1;
  // Tie-break must reproduce the page's own ordering. It sorts a list that is
  // already newest-first, and Array.prototype.sort is stable — so rows with an
  // equal sort key keep newest-first. For descending the page sorts ascending
  // and then `.reverse()`s, which flips the ties too, giving oldest-first.
  // Hence `-dir`: newest-first when ascending, oldest-first when descending.
  const tie = { createdAt: -dir, _id: -dir };
  // KNOWN, BOUNDED DEVIATION — the Name sort.
  //
  // The page compared `${firstName} ${lastName}` as ONE concatenated string.
  // This compares the two fields in order, which is the same ordering EXCEPT
  // for rows whose stored name has leading/trailing whitespace: concatenation
  // inserts the separator before the second field, so " " vs the first
  // character of lastName decides it, where a field-wise compare settles it on
  // firstName alone. Measured on the live institution: 4 of 179 rows carry
  // such whitespace ("kiot  ", "VARSINI ", "METHUN ", "DHANUSH ") and exactly
  // those 4 positions move; every other sort and every filter is identical.
  //
  // Reproducing the concatenation would mean sorting on a computed `$concat`,
  // which no index can serve — a blocking in-memory sort of the whole
  // collection, which is the thing this endpoint exists to avoid. Trimming the
  // stored names removes the difference at the source; flagged separately.
  const SORTABLE = {
    name: { firstName: dir, lastName: dir, ...tie },
    phone: { phone: dir, ...tie },
  };
  const sort = SORTABLE[sortKey] || { createdAt: -1, _id: -1 };

  // Also drops `permissions` — 45% of a page's bytes. Verified unused on this
  // path: transformUser (queries/users.ts) never maps it, and PermissionModal
  // receives only `userId` and loads permissions itself. The FULL-list path
  // above still returns it, for consumers that may rely on it.
  let projection = '-password -tokens -notifications -ai_history -courses -permissions';
  // The CSV's columns, verbatim (see exportUsers in the page). `role` is the id
  // the populate below resolves to a display name.
  if (isExport) {
    projection = 'firstName lastName email phone gender role batch degree '
      + 'department semester section clientName status';
  }

  let Users;
  let total;

  // ── Sorting by role or status ──────────────────────────────────────────────
  // Neither is a plain stored field. `role` sorts on the POPULATED display
  // name, and `status` on the DEFAULTED one ("" and missing both read as
  // "active" on the page). The obvious implementation computes the value in an
  // aggregation and sorts on it — correct, but a computed sort can use no
  // index, so producing ONE page means an in-memory sort of every user in the
  // institution. That is the exact cost this endpoint exists to remove.
  //
  // Instead: both fields have very few DISTINCT values (a handful of roles, two
  // statuses), and every row sharing a value is a tie. So order the VALUES,
  // then walk them in order, taking the page's slice out of whichever
  // value-bucket it lands in. Each bucket read is an equality match plus the
  // createdAt/_id tie-break — exactly the shape of the compound indexes in
  // UserModel — so a page reads its 25 documents and no more, at any scale.
  if (sortKey === 'role' || sortKey === 'status') {
    // The distinct values under the CURRENT filter AND their counts, in ONE
    // round trip. `$match` + `$group` on the sort field is served by the
    // compound index (both fields are in it, so no document is fetched).
    //
    // This replaces a `distinct()` followed by a per-bucket countDocuments.
    // Every hop to this cluster costs ~35 ms, and the serial version — discover
    // values, then count or read one bucket at a time until the page filled —
    // measured 551 ms for a role-sorted page against 225 ms for an unsorted
    // one. Knowing every count up front means the page's buckets can be read
    // together instead of one after another.
    //
    // `aggregate()` does NOT cast a filter against the schema the way `find()`
    // does, so the institution id (a string from the URL) has to be cast by
    // hand or `$match` silently matches nothing.
    const grouped = await User.aggregate([
      { $match: User.find(filter).cast(User) },
      { $group: { _id: `$${sortKey}`, n: { $sum: 1 } } },
    ]);
    const countByRaw = new Map(grouped.map((g) => [String(g._id), g.n]));
    const rawValues = grouped.map((g) => g._id);

    const buckets = new Map();
    const addToBucket = (label, raw) => {
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(raw);
    };
    if (sortKey === 'status') {
      // "" and missing both display as active — the page's `status || "active"`.
      rawValues.forEach((v) => addToBucket(v || 'active', v));
    } else {
      const roleIds = rawValues.filter(Boolean);
      const roleDocs = roleIds.length
        ? await Role.find({ _id: { $in: roleIds } }).select('renameRole').lean()
        : [];
      const nameById = new Map(roleDocs.map((r) => [String(r._id), r.renameRole]));
      // A role id with no surviving Role document populates to null, which the
      // page renders as "Unknown Role" — same for a blank renameRole.
      rawValues.forEach((v) => addToBucket((v && nameById.get(String(v))) || 'Unknown Role', v));
    }

    // `distinct` reports null for a missing field when unfiltered, but DROPS it
    // once a filter is applied — so with `status=active` (which matches the
    // documents that have no status at all) the 5 status-less users had no
    // bucket to land in and vanished from the count. The fallback bucket
    // therefore always carries the absent forms explicitly. `role` is an
    // ObjectId field, so "" is not among them: it would fail to cast.
    const fallbackLabel = sortKey === 'status' ? 'active' : 'Unknown Role';
    const absentForms = sortKey === 'status' ? [null, ''] : [null];
    buckets.set(fallbackLabel, [
      ...new Set([...(buckets.get(fallbackLabel) || []), ...absentForms]),
    ]);

    // Order the labels the way the page ordered them, then reverse for desc —
    // including the ties, which the tie-break below already mirrors.
    const ordered = [...buckets.keys()].sort((a, b) =>
      String(a).toLowerCase().localeCompare(String(b).toLowerCase(), undefined, { numeric: true }));
    if (dir === -1) ordered.reverse();

    // Equality when a label maps to a single stored value (every role bucket,
    // and "inactive"): a one-point predicate lets the skip walk index keys,
    // where `$in` makes it fetch each document first. Only the "active" bucket
    // is multi-valued, since "", null and missing all display as active.
    const bucketFilter = (label) => {
      const values = buckets.get(label);
      const predicate = values.length === 1 ? values[0] : { $in: values };
      // When the sort field is ALSO being filtered on (sort by status while
      // filtering status), the bucket must INTERSECT that filter, not replace
      // it — overwriting the key let the fallback bucket pull in rows the
      // filter had excluded.
      if (filter[sortKey] === undefined) return { ...filter, [sortKey]: predicate };
      const { [sortKey]: existing, ...rest } = filter;
      return {
        ...rest,
        $and: [...(filter.$and || []), { [sortKey]: existing }, { [sortKey]: predicate }],
      };
    };
    // Counts are already known, so the page's slice is pure arithmetic: walk
    // the labels in order, skip whole buckets the offset clears, and record
    // the (skip, limit) each remaining bucket owes. No query yet.
    const bucketCount = (label) => buckets.get(label)
      .reduce((sum, raw) => sum + (countByRaw.get(String(raw)) || 0), 0);
    total = ordered.reduce((sum, label) => sum + bucketCount(label), 0);

    const reads = [];
    let skipLeft = (pageNum - 1) * perPage;
    let need = perPage;
    for (let i = 0; i < ordered.length && need > 0; i += 1) {
      const count = bucketCount(ordered[i]);
      if (skipLeft >= count) { skipLeft -= count; continue; }
      const take = Math.min(need, count - skipLeft);
      reads.push({ label: ordered[i], skip: skipLeft, take });
      need -= take;
      skipLeft = 0;
    }

    // A page usually sits inside ONE bucket; when it straddles a boundary the
    // reads are independent, so they go together rather than in sequence.
    // No collation here: within a bucket the sort is on createdAt/_id, which
    // are not strings — and a collation would demand a collated index that
    // this one deliberately is not.
    const chunks = await Promise.all(reads.map((r) => {
      const q = User.find(bucketFilter(r.label)).select(projection);
      if (!isExport) q.populate('institution', 'inst_name basedOn');
      return q
        .populate('role', 'originalRole renameRole roleValue institution')
        .sort(tie)
        .skip(r.skip)
        .limit(r.take)
        .lean();
    }));
    Users = chunks.flat();
  } else {
    const q = User.find(filter).select(projection);
    if (!isExport) q.populate('institution', 'inst_name basedOn');
    [Users, total] = await Promise.all([
      q
        .populate('role', 'originalRole renameRole roleValue institution')
        .collation(LIST_COLLATION)
        .sort(sort)
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean(),
      User.countDocuments(filter),
    ]);
  }

  // A CSV chunk needs neither the facet list nor the client-name join.
  if (isExport) {
    return res.status(200).json({
      message: [{ key: 'success', value: 'Users export chunk retrieved' }],
      Users, total, page: pageNum, limit: perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  }

  // The client's Batch dropdown was built from the loaded rows; with only one
  // page in hand it has to come from the server, over the whole institution
  // rather than the current filter (the page listed every batch, always).
  const batches = (await User.distinct('batch', baseFilter))
    .filter(Boolean)
    .sort();

  // Client lookup for just this page's rows, not the whole directory.
  const clientSubDocIds = [...new Set(Users.map((u) => u.clientId).filter(Boolean))];
  const ClientManagement = mongoose.model('LMS-ClientManagement');
  const allClientDocs = clientSubDocIds.length
    ? await ClientManagement.find({ _id: { $in: clientSubDocIds } }).lean()
    : [];
  const clientMap = {};
  allClientDocs.forEach((c) => { if (c._id) clientMap[c._id.toString()] = c; });

  const transformedUsers = Users.map((user) => {
    const userObj = { ...user };
    if (user.clientId) {
      userObj.clientId = clientMap[user.clientId.toString()] || null;
    }
    return userObj;
  });

  return res.status(200).json({
    message: [{ key: 'success', value: 'Users page retrieved' }],
    Users: transformedUsers,
    total,
    page: pageNum,
    limit: perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
    facets: { batches },
  });
}

/**
 * The six roster figures the admin Profile page shows, counted in Mongo.
 *
 * Every rule here is a port of that page's own derivation (ProfilePage.tsx,
 * `dashboardStats`), so the numbers are the ones it has always displayed:
 *   • the role bucket reads roleValue and falls back to originalRole — with
 *     `||` semantics, where an EMPTY STRING also falls through;
 *   • `activeUsers` tests the RAW stored status, so a user with no status is
 *     NOT counted active (deliberately unlike the user-management list, whose
 *     transform defaults a missing status to "active");
 *   • `newUsers` uses a cutoff the BROWSER computed, passed in as epoch ms,
 *     because the page derived it from local time.
 */
async function getUserAccessStats(req, res, filter) {
  const STUDENT = 'student';
  const STAFF_ROLES = ['poc', 'trainer'];
  const ADMIN_ROLES = ['admin', 'ldhead', 'subhead', 'programcoordinator'];

  const since = Number(req.query.since);
  const cutoff = Number.isFinite(since) ? new Date(since) : new Date(Date.now() - 30 * 86400000);

  // `aggregate()` does not cast a filter the way `find()` does — the
  // institution id arrives as a string, so an uncast $match matches nothing.
  const match = User.find(filter).cast(User);

  const [row] = await User.aggregate([
    { $match: match },
    { $lookup: { from: 'roles', localField: 'role', foreignField: '_id', as: '_r' } },
    {
      $addFields: {
        _rv: {
          $toLower: {
            $let: {
              vars: { v: { $ifNull: [{ $first: '$_r.roleValue' }, ''] } },
              in: {
                $cond: [
                  { $eq: ['$$v', ''] },
                  { $ifNull: [{ $first: '$_r.originalRole' }, ''] },
                  '$$v',
                ],
              },
            },
          },
        },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        students: { $sum: { $cond: [{ $eq: ['$_rv', STUDENT] }, 1, 0] } },
        staff: { $sum: { $cond: [{ $in: ['$_rv', STAFF_ROLES] }, 1, 0] } },
        admin: { $sum: { $cond: [{ $in: ['$_rv', ADMIN_ROLES] }, 1, 0] } },
        newUsers: { $sum: { $cond: [{ $gte: ['$createdAt', cutoff] }, 1, 0] } },
        activeUsers: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
      },
    },
  ]);

  const stats = row || {
    total: 0, students: 0, staff: 0, admin: 0, newUsers: 0, activeUsers: 0,
  };
  delete stats._id;

  return res.status(200).json({
    message: [{ key: 'success', value: 'User stats retrieved' }],
    stats,
  });
}

exports.getUserAccess = async (req, res) => {
  try {
    const { instutionId } = req.params;
    
    let filter = {};
    if (instutionId && instutionId !== 'all') {
      filter.institution = instutionId;
    }

    // ── Paginated mode (opt-in via `page`) ────────────────────────────────────
    // Sized for a six-figure directory. Without `page` this endpoint returns
    // the whole institution, which is what EnrollmentTab, EnrollUsersModal and
    // the Profile stats still expect — so that path is left exactly as it was.
    //
    // With `page`, the search, the six filters and the sort all run in Mongo
    // and only one page crosses the wire. The predicates below are ports of
    // the user-management page's own `filteredUsersList` useMemo, field for
    // field, so a given filter set selects the same rows it always did.
    //
    // Collation matters: the client compared with
    // `String(x).toLowerCase().localeCompare(y, undefined, { numeric: true })`.
    // `{ locale: 'en', strength: 2, numericOrdering: true }` is the Mongo
    // equivalent — case-insensitive, and "Batch 10" sorts after "Batch 9"
    // rather than before it.
    if (req.query.page !== undefined) {
      return await getUserAccessPaginated(req, res, filter);
    }

    // ── Counts-only mode (opt-in via `stats=1`) ──────────────────────────────
    // The admin Profile page displays six numbers derived from the roster and
    // nothing else — no rows are rendered. It was fetching the ENTIRE user list
    // to count them: 583,744 bytes for 179 users, and about 311 MB at 100,000.
    // Counting is what a database is for.
    if (req.query.stats === '1' || req.query.stats === 'true') {
      return await getUserAccessStats(req, res, filter);
    }

    // Get all users. The exclusion projection drops the fields no consumer of
    // this endpoint reads (verified: usermanagement page, EnrollmentTab,
    // EnrollUsersModal, ProfilePage) — password hashes, session tokens,
    // private notifications, AI chat history and full course answer state
    // were ~1.2 MB of a measured 1.77 MB response for a 179-user institution,
    // and none of them belong in an admin list payload. The scoped populates
    // keep exactly the sub-fields consumers use.
    const Users = await User.find(filter)
      .select('-password -tokens -notifications -ai_history -courses')
      .populate('institution', 'inst_name basedOn')
      .populate('role', 'originalRole renameRole roleValue institution')
      .lean();
    
    if (!Users || Users.length === 0) {
      const message = instutionId && instutionId !== 'all'
        ? `No users found for institution ID: ${instutionId}`
        : "No users found";
      console.error(message);
      return res.status(404).json({ message });
    }
    
    // Get all unique client IDs referenced by users
    const clientSubDocIds = [...new Set(Users.map(user => user.clientId).filter(id => id))];

    // Fetch the referenced Client Management documents (standalone client management)
    const ClientManagement = mongoose.model('LMS-ClientManagement');
    const allClientDocs = await ClientManagement.find({
      _id: { $in: clientSubDocIds }
    }).lean();

    // Create a map of client _id to the client object
    const clientMap = {};
    allClientDocs.forEach(client => {
      if (client._id) {
        clientMap[client._id.toString()] = client;
      }
    });
    
    // Transform the users to include the specific client
    const transformedUsers = Users.map(user => {
      const userObj = { ...user };
      
      // If user has clientId, find it in the map
      if (user.clientId) {
        const clientIdStr = user.clientId.toString();
        if (clientMap[clientIdStr]) {
          userObj.clientId = clientMap[clientIdStr];
        } else {
          userObj.clientId = null;
        }
      }
      
      return userObj;
    });
    
    const successMessage = instutionId && instutionId !== 'all'
      ? `Users retrieved for institution ID: ${instutionId}`
      : "All users retrieved successfully";
    
    res.status(200).json({
      message: [{ key: "success", value: successMessage }],
      Users: transformedUsers,
      totalCount: transformedUsers.length,
    });
  } catch (error) {
    console.error("Error in getUserAccess:", error);
    res.status(500).json({ 
      message: [{ key: "error", value: "Internal server error" }] 
    });
  }
};
exports.getUserAccessById = async (req, res) => {
  const { id } = req.params;

  try {
    const user = await User.findById(id);
    if (!user) {
      return res
        .status(404)
        .json({ message: [{ key: "error", value: "User not found" }] });
    }

    res.status(200).json({
      message: [
        { key: "success", value: "User section Id based get the data" },
      ],
      user: user,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

exports.UpdateUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      email,
      firstName,
      lastName,
      phone,
      role, 
      gender,
      permission,
      status,
      batch,
      degree,
      department, year, semester, section, rollNumber,
      phase,
      studentType,serviceModel,clientName,clientId
    } = req.body;

    // Only email (duplicate check) and profile (old-image cleanup) are read
    // off this doc — no need to materialize notifications/courses/etc.
    const existingUser = await User.findById(userId).select("email profile");
    if (!existingUser) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    if (email && email !== existingUser.email) {
      const emailExists = await User.findOne({ email, _id: { $ne: userId } });
      if (emailExists) {
        return res.status(403).json({
          message: [{ key: "error", value: "Email already exists" }],
        });
      }
    }

    let imageUrl;
    const imageFile = req.files?.profile;

    if (imageFile) {
      if (
        existingUser.profile &&
        !existingUser.profile.includes("default_profile_image")
      ) {
        try {
          const oldImagePath = existingUser.profile.split("/").pop();
          const { error: deleteError } = await supabase.storage
            .from("smartlms")
            .remove([`users/profile/${oldImagePath}`]);

          if (deleteError) {
            console.error("Error deleting old image:", deleteError);
          }
        } catch (deleteErr) {
          console.error("Error extracting old image path:", deleteErr);
        }
      }

      const uniqueFileName = `${Date.now()}_${imageFile.name}`;
      const { data, error } = await supabase.storage
        .from("smartlms")
        .upload(`users/profile/${uniqueFileName}`, imageFile.data);

      if (error) {
        console.error("Error uploading image to Supabase:", error);
        return res.status(500).json({
          message: [
            { key: "error", value: "Error uploading image to Supabase" },
          ],
        });
      }
      imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/users/profile/${uniqueFileName}`;
    }

    const updateData = {
      ...(email && { email }),
      ...(firstName && { firstName }),
      ...(lastName && { lastName }),
      ...(phone && { phone }),
      ...(gender && { gender }),
      ...(batch && { batch }),
      ...(degree && { degree }),
      ...(department && { department }),
      ...(year && { year }),
      ...(semester && { semester }),
      ...(section && { section }),
      ...(rollNumber && { rollNumber }),
      ...(phase && { phase }),
      ...(role && { role }),
      ...(status && { status }),
      ...(permission && { permission }),
      ...(imageUrl && { profile: imageUrl }),
      ...(studentType && { studentType }),
      ...(serviceModel && { serviceModel }),
      ...(clientName && { clientName }),
      ...(clientId && { clientId }),
      updatedBy: req.user.email,
      updatedAt: new Date(),
    };

    const updatedUser = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
      runValidators: true,
    });

    if (!updatedUser) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    res.status(200).json({
      message: [{ key: "success", value: "User updated successfully" }],
      user: {
        _id: updatedUser._id,
        email: updatedUser.email,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        phone: updatedUser.phone,
        gender: updatedUser.gender,
        role: updatedUser.role,
        institution: updatedUser.institution,
        permission: updatedUser.permission,
        profile: updatedUser.profile,
        updatedAt: updatedUser.updatedAt,
      },
    });
  } catch (error) {
    console.error("Error updating user:", error);

    if (error.name === "ValidationError") {
      const errors = Object.keys(error.errors).map((key) => ({
        key,
        value: error.errors[key].message,
      }));
      return res.status(400).json({ message: errors });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        message: [
          { key: "error", value: "User with this email already exists" },
        ],
      });
    }

    res.status(500).json({
      message: [
        { key: "error", value: "Internal server error while updating user" },
      ],
    });
  }
};

exports.DeleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    // Only profile is read (for storage cleanup) before the delete.
    const existingUser = await User.findById(userId).select("profile");
    if (!existingUser) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    if (existingUser.profile) {
      try {
        const imageUrlParts = existingUser.profile.split("/");
        const imageName = imageUrlParts[imageUrlParts.length - 1];

        const { error: removeError } = await supabase.storage
          .from("smartlms")
          .remove([`users/profile/${imageName}`]);

        if (removeError) {
          console.error("Error removing image from Supabase:", removeError);
          return res.status(500).json({
            message: [
              {
                key: "error",
                value: "Error removing image from Supabase storage",
              },
            ],
          });
        }
      } catch (error) {
        console.error("Error in removing image:", error);
        return res.status(500).json({
          message: [
            {
              key: "error",
              value: "Error removing image from Supabase storage",
            },
          ],
        });
      }
    }
    const deletedUser = await User.findByIdAndDelete(userId);

    if (!deletedUser) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    res.status(200).json({
      message: [{ key: "success", value: "User deleted successfully" }],
      deletedUser: {
        _id: deletedUser._id,
        email: deletedUser.email,
        firstName: deletedUser.firstName,
        lastName: deletedUser.lastName,
      },
    });
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({
      message: [
        { key: "error", value: "Internal server error while deleting user" },
      ],
    });
  }
};


exports.toggleUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.body;

    if (!userId) {
      return res.status(400).json({
        message: [{ key: "error", value: "User ID is required" }],
      });
    }

    if (status && !["active", "inactive"].includes(status)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Status must be either 'active' or 'inactive'" }],
      });
    }

    // Only status is read (to compute the toggle when none was sent).
    const user = await User.findById(userId).select("status");
    if (!user) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    const newStatus = status || (user.status === "active" ? "inactive" : "active");
    
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { 
        status: newStatus,
        updatedAt: new Date(),
        updatedBy: req.user.email,
      },
      { 
        new: true,
        runValidators: true
      }
    ).select("-password -tokens");

    const emailSubject = "Account Status Update - smartlms HUB";
    let emailBody;

    if (newStatus === "inactive") {
      emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Account Status Update</h2>
          <p>Hello ${updatedUser.firstName} ${updatedUser.lastName},</p>
          
          <div style="background-color: #fff3cd; padding: 20px; border-left: 4px solid #ffc107; margin: 20px 0;">
            <h3 style="color: #856404;">Account Deactivated</h3>
            <p>Your account has been temporarily deactivated. Please contact your administrator if you believe this is an error.</p>
          </div>
          
          <p style="color: #6c757d; font-size: 14px;">
            If you have any questions, please contact your administrator.
          </p>
        </div>
      `;
    } else {
      emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Account Status Update</h2>
          <p>Hello ${updatedUser.firstName} ${updatedUser.lastName},</p>
          
          <div style="background-color: #d4edda; padding: 20px; border-left: 4px solid #28a745; margin: 20px 0;">
            <h3 style="color: #155724;">Account Activated</h3>
            <p>Great news! Your account has been activated and you can now access all features of the smartlms platform.</p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${process.env.BASE_URL || "http://localhost:3000"}/login" 
               style="background-color: #28a745; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
               Login to Your Account
            </a>
          </div>
          
          <p style="color: #6c757d; font-size: 14px;">
            If you have any questions, please contact your administrator.
          </p>
        </div>
      `;
    }

    emailUtil.sendEmail(updatedUser.email, emailSubject, emailBody)
      .catch(error => console.error("Failed to send status update email:", error));

    res.status(200).json({
      message: [{ 
        key: "success", 
        value: `User status updated to ${newStatus} successfully` 
      }],
      user: {
        _id: updatedUser._id,
        email: updatedUser.email,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        role: updatedUser.role,
        status: updatedUser.status,
        institution: updatedUser.institution,
      },
    });

  } catch (error) {
    console.error("Error updating user status:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid user ID format" }],
      });
    }

    res.status(500).json({
      message: [{ key: "error", value: "Internal server error while updating user status" }],
    });
  }
};

exports.bulkToggleUserStatus = async (req, res) => {
  try {
    const { userIds, status } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        message: [{ key: "error", value: "User IDs array is required" }],
      });
    }

    if (!status || !["active", "inactive"].includes(status)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Status must be either 'active' or 'inactive'" }],
      });
    }

    const result = await User.updateMany(
      { _id: { $in: userIds } },
      { 
        status: status,
        updatedAt: new Date(),
        updatedBy: req.user.email
      }
    );

    // Positive projection: the response maps _id/email/firstName/lastName/
    // role/status and the notification emails read the same fields — the old
    // exclusion projection still dragged every user's notifications/courses.
    const updatedUsers = await User.find(
      { _id: { $in: userIds } }
    ).select("email firstName lastName role status");

    const emailSubject = "Account Status Update - smartlms HUB";
    
    const emailPromises = updatedUsers.map(user => {
      let emailBody;
      
      if (status === "inactive") {
        emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Account Status Update</h2>
            <p>Hello ${user.firstName} ${user.lastName},</p>
            
            <div style="background-color: #fff3cd; padding: 20px; border-left: 4px solid #ffc107; margin: 20px 0;">
              <h3 style="color: #856404;">Account Deactivated</h3>
              <p>Your account has been temporarily deactivated. Please contact your administrator if you believe this is an error.</p>
            </div>
            
            <p style="color: #6c757d; font-size: 14px;">
              If you have any questions, please contact your administrator.
            </p>
          </div>
        `;
      } else {
        emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Account Status Update</h2>
            <p>Hello ${user.firstName} ${user.lastName},</p>
            
            <div style="background-color: #d4edda; padding: 20px; border-left: 4px solid #28a745; margin: 20px 0;">
              <h3 style="color: #155724;">Account Activated</h3>
              <p>Great news! Your account has been activated and you can now access all features of the smartlms platform.</p>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.BASE_URL || "http://localhost:3000"}/signin" 
                 style="background-color: #28a745; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
                 Login to Your Account
              </a>
            </div>
            
            <p style="color: #6c757d; font-size: 14px;">
              If you have any questions, please contact your administrator.
            </p>
          </div>
        `;
      }
      
      return emailUtil.sendEmail(user.email, emailSubject, emailBody)
        .catch(error => console.error(`Failed to send status update email to ${user.email}:`, error));
    });

    Promise.all(emailPromises)
      .catch(error => console.error("Some emails failed to send:", error));

    res.status(200).json({
      message: [{ 
        key: "success", 
        value: `${result.modifiedCount} users updated to ${status} successfully` 
      }],
      updatedCount: result.modifiedCount,
      users: updatedUsers.map(user => ({
        _id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        status: user.status,
      })),
    });

  } catch (error) {
    console.error("Error bulk updating user status:", error);

    res.status(500).json({
      message: [{ key: "error", value: "Internal server error while updating users status" }],
    });
  }
};



exports.bulkUploadUsers = async (req, res) => {
  let filePath = null;

  try {
    const {
      notificationMethod,
      // Placement context chosen once in the modal and applied to every row, so
      // bulk users land with the same ObjectId refs the single Add User form
      // writes (role / clientId / serviceMappingId) instead of bare strings.
      role: formRoleId,
      clientId: formClientId,
      clientName: formClientName,
      serviceModel: formServiceModel,
      serviceMappingId: formServiceMappingId,
    } = req.body;
    let courses = req.body.courses;
    const institutionId = req.user.institution;

    if (!institutionId) {
      return res.status(400).json({
        message: [{ key: "error", value: "Institution is required" }],
      });
    }

    if (!req.files || !req.files.file) {
      return res.status(400).json({
        message: [{ key: "error", value: "File is required" }],
      });
    }

    const institutionDoc = await InstitutionModal.findById(institutionId);
    if (!institutionDoc) {
      return res.status(404).json({
        message: [{ key: "error", value: "Institution not found" }],
      });
    }

    const file = req.files.file;
    const uniqueFileName = `${Date.now()}_${file.name}`;
    filePath = path.join(__dirname, "..", "uploads", uniqueFileName);

    // Move file to uploads directory
    await file.mv(filePath);

    // Process the Excel file
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const results = xlsx.utils.sheet_to_json(worksheet);
    if (results.length > 78) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return res.status(400).json({
        message: [{ key: "error", value: "Cannot upload more than 70 users" }],
      });
    }

    // Handle courses - ensure it's an array
    if (courses) {
      if (typeof courses === 'string') {
        courses = [courses];
      } else if (!Array.isArray(courses)) {
        courses = [];
      }
    } else {
      courses = [];
    }

    // Validate course IDs if provided
    const validCourses = [];
    if (courses.length > 0) {
      for (const courseId of courses) {
        try {
          // Check if course exists - adjust model name as needed
          const course = await CourseStructureModal.findById(courseId);
          if (course) {
            validCourses.push(courseId);
          } else {
            console.warn(`Course not found: ${courseId}`);
          }
        } catch (error) {
          console.warn(`Invalid course ID: ${courseId}`, error);
        }
      }
    }

    const users = [];
    const existingUsers = [];
    const sentEmails = [];
    const notSentEmails = [];
    const totalEmail = [];
    const validationErrors = [];
    let creditExceeded = false;

    // ── Resolve the modal's context into real refs, once for the whole file ──
    //
    // Everything below mirrors Addusers. Before this, bulk-created users were
    // saved with no userId, no permissions (so they could log in and see
    // nothing), no profile image, no client/service refs, and their courses were
    // written to `enrolledCourses` — a field the User schema does not define, so
    // Mongoose silently dropped it and nobody was enrolled in anything.
    const isObjectId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v));

    // Client: prefer the id the modal picked; fall back to matching a name from
    // the sheet so the older name-only template still resolves to a real ref.
    let resolvedClientId = isObjectId(formClientId) ? formClientId : null;
    let resolvedClientName = (formClientName || "").trim();
    if (resolvedClientId && !resolvedClientName) {
      try {
        const ClientManagement = mongoose.model("LMS-ClientManagement");
        const clientDoc = await ClientManagement.findById(resolvedClientId);
        if (clientDoc) resolvedClientName = clientDoc.clientCompany || "";
      } catch (e) {
        console.warn("Bulk upload: could not read client", e.message);
      }
    }

    const resolvedServiceMappingId = isObjectId(formServiceMappingId)
      ? formServiceMappingId
      : undefined;
    const resolvedServiceModel = (formServiceModel || "").trim() || undefined;

    // Role chosen in the modal wins over the sheet's role-name column.
    let formRole = null;
    if (isObjectId(formRoleId)) {
      formRole = await roleModel.findById(formRoleId);
      if (!formRole) {
        return res.status(400).json({
          message: [{ key: "error", value: "Invalid role selected" }],
        });
      }
    }

    // One default-profile copy for the whole upload rather than one per row:
    // it is the same image, and 70 rows would otherwise mean 70 storage calls.
    // Safe to share — UpdateUser only deletes a previous image when the filename
    // does NOT contain "default_profile_image", so a user changing their picture
    // never removes the file the others still point at.
    let sharedDefaultProfileUrl = null;
    try {
      const defaultFileName = `default_profile_image_${Date.now()}.jpg`;
      const { error: copyError } = await supabase.storage
        .from("smartlms")
        .copy("users/profile/default_profile_image.jpg", `users/profile/${defaultFileName}`);
      if (!copyError) {
        sharedDefaultProfileUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/users/profile/${defaultFileName}`;
      } else {
        console.warn("Bulk upload: default profile copy failed:", copyError.message);
      }
    } catch (e) {
      console.warn("Bulk upload: default profile copy threw:", e.message);
    }

    const roleNameOf = (roleDoc) =>
      roleDoc?.renameRole
        ? roleDoc.renameRole.toLowerCase()
        : roleDoc?.originalRole
          ? roleDoc.originalRole.toLowerCase()
          : "staff";

    const existingRoles = await roleModel.find({ institution: institutionId });

    // Match a role NAME from the sheet against this institution's roles, so one
    // file can mix a Student row with an Admin row.
    //
    // Match-only, deliberately: this used to CREATE any role name it did not
    // recognise, so a typo ("Studnet") silently minted a new role, and everyone
    // on those rows got an account nobody could make sense of. An unmatched name
    // is now reported as a row error naming the roles that do exist.
    const findRoleByName = (roleName) => {
      if (!roleName) return null;
      const wanted = String(roleName).trim().toLowerCase();
      if (!wanted) return null;
      return (
        existingRoles.find(
          (r) =>
            r.originalRole?.toLowerCase() === wanted ||
            r.renameRole?.toLowerCase() === wanted
        ) || null
      );
    };

    const availableRoleNames = existingRoles
      .map((r) => r.renameRole || r.originalRole)
      .filter(Boolean)
      .join(", ");

    // Per-row clientName / serviceModel columns are resolved to the real refs
    // here, so a sheet can place users with different clients and services in one
    // upload. A spreadsheet can only carry names; clientId and serviceMappingId
    // are what actually get stored.
    const ClientManagement = mongoose.model("LMS-ClientManagement");
    const ServiceMapping = mongoose.model("LMS-ServiceMapping");

    const institutionClients = await ClientManagement.find({ institution: institutionId }).lean();
    const institutionMappings = await ServiceMapping.find({ institution: institutionId }).lean();

    const findClientByName = (name) => {
      const wanted = String(name || "").trim().toLowerCase();
      if (!wanted) return null;
      return institutionClients.find((c) => (c.clientCompany || "").trim().toLowerCase() === wanted) || null;
    };

    const clientIdOfMapping = (m) =>
      m.client && typeof m.client === "object" ? String(m.client._id) : String(m.client || "");

    // A client can run several mappings sharing one model name, so the model name
    // alone is ambiguous. Resolve within the row's client and, when more than one
    // still matches, say so rather than silently picking the first.
    const findMappingByModel = (modelName, forClientId) => {
      const wanted = String(modelName || "").trim().toLowerCase();
      if (!wanted || !forClientId) return { matches: [] };
      const matches = institutionMappings.filter((m) => {
        if (clientIdOfMapping(m) !== String(forClientId)) return false;
        const models = (m.serviceModels || []).map((s) => String(s).trim().toLowerCase());
        if (models.includes(wanted)) return true;
        return String(m.service || "").trim().toLowerCase() === wanted;
      });
      return { matches };
    };

    const availableClientNames = institutionClients
      .map((c) => c.clientCompany)
      .filter(Boolean)
      .join(", ");

    // Process each user
    for (const userData of results) {
      const {
        email, firstName, lastName, phone, role,  gender, password,
        studentType, clientName, degree, department, year, semester,
        rollNumber, section, phase
      } = userData;

      if (!email) {
        validationErrors.push({
          user: userData,
          error: "Email is required"
        });
        continue;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        validationErrors.push({
          user: userData,
          error: "Invalid email format"
        });
        notSentEmails.push({ email, firstName, lastName, role });
        continue;
      }
      
      // A row's own role wins, so one file can hold a Student row and an Admin
      // row. The modal's pick is the fallback for rows that leave it blank.
      const rowRoleName = role !== undefined && String(role).trim() ? String(role).trim() : "";
      const rowRole = rowRoleName ? findRoleByName(rowRoleName) : null;

      if (rowRoleName && !rowRole) {
        validationErrors.push({
          user: userData,
          error: `Unknown role "${rowRoleName}". Available roles: ${availableRoleNames || "none configured"}`,
        });
        notSentEmails.push({ email, firstName, lastName, role });
        continue;
      }

      const roleDoc = rowRole || formRole;
      if (!roleDoc) {
        validationErrors.push({
          user: userData,
          error: "No role for this row — set a role column or choose a default role",
        });
        notSentEmails.push({ email, firstName, lastName, role });
        continue;
      }
      const roleId = roleDoc._id;

      // Permissions are derived from the role NAME, exactly as Addusers does.
      // Without this a bulk user logs in to an empty app.
      const rowRoleLabel = roleNameOf(roleDoc);
      const defaultPermissions = getDefaultPermissions(rowRoleLabel);
      // Service placement is a student concept — the New user form only offers
      // Service Model for students, so an Admin row in the same file must not
      // inherit it. Client still applies to everyone, as it does on that form.
      const rowIsStudent = rowRoleLabel === "student";

      // ── Row-level client / service model ────────────────────────────────
      // A named column wins over the modal's pick, so one file can span several
      // clients. Names are resolved to ids; an unknown name is a row error
      // rather than a user filed against nothing.
      let rowClientId = resolvedClientId;
      let rowClientNameValue = resolvedClientName;
      const sheetClientName = clientName !== undefined && String(clientName).trim()
        ? String(clientName).trim()
        : "";
      if (sheetClientName) {
        const clientDoc = findClientByName(sheetClientName);
        if (!clientDoc) {
          validationErrors.push({
            user: userData,
            error: `Unknown client "${sheetClientName}". Available clients: ${availableClientNames || "none configured"}`,
          });
          notSentEmails.push({ email, firstName, lastName, role });
          continue;
        }
        rowClientId = clientDoc._id;
        rowClientNameValue = clientDoc.clientCompany || sheetClientName;
      }

      let rowServiceModel = rowIsStudent ? resolvedServiceModel : undefined;
      let rowServiceMappingId = rowIsStudent ? resolvedServiceMappingId : undefined;
      const sheetServiceModel = userData.serviceModel !== undefined && String(userData.serviceModel).trim()
        ? String(userData.serviceModel).trim()
        : "";
      if (sheetServiceModel) {
        if (!rowClientId) {
          validationErrors.push({
            user: userData,
            error: `serviceModel "${sheetServiceModel}" needs a client — set a clientName column or pick a client`,
          });
          notSentEmails.push({ email, firstName, lastName, role });
          continue;
        }
        const { matches } = findMappingByModel(sheetServiceModel, rowClientId);
        if (matches.length === 0) {
          validationErrors.push({
            user: userData,
            error: `Unknown service model "${sheetServiceModel}" for client "${rowClientNameValue || ""}"`,
          });
          notSentEmails.push({ email, firstName, lastName, role });
          continue;
        }
        if (matches.length > 1) {
          validationErrors.push({
            user: userData,
            error: `Service model "${sheetServiceModel}" matches ${matches.length} services for "${rowClientNameValue || ""}" — pick the Service Model above instead so the right one is used`,
          });
          notSentEmails.push({ email, firstName, lastName, role });
          continue;
        }
        rowServiceModel = (matches[0].serviceModels && matches[0].serviceModels[0]) || matches[0].service || sheetServiceModel;
        rowServiceMappingId = matches[0]._id;
      }

      totalEmail.push({ email, firstName, phone, lastName, role, gender });
      const existingUser = await User.findOne({ email, institution: institutionId });
      if (existingUser) {
        existingUsers.push({ ...userData, error: "User already exists" });
        notSentEmails.push({ email, firstName, lastName, role, gender });
        continue;
      }

      try {
        // Same institution-scoped human-readable id the single Add User issues
        // (e.g. "KIO0042"). Bulk users previously had none at all.
        const generatedUserId = await generateUserIdForInstitution(institutionId);

        // Prepare user data
        const userDataToSave = {
          email,
          firstName,
          lastName,
          password,
          role: roleId,
          phone,
          institution: institutionId,
          createdBy: req.user.email || "system",
          gender,
          userId: generatedUserId,
          permissions: defaultPermissions,
          status: "active",
          ...(sharedDefaultProfileUrl && { profile: sharedDefaultProfileUrl }),
          // Placement context from the modal — real ObjectId refs, so these
          // users are scoped to the right client/service like form-created ones.
          ...(rowClientId && { clientId: rowClientId }),
          ...(rowServiceModel && { serviceModel: rowServiceModel }),
          ...(rowServiceMappingId && { serviceMappingId: rowServiceMappingId }),
          // courses is the schema's real field ([{ courseId, progress }]);
          // the old `enrolledCourses` was not in the schema and was dropped.
          ...(validCourses.length > 0 && {
            courses: validCourses.map((courseId) => ({ courseId })),
          }),
        };

        // Stored name always comes from the resolved client record, so it stays
        // in step with clientId rather than echoing whatever the sheet typed.
        if (rowClientNameValue) {
          userDataToSave.clientName = rowClientNameValue;
        }

      
        if (rollNumber !== undefined && String(rollNumber).trim()) {
          userDataToSave.rollNumber = String(rollNumber).trim();
        }
        if (section && String(section).trim()) {
          userDataToSave.section = String(section).trim();
        }
        if (phase && String(phase).trim()) {
          userDataToSave.phase = String(phase).trim();
        }

        // Add student/degree fields if provided
        if (studentType && String(studentType).trim()) {
          userDataToSave.studentType = String(studentType).trim();
        }
        if (clientName && String(clientName).trim()) {
          userDataToSave.clientName = String(clientName).trim();
        }
        if (degree && String(degree).trim()) {
          userDataToSave.degree = String(degree).trim();
        }
        if (department && String(department).trim()) {
          userDataToSave.department = String(department).trim();
        }
        if (year && String(year).trim()) {
          userDataToSave.year = String(year).trim();
        }
        if (semester && String(semester).trim()) {
          userDataToSave.semester = String(semester).trim();
        }

        const newUser = new User(userDataToSave);
        await newUser.save();
        users.push(newUser);

        // Auto-enrol exactly as Addusers does, so a bulk user shows up under
        // their courses' Enrollment without anyone opening it. Reported, never
        // thrown: the account already exists, and losing it to an enrolment
        // error would be the worse outcome.
        try {
          const actorId = req.user?.id || req.user?._id;
          const enrolment = await autoEnrollUser(newUser, institutionId, actorId);
          if (enrolment.error) {
            console.error(`Auto-enrol error for ${newUser.email}:`, enrolment.error);
          }
        } catch (enrolErr) {
          console.error(`Auto-enrol threw for ${newUser.email}:`, enrolErr.message);
        }

        // Create course enrollments if you have a separate model
        // if (validCourses.length > 0) {
        //   for (const courseId of validCourses) {
        //     await UserCourseEnrollment.create({
        //       user: newUser._id,
        //       course: courseId,
        //       institution: institutionId,
        //       enrolledBy: req.user.email || "system"
        //     });
        //   }
        // }

        const emailSubject = "Welcome to SmartLMS - Your Account Details";
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Welcome to SmartLMS Dashboard</h2>
            <p>You have been successfully added as a user to our system.</p>
            
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
              <h3 style="color: #495057;">Your Account Details:</h3>
              <p><strong>Name:</strong> ${firstName} ${lastName}</p>
              <p><strong>Email:</strong> ${email}</p>
              <p><strong>Role:</strong> ${role}</p>

              <p><strong>Password:</strong> ${password}</p>
            </div>
            
            <p><strong>Important:</strong> Please change your password after your first login for security purposes.</p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.BASE_URL || "http://localhost:3000"}/login" 
                 style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
                 Login to Your Account
              </a>
            </div>
            
            <p style="color: #6c757d; font-size: 14px;">
              If you have any questions, please contact your administrator.
            </p>
          </div>
        `;

        const emailResponse = await EmailService.sendEmail({
          fromEmail: process.env.NODEMAILER_FORM_EMAIL,
          receiverEmails: email,
          subject: emailSubject,
          body: emailBody,
          institutionId: institutionId,
          users: [{ 
            email: email, 
            firstName: firstName, 
            lastName: lastName, 
            role: role, 
            phone: phone || "" 
          }],
          sendType: "BULK_USER_CREATION",
        });

        if (emailResponse.success) {
          sentEmails.push({ email, firstName, lastName, role });
          console.log(`✅ Email sent successfully to: ${email}`);
        } else {
          notSentEmails.push({ email, firstName, lastName, role });
          console.log(`❌ Email failed for: ${email}`, emailResponse.error);
          if (emailResponse.creditExceeded) creditExceeded = true;
        }
      } catch (userError) {
        console.error("Error creating user:", userError);
        validationErrors.push({
          user: userData,
          error: userError.message || "Unknown processing error",
        });
        notSentEmails.push({ email, firstName, lastName, role });
      }
    }

    // Save bulk upload data
    let bulkSendMail = await BulkSendMail.findOne({ institution: institutionId });
    if (!bulkSendMail) {
      bulkSendMail = new BulkSendMail({
        institution: institutionId,
        emailBulkUploadCounts: [],
        overAllCount: {
          overAllEmailSuccessCount: 0,
          overAllEmailFailedCount: 0,
        },
      });
    }

    bulkSendMail.overAllCount.overAllEmailSuccessCount += sentEmails.length;
    bulkSendMail.overAllCount.overAllEmailFailedCount += notSentEmails.length;

    const uploadRecord = {
      totalEmail,
      notSendmail: notSentEmails,
      sendmail: sentEmails,
      fileName: uniqueFileName,
      sendBy: req.user.email || "system",
    };

  
    if (validCourses.length > 0) {
      uploadRecord.courses = validCourses;
      uploadRecord.courseCount = validCourses.length;
    }

    bulkSendMail.emailBulkUploadCounts.push(uploadRecord);

    // Update institution email details
    if (!institutionDoc.emailDetails) {
      institutionDoc.emailDetails = {
        recharged: 0,
        remaining: 0,
        used: { bulkUpload: 0, individual: 0 }
      };
    }
    if (!institutionDoc.emailDetails.used) {
      institutionDoc.emailDetails.used = { bulkUpload: 0, individual: 0 };
    }

    institutionDoc.emailDetails.used.bulkUpload += sentEmails.length;
    const totalUsed =
      (institutionDoc.emailDetails.used.bulkUpload || 0) +
      (institutionDoc.emailDetails.used.individual || 0);

    institutionDoc.emailDetails.remaining = Math.max(
      0,
      (institutionDoc.emailDetails.recharged || 0) - totalUsed
    );
    
    if (!institutionDoc.alerts) institutionDoc.alerts = {};
    institutionDoc.alerts.emailLowBalance = institutionDoc.emailDetails.remaining < 50;

    await bulkSendMail.save();
    await institutionDoc.save();

    // Create logs if functions exist
    if (typeof createAddUserBulkLog === 'function') {
      const logData = { courses: validCourses };
      await createAddUserBulkLog(req, users, "email", logData);
    }
    if (typeof createBulkUploadLog === 'function') {
      await createBulkUploadLog(req, {
        users,
        notificationMethod: "email",
        fileName: uniqueFileName,
        totalUsers: results.length,
        sentEmails: sentEmails.length,
        notSentEmails: notSentEmails.length,
        existingUsers: existingUsers.length,
        courses: validCourses.length > 0 ? validCourses : undefined,
      });
    }

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Prepare response message
    let successMessage = `Successfully registered ${users.length} users`;
  
    if (sentEmails.length > 0) {
      successMessage += ` and sent ${sentEmails.length} welcome emails`;
    }
    
    if (creditExceeded) {
      successMessage += ". Some emails failed due to insufficient credits.";
    } else {
      successMessage += ".";
    }

    // Send response
    const response = {
      message: [
        {
          key: "success",
          value: successMessage,
        },
      ],
      summary: {
        totalProcessed: results.length,
        successfullyCreated: users.length,
        emailsSent: sentEmails.length,
        emailsFailed: notSentEmails.length,
        existingUsers: existingUsers.length,
        validationErrors: validationErrors.length
      },
      users: users.map(user => {
        const userResponse = {
          _id: user._id,
          userId: user.userId,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role
        };

      

        // Add student/degree fields if exist
        if (user.studentType) userResponse.studentType = user.studentType;
        if (user.clientName) userResponse.clientName = user.clientName;
        if (user.degree) userResponse.degree = user.degree;
        if (user.department) userResponse.department = user.department;
        if (user.year) userResponse.year = user.year;
        if (user.semester) userResponse.semester = user.semester;
        if (user.rollNumber) userResponse.rollNumber = user.rollNumber;
        if (user.serviceModel) userResponse.serviceModel = user.serviceModel;

        // Reads the schema's real field — `enrolledCourses` never existed, so
        // this block always reported nothing.
        if (user.courses && user.courses.length > 0) {
          userResponse.courses = user.courses.map((c) => c.courseId);
        }

        return userResponse;
      }),
      creditExceeded,
    };

  
    if (validCourses.length > 0) {
      response.summary.courses = validCourses;
      response.summary.courseCount = validCourses.length;
    }

    res.status(201).json(response);

  } catch (error) {
    console.error("Error uploading users:", error);
    
    // Clean up file in case of error
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    res.status(500).json({
      message: [{ key: "error", value: "Internal server error" }],
    });
  }
};






exports.UpdateUserWithPermission = async (req, res) => {
  try {
    const { userId } = req.params;
    const { permissions } = req.body;

    // Existence check only — nothing else is read off the doc.
    const existingUser = await User.findById(userId).select("_id");
    if (!existingUser) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    // Validate permissions input
    if (!permissions || !Array.isArray(permissions)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Permissions array is required" }],
      });
    }

    // Validate and transform permissions structure
    const validPermissions = permissions.map((perm, index) => {
      // Check required fields
      if (!perm.permissionName || !perm.permissionKey) {
        throw new Error(`Permission at index ${index} must have permissionName and permissionKey`);
      }

      return {
        permissionName: perm.permissionName,
        permissionKey: perm.permissionKey,
        permissionFunctionality: Array.isArray(perm.permissionFunctionality) 
          ? perm.permissionFunctionality 
          : [],
        icon: perm.icon || "Shield", // Default icon if not provided
        color: perm.color || "blue", // Default color if not provided
        description: perm.description || "",
        isActive: perm.isActive !== undefined ? Boolean(perm.isActive) : true,
        order: typeof perm.order === 'number' ? perm.order : index
      };
    });

    // Check for duplicate permission keys
    const permissionKeys = validPermissions.map(p => p.permissionKey);
    const uniqueKeys = new Set(permissionKeys);
    if (uniqueKeys.size !== permissionKeys.length) {
      return res.status(400).json({
        message: [{ key: "error", value: "Duplicate permission keys found" }],
      });
    }

    // Update ONLY permissions field
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { 
        $set: { permissions: validPermissions },
        updatedAt: new Date()
      },
      {
        new: true,
        runValidators: true,
        select: 'firstName lastName email role permissions createdAt updatedAt'
      }
    )
    .populate("role", "originalRole renameRole roleValue");

    if (!updatedUser) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found during update" }],
      });
    }

    res.status(200).json({
      message: [{ key: "success", value: "User permissions updated successfully" }],
      data: {
        user: {
          _id: updatedUser._id,
          email: updatedUser.email,
          firstName: updatedUser.firstName,
          lastName: updatedUser.lastName,
          role: updatedUser.role,
        },
        permissions: updatedUser.permissions,
        updatedAt: updatedUser.updatedAt
      }
    });
  } catch (error) {
    console.error("Error updating user permissions:", error);

    if (error.name === "ValidationError") {
      const errors = Object.keys(error.errors).map((key) => ({
        key,
        value: error.errors[key].message,
      }));
      return res.status(400).json({ message: errors });
    }

    if (error.message.includes('Permission at index')) {
      return res.status(400).json({
        message: [{ key: "error", value: error.message }],
      });
    }

    res.status(500).json({
      message: [
        { key: "error", value: "Internal server error while updating permissions" },
      ],
    });
  }
};


exports.bulkUpdatePermissions = async (req, res) => {
  try {
    const { userPermissions } = req.body;

    // Validate input
    if (!userPermissions || !Array.isArray(userPermissions)) {
      return res.status(400).json({
        message: [{ key: "error", value: "userPermissions array is required" }],
      });
    }

    if (userPermissions.length === 0) {
      return res.status(400).json({
        message: [{ key: "error", value: "No user permissions provided" }],
      });
    }

    const results = [];
    const errors = [];
    let successCount = 0; // Changed from const to let

    // Process each user's permissions
    for (const item of userPermissions) {
      try {
        const { userId, permissions } = item;

        // Validate required fields
        if (!userId) {
          errors.push({ userId: 'unknown', error: "User ID is required" });
          continue;
        }

        if (!permissions || !Array.isArray(permissions)) {
          errors.push({ userId, error: "Permissions array is required" });
          continue;
        }

        // Existence check first (cheap indexed read) so the error precedence
        // matches the old read-then-save flow exactly.
        const exists = await User.exists({ _id: userId });
        if (!exists) {
          errors.push({ userId, error: "User not found" });
          continue;
        }

        // Validate and transform permissions
        const validPermissions = permissions.map((perm, index) => {
          // Basic validation
          if (!perm.permissionName || !perm.permissionKey) {
            throw new Error(`Permission at index ${index} must have permissionName and permissionKey`);
          }

          return {
            permissionName: perm.permissionName,
            permissionKey: perm.permissionKey,
            permissionFunctionality: Array.isArray(perm.permissionFunctionality)
              ? perm.permissionFunctionality
              : [],
            icon: perm.icon || "Shield",
            color: perm.color || "blue",
            description: perm.description || "",
            isActive: perm.isActive !== undefined ? Boolean(perm.isActive) : true,
            order: typeof perm.order === 'number' ? perm.order : index
          };
        });

        // Check for duplicate permission keys
        const permissionKeys = validPermissions.map(p => p.permissionKey);
        const uniqueKeys = new Set(permissionKeys);
        if (uniqueKeys.size !== permissionKeys.length) {
          errors.push({ userId, error: "Duplicate permission keys found" });
          continue;
        }

        // Targeted update — mirrors UpdateUserWithPermission above. The old
        // read-then-save pair materialized the FULL user doc (notifications,
        // course answer state, …) and rewrote all of it per user, running
        // every pre-save hook, just to set one array.
        const user = await User.findByIdAndUpdate(
          userId,
          {
            $set: { permissions: validPermissions },
            updatedAt: new Date()
          },
          {
            new: true,
            runValidators: true,
            select: "email firstName lastName role"
          }
        );
        if (!user) {
          errors.push({ userId, error: "User not found" });
          continue;
        }

        results.push({
          userId,
          success: true,
          user: {
            _id: user._id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role
          },
          permissionsCount: validPermissions.length
        });

        successCount++; // This line was causing the error

      } catch (error) {
        console.error(`Error processing user ${item.userId}:`, error);
        errors.push({
          userId: item.userId || 'unknown',
          error: error.message || "Internal server error"
        });
      }
    }

    // Prepare response
    const response = {
      message: [
        { 
          key: "success", 
          value: `Bulk update completed. Success: ${successCount}, Failed: ${errors.length}` 
        }
      ],
      data: {
        summary: {
          total: userPermissions.length,
          successful: successCount,
          failed: errors.length
        },
        results,
        errors: errors.length > 0 ? errors : undefined
      }
    };

    res.status(200).json(response);

  } catch (error) {
    console.error("Error in bulk permission update:", error);
    
    if (error.name === "ValidationError") {
      const errors = Object.keys(error.errors).map((key) => ({
        key,
        value: error.errors[key].message,
      }));
      return res.status(400).json({ message: errors });
    }

    res.status(500).json({
      message: [
        { key: "error", value: "Internal server error during bulk update" },
      ],
    });
  }
};



exports.GetUserPermission = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId)
      .populate("role", "originalRole renameRole roleValue")
      .select("firstName lastName email permissions role");

    if (!user) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    res.status(200).json({
      message: [{ key: "success", value: "User permission retrieved successfully" }],
      data: {
        user: {
          _id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
        },
        permissions: user.permissions || []
      },
    });
  } catch (error) {
    console.error("Error getting user permission:", error);
    res.status(500).json({
      message: [
        { key: "error", value: "Internal server error while getting user permission" },
      ],
    });
  }
};


exports.GetMyPermission = async (req, res) => {
  try {
    // Get user ID from authenticated request (from your auth middleware)
    const userId = req.user._id;

    if (!userId) {
      return res.status(401).json({
        message: [{ key: "error", value: "User not authenticated" }],
      });
    }

    // Get user with permission and role details
    const user = await User.findById(userId)
      .populate("role", "originalRole renameRole roleValue permissions")
      .populate("institution", "institutionName")
      .select("firstName lastName email permission role institution status createdAt");

    if (!user) {
      return res.status(404).json({
        message: [{ key: "error", value: "User not found" }],
      });
    }

    // Format permission data
    const permissionData = user.permission || {};
    
    // Combine role permissions and user permissions if needed
    const combinedPermissions = {
      userPermission: permissionData,
      rolePermission: user.role?.permissions || {},
      roleDetails: {
        originalRole: user.role?.originalRole,
        renameRole: user.role?.renameRole,
        roleValue: user.role?.roleValue,
      },
      institution: user.institution,
    };

    // Check if user has any permission access
    const hasPermissionAccess = permissionData.permissions || user.role?.permissions;

    res.status(200).json({
      message: [{ key: "success", value: "User permission retrieved successfully" }],
      data: {
        user: {
          _id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: `${user.firstName} ${user.lastName}`,
          status: user.status,
          createdAt: user.createdAt,
        },
        permissions: combinedPermissions,
        hasPermissionAccess: !!hasPermissionAccess,
        permissionSummary: {
          mainPermission: permissionData.permissions || "No main permission set",
          functionalities: permissionData.permissionFunctionality || [],
          subPermissionsCount: permissionData.subPermission?.length || 0,
          role: user.role?.originalRole || user.role?.renameRole || "No role assigned",
        },
      },
    });
  } catch (error) {
    console.error("Error getting user permission:", error);
    res.status(500).json({
      message: [
        { key: "error", value: "Internal server error while getting user permission" },
      ],
    });
  }
};




