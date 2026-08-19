// V-755 — every STRIPE_* env var an operator is told to set must be one the server reads.
//
// Found by auditing operator runbooks against implementation: three deployment docs told
// an operator to set `STRIPE_WEBHOOK_SIGNING_SECRET`, in four places, including the two
// worst possible ones — the "signature verification is failing" troubleshooting step in
// `runbook.md` and the compromised-credential rotation scenario in `dr-runbook.md`.
//
// `config.ts` reads `STRIPE_WEBHOOK_SECRET`. The consequence of following the docs is not
// a warning: `app.ts` registers `POST /v1/webhooks/stripe` only when
// `stripeWebhookSigningSecret` is provided, and `bootstrap.ts` sources that from
// `config.stripe.webhookSecret`. With the wrong variable set, the route is never
// registered at all, so Stripe's deliveries hit the global 404 handler — subscription
// events never process and customers pay without being upgraded.
//
// The name almost certainly drifted because the SERVER-INTERNAL dep is called
// `stripeWebhookSigningSecret` while the ENV VAR is `STRIPE_WEBHOOK_SECRET`. That
// mismatch is a standing trap, which is why this is a guard and not just a fix.
//
// Scope note: this checks the STRIPE_* family only, deliberately. It is a family that is
// wholly owned by `config.ts`, so docs ⊆ code is a sound invariant. A blanket check over
// every env-looking token in the docs is NOT sound — many are legitimately external
// (Cloudflare project ids, Sentry org/project, GitHub Actions vars) and read by nothing in
// this repo, so it would need an allowlist that would itself go stale.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CONFIG = resolve(REPO_ROOT, 'apps/server/src/lib/config.ts');
const DOC_DIRS = ['docs/deployment', 'docs/runbooks', 'docs/operations'];

const STRIPE_ENV = /\bSTRIPE_[A-Z0-9_]+\b/g;

/** STRIPE_* names config.ts actually reads off the env object. */
function namesConfigReads(): Set<string> {
  const src = readFileSync(CONFIG, 'utf8');
  // loadConfig(env) reads `env.STRIPE_X` — not `process.env.STRIPE_X`.
  const reads = src.match(/\benv\.(STRIPE_[A-Z0-9_]+)/g) ?? [];
  return new Set(reads.map((r) => r.replace('env.', '')));
}

function docFiles(): string[] {
  const out: string[] = [];
  for (const d of DOC_DIRS) {
    const abs = resolve(REPO_ROOT, d);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) if (f.endsWith('.md')) out.push(resolve(abs, f));
  }
  return out;
}

describe('deployment docs name env vars the server actually reads (V-755)', () => {
  it('CRITICAL every STRIPE_* env name in an operator doc is one config.ts reads', () => {
    const known = namesConfigReads();
    // Guard against a vacuous pass: if the extraction breaks, `known` empties and every
    // doc name looks unknown — or worse, a future refactor makes it match nothing and the
    // subset check passes trivially. Both directions are covered by asserting the floor.
    expect(known.size, 'STRIPE_* names extracted from config.ts').toBeGreaterThan(3);
    expect(known.has('STRIPE_WEBHOOK_SECRET')).toBe(true);

    const offenders: string[] = [];
    for (const file of docFiles()) {
      const body = readFileSync(file, 'utf8');
      for (const name of new Set(body.match(STRIPE_ENV) ?? [])) {
        if (known.has(name)) continue;
        // A doc may NAME a wrong variable in order to warn against it. Allow that only
        // when the file also explains the consequence.
        if (body.includes('leaves the endpoint UNREGISTERED')) continue;
        offenders.push(`${file.replace(`${REPO_ROOT}/`, '')}: ${name}`);
      }
    }

    expect(
      offenders,
      'operator doc(s) naming a STRIPE_* env var the server never reads. An operator who ' +
        'sets it gets silence, not an error: with STRIPE_WEBHOOK_SECRET unset, ' +
        'POST /v1/webhooks/stripe is never registered and Stripe deliveries 404, so ' +
        'subscription events never process. Use one of: ' +
        [...known].sort().join(', '),
    ).toEqual([]);
  });

  it('the internal dep name is NOT the env var name — the trap that caused this', () => {
    const config = readFileSync(CONFIG, 'utf8');
    // If someone ever renames the env var to match the internal dep, this test should be
    // deleted along with the guard above. Until then, the asymmetry is real and pinned so
    // a reader does not "helpfully" align the docs to the internal name again.
    expect(config).toMatch(/env\.STRIPE_WEBHOOK_SECRET/);
    expect(config).not.toMatch(/env\.STRIPE_WEBHOOK_SIGNING_SECRET/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V-756 — the same lens on HTTP paths. Five operator docs told an operator to hit
// endpoints that do not exist:
//   • dr-runbook.md named `/v1/version` in THREE places — the DR cutover check and both
//     rollback confirmations. `/version` is deliberately unversioned because the OpenAPI
//     security invariant requires every `/v1/*` path to be authenticated and this one is
//     intentionally public, so `/v1/version` can never exist.
//   • livekit-go-live.md named `/v1/sessions/:id/livekit-token` (real route is
//     `/v1/agent-sessions/:id/livekit-token`) and `/v1/config-summary` (never built).
//   • postmark-go-live.md named `/v1/auth/password/reset/request`; the route is
//     `/v1/auth/password-reset/request` — a hyphen, not a path segment.
//   • cost-monitoring.md gave a curl to `/v1/admin/scheduled-jobs/run-once`; no
//     `/v1/admin/scheduled-jobs/*` route exists at all.
// Every one of these sits in a procedure an operator runs while something is already
// wrong, so the 404 arrives at the worst moment and reads as "the system is broken"
// rather than "the doc is".
// One matcher for both quote styles. The generic parameter must be matched
// permissively: `app.get<{ Querystring: Record<string, string> }>(` contains a nested
// `>`, so a `<[^>]*>` class stops early and the route is MISSED — which made this guard
// flag /v1/auth/oauth/google/callback, a route that genuinely exists (registered in a
// `for (const provider of ['google','github'])` loop over a template literal).
const ROUTE_ANY = /app\.(?:get|post|patch|put|delete)[\s\S]{0,160}?\(\s*\n?\s*(['`])([^'`]+)\1/g;

/** Fastify writes :id, docs write :id or {id}; compare with params erased. */
function normalizePath(p: string): string {
  return p
    .replace(/\{/g, ':')
    .replace(/\}/g, '')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':P')
    .replace(/\/$/, '');
}

function registeredPaths(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const full = resolve(dir, e);
      const st = statSync(full, { throwIfNoEntry: false });
      if (st === undefined) continue;
      if (st.isDirectory()) walk(full);
      else if (e.endsWith('.ts')) {
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(ROUTE_ANY)) {
          const raw = (m[2] as string).replace(/\$\{[^}]+\}/g, ':P');
          if (!raw.startsWith('/')) continue;
          out.add(normalizePath(raw));
        }
      }
    }
  };
  walk(resolve(REPO_ROOT, 'apps/server/src'));
  return out;
}

/**
 * Bare prefixes that appear in PROSE, not as endpoints ("the /v1/admin surface",
 * "/v1/auth flows"). Kept explicit and short on purpose: a broad heuristic here would
 * swallow real misses like /v1/config-summary, which is exactly what this guard is for.
 */
const PROSE_PREFIXES = new Set([
  '/v1/account',
  '/v1/admin',
  '/v1/auth',
  '/v1/auth/oauth',
  '/v1/auth/oauth-client',
  '/v1/payment',
]);

describe('operator docs reference HTTP paths the server registers (V-756)', () => {
  it('CRITICAL every /v1/* or bare-root path in an operator doc resolves to a registered route', () => {
    const registered = registeredPaths();
    // Vacuity guard: if the route-literal extraction breaks, every doc path looks
    // unknown OR the set empties and comparisons go meaningless.
    // V-938 — raised from 150 to just under the measured 213.
    expect(registered.size, 'routes extracted from apps/server/src').toBeGreaterThan(190);
    expect(registered.has('/version')).toBe(true);
    expect(registered.has('/v1/version')).toBe(false);

    const offenders: string[] = [];
    for (const file of docFiles()) {
      const body = readFileSync(file, 'utf8');
      const rel = file.replace(`${REPO_ROOT}/`, '');
      const found =
        body.match(
          /(?:\/v1\/[A-Za-z0-9_\-/:{}.]+|\/health\b|\/ready\b|\/version\b|\/metrics\b)/g,
        ) ?? [];
      for (const raw of new Set(found)) {
        const path = raw.replace(/[.,)`]+$/, '').replace(/\/$/, '');
        if (PROSE_PREFIXES.has(path)) continue;
        // A line-wrapped path in prose loses its tail ("…/rotate-" + newline).
        if (/[-/]$/.test(path)) continue;
        const norm = normalizePath(path);
        if (registered.has(norm)) continue;
        // Example ids inside a real path shape (inc_<uuid>, acc_<id>) normalize to a
        // literal segment; treat a path whose parent-with-:P resolves as fine.
        const parametrized = norm.replace(/\/[a-z]+_[A-Za-z0-9-]+$/, '/:P');
        if (registered.has(parametrized)) continue;
        // Prose naming a route FAMILY ("the /v1/admin/cost/accounts reads") is not a
        // broken link: it is a strict prefix of something registered.
        if ([...registered].some((r) => r.startsWith(`${norm}/`))) continue;
        // Docs write a CONCRETE example where the route has a param
        // (/v1/auth/oauth/google/callback vs /v1/auth/oauth/:P/callback). Try each
        // segment as a parameter before calling it missing.
        const segs = norm.split('/');
        const anySegmentAsParam = segs.some((_, i) => {
          if (segs[i] === '' || segs[i] === ':P') return false;
          const probe = [...segs];
          probe[i] = ':P';
          return registered.has(probe.join('/'));
        });
        if (anySegmentAsParam) continue;
        // A doc may name a wrong path in order to warn against it — but the skip has to
        // be PER OCCURRENCE, not per file. A file-wide skip made this guard blind: once
        // dr-runbook.md said "NOT `/v1/version`", every OTHER `/v1/version` in the same
        // file (there were two more, both live instructions) became invisible. Same
        // too-broad-negative shape that bit the AUP `reason` assertion.
        const NEGATED = /(?:NOT|no|never|there is no|404s|does not exist|was never built)/i;
        let flaggedHere = false;
        for (
          let at = body.indexOf(path);
          at !== -1 && !flaggedHere;
          at = body.indexOf(path, at + 1)
        ) {
          const context = body.slice(Math.max(0, at - 90), at + path.length + 40);
          if (!NEGATED.test(context)) flaggedHere = true;
        }
        if (!flaggedHere) continue;
        offenders.push(`${rel}: ${path}`);
      }
    }

    expect(
      offenders,
      'operator doc(s) naming an HTTP path the server does not register. Each of these ' +
        '404s for an operator mid-incident, which reads as a broken system rather than a ' +
        'stale doc. Either correct the path or, if the endpoint was never built, say so.',
    ).toEqual([]);
  });
});
