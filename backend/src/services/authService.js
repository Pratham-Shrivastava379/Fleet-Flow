import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import config from "../config.js";
import { prisma } from "../prisma.js";
import { HttpError } from "../middleware/errorHandler.js";
import * as audit from "./auditService.js";
import { getContextLogger } from "../lib/logger.js";

// Phase 13 (§11.1): module-scoped logger for auth flows.
const log = getContextLogger({ module: "auth" });

/**
 * Dev-only token delivery seam. The email provider is deferred (Phase 7+), so
 * reset/invite tokens are delivered via the structured log line — and, when a
 * sink is installed (tests/scripts), pushed out-of-band as well. Mirrors the
 * fcm.js setFcmSender seam. Production delivery replaces this seam with the
 * email provider call when it lands.
 */
let devTokenSink = null;
export function setDevTokenSink(fn) {
  devTokenSink = fn;
}

/**
 * §5 token-delivery policy (pure, unit-testable). Reset/invite tokens are
 * account-recovery SECRETS: they must never reach logs, traces or error
 * reports in production — production requires a real delivery provider
 * (Phase 7+) and fails safe with an explicit warning until one is configured.
 * In development the log/sink channel stays available ONLY behind the explicit
 * DEV_TOKEN_DELIVERY=true switch (documented in .env.example / tests/test.env).
 */
export function tokenDeliveryPolicy(nodeEnv, devDeliveryEnabled) {
  if (nodeEnv === "production") {
    return { logToken: false, callSink: false };
  }
  return { logToken: devDeliveryEnabled === true, callSink: devDeliveryEnabled === true };
}

/**
 * §5 explicit delivery-provider seam. The backend never fabricates email
 * delivery; production invitations REQUIRE a provider registered here (wired
 * in src/server.js or a composition root when a real provider lands, Phase 7+).
 * No default provider is configured, so production invitations fail safe with
 * a clear configuration error instead of pretending delivery succeeded.
 */
let inviteDeliveryProvider = null;
export function setInviteDeliveryProvider(provider) {
  inviteDeliveryProvider = provider;
}
export function getInviteDeliveryProvider() {
  return inviteDeliveryProvider;
}

function deliverDevToken({ kind, email, role = null, token }) {
  const policy = tokenDeliveryPolicy(config.nodeEnv, config.devTokenDelivery);
  const fields = { kind, email, ...(role ? { role } : {}) };
  if (!policy.logToken) {
    // Fail SAFE, and say exactly what did (not) happen: the token was neither
    // logged, e-mailed nor sink-delivered. An operator seeing this knows to
    // configure a real provider (Phase 7+). We never silently pretend
    // delivery succeeded.
    log.warn(
      fields,
      `${kind}: token delivery is NOT configured for ${config.nodeEnv} — the token was NOT logged, e-mailed or delivered. ` +
        "Configure an email provider (Phase 7+); the development log channel cannot run in production.",
    );
    return;
  }
  log.info(fields, `${kind} token for ${email}${role ? ` (${role})` : ""}: ${token}`);
  if (devTokenSink) devTokenSink({ kind, email, role, token });
}

const BCRYPT_ROUNDS = 12;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour, single-use
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, single-use

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function signAccessToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role, name: user.name }, config.jwtAccessSecret, {
    expiresIn: config.accessTtl,
  });
}

async function issueRefreshToken(userId, familyId = crypto.randomUUID()) {
  const token = crypto.randomBytes(48).toString("hex");
  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      familyId,
      expiresAt: new Date(Date.now() + config.refreshTtlDays * 24 * 60 * 60 * 1000),
    },
  });
  return token;
}

/**
 * Registration ALWAYS creates a DRIVER. No client-suppliable
 * role, no exceptions — elevation happens exclusively via admin invite.
 */
export async function register({ email, password, name }) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new HttpError(409, "Email already registered");
  const user = await prisma.user.create({
    data: { email, name, role: "DRIVER", passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) },
  });
  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id);
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, accessToken, refreshToken };
}

export async function login({ email, password }) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { statusFlag: true },
  });
  if (!user || (await bcrypt.compare(password, user.passwordHash)) === false) {
    throw new HttpError(401, "Invalid email or password");
  }
  // Phase 12 (§5.1 activation semantics / §7.2 item 4): a deactivated account
  // cannot authenticate at all — indistinguishable from bad credentials so
  // the endpoint doesn't leak account existence/status to an attacker.
  if (user.statusFlag) {
    throw new HttpError(401, "Invalid email or password");
  }
  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id);
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, accessToken, refreshToken };
}

/**
 * Rotation with token-family breach response: using a token
 * that was already rotated (replayed) is treated as a stolen-token signal —
 * the ENTIRE family is revoked, logging out attacker and legitimate client.
 */
export async function refresh(rawToken) {
  const tokenHash = hashToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { include: { statusFlag: true } } },
  });
  if (!stored || stored.expiresAt < new Date()) {
    throw new HttpError(401, "Invalid refresh token");
  }
  // Phase 12 (§5.1/§7.2 item 4): defense-in-depth — deactivation normally
  // revokes the whole family, but never allow a refused account to mint new
  // tokens even if a token somehow survives.
  if (stored.user?.statusFlag) {
    throw new HttpError(401, "Invalid refresh token");
  }
  if (stored.revokedAt) {
    // Replay detected: revoke the whole family (cascade breach response).
    await prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new HttpError(401, "Invalid refresh token");
  }
  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  const accessToken = signAccessToken(stored.user);
  const refreshToken = await issueRefreshToken(stored.user.id, stored.familyId);
  return {
    user: { id: stored.user.id, email: stored.user.email, name: stored.user.name, role: stored.user.role },
    accessToken,
    refreshToken,
  };
}

export async function logout(rawToken) {
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!stored) return; // unknown/expired token: nothing left to revoke
  // Logout is an explicit "this session must end" signal. Revoke the WHOLE
  // user's refresh set (breach-response semantics): a rotated
  // sibling sharing the family, or a token from another device of the same
  // account, must not outlive an explicit logout.
  await prisma.refreshToken.updateMany({
    where: { userId: stored.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Password reset request. Always responds the same regardless of whether the
 * email exists (no account enumeration). Email sending is deferred per
 * initial setup — the token is logged to the server console for local dev.
 */
export async function forgotPassword(email) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    await prisma.passwordResetToken.create({
      data: { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    // TODO Phase 7+: send via email provider. Dev-only delivery (structured
    // log line + optional sink); the reset link needs the token in this phase.
    deliverDevToken({ kind: "password-reset", email, token });
    await audit.record({ actorId: user.id, action: "PASSWORD_RESET_REQUESTED", target: `user:${user.id}` });
  }
  return { ok: true };
}

export async function resetPassword({ token, password }) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const now = new Date();
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.usedAt || record.expiresAt < now) {
    throw new HttpError(400, "Invalid or expired reset token");
  }
  // §5 (atomic reset): password update, single-use token consumption and
  // refresh-family revocation are ONE transaction, and the token consumption
  // inside it is a guarded compare-and-swap (usedAt IS NULL AND not expired).
  // Two concurrent resets can both pass the findUnique precheck above; only
  // the transaction whose CAS update returns count === 1 commits — the loser
  // rolls back (nothing is burned, nothing is half-applied) and is rejected
  // with the same 400 instead of double-setting the password hash.
  await prisma.$transaction(async (tx) => {
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) {
      throw new HttpError(400, "Invalid or expired reset token");
    }
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    // Password change invalidates every existing session for that user.
    await tx.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: now } });
  });
  await audit.record({ actorId: record.userId, action: "PASSWORD_RESET_COMPLETED", target: `user:${record.userId}` });
  return { ok: true };
}

/**
 * ADMIN-only elevation flow: invite a FLEET_MANAGER or ADMIN
 * by email.
 *
 * §5 (invite delivery seam): the invite token is an account-creation SECRET.
 * In production it is NEVER returned in the HTTP response and NEVER logged —
 * delivery goes through the pluggable DeliveryProvider seam (setInviteDelivery
 * provider mode, wired to a real email provider in Phase 7+); when no provider
 * is configured, production fails SAFE: the invite row is created but delivery
 * is reported as failed (503) and the caller is told to configure a provider —
 * we never silently pretend the invite reached the invitee.
 * Development/test keep the opt-in DEV_TOKEN_DELIVERY log/sink channel (and the
 * explicit `includeInviteToken` opt-in for local CLI relay workflows).
 */
export async function invite({ email, role, invitedBy, includeInviteToken = false }) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new HttpError(409, "Email already registered");
  const pending = await prisma.invite.findFirst({ where: { email, acceptedAt: null, expiresAt: { gt: new Date() } } });
  if (pending) throw new HttpError(409, "An open invite already exists for this email");
  const token = crypto.randomBytes(32).toString("hex");
  const created = await prisma.invite.create({
    data: { email, role, tokenHash: hashToken(token), invitedBy, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });
  if (config.isProd) {
    // Production: deliver ONLY through the explicit provider seam.
    const provider = getInviteDeliveryProvider();
    if (provider) {
      try {
        await provider.sendInvite({ email, role, inviteToken: token, invitedBy });
      } catch (err) {
        log.error({ kind: "invite", email, role }, `invite delivery provider failed: ${err?.message ?? err}`);
        throw new HttpError(503, "Invite created but delivery failed — configure or repair the delivery provider");
      }
    } else {
      // Fail SAFE with a configuration error — the operator must wire a real
      // provider before invitations work in production.
      throw new HttpError(
        503,
        "Invite delivery is not configured — set DELIVERY_PROVIDER / provider credentials (see docs)",
      );
    }
  } else {
    // Non-production: opt-in dev delivery (log line + test sink).
    deliverDevToken({ kind: "invite", email, role, token });
  }
  await audit.record({
    actorId: invitedBy,
    action: "INVITE_SENT",
    target: `invite:${created.id}`,
    detail: `${role} ${email}`,
  });
  // §5: the raw token may only be echoed back to an explicit local-CLI opt-in
  // in NON-production (never in production, even with includeInviteToken=true).
  return {
    inviteId: created.id,
    email,
    role,
    expiresAt: created.expiresAt,
    ...(includeInviteToken && !config.isProd ? { inviteToken: token } : {}),
  };
}

export async function acceptInvite({ inviteToken, password, name }) {
  const invite = await prisma.invite.findUnique({ where: { tokenHash: hashToken(inviteToken) } });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    throw new HttpError(400, "Invalid or expired invite");
  }
  const clash = await prisma.user.findUnique({ where: { email: invite.email } });
  if (clash) throw new HttpError(409, "Email already registered");
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { email: invite.email, name, role: invite.role, passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) },
    });
    await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    return created;
  });
  await audit.record({
    actorId: user.id,
    action: "INVITE_ACCEPTED",
    target: `user:${user.id}`,
    detail: `accepted invite ${invite.id} as ${invite.role}`,
  });
  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id);
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, accessToken, refreshToken };
}
