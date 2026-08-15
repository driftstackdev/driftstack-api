// W430.C — drift guard for apps/server/src/schemas/gui-input.ts.
// GUI control-plane coordinate primitives — L-001 server-internal
// schema. Drift here is a posture violation: coordinate-level
// mechanics must NEVER leak into the customer-facing
// @driftstack/api-types surface (the human's own cadence IS the
// behavioral simulation; bypassing automation simulation is correct
// for this surface only).
//
//   • L-001 framing pinned: server-internal only; never on
//     @driftstack/api-types; human-cadence rationale.
//   • Endpoint pinned: POST /v1/sessions/:id/gui-input + gui_control
//     scope, which no broad scope satisfies (V-788 retracted the
//     enterprise-only half of this framing).
//   • GUIInputActionSchema: discriminated-union (tap_at + type_focused).
//   • tap_at: x/y int min 0 (viewport pixels, origin top-left).
//   • type_focused: text max 10_000 + optional delay_ms int 0..500
//     (focused element, no selector; pairs with tap_at).
//   • GUIInputRequestSchema: action + optional timeout_ms 100..60_000.
//   • GUIInputResponseSchema: { ok: true, duration_ms: int>=0 } —
//     mirrors InteractResponse so client handling is identical.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/schemas/gui-input.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W430.C apps/server/src/schemas/gui-input.ts content parity', () => {
  const body = read(LIB);

  it('L-001 framing pinned: GUI control plane — coordinate primitives for the manual-control GUI', () => {
    expect(body).toMatch(
      /\/\/ GUI control plane — coordinate primitives for the manual-control GUI\./,
    );
  });

  it('Server-internal posture pinned: never appears on @driftstack/api-types per L-001; human-cadence-is-behavioral-simulation rationale (bypassing automation simulation is correct, not a regression)', () => {
    expect(body).toMatch(
      /\/\/ This schema is \*\*server-internal only\*\*\. Per L-001\s*\n?\s*\/\/ \(docs\/locked-decisions\.md\), coordinate-level mechanics never appear\s*\n?\s*\/\/ on the customer-facing surface \(`@driftstack\/api-types`\)\./,
    );
    expect(body).toMatch(
      /The GUI's\s*\n?\s*\/\/ live viewport — where a human is literally clicking pixels in a\s*\n?\s*\/\/ screenshot — has a different stealth posture from automation: the\s*\n?\s*\/\/ human's own cadence IS the behavioral simulation, so bypassing the\s*\n?\s*\/\/ automation simulation layer is correct, not a regression\./,
    );
  });

  it('Endpoint + scope posture pinned: POST /v1/sessions/:id/gui-input + the gui_control scope, which no broad scope satisfies. V-788 RETRACTED "only keys minted for the self-hosted GUI workflow (enterprise tier) get it" — false, since ELEVATED_SCOPES withholds only admin + driftstack_internal_admin and any account_owner on an apiAccess tier may request the scope.', () => {
    expect(body).toMatch(
      /\/\/ Endpoint: POST \/v1\/sessions\/:id\/gui-input\.\s*\n?\s*\/\/ Auth: requires the `gui_control` scope\. No broad scope satisfies it, so\s*\n?\s*\/\/ a key only carries it when the mint request asks for it explicitly\./,
    );
    expect(body, 'the retracted enterprise-only claim must not return').not.toMatch(
      /workflow \(enterprise tier\) get it\./,
    );
    expect(body).toMatch(/V-788 — the second half of this sentence used to read "only keys minted/);
  });

  it('GUIInputActionSchema discriminated-union on kind: tap_at (x/y int min 0 viewport pixels origin top-left) + type_focused (text max 10_000 + optional delay_ms 0..500); GUIInputAction type inferred', () => {
    expect(body).toMatch(/export const GUIInputActionSchema = z\.discriminatedUnion\('kind', \[/);
    expect(body).toMatch(
      /\/\/ Tap at viewport pixel coordinates \(origin top-left\)\.\s*\n?\s*z\.object\(\{\s*\n?\s*kind: z\.literal\('tap_at'\),\s*\n?\s*x: z\.number\(\)\.int\(\)\.min\(0\),\s*\n?\s*y: z\.number\(\)\.int\(\)\.min\(0\),\s*\n?\s*\}\),/,
    );
    expect(body).toMatch(
      /\/\/ Type into the currently-focused element \(no selector\)\. Pairs with\s*\n?\s*\/\/ tap_at — tap focuses, type_focused enters text\./,
    );
    expect(body).toMatch(
      /z\.object\(\{\s*\n?\s*kind: z\.literal\('type_focused'\),\s*\n?\s*text: z\.string\(\)\.max\(10_000\),\s*\n?\s*delay_ms: z\.number\(\)\.int\(\)\.min\(0\)\.max\(500\)\.optional\(\),\s*\n?\s*\}\),/,
    );
    expect(body).toMatch(/export type GUIInputAction = z\.infer<typeof GUIInputActionSchema>;/);
  });

  it('GUIInputRequestSchema: action + optional timeout_ms 100..60_000; GUIInputRequest type inferred', () => {
    expect(body).toMatch(
      /export const GUIInputRequestSchema = z\.object\(\{\s*\n?\s*action: GUIInputActionSchema,\s*\n?\s*timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(60_000\)\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/export type GUIInputRequest = z\.infer<typeof GUIInputRequestSchema>;/);
  });

  it('GUIInputResponseSchema mirrors InteractResponse: { ok: true literal, duration_ms: int>=0 }; client-handling-identical rationale', () => {
    expect(body).toMatch(
      /\/\/ The response shape mirrors InteractResponse — we keep it identical\s*\n?\s*\/\/ so the client-side handling is the same\./,
    );
    expect(body).toMatch(
      /export const GUIInputResponseSchema = z\.object\(\{\s*\n?\s*ok: z\.literal\(true\),\s*\n?\s*duration_ms: z\.number\(\)\.int\(\)\.nonnegative\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/export type GUIInputResponse = z\.infer<typeof GUIInputResponseSchema>;/);
  });

  it("imports: only z from 'zod' (no api-types dependency — L-001 server-internal posture)", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).not.toMatch(/from '@driftstack\/api-types'/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
