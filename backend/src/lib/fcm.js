import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

/**
 * FCM push sender. Credentials come from the
 * environment, never from the repo: either GOOGLE_APPLICATION_CREDENTIALS
 * (path to a service-account JSON) or FCM_SERVICE_ACCOUNT_JSON (the JSON
 * itself, for secrets-manager injection). When neither is configured the
 * sender reports `configured:false` and dispatch is skipped WITH a log —
 * it never silently no-ops in a production deploy (config error is loud).
 *
 * Tests inject a mock sender via setFcmSender() (done-condition §15.7:
 * "(mocked) FCM send call with correct payload").
 */

import { getContextLogger } from "./logger.js";

let injectedSender = null; // test seam
let loggedUnconfigured = false;

const log = getContextLogger({ module: "fcm" });

function initFirebaseAdmin() {
  if (getApps().length) return;
  if (process.env.FCM_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp(); // adc picks up the service account path
  } else {
    return false;
  }
  return true;
}

/** Replace the sender (tests). Pass null to restore the real one. */
export function setFcmSender(fn) {
  injectedSender = fn;
}

export function fcmConfigured() {
  if (injectedSender) return true;
  return Boolean(process.env.FCM_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

/**
 * Send one FCM message per registration token. Returns per-token results:
 * [{token, ok, error?}]. Invalid/unknown tokens surface as ok:false with the
 * provider error so callers can prune dead registrations later.
 */
export async function sendPushToTokens(tokens, message) {
  if (!tokens?.length) return [];
  if (injectedSender) return injectedSender(tokens, message);

  if (!initFirebaseAdmin()) {
    if (!loggedUnconfigured) {
      log.error(
        "no service-account configured (set GOOGLE_APPLICATION_CREDENTIALS or FCM_SERVICE_ACCOUNT_JSON) — push notifications are NOT being delivered",
      );
      loggedUnconfigured = true;
    }
    return tokens.map((token) => ({ token, ok: false, error: "fcm-unconfigured" }));
  }

  const messaging = getMessaging();
  return Promise.all(
    tokens.map(async (token) => {
      try {
        await messaging.send({ ...message, token });
        return { token, ok: true };
      } catch (err) {
        return { token, ok: false, error: err?.message };
      }
    }),
  );
}
