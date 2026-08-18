// Seed (or upgrade) the platform-owner Super Admin account.
//
// This is separate from scripts/seedSuperAdmin.js, which seeds a per-institution
// "Super Admin" LMS-User (existing concept, logs into the regular LMS). This
// script seeds the new SuperAdmin-User collection — the platform owner who logs
// into /superadmin/login and has no institution.
//
// Run from the Server folder:
//   node scripts/seedSuperAdminUser.js <email> [password] [name]
//
// Password default for NEW accounts: SuperAdmin@123 (change after first login).

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const SuperAdminUser = require("../models/superadmin/SuperAdminUserModel");

const DEFAULT_PASSWORD = "SuperAdmin@123";

const parseArgs = () => {
  const [email, password, name] = process.argv.slice(2);
  return { email, password: password || DEFAULT_PASSWORD, name: name || "Platform Owner" };
};

const run = async () => {
  const { email, password, name } = parseArgs();

  if (!email || !email.includes("@")) {
    console.error("Usage: node scripts/seedSuperAdminUser.js <email> [password] [name]");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGOURI);
  console.log("MongoDB connected");

  try {
    let superAdmin = await SuperAdminUser.findOne({ email: email.toLowerCase() });

    if (superAdmin) {
      superAdmin.status = "active";
      await superAdmin.save();
      console.log(`Super Admin ${email} already exists — status set to active (password unchanged)`);
    } else {
      superAdmin = new SuperAdminUser({
        name,
        email,
        password,
        status: "active",
      });
      await superAdmin.save();
      console.log(`Created Super Admin ${email}`);
      console.log(`Password: ${password} — change it after first login`);
    }
  } finally {
    await mongoose.disconnect();
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
