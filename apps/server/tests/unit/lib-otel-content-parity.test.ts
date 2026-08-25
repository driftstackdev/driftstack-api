// W391.C — drift guard for apps/server/src/lib/otel.ts.
// V-147 — OpenTelemetry traces optional path SCAFFOLD-ONLY. Per
// founder direction: no actual OTel wiring; interface skeleton +
// no-op default only. NO new runtime dependency (would cross the
// Tier 2 line). When founder + revenue justify activation
// post-launch, the wiring is mechanical.
//
//   • V-147 scaffold-only framing pinned.
//   • "NO new dependency" Tier 2 rationale pinned.
//   • SpanAttributeValue subset (string | number | boolean |
//     readonly string[]).
//   • Span interface 3-method shape (setAttribute / recordException /
//     end).
//   • Tracer interface (startSpan with optional attributes).
//   • OtelService interface (getTracer + shutdown).
//   • NoopSpan + NoopTracer + NoopOtelService implementations.
//   • createOtelService default = NoopOtelService.
//   • 4-step Activation procedure pinned.
//   • Request-ID propagation note pinned (request-id middleware
//     primitive becomes trace id when OTel wires up).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/otel.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W391.C apps/server/src/lib/otel.ts content parity', () => {
  const body = read(LIB);

  it('V-147 scaffold-only framing pinned (interface skeleton + no-op default, no wiring)', () => {
    expect(body).toMatch(
      /V-147 — OpenTelemetry traces optional path scaffold \(interface-only\)\./,
    );
    expect(body).toMatch(
      /Per founder direction: scaffold ONLY \(no actual OTel wiring\)\.\s*\/\/\s*Instrumentation surface \(request ID propagation, span creation\s*\/\/\s*hooks, exporter config\) lands as TODO comments \+ interface\s*\/\/\s*skeleton/,
    );
  });

  it('"NO new dependency" Tier 2 line framing pinned', () => {
    expect(body).toMatch(
      /NO new dependency added — `@opentelemetry\/api` would be a runtime\s*\/\/\s*dep change that crosses the Tier 2 line\. The interface here uses\s*\/\/\s*plain TypeScript only/,
    );
  });

  it('SpanAttributeValue type: string | number | boolean | readonly string[]', () => {
    expect(body).toMatch(
      /export type SpanAttributeValue = string \| number \| boolean \| readonly string\[\];/,
    );
  });

  it('Span interface: 3-method shape (setAttribute + recordException + end)', () => {
    expect(body).toMatch(/export interface Span \{/);
    expect(body).toMatch(/setAttribute\(key: string, value: SpanAttributeValue\): void;/);
    expect(body).toMatch(/recordException\(error: Error \| \{ message: string \}\): void;/);
    expect(body).toMatch(/end\(\): void;/);
  });

  it('Tracer interface: startSpan with optional attributes opts + must-be-ended framing', () => {
    expect(body).toMatch(/export interface Tracer \{/);
    expect(body).toMatch(
      /The span MUST be ended via `span\.end\(\)`; otherwise\s*\*\s*the duration is lost \+ exporters report incomplete data/,
    );
    expect(body).toMatch(
      /startSpan\(name: string, opts\?: \{ attributes\?: Record<string, SpanAttributeValue> \}\): Span;/,
    );
  });

  it('OtelService interface: getTracer + shutdown (force-flush at shutdown)', () => {
    expect(body).toMatch(/export interface OtelService \{/);
    expect(body).toMatch(/getTracer\(name: string\): Tracer;/);
    expect(body).toMatch(
      /Force-flush pending spans\. Called at shutdown to avoid losing the last batch\./,
    );
    expect(body).toMatch(/shutdown\(\): Promise<void>;/);
  });

  it('NoopSpan: 3 no-op methods (setAttribute / recordException / end)', () => {
    expect(body).toMatch(/class NoopSpan implements Span \{/);
    expect(body).toMatch(
      /setAttribute\(_key: string, _value: SpanAttributeValue\): void \{\s*\/\/ no-op\s*\}/,
    );
    expect(body).toMatch(
      /recordException\(_error: Error \| \{ message: string \}\): void \{\s*\/\/ no-op\s*\}/,
    );
    expect(body).toMatch(/end\(\): void \{\s*\/\/ no-op\s*\}/);
  });

  it('NoopTracer: startSpan returns new NoopSpan', () => {
    expect(body).toMatch(/class NoopTracer implements Tracer \{/);
    expect(body).toMatch(
      /startSpan\(_name: string, _opts\?: \{ attributes\?: Record<string, SpanAttributeValue> \}\): Span \{\s*return new NoopSpan\(\);\s*\}/,
    );
  });

  it('NoopOtelService: single shared NoopTracer + shutdown returns Promise.resolve()', () => {
    expect(body).toMatch(/export class NoopOtelService implements OtelService \{/);
    expect(body).toMatch(/private readonly tracer = new NoopTracer\(\);/);
    expect(body).toMatch(/getTracer\(_name: string\): Tracer \{\s*return this\.tracer;\s*\}/);
    expect(body).toMatch(/shutdown\(\): Promise<void> \{\s*return Promise\.resolve\(\);\s*\}/);
  });

  it('createOtelService: default returns NoopOtelService + TODO(post-launch) for OTEL_EXPORTER_OTLP_ENDPOINT branch', () => {
    expect(body).toMatch(
      /Default export for boot — returns a no-op until founder activates wiring\./,
    );
    expect(body).toMatch(
      /export function createOtelService\(\): OtelService \{\s*\/\/ TODO\(post-launch\): branch on `OTEL_EXPORTER_OTLP_ENDPOINT` env\s*\/\/\s*var presence to construct a real SDK-backed OtelService when\s*\/\/\s*configured, falling back to NoopOtelService when not\.\s*return new NoopOtelService\(\);\s*\}/,
    );
  });

  it('Activation procedure: 4-step (deps add → SDK-backed impl → OTLP endpoint env → bootstrap integration)', () => {
    expect(body).toMatch(/Activation procedure \(when founder approves\):/);
    expect(body).toMatch(
      /1\. Add `@opentelemetry\/api` \+ `@opentelemetry\/sdk-node` \+\s*\*\s*`@opentelemetry\/exporter-trace-otlp-http` runtime deps\s*\*\s*\(Tier 2 — requires founder approval\)\./,
    );
    expect(body).toMatch(/2\. Replace this no-op with a SDK-backed implementation\./);
    expect(body).toMatch(
      /3\. Wire OTLP HTTP endpoint via `OTEL_EXPORTER_OTLP_ENDPOINT`\s*\*\s*env var \(signal-grade upstream — Tempo, Jaeger, Honeycomb,\s*\*\s*etc\., all accept OTLP\)\./,
    );
    expect(body).toMatch(
      /4\. Add `bootstrap\.ts` integration: construct OtelService, pass\s*\*\s*to AppDeps, instrument the request lifecycle in app\.ts\./,
    );
  });

  it('Request-ID propagation note: request-id middleware UUID becomes the trace id when OTel wires up', () => {
    expect(body).toMatch(
      /`apps\/server\/src\/middleware\/request-id\.ts` already generates a\s*\/\/\s*per-request UUID \+ propagates it via the `x-request-id` header\.\s*\/\/\s*When OTel wires up, that request id becomes the trace id \(or\s*\/\/\s*derivative\) so logs \+ traces correlate/,
    );
    expect(body).toMatch(
      /Sentry\s*\/\/\s*captureException calls include it as `extra\.request_id`\s*\/\/\s*\(`apps\/server\/src\/lib\/sentry\.ts:wireSentryErrorHandler`\)/,
    );
  });

  it('imports: NONE (plain TS only — no @opentelemetry/api dep)', () => {
    // Sanity check that the scaffold-only posture isn't accidentally violated.
    expect(body).not.toMatch(/from '@opentelemetry\//);
    expect(body).not.toMatch(/import .+ from '@opentelemetry/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
