// W983 — gui-input L-001 schemas cross-source invariant. Three-
// hundred-ninth in the drift-guard series. Pins the apps/server/src/
// schemas/gui-input.ts manual-control GUI coordinate-input primitive:
//
//   L-001 server-internal framing — 'GUI control plane — coordinate
//   primitives for the manual-control GUI. This schema is **server-
//   internal only**. Per L-001 (docs/locked-decisions.md),
//   coordinate-level mechanics never appear on the customer-facing
//   surface (@driftstack/api-types). The GUI's live viewport — where
//   a human is literally clicking pixels in a screenshot — has a
//   different stealth posture from automation: the human's own
//   cadence IS the behavioral simulation, so bypassing the
//   automation simulation layer is correct, not a regression'.
//
//   Endpoint framing — 'Endpoint: POST /v1/sessions/:id/gui-input.
//   Auth: requires the gui_control scope, which no broad scope satisfies.
//   (V-788: this header used to add "only keys minted for the self-hosted GUI
//   workflow (enterprise tier) get it" — false; any account_owner may ask.)
//
//   GUIInputActionSchema discriminated union on 'kind' with 2 variants:
//     - 'tap_at' with x, y (int ≥ 0).
//     - 'type_focused' with text (≤10_000 chars) + optional delay_ms
//       (int 0-500).
//
//   GUIInputRequestSchema — action + optional timeout_ms (int 100-
//     60_000).
//
//   GUIInputResponseSchema — ok: true + duration_ms (int ≥ 0).
//
//   Response framing — 'The response shape mirrors InteractResponse —
//   we keep it identical so the client-side handling is the same'.
//
// stays in lockstep across apps/server/src/schemas/gui-input.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GUIInputActionSchema,
  GUIInputRequestSchema,
  GUIInputResponseSchema,
} from '../../src/schemas/gui-input.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W983 gui-input L-001 schemas cross-source invariant', () => {
  // ─── L-001 server-internal framing ───────────────────────────

  it("CRITICAL apps/server/src/schemas/gui-input.ts header pins L-001 framing — 'GUI control plane — coordinate primitives for the manual-control GUI. This schema is **server-internal only**. Per L-001 (docs/locked-decisions.md), coordinate-level mechanics never appear on the customer-facing surface (@driftstack/api-types). The GUI's live viewport — where a human is literally clicking pixels in a screenshot — has a different stealth posture from automation: the human's own cadence IS the behavioral simulation, so bypassing the automation simulation layer is correct, not a regression'. The server-internal + L-001 + human-cadence-IS-simulation design is the GUI-vs-automation stealth contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts'));
    expect(p).toMatch(/GUI control plane — coordinate primitives for the manual-control GUI\./);
    expect(p).toMatch(/This schema is \*\*server-internal only\*\*\. Per L-001/);
    expect(p).toMatch(/\(docs\/locked-decisions\.md\), coordinate-level mechanics never appear/);
    expect(p).toMatch(/on the customer-facing surface \(`@driftstack\/api-types`\)\. The GUI's/);
    expect(p).toMatch(/live viewport — where a human is literally clicking pixels in a/);
    expect(p).toMatch(/screenshot — has a different stealth posture from automation: the/);
    expect(p).toMatch(/human's own cadence IS the behavioral simulation, so bypassing the/);
    expect(p).toMatch(/automation simulation layer is correct, not a regression\./);
  });

  // ─── Endpoint + scope framing ────────────────────────────────

  it("CRITICAL endpoint + scope framing. V-788 REPLACED the second half of this: 'only keys minted for the self-hosted GUI workflow (enterprise tier) get it' was false — ELEVATED_SCOPES withholds only admin + driftstack_internal_admin, so any account_owner on an apiAccess tier can request the scope. The 'no broad scope satisfies it' half is the part that is actually enforced, and it is asserted here plus derived from the code in gui-control-is-a-scope-boundary-not-a-tier-one.test.ts.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts'));
    expect(p).toMatch(/Endpoint: POST \/v1\/sessions\/:id\/gui-input\./);
    expect(p).toMatch(
      /Auth: requires the `gui_control` scope\. No broad scope satisfies it, so\s*\/\/ a key only carries it when the mint request asks for it explicitly\./,
    );
    expect(p).toMatch(/V-788 — the second half of this sentence used to read/);
    // Per-occurrence negatives on the retracted half.
    expect(p, 'the enterprise-only claim must not return').not.toMatch(
      /only keys minted for the self-hosted GUI\s*\/\/ workflow \(enterprise tier\) get it\./,
    );
  });

  // ─── GUIInputActionSchema discriminated union ────────────────

  it("CRITICAL GUIInputActionSchema is a discriminatedUnion on 'kind'. The discriminated-union design lets the route handler dispatch on action.kind without type-narrowing dance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts'));
    expect(p).toMatch(/export const GUIInputActionSchema = z\.discriminatedUnion\('kind', \[/);
  });

  // ─── tap_at variant ──────────────────────────────────────────

  it("CRITICAL tap_at variant framing — 'Tap at viewport pixel coordinates (origin top-left)'. The top-left-origin design matches the screenshot pixel-space.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts'));
    expect(p).toMatch(/\/\/ Tap at viewport pixel coordinates \(origin top-left\)\./);
    expect(p).toMatch(/kind: z\.literal\('tap_at'\),/);
    expect(p).toMatch(/x: z\.number\(\)\.int\(\)\.min\(0\),/);
    expect(p).toMatch(/y: z\.number\(\)\.int\(\)\.min\(0\),/);
  });

  // ─── type_focused variant ────────────────────────────────────

  it("CRITICAL type_focused variant framing — 'Type into the currently-focused element (no selector). Pairs with tap_at — tap focuses, type_focused enters text'. The no-selector + paired-with-tap design is what makes the GUI's tap-then-type flow ergonomic.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts'));
    expect(p).toMatch(/\/\/ Type into the currently-focused element \(no selector\)\. Pairs with/);
    expect(p).toMatch(/\/\/ tap_at — tap focuses, type_focused enters text\./);
    expect(p).toMatch(/kind: z\.literal\('type_focused'\),/);
  });

  it('CRITICAL type_focused text capped at 10_000 chars. The 10k cap prevents single-request payload bombs through the text path.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts'));
    expect(p).toMatch(/text: z\.string\(\)\.max\(10_000\),/);
  });

  it('CRITICAL delay_ms is optional int 0-500. The 500ms ceiling caps per-character pacing without surfacing pacing as a primary UI knob.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts'));
    expect(p).toMatch(/delay_ms: z\.number\(\)\.int\(\)\.min\(0\)\.max\(500\)\.optional\(\),/);
  });

  // ─── GUIInputRequestSchema ───────────────────────────────────

  it('CRITICAL GUIInputRequestSchema has action (action union) + optional timeout_ms (int 100-60_000). The 60_000ms ceiling matches the V-666 longest-operation budget.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts'));
    expect(p).toMatch(/export const GUIInputRequestSchema = z\.object\(\{/);
    expect(p).toMatch(/action: GUIInputActionSchema,/);
    expect(p).toMatch(
      /timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(60_000\)\.optional\(\),/,
    );
  });

  // ─── GUIInputResponseSchema ──────────────────────────────────

  it("CRITICAL response framing — 'The response shape mirrors InteractResponse — we keep it identical so the client-side handling is the same'. The mirror-InteractResponse design lets the GUI client share parsing code with automation.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts'));
    expect(p).toMatch(/The response shape mirrors InteractResponse — we keep it identical/);
    expect(p).toMatch(/so the client-side handling is the same\./);
  });

  it('CRITICAL GUIInputResponseSchema has 2 fields — ok: literal(true) + duration_ms: int >=0. The 2-field shape matches the automation InteractResponse exactly.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts'));
    expect(p).toMatch(/export const GUIInputResponseSchema = z\.object\(\{/);
    expect(p).toMatch(/ok: z\.literal\(true\),/);
    expect(p).toMatch(/duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),/);
  });

  // ─── Runtime — schema parse matrix ───────────────────────────

  it('CRITICAL runtime — GUIInputActionSchema parses tap_at with x/y >=0.', () => {
    expect(GUIInputActionSchema.parse({ kind: 'tap_at', x: 100, y: 200 })).toEqual({
      kind: 'tap_at',
      x: 100,
      y: 200,
    });
  });

  it('CRITICAL runtime — GUIInputActionSchema rejects negative x/y in tap_at. The min(0) guard prevents inverted-axis bugs from leaking to the renderer.', () => {
    expect(() => GUIInputActionSchema.parse({ kind: 'tap_at', x: -1, y: 0 })).toThrow();
    expect(() => GUIInputActionSchema.parse({ kind: 'tap_at', x: 0, y: -1 })).toThrow();
  });

  it('CRITICAL runtime — GUIInputActionSchema rejects non-int x/y. The .int() guard enforces pixel-grid alignment.', () => {
    expect(() => GUIInputActionSchema.parse({ kind: 'tap_at', x: 0.5, y: 0 })).toThrow();
  });

  it('CRITICAL runtime — GUIInputActionSchema parses type_focused with valid text + optional delay_ms.', () => {
    expect(GUIInputActionSchema.parse({ kind: 'type_focused', text: 'hello' })).toEqual({
      kind: 'type_focused',
      text: 'hello',
    });
    expect(GUIInputActionSchema.parse({ kind: 'type_focused', text: 'a', delay_ms: 100 })).toEqual({
      kind: 'type_focused',
      text: 'a',
      delay_ms: 100,
    });
  });

  it('CRITICAL runtime — GUIInputActionSchema rejects 10_001-char text + delay_ms > 500. The caps prevent oversize payloads + unbounded pacing.', () => {
    expect(() =>
      GUIInputActionSchema.parse({ kind: 'type_focused', text: 'a'.repeat(10_001) }),
    ).toThrow();
    expect(() =>
      GUIInputActionSchema.parse({ kind: 'type_focused', text: 'a', delay_ms: 501 }),
    ).toThrow();
  });

  it('CRITICAL runtime — GUIInputRequestSchema rejects timeout_ms < 100 or > 60_000. The [100, 60_000] window matches V-666 longest-op budget.', () => {
    const tap = { kind: 'tap_at', x: 0, y: 0 } as const;
    expect(() => GUIInputRequestSchema.parse({ action: tap, timeout_ms: 99 })).toThrow();
    expect(() => GUIInputRequestSchema.parse({ action: tap, timeout_ms: 60_001 })).toThrow();
    expect(GUIInputRequestSchema.parse({ action: tap, timeout_ms: 5000 })).toBeTruthy();
  });

  it('CRITICAL runtime — GUIInputResponseSchema rejects ok:false. The z.literal(true) is what makes the shape always-true.', () => {
    expect(() => GUIInputResponseSchema.parse({ ok: false, duration_ms: 0 })).toThrow();
    expect(GUIInputResponseSchema.parse({ ok: true, duration_ms: 42 })).toEqual({
      ok: true,
      duration_ms: 42,
    });
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/gui-input-l001-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
