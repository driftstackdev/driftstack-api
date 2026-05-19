// Drift guard for apps/gui-client/src/lib/fork-telemetry.ts (Wave 29-400
// §1+§2 telemetry consumer, Slice B). Pins:
//
//   • Event-family regex constants (RX_V510_HIT / RX_ATLAS_MAPPED /
//     RX_ATLAS_NOT_PRESENT / RX_AFP_FALLBACK / RX_PROBE_SIG / RX_HOOK /
//     RX_ARCHETYPE_INIT). Source-of-truth = the WTFLogAlways tags in
//     /Users/john/code/driftstack/docs/internal/driftstack-telemetry-
//     event-schema-for-gui-panel.md — drift on either side breaks the
//     panel without a runtime test catching it until a customer session
//     actually fires the missed event.
//
//   • Type-union shapes (AtlasSlot / AfpContext / ProbeSigContext /
//     HookTag / SpoofingStatus). Drift on the unions vs the schema means
//     new event categories don't get aggregated.
//
//   • State-machine surface (applyEventLine / reduceEventStream /
//     deriveSpoofingStatus exports). Removing one breaks consumers.
//
// This test reads the source file as text + asserts the documented
// regex patterns are present byte-for-byte. Bypasses runtime; catches
// drift even when the file still compiles.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SOURCE = readFileSync(
  resolve(REPO_ROOT, 'apps/gui-client/src/lib/fork-telemetry.ts'),
  'utf8',
);

describe('fork-telemetry content parity (Wave 29-400 Slice B)', () => {
  it('header anchors the schema doc + Option A verdict', () => {
    expect(SOURCE).toMatch(/Wave 29-400 §1\+§2 telemetry consumer/);
    // "Option A locked" may line-wrap as "Option\n// A locked" in the
    // header comment — match across any intermediate chars.
    expect(SOURCE).toMatch(/Option[\s\S]*?A locked/);
    expect(SOURCE).toMatch(/docs\/internal\/driftstack-telemetry-event-schema-for-/);
  });

  it('atlas-slot union: main | priority', () => {
    expect(SOURCE).toMatch(/export type AtlasSlot = 'main' \| 'priority';/);
  });

  it('AFP + ProbeSig context unions: toDataURL | toBlob | Worker', () => {
    expect(SOURCE).toMatch(/export type AfpContext = 'toDataURL' \| 'toBlob' \| 'Worker';/);
    expect(SOURCE).toMatch(/export type ProbeSigContext = 'toDataURL' \| 'toBlob' \| 'Worker';/);
  });

  it('hook-tag union: 7 V-tags (V185 / V184 / V241 / V166-DASA / V374 / V375 / V186)', () => {
    expect(SOURCE).toMatch(
      /export type HookTag =\s*\|?\s*'V185'\s*\|\s*'V184'\s*\|\s*'V241'\s*\|\s*'V166-DASA'\s*\|\s*'V374'\s*\|\s*'V375'\s*\|\s*'V186';/,
    );
  });

  it('spoofing-status union: active | partial | inactive', () => {
    expect(SOURCE).toMatch(/export type SpoofingStatus = 'active' \| 'partial' \| 'inactive';/);
  });

  it('RX_V510_HIT regex: [Driftstack-V510-HIT] slot=(main|priority)', () => {
    expect(SOURCE).toMatch(
      /RX_V510_HIT = \/\\\[Driftstack-V510-HIT\\\] slot=\(main\|priority\)\\b\//,
    );
  });

  it('RX_ATLAS_MAPPED regex: V510Atlas[slot]: mapped bytes from path; N entries; format=vV; file_mtime=T', () => {
    expect(SOURCE).toMatch(/RX_ATLAS_MAPPED =/);
    expect(SOURCE).toMatch(/V510Atlas\\\[\(main\|priority\)\\\]: mapped/);
    expect(SOURCE).toMatch(/entries; format=/);
    expect(SOURCE).toMatch(/file_mtime=/);
  });

  it('RX_ATLAS_NOT_PRESENT regex: V510Atlas[slot]: not present at path — disabled', () => {
    expect(SOURCE).toMatch(/RX_ATLAS_NOT_PRESENT =/);
    expect(SOURCE).toMatch(
      /V510Atlas\\\[\(main\|priority\)\\\]: not present at \(\\S\+\) — disabled/,
    );
  });

  it('RX_AFP_FALLBACK regex: [Driftstack-W29399-S1-AFP-Fallback-Fired] context=(toDataURL|toBlob|Worker)', () => {
    expect(SOURCE).toMatch(
      /RX_AFP_FALLBACK =\s*\/\\\[Driftstack-W29399-S1-AFP-Fallback-Fired\\\] context=\(toDataURL\|toBlob\|Worker\)\\b\//,
    );
  });

  it('RX_PROBE_SIG regex: [Driftstack-W29399-S2-ProbeSig-(toDataURL|toBlob|Worker)', () => {
    expect(SOURCE).toMatch(
      /RX_PROBE_SIG = \/\\\[Driftstack-W29399-S2-ProbeSig-\(toDataURL\|toBlob\|Worker\)\\b\//,
    );
  });

  it('RX_HOOK regex: [Driftstack-(V185|V184|V241|V166-DASA|V374|V375|V186)]', () => {
    expect(SOURCE).toMatch(
      /RX_HOOK = \/\\\[Driftstack-\(V185\|V184\|V241\|V166-DASA\|V374\|V375\|V186\)\\\]\//,
    );
  });

  it('RX_ARCHETYPE_INIT regex: [Driftstack-Archetype-Init] archetype=(\\S+)', () => {
    expect(SOURCE).toMatch(
      /RX_ARCHETYPE_INIT = \/\\\[Driftstack-Archetype-Init\\\] archetype=\(\\S\+\)\//,
    );
  });

  it('public surface: applyEventLine + reduceEventStream + deriveSpoofingStatus + emptySessionTelemetryState', () => {
    expect(SOURCE).toMatch(/export function applyEventLine\(/);
    expect(SOURCE).toMatch(/export function reduceEventStream\(/);
    expect(SOURCE).toMatch(/export function deriveSpoofingStatus\(/);
    expect(SOURCE).toMatch(/export function emptySessionTelemetryState\(\)/);
  });

  it('deriveSpoofingStatus rubric: active = any V510/hook/AFP/probe; partial = atlas loaded only; inactive = nothing', () => {
    expect(SOURCE).toMatch(/anyV510Hits/);
    expect(SOURCE).toMatch(/anyHookFires/);
    expect(SOURCE).toMatch(/anyAfp/);
    expect(SOURCE).toMatch(/anyProbeSig/);
    expect(SOURCE).toMatch(/return 'active';/);
    expect(SOURCE).toMatch(/return 'partial';/);
    expect(SOURCE).toMatch(/return 'inactive';/);
  });
});
