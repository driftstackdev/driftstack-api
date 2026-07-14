// Cross-source invariant — the BYOK Anthropic key convenience layer
// is now shipped across all 3 SDKs (TS opts.byokApiKey + Python
// byok_api_key kwarg + Go *MessageOptions{ByokAPIKey}). All three
// language-idiomatic shapes MUST forward as the same HTTP header
// name (`x-byok-anthropic-api-key`) on the same route
// (`/v1/agent-sessions/{id}/message`), because the server reads ONE
// header (apps/server/src/routes/agent-sessions.ts handler) — drift
// on any SDK's header name would silently send the customer's key
// to a header the server ignores, and the customer would be billed
// against the deployment fallback key instead of their own.
//
// This invariant catches:
// - Header-name drift on any SDK (e.g. someone renames to
//   `x-driftstack-byok-key` or `anthropic-api-key`).
// - Opt-name drift that would break documentation parity (TS
//   docs say `opts.byokApiKey`; Python says `byok_api_key`; Go
//   says `MessageOptions.ByokAPIKey`).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const HEADER_NAME = 'x-byok-anthropic-api-key';

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('cross-SDK BYOK Anthropic header invariant', () => {
  const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts');
  const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/agent_sessions.py');
  const GO = resolve(REPO_ROOT, 'packages/sdk-go/agent_sessions.go');

  it('all 3 SDK resource files exist', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  it(`all 3 SDKs forward the BYOK key on the same header name: "${HEADER_NAME}". Drift would silently route the customer's key to a header the server ignores (apps/server/src/routes/agent-sessions.ts reads this exact name), and the customer's traffic would fall through to the deployment fallback key`, () => {
    expect(read(TS), 'TS header').toContain(`'${HEADER_NAME}'`);
    expect(read(PY), 'Py header').toContain(`"${HEADER_NAME}"`);
    expect(read(GO), 'Go header').toContain(`"${HEADER_NAME}"`);
  });

  it('TS exposes the opt as `opts.byokApiKey` (matches the SDK docs + sample-code example)', () => {
    const ts = read(TS);
    // message()'s opts gained `approveConsequentialActions` (AI-chat S5), so the
    // opts object is now multi-line; pin that byokApiKey is still a field on it.
    expect(ts).toMatch(/opts\?: \{[\s\S]*?byokApiKey\?: string;/);
    expect(ts).toMatch(/opts\?\.byokApiKey/);
  });

  it('Python exposes the kwarg as `byok_api_key` (snake_case per PEP 8; matches the Python SDK docs)', () => {
    const py = read(PY);
    expect(py).toMatch(/byok_api_key: str \| None = None/);
  });

  it('Go exposes the option as `MessageOptions.ByokAPIKey` (PascalCase per Go style; matches the Go SDK docs + example)', () => {
    const go = read(GO);
    expect(go).toMatch(/type MessageOptions struct \{[\s\S]*?ByokAPIKey\s+string/);
  });

  it('server-side route reads the same header name (apps/server/src/routes/agent-sessions.ts) — closes the loop end-to-end', () => {
    const routes = read(resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts'));
    expect(routes).toContain(`'${HEADER_NAME}'`);
  });

  it('the server-side route uses Tier-3-BYOK framing (2026-05-16 LOCKED) so the comment lineage stays load-bearing — drift to dropping the LOCK reference is a signal the team forgot why the surface exists', () => {
    const routes = read(resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts'));
    expect(routes).toMatch(/BYOK[\s\S]{0,100}Tier-3 LOCKED 2026-05-16/);
  });

  it('all 3 SDKs skip the BYOK header when the customer-supplied key is empty (cross-SDK parity per slice 106). Sending an empty header wastes bytes + would have triggered the slice 105 server-side empty-string normalisation that exists as a safety net', () => {
    // Go's shape was always correct: `opts != nil && opts.ByokAPIKey != ""`.
    // TS + Python initially diverged (only-undefined / only-None
    // checks); slice 106 aligned them. Pin all 3 to lock the parity.
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);
    // TS: `opts?.byokApiKey !== undefined && opts.byokApiKey.length > 0`
    expect(ts).toMatch(/opts\?\.byokApiKey !== undefined && opts\.byokApiKey\.length > 0/);
    // Python: sync + async each use a truthy check (None + '' both skip
    // insertion) while sharing one map with the optional idempotency header.
    expect(
      py.match(
        /if byok_api_key:\s*\n\s*extra_headers\["x-byok-anthropic-api-key"\] = byok_api_key/g,
      ),
    ).toHaveLength(2);
    expect(py.match(/extra_headers=extra_headers or None/g)).toHaveLength(2);
    // Go: the option envelope is checked once, then the shared header map
    // receives BYOK only when nonempty (alongside optional idempotency).
    expect(go).toMatch(
      /if opts != nil \{[\s\S]*?headers := map\[string\]string\{\}[\s\S]*?if opts\.ByokAPIKey != "" \{\s*headers\["x-byok-anthropic-api-key"\] = opts\.ByokAPIKey/,
    );
    // Drift-guards on the previous laxer forms (TS undefined-only check + Python None-only check).
    expect(ts).not.toMatch(/^\s*\.\.\.\(opts\?\.byokApiKey !== undefined$\s*\?/m);
    expect(py).not.toMatch(/if byok_api_key is not None else None/);
  });

  it(`OpenAPI spec documents the ${HEADER_NAME} request header on /v1/agent-sessions/{id}/message — SDK code generators that read the OpenAPI surface must learn about the BYOK header, not just the 3 hand-written SDKs in this repo`, () => {
    const openapi = read(resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts'));
    // The /v1/agent-sessions/{id}/message route entry must list the
    // header. Slice from the route path to the next registerRoute
    // boundary so we don't accidentally match a different route's
    // header section.
    const routeIdx = openapi.indexOf("path: '/v1/agent-sessions/{id}/message'");
    expect(routeIdx, 'message route not registered in openapi.ts').toBeGreaterThan(-1);
    const tail = openapi.slice(routeIdx);
    const sectionEnd = tail.indexOf('registerRoute(', 1);
    const section = sectionEnd === -1 ? tail : tail.slice(0, sectionEnd);
    expect(section).toContain(`'${HEADER_NAME}'`);
  });
});
