// W550.B — drift guard for /docs/adr/ADR-003-paid-trial-pack-replaces-free-tier.md.
// Contractual decision record. Drift here either weakens the
// $2.99-as-abuse-filter posture (would re-permit free-trial
// signup-fingerprinting/Turnstile infrastructure-spend), drops
// the trial-pack canonical shape (would diverge from
// accounts.trial_pack_* columns in DB schema), or drops the
// 5-revisit-trigger inventory (would orphan the path back to
// file-127 §6 free-trial framing).
//
//   • Status: Accepted, 2026-05-03, Contractual.
//   • Related V-entry: V-061 + V-063.
//   • $2.99 one-time, 299¢ credit, $0.18/hr decrement, ≈16 hours,
//     1 concurrent, 14-day window, once per account.
//   • trial_pack_redeemed boolean — no reset on downgrade/churn.
//   • Zero anti-abuse infra (fingerprinting/Turnstile/blocklists
//     all explicitly out of scope).
//   • DB columns: trial_pack_purchased_at + credit_cents +
//     expires_at + redeemed (Workstream D).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/adr/ADR-003-paid-trial-pack-replaces-free-tier.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W550.B /docs/adr/ADR-003-paid-trial-pack-replaces-free-tier.md content parity', () => {
  const body = read(LIB);

  it("Header + Status-Contractual + Related-V framing pinned: '# ADR-003 — $2.99 paid trial pack replaces the free tier' + '**Status:** Accepted' + '**Date:** 2026-05-03' + '**Tier:** Contractual (explicit; commercial-commitment shape)' + '**Related V-entry:** V-061 (file-127 sweep that initially carried forward the \"free trial\" framing — withdrawn here), V-063 (this ADR + memory + scaffolding annotations).' — pinned so the ADR-003-Accepted-2026-05-03 + Tier-Contractual-commercial-commitment + V-061-free-trial-framing-withdrawn + V-063-ADR-memory-scaffolding commitment survives", () => {
    expect(body).toMatch(/^# ADR-003 — \$2\.99 paid trial pack replaces the free tier$/m);
    expect(body).toMatch(/\*\*Status:\*\* Accepted/);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-03/);
    expect(body).toMatch(/\*\*Tier:\*\* Contractual \(explicit; commercial-commitment shape\)/);
    expect(body).toMatch(
      /\*\*Related V-entry:\*\* V-061 \(file-127 sweep that initially carried forward the "free trial" framing — withdrawn here\),/,
    );
    expect(body).toMatch(/V-063 \(this ADR \+ memory \+ scaffolding annotations\)\./);
  });

  it("Context — file-127 §6 25-hour free trial deviation + anti-abuse-infra scope + self-funding fleet framing pinned: 'Parent driftstack repo file 127' + '§6 specs a **free trial**: 25 browser-hours one-time, 7-day window, no card required, 1 concurrent, 1 archetype, Community support.' + '1. **Anti-abuse infrastructure scope.**' + 'signup fingerprinting, IP rate limits on signup endpoints, GitHub-OAuth-quality gates' + 'Cloudflare Turnstile on signup forms, email-domain blocklists, post-signup behaviour-anomaly detection.' + '2. **Self-funding fleet costs at first session.** Each browser-hour costs Driftstack ~$0.04 in MacStadium time' + '$2.99 is invisible friction for a B2B technical buyer audience' — pinned so the file-127 §6 25-hour-7-day-1-concurrent-Community framing + 6-anti-abuse-tools-inventory + $0.04-MacStadium-fleet-cost + $2.99-invisible-friction-B2B commitment survives", () => {
    expect(body).toMatch(/Parent driftstack repo file 127/);
    expect(body).toMatch(
      /§6 specs a \*\*free trial\*\*: 25 browser-hours one-time, 7-day window, no card required, 1 concurrent, 1 archetype, Community support\./,
    );
    expect(body).toMatch(/1\. \*\*Anti-abuse infrastructure scope\.\*\*/);
    expect(body).toMatch(
      /signup fingerprinting, IP rate limits on signup endpoints, GitHub-OAuth-quality gates/,
    );
    expect(body).toMatch(
      /Cloudflare Turnstile on signup forms, email-domain blocklists, post-signup behaviour-anomaly detection\./,
    );
    expect(body).toMatch(
      /2\. \*\*Self-funding fleet costs at first session\.\*\* Each browser-hour costs Driftstack ~\$0\.04 in MacStadium time/,
    );
    expect(body).toMatch(
      /\*\*\$2\.99 is invisible friction for a B2B technical buyer audience\*\*/,
    );
  });

  it("Decision — trial-pack canonical shape framing pinned: '**Replace the file-127 §6 free trial with a $2.99 paid trial pack.**' + '$2.99 one-time charge** via Stripe Checkout at trial activation.' + 'Funds account credit balance at **299 cents**.' + 'Sessions metered at **Starter tier rate ($0.18/hr)** decrementing the credit balance — yields ~16 hours of usage.' + '1 concurrent session' + '14-day window' + 'Once per account** — `trial_pack_redeemed` boolean prevents re-activation; no reset on downgrade or churn.' — pinned so the $2.99-Stripe-Checkout + 299¢-credit + $0.18/hr-decrement + ≈16-hours + 1-concurrent + 14-day-window + once-per-account + trial_pack_redeemed-no-reset commitment survives", () => {
    expect(body).toMatch(
      /\*\*Replace the file-127 §6 free trial with a \$2\.99 paid trial pack\.\*\*/,
    );
    expect(body).toMatch(
      /\*\*\$2\.99 one-time charge\*\* via Stripe Checkout at trial activation\./,
    );
    expect(body).toMatch(/Funds account credit balance at \*\*299 cents\*\*\./);
    expect(body).toMatch(
      /Sessions metered at \*\*Starter tier rate \(\$0\.18\/hr\)\*\* decrementing the credit/,
    );
    expect(body).toMatch(/balance — yields ~16 hours of usage\./);
    expect(body).toMatch(/\*\*1 concurrent session\*\*/);
    expect(body).toMatch(/\*\*14-day window\*\* from purchase \(any unused balance expires/);
    expect(body).toMatch(
      /\*\*Once per account\*\* — `trial_pack_redeemed` boolean prevents re-activation; no reset on downgrade or churn\./,
    );
  });

  it("Consequences — zero-anti-abuse-infra + self-funding framing pinned: '**Zero anti-abuse infrastructure required.**' + 'Signup-fingerprinting, IP rate limits on signups, GitHub-OAuth-quality gates, Cloudflare Turnstile on signup forms, email-domain blocklists, post-signup behaviour-anomaly detection — all unnecessary.' + 'abuse defense is a paid problem instead of a code problem.' + '**Self-funding from session 1.**' + 'Driftstack's MacStadium fleet cost is covered by the trial-pack revenue. No subsidy line item.' — pinned so the zero-anti-abuse-infra + 6-tool-inventory-unnecessary + paid-problem-not-code-problem + session-1-self-funding + no-subsidy-line-item commitment survives", () => {
    expect(body).toMatch(/- \*\*Zero anti-abuse infrastructure required\.\*\*/);
    expect(body).toMatch(
      /Signup-fingerprinting, IP rate limits on signups, GitHub-OAuth-quality gates, Cloudflare Turnstile on signup forms, email-domain blocklists, post-signup behaviour-anomaly detection — all unnecessary\./,
    );
    expect(body).toMatch(/abuse defense is a paid problem instead of a code problem\./);
    expect(body).toMatch(/- \*\*Self-funding from session 1\.\*\*/);
    expect(body).toMatch(
      /Driftstack's MacStadium fleet cost is covered by the trial-pack revenue\. No subsidy line item\./,
    );
  });

  it("Revisit triggers — 5-trigger inventory + Notes DB-schema framing pinned: '**Trial-pack-to-paid conversion rate drops below 8%.**' + '**Competitor pricing pressure forces a free trial.**' + '**Anti-abuse infrastructure becomes \"free\" via a third-party.**' + '**MacStadium fleet utilisation drops below the level where trial-pack revenue meaningfully self-funds.**' + '**Audience composition shifts.**' + 'Database schema for the trial-pack columns (`accounts.trial_pack_purchased_at`, `accounts.trial_pack_credit_cents`, `accounts.trial_pack_expires_at`, `accounts.trial_pack_redeemed`) lands in Workstream D' + 'Anti-abuse infrastructure is **explicitly out of scope** under this ADR' — pinned so the 5-revisit-triggers + 4-DB-column-inventory + Workstream-D + anti-abuse-explicitly-out-of-scope commitment survives", () => {
    expect(body).toMatch(/- \*\*Trial-pack-to-paid conversion rate drops below 8%\.\*\*/);
    expect(body).toMatch(/- \*\*Competitor pricing pressure forces a free trial\.\*\*/);
    expect(body).toMatch(/- \*\*Anti-abuse infrastructure becomes "free" via a third-party\.\*\*/);
    expect(body).toMatch(
      /- \*\*MacStadium fleet utilisation drops below the level where trial-pack revenue meaningfully self-funds\.\*\*/,
    );
    expect(body).toMatch(/- \*\*Audience composition shifts\.\*\*/);
    expect(body).toMatch(
      /Database schema for the trial-pack columns \(`accounts\.trial_pack_purchased_at`, `accounts\.trial_pack_credit_cents`, `accounts\.trial_pack_expires_at`, `accounts\.trial_pack_redeemed`\) lands in Workstream D/,
    );
    expect(body).toMatch(
      /Anti-abuse infrastructure is \*\*explicitly out of scope\*\* under this ADR/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
