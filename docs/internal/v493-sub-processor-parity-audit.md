# V-493 — sub-processor parity audit (2026-05-10)

Audit of the parity between:

- **Source A** (customer-facing): `apps/marketing-site/src/data/sub-processors.ts:SUB_PROCESSORS`
- **Source B** (legal): `docs/legal/dpa.md` Annex 3 table

Both are intended to mirror the same canonical list. Drift creates
GDPR Article 28(2) risk: customers reading either source must reach
the same conclusion about who processes their data.

> **This audit modifies neither source.** Any sub-processor list
> change is a Tier-3 founder decision because it triggers the 30-day
> Article 28(2) notice cadence. The audit's purpose is to surface
> the deltas for founder review + Tier-3 reconciliation.

## Side-by-side

| Marketing data (SUB_PROCESSORS)               | DPA Annex 3                                               | Status                            |
| --------------------------------------------- | --------------------------------------------------------- | --------------------------------- |
| Hetzner Cloud — Falkenstein, Germany (EU)     | Hetzner Online GmbH — Germany — EEA-internal              | ⚠ Name mismatch (Cloud vs GmbH)   |
| Neon — Frankfurt (EU)                         | Neon, Inc. — US (corp); EU Frankfurt (data)               | ⚠ DPA distinguishes corp vs data  |
| Upstash — Frankfurt (EU)                      | Upstash, Inc. — US (corp); EU Frankfurt (data)            | ⚠ Same corp/data distinction      |
| Cloudflare R2 — EU jurisdiction               | Cloudflare, Inc. — US (corp); EU jurisdiction (data)      | ⚠ DPA covers all CF products      |
| Postmark — EU sending region                  | Postmark (ActiveCampaign LLC) — US                        | ⚠ Marketing missing legal-entity  |
| Sentry — EU region                            | Sentry (Functional Software, Inc.) — US (corp); EU (data) | ⚠ Same                            |
| Stripe — Stripe Payments Europe Ltd (Ireland) | Stripe Payments Europe Ltd + Stripe, Inc. (split)         | ⚠ DPA splits EEA vs non-EEA       |
| Anthropic — United States (no opt-in marker)  | Anthropic, PBC (conditional, opt-in only) — US            | ⚠ Marketing missing opt-in marker |
| Moneybird — Netherlands (EU)                  | Moneybird B.V. — Netherlands — EEA-internal               | ✓ Aligned                         |
| MacStadium — United States                    | (NOT IN DPA Annex 3)                                      | ❌ Marketing-only entry           |
| NowPayments — Estonia                         | NowPayments OU (conditional, opt-in only) — Estonia       | ⚠ Marketing missing opt-in marker |
| LiveKit — US                                  | (NOT IN DPA Annex 3)                                      | ❌ Marketing-only entry           |

## Findings, ranked

### F1 — MacStadium + LiveKit are in the marketing list but NOT the DPA Annex 3

The marketing-site `SUB_PROCESSORS` array includes MacStadium and
LiveKit; the DPA does not. Customers reading the DPA may be unaware
of these processors. Two scenarios:

1. **MacStadium is real but the DPA is stale.** Update the DPA to
   add the entry. Triggers Art. 28(2) 30-day notice (which is
   ostensibly already running because the marketing list has had
   the entry public since `SUB_PROCESSOR_REGISTER_LAST_UPDATED =
2026-05-10`). Verify the customer-facing notice was actually
   sent on entry-add date.
2. **MacStadium / LiveKit are forward-looking marketing entries
   not yet active.** Mark with a `(planned, not yet engaged)`
   qualifier in the marketing list, similar to NowPayments'
   `(conditional, opt-in only)` styling. Or remove from marketing
   until the sub-processor is actually engaged.

**Recommendation**: founder confirms which scenario applies. If (1),
DPA update lands as a Tier-3 slice with the matching Art. 28(2)
notice; if (2), marketing list amends.

### F2 — Marketing list collapses corp-vs-data jurisdiction distinctions

The DPA distinguishes corporate-domicile vs data-residency where
they differ (e.g. Neon: US corp, EU Frankfurt data). The marketing
list shows only the data-residency. Customers comparing the two
sources see "EU" in marketing and "US (corp)" in DPA and may
conclude one of them is wrong.

**Recommendation**: marketing list adds a `corporate_domicile` field
to the `SubProcessor` interface; UI renders both columns at
`/trust/sub-processors`. No Art. 28(2) trigger because no
sub-processor is added or removed; the change is a presentation
clarification only.

### F3 — Anthropic + NowPayments missing the opt-in qualifier in marketing

DPA says "conditional, opt-in only" for both. Marketing list has
that nuance only in the `purpose` text for NowPayments and not at
all for Anthropic. Customers scanning the table may not realize
these processors are bypassed entirely for non-opting customers.

**Recommendation**: marketing list adds an `engagement` field
(`always` / `conditional` / `opt_in`) to the `SubProcessor`
interface; UI shows a badge on the conditional entries. No Art.
28(2) trigger.

### F4 — Postmark's parent legal entity (ActiveCampaign LLC) not in marketing

Customers chasing legal-entity research from the marketing list
won't find ActiveCampaign LLC — they'll search "Postmark" and
land on a brand page that's helpful but not legally complete.

**Recommendation**: marketing list adds a `legal_entity` field for
each entry; UI renders it on the same row as the brand name.
Same change shape as F2/F3. No Art. 28(2) trigger.

### F5 — Stripe split (EEA vs non-EEA) lost in marketing

DPA splits Stripe Payments Europe Ltd (EEA customers) from Stripe,
Inc. (non-EEA customers). Marketing shows only the EEA entity.
For non-EEA customers, the actually-engaged sub-processor is
different.

**Recommendation**: marketing list expands Stripe into two
entries OR adds a `regional_split` annotation on the single entry.
No Art. 28(2) trigger.

## Actionable engineering work (Tier-1 follow-up)

If founder approves the F2/F3/F4/F5 reconciliations (presentation
changes only — no actual sub-processor list change):

1. Extend `SubProcessor` interface in
   `apps/marketing-site/src/data/sub-processors.ts` with optional
   `legal_entity`, `corporate_domicile`, `engagement` fields.
2. Update the existing entries with the additional fields drawn
   from the DPA Annex 3.
3. Update `apps/marketing-site/src/pages/trust/sub-processors.astro`
   to render the new columns/badges.
4. Add a typecheck-time invariant test that asserts every DPA
   Annex 3 entry has a matching marketing entry by legal_entity
   name (catches future drift automatically).

## Tier-3 follow-up (founder action)

F1 (MacStadium + LiveKit DPA absence) requires a founder decision:

- Are MacStadium / LiveKit currently engaged?
- If yes, was the Art. 28(2) notice sent when they were added?
- If no, should the marketing list mark them as planned?

This audit logs the question; engineering does not act on F1 until
founder confirms.

## Audit metadata

- Audit date: 2026-05-10
- Source A version: `SUB_PROCESSOR_REGISTER_LAST_UPDATED = '2026-05-10'`
- Source B version: `docs/legal/dpa.md` Annex 3 table at
  the same date
- Audit scope: 12 marketing entries × 10 DPA entries
- Audit tool: manual cross-reference
- Audit re-run cadence: pre-first-paying-customer + every Art.
  28(2) notice + every quarter post-launch
