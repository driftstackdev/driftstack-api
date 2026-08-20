// V-1065 — the saved-proxy cap a customer hits is one they can look up first.
//
// `POST /v1/account/me/proxies` refuses past a per-tier ceiling with
// `Proxy limit reached (<cap>). Delete an existing proxy to add another.` The
// ceiling is `PROXIES_PER_TIER`, it varies from 1 on free to 500 on api_scale, and
// until V-1065 no customer-facing page named it — not the API reference, not the
// marketing pricing page. The first way to learn your own limit was to exceed it.
//
// The sibling caps are all published: `TIER_CONCURRENT_SESSION_LIMITS` and
// `PROFILES_PER_TIER` in the usage quota table, session duration in the lifecycle
// guide. This one was the exception, and nothing marked it as one.
//
// ── Two things worth pinning beyond the numbers ────────────────────────────
//
// The status code. Crossing the PROFILE cap returns `429` with the `tier-limit`
// problem type; crossing the PROXY cap returns a plain `400`. Whether that should
// be reconciled is a behaviour question and not this file's business, but a
// customer writing one handler for "I hit a plan ceiling" needs to know the two
// differ, so the page says so and this asserts the page still says it.
//
// The VPN password rule, which is the other thing the page used to get wrong. The
// update section listed three password cases — omit, null, new value — and all
// three are false for a saved `openvpn`/`wireguard` proxy: the handler rejects
// `password` in the body at all, INCLUDING `null`, unless `scheme` and the matching
// config block come with it, because the credential is wrapped together with the
// config. `'password' in body` is the actual test, so clearing is refused for the
// same reason setting is.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountTierSchema, PROXIES_PER_TIER } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/proxies.md');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts');

const doc = (): string => readFileSync(DOC, 'utf8');

/** `| \`tier\` | value |` rows from the saved-proxy cap table. */
function publishedCaps(): Map<string, string> {
  const body = doc();
  const at = body.indexOf('| Tier            | Saved proxies |');
  const out = new Map<string, string>();
  if (at < 0) return out;
  for (const line of body.slice(at).split('\n').slice(2)) {
    const m = /^\|\s*`([a-z_]+)`\s*\|\s*([a-z0-9]+)\s*\|/.exec(line);
    if (m === null) break;
    out.set(m[1]!, m[2]!);
  }
  return out;
}

describe('V-1065 the saved proxy cap is published', () => {
  it('CRITICAL the table was actually parsed. A heading rename or a column change makes the parser return nothing, and a comparison over an empty map agrees with a page that lists no caps at all — which is the state this file was written to end.', () => {
    const caps = publishedCaps();
    expect(caps.size, 'tier rows parsed from the saved-proxy cap table').toBe(
      AccountTierSchema.options.length,
    );
    expect(caps.size, 'tier rows parsed').toBeGreaterThanOrEqual(8);
  });

  it('CRITICAL every tier publishes the cap the server enforces. The route reads PROXIES_PER_TIER and refuses past it; a page naming a different number sends a customer to buy a tier for an allowance it does not carry.', () => {
    const caps = publishedCaps();
    const wrong: string[] = [];
    for (const tier of AccountTierSchema.options) {
      const enforced = PROXIES_PER_TIER[tier];
      const expected = typeof enforced === 'number' ? String(enforced) : 'custom';
      const shown = caps.get(tier);
      if (shown !== expected)
        wrong.push(`${tier}: page says ${String(shown)}, code enforces ${expected}`);
    }
    expect(wrong.sort(), 'the published saved-proxy caps disagree with PROXIES_PER_TIER:').toEqual(
      [],
    );
  });

  it('CRITICAL the page states the refusal a customer actually receives, including that it is a 400 rather than the 429 the profile cap uses. One handler for "I hit a plan ceiling" has to branch on two different shapes, and only the page says so.', () => {
    const body = doc();
    expect(body, 'the exact refusal text is no longer quoted').toMatch(/Proxy limit reached/);
    expect(body, 'the 400-not-429 difference is no longer stated').toMatch(
      /`400`[\s\S]{0,120}not the `429 Tier limit`/,
    );

    // …and the route still refuses that way, so the page is not describing a
    // status code the server stopped sending.
    const route = readFileSync(ROUTE, 'utf8');
    expect(route, 'the route no longer throws BadRequestError for the proxy cap').toMatch(
      /throw new BadRequestError\(\s*\n?\s*`Proxy limit reached/,
    );
  });

  it('CRITICAL the VPN password exception is documented, and it covers clearing as well as setting. The handler tests `password in body`, so sending null is refused for the same reason a new value is — a page that mentioned only replacement would still mislead the customer trying to clear one.', () => {
    const body = doc();
    expect(body, 'the VPN password exception is gone from the update section').toMatch(
      /VPN proxies are different/,
    );
    expect(body, 'the page no longer says null is refused too').toMatch(
      /a new value \*or\* `null`/,
    );

    // The three unconditional bullets must not come back: they were true only for
    // socks5/http, and the section now says which schemes they describe.
    expect(body, 'the password bullets are unconditional again').toMatch(
      /For the password on a \*\*SOCKS5 or HTTP\*\* proxy/,
    );

    const route = readFileSync(ROUTE, 'utf8');
    expect(route, 'the route no longer enforces the VPN password rule').toMatch(
      /A VPN password can only be changed by resubmitting the matching VPN configuration\./,
    );
    expect(
      route,
      "the route stopped testing 'password' in body, so null may now be accepted",
    ).toMatch(/'password' in body/);
  });
});
