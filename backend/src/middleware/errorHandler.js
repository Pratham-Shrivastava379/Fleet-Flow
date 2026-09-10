import { Prisma } from "@prisma/client";
import { getContextLogger } from "../lib/logger.js";
import { captureError } from "../lib/sentry.js";

export function notFound(req, res) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Conflict: resource already exists", meta: err.meta?.target });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Resource not found" });
    }
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON body" });
  }
  const status = err.status || 500;
  const log = getContextLogger({ module: "error" });
  // Phase 13 (§11.1/§11.4): unexpected 5xx errors are logged with the request
  // context (requestId/userId — from the ALS store the requestContext
  // middleware opened) and forwarded to Sentry when SENTRY_DSN is configured.
  if (status >= 500) {
    log.error({ err: { message: err?.message, stack: err?.stack, status } }, "unhandled error");
    captureError(err, { requestId: req.headers["x-request-id"] || undefined, userId: req.user?.id ?? undefined });
  } else {
    log.warn({ err: err?.message, status }, "request error");
  }
  res.status(status).json({ error: err.publicMessage || "Internal server error" });
}

export class HttpError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}
