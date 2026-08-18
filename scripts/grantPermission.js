// Grant one or more sidebar module permissions to an existing user.
//
// Pulls the permission definition from the catalog
// (utils/superAdminPermissions.js) and adds it to the user's permissions
// array. Idempotent — if the user already has the key, the entry is
// re-activated/refreshed instead of duplicated.
//
// "servicemapping" is inserted directly below the user's Client Management
// entry (shifting later orders), so it lands in the right sidebar spot.
//
// Run from the Server folder:
//   node scripts/grantPermission.js <email> <permissionKey> [permissionKey ...]
//   e.g. node scripts/grantPermission.js batch@gmail.com servicemapping

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const User = require("../models/UserModel");
const { SUPER_ADMIN_PERMISSIONS } = require("../utils/superAdminPermissions");

const main = async () => {
  const [email, ...keys] = process.argv.slice(2);
  if (!email || keys.length === 0) {
    console.error("Usage: node scripts/grantPermission.js <email> <permissionKey> [permissionKey ...]");
    console.error(`Known keys: ${SUPER_ADMIN_PERMISSIONS.map((p) => p.permissionKey).join(", ")}`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGOURI);
  console.log("MongoDB connected");

  const user = await User.findOne({ email: new RegExp(`^${email}$`, "i") });
  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }

  for (const key of keys) {
    const catalogEntry = SUPER_ADMIN_PERMISSIONS.find(
      (p) => p.permissionKey.toLowerCase() === key.toLowerCase()
    );
    if (!catalogEntry) {
      console.error(`✗ "${key}" is not in the permission catalog — skipped`);
      continue;
    }

    const existing = user.permissions.find(
      (p) => p.permissionKey.toLowerCase() === catalogEntry.permissionKey.toLowerCase()
    );
    if (existing) {
      existing.isActive = true;
      existing.permissionName = catalogEntry.permissionName;
      existing.permissionFunctionality = [...catalogEntry.permissionFunctionality];
      existing.icon = catalogEntry.icon;
      existing.color = catalogEntry.color;
      console.log(`• ${email} already had "${catalogEntry.permissionKey}" — refreshed & re-activated`);
      continue;
    }

    // Decide where the new module sits in this user's sidebar order.
    // servicemapping goes directly below the user's clientmanagement entry;
    // anything else is appended at the end.
    const orders = user.permissions.map((p) => p.order || 0);
    let newOrder = orders.length ? Math.max(...orders) + 1 : catalogEntry.order;

    if (catalogEntry.permissionKey === "servicemapping") {
      const clientPerm = user.permissions.find((p) => p.permissionKey === "clientmanagement");
      if (clientPerm) {
        newOrder = (clientPerm.order || 0) + 1;
        user.permissions.forEach((p) => {
          if (p !== clientPerm && (p.order || 0) >= newOrder) p.order = (p.order || 0) + 1;
        });
      }
    }

    user.permissions.push({
      ...catalogEntry,
      permissionFunctionality: [...catalogEntry.permissionFunctionality],
      order: newOrder,
    });
    console.log(`✓ Granted "${catalogEntry.permissionKey}" to ${email} (order ${newOrder})`);
  }

  await user.save();

  console.log(`\nSidebar for ${email} is now:`);
  [...user.permissions]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .forEach((p) =>
      console.log(
        `  ${String(p.order).padStart(2)}  ${p.isActive ? "●" : "○"} ${p.permissionName}  → /lms/pages/${p.permissionKey.toLowerCase()}`
      )
    );

  await mongoose.disconnect();
  console.log("\nDone. The user must log out and back in (the sidebar reads permissions at login).");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
