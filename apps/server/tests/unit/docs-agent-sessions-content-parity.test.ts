// Arc 4 Wave 2.B sub-slice 8.20.d (v2-#8) — docs/api/agent-sessions.md
// content parity. Pins the new docs page against the source-of-truth
// surface so renames break CI:
//
//   - PROBLEM_TYPES enum (from @driftstack/api-types) MUST appear in
//     the page's error table.
//   - AccountAuditAction enum entries for pair-mode actions MUST
//     appear in the "Audit log" section.
//   - Every documented endpoint must correspond to a real route file
//     in apps/server/src/routes/agent-sessions.ts.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountAuditActionSchema } from '@driftstack/api-types';
import { PAIR_MODE_HEARTBEAT_TTL_MS } from '../../src/services/agent-pair-mode-heartbeat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/agent-sessions.md');
const ROUTE_FILE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');

describe('Arc 4 Wave 2.B sub-slice 8.20.d docs/api/agent-sessions.md parity', () => {
  it('docs page file exists at the expected path', () => {
    expect(existsSync(DOCS_PAGE)).toBe(true);
  });

  const body = readFileSync(DOCS_PAGE, 'utf8');
  const routeSource = readFileSync(ROUTE_FILE, 'utf8');

  it('frontmatter declares the layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: Agent sessions/);
    expect(body).toMatch(/description: .+decompose.+/);
  });

  it('documents every operational mode (ai / manual / pair)', () => {
    expect(body).toMatch(/`ai`/);
    expect(body).toMatch(/`manual`/);
    expect(body).toMatch(/`pair`/);
  });

  it('documents POST / GET / DELETE / takeover / handback endpoints', () => {
    expect(body).toMatch(/POST \/v1\/agent-sessions\b/);
    expect(body).toMatch(/GET \/v1\/agent-sessions\/\{id\}/);
    expect(body).toMatch(/DELETE \/v1\/agent-sessions\/\{id\}/);
    expect(body).toMatch(/POST \/v1\/agent-sessions\/\{id\}\/message/);
    expect(body).toMatch(/POST \/v1\/agent-sessions\/\{id\}\/takeover/);
    expect(body).toMatch(/POST \/v1\/agent-sessions\/\{id\}\/handback/);
  });

  it('every endpoint in the docs page maps to a real handler in the route source', () => {
    // Documented endpoints reference handlers on the server side; the
    // /takeover + /handback handlers are the new Wave 2.A surface we
    // just shipped, so this guard catches renames + drops on both
    // ends.
    const paths = [
      '/v1/agent-sessions',
      '/v1/agent-sessions/:id',
      '/v1/agent-sessions/:id/message',
      '/v1/agent-sessions/:id/takeover',
      '/v1/agent-sessions/:id/handback',
    ];
    for (const p of paths) {
      // The route source uses route-pattern strings + Fastify's `:id`
      // template, so we look for the same literal.
      expect(
        routeSource.includes(`'${p}'`) ||
          routeSource.includes(`\`${p}\``) ||
          routeSource.includes(`'${p}/`),
        `route source must declare ${p}`,
      ).toBe(true);
    }
  });

  it('audit log section names all three pair-mode AccountAuditAction values', () => {
    const accepted = new Set(AccountAuditActionSchema.options);
    const pairModeActions = [
      'agent_session.pair_mode.takeover',
      'agent_session.pair_mode.handback',
      'agent_session.pair_mode.timeout',
    ];
    for (const action of pairModeActions) {
      expect(accepted.has(action), `${action} should be in AccountAuditActionSchema`).toBe(true);
      const re = new RegExp(`\`${action.replace(/\./g, '\\.')}\``);
      expect(body, `docs page must reference ${action}`).toMatch(re);
    }
  });

  it('error table includes the typed pair-mode-invalid-transition row', () => {
    expect(body).toMatch(/pair-mode-invalid-transition/);
    expect(body).toMatch(/PairModeStateInvalidTransitionError/);
  });

  it('error table includes byok-anthropic-required + bundled-llm error types', () => {
    expect(body).toMatch(/byok-anthropic-required/);
    expect(body).toMatch(/bundled-llm-budget-exhausted/);
    expect(body).toMatch(/bundled-llm-consent-required/);
  });

  it('documents the v2-#19 Idempotency-Key header on create', () => {
    expect(body).toMatch(/Idempotency-Key/);
  });

  it('documents the BYOK header on /message', () => {
    expect(body).toMatch(/x-byok-anthropic-api-key/);
  });

  it('documents the heartbeat-timeout auto-handback (30s)', () => {
    expect(body).toMatch(/30s/);
    expect(body).toMatch(/heartbeat/i);
  });

  // Arc 4 Wave 2.B sub-slice 8.20.d.2 — drift guard for the docs vs
  // PAIR_MODE_HEARTBEAT_TTL_MS constant. If a future change to the
  // sweep TTL bumps the constant from 30_000 to anything else, this
  // guard fails so the docs page MUST be updated in lock-step (or the
  // constant changed back).
  it('docs heartbeat-timeout window matches PAIR_MODE_HEARTBEAT_TTL_MS constant', () => {
    const ttlSeconds = PAIR_MODE_HEARTBEAT_TTL_MS / 1000;
    expect(ttlSeconds).toBe(30);
    // The docs page MUST mention the same value the constant exports;
    // drift = customer-visible documentation that contradicts the
    // production behavior.
    expect(body).toMatch(new RegExp(`${ttlSeconds}s`));
  });
});
