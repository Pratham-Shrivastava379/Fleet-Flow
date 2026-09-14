import { prisma } from "../prisma.js";
import { HttpError } from "../middleware/errorHandler.js";
import * as audit from "./auditService.js";
import bcrypt from "bcryptjs";

/**
 * Phase 12: fleet-manager/admin user directory.
 *
 * Read APIs for any fleet role (drivers are visible to managers); mutations
 * are ADMIN-only and always audited. Role changes use the dedicated
 * USER_ROLE_CHANGED audit action with before/after detail (§7.2 item 4 +
 * §5.1's audited-role-change requirement); invite remains the only elevation
 * path for NEW accounts — this endpoint manages EXISTING accounts.
 */

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
};

async function isDeactivated(userId) {
  const flag = await prisma.userStatus.findUnique({ where: { userId } });
  return flag != null;
}

/** Paginated directory with optional filters (§7.2 item 4 + §7.3 audit-view). */
export async function listUsers({ q, role, status, includeDeactivated, page, pageSize }) {
  const where = {};
  if (q) where.OR = [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }];
  if (role) where.role = role;
  if (!includeDeactivated) {
    where.statusFlag = null;
  } else if (status === "DEACTIVATED") {
    where.statusFlag = { isNot: null };
  }
  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ]);
  // Effective status: the UserStatus flag row is the deactivation marker.
  const withStatus = await Promise.all(
    items.map(async (u) => ({
      ...u,
      status: (await isDeactivated(u.id)) ? "DEACTIVATED" : "ACTIVE",
    })),
  );
  return { items: withStatus, page, pageSize, total, pages: Math.ceil(total / pageSize) };
}

/** Get one user (§7.2 item 4: user admin detail / §11.5 audit trail view). */
export async function getUser(id) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: USER_SELECT,
  });
  if (!user) throw new HttpError(404, "User not found");
  return { ...user, status: (await isDeactivated(id)) ? "DEACTIVATED" : "ACTIVE" };
}

/** ADMIN-only direct driver provisioning for managed fleet accounts. Roles
 * above DRIVER continue to use the invitation flow so privilege elevation
 * always requires invite acceptance. The temporary password is hashed and is
 * never written to logs or audit detail. */
export async function createDriver(actor, { email, name, password }) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new HttpError(409, "Email already registered");

  const user = await prisma.user.create({
    data: {
      email,
      name,
      role: "DRIVER",
      passwordHash: await bcrypt.hash(password, 12),
    },
  });
  await audit.record({
    actorId: actor.id,
    action: "USER_CREATED",
    target: `user:${user.id}`,
    detail: `DRIVER ${email}`,
  });
  return { ...userSelectResult(user), status: "ACTIVE" };
}

function userSelectResult(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
  };
}

/**
 * ADMIN user admin (§7.2 item 4):
 *  - { name }        → rename (USER_UPDATED)
 *  - { role }        → role change (USER_ROLE_CHANGED, before/after in detail)
 *  - { deactivated } → activate/deactivate (USER_DEACTIVATED/REACTIVATED).
 *    Deactivating revokes ALL sessions (same contract as a password reset) and
 *    login refuses deactivated accounts (authService). The original role is
 *    preserved — reactivation restores exactly the same account.
 * At least one field must be present (zod refine upstream). The last ADMIN
 * can never be demoted or deactivated — otherwise every admin surface (§7)
 * would be permanently locked out (there is no recovery path without DB
 * surgery; bootstrap-admin.js refuses to run when an ADMIN exists).
 */
export async function updateUser(actor, id, { name, role, deactivated }) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new HttpError(404, "User not found");

  if (user.role === "ADMIN" && (role || deactivated === true) && role !== "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      throw new HttpError(409, "Cannot demote or deactivate the last admin");
    }
  }

  if (name !== undefined) {
    await prisma.user.update({ where: { id }, data: { name } });
    await audit.record({
      actorId: actor.id,
      action: "USER_UPDATED",
      target: `user:${id}`,
      detail: `renamed to "${name}"`,
    });
  }

  if (role !== undefined && role !== user.role) {
    await prisma.user.update({ where: { id }, data: { role } });
    await audit.record({
      actorId: actor.id,
      action: "USER_ROLE_CHANGED",
      target: `user:${id}`,
      detail: `${user.role} -> ${role}`,
    });
  }

  if (deactivated !== undefined) {
    if (deactivated) {
      await prisma.$transaction([
        prisma.userStatus.upsert({
          where: { userId: id },
          update: { deactivatedAt: new Date() },
          create: { userId: id, deactivatedAt: new Date() },
        }),
        // Deactivation kills every live session — otherwise the user stays
        // logged in until their 15m access token expires.
        prisma.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
      await audit.record({
        actorId: actor.id,
        action: "USER_DEACTIVATED",
        target: `user:${id}`,
      });
    } else {
      await prisma.userStatus.deleteMany({ where: { userId: id } });
      await audit.record({
        actorId: actor.id,
        action: "USER_REACTIVATED",
        target: `user:${id}`,
      });
    }
  }

  return getUser(id);
}
