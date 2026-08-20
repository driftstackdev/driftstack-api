// Drift guard for apps/docs/src/pages/api/recipes.md. Pins the
// customer-facing recipes API docs — v1.0 write-only POST /v1/recipes
// + v1.1 D2/D3 read/list/execute/delete + intent_log atomic-snapshot
// pattern + ON DELETE SET NULL relationship.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/docs/src/pages/api/recipes.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs/api/recipes content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('Recipes overview pins the immutable snapshot as a durable reference without claiming replay', () => {
    expect(body).toMatch(
      /A \*\*recipe\*\* is an immutable snapshot of a finished\s*\n?\s*\[agent-session\]\(\/api\/agent-sessions\/\) — the structured intent_log\s*\n?\s*plus the full transcript at the moment of capture\. Recipes preserve\s*\n?\s*a completed flow as a durable reference without re-running decomposition/,
    );
  });

  it('current create/list/read/delete surface and explicit no-execute boundary are pinned', () => {
    expect(body).toMatch(
      /The current surface covers create, list, read, and delete:\s*\n?\s*`POST \/v1\/recipes`, `GET \/v1\/recipes`, `GET \/v1\/recipes\/\{id\}`, and\s*\n?\s*`DELETE \/v1\/recipes\/\{id\}`\. There is no recipe-execution endpoint/,
    );
    expect(body).toMatch(/start a new agent-session to run another task\./);
  });

  it('Resource shape and public-detail redaction pinned: list metadata stays compact; detail retains sensitive selectors/order/marker but never returns saved type values to read scope', () => {
    expect(body).toMatch(
      /"id": "rec_<uuid>",\s*\n?\s*"account_id": "<account-uuid>",\s*\n?\s*"agent_session_id": "agt_<uuid> \| null",\s*\n?\s*"label": "my checkout flow",/,
    );
    expect(body).toMatch(
      /`agent_session_id` is `null` when the originating agent-session\s*\n?\s*has been deleted \(ON DELETE SET NULL — the recipe survives the\s*\n?\s*source session's lifecycle\)\./,
    );
    expect(body).toMatch(
      /`intent_count` is the length of the\s*\n?\s*flattened intent_log\. The list endpoint omits the intent array for\s*\n?\s*payload weight; fetch a single recipe with `GET \/v1\/recipes\/\{id\}`\s*\n?\s*to get its public `intent_log`\./,
    );
    expect(body).toMatch(
      /to get its public `intent_log`\. Sensitive `type` steps retain their\s*\n?\s*selector, order, and `sensitive: true` marker but omit `value`\./,
    );
    expect(body).toMatch(/never exposed to an ordinary\s*\n?\s*`read`-scope caller\./);
  });

  it('Create body 3-field validation framing pinned: agent_session_id required + ACCESS-scoped 404 (V-812: owner OR team admin, not calling-account-only) + label 1-120 chars after trim + description optional up to 2000 chars + 201 Created response. Drift to dropping the cross-account-404 anti-enumeration would leak agent-session-id existence to attackers', () => {
    // V-812 — "must belong to the calling account" was false. The route gates on
    // callerCanAccessAgentSession(ctx, ownerAccountId), which returns true for the
    // owner OR an admin member of the owner's team (V-736), so a team admin
    // snapshotting the owner's session gets a 201. The 404-not-403 anti-enumeration
    // posture is real and stays pinned.
    // V-1085 — the sentence carried `(V-736)` and a `V-812 —` retraction into
    // customer-rendered HTML, which `check:rendered-product-status` forbids and
    // which failed that CI stage. The CONTENT was right; only the bookkeeping was
    // leaking, so the access rule stays pinned and the markers must not come back.
    expect(body).toMatch(
      /- `agent_session_id` — required\. Must be a session you can ACCESS: one\s*\n?\s*your own account owns, or one owned by a team you hold the \*\*admin\*\*\s*\n?\s*role on/,
    );
    expect(
      body,
      'an internal V-marker is back in customer-rendered prose; check:rendered-product-status fails on it',
    ).not.toMatch(/\bV-\d{3,}/);
    expect(body).toMatch(/a team admin snapshotting the owner's session gets/);
    expect(body, 'the calling-account-only claim must not return').not.toMatch(
      /Must belong to the calling/,
    );
    expect(body, 'anti-enumeration must stay 404 rather than 403').toMatch(
      /404 rather than 403 so the response does not confirm the session exists/,
    );
    expect(body).toMatch(/- `label` — required\. 1-120 characters after trim\./);
    expect(body).toMatch(/- `description` — optional\. Up to 2000 characters\./);
    expect(body).toMatch(/Response `201 Created` returns the resource above\./);
  });

  it("Intent log assembly framing pinned: 'the server walks the source agent-session's transcript and flatMaps every plan-executed agent turn's structured intents array into a single intent_log. The result is captured atomically (insert-once; never edited) so the historical snapshot survives any later session activity.' + 'Operator + user transcript entries don't carry intents — only agent turns from a successful decompose+execute step contribute. A session that ran exclusively in mode=manual will produce a recipe with intent_count: 0 (because manual sessions log operator entries, not decomposer plans). That's expected — the recipe is still useful as a transcript-only snapshot.' — pinned so the flatMap-plan-executed + insert-once + manual-session-intent_count-0-is-expected contract all stay documented", () => {
    expect(body).toMatch(
      /the server walks the source agent-session's\s*\n?\s*transcript and flatMaps every `plan-executed` agent turn's\s*\n?\s*structured `intents` array into a single `intent_log`\. The result\s*\n?\s*is captured atomically \(insert-once; never edited\) so the\s*\n?\s*historical snapshot survives any later session activity\./,
    );
    expect(body).toMatch(
      /A session that ran exclusively in `mode='manual'` will produce a\s*\n?\s*recipe with `intent_count: 0`/,
    );
  });

  it('Errors table 4-row roster pinned, with no speculative Upcoming section', () => {
    expect(body).toMatch(/\|\s*400 \| validation-failed/);
    expect(body).toMatch(/\|\s*404 \| not-found/);
    expect(body).toMatch(/\|\s*401 \| unauthorized/);
    expect(body).toMatch(/\|\s*503 \| feature-unavailable/);
    expect(body).not.toMatch(/## Upcoming|lands at v1\.1|\/recipes\/\{id\}\/execute/);
  });

  it('List endpoint documented as shipped: GET /v1/recipes cursor-paginated (limit 1-100 default 50 + opaque cursor + { data, has_more, next_cursor } envelope, intent_log omitted from list items) — pinned so the read path is documented as live and matches the keyset-pagination contract the route + SDKs implement', () => {
    expect(body).toMatch(/## List\s*\n\s*\n`GET \/v1\/recipes`/);
    expect(body).toMatch(/- `limit` — optional\. 1-100, defaults to 50\./);
    expect(body).toMatch(
      /- `cursor` — optional\. Opaque cursor from a prior page's `next_cursor`\./,
    );
    expect(body).toMatch(/"has_more": true,\s*\n\s*"next_cursor": "<opaque> \| null"/);
  });

  it('Get-one endpoint documents the public intent log, sensitive-value omission, and cross-account 404 anti-enumeration', () => {
    expect(body).toMatch(/## Get one\s*\n\s*\n`GET \/v1\/recipes\/\{id\}`/);
    expect(body).toMatch(
      /including its public `intent_log` array \(the\s*\n?\s*list endpoint omits it\)\./,
    );
    expect(body).toMatch(
      /Sensitive `type` intents omit `value`, even\s*\n?\s*when sensitivity is inferred from a password, OTP, PIN, card, or API\s*\n?\s*key selector; these steps still carry `sensitive: true`/,
    );
    expect(body).toMatch(
      /doesn't distinguish missing from forbidden, to avoid\s*\n?\s*leaking existence\./,
    );
  });

  it('intent-log storage docs pin encryption plus copy-on-serialize redaction', () => {
    expect(body).toMatch(/Recipe payloads are encrypted at rest\./);
    expect(body).toMatch(
      /Public detail serialization\s*\n?\s*works from a copy and removes sensitive type values without changing\s*\n?\s*the stored intent log/,
    );
  });

  it('Delete endpoint documented as shipped: DELETE /v1/recipes/{id} returns 204 + NOT idempotent (already-deleted returns 404) + cross-account 404 — pinned so the non-idempotent contract (matching the SDKs, which propagate the 404 rather than swallowing it) stays explicit', () => {
    expect(body).toMatch(/## Delete\s*\n\s*\n`DELETE \/v1\/recipes\/\{id\}`/);
    expect(body).toMatch(/Deletes a recipe\. Response `204 No Content`\./);
    expect(body).toMatch(
      /Delete is \*\*not\*\* idempotent: deleting an already-deleted recipe\s*\n?\s*returns 404, not 204\./,
    );
  });
});
