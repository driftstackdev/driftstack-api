# Production-readiness assessment — control plane, SDKs, docs (A2)

Written 2026-08-01 after a full-day verification run, and kept current as work lands. This is not a summary of
work done; it is a statement of **what is proven, what is assumed, and what is
open**, so the remaining decisions can be made without re-deriving the evidence.

Every "proven" line below means the same thing: **the behaviour was broken
deliberately and a test went red.** Where that was not done, the line says so.

## Method, stated once

Coverage claims in this repo were not trustworthy on inspection. Four guards
were found whose stated promise was wider than what they asserted — a docs page
claiming `POST /v1/sessions` "only" for a bucket two routes consumed, an
anti-enumeration suite opening with "every customer-facing route" and testing
two of thirteen, a constant-time comparison guard asserting an identifier, and a
key-sharing invariant asserting a comment. **In every case the description was
correct and the assertion was not.**

So the working rule became: break the property, count what reds, and only then
decide whether a guard is worth writing. That measurement is also what says
_don't_ write one — six lanes came back adequately covered and got no new code.

## Proven (mutation-verified)

| area                      | evidence                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope enforcement         | All **163** scope-enforcing routes refuse a key lacking the scope. Staff surface (65 routes) and customer surface (98) each pin an independent roster, because a table generated from the source it grades cannot see a deletion — verified: removing one gate took the run from 67 passed to 66 passed, all green. |
| Cross-account ownership   | Sessions 2 guarding tests → 16, profiles 1 → 12, agent sessions **0** → 12, snapshots **0** → 3, proxies (route level) 0 → 4, crypto orders ~1 → 7. Webhooks + api-keys measured at 23 and deliberately left alone.                                                                                                 |
| Credential secrecy        | BYOK Anthropic key, proxy secrets and api-key plaintext are absent from every response including write and error paths, asserted against the secret **value** rather than its public prefix or its field name.                                                                                                      |
| Rate-limit disclosure     | Every dedicated bucket's consumers are named on every page describing it, per page and forward of the mention. Roster derives from the canonical enum.                                                                                                                                                              |
| PKCE                      | `plain` is refused, proved by sending one and requiring S256 to succeed on the identical request.                                                                                                                                                                                                                   |
| MFA credential management | API keys cannot enroll, disable or regenerate recovery codes — 6 tests hold that gate.                                                                                                                                                                                                                              |
| SSE resource bound        | The public unauthenticated stream refuses past its per-IP cap with 503 + `Retry-After`, over real sockets.                                                                                                                                                                                                          |
| AUP refusal               | Evasion-resistant: zero-width splitters and full-width confusables normalise before matching, and the normalize order itself is pinned.                                                                                                                                                                             |
| SDK consistency           | Three SDKs expose the same 19 resources and the same methods modulo language idiom; two deliberate aliases are allowlisted with reasons.                                                                                                                                                                            |
| Production dependencies   | `npm audit --omit=dev` is zero at any severity, now gated in CI. All 12 remaining advisories are build/lint tooling.                                                                                                                                                                                                |
| Billing idempotency       | A retried usage write cannot charge a turn twice — one row id per row, reused across attempts, insert `onConflictDoNothing`. Both halves guarded because they fail independently: a stable id with a plain insert still double-writes, and a conflict-safe insert with a per-attempt id does too.                   |
| Intent replay safety      | `intentReplayMayDuplicateEffect` fails safe: it enumerates the SAFE kinds and treats anything unrecognised as effectful, so a new intent kind is not auto-retried after an ambiguous WebDriver failure until someone says it can be.                                                                                |
| Retention erasure         | Wrapped proxy credentials, profiles and snapshots are erased 30 days after account termination, with sealed R2 blobs dropped. Safety predicates live in SQL beside the delete target; an active account survives a direct clear call with its own id.                                                               |
| Webhook fairness          | One broken endpoint cannot starve the rest — the claim ranks per endpoint rather than global FIFO. Held on BOTH implementations so the staged cutover cannot reintroduce it.                                                                                                                                        |
| SDK retry safety          | A create is never auto-retried without an Idempotency-Key, in all three SDKs. Go had no coverage of the gate at all; PATCH was untested everywhere.                                                                                                                                                                 |
| Observability             | Retention purge outcomes are labelled per arm with a `skipped` value, and a scrape-time gauge reports a dead job chain as 0 rather than as an absent series. Every emitted metric is registered at boot.                                                                                                            |

## Assumed, not proven

- **Deploy-time behaviour.** Nothing here was deployed, and nothing has been
  pushed — see open item 1. Migration `0108` applied cleanly to a populated local
  Postgres; production application is unverified by A2.
- **First-run volume of the retention purges.** The three erasure paths shipped
  today have no batch limit. On a production backlog of long-terminated accounts
  the first run deletes everything past the cutoff in one pass. Correct, but
  unmeasured at scale; the existing trash purge has the same shape.
- **Observability.** Sentry, email and LiveKit activation flags are wired in
  config and untested against the real services from this repo.
- **Performance under load.** The bench-regression job is advisory
  (`continue-on-error: true`) by an explicit earlier decision. No load test was
  run.
- **The GUI keychain fix** (`81460cf01`) is a git-verified ancestor of the tree
  A3 built and installed. A2 could not grep the compressed bundle to confirm it
  directly, and said so rather than claiming delivery.

## Open — needs a decision, not more engineering

Ten items. Each states the evidence, what happens if nothing is decided, and a
recommendation. None is blocked on more test coverage; every one is blocked on
somebody choosing.

**The list is ordered by what it costs to keep waiting**, not by effort.

### 1. 1,031 commits have never reached CI

`git rev-list --count @{u}..HEAD` = **1,031** (was 1,022; 40 commits landed in
the preceding six hours). Upstream's tip is `6b3a856cd`, dated **2026-07-12** —
nineteen days. Every "gates green" any agent has reported, including all of
mine, is a LOCAL result.

_Doing nothing:_ the divergence grows and the eventual push is a single
high-risk event. _Evidence it would land:_ CI's entire job list re-run locally
at 1,031 commits — build (all five Astro sites + server), SDK build, typecheck
across eight workspaces, lint, format, `npm audit --omit=dev --audit-level=high`
(0 vulnerabilities), `vitest run --coverage` (lines 89.83 / statements 88.11 /
functions 88.51 / branches 79.24, against 80/80/80/75), Playwright e2e (199
passed), Python SDK (337 passed, mypy clean over 43 files) and Go SDK (vet
clean, tests ok). _Recommendation:_ push — but read item 11 first: there is one
intermittent failure that CI can hit and local runs mostly do not.

Branch coverage sits at 79.24% against a 75% floor. That is 4.24 points of
headroom and it is the metric that drifts down as source is added, so it is
worth watching rather than acting on.

### 12. Agent transcripts and turn receipts are retained forever, including after account termination

`agent_sessions` (encrypted transcripts) and `agent_turn_receipts`
(`response_ciphertext` — the agent turn's response body) have **no purge of any
kind**. Not a retention sweep, not a cutoff, not a cleanup job. Both tables grow
without bound and both keep customer content indefinitely after an account is
terminated.

This is the third instance of one pattern, and the pattern is what matters:
`deleteAccount` is a SOFT delete, so the `ON DELETE CASCADE` on
`agent_turn_receipts.account_id` never fires — the accounts row is never
hard-deleted. That is exactly why proxy credentials (`6671cde70`) and profiles
plus snapshots (`1ef6d4229`) were both retained past their disclosed windows.
Neither of those fixes generalised, because each added one arm for one table.
The account-deletion purge sweeper now has three arms and these two tables are
not among them.

_Against the published policy:_ the retention table in `docs/legal/privacy-policy.md`
caps "Session metadata" at "90 days operational" and permits indefinite
retention only for "aggregated counters (no PII)". A transcript and a response
body are neither. DPA §3.8 separately commits to deletion or return within 30
days of termination.

_Verified, not assumed:_ no `delete`/`purge` on either table anywhere in
`apps/server/src`; the sweeper's three arms are byok, proxy secrets, and
profiles+snapshots; and nothing nulls `transcript` on close or
`response_ciphertext` on completion, so the content is live in the row rather
than a husk.

_Doing nothing:_ two unbounded tables, and a disclosed retention commitment that
is not met for the richest customer content in the product.
_Recommendation:_ a fourth and fifth sweeper arm on the established pattern —
bounded per tick, independently optional, per-arm metric. Receipts are the
simpler half (no blob side effects); `agent_sessions` needs a check for
usage-record and LiveKit references first. **A2 did not implement this in the
fire that found it:** it is two repo methods, two sweeper arms, metrics and
guards, and starting it with little runway risks leaving a half-wired sweep,
which for an erasure path is worse than none. It is the top item for the next
fire.

_Worth noting for whoever picks it up:_ the same soft-delete-vs-CASCADE question
applies to every table with an `account_id` foreign key. Fixing these two by
hand makes it four tables closed out of however many exist; a guard that
enumerates `account_id`-bearing tables and asserts each is either purged or
explicitly exempted would stop the fourth instance rather than find it.

_Scale of it, measured:_ **34 tables carry an `account_id` column. 21 have no
delete path anywhere in `apps/server/src`** — no `.delete(table)`, no
`DELETE FROM`. That detector is crude and the 21 is an upper bound, not a
finding: several of those tables SHOULD retain. `subscriptions`,
`usage_records`, `crypto_orders` and `billing_email_sends` are billing data the
policy holds for 7 years; `account_audit_log` is the compliance trail; the
token tables may be cleared by expiry sweeps this detector cannot see. The list
is a work-list, not a defect list, and treating it as the latter would be the
same mistake as trusting the stale dashboard-only list in item 11's cousin.

That is exactly why the guard should be a ROSTER — each `account_id`-bearing
table classified as purged, retained-by-policy with the policy line quoted, or
operationally ephemeral — and why A2 did not write it in this fire. Classifying
34 tables at speed produces a guard that asserts "this one is fine" for tables
nobody checked, which reads as coverage and is worse than the gap. It needs
per-table verification against the published retention table, and it should be
built alongside the sweeper arms above rather than bolted on after.

### 11. One integration test can fail intermittently in CI, and the mechanism is proven

Three cases in `db-webhooks-concurrency-drizzle.test.ts` assert on the result of
`encryptLegacySecrets`, which sweeps `webhook_endpoints` **globally** — it takes
no account scope. They assert exact totals (`{scanned: 1, converted: 1,
remaining: 0}` at line 184, `scanned: 3` at 243, `converted: 0` at 347), which
is really an assertion that the whole table holds exactly the rows that test
created.

_Proven, not suspected:_ seeding one legacy-secret endpoint under an unrelated
account and running the file in isolation reproduces the failure exactly —
`expected { scanned: 2, converted: 2 } to deeply equal { scanned: 1,
converted: 1 }`. Six real-Postgres integration files insert legacy webhook
secrets and vitest runs files in parallel, so any overlap between them and this
one breaks it.

_Frequency, corrected upward:_ **three of six** full-suite runs with
`DATABASE_URL` set, not the "once" first recorded. It is green in isolation
every time and green on targeted runs of every webhook file, so it needs
full-suite parallel load to appear. This matters for item 1 specifically because
CI runs `vitest run --coverage` against a real Postgres service — the exact
configuration that hits it. Most local runs skip these files entirely, because
they are gated on `DATABASE_URL`.

_One mechanism found and closed (`024eb4f6c`)._ The exact-total assertions were
re-expressed as the sweep's real invariant — everything scanned was converted,
nothing left legacy — which holds no matter who else has rows. That is not
leniency and was proved so: an upgrader reporting `converted: 0` reds two cases,
one misreporting `remaining` reds three, one dropping `secretPrev` from the
write reds three, and one dropping the four-field CAS predicate reds one. With
one and two seeded foreign legacy rows the file now passes where it previously
failed deterministically.

_Still open._ The same three cases failed once more under full-suite load after
that fix, so at least one mechanism remains. The evidence now points at timing
rather than data: the CAS case polls `pg_stat_activity` for only 100 × 10 ms
before asserting the migrator reached its lock wait, and the suite's
`testTimeout` is 10 s — both are load-sensitive in a way the data path is not.
Confirming it needs the assertion text from a failing run, which requires
catching one; the failures are not reproducible on demand.

_Doing nothing:_ the push lands an intermittently red CI, and an intermittent
red is the kind that gets re-run until green and then stops being read.
_Not recommended:_ raising the poll budget until it stops failing. That tunes
the symptom without establishing what the wait is competing with, and a timing
constant chosen to make a test pass is one that will need raising again.
_Recommendation:_ capture a failing run's assertion text first — a persistent
reporter over repeated full-suite runs — then fix the mechanism that shows up.
Isolating the real-Postgres files onto their own database remains the
structural answer if the cause turns out to be contention rather than a thin
timing budget.

### 2. Three subsystems are built, tested, and have never run

Recorded in code at `apps/server/tests/unit/tick-services-are-wired-invariant.test.ts`
rather than only here, so they cannot go quiet again.

- **`AuditArchiveService`** (ADR-006). Sweeps rows older than 90 days out of five
  tables — `admin_audit_log`, `processed_stripe_events`, `legal_acceptances`,
  `webhook_deliveries`, and the high-volume `session_events` action log — into R2,
  then DELETEs them. `audit_archive_runs` has **zero rows**. _Doing nothing:_
  those five tables have no retention bound, two are explicitly high-volume, and
  the privacy policy's "Session metadata: 90 days operational" line has no
  mechanism behind it. _Recommendation:_ wire it, but on a staging dataset first
  — it deletes production rows after an R2 upload.
- **`WebhookSecretForceRotationService`**. Rotates webhook signing secrets past
  91 days and emails the customer a 7-day grace deadline. Its sibling
  `WebhookGraceExpiringNoticeService` IS wired, so the half that warns about
  expiring grace windows runs while the half that opens them does not.
  _Doing nothing:_ signing secrets never rotate. _Recommendation:_ decide the
  policy first — turning it on breaks any integration that ignores the grace
  window.
- **`DurableWebhookDeliveryService`**. The documented V-173 successor, awaiting
  soak time. _Doing nothing:_ fine, this one is genuinely staged. Its claim query
  is kept in step with the live one so a cutover cannot reintroduce the endpoint
  starvation fixed in `84dc306b1`.

### 3. Two retention-table lines cannot be honoured as written

- **"Revoked API keys retained 90 days for audit then deleted."** Nothing deletes
  `api_keys` rows and nothing can: `sessions.api_key_id` is **RESTRICT**, and
  sessions are retained seven years under the Dutch tax-law line in the same
  table. _Recommendation:_ reword to match reality (credential material zeroed,
  metadata retained), or change the FK. It is a text-or-schema decision.
- **"Session metadata: 90 days operational."** Coherent, and item 2's archiver is
  the mechanism — it archives rather than deletes, so it does not conflict with
  the seven-year billing line. Resolves itself once the archiver runs. _(This
  corrects an earlier reading of mine that called the line ambiguous.)_

### 4. Webhook delivery is capped near 25 deliveries/minute

`POLLER_INTERVAL_MS = 60_000` with `batchSize` 25, and the batch is delivered
serially. Per-endpoint fairness is fixed (`84dc306b1`), so one broken endpoint no
longer starves the rest — but the global ceiling stands. _Doing nothing:_ the
cap binds as soon as a real customer base generates events. _Recommendation:_
give webhook delivery its own interval rather than the shared poller constant.
A2 did not, because it changes outbound load on customer endpoints and our
egress.

### 5. An abandoned paid session bills indefinitely

Billed minutes derive from the `sessions` table, and an `active` row with no
`destroyed_at` accrues to `now()`. Only `free` is capped — the duration sweeper's
own comment says "paid = null = never", and its suite pins that. A paid session
ends only via customer DELETE, a failed operation, admin action, or suspension,
and there is **no liveness signal on driver sessions**. _Doing nothing:_ a
silently-dead driver keeps billing. _Recommendation:_ needs A1/A3 input on
whether driver death reaches the control plane; A2 cannot verify that from here.

### 6. Unrecognised request fields are silently dropped

Zod strips unknown keys and the routes use `safeParse`. A customer who mistypes
`archetype` on profile creation gets **201 Created** with the default archetype
substituted. _Doing nothing:_ silent misconfiguration presented as success, in a
product whose value is which device you appear to be. _Recommendation:_ product
call — making the schemas strict is a breaking change for any client already
sending extra fields. Current behaviour is pinned so a change is deliberate.

### 7. Free-tier OAuth consent, and 8. free-tier API-key minting

Unchanged from the original assessment: both are coherent product policy, both
are pinned by their own tests so they stay visible, and neither is a defect.

### 9. GUI signing identity

Both bundles are ad-hoc signed (`TeamIdentifier=not set`), so every rebuild voids
the keychain grants "Always Allow" pinned to the old cdhash. The per-call prompt
storm is fixed in code; this half needs Developer ID or a stable self-signed
identity, and touches the founder's machine and the release path.

### 10. Prettier is declared `^3.4.0`

A caret range on a formatter. The lockfile pins 3.8.3 and the installed copy only
caught up on 2026-07-31, at which point the format gate went red on 24 files
formatted under an older version — while `.husky/pre-push` runs `format:check`,
so the next push would have failed. Fixed in `940cd90d7`. _Recommendation:_ pin
exactly, so a future minor bump cannot reformat the repo silently. A2 did not,
because it means editing `package.json` and the lockfile while A3 was actively
working dependencies.

## What A2 deliberately did not do

- No suite where measurement showed the boundary already covered — webhooks and
  api-keys ownership (23), tier caps (26), act-as, redaction, the SSE DoS bound.
  A redundant suite looks like progress and protects nothing.
- No removal of `/v1/whoami` despite it having no consumer. It answers "which
  key am I holding and what can it do", which nothing else answers; it was
  documented instead.
- No speculative fix to shared test infrastructure. The stale-vite-cache reap
  could not be reproduced on demand, so the condition is healed rather than the
  suspected root cause guessed at.
- No widening of another agent's guard without a demonstrated gap behind it.

## Current state

Node suite **2,559 files / 26,548 passing** with `DATABASE_URL` set, so the
real-Postgres integration files run rather than skip. e2e **199 / 0**, from
187/10 at the start of the run. Python SDK 337 tests + mypy strict over 43
files; Go SDK vet and tests clean; all five Astro sites typecheck clean;
`npm audit --omit=dev` 0 vulnerabilities.

One caveat on reading any of these numbers, including mine: a suite run without
`DATABASE_URL` silently SKIPS every `db-*` integration file, and the totals it
prints look like a full pass. The figures above are from a run with the database
present. See item 11 for the one intermittent failure that configuration can
surface.
