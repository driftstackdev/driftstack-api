// W514.B — drift guard for apps/marketing-site/src/pages/docs/cost-monitoring.astro.
// V-671 customer-facing cost-monitoring docs. Drift here either changes a
// cost component (would create marketing↔V-541.D-cost-route divergence) or
// breaks the 3-state thresholdState taxonomy (would mislead alert UX).
//
//   • V-671 doc-comment framing + V-541.D GET /v1/account/cost companion.
//   • 5 cost components: Compute (session-minutes) / Storage (R2 GB-months) /
//     Egress (TURN GB) / Email (Postmark sends) / bundled AI usage (BYOK 0).
//   • Retention defaults: 30d screenshots/DOM, 90d recordings.
//   • thresholdState 3-state enum: under-soft / between-soft-and-hard / over-hard.
//   • Soft + hard email alerts fire once per crossing.
//   • Endpoint: GET /v1/account/cost?billing_cycle=YYYY-MM + omit-for-current +
//     200-with-zero-breakdown-for-fresh-accounts (no 404).
//   • Sample response 7-field breakdown (compute/storage/egress/email/llm/
//     total/thresholdState) — all integer cents.
//   • FAQ: real-time-within-seconds + BYOK-llm-0 + hard-cap-never-silently-kills.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/cost-monitoring.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W514.B apps/marketing-site/src/pages/docs/cost-monitoring.astro content parity', () => {
  const body = read(LIB);

  it("V-671 framing pinned: 'customer-facing cost-monitoring docs. The companion to V-541.D's GET /v1/account/cost route. Walks through how spend is computed, what each component covers, when threshold alerts fire, and how to interpret the response shape.' — pinned so the V-671 + V-541.D anchors + 4-topic walkthrough commitment survive (drift to dropping the V-541.D anchor would orphan from the source-of-truth route)", () => {
    expect(body).toMatch(
      /\/\/ V-671 — customer-facing cost-monitoring docs\. The companion to\s*\n?\s*\/\/ V-541\.D's GET \/v1\/account\/cost route\. Walks through how spend is\s*\n?\s*\/\/ computed, what each component covers, when threshold alerts fire,\s*\n?\s*\/\/ and how to interpret the response shape\./,
    );
  });

  it("5-cost-component framing pins bundled AI's flat turn rate while preserving the llmCents response field", () => {
    expect(body).toMatch(
      /<dt class="text-sm font-medium text-tk-ink">Compute \(session-minutes\)<\/dt>/,
    );
    expect(body).toMatch(
      /<dt class="text-sm font-medium text-tk-ink">Storage \(R2 GB-months\)<\/dt>/,
    );
    expect(body).toMatch(/<dt class="text-sm font-medium text-tk-ink">Egress \(TURN GB\)<\/dt>/);
    expect(body).toMatch(
      /<dt class="text-sm font-medium text-tk-ink">Email \(Postmark sends\)<\/dt>/,
    );
    expect(body).toMatch(/<dt class="text-sm font-medium text-tk-ink">Bundled AI usage<\/dt>/);
    expect(body).toMatch(/API\s*\n?\s*Scale usage posts \$0\.10 per agent turn/);
    expect(body).toMatch(/Enterprise can use\s*\n?\s*its contracted custom rate/);
    expect(body).toMatch(/<code class="font-mono">llmCents<\/code> field/);
    expect(body).not.toMatch(/pass-through pricing|operational markup|input \+ output tokens/i);
    expect(body).toMatch(
      /The breakdown returned by\s*\n?\s*<code class="font-mono">\/v1\/account\/cost<\/code> mirrors the\s*\n?\s*same five components\./,
    );
  });

  it("Retention default + BYOK-llm-0 framing pinned: 'Retention defaults are 30 days for screenshots / DOM, 90 days for recordings; shorter retention reduces this line.' + 'BYOK customers see 0 here.' — pinned so the 30d/90d retention default + BYOK-llm-0 commitment survives (drift to a different retention window would create marketing↔storage-purge-schedule divergence; drift to claiming BYOK customers see non-zero LLM would mislead about pass-through-only metering)", () => {
    expect(body).toMatch(
      /Retention defaults are\s*\n?\s*30 days for screenshots \/ DOM, 90 days for recordings;\s*\n?\s*shorter retention reduces this line\./,
    );
    expect(body).toMatch(/BYOK customers see 0\s*\n?\s*here\./);
  });

  it("thresholdState 3-state enum pinned: under-soft (on track, no email) + between-soft-and-hard (approaching limit email, fires first crossing) + over-hard (over limit email, fires once per crossing) + 'Threshold numeric values are not part of the customer response (they're operator-tuned configuration).' — pinned so the 3-state enum + once-per-crossing email-firing + operator-tuned-numerics commitment survives (drift to exposing the numeric thresholds would create marketing↔internal-config divergence)", () => {
    expect(body).toMatch(/>under-soft<\/span/);
    expect(body).toMatch(/>between-soft-and-hard<\/span/);
    expect(body).toMatch(/>over-hard<\/span/);
    expect(body).toMatch(
      /Threshold numeric values are not part of the customer\s*\n?\s*response \(they're operator-tuned configuration\)\./,
    );
  });

  it("Endpoint framing pinned: 'GET /v1/account/cost?billing_cycle=YYYY-MM' + 'Omit the parameter for the current cycle. Returns 200 with a synthesised zero-breakdown for fresh accounts that haven't accrued usage yet (no 404).' — pinned so the optional-billing_cycle-param + 200-with-synthesised-zero (no-404) commitment survives (drift to returning 404 on fresh accounts would create marketing↔server-shape divergence)", () => {
    expect(body).toMatch(
      /<code class="font-mono">GET \/v1\/account\/cost\?billing_cycle=YYYY-MM<\/code>\./,
    );
    expect(body).toMatch(
      /Omit the parameter for the current cycle\. Returns 200 with a\s*\n?\s*synthesised zero-breakdown for fresh accounts that haven't\s*\n?\s*accrued usage yet \(no 404\)\./,
    );
  });

  it('Sample response 7-field breakdown pinned: account_id + billing_cycle 2026-05 + tier api_builder + computeCents 12_000 + storageCents 200 + egressCents 50 + emailCents 5 + llmCents 1_800 + totalCents 14_055 + thresholdState under-soft — pinned so the canonical 7-field response shape + sample-cents-values + integer-cents framing survives (drift to a different response shape would create marketing↔/v1/account/cost divergence)', () => {
    expect(body).toMatch(/"billing_cycle": "2026-05"/);
    expect(body).toMatch(/"tier": "api_builder"/);
    expect(body).toMatch(/"computeCents": 12_000/);
    expect(body).toMatch(/"storageCents": 200/);
    expect(body).toMatch(/"egressCents": 50/);
    expect(body).toMatch(/"emailCents": 5/);
    expect(body).toMatch(/"llmCents": 1_800/);
    expect(body).toMatch(/"totalCents": 14_055/);
    expect(body).toMatch(/"thresholdState": "under-soft"/);
    expect(body).toMatch(/All amounts are integer cents/);
  });

  it('FAQ pins real-time recomputation, BYOK zero cost, flat standard bundled turns, and the never-silently-kill cap boundary', () => {
    expect(body).toMatch(/Is the response real-time\?/);
    expect(body).toMatch(
      /Within a few seconds of the underlying usage event\.\s*\n?\s*Snapshots aren't persisted yet, so the endpoint\s*\n?\s*recomputes every request\. This will move to nightly\s*\n?\s*snapshots when traffic justifies caching/,
    );
    expect(body).toMatch(/Why is bundled AI cost 0 even though I'm using the agent\?/);
    expect(body).toMatch(/BYOK accounts \(Bring Your Own Anthropic Key\)/);
    expect(body).toMatch(/standard Builder or Scale agent turn adds \$0\.10/);
    expect(body).toMatch(/Enterprise\s*\n?\s*follows its contracted custom rate/);
    expect(body).toMatch(/What happens if I cross the hard cap\?/);
    expect(body).toMatch(
      /Nothing is automatically blocked\. The platform alerts our\s*\n?\s*ops team and emails you\. We reach out to discuss raising\s*\n?\s*the cap or moving you to a higher tier; we never silently\s*\n?\s*kill running sessions to enforce a soft cap\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
