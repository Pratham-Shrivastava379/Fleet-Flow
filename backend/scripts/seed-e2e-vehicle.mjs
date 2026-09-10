// Seed the E2E driver + a dedicated E2E vehicle for the on-device run.
// Idempotent: re-running is a no-op for the vehicle and guarantees the driver
// exists with EXACTLY the documented credentials below (the password hash is
// always reset so the driver can never drift out of sync with e2e-reg.json /
// the handoff notes).
//
// Usage: node scripts/seed-e2e-vehicle.mjs [plate] [model]
//
// E2E device credentials (must match the driver seeded below; kept in sync with
// e2e-reg.json — see also the Session handoff notes):
//   email:    e2e.device@fleetflow.test
//   password: Driverpass      <- letters-only ON PURPOSE: `adb shell input text`
//   name:     E2E Driver         cannot reliably type digits-inside-words on the
//                                ColorOS IME (autocorrect rewrites e.g. "Passw0rd"
//                                -> "Password", the source of repeated on-device
//                                401s). Real-user passwords follow the normal
//                                policy; this is a device-automation fixture.
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const plate = process.argv[2] ?? "E2E-DEV-1";
const model = process.argv[3] ?? "Ashok Leyland Dost+";
const E2E_EMAIL = "e2e.device@fleetflow.test";
const E2E_PASSWORD = "Driverpass";
const E2E_NAME = "Vikram Singh";
const prisma = new PrismaClient();

// 1) Driver account — a root cause of the first on-device 401 was that the
//    account was never seeded at all (the old script only made a vehicle). Always
//    reset the hash so the fixture and the DB can never disagree.
await prisma.user.upsert({
  where: { email: E2E_EMAIL },
  update: { name: E2E_NAME, role: "DRIVER", passwordHash: await bcrypt.hash(E2E_PASSWORD, 12) },
  create: { email: E2E_EMAIL, name: E2E_NAME, role: "DRIVER", passwordHash: await bcrypt.hash(E2E_PASSWORD, 12) },
});
const user = await prisma.user.findUnique({ where: { email: E2E_EMAIL } });
console.log(`driver ready id=${user.id} email=${user.email} (${E2E_PASSWORD})`);

// 2) Vehicle. Fresh only; re-runs leave it untouched.
const existingVehicle = await prisma.vehicle.findFirst({ where: { plate } });
const vehicle = existingVehicle
  ? await prisma.vehicle.update({ where: { id: existingVehicle.id }, data: { model } })
  : await prisma.vehicle.create({ data: { plate, model } });
console.log(
  existingVehicle
    ? `vehicle present id=${vehicle.id} plate=${vehicle.plate}`
    : `vehicle created id=${vehicle.id} plate=${vehicle.plate}`,
);

await prisma.$disconnect();
