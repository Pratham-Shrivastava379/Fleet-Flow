import { prisma } from "../prisma.js";
import { HttpError } from "../middleware/errorHandler.js";

/** Active (non-soft-deleted) vehicles for the default listing. Phase 12
 *  (§7.2 item 4): include the assigned default driver for the Vehicles grid. */
export async function listVehicles() {
  return prisma.vehicle.findMany({
    where: { deletedAt: null },
    orderBy: { id: "asc" },
    include: { defaultDriver: { select: { id: true, name: true } } },
  });
}

export async function createVehicle(data) {
  return prisma.vehicle.create({ data });
}

/**
 * Driver-scoped vehicle list (§2 RBAC, "view only vehicles available/assigned
 * for the driver workflow"): a DRIVER sees
 *   - vehicles with no ACTIVE trip (startable now), plus
 *   - the vehicle assigned to them as defaultDriver (visible even while
 *     IN_MAINTENANCE so the assignment is never a mystery),
 * and never sees soft-deleted or RETIRED vehicles. Managers/admins keep the
 * full fleet list. This is a UX-scoping query, NOT the security boundary —
 * every mutation stays role-guarded at the route layer.
 */
export async function listVehiclesForDriver(driverId) {
  const activeTripVehicleIds = await prisma.trip.findMany({
    where: { status: "ACTIVE" },
    select: { vehicleId: true },
  });
  const busy = new Set(activeTripVehicleIds.map((t) => t.vehicleId));
  const vehicles = await prisma.vehicle.findMany({
    where: { deletedAt: null, status: { not: "RETIRED" } },
    orderBy: { id: "asc" },
    include: { defaultDriver: { select: { id: true, name: true } } },
  });
  return vehicles.filter((v) => !busy.has(v.id) || v.defaultDriverId === driverId);
}

export async function updateVehicle(id, data) {
  const existing = await prisma.vehicle.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "Vehicle not found");
  if (existing.deletedAt) throw new HttpError(409, "Vehicle is deleted");
  // Phase 12 (§7.2 item 4): defaultDriverId must reference a real, active
  // (non-deactivated) user — a dangling or deactivated assignment would show
  // a broken row in the Vehicles grid.
  if (data.defaultDriverId !== undefined && data.defaultDriverId !== null) {
    const driver = await prisma.user.findUnique({
      where: { id: data.defaultDriverId },
      include: { statusFlag: true },
    });
    if (!driver || driver.statusFlag) {
      throw new HttpError(422, "defaultDriverId must reference an active user");
    }
  }
  return prisma.vehicle.update({
    where: { id },
    data,
    include: { defaultDriver: { select: { id: true, name: true } } },
  });
}

/** Soft-delete: set deletedAt so it drops out of the default listing but
 *  historical trips referencing it still resolve. Hard-delete only happens via
 *  DB retention, if ever — never here. */
export async function deleteVehicle(id) {
  const existing = await prisma.vehicle.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, "Vehicle not found");
  if (existing.deletedAt) throw new HttpError(404, "Vehicle already deleted");
  return prisma.vehicle.update({ where: { id }, data: { deletedAt: new Date() } });
}
