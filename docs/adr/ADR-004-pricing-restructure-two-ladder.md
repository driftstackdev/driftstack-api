# ADR-004 — Pricing restructure to two-ladder concurrent-only

**Status:** Accepted
**Date:** 2026-05-03
**Tier:** Contractual (explicit; commercial-commitment shape)
**Related V-entry:** V-061 (file-127 sweep that landed the previous single-ladder values), V-071 (this ADR), V-073 (data-layer rewrite that codifies the new structure — V-072 was renumbered).
**Related ADR:** ADR-003 (paid trial pack — unchanged by this restructure; trial-pack mechanics survive intact).
**Related D-entry:** none new — D-019 ("Six-tier locked pricing model") still references the prior structure and is now superseded by this ADR; future revision of D-019 may add a pointer to ADR-004 when convenient.

## Context

The pricing structure that landed in V-061 mirrored parent driftstack repo file 127 §3-§5: a single API tier ladder (Free → Starter → Solo → Builder → Scale → Enterprise) with **per-browser-hour metering** as the primary meter, monthly hour caps per tier (100 / 400 / 1,500 / 6,000), per-hour overage rates ($0.18 → $0.12 sliding down the tiers), and concurrency caps as session-creation hard limits. The free tier was replaced by the $2.99 trial pack in ADR-003 but the rest of the ladder retained the file-127 shape.

Two empirical pressures reshaped the design before any commercial activation landed:

1. **Hours metering is hostile to manual users.** Driftstack's GUI client surface (file 128 / Workstream B-adjacent) targets account managers, agencies, and solo operators who run **persistent profiles** for 8+ hours daily. A typical agency-scale workflow — 3 profiles open per workday across business hours — produces ~720 browser-hours per month. Under the V-061 / file-127 values that's $130+/mo in unexpected overage on top of the Starter $29 base, with the customer experiencing it as a surprise rather than a feature. Hours metering rewards short-burst automation and punishes long-session manual work; the customer mix Driftstack is uniquely positioned to serve (real iPhone fidelity + persistence + UDP proxy + automation) splits roughly evenly between those two patterns, and a single ladder can't price both correctly.

2. **Concurrent-only metering is simpler everywhere.** The customer mental model collapses to "how many parallel sessions can I run." The Stripe integration collapses to a per-tier subscription (no metered events on the paid tiers). The internal enforcement collapses to a single hard limit at session-creation time. The sales conversation collapses to "what's your peak parallelism need." Hours metering's complexity isn't paying for itself at this scale — there are no production customers yet to migrate, so the cost of switching is purely scaffolding work, not customer comms.

A third constraint shaped the absolute price points: **conservative fleet capacity assumption**. Pre-launch we have no measured value for `N`, the number of concurrent sessions a single MacStadium-rented Mac Mini M4 16GB can sustain at quality. The estimate is `N=4` based on conservative reasoning (each concurrent WebKit session needs ~3-4GB working set; 16GB minus OS + Driftstack runtime leaves ~12GB for sessions). At `N=4` and ~$200-280/mo per Mac Mini at MacStadium, fleet cost lands around $50-70 per concurrent session-slot per month. That number sets a floor on Solo Manual's price (must cover at least one concurrent slot's fleet cost with a working margin) and a ceiling on how aggressive lower-tier pricing can be without going negative-margin under heavy 24/7 utilisation.

The two-ladder design separates the customer-facing pricing question into two answers:

- **Manual ladder** (Solo / Team / Agency Manual) — humans clicking the GUI client. Profile count is the natural tier-defining metric (more profiles = bigger team / agency). Concurrent caps stay as the hard enforcement metric. Hours metering removed entirely; "unlimited hours within your concurrent cap" is the mental model.
- **API ladder** (API Starter / Builder / Scale / Enterprise) — code calling the SDK. Concurrent caps are the natural tier-defining metric (more concurrency = more parallel automation). Profile count tracks but isn't the upgrade lever. Hours metering removed entirely; same "unlimited hours within your concurrent cap" framing.

Self-hosted pricing also moves down: the prior V-061 / file-127 values ($1,500 / $2,500 / $5,000+) were anchored on legacy positioning relative to BrowserStack on-prem ($10k+/year/concurrent) but didn't adequately reflect that Driftstack's self-hosted product gets the customer to pay for their own hardware on top of the license. The lower floor ($1,000 / $2,000 / $4,000+) brings the licensing fee into closer parity with Multilogin's self-hosted equivalent (~$300/mo) at the entry tier while keeping the per-hour fleet TCO advantage at scale.

## Decision

**Replace the single-ladder hours-with-overage model with a two-ladder concurrent-only model.** Trial pack mechanics (per ADR-003) survive intact. Self-hosted pricing lowers.

**Trial pack** (unchanged from ADR-003):

- $2.99 one-time / 1 concurrent / 14-day window / once per account
- 299¢ credit decremented at $0.18/hr (Starter equivalent rate, ≈16 hours)

**Manual tier ladder** (humans clicking GUI client, persistent profiles):

| Tier          | Monthly | Annual | Annual $/mo | Profiles | Concurrent | Hours     |
| ------------- | ------- | ------ | ----------- | -------- | ---------- | --------- |
| Solo Manual   | $79     | $758   | $63         | 10       | 1          | unlimited |
| Team Manual   | $249    | $2,390 | $199        | 50       | 3          | unlimited |
| Agency Manual | $699    | $6,710 | $559        | 200      | 8          | unlimited |

**API tier ladder** (programmatic SDK access):

| Tier        | Monthly        | Annual      | Annual $/mo | Profiles | Concurrent | Hours      |
| ----------- | -------------- | ----------- | ----------- | -------- | ---------- | ---------- |
| API Starter | $149           | $1,430      | $119        | 25       | 2          | unlimited  |
| API Builder | $499           | $4,790      | $399        | 100      | 8          | unlimited  |
| API Scale   | $1,499         | $14,390     | $1,199      | 500      | 24         | unlimited  |
| Enterprise  | from $4,000/mo | annual only | —           | Custom   | Custom     | Negotiated |

**Self-hosted** (lowered from V-061 / file-127):

| Tier                   | Monthly        | Annual      | Concurrent | Archetypes | Term     |
| ---------------------- | -------------- | ----------- | ---------- | ---------- | -------- |
| Self-Hosted Solo       | $1,000         | $9,600      | 4 ceiling  | 1          | 3-month  |
| Self-Hosted Pro        | $2,000         | $19,200     | 12-16      | 3          | 3-month  |
| Self-Hosted Enterprise | from $4,000/mo | annual only | 32+        | unlimited  | 12-month |

Hardware requirements (M4 Mini 16GB / Mac Studio M4 Max / Mac Studio Ultra+Mac Pro+multi-node) unchanged; that detail lives on `/self-hosted` only per V-068 / V-069.

**Annual discount:** 20% across all tiers. **Setup fees:** zero across all tiers.

Concrete enforcement implications (handled in V-073 — V-072 slot was skipped during renumbering):

- Postgres `account_tier` enum drops `'free' | 'starter' | 'solo' | 'builder' | 'scale' | 'enterprise'` and becomes `'trial_pack' | 'solo_manual' | 'team_manual' | 'agency_manual' | 'api_starter' | 'api_builder' | 'api_scale' | 'enterprise'`. Pre-launch — no production customers — so the migration drops + recreates rather than preserving values.

> **Implementation note (V-827) — the first enum member is no longer `trial_pack`.**
> Migration `0065_retire_trial_pack_free_tier.sql` retired the trial pack and the
> shipped enum is `['free', 'solo_manual', 'team_manual', 'agency_manual',
'api_starter', 'api_builder', 'api_scale', 'enterprise']` — `trial_pack` became
> `free`, and no `accounts.trial_pack_*` column survives. That also retires the
> `trial_pack_credit_cents` decrement described two bullets down, and the
> "trial-pack mechanics survive intact" line in this ADR's header.
>
> As with the V-814 note below, the bullet above is left as the decision that was
> accepted; this records what the implementation did instead. An ADR is a record
> of a decision, not a description of the running system, and this one is cited as
> a spec by other documents — which is exactly why it needs the difference stated
> rather than edited away.

- `TIER_CONCURRENT_SESSION_LIMITS` becomes the only tier-limit metric on paid tiers.
- `TIER_QUOTAS.session_minute` removed. Trial-pack `trial_pack_credit_cents` decrement at $0.18/hr stays per ADR-003 (the only place hours metering survives).
- New `PROFILES_PER_TIER` map enforces profile count at the `/v1/profiles` creation endpoint. Exceeding profile cap → 429 with the `https://errors.driftstack.dev/tier-limit` problem type. **This diverges from what this ADR originally decided — see the implementation note below.**
- Concurrent cap exceeded at session-creation → 429 with the `https://errors.driftstack.dev/concurrency-limit` problem type.

> **Implementation note (V-814, 2026-08-18) — what shipped differs from the decision above.**
>
> As accepted, this ADR specified `402 Payment Required` with a `profile-cap-reached` body
> and an upgrade link for the profile cap, and drew a deliberate contrast with the
> concurrency cap at 429 ("payment-required is for trial-pack states only"). What shipped
> does not implement that contrast. Both caps return **429**: the profile cap throws
> `TierLimitError` (`lib/errors.ts` — `status: 429`, type `.../tier-limit`) and the
> concurrency cap throws `ConcurrencyLimitError` (type `.../concurrency-limit`). There is no
> `profile-cap-reached` identifier anywhere in the codebase, and the extensions on the wire
> are `{ limit, current, resource, tier }` — no upgrade link.
>
> The two bullets above have been rewritten to describe the shipped behaviour, because this
> ADR is cited as a spec by other documents and a reader had no way to tell the decision from
> the implementation. **Whether to move the profile cap to 402 as originally decided is an
> open product decision, not a documentation fix** — it is a breaking change to a live status
> code, and the SDKs dispatch on the problem-type URI rather than the status, so they are
> unaffected either way (`tier_limit` is classified non-retryable in all three).
>
> A raw-HTTP consumer is the one at risk: told to branch on 402, they get 429, which a
> generic client reads as "rate limited, back off and retry" — a transient status for a
> permanent condition that no amount of waiting clears.

## Consequences

**Enables:**

- **Manual users get a fair price.** The agency running 3 profiles 8 hours daily lives within Team Manual's 3-concurrent cap at a flat $249/mo, no overage anxiety. The previous design would have surfaced that workload as $179+ in unexpected monthly overage on top of Solo $99.
- **Customer mental model collapses.** "How many parallel sessions" is the only metering question. No "how many hours" question. No "what's the overage rate" question. The pricing page is a comparison of concurrent caps + profile counts.
- **Stripe integration simpler.** Each tier becomes a recurring subscription with a single price ID per period (monthly + annual). No metered events, no usage records flowing to Stripe Meters for concurrent-cap enforcement (concurrent enforcement is in-process at session-creation time). BYOK metering still uses Stripe Meters per V-053 (`driftstack_llm_tokens`); this change doesn't affect that.
- **Two-ladder positioning makes the GUI client a first-class product.** The Manual ladder is the GUI client's commercial home. The Manual section on the marketing site becomes the GUI's pricing page; the API section serves the SDK customer. Two clear funnels with shared trial-pack entry.
- **Self-hosted floor enters competitive range.** $1,000 Solo entry is comparable to Multilogin self-hosted (~$300/mo equivalent for fewer concurrent slots and weaker fingerprint fidelity). Customers self-hosting Multilogin today are addressable at this floor.

**Rules out:**

- **Pure usage-based pricing for paid tiers.** A customer who only uses 5 hours per month on Solo Manual still pays $79/mo. Under the prior hours-with-overage design, a low-utilisation Starter customer might have paid $29 + $0 overage = $29. Acceptable trade-off — low-utilisation customers are evaluation-stage and convert on the trial pack rather than the paid Starter tier.
- **The "more generous than competitors" framing of the prior design.** Hours-included-with-overage is a more generous shape on paper for high-utilisation customers if the per-hour rate is competitive. Concurrent-only is a less generous frame for that segment; offset by the simpler mental model and the elimination of overage shock.
- **Over-allocating fleet to evaluators.** Trial pack already self-funds its fleet cost (per ADR-003). Paid tiers self-fund via subscription baseline regardless of utilisation. No customer category gets fleet time below its tier's contribution to fleet cost.

**Operational cost accepted:**

- **More tiers (8 paid + 3 self-hosted = 11) vs prior (5 paid + 3 self-hosted = 8) on the marketing site.** More columns/cards to display, more SKU price IDs in Stripe (19 total), more rows in `pricing.ts`. Acceptable — the two-ladder split is the load-bearing design decision and the extra tier count is a consequence.
- **Two ladder-specific copy treatments on the marketing site.** "Manual — for humans" and "API — for code" headers add a layer of organisation that didn't exist before. Workstream B v3 lands the rewrite.
- **Risk of audience confusion at the boundary** ("am I Manual or API?"). A solo developer running 1 concurrent SDK-driven session might fit either Solo Manual ($79) or API Starter ($149); the answer ("which surface are you using") depends on whether they're building automation that runs on its own or sitting at the keyboard. FAQ entry "What's the difference between Manual and API?" addresses this directly (Workstream B v3).

## Alternatives considered

### Single ladder with hours-with-overage matching blended rate (the V-061 / file-127 design)

- **Pro:** unified pricing-page UX; one comparison table; familiar SaaS pattern; "more generous than competitors" framing for high-utilisation customers.
- **Con:** breaks for manual users with 720+ browser-hours/month; surprise overage as a customer-experience anti-pattern; metering anxiety as a sales-cycle drag; Stripe Meter integration overhead for concurrent-cap enforcement that's actually in-process logic.
- **Why rejected:** the manual-user breakage is real and not solvable by adjusting hour caps within a single ladder. Either Manual users need their own ladder, or hours metering goes away entirely. Going both routes simultaneously is the cleanest answer.

### Two ladders but keep hours-with-overage on the API ladder

- **Pro:** API customers running automation are ostensibly the ones who'd benefit from per-usage pricing; preserving hours metering for them captures that.
- **Con:** the same "metering anxiety" objection applies — API customers running large automations also hit overage shock. And the simplicity argument (one mental model, one Stripe primitive) is half-realised, increasing maintenance surface compared to fully concurrent-only.
- **Why rejected:** if hours metering doesn't pay for itself on the manual side, it doesn't pay for itself on the API side either. The conservative N=4 fleet assumption gives concurrent-only paid tiers positive margin without needing usage-based recovery.

### Lower Solo Manual to $49

- **Pro:** more aggressive entry-level pricing; expands top-of-funnel.
- **Con:** under conservative N=4 fleet assumption + 24/7 utilisation, Solo Manual at $49 is $9-21 loss per customer per month — Driftstack subsidises the fleet cost out of higher-tier margin. Pre-launch (no other tier customers yet) this is structurally bad.
- **Why rejected:** wait until measured fleet capacity validates higher N before squeezing entry pricing. Revisit trigger #1 captures the path back here.

### Lower Self-Hosted Solo to $500

- **Pro:** more aggressive entry; reaches the "single-developer self-host" segment.
- **Con:** software licensing value — orchestration, GUI client, archetype updates, support — at $500/mo undervalues the work going into the platform. BrowserStack on-prem ($10k+/year/concurrent) and Multilogin self-hosted (~$300/mo for 1 concurrent / weaker fingerprint) are the reference points; $1,000/mo for 4 concurrent + iPhone-grade fidelity is the right anchor.
- **Why rejected:** $1,000 floor is the minimum to reflect software-licensing value without undercutting the cloud Solo Manual ($79) by too wide a margin (relative spread is appropriate: cloud is 79× cheaper at entry, justified by no-hardware no-ops).

### Higher API Starter ($199)

- **Pro:** more revenue per API entry-customer; closer to enterprise SaaS norms.
- **Con:** loses comparison-shoppers vs Browserbase ($99-149) and Steel ($79-129) at the entry tier. $149 is the highest justifiable API entry while staying in the competitive range; at $199 the price-comparison conversion drops noticeably.
- **Why rejected:** competitive positioning at the entry tier is more important than revenue-per-entry-customer; conversion trumps unit economics at the funnel-top stage where Driftstack hasn't proven itself yet.

### Per-archetype premium pricing (charge more for iPhone Safari archetype)

- **Pro:** captures the premium nature of the iPhone Safari fidelity Driftstack uniquely delivers.
- **Con:** iPhone Safari is the **only** archetype at v1 (per CAPABILITIES.md / V-141 progress). Charging a premium for the only thing the product does is just charging more, with extra steps. Multi-archetype premium pricing becomes meaningful only when a second archetype lands (deferred per AGENTS.md).
- **Why rejected:** wait for the second archetype before pricing differentiates per-archetype. ADR-004 prices the platform; archetype-tier premium pricing is a future ADR if/when warranted.

## Revisit triggers

Re-evaluate this decision if **any** of the following fires:

1. **First MacStadium fleet provisioning under real production load reveals N differs from estimate by ±2 sessions per M4 16GB.** Trigger metric: measured concurrent-session capacity per fleet node in the first month of paying-customer fleet utilisation. If `N=6` (more capacity than estimated), Solo Manual could drop to $49 with positive margin. If `N=2` (less capacity than estimated), Solo Manual must rise or the cap must drop.
2. **Provider arbitrage qualifies a Mac fleet provider at <$150/mo that meets quality bar.** Trigger event: the team evaluates an alternative Mac fleet provider (currently MacStadium-equivalent at $200-280) and confirms it meets the operational quality bar. Provider cost reduction directly reduces the fleet-cost floor on Solo Manual; could enable the $49 entry tier.
3. **Customer feedback consistently signals Solo Manual is mispriced.** Trigger metric: post-Manual-tier-launch customer survey responses, support tickets explicitly about Solo Manual pricing, churn patterns at the Solo Manual tier specifically. Two patterns to watch: too-low (customers convert easily but don't generate revenue cushion) or too-high (customers evaluate then drop without converting from trial pack).
4. **Competitive pricing pressure: Browserbase / Steel / Multilogin restructure to a directly comparable tier.** Trigger event: a peer service in cloud-browser or browser-anti-detect ships a directly comparable two-ladder structure. If their entry pricing undercuts Driftstack meaningfully, comparison-shopping conversion drops; reconsider entry pricing.
5. **BYOK markup multiplier locks (still explicit pending value).** Trigger event: the team commits a specific markup ratio for the bundled-LLM rate. Locking the BYOK markup may shift the relative attractiveness of paid tiers (BYOK on Builder/Scale/Enterprise becomes a more concrete value proposition); could warrant tier-pricing revisions if BYOK customers cluster at a specific tier.

## Notes

The deferred file-127 single-ladder hours-with-overage design remains the parent driftstack repo's prior recorded design but is now superseded by ADR-004 in this repo's scope. If any revisit trigger fires and the conclusion is "go back to single-ladder + hours metering," the reactivation path is to (1) update the parent file 127 spec back to that shape, (2) reverse the V-073 enforcement code (re-add `TIER_QUOTAS.session_minute` + Stripe Meter integration for concurrent), (3) revise marketing-site pricing copy, (4) issue Art 28(2) sub-processor amendment notice if anything in the rail mix changes (it wouldn't here — billing rail is still Stripe-only per ADR-002).

The trial pack survives ADR-004 unchanged. ADR-003's schema (`accounts.trial_pack_*`), purchase mechanism ($2.99 Stripe Checkout one-time), credit-decrement rate ($0.18/hr), 14-day window, and once-per-account semantic all remain. The tier the trial pack converts customers into is now Solo Manual or API Starter (customer choice at conversion checkout) rather than the prior Starter; the conversion mechanic is unchanged.

Old Stripe price IDs from V-061 era (`driftstack_starter_monthly` etc.) are deprecated. Founder action: archive in Stripe (don't delete — audit trail). New SKU naming convention `driftstack_<tier_id>_<period>` produces 19 price IDs total (8 paid tiers × 2 periods + 3 self-hosted × 2 periods + 2 annual-only enterprise tiers + trial-pack one-time, with Self-Hosted Enterprise and API Enterprise both annual-only).

The N=4 fleet capacity assumption is the load-bearing pre-launch unknown. Phase 2.5 multi-tenancy stress test was deferred to first paying customer per D-2026-04-30-13 (local dev machine unavailable for stress-test, V-141 POC in flight). When real fleet measurements land, revisit trigger #1 fires and ADR-004 reopens.
