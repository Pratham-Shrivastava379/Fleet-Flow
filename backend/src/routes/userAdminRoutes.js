import { Router } from "express";
import { z } from "zod";
import { requireAuthDb, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import * as users from "../services/userService.js";
import * as audit from "../services/auditService.js";

/**
 * Phase 12 (blueprint §7.2 item 4): fleet user directory (ADMIN screens).
 * `GET /users` (any fleet role) reads; mutations are ADMIN-only and audited.
 * Self-service profile endpoints live in userRoutes.js — these are the
 * *administration* endpoints and deliberately don't overlap.
 */

const listSchema = {
  query: z
    .object({
      q: z.string().trim().min(1).max(120).optional(),
      role: z.enum(["DRIVER", "FLEET_MANAGER", "ADMIN"]).optional(),
      status: z.enum(["ACTIVE", "DEACTIVATED"]).optional(),
      includeDeactivated: z.coerce.boolean().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    })
    // `validate()` runs safeParse against req.query which is ALWAYS an object,
    // but the outer wrapper still needs a default so empty objects stay valid
    // (GET /api/users-admin with no query string must list page 1).
    .default({}),
};

const idParam = z.object({
  id: z.coerce.number().int().positive(),
});

const router = Router();

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.enum(["DRIVER", "FLEET_MANAGER", "ADMIN"]).optional(),
    deactivated: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.role !== undefined || b.deactivated !== undefined, {
    message: "At least one of name, role, deactivated is required",
  });

const updateParams = {
  params: idParam,
  body: updateSchema,
};

const createDriverSchema = {
  body: z.object({
    email: z.string().trim().email().max(254),
    name: z.string().trim().min(1).max(120),
    password: z.string().min(8).max(72),
  }),
};

router.post("/", requireAuthDb, requireRole("ADMIN"), validate(createDriverSchema), async (req, res, next) => {
  try {
    res.status(201).json(await users.createDriver(req.user, req.validated.body));
  } catch (err) {
    next(err);
  }
});

router.get("/", requireAuthDb, requireRole("ADMIN", "FLEET_MANAGER"), validate(listSchema), async (req, res, next) => {
  try {
    res.json(await users.listUsers(req.validated.query ?? {}));
  } catch (err) {
    next(err);
  }
});

router.get(
  "/:id",
  requireAuthDb,
  requireRole("ADMIN", "FLEET_MANAGER"),
  validate({ params: idParam }),
  async (req, res, next) => {
    try {
      res.json(await users.getUser(req.validated.params.id));
    } catch (err) {
      next(err);
    }
  },
);

router.patch("/:id", requireAuthDb, requireRole("ADMIN"), validate(updateParams), async (req, res, next) => {
  try {
    res.json(await users.updateUser(req.user, req.validated.params.id, req.validated.body));
  } catch (err) {
    next(err);
  }
});

/** ADMIN: audit entries for one user (§7.2 item 4 — "with a link to their
 *  audit trail"; reuses listAuditLogs with an actor filter). */
router.get("/:id/audit", requireAuthDb, requireRole("ADMIN"), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { id } = req.validated.params;
    const { page, pageSize } = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(req.query ?? {});
    const [items, total] = await audit.listAuditLogs({ actorId: id, page, pageSize });
    res.json({ items, page, pageSize, total });
  } catch (err) {
    next(err);
  }
});

export default router;
