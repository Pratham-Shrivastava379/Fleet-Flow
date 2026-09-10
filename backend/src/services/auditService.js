import { prisma } from "../prisma.js";
import { getContextLogger } from "../lib/logger.js";

/**
 * Append-only audit trail writer (blueprint §5, Phase 2).
 * Fire-and-forget safe: audit failures must never break the main flow, but
 * they are logged loudly. Query API for admins: Phase 12 dashboard viewer
 * (§7.3) with action/actor/free-text filters.
 */
export async function record({ actorId = null, action, target = "", detail = "" }) {
  try {
    await prisma.auditLog.create({ data: { actorId, action, target, detail } });
  } catch (err) {
    getContextLogger({ module: "audit" }).error({ action, target, err: err?.message }, "FAILED to record audit entry");
  }
}

export function listAuditLogs({ page = 1, pageSize = 50, action, actorId, q } = {}) {
  const where = {};
  if (action) where.action = action;
  if (actorId) where.actorId = actorId;
  if (q) {
    where.OR = [{ target: { contains: q, mode: "insensitive" } }, { detail: { contains: q, mode: "insensitive" } }];
  }
  return prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { actor: { select: { id: true, email: true, role: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);
}
