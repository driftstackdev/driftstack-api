// V-1015 — no shipped source describes the team auth-path integration as future work.
//
// The team-RBAC auth path shipped. `services/auth.ts` loads memberships on every
// authenticated path, and `resolveEffectiveAccount` looks the requested account
// up in `ctx.teams` and returns `kind: 'team'` with the member's role, or 403s.
//
// The sentence saying otherwise outlived it in three separate waves, and each
// wave was found only because someone went looking for that wave:
//
//   V-1010 — the three SDK team RESOURCE files.
//   V-1015 — the three SDK CLIENT files, four occurrences, including both the
//            sync and async Python constructors.
//   V-1015 — `lib/app.ts`, `lib/openapi.ts`, `lib/bootstrap.ts`, which the first
//            two waves had deliberately deferred because each carried a TRUE
//            qualifier next to the false framing.
//
// Three waves for one fact is what a per-file negative buys you. Every one of
// those files had a content-parity pin, and every pin was green, because a pin
// asserts what its own file says and no pin asks the question this file asks.
// So this is the question, once, over every shipped source tree.
//
// It reads RAW source deliberately — no comment stripping. The claim being
// policed IS a comment, and V-1014 is the entry that says a gate asking whether
// a claim is still WRITTEN wants the prose, while a gate asking what the code
// DOES does not. Stripping comments here would make this file assert nothing.
//
// Scope is source only. Test files legitimately quote the retracted framing:
// this file quotes it, and so does every per-occurrence negative committed with
// the fixes. A guard that could not tell a retraction from a live claim would
// force the record to be deleted to stay green — the collision this sweep has
// hit four times.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** Shipped source trees. Tests excluded — see the header. */
const SOURCE_ROOTS = [
  'apps/server/src',
  'apps/customer-dashboard/src',
  'apps/docs/src',
  'packages/sdk-typescript/src',
  'packages/sdk-python/src',
  'packages/sdk-go',
  'packages/api-types/src',
];

/**
 * Phrasings that describe the integration as not yet done.
 *
 * `V-298d` is the anchor the whole framing hung from: it named a slice that was
 * going to wire the auth path, so any surviving mention in shipped source is
 * either the stale promise itself or a pointer to it.
 */
const PENDING_FRAMINGS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: 'the V-298d slice anchor', re: /V-298d/ },
  {
    label: 'an auth path that does not yet honor membership',
    re: /not yet honor team membership/i,
  },
  { label: 'permissions deferred to a later slice', re: /permissions are next-slice/i },
  { label: 'membership described as granting no permissions at all', re: /until V-298d ships/i },
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|py|go|astro|md|mdx)$/.test(p)) out.push(p);
    }
  };
  for (const root of SOURCE_ROOTS) walk(resolve(REPO_ROOT, root));
  return out;
}

describe('V-1015 the team auth path is not described as pending', () => {
  const files = sourceFiles();

  it('CRITICAL the scan reaches every shipped source tree and the matchers discriminate. A walk that found nothing, or a matcher that never fires, would make the arm below pass for a repo that still says the integration is coming — which is the exact state this file was written after finding three times.', () => {
    expect(files.length, 'source files walked').toBeGreaterThanOrEqual(300);
    for (const root of SOURCE_ROOTS) {
      expect(
        files.some((f) => f.includes(root.replace(/\//g, '/'))),
        `no files walked under ${root} — the path moved and this guard silently stopped covering it`,
      ).toBe(true);
    }
    // The matchers fire on the retracted sentences and not on the corrected ones.
    const retracted = [
      'V-298c — Team RBAC. Auth path integration is V-298d.',
      'The auth path itself does NOT yet honor team membership (V-298d)',
      'Routes work; permissions are next-slice.',
    ];
    for (const sentence of retracted) {
      expect(
        PENDING_FRAMINGS.some((f) => f.re.test(sentence)),
        `no matcher fires on: ${sentence}`,
      ).toBe(true);
    }
    const corrected =
      "Team membership IS honored on the auth path: a member acts on the owner's account by " +
      'sending X-Driftstack-Account, bounded by membership role and required scope.';
    for (const { label, re } of PENDING_FRAMINGS) {
      expect(re.test(corrected), `${label} matches the CORRECTED wording`).toBe(false);
    }
  });

  it('CRITICAL no shipped source says the team auth-path integration is still to come. It shipped; a customer reading an SDK field comment that calls it future work will not send the header that makes team access work, and an engineer reading the server comment will not know the path they are editing is load-bearing.', () => {
    const offenders: string[] = [];
    for (const path of files) {
      const raw = readFileSync(path, 'utf8');
      for (const { label, re } of PENDING_FRAMINGS) {
        if (re.test(raw)) offenders.push(`${path.slice(REPO_ROOT.length + 1)} — ${label}`);
      }
    }
    expect(
      offenders.sort(),
      'these shipped sources describe the team auth-path integration as pending. It is not: ' +
        'services/auth.ts resolves memberships and resolveEffectiveAccount maps ' +
        'X-Driftstack-Account to the owner account and role:',
    ).toEqual([]);
  });

  it('CRITICAL the fact this file is derived from is still true. If the auth path ever stops honoring membership, the arm above becomes a rule against writing down something TRUE — so it fails here first, pointing at the code rather than the prose.', () => {
    const auth = readFileSync(resolve(REPO_ROOT, 'apps/server/src/services/auth.ts'), 'utf8');
    expect(auth, 'auth.ts no longer loads team memberships').toMatch(/findTeamMemberships\(/);
    expect(auth, 'resolveEffectiveAccount no longer consults ctx.teams').toMatch(
      /ctx\.teams\.find\(/,
    );
    expect(auth, 'resolveEffectiveAccount no longer returns a team-kind grant').toMatch(
      /kind: 'team'/,
    );
  });
});
