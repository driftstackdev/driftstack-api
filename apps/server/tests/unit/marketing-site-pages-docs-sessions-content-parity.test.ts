// W516.B — drift guard for apps/marketing-site/src/pages/docs/sessions.astro.
// V-690 sessions developer docs + W215.C accuracy pass. Drift here
// either changes a lifecycle state (would create marketing↔server-status
// divergence) or shifts the create-response shape (would create
// marketing↔publicSession route divergence).
//
//   • V-690 doc-comment framing + W215.C 4-source-of-truth accuracy pass
//     (publicSession in routes/sessions.ts + CreateSessionRequestSchema in
//     api-types/sessions.ts + PaginationQuerySchema in api-types/common.ts +
//     webhook_event_type in db/schema.ts).
//   • 5-state LIFECYCLE: creating → ready → busy → destroyed / errored.
//   • POST /v1/sessions 4-optional-field body + 201 with flat-no-envelope.
//   • GET /v1/sessions/:id sample response with full 11-field publicSession
//     shape including last_state_at + destroyed_at nullable.
//   • GET /v1/sessions list with cursor pagination + default 50 + max 100.
//   • POST /v1/sessions/:id/navigate + url + wait_until: 'load'.
//   • POST /v1/sessions/:id/capture inline base64 + 3-kind enum (screenshot
//     / dom_snapshot / pdf).
//   • DELETE /v1/sessions/:id 204 + idempotent.
//   • Concurrency-limit RFC 7807 problem type on 429.
//   • archetype slug regex (3-60 chars, [a-z0-9_]).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sessions.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W516.B apps/marketing-site/src/pages/docs/sessions.astro content parity', () => {
  const body = read(LIB);

  it('V-690 + W215.C 4-source-file accuracy-pass framing pinned: \'Sessions API developer docs. Sibling to api-quickstart; this is the deeper "every field, every lifecycle event" reference for the /v1/sessions surface.\' + W215.C accuracy pass pinned against 4 source-of-truth files (publicSession in routes/sessions.ts + CreateSessionRequestSchema in api-types/sessions.ts + PaginationQuerySchema in api-types/common.ts + webhook_event_type in db/schema.ts) — pinned so the V-690 anchor + W215.C 4-source-of-truth commitment survives', () => {
    expect(body).toMatch(
      /\/\/ V-690 — Sessions API developer docs\. Sibling to api-quickstart;\s*\/\/ this is the deeper "every field, every lifecycle event" reference\s*\/\/ for the \/v1\/sessions surface\./,
    );
    expect(body).toMatch(
      /\/\/ W215\.C — accuracy pass: pinned against publicSession in\s*\/\/ apps\/server\/src\/routes\/sessions\.ts, CreateSessionRequestSchema in\s*\/\/ packages\/api-types\/src\/sessions\.ts, PaginationQuerySchema in\s*\/\/ packages\/api-types\/src\/common\.ts, and webhook_event_type in\s*\/\/ apps\/server\/src\/db\/schema\.ts\./,
    );
  });

  it('5-state LIFECYCLE array pinned: creating (Backend received the start request; provisioning a browser instance) + ready (Browser ready; the session URL is reachable) + busy (Session is actively running an automation step) + destroyed (Normal end-of-life; session has been torn down) + errored (Abnormal termination; the session cannot recover) — pinned so the 5-state enum + happy-path-transition (creating → ready → busy → destroyed) + errored-is-terminal commitments survive', () => {
    expect(body).toMatch(
      /\{ state: 'creating', desc: 'Backend received the start request; provisioning a browser instance\.' \}/,
    );
    expect(body).toMatch(
      /\{ state: 'ready', desc: 'Browser ready; the session URL is reachable\.' \}/,
    );
    expect(body).toMatch(
      /\{ state: 'busy', desc: 'Session is actively running an automation step\.' \}/,
    );
    expect(body).toMatch(
      /\{ state: 'destroyed', desc: 'Normal end-of-life; session has been torn down\.' \}/,
    );
    expect(body).toMatch(
      /\{ state: 'errored', desc: 'Abnormal termination; the session cannot recover\.' \}/,
    );
    expect(body).toMatch(
      /Transitions: <code>creating → ready → busy → destroyed<\/code>\s*is the happy path\. <code>errored<\/code> is terminal; the\s*session cannot recover\./,
    );
  });

  it('POST /v1/sessions documents six optional fields and uses a selectable id from the live archetype catalog', () => {
    expect(body).toMatch(
      /"archetype": "iphone17_ios18_7_safari26_4",\s+← optional, id from GET \/v1\/archetypes/,
    );
    expect(body).toMatch(
      /"purpose": "production_customer",\s+← optional, default applied server-side/,
    );
    expect(body).toMatch(/"label": "ticket-JIRA-1234",\s+← optional, ≤120 chars/);
    expect(body).toMatch(
      /"metadata": \{ "ticket": "JIRA-1234" \},\s+← optional, surfaced in webhooks/,
    );
    expect(body).toMatch(/"profile_id": "prof_01HV…",\s+← optional, binds session to a profile/);
    expect(body).toMatch(
      /"behavioral_profile": "regular"\s+← optional, persona: casual\|regular\|power_user/,
    );
  });

  it('POST /v1/sessions 201 response pins the flat ready session shape', () => {
    expect(body).toMatch(/→ 201 Created/);
    expect(body).toMatch(/"id": "ses_…"/);
    expect(body).toMatch(/"account_id": "acc_…"/);
    expect(body).toMatch(/"api_key_id": "key_…"/);
    expect(body).toMatch(/"status": "ready"/);
    expect(body).toMatch(/"last_state_at": null/);
    expect(body).toMatch(/"destroyed_at": null/);
    expect(body).toMatch(
      /The response is a flat session object — no <code>\{`\{"session": …\}`\}<\/code>\s*envelope\. Session ids are prefixed <code>ses_<\/code>\./,
    );
  });

  it('pins synchronous ready creation, later polling, and terminal-only webhook semantics', () => {
    expect(body).toMatch(
      /create call returns only after the browser driver is ready, so\s*an intermediate <code>creating<\/code> state is not directly\s*observable\. Poll <code>GET \/v1\/sessions\/:id<\/code> for later\s*state changes\./,
    );
    expect(body).toMatch(
      /The <code>session\.completed<\/code> and\s*<code>session\.failed<\/code> webhooks signal clean or errored\s*end-of-life, not readiness\./,
    );
  });

  it("POST /v1/sessions/:id/navigate framing pinned: 'The create call does not take a target URL. Drive the session to a URL after it reaches ready with POST /v1/sessions/<id>/navigate' + body shape { 'url': 'https://example.com', 'wait_until': 'load' } — pinned so the no-URL-on-create + 2-field-navigate-body + wait_until: 'load' commitment survives (drift to claiming create takes URL would create marketing↔SDK divergence)", () => {
    expect(body).toMatch(
      /The create call does not take a target URL\. Drive the session\s*to a URL after it reaches <code>ready<\/code> with\s*<code>POST \/v1\/sessions\/&lt;id&gt;\/navigate<\/code>:/,
    );
    expect(body).toMatch(/POST \/v1\/sessions\/ses_…\/navigate/);
    expect(body).toMatch(/\{ "url": "https:\/\/example\.com", "wait_until": "load" \}/);
  });

  it("GET /v1/sessions list framing pinned: 'GET /v1/sessions?limit=25' + 200 OK with data + has_more + next_cursor + 'Cursor pagination. Pass the previous response's next_cursor as ?cursor= on the next request. Default page size is 50; max 100.' — pinned so the list-response shape + 50-default + 100-max + ?cursor= refeed-pattern commitments survive", () => {
    // V-1117 — anchored, same reason as the profiles page.
    expect(body).toMatch(/GET \/v1\/sessions\?limit=25\b/);
    expect(body).toMatch(/"has_more": true,/);
    expect(body).toMatch(/"next_cursor": "eyJ0aWQiOi…"/);
    expect(body).toMatch(
      /Cursor pagination\. Pass the previous response's\s*<code>next_cursor<\/code> as <code>\?cursor=<\/code> on the next\s*request\. Default page size is <strong>50<\/strong>; max\s*<strong>100<\/strong>\./,
    );
  });

  it("POST /v1/sessions/:id/capture framing pinned: kind: 'screenshot' + 200 OK with 5-field response (kind + data + encoding base64 + byte_size 184320 + duration_ms 412) + 'Captures return inline base64 bytes — there is no presigned URL.' + 3-kind enum (screenshot / dom_snapshot / pdf) — pinned so the 5-field-capture-response shape + no-presigned-URL commitment + 3-kind enum survives (drift to claiming presigned URLs would mislead customers about the bytes-inline contract)", () => {
    expect(body).toMatch(/\{ "kind": "screenshot" \}/);
    expect(body).toMatch(/"data": "<base64-encoded bytes>"/);
    expect(body).toMatch(/"encoding": "base64"/);
    expect(body).toMatch(/"byte_size": 184320/);
    expect(body).toMatch(/"duration_ms": 412/);
    expect(body).toMatch(
      /Captures return inline base64 bytes — there is no presigned\s*URL\. <code>kind<\/code> selects <code>screenshot<\/code>,\s*<code>dom_snapshot<\/code>, or <code>pdf<\/code>\./,
    );
  });

  it("DELETE /v1/sessions/:id 204 + idempotent framing pinned: 'Ends the session immediately and transitions it to destroyed. Idempotent — DELETEing an already-destroyed session also returns 204.' — pinned so the 204 + idempotent-on-destroyed commitment survives (drift to returning 404 on already-destroyed would break the idempotency commitment)", () => {
    expect(body).toMatch(/→ 204 No Content/);
    expect(body).toMatch(
      /Ends the session immediately and transitions it to\s*<code>destroyed<\/code>\. Idempotent — <code>DELETE<\/code>ing an\s*already-destroyed session also returns 204\./,
    );
  });

  it("Concurrent-limit 429 + concurrency-limit RFC 7807 problem-type framing pinned: 'Each tier caps the number of sessions you can have in the live states (creating, ready, busy) at once.' + 'Hitting the cap returns 429 Too Many Requests with the concurrency-limit RFC 7807 problem type — wait for an existing session to finish or upgrade your tier.' — pinned so the live-states-3 (creating/ready/busy) + 429 + concurrency-limit-RFC-7807 problem-type + wait-or-upgrade resolution path survives", () => {
    expect(body).toMatch(
      /Each tier caps the number of sessions you can have in the\s*live states \(<code>creating<\/code>, <code>ready<\/code>,\s*<code>busy<\/code>\) at once\./,
    );
    expect(body).toMatch(
      /Hitting the cap returns\s*<code>429 Too Many Requests<\/code> with the\s*<code>concurrency-limit<\/code> RFC 7807 problem type — wait for\s*an existing session to finish or upgrade your tier\./,
    );
  });

  it('Archetype framing pins live catalog selection, reusable profile IDs, and the server-authoritative default_archetype_id fallback', () => {
    expect(body).toMatch(
      /<code>archetype<\/code> identifies an exact device, iOS, and\s*Safari combination from the live <code>GET \/v1\/archetypes<\/code>\s*catalog\./,
    );
    expect(body).toMatch(
      /Profiles pin one returned id for reuse\. For a one-shot\s*session, omit the field and the server uses the catalog's\s*<code>default_archetype_id<\/code>\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
