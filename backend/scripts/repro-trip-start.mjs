// One-off repro: call startTrip directly and print the raw error.
process.env.DATABASE_URL ||= "postgresql://fleetflow:fleetflow@localhost:5432/fleetflow?schema=public";
import { prisma } from "../src/prisma.js";
import { startTrip } from "../src/services/tripService.js";

const email = `repro-${Date.now()}@fleetflow.test`;
const plate = `REPRO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
try {
  const user = await prisma.user.create({ data: { email, name: "Repro", role: "DRIVER", passwordHash: "x" } });
  const vehicle = await prisma.vehicle.create({ data: { plate, model: "Repro Van" } });
  const trip = await startTrip(user.id, vehicle.id);
  console.log("START OK, trip id:", trip.id);
  await prisma.trip.delete({ where: { id: trip.id } });
  await prisma.vehicle.delete({ where: { id: vehicle.id } });
  await prisma.user.delete({ where: { id: user.id } });
} catch (e) {
  console.error("START FAILED:", e?.constructor?.name, e?.code, e?.message);
  console.error(e?.stack);
} finally {
  await prisma.$disconnect();
}
