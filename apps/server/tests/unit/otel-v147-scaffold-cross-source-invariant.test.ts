// W976 — V-147 OpenTelemetry scaffold cross-source invariant. Three-
// hundred-second in the drift-guard series. Pins the apps/server/
// src/lib/otel.ts traces-scaffold-only primitive:
//
//   V-147 anchor — 'V-147 — OpenTelemetry traces optional path
//   scaffold (interface-only)'.
//
//   Founder-direction framing — 'Per founder direction: scaffold ONLY
//   (no actual OTel wiring). Instrumentation surface (request ID
//   propagation, span creation hooks, exporter config) lands as TODO
//   comments + interface skeleton. When founder + revenue justify
//   activation post-launch, the wiring is mechanical'.
//
//   No-new-dep Tier-2 framing — 'NO new dependency added — @
//   opentelemetry/api would be a runtime dep change that crosses the
//   Tier 2 line. The interface here uses plain TypeScript only'.
//
//   SpanAttributeValue plain-TS subset — string | number | boolean |
//     readonly string[].
//
//   Span interface 3-method surface — setAttribute(key, value) +
//     recordException(error|{message}) + end().
//
//   Tracer interface single-method surface — startSpan(name, opts?)
//     returning Span.
//
//   span.end() framing — 'The span MUST be ended via span.end();
//     otherwise the duration is lost + exporters report incomplete
//     data'.
//
//   OtelService top-level surface — getTracer(name) + shutdown()
//     returning Promise<void>.
//
//   4-step activation procedure framing — '1. Add @opentelemetry/api
//     + sdk-node + exporter-trace-otlp-http (Tier 2 — requires
//     founder approval). 2. Replace this no-op with a SDK-backed
//     implementation. 3. Wire OTLP HTTP endpoint via
//     OTEL_EXPORTER_OTLP_ENDPOINT. 4. Add bootstrap.ts integration:
//     construct OtelService, pass to AppDeps, instrument the request
//     lifecycle in app.ts'.
//
//   NoopSpan + NoopTracer + NoopOtelService implementations all no-
//     op (single shared tracer instance on NoopOtelService).
//
//   createOtelService factory returns NoopOtelService + TODO note for
//     OTEL_EXPORTER_OTLP_ENDPOINT env branch (post-launch).
//
//   Request-ID propagation note — 'apps/server/src/middleware/
//     request-id.ts already generates a per-request UUID + propagates
//     it via x-request-id header. When OTel wires up, that request
//     id becomes the trace id (or derivative) so logs + traces
//     correlate. Until then, request.id is the only correlation
//     primitive — Pino logs include it; Sentry captureException
//     calls include it as extra.request_id'.
//
// stays in lockstep across apps/server/src/lib/otel.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoopOtelService, createOtelService } from '../../src/lib/otel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W976 V-147 otel scaffold cross-source invariant', () => {
  // ─── V-147 anchor ────────────────────────────────────────────

  it("CRITICAL apps/server/src/lib/otel.ts header pins V-147 anchor — 'V-147 — OpenTelemetry traces optional path scaffold (interface-only)'. The V-147 anchor is the policy provenance for the interface-only OTel scaffold.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/V-147 — OpenTelemetry traces optional path scaffold \(interface-only\)\./);
  });

  // ─── Founder-direction framing ───────────────────────────────

  it("CRITICAL founder-direction framing — 'Per founder direction: scaffold ONLY (no actual OTel wiring). Instrumentation surface (request ID propagation, span creation hooks, exporter config) lands as TODO comments + interface skeleton. When founder + revenue justify activation post-launch, the wiring is mechanical'. The scaffold-only + post-launch-mechanical-wiring design is the V-147 V-deferral contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/Per founder direction: scaffold ONLY \(no actual OTel wiring\)\./);
    expect(p).toMatch(/Instrumentation surface \(request ID propagation, span creation/);
    expect(p).toMatch(/hooks, exporter config\) lands as TODO comments \+ interface/);
    expect(p).toMatch(/skeleton\. When founder \+ revenue justify activation post-launch,/);
    expect(p).toMatch(/the wiring is mechanical\./);
  });

  // ─── No-new-dep Tier-2 framing ───────────────────────────────

  it("CRITICAL no-new-dep Tier-2 framing — 'NO new dependency added — @opentelemetry/api would be a runtime dep change that crosses the Tier 2 line. The interface here uses plain TypeScript only'. The Tier-2-line + plain-TS-only design is what makes V-147 a non-impact addition.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/NO new dependency added — `@opentelemetry\/api` would be a runtime/);
    expect(p).toMatch(/dep change that crosses the Tier 2 line\. The interface here uses/);
    expect(p).toMatch(/plain TypeScript only\./);
  });

  // ─── SpanAttributeValue plain-TS subset ──────────────────────

  it("CRITICAL SpanAttributeValue plain-TS subset — 'string | number | boolean | readonly string[]'. The 4-member union matches @opentelemetry/api's attribute-value subset without importing it.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(
      /export type SpanAttributeValue = string \| number \| boolean \| readonly string\[\];/,
    );
  });

  // ─── Span 3-method surface ───────────────────────────────────

  it('CRITICAL Span interface has 3 methods — setAttribute(key, value) + recordException(Error|{message}) + end(). The 3-method surface is the V-147 minimal span contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/export interface Span \{/);
    expect(p).toMatch(/setAttribute\(key: string, value: SpanAttributeValue\): void;/);
    expect(p).toMatch(/recordException\(error: Error \| \{ message: string \}\): void;/);
    expect(p).toMatch(/end\(\): void;/);
  });

  // ─── Tracer interface + startSpan signature ──────────────────

  it("CRITICAL Tracer interface single-method — 'startSpan(name: string, opts?: { attributes?: Record<string, SpanAttributeValue> }): Span'. The opts.attributes is the @opentelemetry/api-compatible options shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/export interface Tracer \{/);
    expect(p).toMatch(
      /startSpan\(name: string, opts\?: \{ attributes\?: Record<string, SpanAttributeValue> \}\): Span;/,
    );
  });

  // ─── span.end() must-call framing ────────────────────────────

  it("CRITICAL span.end() must-call framing — 'The span MUST be ended via span.end(); otherwise the duration is lost + exporters report incomplete data'. The MUST-be-ended convention is what makes try/finally span ownership critical.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/The span MUST be ended via `span\.end\(\)`; otherwise/);
    expect(p).toMatch(/the duration is lost \+ exporters report incomplete data\./);
  });

  // ─── OtelService top-level + getTracer multi-name framing ────

  it("CRITICAL OtelService interface — 'getTracer(name: string): Tracer' + 'shutdown(): Promise<void>'. The 2-method top-level surface is the V-147 service contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/export interface OtelService \{/);
    expect(p).toMatch(/getTracer\(name: string\): Tracer;/);
    expect(p).toMatch(/shutdown\(\): Promise<void>;/);
  });

  it("CRITICAL multi-tracer-per-component framing — 'Multiple tracers per component (e.g. driftstack.auth, driftstack.db) let exporters group spans by component for navigation'. The 1-tracer-per-component design is the OTel-best-practice navigation pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/Multiple/);
    expect(p).toMatch(/tracers per component \(e\.g\. `'driftstack\.auth'`, `'driftstack\.db'`\)/);
    expect(p).toMatch(/let exporters group spans by component for navigation\./);
  });

  it("CRITICAL force-flush shutdown framing — 'Force-flush pending spans. Called at shutdown to avoid losing the last batch'. The shutdown-force-flush design is the no-trace-loss-on-stop contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(
      /\/\*\* Force-flush pending spans\. Called at shutdown to avoid losing the last batch\. \*\//,
    );
  });

  // ─── 4-step activation procedure ─────────────────────────────

  it("CRITICAL activation procedure 4-step framing — '1. Add @opentelemetry/api + @opentelemetry/sdk-node + @opentelemetry/exporter-trace-otlp-http runtime deps (Tier 2 — requires founder approval). 2. Replace this no-op with a SDK-backed implementation. 3. Wire OTLP HTTP endpoint via OTEL_EXPORTER_OTLP_ENDPOINT env var (signal-grade upstream — Tempo, Jaeger, Honeycomb, etc., all accept OTLP). 4. Add bootstrap.ts integration: construct OtelService, pass to AppDeps, instrument the request lifecycle in app.ts'. The 4-step procedure is the V-147 activation runbook.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/Activation procedure \(when founder approves\):/);
    expect(p).toMatch(/1\. Add `@opentelemetry\/api` \+ `@opentelemetry\/sdk-node` \+/);
    expect(p).toMatch(/`@opentelemetry\/exporter-trace-otlp-http` runtime deps/);
    expect(p).toMatch(/\(Tier 2 — requires founder approval\)\./);
    expect(p).toMatch(/2\. Replace this no-op with a SDK-backed implementation\./);
    expect(p).toMatch(/3\. Wire OTLP HTTP endpoint via `OTEL_EXPORTER_OTLP_ENDPOINT`/);
    expect(p).toMatch(/env var \(signal-grade upstream — Tempo, Jaeger, Honeycomb,/);
    expect(p).toMatch(/etc\., all accept OTLP\)\./);
    expect(p).toMatch(/4\. Add `bootstrap\.ts` integration: construct OtelService, pass/);
    expect(p).toMatch(/to AppDeps, instrument the request lifecycle in app\.ts\./);
  });

  // ─── No-op classes ───────────────────────────────────────────

  it('CRITICAL NoopSpan + NoopTracer are private classes; NoopOtelService is exported. The 1-public-2-private split keeps the surface minimal.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/class NoopSpan implements Span \{/);
    expect(p).toMatch(/class NoopTracer implements Tracer \{/);
    expect(p).toMatch(/export class NoopOtelService implements OtelService \{/);
  });

  it('CRITICAL NoopOtelService caches a single NoopTracer instance — private readonly tracer = new NoopTracer(); getTracer ignores name + returns this.tracer. The single-instance design avoids per-call allocation in the hot path.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/private readonly tracer = new NoopTracer\(\);/);
    expect(p).toMatch(/getTracer\(_name: string\): Tracer \{/);
    expect(p).toMatch(/return this\.tracer;/);
  });

  it('CRITICAL NoopOtelService.shutdown returns Promise.resolve(). The immediate-resolve keeps the no-op-shutdown trivially flushable.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/shutdown\(\): Promise<void> \{/);
    expect(p).toMatch(/return Promise\.resolve\(\);/);
  });

  // ─── createOtelService factory + post-launch TODO ────────────

  it('CRITICAL createOtelService factory returns NoopOtelService + has TODO(post-launch) note for OTEL_EXPORTER_OTLP_ENDPOINT env branch. The TODO marks the activation hook-point without changing today behavior.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/export function createOtelService\(\): OtelService \{/);
    expect(p).toMatch(/TODO\(post-launch\): branch on `OTEL_EXPORTER_OTLP_ENDPOINT` env/);
    expect(p).toMatch(/var presence to construct a real SDK-backed OtelService when/);
    expect(p).toMatch(/configured, falling back to NoopOtelService when not\./);
    expect(p).toMatch(/return new NoopOtelService\(\);/);
  });

  // ─── Request-ID propagation note ─────────────────────────────

  it("CRITICAL request-ID propagation framing — 'apps/server/src/middleware/request-id.ts already generates a per-request UUID + propagates it via the x-request-id header. When OTel wires up, that request id becomes the trace id (or derivative) so logs + traces correlate. Until then, request.id is the only correlation primitive — Pino logs include it; Sentry captureException calls include it as extra.request_id (apps/server/src/lib/sentry.ts:wireSentryErrorHandler)'. The request-id-as-future-trace-id design is the V-494 + V-147 correlation contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts'));
    expect(p).toMatch(/`apps\/server\/src\/middleware\/request-id\.ts` already generates a/);
    expect(p).toMatch(/per-request UUID \+ propagates it via the `x-request-id` header\./);
    expect(p).toMatch(/When OTel wires up, that request id becomes the trace id \(or/);
    expect(p).toMatch(/derivative\) so logs \+ traces correlate\. Until then, `request\.id`/);
    expect(p).toMatch(/is the only correlation primitive — Pino logs include it; Sentry/);
    expect(p).toMatch(/captureException calls include it as `extra\.request_id`/);
    expect(p).toMatch(/\(`apps\/server\/src\/lib\/sentry\.ts:wireSentryErrorHandler`\)\./);
  });

  // ─── Runtime: NoopOtelService no-op contract ─────────────────

  it('CRITICAL runtime — createOtelService returns a NoopOtelService instance. Default boot returns the no-op.', () => {
    const otel = createOtelService();
    expect(otel).toBeInstanceOf(NoopOtelService);
  });

  it('CRITICAL runtime — NoopOtelService.getTracer returns same tracer for any name. Cached single-instance.', () => {
    const otel = new NoopOtelService();
    const t1 = otel.getTracer('a');
    const t2 = otel.getTracer('b');
    expect(t1).toBe(t2);
  });

  it('CRITICAL runtime — span methods are no-ops + do not throw. The setAttribute/recordException/end call sequence stays safe even before wiring.', () => {
    const otel = new NoopOtelService();
    const span = otel.getTracer('component').startSpan('op', { attributes: { x: 'y' } });
    expect(() => {
      span.setAttribute('k', 1);
      span.recordException(new Error('boom'));
      span.recordException({ message: 'oops' });
      span.end();
    }).not.toThrow();
  });

  it('CRITICAL runtime — shutdown resolves immediately.', async () => {
    const otel = new NoopOtelService();
    await expect(otel.shutdown()).resolves.toBeUndefined();
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/otel-v147-scaffold-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
