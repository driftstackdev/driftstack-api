// Changing a customer's stored Anthropic key must drop the plaintext copies
// already handed to open sessions.
//
// The plaintext is cached per agent session (`InMemoryByokKeyCache`), because
// each turn would otherwise decrypt again. V-730 records what that cost: a clear
// "returned false while every already-open agent session kept transmitting the
// cleared key to Anthropic until the session closed or the 13h TTL lapsed". Both
// customer routes now call `deleteByAccount` right after the write, and the
// comments beside them say exactly why.
//
// The invariant lives at the CALL SITES, not in the service. `clearKey` does not
// touch the cache — the service holds no reference to it — so "clearing a key
// drops the cached plaintext" is true only for as long as every caller of
// `clearKey` and `setKey` remembers to evict. There are three callers today and
// ONE OF THEM DOES NOT:
//
//   routes/account-byok-anthropic.ts  PUT    setKey   → evicts
//   routes/account-byok-anthropic.ts  DELETE clearKey → evicts
//   services/account-deletion-purge-sweeper.ts  clearKey → does NOT evict
//
// The sweeper is safe, and the reason is worth writing down rather than
// re-deriving: it fires 30 days after `deleted_at`, the cache TTL is 13 hours,
// and deleteAccount reclaims the account's sessions immediately — so no entry
// for that account can still exist by the time it runs. It is an exemption on
// the strength of two independent margins, not on the absence of a problem.
//
// What this guards is the fourth caller. A new `clearKey` or `setKey` site that
// forgets the eviction reintroduces V-730 exactly, and V-730 was not found by
// reading the code — it was found because a customer clear did not take effect.
//
// The better fix is to move the eviction inside the service so it cannot be
// forgotten. That is a wiring change through bootstrap, which another agent is
// editing, and it is worth doing deliberately rather than as a side effect of a
// drift guard. Recorded here as the reason this file exists rather than that
// change.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { InMemoryByokKeyCache } from '../../src/services/byok-anthropic-key-cache.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/**
 * Call sites of `clearKey` / `setKey` that deliberately do NOT evict, and why.
 * An exemption here is a claim that no cached entry can exist at that moment.
 */
const MAY_SKIP_EVICTION = new Map<string, string>([
  [
    'services/account-deletion-purge-sweeper.ts',
    'runs 30 days after deleted_at; the cache TTL is 13h and deleteAccount reclaims sessions immediately, so no entry for the account survives to that point',
  ],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const codeLines = (src: string): string[] =>
  src.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l));

/** How far after a write the eviction may sit. Both routes evict within 10. */
const EVICTION_WINDOW = 25;

/**
 * Every CALL SITE that mutates the stored key, and whether an eviction follows
 * it. The service and its repo are excluded: they are what gets called.
 *
 * Per SITE, not per file, and that distinction is the whole guard. The first
 * version asked whether the file contained a `deleteByAccount` anywhere —
 * routes/account-byok-anthropic.ts has two writes and two evictions, so
 * deleting ONE of them left the file still "evicting" and the mutation
 * reproducing V-730 SURVIVED. A file-level answer to a call-site-level question
 * is indistinguishable from a passing guard.
 */
function mutationSites(): { file: string; line: number; evicts: boolean }[] {
  const out: { file: string; line: number; evicts: boolean }[] = [];
  for (const file of walk(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (rel === 'services/byok-anthropic.ts' || rel.startsWith('db/')) continue;
    const lines = codeLines(readFileSync(file, 'utf8'));
    for (let i = 0; i < lines.length; i += 1) {
      if (!/\b(?:service|byok!?|byokService)\.(?:clearKey|setKey)\(/.test(lines[i] ?? '')) continue;
      const window = lines.slice(i, i + EVICTION_WINDOW).join('\n');
      out.push({ file: rel, line: i + 1, evicts: /deleteByAccount\(/.test(window) });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

describe('changing a BYOK key evicts every cached copy of it', () => {
  it('CRITICAL the scan finds the mutation sites at all. Every assertion below is about a set of files; a matcher that found none would report perfect compliance. Probed by name in both directions.', () => {
    const sites = mutationSites();
    expect(sites.length, 'call sites of clearKey/setKey').toBeGreaterThanOrEqual(3);
    expect(
      sites.map((s) => s.file),
      'the customer route must be among them',
    ).toContain('routes/account-byok-anthropic.ts');
    expect(
      sites.map((s) => s.file),
      'the purge sweeper must be among them',
    ).toContain('services/account-deletion-purge-sweeper.ts');
  });

  it('CRITICAL every file that changes a stored key also evicts the cached plaintext, or is recorded as unable to have one. V-730 was a customer pressing Delete and the key continuing to work — for up to 13 hours, on every session already open. That did not come from a missing check; it came from the eviction living beside the write instead of inside it.', () => {
    const missing = mutationSites()
      .filter((s) => !s.evicts && !MAY_SKIP_EVICTION.has(s.file))
      .map((s) => `${s.file}:${String(s.line)}`);
    expect(
      missing,
      'file(s) changing a stored BYOK key without dropping the cached plaintext. Call ' +
        'deleteByAccount(accountId) after the write, or add the file to MAY_SKIP_EVICTION with ' +
        'the argument for why no cached entry can exist at that moment:',
    ).toEqual([]);
  });

  it('CRITICAL every exemption still names a file that really does skip eviction. An exemption that has since started evicting is a stale claim about the code, and the argument recorded beside it stops being load-bearing without anybody noticing.', () => {
    // A file is only exempt if EVERY one of its sites skips eviction; a file
    // with one evicting site and one not is a bug, not an exemption.
    const byFile = new Map<string, boolean[]>();
    for (const s of mutationSites()) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s.evicts]);
    const stale = [...MAY_SKIP_EVICTION.keys()]
      .filter((f) => !(byFile.get(f) ?? []).every((e) => !e) || !byFile.has(f))
      .sort();
    expect(stale, 'exemption(s) that no longer describe the file:').toEqual([]);
  });

  it('CRITICAL the two margins the sweeper exemption rests on are both still there. The exemption is not "this path is fine", it is "13h TTL and 30d delay". Either number moving makes the argument wrong, and the number that would move silently is the TTL default.', () => {
    const cache = readFileSync(resolve(SRC, 'services/byok-anthropic-key-cache.ts'), 'utf8');
    const ttl = /ttlMs\s*=\s*opts\.ttlMs\s*\?\?\s*(\d+)\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.exec(
      cache,
    );
    expect(ttl, 'the cache TTL default is no longer an hours expression').not.toBeNull();
    expect(Number(ttl?.[1]), 'cache TTL in hours').toBeLessThanOrEqual(24);

    const sweeper = readFileSync(
      resolve(SRC, 'services/account-deletion-purge-sweeper.ts'),
      'utf8',
    );
    expect(sweeper, 'the purge delay is no longer 30 days').toMatch(/\b30\b[^\n]{0,40}day/i);
  });

  it('CRITICAL deleteByAccount actually drops every session for that account, and only that account. The routes count on one call covering every open session; if it dropped one entry the customer would see a clear take effect on one session and not the others, which reads as a flake rather than as a security failure.', () => {
    const cache = new InMemoryByokKeyCache();
    cache.set('as_1', 'sk-a', 'acct_1');
    cache.set('as_2', 'sk-a', 'acct_1');
    cache.set('as_3', 'sk-b', 'acct_2');

    const evicted = cache.deleteByAccount('acct_1');

    expect(evicted, 'both sessions for the account are evicted').toBe(2);
    expect(cache.get('as_1'), 'first session cleared').toBeUndefined();
    expect(cache.get('as_2'), 'second session cleared').toBeUndefined();
    expect(cache.get('as_3'), "another account's session is untouched").toBe('sk-b');
  });

  it('CRITICAL an entry stashed without an accountId is not reachable by deleteByAccount, so the routes cannot rely on it alone. This is the shape of the original V-730 bug — the cache was keyed only by session — and it is worth failing loudly here rather than discovering it as a clear that half worked.', () => {
    const cache = new InMemoryByokKeyCache();
    cache.set('as_orphan', 'sk-orphan');
    expect(cache.deleteByAccount('acct_1'), 'nothing to evict for that account').toBe(0);
    expect(
      cache.get('as_orphan'),
      'an accountId-less entry survives deleteByAccount — every set() on a customer path must pass accountId',
    ).toBe('sk-orphan');
  });
});
