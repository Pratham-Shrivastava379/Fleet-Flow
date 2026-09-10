import { trace, diag, DiagConsoleLogger } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
// NOTE: @opentelemetry/resources >= 2.x dropped the `Resource` class entirely —
// the functional API `resourceFromAttributes()` replaces it.

/**
 * Phase 13 distributed tracing (blueprint §11.3).
 *
 * IMPORTANT ORDERING RULE: this module must be imported (side-effect) BEFORE
 * express/http are first required, so the instrumentations can patch them.
 * Both entrypoints do this: server.js and worker.js import "./lib/tracing.js"
 * as their FIRST import. When disabled (no OTEL_EXPORTER_OTLP_ENDPOINT, or
 * OTEL_ENABLED=false) the module is a complete no-op — nothing is patched and
 * no exporter is created — so tests and local dev without the tracing stack
 * stay untouched.
 *
 * The SDK starts at module top level when enabled (ESM import order is the
 * guarantee that patch-before-load holds); entrypoints that import this module
 * second get a started SDK via the shared exported instance.
 *
 * Auto-instrumentation: inbound/outbound HTTP (node builtins patch reliably).
 * Express route-layer spans are deliberately NOT included: on Node >= 20 the
 * ESM loader bypasses require-in-the-middle's Module._load hook, so CJS
 * packages imported via `import` (express) are never patched — registering
 * ExpressInstrumentation here only produced a boot-time "loaded before"
 * warning with zero spans. The http server span + the manual spans below
 * already cover the request lifecycle end-to-end; revisit express layers when
 * the upstream ESM loader story matures (Phase 13 follow-up, implementation
 * report).
 *
 * Manual spans (the two priority paths per §11.3):
 *   - trip.ping_write        — location-ping persistence (tripService)
 *   - notifications.dispatch — alert push/SMS dispatch (notifications job)
 * Traces export over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (the compose
 * stack runs a Jaeger all-in-one at :4318 as the local proving ground).
 */
export function tracingEnabled() {
  if (process.env.OTEL_ENABLED === "false") return false;
  return process.env.OTEL_ENABLED === "true" || Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

let sdk = null;
let inited = false;

export function initTracing() {
  if (inited) return sdk;
  inited = true;
  if (!tracingEnabled()) return null;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
  diag.setLogger(new DiagConsoleLogger(), process.env.OTEL_LOG_LEVEL || "warn");
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME || "fleetflow-backend",
      "service.version": "1.0.0",
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
    instrumentations: [new HttpInstrumentation()],
  });
  sdk.start();
  return sdk;
}

// Self-initialize at module load so the FIRST-import side effect (entrypoints)
// both patches express/http before they load and starts the SDK.
initTracing();

/** Graceful shutdown for the tracing SDK (entrypoints' SIGTERM/SIGINT paths). */
export async function shutdownTracing() {
  if (sdk) {
    try {
      await sdk.shutdown();
    } catch {
      // best-effort flush; never block process exit on a failed export
    }
  }
}

/** Manual span helper: run `fn` inside a span of `name`. No-op when tracing is
 *  disabled (the OTel API is a no-op without a registered provider). */
export async function withSpan(name, fn, attributes = {}) {
  const tracer = trace.getTracer("fleetflow");
  const span = tracer.startSpan(name, { attributes });
  try {
    return await fn(span);
  } finally {
    span.end();
  }
}
