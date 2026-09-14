/**
 * One-time bootstrap: create the first ADMIN account.
 * Registration is always DRIVER now — the only way to get the first admin is
 * this script, run against the DB directly:
 *
 *   node scripts/bootstrap-admin.js admin@example.com "Admin Name" StrongPass1
 *
 * Refuses to run if any ADMIN already exists (use the invite flow instead).
 */
import bcrypt from "bcryptjs";
import { prisma } from "../src/prisma.js";

const [email, name, password] = process.argv.slice(2);

if (!email || !name || !password || password.length < 8) {
  console.error("Usage: node scripts/bootstrap-admin.js <email> <name> <password>=8+chars");
  process.exit(1);
}

const existingAdmin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
if (existingAdmin) {
  console.error(`Refusing: an ADMIN already exists (${existingAdmin.email}). Use POST /api/auth/invite instead.`);
  process.exit(1);
}

const clash = await prisma.user.findUnique({ where: { email } });
if (clash) {
  console.error(`Refusing: user with email ${email} already exists.`);
  process.exit(1);
}

const user = await prisma.user.create({
  data: { email, name, role: "ADMIN", passwordHash: await bcrypt.hash(password, 12) },
});
console.log(`Bootstrap ADMIN created: id=${user.id} email=${user.email} role=${user.role}`);
await prisma.$disconnect();
