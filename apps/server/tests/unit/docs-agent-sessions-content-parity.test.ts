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

  it('documents POST / GET / DELETE / mode / input-event / takeover / handback endpoints', () => {
    expect(body).toMatch(/POST \/v1\/agent-sessions\b/);
    expect(body).toMatch(/GET \/v1\/agent-sessions\/\{id\}/);
    expect(body).toMatch(/DELETE \/v1\/agent-sessions\/\{id\}/);
    expect(body).toMatch(/POST \/v1\/agent-sessions\/\{id\}\/message/);
    expect(body).toMatch(/POST \/v1\/agent-sessions\/\{id\}\/mode/);
    expect(body).toMatch(/POST \/v1\/agent-sessions\/\{id\}\/input-event/);
    expect(body).toMatch(/POST \/v1\/agent-sessions\/\{id\}\/takeover/);
    expect(body).toMatch(/POST \/v1\/agent-sessions\/\{id\}\/handback/);
  });

  it('every endpoint in the docs page maps to a real handler in the route source', () => {
    // Documented endpoints reference handlers on the server side; the
    // /takeover + /handback handlers are the Wave 2.A surface; /mode +
    // /input-event are the Wave 29-NNN ARC 3 Slice 3 + Slice 4 surfaces.
    // This guard catches renames + drops on both ends.
    const paths = [
      '/v1/agent-sessions',
      '/v1/agent-sessions/:id',
      '/v1/agent-sessions/:id/message',
      '/v1/agent-sessions/:id/mode',
      '/v1/agent-sessions/:id/input-event',
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

  it('audit log section names all six agent-session audit actions (3 pair-mode + mode-changed + created + destroyed)', () => {
    const accepted = new Set<string>(AccountAuditActionSchema.options);
    const pairModeActions: string[] = [
      'agent_session.pair_mode.takeover',
      'agent_session.pair_mode.handback',
      'agent_session.pair_mode.timeout',
      // Slice 6 follow-up 2026-05-20 — Slice 3 /:id/mode handler audit.
      'agent_session.mode.changed',
      // Slice 6 follow-up 2026-05-20 — agent-session lifecycle audit.
      'agent_session.created',
      'agent_session.destroyed',
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

  it('error table + takeover section document pair-mode-conflict (the lock race), distinct from invalid-transition', () => {
    // The concurrent-takeover lock race returns PairModeConflictError
    // (winner_client_id), NOT PairModeStateInvalidTransitionError.
    expect(body).toMatch(/pair-mode-conflict/);
    expect(body).toMatch(/PairModeConflictError/);
    expect(body).toMatch(/winner_client_id/);
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

  // Arc 6 docs.agent-sessions.b — SSE transcript stream documented.
  it('documents the SSE transcript stream endpoint with auth fallback', () => {
    expect(body).toMatch(/GET \/v1\/agent-sessions\/\{id\}\/transcript/);
    expect(body).toMatch(/Server-Sent Events/);
    expect(body).toMatch(/ds_token/);
  });

  it('documents the transcript.entry event shape + Last-Event-ID resume semantics', () => {
    expect(body).toMatch(/transcript\.entry/);
    expect(body).toMatch(/Last-Event-ID/);
    expect(body).toMatch(/replay is exclusive/);
  });

  it('documents the transcript scope floor and sensitive-intent projection honestly', () => {
    expect(body).toMatch(/`read:sessions` scope/);
    expect(body).toMatch(/Free-text user and\s*\n?\s*operator `body` fields are returned verbatim/);
    expect(body).toMatch(/sensitive selector\)\s*\n?\s*are omitted from SSE/);
    expect(body).toMatch(/Sensitive type intents retain their selector,[\s\S]*omit `value`/);
  });

  // LK arc — Live video (LiveKit) surface documented.
  it('documents the LK.3 token-mint endpoint + 24h TTL + per-Mac signing flow', () => {
    expect(body).toMatch(/POST \/v1\/agent-sessions\/\{id\}\/livekit-token/);
    expect(body).toMatch(/24 hours/);
    expect(body).toMatch(/per-Mac/);
  });

  it('documents the 5 LiveKit join fields (ws_url + room + token + participant_identity + expires_at)', () => {
    expect(body).toMatch(/"ws_url":/);
    expect(body).toMatch(/"room":/);
    expect(body).toMatch(/"token":/);
    expect(body).toMatch(/"participant_identity":/);
    expect(body).toMatch(/"expires_at":/);
  });

  it('documents the LK.4 auto-populate-on-session-create callout', () => {
    expect(body).toMatch(/Auto-populated on session-create/);
    expect(body).toMatch(/`livekit` shape inline/);
  });

  it('documents the LK 503 error paths (no Mac yet / secret unreadable)', () => {
    expect(body).toMatch(/no Mac has registered LiveKit credentials/i);
    expect(body).toMatch(/stored Mac secret is unreadable/i);
  });

  it('documents the canSubscribe=true / canPublish=false subscriber grant set', () => {
    expect(body).toMatch(/canSubscribe:\s*true/);
    expect(body).toMatch(/canPublish:\s*false/);
  });
});
