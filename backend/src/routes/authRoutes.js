import { Router } from "express";
import * as authService from "../services/authService.js";
import {
  validate,
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  inviteSchema,
  acceptInviteSchema,
} from "../middleware/validate.js";
import { requireAuthDb, requireRole } from "../middleware/auth.js";
import { HttpError } from "../middleware/errorHandler.js";
import config from "../config.js";

const router = Router();

/** True when the caller is a browser SPA — switch refresh-token
 *  delivery from JSON body to an HttpOnly cookie. Identified by X-Client: web. */
function isWebClient(req) {
  return String(req.headers["x-client"] || "").toLowerCase() === "web";
}

const webCookieOpts = {
  httpOnly: true,
  secure: config.webRefreshCookieSecure,
  sameSite: "strict",
  path: "/",
  // 15m access + this refresh TTL; rolling refresh keeps the cookie alive.
  maxAge: config.refreshTtlDays * 24 * 60 * 60 * 1000,
};

router.post("/register", validate(registerSchema), async (req, res, next) => {
  try {
    const result = await authService.register(req.body);
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

router.post("/login", validate(loginSchema), async (req, res, next) => {
  try {
    const result = await authService.login(req.body);
    if (isWebClient(req)) {
      // Web: refresh token goes ONLY into an HttpOnly cookie; access token in
      // the body for the SPA to hold in memory (never localStorage, §5.4).
      res.cookie(config.webRefreshCookieName, result.refreshToken, webCookieOpts);
      res.json({ user: result.user, accessToken: result.accessToken });
    } else {
      res.json(result); // mobile/tooling keep the current body contract
    }
  } catch (e) {
    next(e);
  }
});

router.post("/refresh", validate(refreshSchema), async (req, res, next) => {
  try {
    // Web reads the refresh token from the HttpOnly cookie; mobile from the body.
    const rawToken = isWebClient(req) ? req.cookies && req.cookies[config.webRefreshCookieName] : req.body.refreshToken;
    if (!rawToken) throw new HttpError(401, "Missing refresh token");
    const result = await authService.refresh(rawToken);
    if (isWebClient(req)) {
      res.cookie(config.webRefreshCookieName, result.refreshToken, webCookieOpts);
      res.json({ user: result.user, accessToken: result.accessToken });
    } else {
      res.json(result);
    }
  } catch (e) {
    next(e);
  }
});

router.post("/logout", validate(refreshSchema), async (req, res, next) => {
  try {
    const rawToken = isWebClient(req) ? req.cookies && req.cookies[config.webRefreshCookieName] : req.body.refreshToken;
    if (rawToken) await authService.logout(rawToken);
    if (isWebClient(req)) {
      res.clearCookie(config.webRefreshCookieName, { ...webCookieOpts, maxAge: undefined });
      res.status(204).end();
    } else {
      res.status(204).end();
    }
  } catch (e) {
    next(e);
  }
});

router.get("/me", requireAuthDb, (req, res) => {
  const { id, email, name, role } = req.userDb;
  res.json({ user: { id, email, name, role } });
});

router.post("/forgot-password", validate(forgotPasswordSchema), async (req, res, next) => {
  try {
    res.status(202).json(await authService.forgotPassword(req.body.email));
  } catch (e) {
    next(e);
  }
});

router.post("/reset-password", validate(resetPasswordSchema), async (req, res, next) => {
  try {
    res.json(await authService.resetPassword(req.body));
  } catch (e) {
    next(e);
  }
});

router.post("/invite", requireAuthDb, requireRole("ADMIN"), validate(inviteSchema), async (req, res, next) => {
  try {
    // §5 invite-delivery seam: production NEVER returns the raw invite token —
    // delivery goes through the configured provider (or fails safe, 503).
    // Non-production may include it only as an explicit opt-in for local CLI
    // relay workflows (body flag, default off).
    const includeInviteToken = req.body?.includeInviteToken === true;
    res.status(201).json(await authService.invite({ ...req.body, invitedBy: req.user.id, includeInviteToken }));
  } catch (e) {
    next(e);
  }
});

router.post("/accept-invite", validate(acceptInviteSchema), async (req, res, next) => {
  try {
    res.status(201).json(await authService.acceptInvite(req.body));
  } catch (e) {
    next(e);
  }
});

export default router;
