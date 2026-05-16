#!/usr/bin/env node
// Wave 1119 / Slice 1119.1 — Stripe products + prices bootstrap script.
//
// Idempotently creates the 7 Stripe products + 13 prices the API server
// expects in DRIFTSTACK_TIER_PRICE_IDS + STRIPE_TRIAL_PACK_PRICE_ID. Run
// once per Stripe account (test mode + live mode are separate accounts;
// run twice for both).
//
// Founder usage:
//
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/stripe-bootstrap-prices.mjs
//
// Add --dry-run to preview the plan against an empty account without
// creating anything (GET search calls still hit Stripe so a partially-
// populated account shows reuse vs new-create per row).
//
// Or with sk_test_xxx against test mode. The script:
//   1. Looks up existing products by metadata.driftstack_tier; reuses if found.
//   2. Looks up existing prices by metadata.driftstack_tier + .billing_period;
//      reuses if found AND amount matches.
//   3. Creates missing products + prices.
//   4. Prints the final DRIFTSTACK_TIER_PRICE_IDS JSON + STRIPE_TRIAL_PACK_PRICE_ID
//      block ready to paste into /etc/driftstack/api.env (or .env.local for
//      dev runs).
//
// Idempotent + safe to re-run. Each Stripe create call has an Idempotency-
// Key derived from the tier slug + billing_period so a retry-after-partial-
// failure doesn't double-create.
//
// SECURITY: the STRIPE_SECRET_KEY is read from env ONLY. Never written to
// a file, never echoed in output (the script prints ids only — `price_xxx`
// is a public identifier, not a secret).
//
// Tier matrix matches packages/api-types/src/billing.ts + apps/customer-
// dashboard/src/pages/select-tier.astro TIERS array (W373.C parity).

import process from 'node:process';

const TIERS = [
  { id: 'solo_manual', name: 'Solo (manual)', monthly_cents: 7900, annual_cents: 7900 * 10 },
  { id: 'team_manual', name: 'Team (manual)', monthly_cents: 24900, annual_cents: 24900 * 10 },
  { id: 'agency_manual', name: 'Agency (manual)', monthly_cents: 69900, annual_cents: 69900 * 10 },
  { id: 'api_starter', name: 'API starter', monthly_cents: 14900, annual_cents: 14900 * 10 },
  { id: 'api_builder', name: 'API builder', monthly_cents: 49900, annual_cents: 49900 * 10 },
  { id: 'api_scale', name: 'API scale', monthly_cents: 149900, annual_cents: 149900 * 10 },
];

const TRIAL_PACK = {
  id: 'trial_pack',
  name: 'Trial pack',
  amount_cents: 299, // $2.99 one-time
};

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function envOrDie(name) {
  const v = process.env[name];
  if (typeof v !== 'string' || v.length === 0) {
    process.stderr.write(`ERROR: env var ${name} is required.\n`);
    process.exit(2);
  }
  return v;
}

const SECRET_KEY = envOrDie('STRIPE_SECRET_KEY');
const DRY_RUN = process.argv.includes('--dry-run');

async function stripeRequest(method, path, params, idempotencyKey) {
  // Dry-run mutates nothing — POST requests are simulated with
  // a synthetic `dryrun_<tier>_<period>` id so the rest of the
  // script can run end-to-end and print the env-block preview.
  // GET (search) calls still hit Stripe so the dry-run reflects
  // the actual state of the target account.
  if (DRY_RUN && method === 'POST') {
    const isProduct = path === '/products';
    const isPrice = path === '/prices';
    if (isProduct) {
      const tier = params.metadata.driftstack_tier;
      const id = `prod_dryrun_${tier}`;
      process.stdout.write(`  [dry-run] would create product ${tier} → ${id}\n`);
      return { id };
    }
    if (isPrice) {
      const tier = params.metadata.driftstack_tier;
      const period = params.metadata.billing_period;
      const id = `price_dryrun_${tier}_${period}`;
      process.stdout.write(
        `  [dry-run] would create price ${tier}/${period} (${params.unit_amount}¢) → ${id}\n`,
      );
      return { id };
    }
  }
  const url = STRIPE_API_BASE + path;
  const body =
    params !== undefined
      ? new URLSearchParams(
          Object.entries(params).flatMap(([k, v]) =>
            Array.isArray(v)
              ? v.map((vi) => [k + '[]', String(vi)])
              : typeof v === 'object' && v !== null
                ? Object.entries(v).map(([sk, sv]) => [`${k}[${sk}]`, String(sv)])
                : [[k, String(v)]],
          ),
        ).toString()
      : undefined;
  const headers = {
    Authorization: 'Bearer ' + SECRET_KEY,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': '2024-12-18.acacia',
  };
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const json = await res.json();
  if (!res.ok) {
    process.stderr.write(`Stripe ${method} ${path} → ${res.status}: ${JSON.stringify(json)}\n`);
    process.exit(3);
  }
  return json;
}

async function findProductByMetadata(tier) {
  const list = await stripeRequest(
    'GET',
    `/products/search?query=${encodeURIComponent(`metadata['driftstack_tier']:'${tier}'`)}`,
  );
  return list.data && list.data.length > 0 ? list.data[0] : null;
}

async function findPriceByMetadata(tier, period) {
  const list = await stripeRequest(
    'GET',
    `/prices/search?query=${encodeURIComponent(`metadata['driftstack_tier']:'${tier}' AND metadata['billing_period']:'${period}'`)}`,
  );
  return list.data && list.data.length > 0 ? list.data[0] : null;
}

async function ensureProduct(tier, name) {
  const existing = await findProductByMetadata(tier);
  if (existing) {
    process.stdout.write(`✓ product ${tier}: reusing ${existing.id}\n`);
    return existing.id;
  }
  const created = await stripeRequest(
    'POST',
    '/products',
    { name, metadata: { driftstack_tier: tier } },
    `driftstack-product-${tier}`,
  );
  process.stdout.write(`+ product ${tier}: created ${created.id}\n`);
  return created.id;
}

async function ensurePrice(tier, period, productId, amountCents, recurring) {
  const existing = await findPriceByMetadata(tier, period);
  if (existing) {
    if (existing.unit_amount !== amountCents) {
      process.stderr.write(
        `ERROR: price ${tier}/${period} exists with amount ${existing.unit_amount} (expected ${amountCents}). Archive or fix manually.\n`,
      );
      process.exit(4);
    }
    process.stdout.write(`✓ price ${tier}/${period}: reusing ${existing.id}\n`);
    return existing.id;
  }
  const params = {
    product: productId,
    currency: 'usd',
    unit_amount: amountCents,
    metadata: { driftstack_tier: tier, billing_period: period },
  };
  if (recurring) {
    params['recurring[interval]'] = recurring;
  }
  const created = await stripeRequest(
    'POST',
    '/prices',
    params,
    `driftstack-price-${tier}-${period}`,
  );
  process.stdout.write(`+ price ${tier}/${period}: created ${created.id}\n`);
  return created.id;
}

async function main() {
  process.stdout.write('Driftstack Stripe bootstrap — Wave 1119 / Slice 1119.1\n');
  process.stdout.write(`Using key prefix: ${SECRET_KEY.slice(0, 7)}…\n`);
  if (DRY_RUN) {
    process.stdout.write(
      'Dry-run mode: GET (search) calls hit Stripe; POST calls are simulated.\n',
    );
  }
  process.stdout.write('\n');

  const tierPrices = {};

  for (const tier of TIERS) {
    const productId = await ensureProduct(tier.id, tier.name);
    const monthlyId = await ensurePrice(tier.id, 'monthly', productId, tier.monthly_cents, 'month');
    const annualId = await ensurePrice(tier.id, 'annual', productId, tier.annual_cents, 'year');
    tierPrices[tier.id] = { monthly: monthlyId, annual: annualId };
  }

  const trialProductId = await ensureProduct(TRIAL_PACK.id, TRIAL_PACK.name);
  const trialPriceId = await ensurePrice(
    TRIAL_PACK.id,
    'one_time',
    trialProductId,
    TRIAL_PACK.amount_cents,
    null,
  );

  process.stdout.write('\n========================================\n');
  process.stdout.write('Paste into /etc/driftstack/api.env:\n');
  process.stdout.write('========================================\n');
  process.stdout.write(`DRIFTSTACK_TIER_PRICE_IDS='${JSON.stringify(tierPrices)}'\n`);
  process.stdout.write(`STRIPE_TRIAL_PACK_PRICE_ID='${trialPriceId}'\n`);
  process.stdout.write('========================================\n');
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
