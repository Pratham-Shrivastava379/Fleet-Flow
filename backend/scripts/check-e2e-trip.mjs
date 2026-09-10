// Inspect the live device-E2E trip row (read-only).
// Usage: node scripts/check-e2e-trip.mjs [tripId]
import { PrismaClient } from "@prisma/client";

const tripId = Number(process.argv[2] ?? 716);
const prisma = new PrismaClient();

const trip = await prisma.trip.findUnique({
  where: { id: tripId },
  include: { _count: { select: { pings: true } } },
});
if (!trip) {
  console.log(`trip ${tripId} not found`);
} else {
  console.log(
    JSON.stringify({
      id: trip.id,
      status: trip.status,
      pings: trip._count.pings,
      driverId: trip.driverId,
      vehicleId: trip.vehicleId,
      startedAt: trip.startedAt,
      endedAt: trip.endedAt,
    }),
  );
}
await prisma.$disconnect();
