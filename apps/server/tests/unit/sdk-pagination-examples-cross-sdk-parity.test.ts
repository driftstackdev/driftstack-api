// W798 — cross-SDK pagination-example parity. One-hundred-twenty-
// fourth in the drift-guard series. Pins the cursor-pagination
// teaching examples in lockstep across sdk-typescript / sdk-python
// / sdk-go. TS + Python use the V-118 / V-119 / V-126 iterator
// helpers (for await + for/async for); Go uses the manual cursor
// loop on top of List(...) because Go pre-1.23 has no generators.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/examples/pagination.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/examples/pagination.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/examples/pagination/main.go');

describe('W798 cross-SDK pagination examples parity', () => {
  it('all 3 pagination example files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── V-anchor framing ─────────────────────────────────────────

  it('CRITICAL V-118 + V-119 (TS) / V-126 (Python) iterator-helper anchors pinned. The V-numbers thread iterator-provenance through the SDK source — drift to dropping the anchors would lose the canonical "iterator handles cursor handoff" doc-source link.', () => {
    expect(read(TS)).toMatch(
      /The iterators \(V-118 \+ V-119\) handle\s*\n\/\/ cursor handoff automatically — consumer code reads as a normal\s*\n\/\/ `for await` loop\./,
    );
    expect(read(PY)).toMatch(
      /V-126 added ``iterate\(\)`` \/ ``iterate_deliveries\(\)`` helpers on the/,
    );
    expect(read(PY)).toMatch(/Sessions \/ Profiles \/ Webhooks resources/);
  });

  it("CRITICAL Go 'pre-1.23 no generators' rationale pinned. The header comment explains why Go uses the manual cursor loop instead of an iterator helper — drift would let docs falsely claim Go has an `iterate()` method.", () => {
    expect(read(GO)).toMatch(
      /Go pre-1\.23 has\s*\n\/\/ no generators \/ range-over-func, so the SDK exposes raw List\(\.\.\.\)\s*\n\/\/ methods that return one page at a time\./,
    );
    expect(read(GO)).toMatch(
      /The pattern translates 1:1 to webhook deliveries \(client\.Webhooks\.\s*\n\/\/ ListDeliveries\) — same shape: Data \+ NextCursor \+ has_more\./,
    );
  });

  // ─── TS-side: 3 helper functions ──────────────────────────────

  it('CRITICAL TS 3-helper function set pinned — listAllSessions + listProfiles + dlqDeliveriesForFirstWebhook. Each demonstrates a different resource shape; drift would lose breadth of the demo.', () => {
    const p = read(TS);
    expect(p).toMatch(/async function listAllSessions\(\): Promise<void>/);
    expect(p).toMatch(/async function listProfiles\(\): Promise<void>/);
    expect(p).toMatch(/async function dlqDeliveriesForFirstWebhook\(\): Promise<void>/);
  });

  it('CRITICAL TS for-await-of pattern with limit:50 pinned. `for await (const session of client.sessions.iterate({ limit: 50 }))` is the canonical SDK iterator usage. Drift to manual cursor handling would un-teach the V-118 helper.', () => {
    const p = read(TS);
    expect(p).toMatch(
      /for await \(const session of client\.sessions\.iterate\(\{ limit: 50 \}\)\)/,
    );
    expect(p).toMatch(/for await \(const profile of client\.profiles\.iterate\(\)\)/);
  });

  it("CRITICAL TS DLQ-filter pattern pinned — iterateDeliveries(first.id, { status: 'dlq', limit: 100 }). Demonstrates filter-threading through the cursor loop. Drift would lose the only quickstart-level demonstration of this pattern.", () => {
    const p = read(TS);
    expect(p).toMatch(
      /for await \(const delivery of client\.webhooks\.iterateDeliveries\(first\.id, \{\s*\n\s+status: 'dlq',\s*\n\s+limit: 100,\s*\n\s+\}\)\)/,
    );
  });

  it('CRITICAL TS session field accessors — session.id + session.status + session.archetype + delivery.event_type + delivery.attempts pinned. Drift to a different schema would break the demo print output.', () => {
    const p = read(TS);
    expect(p).toMatch(/\$\{session\.id\}\s+\$\{session\.status\}\s+\$\{session\.archetype\}/);
    expect(p).toMatch(
      /\$\{delivery\.id\}\s+\$\{delivery\.event_type\}\s+attempts=\$\{delivery\.attempts\}/,
    );
  });

  // ─── Python-side: sync + async dual-pattern ───────────────────

  it('CRITICAL Python sync + async dual-pattern pinned. The example demonstrates both `for session in ...` (sync) AND `async for session in aclient.sessions.iterate(...)` (async). Drift to dropping the async pattern would orphan the AsyncDriftstack docs.', () => {
    const p = read(PY);
    expect(p).toMatch(/for session in client\.sessions\.iterate\(limit=50\):/);
    expect(p).toMatch(/async for session in aclient\.sessions\.iterate\(limit=50\):/);
    expect(p).toMatch(
      /async with AsyncDriftstack\(api_key=api_key, base_url=base_url\) as aclient:/,
    );
  });

  it('CRITICAL Python imports both AsyncDriftstack + Driftstack from same package. The dual-import demonstrates that both clients live in the same surface module — drift would force users to know two import paths.', () => {
    const p = read(PY);
    expect(p).toMatch(/from driftstack import AsyncDriftstack, Driftstack/);
  });

  it("CRITICAL Python profile dict-vs-object framing pinned. The 'Profiles still return raw dict (untyped pending codegen pass)' + 'duck typing' framing is the load-bearing explanation for why profile.get('name') instead of profile.name. Drift to claiming profiles are typed would break the dict.get() usage.", () => {
    const p = read(PY);
    expect(p).toMatch(/Profiles still return raw dict \(untyped pending codegen pass\);/);
    expect(p).toMatch(/the iterator handles both attribute-style \+ dict-style page/);
    expect(p).toMatch(/shapes via duck typing/);
    expect(p).toMatch(/name = profile\.get\("name", "<unnamed>"\)/);
  });

  it("CRITICAL Python DLQ-filter pattern pinned — `iterate_deliveries(str(first.id), limit=100, status='dlq')`. The `status='dlq'` kwarg threads through every page just like the TS option. Drift to a different filter syntax would diverge from TS.", () => {
    const p = read(PY);
    expect(p).toMatch(
      /for delivery in client\.webhooks\.iterate_deliveries\(str\(first\.id\), limit=100, status="dlq"\):/,
    );
  });

  // ─── Go-side: manual cursor loop ──────────────────────────────

  it('CRITICAL Go cursor-loop shape pinned. `cursor := ""` + `for { page, err := ... List(...); if page.NextCursor == nil { break }; cursor = *page.NextCursor }`. Drift would break the canonical Go-pre-1.23 cursor-pagination teaching shape.', () => {
    const p = read(GO);
    expect(p).toMatch(/cursor := ""/);
    expect(p).toMatch(
      /for \{\s*\n\s+page, err := client\.Sessions\.List\(ctx, &driftstack\.ListSessionsQuery\{/,
    );
    expect(p).toMatch(/if page\.NextCursor == nil \{\s*\n\s+break\s*\n\s+\}/);
    expect(p).toMatch(/cursor = \*page\.NextCursor/);
  });

  it('CRITICAL Go Limit:50 + Limit:100 dual-page-size pinned. Pattern 1 (full walk) uses Limit:50; Pattern 2 (early-exit search) uses Limit:100 because larger pages mean fewer round-trips when looking for a match.', () => {
    const p = read(GO);
    expect(p).toMatch(/Limit: +50,/);
    expect(p).toMatch(/Limit: +100,/);
  });

  it("CRITICAL Go early-exit Pattern-2 framing pinned. The 'early-exit on the first match. Cursor pagination is page-aligned so the loop body controls how aggressively to walk' wording explains why early-exit is safe with cursor-pagination.", () => {
    const p = read(GO);
    expect(p).toMatch(
      /\/\/ Pattern 2 — early-exit on the first match\. Cursor pagination is\s*\n\s+\/\/ page-aligned so the loop body controls how aggressively to walk\./,
    );
  });

  it('CRITICAL Go FIND_SESSION_LABEL env-var convention pinned. The env-var-gated Pattern-2 lets the example skip the search when not configured — drift would either run it always (slow) or never (un-tested).', () => {
    const p = read(GO);
    expect(p).toMatch(/target := os\.Getenv\("FIND_SESSION_LABEL"\)/);
    expect(p).toMatch(/if target == "" \{\s*\n\s+return\s*\n\s+\}/);
  });

  it('CRITICAL Go ListSessionsQuery shape pinned — Limit + Cursor fields. Matches the V-118-equivalent request type; drift to a different field name would break every Go SDK consumer.', () => {
    const p = read(GO);
    expect(p).toMatch(
      /&driftstack\.ListSessionsQuery\{\s*\n\s+Limit:\s+50,\s*\n\s+Cursor: cursor,\s*\n\s+\}/,
    );
  });

  // ─── Cross-SDK shared invariants ──────────────────────────────

  it('CRITICAL all 3 examples demonstrate session pagination with limit:50 default. The 50-per-page number is the documented default; drift in any SDK would change the canonical demo throughput.', () => {
    expect(read(TS)).toMatch(/limit: 50/);
    expect(read(PY)).toMatch(/limit=50/);
    expect(read(GO)).toMatch(/Limit:\s+50,/);
  });

  it("CRITICAL all 3 examples print session.id + status + archetype in the loop body. The 3-field print is the canonical 'verify the iterator is yielding hydrated objects' demonstration.", () => {
    expect(read(TS)).toMatch(/session\.id.*session\.status.*session\.archetype/);
    expect(read(PY)).toMatch(/session\.id.*session\.status.*session\.archetype/);
    expect(read(GO)).toMatch(/s\.ID.*s\.Status.*s\.Archetype/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sdk-pagination-examples-cross-sdk-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
