# Bundled-LLM opt-in design (v2-#6)

**Status:** DESIGN ONLY. Awaiting founder verdicts on the 5 open
questions in the "Founder verdicts needed" section. Implementation
deferred until verdicts ripen.

**Trigger:** Strategic directive 2026-05-17T19:15Z (4) — bundled-LLM
opt-in at signup, USD pay-per-use, parallel arc to the AI chat + manual
live differentiator.

**Date staged:** 2026-05-18 (post v2-#4/5/9 cost-tracking + audit-log
events landing as the prerequisite). Cross-link:
[Q.1 wire commits](../internal/2026-05-17-q-queue-loop-handoff.md);
[strategic directives memory `project_strategic_directives_2026_05_17`].

## The product question

Today (post-v2-#3/4/5/9) every customer using the AI chat agent layer
pays Anthropic directly via their own BYOK key. The Q.1.d hard-502
refuses the chat when no BYOK key is configured.

For customers who don't want to manage a separate Anthropic billing
account, we offer an opt-in: "Use Driftstack's Claude" — we pay
Anthropic, they pay us in USD per turn.

The cost-tracking infrastructure (v2-#4 migration 0046
`usage_records.metadata` + `agent_decomposer` source) already records
per-turn input/output tokens + cost cents whether the customer pays
Anthropic or we do. The bundled-LLM tier is a config flip on the
billing side, not a schema migration.

## Default vs opt-in posture

- **Default (no opt-in):** BYOK; Q.1.d hard-502 fires when no key
  configured. Customer's existing Driftstack subscription unchanged.
- **Opt-in (`bundled_llm_consent = true`):** Q.1.d gate allows
  fallback key usage; usage_records row metadata.cost_usd_cents
  becomes a billable signal (sent to Stripe via a new meter, when
  the tier launches).

## Schema delta (additive; one migration)

```sql
ALTER TABLE accounts ADD COLUMN bundled_llm_consent boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN bundled_llm_consent_at timestamptz;
```

- `bundled_llm_consent`: customer toggles via signup checkbox or
  account settings.
- `bundled_llm_consent_at`: when the consent was given (audit trail).
  Null when consent is false. Set/cleared on toggle.

Migration number: 0048 (sequential after 0047 agent_sessions
hardening).

## Q.1.d gate extension

The route layer (`apps/server/src/routes/agent-sessions.ts`) currently:

```ts
if (agentDecomposerKind === 'claude' && !byokKey) {
  throw new ByokAnthropicRequiredError();
}
```

Extended to honor consent:

```ts
if (agentDecomposerKind === 'claude' && !byokKey) {
  const account = await accountsRepo.findById(ctx.account.id);
  if (!account.bundledLlmConsent) {
    throw new ByokAnthropicRequiredError();
  }
  // Fallback key from config — already loaded into the decomposer's
  // deps via `useFallbackForUnconfiguredCustomers`.
}
```

The decomposer wire stays unchanged — it consumes whichever key the
route resolves. Only the GATE policy changes per consent.

## Pricing surface

Per strategic directive: "$0.10 per AI chat turn" — flat-rate pricing
on TOP of the existing concurrent-tier subscription.

Cost-tracked metadata.cost_usd_cents (v2-#4) is the actual Anthropic
spend; the billed amount is the rate-card price. Margin = billed −
actual. Both columns stored:

- `metadata.cost_usd_cents`: our actual Anthropic spend (v2-#4
  existing field).
- `metadata.billed_usd_cents`: what we charged the customer (new
  field, layered on top by the bundled-LLM billing service).

If the customer's plan includes N free turns / month, the meter
emits `billed_usd_cents = 0` for those + `billed_usd_cents = 10` for
each over-quota turn. The free-quota threshold is tier-tiered (open
question #2 below).

## Founder verdicts needed

The bundled-LLM tier launches AFTER founder picks verdicts on these
five. Surface to ORCHESTRATOR-PENDING-TIER3 queue.

### Question 1: Trial inclusion at v1.0 launch

**Options:**

- A. Ship v1.0 with bundled-LLM SKIPPED entirely; BYOK-only for the
  launch window. Revisit at v1.1 once we have signup-data showing
  what % of signups bounce on the BYOK requirement.
- B. Ship v1.0 with bundled-LLM available BUT NO trial — opt-in
  requires the customer add a credit card; first turn costs $0.10.
- C. Ship v1.0 with bundled-LLM + a free quota (e.g. 25 turns / month
  for all paid tiers). Marketing-friendly but increases the risk of
  customer-acquisition cost overrun in the first weeks.

**Recommendation:** B (no trial). Lower marketing surface area at
launch; we can layer trials in once the cost trajectory is stable.
Defers the customer-acquisition risk to a later product decision.

### Question 2: Per-tier included turns / month

If trial is included (Q1 = C), how many turns ride free?

**Options:**

- A. Uniform 25 turns/mo across all paid tiers.
- B. Tier-tiered: Solo 0 / Team 25 / Agency 100 / API tiers same as
  manual.
- C. Tier-tiered but generous: Solo 50 / Team 250 / Agency 1000.

**Recommendation:** B. Mirrors the existing concurrent-tier shape;
preserves the upsell narrative ("higher tier = more included turns").

### Question 3: Over-quota behavior

Once the customer exhausts their included turns, what happens?

**Options:**

- A. Hard-cap: refuse further turns with 402-style "upgrade or add
  credit". Customer's chat hangs until they take action.
- B. Soft-cap: charge per-turn over the quota with no upper bound
  (the customer gets a bill at month-end). Stripe metered billing
  pattern.
- C. Soft-cap with monthly cap: per-turn billing up to a customer-
  configurable monthly maximum (default $20). Above the cap, hard-
  refuse.

**Recommendation:** C. Combines the predictable-bill upside of A
with the no-friction upside of B; customer controls the ceiling.

### Question 4: BYOK + bundled-LLM coexistence

If the customer has BOTH a BYOK key AND `bundled_llm_consent = true`,
which key does the decomposer use?

**Options:**

- A. BYOK always wins when configured (current Q.1.c key-resolution
  chain). Bundled-LLM consent is a fallback only.
- B. Per-session toggle on POST /v1/agent-sessions: customer picks
  per session whether to use their BYOK or our bundled key. Default
  to BYOK when both available.
- C. Account-level override: the customer's `bundled_llm_consent`
  flag becomes a 3-state enum (`off` | `fallback` | `prefer`) —
  `prefer` forces bundled even when BYOK is configured (useful when
  the customer wants to consolidate their Anthropic spend into a
  single bill from us).

**Recommendation:** A. Simplest; matches the existing key-resolution
chain. The 3-state nuance in C can layer on top later if customer
requests come in.

### Question 5: Cost-pass-through transparency

Do we surface the underlying Anthropic spend to the customer?

**Options:**

- A. No. Customer sees only the billed amount ($0.10 / turn).
  metadata.cost_usd_cents stays operator-only.
- B. Yes, on a separate "AI Chat Detail" tab in the usage dashboard:
  "you used 47 turns; we billed $4.70; underlying Anthropic spend
  was $1.43; margin = $3.27". Maximally transparent.
- C. Yes, in the per-turn audit log (already populated via v2-#5):
  customer can see cost per turn in their account.audit-log filter
  but not in headline usage UI.

**Recommendation:** A. Best customer-experience match; we don't want
to compete on margin transparency, just on product value. C is the
implicit fallback (audit log carries cost data; sophisticated
customers can already query the API for it).

## Implementation arc (post-verdicts)

Once founder picks verdicts:

1. Migration 0048: `accounts.bundled_llm_consent` + `_at` columns.
2. AccountsService + dashboard "billing settings" page wires the
   opt-in checkbox. Audit emit on toggle (new audit action
   `account.bundled_llm_consent_toggled`).
3. Route layer Q.1.d gate extension (consent-aware fallback).
4. UsageService extension: `bundledLlmSummary()` returning included
   vs over-quota turn counts + billed total. Drives the usage page
   widget.
5. Stripe metered-billing wire (separate slice): a new SKU per tier
   for over-quota turns. Bills monthly.
6. Marketing copy: pricing page checkbox; "/ai-chat-included" link
   on the comparison table.

Estimated wall-clock from verdicts to launch: 5-7 days.

## Out of scope

- Own-LLM ("we train our own model") is SKIPPED through v1.x per
  strategic directive (2). The bundled-LLM tier always relays to
  Anthropic.
- Credit-abstraction layer SKIPPED entirely (strategic directive 1
  — USD direct).
- Free-quota signup bonus SKIPPED (strategic directive 4).

## References

- Strategic directives 2026-05-17T19:15Z:
  memory `project_strategic_directives_2026_05_17`
- v2-#4 cost-tracking commit `c48ff341`
- AI chat agent layer design: `docs/internal/ai-chat-agent-layer-design.md`
- Activation-gate pattern: memory `project_activation_gate_pattern`
