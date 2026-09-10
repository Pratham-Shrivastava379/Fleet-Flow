import { prisma } from "../src/prisma.js";

const events = await prisma.geofenceEvent.findMany({ orderBy: { id: "asc" } });
console.log(
  "GeofenceEvents:",
  JSON.stringify(events.map((e) => ({ id: e.id, type: e.eventType, gf: e.geofenceId, veh: e.vehicleId }))),
);
const alerts = await prisma.alert.findMany({ where: { type: { in: ["GEOFENCE_ENTER", "GEOFENCE_EXIT"] } } });
console.log("Geofence Alerts:", JSON.stringify(alerts.map((a) => ({ id: a.id, type: a.type, trip: a.tripId }))));
const flp = await prisma.fleetLastPosition.findMany();
console.log("FleetLastPosition:", JSON.stringify(flp));
await prisma.$disconnect();
