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

  it("v1.0 write-only + v1.1 D2/D3 scope framing pinned: 'At v1.0 the surface is write-only: POST /v1/recipes. Read / list / execute / delete land at v1.1 (D2/D3 scope per the v2-#37 queue).' — pinned so the v1.0-write-only-narrow-surface + v1.1-D2-D3-roadmap-scope contract all stay documented (drift to shipping read/list at v1.0 would over-promise + open audit-log gaps)", () => {
    expect(body).toMatch(
      /At v1\.0 the surface is write-only: `POST \/v1\/recipes`\. Read \/\s*\n?\s*list \/ execute \/ delete land at v1\.1 \(D2\/D3 scope per the v2-#37\s*\n?\s*queue\)\./,
    );
  });

  it("Resource shape 7-field pinned: id (rec_<uuid>) + account_id + agent_session_id (nullable) + label + description + intent_count + created_at + updated_at. + 'agent_session_id is null when the originating agent-session has been deleted (ON DELETE SET NULL — the recipe survives the source session's lifecycle).' + 'intent_count is the length of the flattened intent_log; the actual intent array is captured but not surfaced at v1.0 (it lands with the read/list endpoints at v1.1).' — pinned so the ON-DELETE-SET-NULL relationship + intent-array-captured-but-not-surfaced contract all stay documented", () => {
    expect(body).toMatch(
      /"id": "rec_<uuid>",\s*\n?\s*"account_id": "<account-uuid>",\s*\n?\s*"agent_session_id": "agt_<uuid> \| null",\s*\n?\s*"label": "my checkout flow",/,
    );
    expect(body).toMatch(
      /`agent_session_id` is `null` when the originating agent-session\s*\n?\s*has been deleted \(ON DELETE SET NULL — the recipe survives the\s*\n?\s*source session's lifecycle\)\./,
    );
    expect(body).toMatch(
      /`intent_count` is the length of the\s*\n?\s*flattened intent_log; the actual intent array is captured but\s*\n?\s*not surfaced at v1\.0 \(it lands with the read\/list endpoints at\s*\n?\s*v1\.1\)\./,
    );
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

  it('Errors table 4-row roster pinned: 400 validation + 404 not-found + 401 unauthorized + 503 feature-unavailable. + Upcoming-v1.1 4-endpoint roadmap (GET list + GET id + POST id/execute + DELETE id) — pinned so the 4-error-status + 4-future-endpoints-roadmap contract all stay documented', () => {
    expect(body).toMatch(/\|\s*400 \| validation/);
    expect(body).toMatch(/\|\s*404 \| not-found/);
    expect(body).toMatch(/\|\s*401 \| unauthorized/);
    expect(body).toMatch(/\|\s*503 \| feature-unavailable/);
    expect(body).toMatch(/- `GET \/v1\/recipes` — list the calling account's recipes/);
    expect(body).toMatch(/- `POST \/v1\/recipes\/\{id\}\/execute` — replay against a new/);
  });
});
