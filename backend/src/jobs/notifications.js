import { prisma } from "../prisma.js";
import { sendPushToTokens } from "../lib/fcm.js";
import { sendSosSms } from "../lib/sms.js";
import config from "../config.js";
import { getContextLogger } from "../lib/logger.js";
import { withSpan } from "../lib/tracing.js";
import { notificationDispatchDuration } from "../lib/metrics.js";

/**
 * `notifications` job. Runs in the background
 * worker process so slow/flaky provider calls never block the alert-creating
 * request path. data: {alertId, requestId?}.
 *
 * Recipients: every ADMIN/FLEET_MANAGER's registered device tokens.
 *
 * Preference enforcement (§713): a recipient's NotificationPreference for the
 * alert type suppresses the push — EXCEPT SOS, which is exempt from
 * suppression (done-condition §15.7).
 *
 * Phase 13 (§11.3): the dispatch is wrapped in a `notifications.dispatch`
 * trace span and timed (notification_dispatch_duration_seconds, §11.2);
 * requestId (carried from the alert-creating request, §11.1) is attached to
 * the log line so an async dispatch is traceable end-to-end.
 */
const ALERT_LABELS = {
  SOS: "SOS emergency",
  HARSH_BRAKING: "Harsh braking",
  OVERSPEED: "Overspeed",
  GEOFENCE_ENTER: "Geofence entry",
  GEOFENCE_EXIT: "Geofence exit",
  CRASH_DETECTED: "Crash detected",
};

export async function notificationsJob(data) {
  const start = process.hrtime.bigint();
  return withSpan(
    "notifications.dispatch",
    async () => {
      const log = getContextLogger({
        module: "notifications",
        ...(data.requestId ? { requestId: data.requestId } : {}),
      });
      const alert = await prisma.alert.findUnique({ where: { id: data.alertId } });
      if (!alert) return { skipped: "alert-gone" };

      const managers = await prisma.user.findMany({
        where: { role: { in: ["ADMIN", "FLEET_MANAGER"] } },
        select: {
          id: true,
          deviceTokens: { select: { token: true } },
          notificationPrefs: { where: { type: alert.type }, select: { enabled: true } },
        },
      });

      const exempt = alert.type === "SOS";
      const recipients = managers.filter((m) => exempt || m.notificationPrefs[0]?.enabled !== false);
      const tokens = recipients.flatMap((m) => m.deviceTokens.map((d) => d.token));

      const label = ALERT_LABELS[alert.type] ?? alert.type;
      const sent = await sendPushToTokens(tokens, {
        notification: {
          title: label,
          body: alert.detail || `Alert #${alert.id} (${alert.type})`,
        },
        data: {
          alertId: String(alert.id),
          type: alert.type,
          status: alert.status,
          lat: String(alert.lat ?? ""),
          lng: String(alert.lng ?? ""),
        },
      });
      const delivered = sent.filter((r) => r.ok).length;

      // SOS-only SMS fallback (feature-flagged off by default, §714/§512)
      let sms = { sent: false, reason: "not-sos" };
      if (exempt) {
        sms = await sendSosSms(
          `FleetFlow SOS: alert #${alert.id} (${label}) at ${alert.lat},${alert.lng} — ${config.appBaseUrl ?? ""}`,
        );
      }

      const result = {
        alertId: alert.id,
        type: alert.type,
        recipients: recipients.length,
        tokens: tokens.length,
        delivered,
        pruned: sent.filter((r) => !r.ok && r.error === "fcm-unconfigured").length,
        sms,
      };
      log.info(
        {
          alertId: alert.id,
          type: alert.type,
          recipients: recipients.length,
          tokens: tokens.length,
          delivered,
        },
        `notification dispatch complete (${delivered}/${tokens.length} pushes delivered)`,
      );
      return result;
    },
    { alertId: String(data.alertId) },
  ).finally(() => {
    notificationDispatchDuration.observe(Number(process.hrtime.bigint() - start) / 1e9);
  });
}

export default notificationsJob;
