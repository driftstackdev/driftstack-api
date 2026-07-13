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

  it("Recipes overview framing pinned: 'A recipe is an immutable snapshot of a finished agent-session — the structured intent_log plus the full transcript at the moment of capture. Recipes let customers replay the same flow later without re-paying the LLM decompose cost.' — pinned so the immutable-snapshot + intent_log+transcript + replay-without-decompose-cost contract all stay documented", () => {
    expect(body).toMatch(
      /A \*\*recipe\*\* is an immutable snapshot of a finished\s*\n?\s*\[agent-session\]\(\/api\/agent-sessions\/\) — the structured intent_log\s*\n?\s*plus the full transcript at the moment of capture\. Recipes let\s*\n?\s*customers replay the same flow later without re-paying the LLM\s*\n?\s*decompose cost\./,
    );
  });

  it("v1.0 create/list/read/delete surface + execute-stays-v1.1 framing pinned: 'The v1.0 surface covers create, list, read, and delete: POST /v1/recipes, GET /v1/recipes, GET /v1/recipes/{id}, and DELETE /v1/recipes/{id}. Recipe execution — replaying a recipe against a new agent-session — lands at v1.1 (D2/D3 scope per the v2-#37 queue).' — pinned so the read/management path is documented as SHIPPED while execution stays gated on the harness executor (drift to re-listing list/get/delete as 'upcoming' would under-document the live surface; drift to documenting execute as shipped would over-promise the harness-gated path)", () => {
    expect(body).toMatch(
      /The v1\.0 surface covers create, list, read, and delete:\s*\n?\s*`POST \/v1\/recipes`, `GET \/v1\/recipes`, `GET \/v1\/recipes\/\{id\}`, and\s*\n?\s*`DELETE \/v1\/recipes\/\{id\}`\. Recipe execution — replaying a recipe/,
    );
    expect(body).toMatch(
      /against a new agent-session — lands at v1\.1 \(D2\/D3 scope per the\s*\n?\s*v2-#37 queue\)\./,
    );
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

  it('Create body 3-field validation framing pinned: agent_session_id required + cross-account 404 + label 1-120 chars after trim + description optional up to 2000 chars + 201 Created response. Drift to dropping the cross-account-404 anti-enumeration would leak agent-session-id existence to attackers', () => {
    expect(body).toMatch(
      /- `agent_session_id` — required\. Must belong to the calling\s*\n?\s*account; cross-account references return 404\./,
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

  it('Errors table 4-row roster pinned: 400 validation + 404 not-found + 401 unauthorized + 503 feature-unavailable. + Upcoming-v1.1 reduced to the single execute endpoint (list/get/delete shipped at v1.0, so only POST /v1/recipes/{id}/execute remains gated on the harness executor) — pinned so the 4-error-status + execution-stays-the-only-upcoming-endpoint contract stay documented', () => {
    expect(body).toMatch(/\|\s*400 \| validation/);
    expect(body).toMatch(/\|\s*404 \| not-found/);
    expect(body).toMatch(/\|\s*401 \| unauthorized/);
    expect(body).toMatch(/\|\s*503 \| feature-unavailable/);
    expect(body).toMatch(
      /## Upcoming \(v1\.1\)\s*\n\s*\n- `POST \/v1\/recipes\/\{id\}\/execute` — replay a recipe against a new\s*\n\s*agent-session, skipping the decompose step/,
    );
    // list/get/delete are no longer "upcoming" — they must NOT appear
    // under any "land at v1.1" / "Upcoming" framing now that they ship.
    expect(body).not.toMatch(/- `GET \/v1\/recipes` — list the calling account's recipes/);
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
