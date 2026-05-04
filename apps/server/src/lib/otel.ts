// V-147 — OpenTelemetry traces optional path scaffold (interface-only).
//
// Per founder direction: scaffold ONLY (no actual OTel wiring).
// Instrumentation surface (request ID propagation, span creation
// hooks, exporter config) lands as TODO comments + interface
// skeleton. When founder + revenue justify activation post-launch,
// the wiring is mechanical.
//
// NO new dependency added — `@opentelemetry/api` would be a runtime
// dep change that crosses the Tier 2 line. The interface here uses
// plain TypeScript only.
//
// Usage when wired (future):
//
//   const tracer = otel.getTracer('driftstack.server');
//   const span = tracer.startSpan('sessions.create');
//   try {
//     // ...
//     span.setAttribute('account_id', ctx.account.id);
//     return result;
//   } finally {
//     span.end();
//   }
//
// Today (no wiring): tracer is a no-op; spans capture no data; the
// surrounding code reads identical whether OTel is enabled or not.

/** Span attribute values OTel allows. Plain TS subset of @opentelemetry/api. */
export type SpanAttributeValue = string | number | boolean | readonly string[];

export interface Span {
  /** Add a key/value attribute to the span. */
  setAttribute(key: string, value: SpanAttributeValue): void;
  /** Mark the span as failed. Optionally include an error message. */
  recordException(error: Error | { message: string }): void;
  /** End the span — captures duration + emits to the configured exporter. */
  end(): void;
}

export interface Tracer {
  /** Start a new span. The span MUST be ended via `span.end()`; otherwise
   * the duration is lost + exporters report incomplete data. */
  startSpan(name: string, opts?: { attributes?: Record<string, SpanAttributeValue> }): Span;
}

/**
 * Top-level OTel surface. The `getTracer(name)` call is the entry
 * point for every component that wants to emit spans. Multiple
 * tracers per component (e.g. `'driftstack.auth'`, `'driftstack.db'`)
 * let exporters group spans by component for navigation.
 */
export interface OtelService {
  getTracer(name: string): Tracer;
  /** Force-flush pending spans. Called at shutdown to avoid losing the last batch. */
  shutdown(): Promise<void>;
}

// ── No-op default ────────────────────────────────────────────────────

/**
 * No-op OTel service. Default while OTel is unwired. Returns spans
 * that accept all calls but emit nothing.
 *
 * Activation procedure (when founder approves):
 *   1. Add `@opentelemetry/api` + `@opentelemetry/sdk-node` +
 *      `@opentelemetry/exporter-trace-otlp-http` runtime deps
 *      (Tier 2 — requires founder approval).
 *   2. Replace this no-op with a SDK-backed implementation.
 *   3. Wire OTLP HTTP endpoint via `OTEL_EXPORTER_OTLP_ENDPOINT`
 *      env var (signal-grade upstream — Tempo, Jaeger, Honeycomb,
 *      etc., all accept OTLP).
 *   4. Add `bootstrap.ts` integration: construct OtelService, pass
 *      to AppDeps, instrument the request lifecycle in app.ts.
 */
class NoopSpan implements Span {
  setAttribute(_key: string, _value: SpanAttributeValue): void {
    // no-op
  }
  recordException(_error: Error | { message: string }): void {
    // no-op
  }
  end(): void {
    // no-op
  }
}

class NoopTracer implements Tracer {
  startSpan(_name: string, _opts?: { attributes?: Record<string, SpanAttributeValue> }): Span {
    return new NoopSpan();
  }
}

export class NoopOtelService implements OtelService {
  private readonly tracer = new NoopTracer();
  getTracer(_name: string): Tracer {
    return this.tracer;
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Default export for boot — returns a no-op until founder activates wiring. */
export function createOtelService(): OtelService {
  // TODO(post-launch): branch on `OTEL_EXPORTER_OTLP_ENDPOINT` env
  // var presence to construct a real SDK-backed OtelService when
  // configured, falling back to NoopOtelService when not.
  return new NoopOtelService();
}

// ── Request-ID propagation note ─────────────────────────────────────
//
// `apps/server/src/middleware/request-id.ts` already generates a
// per-request UUID + propagates it via the `x-request-id` header.
// When OTel wires up, that request id becomes the trace id (or
// derivative) so logs + traces correlate. Until then, `request.id`
// is the only correlation primitive — Pino logs include it; Sentry
// captureException calls include it as `extra.request_id`
// (`apps/server/src/lib/sentry.ts:wireSentryErrorHandler`).
