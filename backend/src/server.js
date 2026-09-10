// Phase 13 (§11.3): tracing MUST initialize before express/http load so the
// instrumentations can patch them — this import is the entrypoint's first one.
import "./lib/tracing.js";
import http from "node:http";
import config from "./config.js";
import { createApp } from "./app.js";
import { initWebSocket } from "./websocket.js";
import { prisma } from "./prisma.js";
import { logger } from "./lib/logger.js";
import { shutdownTracing } from "./lib/tracing.js";
import { initSentry } from "./lib/sentry.js";

initSentry();

const app = createApp();
const server = http.createServer(app);
initWebSocket(server);

server.listen(config.port, () => {
  logger.info({ port: config.port }, `FleetFlow API listening (WS at /ws)`);
});

async function shutdown(signal) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await shutdownTracing();
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
