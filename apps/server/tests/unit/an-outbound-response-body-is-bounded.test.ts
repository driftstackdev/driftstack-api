// V-2042 — every outbound caller bounds the response body it reads.
//
// The server POSTs to endpoints it does not control: customer-supplied webhook
// URLs, payment providers, an IDP token endpoint, the Anthropic API. A remote
// end can stream an unbounded body, or a Content-Encoding decompression bomb
// (the undici advisory `webhook-worker.ts` cites), and an unbounded
// `response.text()` buffers all of it inside the delivery timeout. The
// AbortController each caller already installs bounds the read by TIME; only a
// size cap bounds it by MEMORY.
//
// Measured before writing this: planting a NEW file under apps/server/src whose
// body is `const res = await fetch(url); return await res.text();` passed the
// entire unit suite — 2020 files, 20984 tests, zero failures. Removing the bound
// from an EXISTING caller is caught, but only incidentally: the now-unused
// import trips the typecheck guard. Nothing asserted the property itself, and
// nothing at all noticed a new caller.
//
// Three mechanisms are in use and all three are legitimate, so this roster
// records WHICH one each file uses rather than pinning one implementation:
// the shared `readBoundedResponseBody`, an equivalent local streaming cap, or
// cancelling the body and reading only `status`/`ok`.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'apps/server/src');

/** Every file that issues an outbound request, mapped to HOW it bounds the
 *  response body. A file added here without a reason is as unreviewed as one
 *  missing from it, which is why the value is prose and not `true`. */
const OUTBOUND_CALLERS: ReadonlyMap<string, string> = new Map([
  ['lib/nowpayments-api.ts', 'shared readBoundedResponseBody, 256 KiB'],
  ['lib/stripe-api.ts', 'shared readBoundedResponseBody'],
  [
    'lib/oauth-client-exchange.ts',
    'local readBoundedResponseBody copy, MAX_OAUTH_RESPONSE_BODY_BYTES 256 KiB',
  ],
  ['services/agent-decomposer-claude.ts', 'own streaming cap, MAX_ANTHROPIC_RESPONSE_BYTES 64 KiB'],
  ['services/webhook-worker.ts', 'own readExcerpt streaming cap, MAX_RESPONSE_READ_BYTES 64 KiB'],
  ['services/durable-webhook-delivery.ts', 'own streaming cap, RESPONSE_READ_MAX_BYTES 64 KiB'],
  ['services/anthropic-key-tester.ts', 'body cancelled, only status read'],
  ['services/health-probe.ts', 'body cancelled, only status/ok read'],
  ['services/incident-broadcast.ts', 'body cancelled, only status read'],
]);

/** Files issuing an outbound request, walked rather than listed — a NEW caller
 *  is the drift this exists for, and a list cannot notice one. Comment lines are
 *  dropped so prose mentioning fetch does not enrol a file. */
function outboundCallers(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const code = readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      if (/\b(?:fetch|fetchImpl|this\.fetchImpl)\s*\(/.test(code)) out.push(relative(SRC_ROOT, p));
    }
  };
  walk(SRC_ROOT);
  return out.sort();
}

describe('an outbound response body is bounded', () => {
  it('CRITICAL the outbound-caller census found the callers. Both arms below iterate it, so an empty walk makes them vacuously true — and a rename of `fetch` behind a wrapper is exactly the refactor that would empty it while leaving every real caller in place.', () => {
    expect(outboundCallers(), 'no outbound callers found under apps/server/src').not.toHaveLength(
      0,
    );
  });

  it('CRITICAL every file issuing an outbound request is rostered with the mechanism that bounds its response body. A new caller reading `await res.text()` on an endpoint the server does not control buffers whatever that endpoint sends, inside a timeout that bounds only TIME. Measured: such a file passes the whole unit suite today.', () => {
    const unrostered = outboundCallers().filter((f) => !OUTBOUND_CALLERS.has(f));
    expect(
      unrostered,
      'outbound caller(s) with no recorded response-body bound — state the mechanism (shared reader, own streaming cap, or body cancelled):',
    ).toEqual([]);
  });

  it('the roster cannot rot: every rostered file still issues an outbound request. An entry that stops calling out is a stale claim about a file nobody re-reads, and it makes the roster look more thorough than it is.', () => {
    const live = new Set(outboundCallers());
    const stale = [...OUTBOUND_CALLERS.keys()].filter((f) => !live.has(f)).sort();
    expect(
      stale,
      'rostered file(s) that no longer issue an outbound request — drop the entry:',
    ).toEqual([]);
  });
});
