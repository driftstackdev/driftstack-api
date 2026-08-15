// Every boolean tier feature is either enforced somewhere, or explicitly recorded as not.
//
// `TIER_FEATURES` is rendered to customers: `apps/customer-dashboard/src/pages/select-tier.astro`
// reads the flags directly and paints the pricing table's Access column from them. So a flag set
// `false` on a tier is a published statement about what that tier cannot do. If nothing enforces
// it, the statement is decoration — and in the direction that matters commercially, because the
// paid tiers' differentiator is what stops being real.
//
// That is what happened to `vpnEgress`. Its own doc comment says "OpenVPN / WireGuard egress
// profiles allowed on this tier. `false` on free (SOCKS5 proxy only)". Nothing checked it: a free
// account could register an OpenVPN or WireGuard proxy and egress through it end-to-end. The
// registration paths now gate on it (`routes/account-me.ts`), and this file exists so the next
// boolean feature added to the interface cannot repeat the omission silently.
//
// V-786 — and then it happened again, to the same flag, in the half this file could not see.
// Counting call sites answers "is it enforced ANYWHERE". `vpnEgress` had two, so it read as done.
// But both were on the path that CREATES a proxy, and a stored proxy outlives the tier that was
// allowed to store it: an account that registered a VPN profile while paid and then downgraded to
// free kept egressing through it, because nothing on the launch path looked and the tier-change
// handler audits and emails without touching `account_proxies`. Enforced-on-write and
// enforced-where-it-matters are different properties, and a call-site count cannot distinguish
// them — the last case below asserts the second one directly, per feature, because there is no
// derivation that can tell a create path from a use path by reading a call site.
//
// Deliberately derived, not a literal roster: the feature names come from the `TierFeatures`
// interface and the enforcement sites from the server's own call sites, so adding a flag is
// enough to bring it into scope.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');
const COMMON = resolve(REPO_ROOT, 'packages/api-types/src/common.ts');

/**
 * Features with no enforcement site, each with the reason it is acceptable. Empty is the goal.
 * An entry is a claim that no customer-visible promise depends on the flag — not that wiring it
 * is inconvenient.
 */
const UNENFORCED_BY_DESIGN: Record<string, string> = {};

/** Boolean fields of the `TierFeatures` interface. */
function booleanFeatures(): string[] {
  const src = readFileSync(COMMON, 'utf8');
  const start = src.indexOf('export interface TierFeatures');
  const block = src.slice(start, src.indexOf('\n}', start));
  return [...block.matchAll(/^\s*([a-zA-Z]+)\??: boolean;/gm)].map((m) => m[1]!);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'migrations' || entry === 'node_modules') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * One enforcement call, with its feature literal.
 *
 * V-786a — one level of nesting is allowed between the opening paren and the
 * literal. The original `\([^)]*?'([a-zA-Z]+)'` terminates on the FIRST `)`, so
 * it could not see `requireTierFeature(requireCtx(req).account.tier, 'aiAgent')`,
 * a real call site in `routes/agent-sessions.ts`. Under-counting is the safe
 * direction for the two roster cases (a missed site reports a feature as
 * unenforced — a false alarm someone would notice), but the use-path case asks
 * whether a SPECIFIC file enforces a feature, and there an invisible call site is
 * a false failure that would push someone to add a duplicate check.
 *
 * Shared with the call-shape case below on purpose: a fixture asserted against a
 * SECOND copy of this pattern would only prove the copy works.
 */
const ENFORCEMENT_CALL =
  /(?:requireTierFeature|tierHasFeature)\((?:[^()']|\([^()]*\))*'([a-zA-Z]+)'/g;

/**
 * Features the server actually gates on. Both helpers count: `requireTierFeature` throws 403,
 * and `tierHasFeature` is the branching form used where a throw is the wrong shape.
 */
function enforced(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const file of walk(SERVER_SRC)) {
    const rel = file.slice(REPO_ROOT.length + 1);
    // The helpers' own definitions are not enforcement sites.
    if (rel.endsWith('lib/errors-helpers.ts')) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(ENFORCEMENT_CALL)) {
      const list = sites.get(m[1]!) ?? [];
      list.push(rel);
      sites.set(m[1]!, list);
    }
  }
  return sites;
}

describe('every boolean tier feature is enforced somewhere', () => {
  const features = booleanFeatures();
  const sites = enforced();

  it('CRITICAL both derivations found real data. An empty feature list or an empty call-site map would make the check below pass by comparing nothing to nothing, which is the failure mode this file is about.', () => {
    expect(features.length, 'boolean fields on TierFeatures').toBeGreaterThanOrEqual(3);
    expect(features, 'the flag this file was written for').toContain('vpnEgress');
    expect([...sites.keys()].sort(), 'features with at least one enforcement site').toEqual(
      expect.arrayContaining(['aiAgent', 'apiAccess']),
    );
  });

  it('CRITICAL no boolean tier feature is published as a tier difference while nothing enforces it. The pricing table paints its Access column straight from these flags, so an unenforced `false` is a paid-tier differentiator that does not exist.', () => {
    const unenforced = features
      .filter((f) => !sites.has(f))
      .filter((f) => UNENFORCED_BY_DESIGN[f] === undefined)
      .sort();

    expect(
      unenforced,
      'boolean tier feature(s) with no requireTierFeature / tierHasFeature site — gate them, or record them in UNENFORCED_BY_DESIGN with the reason no customer promise depends on the flag:',
    ).toEqual([]);
  });

  it('CRITICAL the call-site matcher handles every call SHAPE in this repo, including a nested paren before the feature literal. Everything in this file is derived from that one regex, so a shape it silently skips makes every answer below it partial. Asserted against literal fixtures rather than against the aggregate: my first version of this case checked that agent-sessions.ts appears in the aiAgent site list, which it already did from a DIFFERENT, non-nested call on the same file — green, and blind to the exact regression it was written for.', () => {
    const featuresIn = (source: string): string[] =>
      [...source.matchAll(new RegExp(ENFORCEMENT_CALL.source, 'g'))].map((m) => m[1]!);

    expect(featuresIn("requireTierFeature(ctx.account.tier, 'apiAccess');"), 'plain').toEqual([
      'apiAccess',
    ]);
    expect(
      featuresIn("requireTierFeature(requireCtx(req).account.tier, 'aiAgent');"),
      'nested paren before the literal — the shape the original regex could not see',
    ).toEqual(['aiAgent']);
    expect(featuresIn("tierHasFeature(tier, 'vpnEgress')"), 'the branching form').toEqual([
      'vpnEgress',
    ]);
    expect(
      featuresIn("requireTierFeature(\n  ownerTier,\n  'aiAgent',\n)"),
      'prettier-wrapped across lines',
    ).toEqual(['aiAgent']);

    // And it does not match indiscriminately: a bare literal, or a different
    // function taking one, is not an enforcement site.
    expect(featuresIn("const x = 'vpnEgress';"), 'a bare literal is not a call').toEqual([]);
    expect(featuresIn("logFeature(tier, 'vpnEgress');"), 'a different function is not').toEqual([]);
  });

  it('CRITICAL a feature that gates a STORED resource is enforced where the resource is USED, not only where it is created. This is the half a call-site count cannot see, and it is how vpnEgress broke twice: the create paths gated it, so the flag read as enforced, while every proxy registered before a downgrade stayed usable forever. Nothing about a call site says whether it runs at create time or at use time, so the required use-path site is named per feature.', () => {
    /**
     * Feature → the file that must enforce it on the USE path, and why the create-path
     * check is not sufficient on its own. Only for features that gate a resource which
     * outlives the request that created it.
     */
    const USE_PATH_ENFORCEMENT: Record<string, { file: string; because: string }> = {
      vpnEgress: {
        file: 'apps/server/src/services/account-proxies.ts',
        because:
          'resolveForDispatch is the single choke point that turns a stored account_proxies row ' +
          'into a dispatchable egress config. A downgrade leaves the row in place, so a check ' +
          'only at registration lapses the moment the tier changes.',
      },
    };

    const missing = Object.entries(USE_PATH_ENFORCEMENT)
      .filter(([feature, { file }]) => !(sites.get(feature) ?? []).includes(file))
      .map(
        ([feature, { file, because }]) =>
          `${feature}: expected enforcement in ${file} — ${because}`,
      );

    expect(
      missing,
      'feature(s) gated only where the resource is created, so the entitlement lapses silently on downgrade:',
    ).toEqual([]);

    // Vacuity: the map is only meaningful while its features are real ones.
    for (const feature of Object.keys(USE_PATH_ENFORCEMENT)) {
      expect(features, `${feature} is still a boolean TierFeature`).toContain(feature);
    }
  });

  it('CRITICAL the exemption list may only SHRINK — an entry that becomes enforced must leave it, and an entry naming a flag that no longer exists must go too.', () => {
    const nowEnforced = Object.keys(UNENFORCED_BY_DESIGN)
      .filter((f) => sites.has(f))
      .sort();
    expect(nowEnforced, 'these are enforced now — remove them from UNENFORCED_BY_DESIGN:').toEqual(
      [],
    );

    const stale = Object.keys(UNENFORCED_BY_DESIGN)
      .filter((f) => !features.includes(f))
      .sort();
    expect(stale, 'exemption(s) for flags that are no longer boolean TierFeatures:').toEqual([]);
  });
});
