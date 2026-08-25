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

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountAuditActionSchema } from '@driftstack/api-types';
import { PAIR_MODE_HEARTBEAT_TTL_MS } from '../../src/services/agent-pair-mode-heartbeat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOCS_PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/agent-sessions.md');
const ROUTE_FILE = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

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

  it('documents fail-closed control changes and non-replayable settled partial work', () => {
    expect(body).toMatch(/exactly one control lane/);
    expect(body).toMatch(/ai_control_unavailable: true/);
    expect(body).toMatch(/partial_results/);
    expect(body).toMatch(/Do not replay those partial steps automatically/);
    expect(body).toMatch(/manual transcript turn never reads or hashes the irrelevant/);
    expect(body).toMatch(/BYOK header is deliberately outside receipt identity/);
    expect(body).toMatch(/still replays the original terminal result/);
    expect(body).toMatch(/message's admitted control epoch changes/);
    expect(body).toMatch(/close or pause wins after model or\s*browser work has already settled/);
    expect(body).toMatch(/resume a paused session, but\s*replace a closed one/);
    expect(body).toMatch(/never as an\s*invitation to replay them in a replacement session/);
    expect(body).toMatch(/posted 10-cent included-service accounting value/);
    expect(body).toMatch(/not the upstream model's measured cost/);
    expect(body).toMatch(/optional read-back model call is recorded separately/);
    expect(body).toMatch(/not currently aggregated into this response field/);
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

  it('V-1508 CRITICAL the resume header is DECLARED in the published spec, not only described in its prose. The 200 description has always said this stream supports Last-Event-ID resume and the route has always read the header — but a description is not a parameter, and a header with no parameter has no slot in a generated client. A browser EventSource sends it unprompted; a Python or Go caller has to set it deliberately, which is exactly the caller who can only learn it from the document.', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
      paths: Record<
        string,
        Record<string, { parameters?: { name?: string; in?: string; schema?: unknown }[] }>
      >;
    };
    const params = spec.paths['/v1/agent-sessions/{id}/transcript']?.['get']?.parameters ?? [];
    const header = params.find(
      (x) => x.in === 'header' && (x.name ?? '').toLowerCase() === 'last-event-id',
    );
    expect(header, 'the transcript stream declares its Last-Event-ID request header').toBeDefined();

    // The route reads the header on this exact stream, so the declaration is
    // anchored to the reader rather than to a path string that could move.
    expect(readFileSync(ROUTE_FILE, 'utf8')).toMatch(/req\.headers\['last-event-id'\]/);
  });

  it('V-1513 CRITICAL every stream that accepts the EventSource query token declares it. `requireAuthEventSource` takes the bearer from `?ds_token=` because the browser EventSource API cannot set an Authorization header — so on the surface where SSE is actually consumed, that parameter is the ONLY way to authenticate, and it was declared on neither stream. Both docs pages show it in a code sample. The route set is derived from the preHandler rather than listed here, so a third stream adopting this auth is judged the day it lands.', () => {
    const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');
    const accepting = new Set<string>();
    for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(resolve(ROUTES, file), 'utf8');
      for (const m of src.matchAll(
        /app\.get(?:<[^(]*>)?\(\s*'(\/v1\/[^']+)'[\s\S]{0,400}?app\.requireAuthEventSource/g,
      )) {
        accepting.add(`GET ${(m[1] ?? '').replace(/:(\w+)/g, '{$1}')}`);
      }
    }
    // Reports an absence, so an empty derivation would pass having compared nothing.
    expect(accepting.size, 'routes gated by requireAuthEventSource').toBeGreaterThanOrEqual(2);

    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
      paths: Record<string, Record<string, { parameters?: { name?: string; in?: string }[] }>>;
    };
    const missing = [...accepting]
      .filter((key) => {
        const [, path] = key.split(' ');
        const params = spec.paths[path ?? '']?.['get']?.parameters ?? [];
        return !params.some((x) => x.in === 'query' && x.name === 'ds_token');
      })
      .sort();
    expect(
      missing,
      'these streams accept `?ds_token=` and the document does not declare it, so a generated ' +
        'client cannot authenticate an EventSource against them:',
    ).toEqual([]);
  });

  it('documents the transcript scope floor and sensitive-intent projection honestly', () => {
    expect(body).toMatch(/`read:sessions` scope/);
    expect(body).toMatch(/Free-text user and\s*operator `body` fields are returned verbatim/);
    expect(body).toMatch(/sensitive selector\)\s*are omitted from SSE/);
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
