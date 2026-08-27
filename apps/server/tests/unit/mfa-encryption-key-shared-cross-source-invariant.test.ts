// Cross-source invariant: the 4 secret-encryption classes (BYOK
// Anthropic + gui_control_key + LiveKit + MFA TOTP) ALL share the
// same MFA_ENCRYPTION_KEY env var as the AES-256-GCM key material.
// Drift on one (e.g. a refactor that introduces a separate
// LIVEKIT_ENCRYPTION_KEY) would break the "single trust boundary"
// + "one rotation rotates all four ciphertexts" guarantee.
//
// The four named above are the ones whose TEXT is pinned here, not the whole
// family: EIGHT modules under apps/server/src define `decodeKey` for this key
// (adding platform-secret, platform-secret-value, webhook-secret and
// recipe-payload), every one is handed `config.mfaEncryptionKey` by bootstrap,
// and `mfaEncryptionKey` is the only encryption-key field config.ts declares —
// so one rotation rotates EIGHT surfaces' ciphertexts. The census-derived arms
// at the foot of this file cover the family; the per-module text pins do not.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BYOK = resolve(REPO_ROOT, 'apps/server/src/lib/byok-anthropic-encryption.ts');
const GCK = resolve(REPO_ROOT, 'apps/server/src/lib/gui-control-key-encryption.ts');
const LK = resolve(REPO_ROOT, 'apps/server/src/lib/livekit-secret-encryption.ts');
const MFA = resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts');
// The four library files above document the shared key; the SHARING itself
// happens where they are wired.
const BOOTSTRAP = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');
const CONFIG = resolve(REPO_ROOT, 'apps/server/src/lib/config.ts');
const SRC_ROOT = resolve(REPO_ROOT, 'apps/server/src');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** Every `*_AAD_PURPOSE` constant declared anywhere under apps/server/src, keyed
 *  by `<relative path>:<constant>`. Derived rather than listed because the drift worth
 *  catching is an ADDITION — a new consumer of the shared key reusing a label
 *  that already means something else.
 *
 *  Keyed by the path RELATIVE TO SRC_ROOT, never the basename: 18 of the 342 files under
 *  apps/server/src share a basename with another (`auth.ts` x3, plus the routes/X.ts +
 *  services/X.ts pairing used throughout). Two same-named files each declaring the bare
 *  `AAD_PURPOSE` collapse to ONE map entry, and the collision arm then passes by losing the
 *  evidence — planting lib/ + services/ copies that share one label was reported 9/9 GREEN
 *  under the old basename key. */
function aadPurposes(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      for (const m of read(p).matchAll(/const\s+([A-Z0-9_]*AAD_PURPOSE)\s*=\s*'([^']*)'/g)) {
        out.set(`${relative(SRC_ROOT, p)}:${m[1] ?? ''}`, m[2] ?? '');
      }
    }
  };
  walk(SRC_ROOT);
  return out;
}

/** Every file under apps/server/src defining `function decodeKey(` — the modules that
 *  decode the shared AES-256 key — keyed by path relative to SRC_ROOT, mapped to source.
 *  Derived by walking rather than listed: the enumerated four-module roster above is half
 *  the real family, and the drift worth catching is a NINTH module joining it. */
function sharedKeyDecoders(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const src = read(p);
      if (/function decodeKey\s*\(/.test(src)) out.set(relative(SRC_ROOT, p), src);
    }
  };
  walk(SRC_ROOT);
  return out;
}

/** Every source file under apps/server/src that reads an `*_ENCRYPTION_KEY`
 *  straight from the environment, keyed by `<rel path>:<env var>`. `config.ts`
 *  is excluded: it is the sanctioned reader, and the arm below pins that it
 *  reads exactly one. Walked rather than read from a two-file list, because a
 *  refactor that gives one class its own key does not have to touch either
 *  bootstrap.ts or config.ts to do it. */
function rogueKeyEnvReads(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (p === CONFIG) continue;
      const rel = p.slice(SRC_ROOT.length + 1);
      // Both spellings: `process.env.X_ENCRYPTION_KEY` and `process.env['X_ENCRYPTION_KEY']`.
      for (const m of read(p).matchAll(
        /process\.env(?:\.([A-Z0-9_]*ENCRYPTION_KEY)\b|\[\s*['"`]([A-Z0-9_]*ENCRYPTION_KEY)['"`]\s*\])/g,
      )) {
        out.push(`${rel}:${m[1] ?? m[2] ?? ''}`);
      }
    }
  };
  walk(SRC_ROOT);
  return [...new Set(out)].sort();
}

describe('MFA_ENCRYPTION_KEY shared 4-class cross-source invariant', () => {
  const byok = read(BYOK);
  const gck = read(GCK);
  const lk = read(LK);
  const mfa = read(MFA);

  it('Each of the 4 lib/* encryption modules references MFA_ENCRYPTION_KEY by name', () => {
    expect(byok).toMatch(/MFA_ENCRYPTION_KEY/);
    expect(gck).toMatch(/MFA_ENCRYPTION_KEY/);
    expect(lk).toMatch(/MFA_ENCRYPTION_KEY/);
    expect(mfa).toMatch(/MFA_ENCRYPTION_KEY/);
  });

  it('Each of the 4 lib/* encryption modules validates the key as 32 bytes (AES-256) with a MFA_ENCRYPTION_KEY-named error message — pinned so the must-decode-to-32-bytes guard stays consistent across the 4 classes (drift would let a smaller-key class silently weaken its security)', () => {
    expect(byok).toMatch(/MFA_ENCRYPTION_KEY must decode to .* bytes; got/);
    expect(gck).toMatch(/MFA_ENCRYPTION_KEY must decode to .* bytes; got/);
    expect(lk).toMatch(/MFA_ENCRYPTION_KEY must decode to .* bytes; got/);
    expect(mfa).toMatch(/MFA_ENCRYPTION_KEY must decode to 32 bytes; got/);
  });

  it("byok-anthropic-encryption explicitly cross-references mfa-totp: 'The same key is used by mfa-totp.ts; rotating MFA_ENCRYPTION_KEY simultaneously rotates both surfaces' ciphertexts.' — pinned so the rotation-rotates-multiple-surfaces guarantee stays documented (drift here is the load-bearing operator-facing rotation-runbook contract)", () => {
    expect(byok).toMatch(
      /The same key is\s*\/\/ used by `mfa-totp\.ts`; rotating MFA_ENCRYPTION_KEY simultaneously\s*\/\/ rotates both surfaces' ciphertexts\./,
    );
  });

  it("livekit-secret-encryption explicitly cross-references the single-trust-boundary contract: 'single host-resident MFA_ENCRYPTION_KEY. The reused key is fine (single trust boundary; rotating MFA_ENCRYPTION_KEY rotates all' — pinned so the cross-reference + single-trust-boundary + rotate-all rationale stays documented", () => {
    expect(lk).toMatch(
      /single host-resident MFA_ENCRYPTION_KEY\. The reused key is fine\s*\/\/ \(single trust boundary; rotating MFA_ENCRYPTION_KEY rotates all/,
    );
  });

  it('gui-control-key-encryption pins the versioned envelope, context-bound AAD, and shared host-key contract', () => {
    expect(gck).toMatch(
      /AES-256-GCM uses a\s*\/\/ versioned `\[magic \| IV \| tag \| ciphertext\]` envelope and canonical\s*\/\/ additional authenticated data \(AAD\) that binds the ciphertext to its\s*\/\/ purpose, owning account, and one agent-session\. Re-uses\s*\/\/ MFA_ENCRYPTION_KEY per Q2=C \(24h-TTL, MFA-key pattern\)\./,
    );
  });

  it("CRITICAL every encryption consumer is wired from config.mfaEncryptionKey at the BOOTSTRAP site, and no second key source exists. The assertions above read the four library files, where `MFA_ENCRYPTION_KEY` appears only in comments and error strings for at least livekit-secret-encryption — so they pass on prose. Verified by mutation: giving LiveKit `process.env.LIVEKIT_ENCRYPTION_KEY ?? config.mfaEncryptionKey` in bootstrap left this file 5/5 GREEN, which is verbatim the refactor the header says it prevents. Breaking this makes 'one rotation rotates all four ciphertexts' silently false.", () => {
    const bootstrap = read(BOOTSTRAP);
    const config = read(CONFIG);

    // Every consumer draws from the one config field.
    const wirings = bootstrap.match(/config\.mfaEncryptionKey/g) ?? [];
    expect(wirings.length, 'bootstrap must wire the shared key to every consumer').toBeGreaterThan(
      5,
    );

    // And no consumer may reach around it to a second env var. `config.ts` is
    // the only place an *_ENCRYPTION_KEY env may be read at all — a claim about
    // the whole tree, so it is checked against the whole tree. V-1529: this
    // scan read only bootstrap.ts, and a service file declaring
    // `process.env.LIVEKIT_ENCRYPTION_KEY` left this file 9/9 GREEN, which is
    // the same refactor the arm title says it caught in bootstrap.
    expect(
      rogueKeyEnvReads(),
      'only config.ts may read an encryption key from the environment; these reach around it:',
    ).toEqual([]);

    // config.ts itself must expose exactly one encryption-key env.
    const configEnvKeys = [
      ...new Set([...config.matchAll(/env\.([A-Z_]*ENCRYPTION_KEY)/g)].map((m) => m[1]!)),
    ];
    expect(configEnvKeys.sort(), 'exactly one encryption-key env may exist').toEqual([
      'MFA_ENCRYPTION_KEY',
    ]);
  });

  // V-1440 — the arms above establish that four domains share ONE key. What
  // makes that safe is domain separation, and this file had no view of it.
  //
  // Separation here is two independent layers, and the distinction matters for
  // how loudly to state this: each module's ciphertext carries its own
  // `*_V2_PREFIX`, and each decryptor rejects a foreign envelope on that prefix
  // BEFORE the AAD is ever evaluated. So substitution through the public API is
  // already blocked at the format layer. The AAD purpose is the second,
  // *cryptographic* half — the one bound into GCM authentication, and the one
  // gui-control-key-encryption's own header calls out as binding a ciphertext
  // "to its purpose". A collision would not be a live vulnerability; it would
  // silently reduce two-layer separation to one, leaving a plaintext format
  // check as the only thing between two domains sharing key material.
  //
  // Each of the four labels is ALREADY guarded against being *changed*, which
  // is why this is scoped to collision: gui-control-key and livekit pin theirs
  // as source text in their content-parity files, and byok and mfa-totp rebuild
  // the AAD from the literal in their behavioural tests, so an edit breaks GCM
  // authentication and reds. What no guard could see is a FIFTH consumer of the
  // shared key reusing an existing purpose — there is no pin for a file that
  // does not exist yet. Hence a derived census rather than a roster.
  const purposes = aadPurposes();

  it('CRITICAL the AAD-purpose census found the domain labels. A census that silently stops matching reports "no collisions" forever — the distinctness arm below cannot fail on an empty map, so this arm is what stands between that and a vacuous pass.', () => {
    expect(
      purposes.size,
      'no *_AAD_PURPOSE constants extracted from apps/server/src',
    ).toBeGreaterThan(9);
  });

  it('CRITICAL no two AAD purpose labels in apps/server/src are equal. Keyed by relative PATH + constant — not by constant name, and not by basename: account-proxy declares its label under the BARE name `AAD_PURPOSE`, and 18 basenames under apps/server/src are non-unique, so a census keyed by either alone drops a second bare declaration and passes by losing the evidence. A duplicate is the one drift the per-module text pins structurally cannot see — each pin asserts its own literal in isolation and has no view of the other eleven.', () => {
    const byValue = new Map<string, string[]>();
    for (const [where, value] of purposes) {
      byValue.set(value, [...(byValue.get(value) ?? []), where]);
    }
    const collisions = [...byValue.entries()]
      .filter(([, sites]) => sites.length > 1)
      .map(([value, sites]) => `${value} <- ${sites.sort().join(', ')}`)
      .sort();
    expect(collisions, 'AAD purpose label(s) reused across domains:').toEqual([]);
  });

  it('CRITICAL the four modules sharing MFA_ENCRYPTION_KEY carry four DIFFERENT AAD purposes. This is the pair that matters most: byok-anthropic-encryption and mfa-totp build identically shaped AAD — `[purpose, 2, accountId]` — from the same key, so for one account the purpose label is the entire cryptographic distance between a stored Anthropic API key and that account TOTP secret. A refactor unifying those two near-identical builders behind a shared default is the realistic way this breaks.', () => {
    const labels = [byok, gck, lk, mfa].map((src) => {
      const m = /const\s+[A-Z0-9_]*AAD_PURPOSE\s*=\s*'([^']*)'/.exec(src);
      return m?.[1] ?? '';
    });
    expect(labels, 'every key-sharing module must declare an AAD purpose').not.toContain('');
    expect(
      new Set(labels).size,
      `the four key-sharing modules must not share an AAD purpose: ${labels.join(', ')}`,
    ).toBe(4);
  });

  it('CRITICAL the shared-key decoder census found the family. The four modules the arms above enumerate are HALF of it: eight files define `decodeKey`, every one is handed `config.mfaEncryptionKey` by bootstrap, and `mfaEncryptionKey` is the only encryption-key field config.ts declares. A census that silently stops matching would make the binding arm below vacuous.', () => {
    expect(
      sharedKeyDecoders().size,
      'no `function decodeKey(` definitions extracted from apps/server/src',
    ).toBeGreaterThan(7);
  });

  it('CRITICAL every module decoding the shared key binds an AAD — either declaring its own *_AAD_PURPOSE label, or taking the context from its caller through an `authenticatedContext` parameter. Keyed by REASON, not by filename: the single module declaring no label is exactly the one whose AAD is caller-supplied, so the exemption states why it is exempt instead of naming it. This is the drift the arms above cannot see — they pin four of the eight, and a label that stops EXISTING leaves the distinctness census smaller but still collision-free.', () => {
    const unbound = [...sharedKeyDecoders()]
      .filter(
        ([, src]) =>
          !/const\s+[A-Z0-9_]*AAD_PURPOSE\s*=/.test(src) && !/authenticatedContext/.test(src),
      )
      .map(([rel]) => rel)
      .sort();
    expect(unbound, 'module(s) decoding the shared key with no AAD binding:').toEqual([]);
  });

  it('the caller-supplied-AAD exemption cannot rot: at least one shared-key decoder must actually rely on it. If every module grows its own label this drops to zero, and the exemption clause above becomes dead text that would silently excuse a future module — delete the clause on that day rather than carrying an untested branch.', () => {
    const exempt = [...sharedKeyDecoders()]
      .filter(([, src]) => !/const\s+[A-Z0-9_]*AAD_PURPOSE\s*=/.test(src))
      .map(([rel]) => rel)
      .sort();
    expect(
      exempt.length,
      `shared-key decoders relying on a caller-supplied AAD: ${exempt.join(', ')}`,
    ).toBeGreaterThan(0);
  });
});
