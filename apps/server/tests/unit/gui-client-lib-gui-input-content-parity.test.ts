// W464.C — drift guard for apps/gui-client/src/lib/gui-input.ts.
// L-001 gui-control endpoint client. Drift here either leaks
// coordinate-level primitives into shared types (L-001 says they
// must NOT appear on the customer SDK surface — a shared type
// import would put them in the customer SDK build graph) or breaks
// the auth-missing pre-check (request reaches the server with
// empty Bearer header and the gui_control scope check rejects
// with a confusing 401 instead of a clear 'API key not configured').
//
//   • L-001 framing pinned: 'GUI control plane — thin client for
//     /v1/sessions/:id/gui-input.' + 'coordinate-level primitives
//     don't appear on the customer SDK surface. The self-hosted
//     GUI talks to a separate, scope-gated endpoint via this
//     helper. The wire shape matches the server's
//     GUIInputActionSchema exactly; we don't share types because
//     the server schema is internal-only.'
//   • Auth framing pinned: 'Auth: requires the API key to carry
//     the gui_control scope. Mutates the session via the same
//     WebKit driver as /interact does, just on the gui-control
//     branch.'
//   • GUIInputAction 2-variant tagged union (kind:'tap_at' x+y
//     + kind:'type_focused' text + optional delay_ms).
//   • GUIInputResponse: { ok: true; duration_ms: number }.
//   • GUIInputError class: extends Error + readonly status: number
//     + readonly kind: string + this.name = 'GUIInputError'.
//   • sendGUIInput: empty/null apiKey → throw GUIInputError
//     'API key not configured', status:0, kind:'auth_missing';
//     trailing-slash strip on baseUrl; encodeURIComponent(sessionId);
//     Authorization Bearer + Content-Type JSON.
//   • Error parsing: detail = body.detail ?? body.title ?? detail;
//     kind = body.type.split('/').pop() ?? 'unknown'.
//   • RFC 7807 type-URI framing pinned: 'Server emits RFC 7807
//     `type` URIs like "https://errors.driftstack.dev/forbidden".'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/gui-input.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W464.C apps/gui-client/src/lib/gui-input.ts content parity', () => {
  const body = read(LIB);

  it("L-001 framing pinned: 'GUI control plane — thin client for /v1/sessions/:id/gui-input.' + 'Per L-001 (docs/locked-decisions.md), coordinate-level primitives don't appear on the customer SDK surface. The self-hosted GUI talks to a separate, scope-gated endpoint via this helper. The wire shape matches the server's GUIInputActionSchema exactly; we don't share types because the server schema is internal-only.'", () => {
    expect(body).toMatch(
      /\/\/ GUI control plane — thin client for `\/v1\/sessions\/:id\/gui-input`\./,
    );
    expect(body).toMatch(
      /\/\/ Per L-001 \(docs\/locked-decisions\.md\), coordinate-level primitives\s*\n?\s*\/\/ don't appear on the customer SDK surface\. The self-hosted GUI talks\s*\n?\s*\/\/ to a separate, scope-gated endpoint via this helper\. The wire shape\s*\n?\s*\/\/ matches the server's `GUIInputActionSchema` exactly; we don't share\s*\n?\s*\/\/ types because the server schema is internal-only\./,
    );
  });

  it("Auth framing pinned: 'Auth: requires the API key to carry the gui_control scope. Mutates the session via the same WebKit driver as /interact does, just on the gui-control branch.'", () => {
    expect(body).toMatch(
      /\/\/ Auth: requires the API key to carry the `gui_control` scope\.\s*\n?\s*\/\/ Mutates the session via the same WebKit driver as `\/interact` does,\s*\n?\s*\/\/ just on the gui-control branch\./,
    );
  });

  it("GUIInputAction 2-variant tagged union: { kind:'tap_at'; x: number; y: number } + { kind:'type_focused'; text: string; delay_ms?: number }", () => {
    expect(body).toMatch(
      /export type GUIInputAction =\s*\n?\s*\| \{ kind: 'tap_at'; x: number; y: number \}\s*\n?\s*\| \{ kind: 'type_focused'; text: string; delay_ms\?: number \};/,
    );
  });

  it('GUIInputResponse: { ok: true (literal-true); duration_ms: number }', () => {
    expect(body).toMatch(
      /export interface GUIInputResponse \{\s*\n?\s*ok: true;\s*\n?\s*duration_ms: number;\s*\n?\s*\}/,
    );
  });

  it("GUIInputError class: extends Error + readonly status: number + readonly kind: string + super(message) + this.name = 'GUIInputError'", () => {
    expect(body).toMatch(
      /export class GUIInputError extends Error \{\s*\n?\s*constructor\(\s*\n?\s*message: string,\s*\n?\s*readonly status: number,\s*\n?\s*readonly kind: string,\s*\n?\s*\) \{\s*\n?\s*super\(message\);\s*\n?\s*this\.name = 'GUIInputError';\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it("sendGUIInput: empty/null apiKey → throw GUIInputError 'API key not configured', status:0, kind:'auth_missing'", () => {
    expect(body).toMatch(
      /if \(settings\.apiKey === null \|\| settings\.apiKey\.length === 0\) \{\s*\n?\s*throw new GUIInputError\('API key not configured', 0, 'auth_missing'\);\s*\n?\s*\}/,
    );
  });

  it("Request construction: trailing-slash strip baseUrl.replace(/\\/+$/, '') + encodeURIComponent(sessionId) on URL + Authorization Bearer header + Content-Type application/json", () => {
    expect(body).toMatch(/const baseUrl = settings\.baseUrl\.replace\(\/\\\/\+\$\/, ''\);/);
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(\s*`\$\{baseUrl\}\/v1\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/gui-input`,\s*\{\s*method: 'POST',\s*headers: \{\s*'Content-Type': 'application\/json',\s*Authorization: `Bearer \$\{settings\.apiKey\}`,\s*\},\s*body: JSON\.stringify\(\{ action \}\),\s*\},\s*\);/,
    );
    expect(body).toMatch(/const GUI_INPUT_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(/signal: controller\.signal/);
  });

  it("Error-response parsing: detail = body.detail ?? body.title ?? detail (HTTP-status fallback) + kind = body.type.split('/').pop() ?? 'unknown' + RFC 7807 type-URI framing pinned 'Server emits RFC 7807 `type` URIs like \"https://errors.driftstack.dev/forbidden\".'", () => {
    expect(body).toMatch(
      /let detail = `HTTP \$\{res\.status\}`;\s*\n?\s*let kind = 'unknown';\s*\n?\s*try \{\s*\n?\s*const body = \(await res\.json\(\)\) as \{ detail\?: string; type\?: string; title\?: string \};\s*\n?\s*detail = body\.detail \?\? body\.title \?\? detail;\s*\n?\s*\/\/ Server emits RFC 7807 `type` URIs like "https:\/\/errors\.driftstack\.dev\/forbidden"\.\s*\n?\s*if \(typeof body\.type === 'string'\) kind = body\.type\.split\('\/'\)\.pop\(\) \?\? 'unknown';/,
    );
  });

  it("Catch fallback framing pinned: 'Body wasn't JSON; keep the HTTP-status fallback.' + throw GUIInputError(detail, res.status, kind) + final return cast `await res.json() as GUIInputResponse`", () => {
    expect(body).toMatch(
      /\} catch \{\s*\n?\s*\/\/ Body wasn't JSON; keep the HTTP-status fallback\.\s*\n?\s*\}\s*\n?\s*throw new GUIInputError\(detail, res\.status, kind\);/,
    );
    expect(body).toMatch(/return \(await res\.json\(\)\) as GUIInputResponse;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
