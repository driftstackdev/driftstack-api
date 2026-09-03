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
      /throw new BadRequestError\(\s*`Proxy limit reached/,
    );
  });

  it('CRITICAL the VPN password exception is documented, and it covers clearing as well as setting. The handler tests `password in body`, so sending null is refused for the same reason a new value is — a page that mentioned only replacement would still mislead the customer trying to clear one.', () => {
    const body = doc();
    expect(body, 'the VPN password exception is gone from the update section').toMatch(
      /VPN proxies are different/,
    );
    // The emphasis marker is prettier's business — it rewrites `*or*` to `_or_`
    // when it reflows the file, and pinning either spelling makes this arm fail on
    // a formatting pass rather than on a claim changing. Match the words.
    expect(body, 'the page no longer says null is refused too').toMatch(
      /a new value [*_]or[*_] `null`/,
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

  it('CRITICAL V-1067 the page documents the 409 the update can return, and the route still returns it. The PUT is a compare-and-set on `scheme`, so a concurrent change refuses the write rather than applying it to a proxy the caller no longer recognises. A customer who is not told cannot write the re-read-and-retry their integration needs, and the failure looks like an intermittent rejection with no stated cause.', () => {
    const body = doc();
    expect(body, 'the 409 is no longer documented on the update section').toMatch(
      /`409` — `Proxy changed concurrently\. Retry the update\.`/,
    );
    expect(body, 'the compare-and-set mechanism is no longer explained').toMatch(
      /compare-and-set on `scheme`/,
    );
    // The 404/409 distinction is the half a caller acts on: retry one, stop on
    // the other. The integration suite pins the same distinction behaviourally.
    expect(body, 'the page no longer separates the still-there 409 from the gone 404').toMatch(
      /`409` here means the row still exists; a `404` means it is gone/,
    );

    const route = readFileSync(ROUTE, 'utf8');
    expect(route, 'the route no longer throws the concurrent-change conflict').toMatch(
      /throw new ConflictError\('Proxy changed concurrently\. Retry the update\.'\)/,
    );
    expect(
      route,
      'the update no longer passes expectedScheme, so there is no compare-and-set to document',
    ).toMatch(/expectedScheme: existing\.scheme/);
  });
  it('CRITICAL V-1115 every documented proxy endpoint states the scope it enforces. All five saved-proxy routes require `account_owner`, which a broad `write` key does NOT satisfy, and the page stated it under List alone — so a customer reading Create, Update, Delete or Test saw no scope requirement, minted a `write` key for their automation, and got a 403 the page had not warned about. The requirement is read off the route rather than restated, so the sentence cannot outlive the enforcement.', () => {
    const route = readFileSync(ROUTE, 'utf8');
    const enforced = [
      ...route.matchAll(
        /'(\/v1\/account\/me\/proxies[^']*)',\s*\n\s*\{[^}]*requireScope\('([a-z_]+)'\)/g,
      ),
    ].map((m) => ({ path: m[1] as string, scope: m[2] as string }));
    expect(enforced.length, 'saved-proxy routes with a scope gate').toBeGreaterThanOrEqual(5);

    const scopes = [...new Set(enforced.map((e) => e.scope))];
    expect(scopes, 'the saved-proxy routes no longer agree on one scope').toEqual([
      'account_owner',
    ]);

    // One "Required scope" line per documented endpoint section. `Resource
    // shape`, `Route a session through a proxy` and `Why a launch is refused`
    // are prose, not endpoints, so the count is the endpoint sections.
    const page = doc();
    const stated = (page.match(/Required scope: `account_owner`/g) ?? []).length;
    expect(
      stated,
      'a documented saved-proxy endpoint is missing its scope line — List, Create, Update, Delete ' +
        'and Test each enforce account_owner:',
    ).toBeGreaterThanOrEqual(5);
    expect(page, 'the write-key caveat is gone, which is the part that stops the 403').toMatch(
      /a broad `write` key is not sufficient/,
    );
  });

  it(`CRITICAL the page says what kind of proxy works BEFORE the customer buys one: a public address, username/password rather than an IP allowlist, and a scheme that can carry a session. Profiles run on Driftstack's servers, so a proxy on the customer's own network, or one that admits only their IP, passes the desktop app's local test and fails every launch (owner: "do not confuse a customer that they could add a local proxy and later find out it doesn't work"). The public-address claim is read against the route that enforces it, so the sentence cannot outlive the guard.`, () => {
    const page = doc();
    const start = page.indexOf('## What kind of proxy works');
    expect(
      start,
      'the "What kind of proxy works" section is gone from api/proxies.md',
    ).toBeGreaterThan(0);
    // The section is the text up to the next h2 — the claims must sit INSIDE
    // it, not anywhere on a page that mentions localhost elsewhere.
    const rest = page.slice(start + 1);
    const nextHeading = rest.search(/\n## /);
    const section = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
    const bullets = section.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets.length, 'the section no longer lists its three requirements as bullets').toBe(3);
    // `\s+` between words: prettier reflows this page at 80 columns, so any of
    // these spaces may be a line break tomorrow without the claim changing.
    expect(section, 'the public-address requirement is gone').toMatch(
      /\*\*A\s+public\s+address\.\*\*/,
    );
    expect(section, 'localhost is no longer named as what does not work').toMatch(/`localhost`/);
    expect(section, 'the user/pass requirement is gone').toMatch(
      /\*\*Username\s+and\s+password\s+authentication\.\*\*/,
    );
    expect(section, 'the page no longer says IP-allowlist access does not work').toMatch(
      /IP-allowlist\s+access\s+does\s+not\s+work/,
    );
    expect(
      section,
      'the page no longer says WHY: profiles run from our servers, not the customer IP',
    ).toMatch(/profiles\s+run\s+from\s+Driftstack's\s+servers,\s+not\s+from\s+your\s+IP/);
    expect(section, 'the schemes that can carry a session are gone').toMatch(
      /\*\*SOCKS5,\s+OpenVPN,\s+or\s+WireGuard\.\*\*/,
    );
    // VACUITY CONTROL — the slice stopped at the next h2. The create-time
    // "Host safety" paragraph lives under Create; if it shows up here the slice
    // ran on, and the arms above could pass on prose this section never held.
    expect(section, 'the section slice ran past its own h2').not.toMatch(/Host safety/);

    // …and the route still refuses a private host, so "a public address" is a
    // rule the server enforces rather than advice the page gives.
    const route = readFileSync(ROUTE, 'utf8');
    expect(route, 'the route no longer classifies the proxy host before storing it').toMatch(
      /classifyUnsafeHost\(host\)/,
    );
    expect(route, 'the route no longer refuses a private proxy host').toMatch(
      /Proxy host must not target a private, loopback, link-local, or metadata address\./,
    );
  });
});
