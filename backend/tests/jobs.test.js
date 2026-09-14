/**
 * Phase 4 — background job infrastructure tests.
 *
 * 1. partition-maintenance creates next month's `location_pings` partition.
 * 2. retention clears expired/used credentials and invites.
 */
import { describe, it, before } from "node:test";
import bcrypt from "bcryptjs";
import { expect } from "./expectShim.js";
import { prisma } from "../src/prisma.js";
import { ensureLocationPingPartitions, monthLabel } from "../src/jobs/partitionMaintenance.js";
import retentionJob from "../src/jobs/retention.js";

const PASS = "Passw0rd!";

async function relExists(name) {
  const rows = await prisma.$queryRawUnsafe("SELECT 1 FROM pg_class WHERE relname = $1", name);
  return rows.length > 0;
}

before(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.deviceToken.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.locationPing.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.geofence.deleteMany();
  await prisma.user.deleteMany();
});

describe("partition-maintenance job (Phase 4)", () => {
  it("creates next month's location_pings partition when run", async () => {
    const nextMonth = `LocationPing_${monthLabel(1)}`;
    // Prove the JOB (not the migration) created it: ensure it's currently absent.
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${nextMonth}"`);
    expect(await relExists(nextMonth)).toBe(false);

    await ensureLocationPingPartitions(4);

    expect(await relExists(nextMonth)).toBe(true);
    // current month must also exist (migration seeded it)
    expect(await relExists(`LocationPing_${monthLabel(0)}`)).toBe(true);

    // rerun is idempotent — no error, no duplicate partition
    const again = await ensureLocationPingPartitions(4);
    expect(Array.isArray(again.created)).toBe(true);
  });
});

describe("retention job (Phase 4)", () => {
  it("removes expired tokens and unused invites", async () => {
    const user = await prisma.user.create({
      data: {
        email: "retention@fleetflow.test",
        name: "Retention User",
        role: "DRIVER",
        passwordHash: await bcrypt.hash(PASS, 4),
      },
    });
    const past = new Date(Date.now() - 1000);

    await prisma.refreshToken.create({
      data: { tokenHash: `rt-${Math.random()}`, userId: user.id, familyId: "f", expiresAt: past },
    });
    await prisma.passwordResetToken.create({
      data: { tokenHash: `prt-${Math.random()}`, userId: user.id, expiresAt: past },
    });
    await prisma.invite.create({
      data: {
        email: "invited@fleetflow.test",
        role: "FLEET_MANAGER",
        tokenHash: `inv-${Math.random()}`,
        invitedBy: user.id,
        expiresAt: past,
      },
    });

    const result = await retentionJob();

    expect(result.expiredRefreshTokens).toBe(1);
    expect(result.expiredResetTokens).toBe(1);
    expect(result.expiredOrUsedInvitesRemoved).toBe(1);

    expect(await prisma.refreshToken.count()).toBe(0);
    expect(await prisma.passwordResetToken.count()).toBe(0);
    expect(await prisma.invite.count()).toBe(0);
  });
});
