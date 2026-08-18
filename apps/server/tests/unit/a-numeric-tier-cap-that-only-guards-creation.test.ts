// The numeric half of the tier caps, which the boolean guard cannot see.
//
// `every-boolean-tier-feature-is-enforced` says its own scope out loud: it
// derives boolean fields off `TierFeatures`, and its header tells the story that
// motivates it twice over. The second telling (V-786) is the one that matters
// here:
//
//   an account that registered a VPN profile while paid and then downgraded to
//   free kept egressing through it, because nothing on the launch path looked
//   and the tier-change handler audits and emails without touching
//   `account_proxies`. Enforced-on-write and enforced-where-it-matters are
//   different properties.
//
// That is exactly right, and it is not a fact about booleans. The numeric caps —
// `concurrentSessions`, `profiles`, and the session-minutes cap beside them —
// have the same two halves and nothing had asked the question of them.
//
// MEASURED. Every resolution of a numeric cap in the server is a CREATE gate:
//
//   concurrentSessionLimitFor  sessions.ts create, agent-sessions.ts create
//   profileLimitFor            profiles create / restore / transfer x4,
//                              profile-snapshots create
//   maxSessionMinutesFor       sessions create — AND session-duration-sweeper
//
// The last one is the shape the others are measured against: a create gate plus
// something that keeps looking. `maxSessionMinutes` is enforced on a session
// that is already running, so a tier change reaches it.
//
// `profiles` has no such thing, and `profileLimitFor`'s own comment says so:
// "enforced at the /v1/profiles creation gate". So an account that created 500
// profiles on api_scale and downgrades to free — cap 1 — keeps all 500, fully
// usable: it can bind them to sessions, load them and save them. Only creating
// the next one is refused. In the words of the boolean guard's header, that is
// "the paid tiers' differentiator" not being real, and it is a commercial leak
// rather than a security one: subscribe for a month, create the profiles,
// downgrade, keep them.
//
// `concurrentSessions` is create-only too, and that one is defensible without a
// decision: sessions end. A downgraded account is over the cap until its live
// sessions finish and cannot start more. It drains on its own; profiles do not.
//
// THIS FILE DOES NOT PICK THE FIX. Deleting a customer's profiles on downgrade
// destroys data they may be paying to get back; freezing them, refusing to bind
// them to sessions, or granting a grace window are all defensible and all have
// a support and a refund story attached. Choosing among those is a product call.
// Recording that the call is open, and that `profiles` is the cap it applies to,
// is not.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');
const COMMON = resolve(REPO_ROOT, 'packages/api-types/src/common.ts');

/**
 * Numeric caps with no enforcement outside the create path, and the reading of
 * each. `OPEN` marks one where the consequence is a live commercial gap and the
 * remedy is a product decision that has not been made.
 */
const CREATE_ONLY_CAPS = new Map<string, string>([
  [
    'concurrentSessions',
    'drains — a downgraded account is over the cap only until its live sessions end, and cannot start more',
  ],
  [
    'profiles',
    'OPEN — a stored profile outlives the tier that allowed it. 500 profiles created on api_scale stay usable on free (cap 1); only the next create is refused',
  ],
]);

/** Non-boolean fields of `TierFeatures` — the half the boolean guard excludes. */
function numericFeatures(): string[] {
  const src = readFileSync(COMMON, 'utf8');
  const start = src.indexOf('export interface TierFeatures');
  const block = src.slice(start, src.indexOf('\n}', start));
  return [...block.matchAll(/^\s*([a-zA-Z]+)\??: (?:number|number \| 'custom');$/gm)].map(
    (m) => m[1] ?? '',
  );
}

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

/** Server files that resolve a cap helper, excluding the file that defines it. */
function resolutionSites(helper: string): string[] {
  const out: string[] = [];
  for (const file of walk(SERVER_SRC)) {
    const rel = file.slice(SERVER_SRC.length + 1);
    const src = codeOnly(readFileSync(file, 'utf8'));
    if (!new RegExp(`\\b${helper}\\(`).test(src)) continue;
    if (new RegExp(`export function ${helper}\\(`).test(src)) continue;
    if (/^import /m.test(src) && !new RegExp(`${helper}\\([^)]`).test(src)) continue;
    out.push(rel);
  }
  return [...new Set(out)].sort();
}

/**
 * A file enforces a cap on something ALREADY RUNNING when it is a sweeper or a
 * poller rather than a request path. That is the distinction V-786 named, and it
 * is not derivable from a call-site count — it is derivable from what the file
 * IS.
 */
const isOngoingEnforcer = (rel: string): boolean => /sweep|sweeper|poller|reconcile/.test(rel);

describe('a numeric tier cap that only guards creation', () => {
  it('CRITICAL the interface still has the numeric fields this file is about. Everything below is derived from TierFeatures, so a rename that emptied the list would report perfect compliance over nothing.', () => {
    const numeric = numericFeatures();
    expect(numeric, 'numeric TierFeatures fields').toEqual(
      expect.arrayContaining(['concurrentSessions', 'profiles']),
    );
    expect(numeric.length, 'numeric fields found').toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL every numeric cap is either enforced on something already running, or recorded as create-only with the consequence. `maxSessionMinutes` is the control: it has a create gate AND a duration sweeper, so a tier change reaches a session that is already open. A cap without that second half is not wrong by itself — it is unexamined, which is how vpnEgress survived a downgrade for months.', () => {
    const unrecorded = numericFeatures().filter((f) => !CREATE_ONLY_CAPS.has(f));
    expect(
      unrecorded,
      'numeric tier cap(s) with no recorded reading. Say whether anything enforces it after the ' +
        'resource exists, and if nothing does, say what a downgraded account keeps:',
    ).toEqual([]);
  });

  it('CRITICAL the profiles cap really is create-only, so the OPEN entry is describing today. If a use-path or a sweeper starts enforcing it, this entry becomes a stale claim that the gap is still there — which is the direction that makes a roster stop being read.', () => {
    const sites = resolutionSites('profileLimitFor');
    expect(sites.length, 'files resolving the profile cap').toBeGreaterThan(1);
    expect(
      sites.filter(isOngoingEnforcer),
      'the profiles cap is now enforced outside a create path — update CREATE_ONLY_CAPS, the OPEN entry no longer describes the code:',
    ).toEqual([]);
  });

  it('CRITICAL maxSessionMinutes still has its ongoing enforcer. It is the only numeric cap that keeps looking after the resource exists, and this file measures the others against it — if the sweeper goes, the comparison silently becomes "nothing enforces any of them" and every entry above still reads as fine.', () => {
    const sites = resolutionSites('maxSessionMinutesFor');
    expect(
      sites.filter(isOngoingEnforcer),
      'the session-duration cap lost its sweeper — the control this file compares against is gone:',
    ).not.toEqual([]);
  });

  it('CRITICAL the tier-change handlers still do not touch the capped resources, which is what makes the OPEN entry true rather than merely unverified. V-786 named this exact shape: the handler "audits and emails without touching account_proxies". If a handler starts reconciling profiles, the entry above is what needs editing.', () => {
    const handlers = ['services/stripe-webhooks.ts', 'services/admin-accounts.ts'];
    for (const rel of handlers) {
      const src = codeOnly(readFileSync(resolve(SERVER_SRC, rel), 'utf8'));
      expect(
        /profileLimitFor|purgeProfiles|reconcileProfiles/.test(src),
        `${rel} now reconciles profiles on a tier change — CREATE_ONLY_CAPS needs updating`,
      ).toBe(false);
    }
  });
});
