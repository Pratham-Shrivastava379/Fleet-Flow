import { WebSocketServer } from "ws";
import { subscribeFleetEvents, fleetEventTopics } from "./lib/events.js";
import jwt from "jsonwebtoken";
import config from "./config.js";
import { prisma } from "./prisma.js";
// Phase 13 (§11.2): live WS connection count for the metrics endpoint.
import { wsConnections } from "./lib/metrics.js";

// Live fleet channel. Reliability model (per JD: "designed for reliability rather
// than assuming constant connectivity"):
//  - Clients authenticate with a JWT after connecting ({type:"auth"}).
//  - REST is the source of truth; pings/alerts are POSTed and then fanned out
//    here — Phase 6: fan-out ALWAYS arrives via the `fleet:events` Redis
//    channel (publishFleetEvent), so this module only does local delivery.
//  - Phase 6 topic model (§4.3): each socket holds a Set of topics
//    (`fleet:all` | `driver:<id>` | `vehicle:<id>`); an event is delivered iff
//    its `topics` intersect the socket's. Default subscription is role-based:
//    DRIVER → driver:<own id>; FLEET_MANAGER/ADMIN → fleet:all.
//  - Mobile keeps its own Room-backed queue, so a dropped WS never loses data.
const servers = new Set(); // supports multiple WS instances per process (tests / co-located gateways)
let unsubscribeFleetEvents = null;

const TOPIC_RE = /^(fleet:all|driver:\d+|vehicle:\d+)$/;

/** Topics a socket is ALLOWED to hold for a given role/user (silently filters). */
function allowedTopics(topics, user) {
  const granted = [];
  for (const t of topics || []) {
    if (typeof t !== "string" || !TOPIC_RE.test(t)) continue;
    if (t === "fleet:all") {
      if (user.role === "ADMIN" || user.role === "FLEET_MANAGER") granted.push(t);
    } else if (t.startsWith("driver:")) {
      const id = Number(t.slice(7));
      if (user.role === "ADMIN" || user.role === "FLEET_MANAGER" || id === user.id) granted.push(t);
    } else {
      // vehicle:<id> — fleet-view topic; drivers use their own driver topic
      if (user.role === "ADMIN" || user.role === "FLEET_MANAGER") granted.push(t);
    }
  }
  return [...new Set(granted)];
}

/** Default subscriptions for a freshly authenticated socket. */
function defaultTopics(user) {
  return user.role === "DRIVER" ? [`driver:${user.id}`] : ["fleet:all"];
}

export function initWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  // ADR-3 bridge (Phase 5, generalized Phase 6): everything published to the
  // `fleet:events` Redis channel — from this process's services, another API
  // instance, or a background worker — is delivered here to locally connected,
  // topic-subscribed clients. Best-effort delivery; REST is the source of truth.
  // Registered ONCE per process (the handler fans out to ALL local instances),
  // otherwise N instances would each receive (and re-deliver) every event N times.
  // NOTE: this check MUST run BEFORE `servers.add(wss)` below — after the add,
  // `servers.size` is already 1 and the Redis subscriber would never be created.
  if (servers.size === 0) {
    unsubscribeFleetEvents = subscribeFleetEvents((event) => broadcastFleetEvent(event));
  }
  servers.add(wss);

  wss.on("connection", (socket, req) => {
    wsConnections.inc();
    let authed = false;
    socket.isAlive = true;
    socket.topics = new Set();
    socket.on("pong", () => (socket.isAlive = true));
    socket.on("close", () => wsConnections.dec());

    // Token may also arrive via ?token= query for clients that can't send frames first
    const url = new URL(req.url, "http://localhost");
    const qsToken = url.searchParams.get("token");

    const tryAuth = (token) => {
      let payload;
      try {
        payload = jwt.verify(token, config.jwtAccessSecret);
      } catch {
        socket.send(JSON.stringify({ type: "auth_failed" }));
        return;
      }
      // §2 (current account state) + §2 (WS authorization parity): the topic
      // ACL below is the per-subscription boundary, but a deactivated or
      // deleted account must not keep a live fleet subscription at all just
      // because its access token is still cryptographically valid. The role
      // also comes from the DB row, not the (possibly stale) JWT claim.
      void (async () => {
        try {
          const user = await prisma.user.findUnique({
            where: { id: Number(payload.sub) },
            select: { role: true, statusFlag: true },
          });
          if (!user || user.statusFlag) {
            socket.send(JSON.stringify({ type: "auth_failed" }));
            return;
          }
          socket.user = { id: Number(payload.sub), role: user.role };
          authed = true;
          // Role-based default subscription; clients can narrow/expand via
          // {type:"subscribe"} / {type:"unsubscribe"} afterwards (filtered by
          // allowedTopics — a DRIVER can never hold another driver's topic).
          socket.topics = new Set(defaultTopics(socket.user));
          socket.send(JSON.stringify({ type: "auth_ok", role: user.role, topics: [...socket.topics] }));
        } catch {
          socket.send(JSON.stringify({ type: "auth_failed" }));
        }
      })();
    };
    if (qsToken) tryAuth(qsToken);

    socket.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return socket.send(JSON.stringify({ type: "error", error: "bad json" }));
      }
      if (msg.type === "auth" && typeof msg.token === "string") tryAuth(msg.token);
      else if (!authed) socket.send(JSON.stringify({ type: "error", error: "authenticate first" }));
      else if (msg.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      else if (msg.type === "subscribe" || msg.type === "unsubscribe") {
        if (msg.type === "subscribe") {
          // §2: re-check account state before minting NEW subscriptions — a
          // mid-session deactivation must not extend a live socket's authority
          // (the socket close below also kills any existing subscriptions).
          void prisma.user
            .findUnique({ where: { id: socket.user.id }, select: { role: true, statusFlag: true } })
            .then((user) => {
              if (!user || user.statusFlag) {
                socket.send(JSON.stringify({ type: "error", error: "Account deactivated" }));
                socket.close();
                return;
              }
              // §2 (WS authorization parity with the REST DB-fresh role check):
              // a mid-session ROLE change (e.g. a demotion) must take effect on
              // the live socket. Adopt the fresh role and reset subscriptions
              // to the new role's defaults — topics granted under the old role
              // (fleet:all, vehicle:*) no longer apply and are dropped here.
              if (user.role !== socket.user.role) {
                socket.user = { id: socket.user.id, role: user.role };
                socket.topics = new Set(defaultTopics(socket.user));
              }
              applySubscribe(msg, socket);
            })
            .catch(() => {
              // FAIL CLOSED: if the account-state revalidation cannot be answered
              // (e.g. DB unreachable), do NOT mint a new subscription. The socket
              // is torn down so a deactivated account can never extend a live
              // session's authority while the store is unavailable.
              socket.send(JSON.stringify({ type: "error", error: "Service unavailable" }));
              socket.close();
            });
          return;
        }
        applySubscribe(msg, socket);
      }
    });

    /** ACL-filtered topic grant/remove + ack (shared by subscribe/unsubscribe). */
    function applySubscribe(msg, socket) {
      const granted = allowedTopics(msg.topics, socket.user);
      for (const t of granted) {
        if (msg.type === "subscribe") socket.topics.add(t);
        else socket.topics.delete(t);
      }
      socket.send(
        JSON.stringify({
          type: msg.type === "subscribe" ? "subscribed" : "unsubscribed",
          topics: granted,
          subscriptions: [...socket.topics],
        }),
      );
    }

    socket.send(JSON.stringify({ type: "hello", requiresAuth: !authed }));
  });

  // heartbeat: drop dead connections every 30s
  const interval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);
  wss.on("close", () => {
    clearInterval(interval);
    servers.delete(wss);
    if (servers.size === 0 && unsubscribeFleetEvents) {
      unsubscribeFleetEvents();
      unsubscribeFleetEvents = null;
    }
  });

  return wss;
}

/**
 * Deliver a fleet event to this process's authenticated sockets whose topic
 * subscriptions intersect event.topics. Called ONLY by the Redis bridge —
 * services publish via publishFleetEvent (lib/events.js) so cross-instance
 * delivery is correct even with multiple API processes.
 * Events without `topics` (legacy workers) are treated as fleet:all.
 */
export function broadcastFleetEvent(event) {
  if (servers.size === 0) return;
  const topics = new Set(event.topics?.length ? event.topics : ["fleet:all"]);
  const data = JSON.stringify({ ...event, ts: new Date().toISOString() });
  for (const wss of servers) {
    for (const socket of wss.clients) {
      if (socket.readyState !== socket.OPEN || !socket.user) continue;
      for (const t of socket.topics) {
        if (topics.has(t)) {
          socket.send(data);
          break;
        }
      }
    }
  }
}

export { fleetEventTopics };
