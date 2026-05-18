// Drift-guard for the customer-facing 503 FeatureUnavailable detail
// strings on activation-gated routes. The detail lands in the
// problem+json body that the SDK surfaces verbatim — a customer
// hitting a 503 from the SDK before the deployment activates the
// feature sees this text as their entire actionable error message.
//
// Previously the detail said
//
//   "AI chat agent is not yet enabled on this deployment. The
//    AgentRuntime requires an LLM key path (BYOK or bundled) to be
//    configured; see the AI-CHAT design doc."
//
// which references an INTERNAL design doc — useless for the SDK
// customer who has no access to internal docs and no link to follow.
//
// This drift-guard pins:
//   - the customer-facing docs URLs for both self-serve options
//     (BYOK Anthropic + bundled-LLM)
//   - the "self-serve" framing matching the dashboard's
//     feature-unavailable banner (agent-sessions.astro lines 35-53)
//   - explicit `not.toMatch` on "AI-CHAT design doc" so the legacy
//     internal-reference text can't drift back into customer-facing
//     copy

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');

describe('agent-sessions disabled-stub 503 detail — customer-facing self-serve links', () => {
  const body = readFileSync(ROUTE, 'utf8');

  it('mentions both self-serve options (BYOK Anthropic + bundled-LLM)', () => {
    // Customer-facing options that activate the AI-chat surface.
    expect(body).toMatch(/bring your own Anthropic key/);
    expect(body).toMatch(/bundled-LLM budget/);
  });

  it('carries customer-facing docs URLs (docs.driftstack.dev/api/byok-anthropic + bundled-llm)', () => {
    // Without these URLs the SDK customer has nowhere to go — the
    // 503 problem-detail is their only signal.
    expect(body).toMatch(/https:\/\/docs\.driftstack\.dev\/api\/byok-anthropic/);
    expect(body).toMatch(/https:\/\/docs\.driftstack\.dev\/api\/bundled-llm/);
  });

  it('does NOT reference internal "AI-CHAT design doc" in the customer-facing 503 detail', () => {
    // The previous detail string sent customers to an internal doc
    // they have no access to. Drift-guard pin so this regression
    // can't slip back.
    const fnIdx = body.indexOf('registerAgentSessionsDisabledRoutes');
    expect(fnIdx).toBeGreaterThan(-1);
    const tail = body.slice(fnIdx);
    // Bound the search to the disabled-stub fn body so other
    // internal comments in the file aren't false positives.
    const fnEnd = tail.indexOf('export function', 10);
    const fnBody = fnEnd > 0 ? tail.slice(0, fnEnd) : tail;
    expect(fnBody).not.toMatch(/AI-CHAT design doc/);
  });

  it('uses the "Two self-serve options" framing matching the dashboard banner', () => {
    // The dashboard's feature-unavailable banner at
    // agent-sessions.astro:37 says "Two self-serve options:" — the
    // 503 detail should use parallel language so customers seeing
    // both surfaces get a coherent message.
    expect(body).toMatch(/Two self-serve options/);
  });
});

describe('byok-anthropic disabled-stub 503 detail — customer-facing, no internal-docs reference', () => {
  const body = readFileSync(
    resolve(REPO_ROOT, 'apps/server/src/routes/account-byok-anthropic.ts'),
    'utf8',
  );

  it('carries the customer-facing docs URL (docs.driftstack.dev/api/byok-anthropic)', () => {
    expect(body).toMatch(/https:\/\/docs\.driftstack\.dev\/api\/byok-anthropic/);
  });

  it('does NOT reference internal "docs/internal/byok-anthropic-key-storage-design" doc', () => {
    const fnIdx = body.indexOf('registerAccountByokAnthropicDisabledRoutes');
    expect(fnIdx).toBeGreaterThan(-1);
    const tail = body.slice(fnIdx);
    const fnEnd = tail.indexOf('export function', 10);
    const fnBody = fnEnd > 0 ? tail.slice(0, fnEnd) : tail;
    expect(fnBody).not.toMatch(/docs\/internal\/byok-anthropic-key-storage-design/);
  });
});

describe('saved-proxies + session-proxy disabled-stub 503 detail — no internal "planning file 133" jargon', () => {
  const SAVED = readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes/saved-proxies.ts'), 'utf8');
  const SESSION = readFileSync(
    resolve(REPO_ROOT, 'apps/server/src/routes/session-proxy.ts'),
    'utf8',
  );

  it('saved-proxies does NOT reference internal "planning file 133" in the customer-facing 503 detail', () => {
    const fnIdx = SAVED.indexOf('registerSavedProxiesDisabledRoutes');
    expect(fnIdx).toBeGreaterThan(-1);
    const tail = SAVED.slice(fnIdx);
    const fnEnd = tail.indexOf('export function', 10);
    const fnBody = fnEnd > 0 ? tail.slice(0, fnEnd) : tail;
    expect(fnBody).not.toMatch(/planning file 133/);
  });

  it('session-proxy does NOT reference internal "planning file 133" in the customer-facing 503 detail', () => {
    const fnIdx = SESSION.indexOf('registerSessionProxyDisabledRoutes');
    expect(fnIdx).toBeGreaterThan(-1);
    const tail = SESSION.slice(fnIdx);
    const fnEnd = tail.indexOf('export function', 10);
    const fnBody = fnEnd > 0 ? tail.slice(0, fnEnd) : tail;
    expect(fnBody).not.toMatch(/planning file 133/);
  });

  it('both proxy disabled-stubs surface the same customer-readable "Phase 1 SOCKS5 on the roadmap" framing', () => {
    expect(SAVED).toMatch(/Phase 1 SOCKS5 support is on the roadmap/);
    expect(SESSION).toMatch(/Phase 1 SOCKS5 support is on the roadmap/);
  });

  it("both proxy disabled-stubs tell customers that sessions route through Driftstack's default egress until activation", () => {
    // Customers reading the 503 need to know the impact: their
    // sessions still work, just not via their custom proxy yet.
    expect(SAVED).toMatch(/route through Driftstack's default egress/);
    expect(SESSION).toMatch(/route through Driftstack's default egress/);
  });
});
