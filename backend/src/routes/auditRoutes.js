import { Router } from "express";
import { listAuditLogs } from "../services/auditService.js";
import { validate, auditQuerySchema } from "../middleware/validate.js";
import { requireAuthDb, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(requireAuthDb);

/** Audit log query API — ADMIN-only.
 *  Phase 12 (§7.3): adds action/actor/free-text filters for the dashboard's
 *  audit viewer. */
router.get("/", requireRole("ADMIN"), validate(auditQuerySchema), async (req, res, next) => {
  try {
    const { action, actorId, q, page, pageSize } = req.query;
    const [items, total] = await listAuditLogs({ action, actorId, q, page, pageSize });
    res.json({ items, page: Number(page) || 1, pageSize: Number(pageSize) || 50, total });
  } catch (e) {
    next(e);
  }
});

export default router;
