// A team-scoped write owns the resource on the OWNER and gates it on a tier.
// Passing one without the other gates the owner's resource by the CALLER's tier.
//
// Three service methods take both — `SessionsService.create`,
// `ApiKeysService.create` and `.rotate` — and each resolves them independently:
//
//     const accountId = opts.effectiveAccountId ?? ctx.account.id;
//     const tier      = opts.effectiveTier      ?? ctx.account.tier;
//
// So `{ effectiveAccountId: owner.id }` alone creates the resource on the
// owner's account and applies the caller's limits to it. For api-keys that is
// the test/live minting switch — the comment beside it says "a member acting for
// an api_starter owner mints ds_live_… keys; member's own tier doesn't matter" —
// and for sessions it is the concurrency cap. In both directions: a member on a
// free personal account acting for a paid owner gets free limits on the owner's
// resource, and a member on a paid account acting for a free owner gets paid
// ones.
//
// All four call sites pass both today. Nothing made them: two independent
// optional fields make the mismatch a perfectly well-typed call, and the pairing
// lived in prose beside each resolution.
//
// It is a TYPE now — `EffectiveOwner`, a union of both-or-neither — so the
// mistake cannot be written. The two `admin.ts` locals were the interesting part
// of landing it: their VALUES were always set together, but they were DECLARED
// as two optionals, so the pairing was lost the moment it left the if-block. The
// compiler said so as soon as the union existed, which is the whole point.
//
// This file is the part a type cannot do: it fails if a fourth method starts
// taking the two fields loose again, or if one of these three goes back. A
// signature is easy to widen back to `effectiveAccountId?: string;
// effectiveTier?: AccountTier` while every existing caller keeps compiling, and
// nothing else in the suite would notice.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/** Methods that own on an account AND gate on a tier. */
const PAIRED_METHODS = ['services/sessions.ts', 'services/api-keys.ts'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/**
 * Anywhere the two fields are declared as SEPARATE optional members — the shape
 * that lets them be passed apart. `EffectiveOwner` itself is the one place the
 * names may sit beside each other, because there they are a union.
 */
function looseDeclarations(): string[] {
  const out: string[] = [];
  for (const file of walk(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (rel === 'lib/effective-account-header.ts') continue;
    const src = codeOnly(readFileSync(file, 'utf8'));
    // `effectiveAccountId?: string` on its own line, with `effectiveTier?:`
    // within a few lines — a hand-rolled pair rather than the union.
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/effectiveAccountId\?:\s*string/.test(lines[i] ?? '')) continue;
      const near = lines.slice(Math.max(0, i - 4), i + 5).join('\n');
      if (/effectiveTier\?:\s*AccountTier/.test(near)) out.push(`${rel}:${String(i + 1)}`);
    }
  }
  return out.sort();
}

describe('the team-owner pair cannot be split', () => {
  it('CRITICAL the union exists and is both-or-neither. Everything below rests on it; a `Partial<…>` or two optional members would compile every call site the same way and enforce nothing.', () => {
    const lib = readFileSync(resolve(SRC, 'lib/effective-account-header.ts'), 'utf8');
    expect(lib, 'EffectiveOwner is gone').toMatch(/export type EffectiveOwner\s*=/);
    // The both-arm requires both. The neither-arm forbids both.
    expect(lib, 'the both-arm must make each field required').toMatch(
      /\{\s*effectiveAccountId:\s*string;\s*effectiveTier:\s*AccountTier;?\s*\}/,
    );
    expect(lib, 'the neither-arm must type each field as undefined, not optional-any').toMatch(
      /\{\s*effectiveAccountId\?:\s*undefined;\s*effectiveTier\?:\s*undefined;?\s*\}/,
    );
  });

  it('CRITICAL every service that gates on an effective tier takes the pair as one type. Widening a signature back to two optionals leaves every existing caller compiling — so the regression is invisible to the compiler and to every other test, and shows up only as a customer on the wrong limits.', () => {
    for (const rel of PAIRED_METHODS) {
      const src = codeOnly(readFileSync(resolve(SRC, rel), 'utf8'));
      expect(src, `${rel} no longer takes EffectiveOwner`).toMatch(/opts:\s*EffectiveOwner/);
    }
  });

  it('CRITICAL nothing anywhere declares the two fields as separate optionals. That includes route locals: admin.ts held both in a `let` typed as two optionals, so the values were paired and the TYPE was not — the pairing was lost the moment the object left its if-block.', () => {
    expect(
      looseDeclarations(),
      'the effective account/tier pair is declared loose here — use EffectiveOwner, or the two ' +
        'can be passed apart and the owner gets the caller’s tier:',
    ).toEqual([]);
  });

  it('CRITICAL both resolutions are still there to be protected. The pair only matters because each field is defaulted independently; if a method stopped reading one of them this file would be guarding a shape nothing uses, which is how a guard becomes decoration.', () => {
    const sessions = codeOnly(readFileSync(resolve(SRC, 'services/sessions.ts'), 'utf8'));
    const keys = codeOnly(readFileSync(resolve(SRC, 'services/api-keys.ts'), 'utf8'));
    for (const [name, src] of [
      ['sessions', sessions],
      ['api-keys', keys],
    ] as const) {
      expect(src, `${name} no longer defaults the account id`).toMatch(
        /opts\.effectiveAccountId \?\? ctx\.account\.id/,
      );
      expect(src, `${name} no longer defaults the tier`).toMatch(
        /opts\.effectiveTier \?\? ctx\.account\.tier/,
      );
    }
  });
});
