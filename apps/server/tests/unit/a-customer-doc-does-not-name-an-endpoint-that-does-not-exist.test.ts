// V-984 — the cross-source guard the sweep's action 37 asked for, in the form the
// measurement supports rather than the form it was proposed in.
//
// The proposal was: assert every `/v1/…` path literal in `docs/**` and
// `apps/docs/**` exists in the spec's `paths`. Run as written it produces **144
// distinct misses across 2444 literals** and is unshippable, for three reasons
// that are all correct behaviour rather than drift:
//
//   • `docs/**` is largely dated internal snapshots. They name endpoints that
//     were real when written — `/v1/billing/trial-pack` retired in migration
//     0065, `/v1/proxies`, a dozen more. Action 37's own thesis is that those
//     files are snapshots and should carry a date rather than be line-edited, so
//     failing a suite on them would contradict the finding that proposed this.
//   • "in the spec" is the wrong oracle for "exists". `/v1/webhooks/stripe` is
//     registered and live and deliberately absent from the customer spec. A
//     route can be real and unpublished.
//   • A doc that correctly records a REMOVAL must name the removed path.
//     `reference/metrics.md` says the legacy `/v1/sessions/:id/livekit-token`
//     "was removed" — accurate prose the naive check calls drift.
//
// Narrowed to the surface where a phantom path is a customer-visible defect
// (`apps/docs/src/pages/**`), with "exists" meaning the spec publishes it **or**
// a route registers it, the same scan returns **533 literals and 16 flags, all
// of which are artefacts or correct prose.** That is the honest result: this
// guard is green on arrival. It is worth having anyway — it is the direction
// V-847 does not cover (that one is spec→docs; this is docs→spec), and the
// phantom it was written for, `/v1/captures`, is exactly what it detects.
//
// **The one real finding came from the fourth arm, not the first.** `/v1/whoami`
// is live (`lib/app.ts`), documented for customers in `reference/scopes.md` with
// a response example, and absent from the spec builder and from all three SDKs.
// So a spec-driven client cannot call an endpoint the docs tell customers to
// call, and `docs-response-examples-match-the-spec` cannot check that example
// because it can only see paths the spec knows. Whether to publish it is not a
// test's call; that it stays visible is.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const CUSTOMER_DOCS = resolve(REPO, 'apps/docs/src/pages');
const SPEC_JSON = resolve(REPO, 'packages/sdk-python/openapi.json');

/**
 * Paths a customer doc may name that resolve to no live route, each with the
 * reason it is not drift — and each self-policing, so the exemption lapses if
 * the context that earns it goes away.
 */
const EXEMPT: ReadonlyArray<{
  readonly path: string;
  readonly file: string;
  readonly because: string;
  /** The exemption holds only while this is still true of the file. */
  readonly stillTrue: string;
}> = [
  {
    path: '/v1/models',
    file: 'api/byok-anthropic.md',
    because: "it is Anthropic's endpoint, not ours — the BYOK key test calls it upstream",
    stillTrue: "Anthropic's authenticated `GET /v1/models?limit=1`",
  },
  {
    path: '/v1/sessions/*/livekit-token',
    file: 'reference/metrics.md',
    because: 'the page names it only to record that it was removed (W363 over-grant)',
    stillTrue: 'was removed',
  },
];

/**
 * Live and customer-documented, but not in the published spec.
 *
 * Listed rather than failed: publishing an endpoint is a surface decision. What
 * this pins is that the set does not grow silently.
 *
 * All three are registered, documented on a customer page, and absent from
 * `lib/openapi.ts` — which records no withheld-path list, so nothing states that
 * the omission is deliberate. The cost is the same in each case: a spec-driven
 * client has no generated method, and `docs-response-examples-match-the-spec`
 * cannot check the page's example, because it can only see paths the spec knows.
 */
const DOCUMENTED_BUT_UNPUBLISHED: ReadonlyArray<{
  readonly path: string;
  readonly registeredIn: string;
  readonly documentedIn: string;
}> = [
  { path: '/v1/whoami', registeredIn: 'lib/app.ts', documentedIn: 'reference/scopes.md' },
  {
    path: '/v1/status/stream',
    registeredIn: 'routes/status-stream.ts',
    documentedIn: 'api/status.md',
  },
  {
    path: '/v1/oauth/authorize/complete',
    registeredIn: 'routes/oauth.ts',
    documentedIn: 'api/oauth.md',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(md|mdx|astro)$/.test(p)) out.push(p);
  }
  return out;
}

/** `{id}`, `:id` and concrete example ids all become `*`. */
function normalise(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      if (/^\{[^}]*\}$/.test(seg) || /^:[A-Za-z]/.test(seg)) return '*';
      // an example id: `ses_abc123`, `ord_a1b2c3d4e5f6`, `ses_…`
      if (/^[a-z]{2,8}_/.test(seg)) return seg.includes('.') ? `*.${seg.split('.').pop()}` : '*';
      return seg;
    })
    .join('/')
    .replace(/\/+$/, '');
}

/** Every path the server actually serves — routes/ AND the ones app.ts declares itself. */
function livePaths(): Set<string> {
  const live = new Set<string>();
  const files = readdirSync(resolve(REPO, 'apps/server/src/routes'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => resolve(REPO, 'apps/server/src/routes', f));
  // `/v1/whoami` is registered on the app directly; a routes/-only scan is blind to it.
  files.push(resolve(REPO, 'apps/server/src/lib/app.ts'));
  for (const f of files) {
    // Quotes only, NOT backticks. A comment writing a path in markdown style —
    // `routes/billing.ts` does, as `/v1/billing/*` — is prose, and counting it
    // as a registration inflates the live set. That matters more than it looks:
    // every inflated entry is a phantom path arm 1 would then wave through
    // because somebody mentioned it. Caught by this file's own fourth arm.
    //
    // V-988 — and anchored on the registration call, not merely on a quoted
    // literal. The three SDK path guards each derived "the server has this
    // route" from any quoted `/v1/…` string under `apps/server/src`, which
    // counts a declaration and a policy row as endpoints; this file shipped
    // with the same looseness two commits earlier. Measured when tightening:
    // 210 quoted literals against 209 registrations here, the one difference
    // being a bare `/v1` prefix, so the correction costs nothing and removes a
    // way for a phantom documented path to resolve against a mention.
    for (const m of readFileSync(f, 'utf8').matchAll(
      /app\.(?:get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"](\/v1\/[^'"]*)['"]/g,
    )) {
      live.add(normalise(m[1] ?? ''));
    }
  }
  const spec = JSON.parse(readFileSync(SPEC_JSON, 'utf8')) as { paths: Record<string, unknown> };
  for (const p of Object.keys(spec.paths)) live.add(normalise(p));
  return live;
}

const LITERAL = /\/v1\/[A-Za-z0-9_\-{}:*.,/…]+/g;

/** `{initiate,exchange}` in a doc means two sibling paths. */
function expand(raw: string): string[] {
  const p = raw.replace(/[.,;:)\]]+$/, '').replace(/\/+$/, '');
  const brace = /\{([a-z0-9_-]+(?:,[a-z0-9_-]+)+)\}/i.exec(p);
  return brace ? brace[1]!.split(',').map((alt) => p.replace(brace[0], alt)) : [p];
}

interface Flag {
  readonly path: string;
  readonly file: string;
}

function scan(live: Set<string>): { flags: Flag[]; literals: number; wrapped: number } {
  const flags: Flag[] = [];
  let literals = 0;
  let wrapped = 0;
  const exemptPaths = new Set(EXEMPT.map((e) => e.path));

  for (const abs of walk(CUSTOMER_DOCS)) {
    const rel = abs.slice(REPO.length + 1);
    for (const raw of readFileSync(abs, 'utf8').match(LITERAL) ?? []) {
      for (const one of expand(raw)) {
        // a markdown soft-wrap splits a path across lines: `…/v1/billing/crypto-`
        if (one.endsWith('-')) {
          wrapped += 1;
          continue;
        }
        literals += 1;
        const n = normalise(one);
        if (live.has(n) || exemptPaths.has(n)) continue;
        // prose naming a family: `/v1/admin/*`, or `/v1/auth/mfa` for its children
        const prefix = n.endsWith('/*') ? n.slice(0, -1) : `${n}/`;
        if ([...live].some((p) => p.startsWith(prefix))) continue;
        flags.push({ path: n, file: rel });
      }
    }
  }
  return { flags, literals, wrapped };
}

describe('V-984 a customer doc does not name an endpoint that does not exist', () => {
  const live = livePaths();
  const { flags, literals, wrapped } = scan(live);

  it('CRITICAL every /v1/ path a customer doc names resolves to a route the server serves or the spec publishes. This is the direction V-847 does not run: that one finds published paths no doc mentions, this one finds documented paths nothing serves — a customer following the page gets a 404 from an endpoint that was never built, which is how the sweep found `/v1/captures` in a plan doc.', () => {
    expect(
      flags.map((f) => `${f.path}  (${f.file})`).sort(),
      'these customer-facing docs name a /v1 path that no route registers and the spec does not ' +
        'publish — either the endpoint was removed and the page still promises it, or it was ' +
        'never built:',
    ).toEqual([]);
  });

  it('CRITICAL the scan reaches the customer docs and the resolver resolves, so the arm above cannot pass because it found nothing. Both halves are asserted: a walk that returned no files, or a live-path set that came back empty, would make an empty flag list mean the opposite of what it appears to mean.', () => {
    expect(literals, '/v1 path literals read out of apps/docs/src/pages').toBeGreaterThanOrEqual(
      400,
    );
    expect(live.size, 'live paths (routes + spec)').toBeGreaterThanOrEqual(200);
    expect(walk(CUSTOMER_DOCS).length, 'customer doc pages scanned').toBeGreaterThanOrEqual(40);
    // The resolver must actually resolve a known-good path, not accept everything.
    expect(live.has('/v1/account/me'), 'a path known to exist resolves').toBe(true);
    expect(live.has('/v1/captures'), 'a path known NOT to exist does not resolve').toBe(false);
    expect(wrapped, 'markdown soft-wrapped path fragments skipped').toBeLessThanOrEqual(5);
  });

  it('CRITICAL each exemption still earns itself. An exemption list is where a guard goes to die: the reason that justified one can be edited away and the entry keeps waving the path through. Each is tied to the text that makes it correct, so removing that text removes the exemption with it.', () => {
    const stale: string[] = [];
    for (const e of EXEMPT) {
      const src = readFileSync(resolve(CUSTOMER_DOCS, e.file), 'utf8');
      if (!src.includes(e.stillTrue))
        stale.push(
          `${e.path}: ${e.file} no longer says "${e.stillTrue}" — exemption was: ${e.because}`,
        );
    }
    expect(stale, 'these exemptions no longer hold and must be re-earned or removed:').toEqual([]);
  });

  it('CRITICAL the set of live, customer-documented endpoints the spec does not publish is exactly the listed one. `/v1/whoami` is registered in lib/app.ts, has its own section in reference/scopes.md with a response example, and appears in neither the spec builder nor any of the three SDKs — so a customer told to call it has no generated method for it, and the example on that page is unreachable by docs-response-examples-match-the-spec, which can only check paths the spec knows.', () => {
    const spec = JSON.parse(readFileSync(SPEC_JSON, 'utf8')) as { paths: Record<string, unknown> };
    const published = new Set(Object.keys(spec.paths).map(normalise));

    for (const entry of DOCUMENTED_BUT_UNPUBLISHED) {
      const routeSrc = readFileSync(resolve(REPO, 'apps/server/src', entry.registeredIn), 'utf8');
      const docSrc = readFileSync(resolve(CUSTOMER_DOCS, entry.documentedIn), 'utf8');
      expect(routeSrc, `${entry.path} is still registered in ${entry.registeredIn}`).toContain(
        `'${entry.path}'`,
      );
      expect(docSrc, `${entry.path} is still documented in ${entry.documentedIn}`).toContain(
        entry.path,
      );
      expect(
        published.has(entry.path),
        `${entry.path} is now published in the spec — good; drop it from DOCUMENTED_BUT_UNPUBLISHED`,
      ).toBe(false);
    }

    // and nothing else has quietly joined it
    const documented = new Set<string>();
    for (const abs of walk(CUSTOMER_DOCS)) {
      for (const raw of readFileSync(abs, 'utf8').match(LITERAL) ?? []) {
        for (const one of expand(raw)) documented.add(normalise(one));
      }
    }
    const listed = new Set(DOCUMENTED_BUT_UNPUBLISHED.map((e) => e.path));
    const unlisted = [...documented].filter(
      (p) => live.has(p) && !published.has(p) && !listed.has(p),
    );
    expect(
      unlisted.sort(),
      'these are live and documented for customers but absent from the published spec, so no ' +
        'generated SDK can reach them — list them deliberately or publish them:',
    ).toEqual([]);
  });
});
