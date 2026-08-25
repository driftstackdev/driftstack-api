// V-1598 — the set of statuses that CAN carry `Retry-After` must be a subset of
// the statuses that DECLARE it.
//
// `docs/decisions.md` records the TypeScript SDK carrying a retry policy that
// honours `Retry-After`, so the header is a contract with a named consumer. V-1597
// found thirteen 429 responses that omitted it while the server sent it on every
// one, which is precisely this invariant broken in the direction that matters: a
// generated client could not see the signal.
//
// Both sides are derived, neither is a list maintained here:
//
//   emits   — an `ApiError` subclass whose constructor puts `retry_after_seconds`
//             in its extensions, read out of `lib/errors.ts`. The error handler
//             turns that extension into the header, so a class carrying it is a
//             status that can arrive with one.
//   declares — the statuses whose `openapi.json` responses list a `Retry-After`
//             response header.
//
// The assertion is one-directional on purpose. A response MAY declare the header
// without every instance carrying it — a 429 from a concurrency limit has no
// honest number to give, which `openapi.ts` already says in the header's own
// description. What must not happen is the reverse: a status that can arrive with
// the header while the document never mentions it.
//
// Measured when this landed: emits {429}, declares {429}. The 503 case is the one
// worth recording, because the code reads as though it were in the set and is
// not. `middleware/error-handler.ts` and the agent-message passthrough both branch
// on `429 || 503`, but no 503-producing class sets the extension —
// `FeatureUnavailableError` and `DriverNotIntegratedError` do not — so the 503
// half of both branches is currently unreachable and the document is right to omit
// it. Give either class a retry hint and this fails, which is the moment the spec
// needs updating.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ERRORS_TS = resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

/** Statuses whose error class puts `retry_after_seconds` in its extensions. */
function statusesThatEmit(): number[] {
  const src = readFileSync(ERRORS_TS, 'utf8');
  const out = new Set<number>();
  for (const m of src.matchAll(/export class (\w+) extends ApiError \{(.*?)\n\}/gs)) {
    const body = m[2] ?? '';
    if (!body.includes('retry_after_seconds')) continue;
    const status = /status:\s*(\d+)/.exec(body);
    // A class computing its status dynamically cannot be attributed here, and
    // silently dropping it would shrink the left-hand side without saying so.
    expect(
      status,
      `${m[1]} sets retry_after_seconds but its status is not a literal`,
    ).not.toBeNull();
    out.add(Number(status?.[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/** Statuses whose published responses declare a `Retry-After` response header. */
function statusesThatDeclare(): number[] {
  const doc = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
    components?: { responses?: Record<string, unknown> };
  };
  const deref = (node: unknown): Record<string, unknown> | undefined => {
    let cur =
      typeof node === 'object' && node !== null ? (node as Record<string, unknown>) : undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const ref = cur?.['$ref'];
      if (typeof ref !== 'string') break;
      let walk: unknown = doc;
      for (const key of ref.replace(/^#\//, '').split('/')) {
        walk =
          typeof walk === 'object' && walk !== null
            ? (walk as Record<string, unknown>)[key]
            : undefined;
      }
      cur =
        typeof walk === 'object' && walk !== null ? (walk as Record<string, unknown>) : undefined;
    }
    return cur;
  };
  const out = new Set<number>();
  for (const path of Object.keys(doc.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = doc.paths[path]?.[method];
      if (typeof op !== 'object' || op === null) continue;
      const responses = (op as Record<string, unknown>)['responses'];
      if (typeof responses !== 'object' || responses === null) continue;
      for (const [code, resp] of Object.entries(responses as Record<string, unknown>)) {
        const headers = deref(resp)?.['headers'];
        if (typeof headers !== 'object' || headers === null) continue;
        const names = Object.keys(headers).map((h) => h.toLowerCase());
        if (names.includes('retry-after')) out.add(Number(code));
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

describe('a status that can carry Retry-After declares it', () => {
  it('CRITICAL both sides parsed something. An empty left-hand side makes the subset assertion below trivially true, and an empty right-hand side would make it trivially false — so neither reading is trusted without knowing the parse worked.', () => {
    expect(statusesThatEmit(), 'at least one error class sets retry_after_seconds').not.toEqual([]);
    expect(statusesThatDeclare(), 'at least one response declares Retry-After').not.toEqual([]);
  });

  it('CRITICAL every status an error class can emit the header on is a status the document declares it on. V-1597 found this broken for thirteen 429 responses: the server sent the header, the spec never mentioned it, and a generated client fell back to a hard-coded backoff on exactly the endpoints called in bursts.', () => {
    const declares = new Set(statusesThatDeclare());
    const undeclared = statusesThatEmit().filter((s) => !declares.has(s));
    expect(
      undeclared,
      'these statuses can arrive carrying Retry-After and the document does not say so',
    ).toEqual([]);
  });
});
