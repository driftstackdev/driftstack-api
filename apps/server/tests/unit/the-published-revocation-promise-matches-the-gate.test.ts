// V-914 — the customer docs now state when key revocation takes effect, so the
// mechanism that makes it true has to stay.
//
// P2-002 in the security audit records that the 30s revocation lag was
// "documented internally but no customer-facing public note". V-886 found the
// internal note was wrong in both directions: no customer page said anything,
// and the 30s TTL was never the revocation budget anyway. Since V-247 a
// revocation INCRs a per-key version counter and `get()` compares it on EVERY
// read, so a revoked key stops authenticating on the next request.
//
// `api/api-keys.md` now says that. Publishing it turns an implementation detail
// into a customer commitment, which is worth doing — silence is worse on a
// credential-revocation path, where a customer who has just leaked a key needs
// to know whether they are done — but only if something keeps the two aligned.
//
// This is the V-902 shape: a promise in one workspace resting on a mechanism in
// another, with nothing tying them. The failure mode is quiet in the same way —
// remove the version gate and every existing test still passes, because the
// cache is correct for every key that was never revoked.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/api-keys.md');
const CACHE = resolve(REPO_ROOT, 'apps/server/src/services/auth-cache.ts');

describe('V-914 the published revocation promise matches the gate', () => {
  it('CRITICAL both files parse as real content. Every arm below is a match against one of them, and an empty read would fail loudly rather than silently — asserted anyway because the two arms that pair a doc claim with a code mechanism are only meaningful if both sides were actually read.', () => {
    expect(readFileSync(DOC, 'utf8').length, 'the api-keys page').toBeGreaterThan(4000);
    expect(readFileSync(CACHE, 'utf8').length, 'the auth cache').toBeGreaterThan(4000);
  });

  it('CRITICAL the page states when revocation takes effect. Before V-886 no customer page said anything, while the cache header claimed customers had been told a 30s worst case. A customer who has just leaked a key needs to know whether revoking it finished the job.', () => {
    const doc = readFileSync(DOC, 'utf8');
    expect(doc, 'the timing section').toMatch(/\*\*When it takes effect\.\*\*/);
    expect(doc, 'and the promise itself').toMatch(
      /stops authenticating on the next\s*\n?request that presents it/,
    );
  });

  it('CRITICAL the per-key version gate that makes the promise true is still in place. This is what the page now commits to: a counter bumped on revocation and compared on every cache read. Remove it and the cache serves a pre-revocation entry until its TTL — the docs would be wrong and nothing else would notice, because a cache is correct for every key that was never revoked.', () => {
    // Comments stripped first. The bare expression also appears in this file's
    // own header prose, so matching it raw passed even with the comparison
    // DELETED from the code — the mutation proof caught a vacuous arm that no
    // reading of the assertion would have.
    const cache = readFileSync(CACHE, 'utf8').replace(/(?<!:)\/\/[^\n]*/g, '');
    expect(cache, 'the per-key version key').toMatch(/KEY_KEY_VERSION\s*=\s*\(keyId: string\)/);
    expect(cache, 'compared on read as a live branch, not merely mentioned').toMatch(
      /if \(currentKeyVersion !== entry\.keyVersion\) return null;/,
    );
  });

  it('CRITICAL the page and the cache agree that a cache failure does not extend a key. The doc promises the fallback is a slower request rather than a longer-lived key; `get()` returns null on any error so the authoritative path runs. If that ever became fail-open, the published promise would be the dangerous kind of wrong.', () => {
    expect(readFileSync(DOC, 'utf8'), 'the documented failure mode').toMatch(
      /never delayed by a cache failure/,
    );
    expect(readFileSync(CACHE, 'utf8'), 'and the code that degrades to the slow path').toMatch(
      /auth cache get failed; degrading to scrypt path/,
    );
  });
});
