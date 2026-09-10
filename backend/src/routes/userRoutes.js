import { Router } from "express";
import { prisma } from "../prisma.js";
import { validate, notificationPrefsSchema, deviceTokenSchema } from "../middleware/validate.js";
import { requireAuthDb } from "../middleware/auth.js";

const router = Router();
router.use(requireAuthDb);

/**
 * GET /api/users/me/notification-prefs — current effective preferences.
 * Absent entries mean "enabled" (the default); returned explicitly anyway.
 */
router.get("/me/notification-prefs", async (req, res, next) => {
  try {
    const prefs = await prisma.notificationPreference.findMany({
      where: { userId: req.user.id },
      select: { type: true, enabled: true },
    });
    res.json({ prefs });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/users/me/notification-prefs (Phase 7, blueprint §713)
router.patch("/me/notification-prefs", validate(notificationPrefsSchema), async (req, res, next) => {
  try {
    const results = [];
    for (const { type, enabled } of req.body.prefs) {
      const pref = await prisma.notificationPreference.upsert({
        where: { userId_type: { userId: req.user.id, type } },
        update: { enabled },
        create: { userId: req.user.id, type, enabled },
      });
      results.push({ type: pref.type, enabled: pref.enabled });
    }
    res.json({ prefs: results });
  } catch (e) {
    next(e);
  }
});

// POST /api/users/me/device-tokens — FCM registration-token upload (§715).
// Idempotent: re-registering the same token refreshes it (unique on token).
router.post("/me/device-tokens", validate(deviceTokenSchema), async (req, res, next) => {
  try {
    const { token, platform } = req.body;
    const deviceToken = await prisma.deviceToken.upsert({
      where: { token },
      update: { userId: req.user.id, platform, lastUsedAt: new Date() },
      create: { userId: req.user.id, token, platform },
    });
    res.status(201).json({ id: deviceToken.id, platform: deviceToken.platform });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/users/me/device-tokens/:token — unregister a device (logout).
router.delete("/me/device-tokens/:token", async (req, res, next) => {
  try {
    await prisma.deviceToken.deleteMany({
      where: { token: req.params.token, userId: req.user.id },
    });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
