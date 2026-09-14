import config from "../config.js";
import { getContextLogger } from "./logger.js";

const log = getContextLogger({ module: "sms" });

/**
 * SOS SMS fallback. Twilio REST API via fetch —
 * no SDK dependency. STRICTLY feature-flagged off by default (§512: "the system
 * must function fully without SMS configured"): it only fires when
 * SMS_SOS_ENABLED=true AND Twilio credentials are present. Sends to a single
 * configurable ops/on-call number (SMS_SOS_TO) — SOS is the one alert type
 * where a missed notification is unacceptable, so it pages the on-call line
 * rather than trying to resolve per-recipient phone numbers (User has none).
 */

export function smsConfigured() {
  return Boolean(
    config.smsSosEnabled && config.twilioAccountSid && config.twilioAuthToken && config.twilioFrom && config.smsSosTo,
  );
}

/** Send one SMS. Never throws — best-effort fallback channel (§14.3). */
export async function sendSosSms(body) {
  if (!smsConfigured()) {
    return { sent: false, reason: config.smsSosEnabled ? "twilio-not-configured" : "sms-flag-off" };
  }
  try {
    const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: config.smsSosTo, From: config.twilioFrom, Body: body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      log.error({ status: res.status }, `SOS fallback send failed: ${detail.slice(0, 200)}`);
      return { sent: false, reason: `http-${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    log.error({ err: err?.message }, "SOS fallback send error");
    return { sent: false, reason: err?.message };
  }
}
