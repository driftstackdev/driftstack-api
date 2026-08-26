// Every at-rest encryption binds the record it belongs to.
//
// `encryptPlatformSecret(plaintext, key, authenticatedContext?)` takes its AAD
// as an OPTIONAL third argument, and `if (context !== undefined) setAAD(...)`.
// So omitting one token produces ciphertext bound to nothing — which decrypts
// anywhere, under any record, for any account. That is V-1649's defect one
// layer down: the row said who owned it, and nothing in the bytes agreed.
//
// The sibling API in this same repo shows the shape that cannot be misused:
// `encryptPlatformSecretValue(plaintext, key, name)` takes `name` as REQUIRED
// and always calls setAAD. The difference between the two is a `?`. Making the
// parameter required would enforce this at compile time and is the better fix;
// it costs 46 call-site edits across the tests, so this guard holds the line in
// the meantime and should be deleted the day the signature changes.
//
// Measured when written: 5 encrypt and 5 decrypt call sites under
// `apps/server/src`, and exactly two pass fewer than three arguments. Both are
// legitimate and both are listed below with the reason, because an exemption
// whose reason is not written down is indistinguishable from an oversight.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SRC = resolve(REPO_ROOT, 'apps/server/src');

/**
 * Call sites allowed to encrypt or decrypt without an authenticated context.
 *
 * Each entry is asserted to still describe a real context-free call below, so a
 * site that gains its AAD cannot leave a stale exemption behind claiming a
 * weakness that no longer exists.
 */
const ALLOWED: ReadonlyArray<{ file: string; fn: string; reason: string }> = [
  {
    file: 'services/agent-transcript-encryption.ts',
    fn: 'encryptPlatformSecret',
    reason:
      'v1 transcript envelopes are context-free BY DEFINITION, and this writer has zero production callers — ' +
      'the repo reads v1 and writes v2 (`encryptAgentSessionTranscript`, which binds). Its only callers are ' +
      'tests manufacturing v1 blobs so the v1→v2 migration path can be exercised.',
  },
  {
    file: 'services/agent-transcript-encryption.ts',
    fn: 'decryptPlatformSecret',
    reason:
      'the v1 READ path. A v1 envelope carries no AAD, so reading one cannot supply a context — matching is ' +
      'not optional here, it is what v1 is. Stated plainly because it is a real residual property rather than ' +
      'a non-issue: a v1 row swapped between accounts would decrypt, where a v2 row would fail its tag. The ' +
      'mitigation is finishing the migration — `convertLegacyAgentSessionTranscript` rewrites v1 to v2 on ' +
      'access — not weakening v2 to match.',
  },
  {
    file: 'lib/webhook-secret-encryption.ts',
    fn: 'decryptPlatformSecret',
    reason:
      'the bootstrap-only v1→v2 bridge, which decrypts a context-free v1 blob and immediately re-encrypts it ' +
      'bound to the exact record tuple. The ordinary read path (`readWebhookSecret`) throws on anything that ' +
      'is not a v2 envelope, so this is a migration step and not a dual-read.',
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? d.name === 'node_modules'
        ? []
        : sourceFiles(resolve(dir, d.name))
      : d.name.endsWith('.ts')
        ? [resolve(dir, d.name)]
        : [],
  );
}

/** Top-level argument count of the call whose opening paren is at `open`. */
function argSegments(src: string, open: number): string[] | null {
  let depth = 0;
  let close = -1;
  for (let k = open; k < src.length; k += 1) {
    const c = src[k] as string;
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        close = k;
        break;
      }
    }
  }
  if (close < 0) return null;
  const args = src.slice(open + 1, close);
  if (args.trim() === '') return [];
  // Split into top-level segments and count the NON-EMPTY ones. Counting commas
  // and adding one reads a trailing comma as an extra argument — and prettier
  // writes a trailing comma on every multi-line call, which is how four of the
  // five real sites are formatted. That version of this function passed a
  // mutation that stripped a real AAD, because `f(a, b,)` counted as three.
  const segments: string[] = [];
  let d = 0;
  let cur = '';
  for (const ch of args) {
    if (ch === '(' || ch === '[' || ch === '{') d += 1;
    else if (ch === ')' || ch === ']' || ch === '}') d -= 1;
    if (ch === ',' && d === 0) {
      segments.push(cur);
      cur = '';
    } else cur += ch;
  }
  segments.push(cur);
  return segments.map((seg) => seg.trim()).filter((seg) => seg !== '');
}

/** Argument count, or -1 when the call could not be parsed. */
function argCount(src: string, open: number): number {
  return argSegments(src, open)?.length ?? -1;
}

/**
 * Whether this call deliberately passes no context.
 *
 * Since `authenticatedContext` became REQUIRED, omission is a compile error and
 * this is the only remaining spelling of an unbound call. The guard moved with
 * the signature: it used to count arguments, and counting would now pass every
 * call in the repo, including the ones that pass nothing.
 */
function passesNoContext(segs: string[]): boolean {
  return segs.length < 3 || segs[2] === 'undefined';
}

interface Site {
  rel: string;
  fn: string;
  line: number;
  args: number;
  segs: string[];
}

function callSites(): Site[] {
  const out: Site[] = [];
  for (const abs of sourceFiles(SRC)) {
    const src = codeOnly(readFileSync(abs, 'utf8'));
    for (const m of src.matchAll(/\b((?:en|de)cryptPlatformSecret)\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      // The declaration itself is not a call.
      const before = src.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0);
      if (/function\s+$/.test(before)) continue;
      out.push({
        rel: abs.slice(REPO_ROOT.length + 1).replace('apps/server/src/', ''),
        fn: m[1] as string,
        line: src.slice(0, m.index ?? 0).split('\n').length,
        args: argCount(src, open),
        segs: argSegments(src, open) ?? [],
      });
    }
  }
  return out;
}

/**
 * Cipher constructions allowed to omit setAAD, because they bind by KEY instead.
 *
 * `profile-key-hierarchy` derives a per-account Tenant Master Key —
 * `HKDF-SHA256(master, salt = "tenant" || account_id, info = "TMK-v1")` — so a
 * secret wrapped under account A's TMK cannot be unwrapped with B's. That is
 * binding in the key rather than in the tag, and it is stronger, not weaker.
 * Both `wrapSecret`/`unwrapSecret` callers pass a derived TMK; nothing wraps
 * under the raw master key.
 */
const KEY_BOUND: ReadonlyArray<string> = ['lib/profile-key-hierarchy.ts'];

/** Every `createCipheriv` / `createDecipheriv`, and whether setAAD follows it. */
function cipherSites(): { rel: string; kind: string; line: number; aad: boolean }[] {
  const out: { rel: string; kind: string; line: number; aad: boolean }[] = [];
  for (const abs of sourceFiles(SRC)) {
    const src = codeOnly(readFileSync(abs, 'utf8'));
    for (const m of src.matchAll(/create(Cipheriv|Decipheriv)\s*\(/g)) {
      out.push({
        rel: abs.slice(REPO_ROOT.length + 1).replace('apps/server/src/', ''),
        kind: m[1] as string,
        line: src.slice(0, m.index ?? 0).split('\n').length,
        aad: /\.setAAD\s*\(/.test(
          src.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 400),
        ),
      });
    }
  }
  return out;
}

describe('an at-rest secret is bound to what it belongs to', () => {
  const sites = callSites();
  const contextFree = sites.filter((s) => s.args >= 0 && passesNoContext(s.segs));

  it('CRITICAL the scan finds the real call sites. A zero here reads exactly like a clean sweep, and this file would then be asserting nothing about a codebase full of unbound ciphertext.', () => {
    expect(
      sites.length,
      'no encrypt/decrypt call sites found under apps/server/src',
    ).toBeGreaterThanOrEqual(8);
    expect(
      sites.some((s) => s.fn === 'encryptPlatformSecret'),
      'the encrypt direction must be in the population',
    ).toBe(true);
  });

  it('CRITICAL the argument counter distinguishes a bound call from an unbound one, including when the context is itself a call with commas in it — which is how four of the five real sites are written.', () => {
    const bound = 'encryptPlatformSecret(pt, key, ctx({ accountId: a, endpointId: b }))';
    const unbound = 'encryptPlatformSecret(pt, key)';
    const trailing = 'encryptPlatformSecret(\n  pt,\n  key,\n)';
    expect(argCount(bound, bound.indexOf('(')), 'a nested call is one argument').toBe(3);
    expect(argCount(unbound, unbound.indexOf('(')), 'two arguments is unbound').toBe(2);
    expect(
      argCount(trailing, trailing.indexOf('(')),
      'a trailing comma is not an argument — the first version of this counter said 3 here and let a stripped AAD through',
    ).toBe(2);
    const explicit = 'encryptPlatformSecret(pt, key, undefined)';
    expect(
      passesNoContext(argSegments(explicit, explicit.indexOf('(')) ?? []),
      'an explicit `undefined` third argument is the unbound call now that the parameter is required',
    ).toBe(true);
    expect(
      passesNoContext(argSegments(bound, bound.indexOf('(')) ?? []),
      'a real context is not an unbound call',
    ).toBe(false);
  });

  it('every encrypt and decrypt passes an authenticated context, except the sites listed with a reason. Omitting it is one token and the type system permits it; what it produces is ciphertext that decrypts under any record, for any account.', () => {
    const unexplained = contextFree
      .filter((s) => !ALLOWED.some((a) => a.file === s.rel && a.fn === s.fn))
      .map(
        (s) =>
          `${s.rel}:${s.line} ${s.fn} passes no authenticated context — third argument is ${s.segs[2] ?? '<absent>'}`,
      );
    expect(
      unexplained.sort(),
      'an at-rest secret is encrypted or read without binding the record it belongs to',
    ).toEqual([]);
  });

  it('CRITICAL every cipher construction binds, whichever mechanism it uses. The call-site arm above only sees `encryptPlatformSecret`, and four other modules build their own ciphers — livekit calls setAAD unconditionally, byok builds its AAD from a validated accountId, and profile-key-hierarchy binds in the KEY. A guard scoped to one helper reads as covering the codebase.', () => {
    const sites = cipherSites();
    expect(
      sites.length,
      'no cipher constructions found — the sweep is measuring nothing',
    ).toBeGreaterThanOrEqual(15);
    const unbound = sites
      .filter((s) => !s.aad && !KEY_BOUND.includes(s.rel))
      .map((s) => `${s.rel}:${s.line} create${s.kind} with no setAAD`);
    expect(
      unbound.sort(),
      'a cipher is constructed without binding the record, and its file is not one that binds by key',
    ).toEqual([]);
  });

  it('every exemption still names a real context-free call. An exemption that outlives the code it excuses is a claim that the codebase is weaker than it is, and it hides the next real one by making the list look maintained.', () => {
    const stale = ALLOWED.filter(
      (a) => !contextFree.some((s) => s.rel === a.file && s.fn === a.fn),
    ).map((a) => `${a.file} ${a.fn} no longer calls without a context — drop the exemption`);
    expect(stale.sort(), 'a listed exemption describes code that no longer exists').toEqual([]);
  });
});
