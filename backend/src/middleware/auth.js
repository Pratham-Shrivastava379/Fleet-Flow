import jwt from "jsonwebtoken";
import config from "../config.js";
import { prisma } from "../prisma.js";
// Phase 13 (§11.1): stamp the authenticated userId into the request's log
// context so every downstream log line for this request carries it.
import { setRequestUserId } from "../lib/logger.js";

export function signAccessToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role, name: user.name }, config.jwtAccessSecret, {
    expiresIn: config.accessTtl,
  });
}

/** requireAuth: verifies Bearer JWT and attaches req.user = { id, role, name }. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  try {
    const payload = jwt.verify(token, config.jwtAccessSecret);
    req.user = { id: Number(payload.sub), role: payload.role, name: payload.name };
    setRequestUserId(req.user.id);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired access token" });
  }
}

/**
 * requireRole: gate an endpoint by role. When the request was authenticated
 * through requireAuthDb, the FRESH DB role (req.userDb.role) decides — the JWT
 * role claim can be stale for up to 15m after a demotion. Without a loaded row
 * (bare requireAuth chains), the JWT claim is the only available signal.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    const effectiveRole = req.userDb?.role ?? req.user?.role;
    if (!req.user || !roles.includes(effectiveRole)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    next();
  };
}

/** Also loads the user row — used for endpoints needing fresh DB state. */
export async function requireAuthDb(req, res, next) {
  requireAuth(req, res, async () => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        // include(rather than findUnique-only): Prisma does NOT return relation
        // objects by default, so a bare findUnique would omit `statusFlag` and
        // the deactivation check below would never fire.
        include: { statusFlag: true },
      });
      if (!user) return res.status(401).json({ error: "User no longer exists" });
      // §2 (RBAC/current account state): a mid-access-token-lifetime
      // deactivation must end privileged actions immediately — the JWT stays
      // valid for up to 15m, but the DB row now carries a UserStatus flag.
      // We return 401 (not 403) to match the login refusal semantics for a
      // deactivated account.
      if (user.statusFlag) return res.status(401).json({ error: "Account is deactivated" });
      req.userDb = user;
      next();
    } catch {
      // Fail CLOSED: when the account store is unreachable we must not trust
      // the (unverifiable) JWT role/state. The async callback of `requireAuth`
      // is not awaited by Express, so route the failure to an explicit 503
      // instead of letting it crash the process or accidentally authorizing.
      res.status(503).json({ error: "Authentication service unavailable" });
    }
  });
}
