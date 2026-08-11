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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
