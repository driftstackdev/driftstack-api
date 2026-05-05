# Moneybird — integration scoping

> Status: scoping doc, not implementation. Captures Moneybird's role in the
> Driftstack stack, what data flows where, and the open questions that
> need founder + accountant + counsel review before implementation can
> land. Implementation gates on KvK closure (BV registered → Moneybird
> account opened under BV name) and resolution of the open questions in
> the final section. Authored 2026-05-03 per Workstream E.

## Why this doc

The Driftstack control plane has three systems that need to agree on
what was billed, when, to whom, and at what tax rate:

1. **Driftstack DB (Postgres)** — accounts, subscriptions, sessions,
   usage records.
2. **Stripe** — payment instruments, charges, subscription state machine,
   metered billing for BYOK + overage, Stripe Tax computation.
3. **Moneybird** — invoices of record, ledger entries, BTW filings, tax
   returns submitted to the Belastingdienst.

Stripe and Moneybird are both authoritative for things that overlap.
Stripe issues receipts and computes per-region VAT/BTW; Moneybird is
where the BV's accountant looks for the books. Whichever side this doc
lands on as primary, the other has to follow — and the cost of getting
this wrong shows up at year-end, not at request time.

Writing this scoping pass _before_ implementation means we get the
boundary right rather than discovering it during reconciliation.

## Sub-processor classification

Moneybird is on the V-052 sub-processor lock and listed at
`/trust/sub-processors`. Customer data flowing through Moneybird is
limited to billing context (account email, invoice line items, totals,
tax handling, billing address, VAT-ID where supplied). Session content,
recordings, captures, API key material, and BYOK provider keys do
**not** flow.

The Privacy Policy + DPA Annex 3 already capture this scope. No
additional consent surface lands when implementation does — but a
sub-processor-amendment notice _would_ fire if Moneybird's scope
expanded beyond billing context.

## Source-of-truth boundary

Three systems, three authorities. The proposed boundary:

| Question                                  | Authoritative source     |
| ----------------------------------------- | ------------------------ |
| Does this account exist?                  | Driftstack DB            |
| What tier is this account on?             | Driftstack DB            |
| Did this charge succeed?                  | Stripe                   |
| What VAT/BTW was applied to this invoice? | Stripe (via Stripe Tax)  |
| What appears on the BV's books?           | Moneybird                |
| What was filed on the BTW return?         | Moneybird                |
| What's the lifetime revenue from acct X?  | Moneybird (audited side) |

Driftstack DB ↔ Stripe sync via Stripe webhooks already (Workstream D
will land the handlers per V-060 / ADR-002). Stripe ↔ Moneybird sync is
the new axis this doc scopes.

## Revenue categories

Four distinct revenue streams need separate treatment in Moneybird's
ledger:

1. **Subscription MRR** — recurring revenue from API tier subscriptions
   (Starter / Solo / Builder / Scale / Enterprise). Recognised at the
   end of each billing period per Dutch revenue-recognition norms.
   Counted toward MRR/ARR analytics. (Tier names + amounts are subject
   to the V-070 pricing-restructure pass; this category survives any
   restructure.)
2. **Trial-pack one-time revenue** (per ADR-003) — $2.99 one-time
   charges. NOT counted toward MRR. Goes to a separate "Trial pack
   revenue" ledger line so monthly MRR analytics aren't polluted by
   trial volume. **Open question**: recognised at purchase time, or
   amortised over the 14-day window? (See open-questions section.)
3. **BYOK LLM markup revenue** — metered overlay on Stripe Meter events
   (`driftstack_llm_tokens` per V-053 env-var schema). Markup over the
   provider's published per-token price. NOT counted toward MRR
   (variable, usage-driven). **Open question**: "service revenue" or
   "passthrough revenue net of passthrough cost"? Different ledger
   treatment in Dutch GAAP.
4. **Self-hosted contract revenue** — annual prepaid contracts. Counted
   toward MRR but on a separate "Self-hosted MRR" line for analytics
   distinguishability. **Open question**: recognised at purchase or
   amortised monthly per IFRS 15 / Dutch equivalent?

Refunds (trial-pack within 14d if no sessions started, per the FAQ
copy) need a Moneybird credit-note workflow coordinated with the
Stripe refund. Single canonical refund event in Stripe → fans out to
the correct Moneybird credit note per category.

## Per-region BTW handling

Stripe Tax is the computational source. The matrix it applies:

- **B2B EU customer with valid VAT-ID** → reverse-charge applied; VAT
  not collected. VIES-validated at checkout.
- **B2C EU customer** → VAT collected at customer's country rate.
- **Customer outside EU** → no VAT collected.
- **Driftstack BV (NL) selling to NL customer** → 21% domestic if B2C;
  reverse-charge to 0% if B2B.

Stripe Tax outputs the per-line tax computation on every invoice. The
question Moneybird needs answered is: how does that arrive in the
ledger?

Three patterns to evaluate:

### Pattern A — Stripe → Moneybird via webhook + control-plane bridge

Stripe webhook fires `invoice.finalized` (or `invoice.paid` for
post-payment). Driftstack control plane catches it, transforms the
Stripe invoice payload into a Moneybird invoice line, posts via
Moneybird API.

**Pro:** Real-time. Driftstack owns the transformation logic, can
enforce idempotency through the existing webhook-handling
infrastructure (Workstream D).

**Con:** Driftstack is now a sync-coordinator. Failures need retry
queues, Moneybird API rate-limits need to be respected, version-skew
handling between Stripe invoice schema and Moneybird invoice schema
is on us.

### Pattern B — Scheduled batch sync

Daily/weekly cron job pulls Stripe invoices that haven't yet been
posted to Moneybird, batch-posts them.

**Pro:** Simpler error handling — failures retry on next batch. Lower
sustained load on Moneybird API. Easier to audit (one batch = one
log entry).

**Con:** Customers may see a Stripe invoice "paid" without it
appearing in Moneybird until the next batch — usually fine, but
year-end timing edges matter. Founder/accountant can't act on
yesterday's revenue until today's batch lands.

### Pattern C — Native Stripe ↔ Moneybird connector (if it exists)

Some Moneybird integrations exist (Zapier, Make.com); a native Stripe
connector may exist on Moneybird Marketplace. If it does and meets the
Driftstack accounting requirements, use it — defer custom integration
to "if the native connector breaks down" trigger.

**Open dependency:** founder verify Moneybird Marketplace state when
implementation gates open. If a native Stripe connector exists with
acceptable scope (handles Stripe Tax line items + VAT-ID
reverse-charge correctly), it's the lowest-maintenance path.

**Recommendation pending verification**: Pattern C if available,
Pattern A as fallback. Pattern B is too lagging for first-paying-
customer year-end.

## Authentication: OAuth2 vs Personal Access Token

Moneybird supports both.

**OAuth2** (recommended for production):

- Driftstack registers as a Moneybird OAuth client.
- Token has scoped permissions (read/write invoices, read/write
  contacts, etc. — request only what's needed).
- Revocable per-app from the Moneybird admin UI without invalidating
  other tokens.
- Token refresh handled by the OAuth flow.

**Personal Access Token** (acceptable for staging):

- Single token in `MONEYBIRD_API_TOKEN` env var (already documented in
  V-053 env-vars schema).
- Full administrative access to the Moneybird administration.
- Rotated by founder; no per-app scope.
- Simple to set up — fits the existing env-var pattern.

**Recommendation:** OAuth2 for production with scopes
`sales_invoices`, `purchase_invoices`, `documents`, `bank`, `time`
(scope list to be finalised against actual Moneybird API surface used).
PAT for staging environment only — convenient for early development,
revoked once OAuth client is registered.

## Sync mechanics — design notes

When implementation lands (per Pattern A or C-fallback-to-A):

- **Idempotency key:** the Stripe invoice ID (`in_xxx`) is the natural
  idempotency key for the Moneybird counterpart. Posting the same
  Stripe-invoice-ID twice should be a no-op, not a duplicate.
- **Failure handling:** Moneybird API failures route to a dead-letter
  queue (Postgres table or Redis stream — Workstream D decides).
  Founder gets a daily summary of failed posts so manual reconciliation
  is possible before year-end.
- **Schema drift detection:** monthly automated reconciliation that
  compares Stripe's "invoices paid in the last 30 days" against
  Moneybird's "invoices posted in the last 30 days" by Stripe-invoice-
  ID and total amount. Mismatches surface to the founder.
- **Customer-data minimization:** the Moneybird invoice carries only
  what's needed for an invoice — customer name, email, VAT-ID where
  supplied, billing address, line items, totals. No session metadata,
  no API key references, no usage detail beyond the aggregate
  representation Stripe already provides.

## Implementation gates

This doc is scoping. Implementation gates on **all** of the following:

1. **KvK closure** — BV registered with the Belastingdienst, BV
   structure visible in KvK register, BV bank account opened. Until
   the BV exists, there's no entity to register a Moneybird
   administration against.
2. **Moneybird account opened** under the BV's legal name with the BV
   bank account linked. Founder action; agent does not.
3. **Accountant review** of the proposed Stripe ↔ Moneybird boundary.
   Accountants in NL have opinions about which side is authoritative
   for tax purposes; this doc is the agent's recommendation, but the
   accountant gets the final call.
4. **Counsel review** of the trial-pack revenue-recognition rule
   (purchase vs amortised) and the BYOK markup revenue treatment
   (service vs net-of-passthrough). Both have year-end
   reporting consequences.
5. **Pattern selection** — A vs B vs C decided after Moneybird
   Marketplace inventory check.
6. **OAuth2 client registered** with Moneybird (production only).

## Open questions

The questions below need founder + accountant + counsel review before
implementation lands. Decisions logged here when they arrive.

1. **Trial-pack revenue recognition.** $2.99 charge collected at
   purchase; trial credit decrements over 14 days as usage occurs.
   Recognised at purchase time (cash basis), or amortised over 14
   days (revenue-recognition basis)? Dutch revenue-recognition rules
   for one-time prepaid digital service consumption — accountant
   call.

2. **BYOK markup revenue treatment.** Customer pays Driftstack the
   markup; Driftstack pays the underlying provider the wholesale
   per-token price. Two ledger postures:
   - **Service revenue (gross)**: Driftstack's revenue is the full
     amount the customer pays; cost-of-revenue is the wholesale
     payment to the provider.
   - **Net revenue (passthrough)**: Driftstack's revenue is only the
     markup (full amount minus passthrough cost).
     Tax treatment, MRR computation, and book-balance shape all differ.
     Accountant + counsel call.

3. **Self-hosted prepaid annual contracts.** Customer pays $14,400
   for an annual Self-Hosted Solo contract. Recognised at receipt
   (cash basis) or amortised $1,200/mo over 12 months (IFRS 15 /
   Dutch GAAP equivalent)? Affects MRR analytics + year-end revenue
   reporting differently. Accountant call.

4. **Refunds — credit-note workflow.** Stripe issues a refund (e.g.
   trial-pack 14-day window with no sessions started, per FAQ).
   Moneybird needs a credit-note posting matching the original
   invoice. Mechanism for ensuring 1:1 correspondence between Stripe
   refunds and Moneybird credit notes — webhook-driven, batch, manual?

5. **Moneybird Marketplace native Stripe connector — does it exist?**
   Founder verifies at implementation time. If yes, Pattern C is
   default; if no, Pattern A is default.

6. **MRR / ARR computation source.** Driftstack DB will compute MRR
   from active subscriptions (Workstream D). Moneybird will compute
   MRR from invoiced amounts (post-payment). These may differ within
   a billing cycle (Driftstack DB shows committed MRR; Moneybird
   shows collected revenue). Which is the "official" number for
   investor / founder reporting?

7. **Billing address vs shipping address.** Stripe customer object
   has billing address. Moneybird needs the contact/billing address
   for invoice generation. Stripe-shipping-address — not used by
   Driftstack (no physical product) — does it map to anything in
   Moneybird?

8. **VAT-ID validation timing.** Stripe Tax validates VAT-IDs against
   VIES at checkout. Moneybird also validates VAT-IDs. If they
   disagree (rare, but VIES is occasionally flaky), which side wins?

## Implementation surface — what lands when

When all gates clear, expected surface in `apps/server/`:

- `apps/server/src/lib/moneybird.ts` — typed wrapper over Moneybird API
  (similar to V-056 R2 wrapper + V-057 Postmark wrapper). Methods:
  `createInvoice`, `createCreditNote`, `findContactByEmail`,
  `upsertContact`. Test seam for stubbed-API tests; real API calls
  guarded behind `config.moneybird !== null`.
- `apps/server/src/services/billing-sync.ts` (working name) — reconciles
  Stripe webhooks → Moneybird postings. Idempotent per Stripe invoice
  ID. DLQ for Moneybird failures.
- `apps/server/src/lib/config.ts` — `moneybird` block already
  scaffolded in V-053 (`MONEYBIRD_API_TOKEN`, `MONEYBIRD_ADMINISTRATION_ID`).
  Add OAuth2 fields when production posture lands.
- Sub-processor entry on `/trust/sub-processors` — already present per
  V-068.

Estimated scope: 2–3 V-entries depending on pattern selection. Ships
after Workstream D's Stripe-billing scaffolding lands and after the
above gates clear.

## References

- ADR-002 (Stripe-only payment processing) — payment-rail context that
  Moneybird sits downstream of.
- ADR-003 (paid trial pack) — the one-time-revenue line that
  necessitates separate Moneybird ledger treatment.
- ADR-004 (pricing restructure to two-ladder concurrent-only) —
  defines the 8 paid tiers + concurrent-only metering that Moneybird
  invoice line items must align with. Subscription-line shape +
  monthly/annual cadence flow from this ADR; trial-pack survives ADR-004
  unchanged per its Notes section.
- V-052 (Coinbase Commerce dropped from sub-processor list) — single-
  rail posture making Moneybird's input simpler.
- V-053 (env-vars schema) — `MONEYBIRD_API_TOKEN` + `MONEYBIRD_ADMINISTRATION_ID`
  slots reserved.
- `/trust/sub-processors` (V-068) — Moneybird entry public.
- `docs/legal/dpa.md` Annex 3 — Moneybird sub-processor with NL
  jurisdiction + EU-resident transfer-mechanism.
