# Driftstack API — Verification Log

This log records every verification of empirical reality (build cycles, test runs, infrastructure assumptions) and every discrepancy between intent and behaviour. Entries are append-only and dated.

When intent and reality disagree: reality wins, code reflects reality, planning is updated, the change is recorded here.

Format: `V-NNN — title`. Date in body.

> **Split 2026-08-20.** Entries up to and including V-1200 are in
> [`verification-log-archive-through-v1200.md`](./verification-log-archive-through-v1200.md). This
> file had reached 52,429 lines / 3.4 MB and Prettier — which the pre-commit hook runs with an 8 GB
> heap — began failing on it with `Ineffective mark-compacts near heap limit`. A 16 GB heap parses
> it, but this machine HAS 16 GB, so raising the limit would hand one hook process the whole
> machine. The archive is frozen and listed in `.prettierignore`; the charter above still governs
> both halves, and the guards that read this log read both.

---

## V-1201 — twelve unordered reads, five acquitted by a unique index, two that were not

A Postgres `SELECT` with no `ORDER BY` has no guaranteed row order. An in-memory double returns
insertion order, every time, for free. That is the V-1197 shape once more, with the double
supplying a _guarantee_ rather than a predicate: a test asserting an order passes against the
double and promises something the shipping query does not provide.

Fourteen array-returning reads in `apps/server/src/db/` carried no `ORDER BY`. Each was checked
against its consumers, because the rule is not "reads need ORDER BY" — most of these genuinely do
not, and an ORDER BY on a purge-job id list is cost with no meaning.

**Five looked like defects and were closed by a constraint, not by the query.** Arbitrary order is
only observable when something contests a key:

```
auth-repo.findActiveRateLimitOverrides  indexOverrides() is last-write-wins keyed by bucketKey
                                        -> UNIQUE (account_id, bucket_key): never contested
auth-repo.findTeamMemberships           consumed as ctx.teams.find(t => t.ownerAccountId === …)
                                        -> UNIQUE (owner_account_id, member_account_id): at most
                                           one match, so it cannot pick a different ROLE per request
pricing-repo.listAll                    folded into a Map keyed by tier
                                        -> tier is the pricing PRIMARY KEY; the returned order comes
                                           from the TIER_MONTHLY_PRICE_CENTS ladder, not from SQL
usage-repo.dailyBucketsForRange         GROUP BY with no ORDER BY, but the result is merged into a
                                        Map and explicitly sorted by date before it is returned
status-subscribers.listConfirmed        incident fan-out mails every recipient — no batching or slice
```

The rate-limit and team-membership ones are worth naming: both would have been real. A contested
`bucketKey` means a customer's rate limit varies per request; a contested membership means `.find()`
can return a different ROLE. Both are unreachable, and only the unique index says so — nothing in
the query or the consumer does. That is the fifth time this session a hole has been closed by a
constraint rather than by the code around it.

**Two did not survive the review.** `oauth-links-repo.listForAccount` and
`email-preferences-repo.list` both render straight to the customer — the dashboard's "Connected
accounts" list (and, with `?active_only=false`, the revoked history) and the email-preference list.
With no `ORDER BY`, the same account can see its own rows in a different order on each load. Both
gained one in this commit: links by `(linked_at, id)` — `id` so two links made in the same instant
still order deterministically — and preferences by `event_type`.

**The guard** is `apps/server/tests/unit/an-unordered-read-is-reviewed-not-accidental.test.ts`. It
holds an allowlist of the twelve that remain, each entry recording which consumer was checked and
why arbitrary order is unobservable there. A new unordered read must earn its place rather than
inherit the silence, and a stale entry — method renamed, deleted, or since ordered — fails too,
because reasoning that no longer describes any code would keep vouching for whatever took the name.

Mutation-proved:

```
M1  revert the oauth-links ORDER BY  -> listForAccount reported unreviewed   1 failed | 3 passed
M2  an allowlisted read gains one    -> pricing-repo::listAll reported stale 1 failed | 3 passed
M3  the detector stops detecting     -> self-check + both list arms red      3 failed | 1 passed
restored (source 0 dirty)                                                    4 passed
```

M1 is the one that proves two things at once: that the fix in this commit is load-bearing, and that
the detector notices a read losing its order. M3 cascades on purpose — a dead detector empties the
scan, so the allowlist agrees with it and only the self-check arm can tell you why the repo suddenly
looks clean.

---

## V-1202 — one env-var copy-paste puts a paying customer on the wrong plan

V-1201's lesson generalises: a last-write-wins fold is only safe when something stops two rows
contesting the same key. There, five folds were acquitted by a unique index. So I swept for folds
whose key has NO constraint behind it.

`account_email_preferences` came back safe — `(account_id, event_type)` is the primary key, the
sixth time this session a constraint has closed one of these.

**The one that is not backed by anything is in config.** `bootstrap.ts` builds the Stripe reverse
map:

```
priceToTier[prices.monthly] = tier;
priceToTier[prices.annual]  = tier;
```

from `config.stripe.tierPrices`, parsed by `parseTierPrices` out of `DRIFTSTACK_TIER_PRICE_IDS`.
That parser validated SHAPE only — each value a string or `{monthly, annual}` — and the Zod schema
is a plain `z.record`, so neither checks anything across keys.

If one price id appears under two tiers, the fold resolves it to whichever tier is iterated LAST.
`StripeWebhooksService` then reads `this.config.priceToTier[priceId]` and writes that tier onto the
subscriber. A copy-paste when adding a tier — the most likely way that env var is ever edited —
silently places customers on the wrong plan. Nothing throws, nothing logs; the webhook handler only
warns when a price id is ABSENT from the map, never when it is ambiguous.

**The fix is at the parser**, matching the fail-fast posture its own header already claims
("Throws on malformed input so a misconfigured deploy fails fast at boot"), and it names both tiers
so a bad deploy is diagnosable — the same reason the existing arm gives for naming the offending
tier.

**The subtlety, and a vacuous test caught by mutation.** A price id may legally repeat WITHIN a
tier: the legacy flat shape (`"tier": "price_x"`) deliberately synthesises `monthly === annual`, and
an existing arm pins that behaviour. So the rule is "no price id maps to two DISTINCT tiers", not
"no price id appears twice".

My first implementation iterated `new Set([prices.monthly, prices.annual])`, and my positive control
asserted the flat shape still parses. Mutating the check from `owner !== undefined && owner !== tier`
to `owner !== undefined` **did not fail** — the Set had already collapsed the within-tier duplicate,
so no test could distinguish the two implementations. The control could not fail, which makes it
worth nothing.

Removing the Set puts the whole rule in one place, `owner !== tier`, where a test can reach it:

```
M1  the cross-tier throw removed        -> duplicate arm red        1 failed | 8 passed
M2  check counts repeats, not tiers     -> flat-shape arm red       2 failed | 7 passed
restored                                                            9 passed
```

M2 reds two arms — my control and the pre-existing legacy-flat-shape arm, which is the right
answer: they describe the same behaviour and should fail together. Before removing the Set, M2 red
nothing at all.

The lesson is the one this log keeps relearning from a different direction: a redundant safeguard
is not free. The Set and the tier comparison both implemented "within-tier reuse is fine", and the
overlap made the real rule untestable.

---

## V-1203 — the guard I shipped one commit ago had an unstated blind spot

Continuing the fold sweep from V-1202 into `legal-repo.ts:82`, which folds legal acceptances by
`document_key`. An account that accepted v1 and later v2 has two rows under one key, so the
surviving record decides which version of the terms the customer is recorded as having accepted.

It is correct, and carefully so:

```
SELECT DISTINCT ON (document_key) …
FROM legal_acceptances WHERE account_id = $1
ORDER BY document_key, accepted_at DESC, id DESC
```

`DISTINCT ON` with the matching `ORDER BY`, latest acceptance first, and an `id DESC` tiebreaker
because `accepted_at` is not monotonic-unique. Its comment notes the in-memory double carries the
same tiebreaker — the V-1198 agreement problem, already solved here.

**What it exposed is mine.** V-1201's detector walks Drizzle `.select(` chains. `legal-repo` uses
`db.execute(sql`…`)`, so this query — and every other hand-written one — was invisible to the guard
I had committed minutes earlier. A guard whose entire subject is unstated guarantees was itself
making one.

**Measured before being described**, per the rule that keeps proving itself: 22 raw SELECT blocks
in `src/db`, 15 without `ORDER BY`. All 15 are `pg_advisory_xact_lock` acquisitions, scalar
`count(*)` reads, or the lifecycle CTE inside `dailyBucketsForRange` already reviewed in V-1201.
**The gap was real and empty** — worth stating plainly, because "we found nothing" and "we did not
look" are indistinguishable from the outside, and that distinction is the whole point of this file.

Two arms added. One classifies every ORDER-BY-less raw SELECT as a lock, a scalar, or reviewed, so
a raw query returning a contested row set in arbitrary order fails. One is the second detector's
own self-check, because it has exactly the failure mode of the first: match nothing, report clean,
look identical to a healthy repo.

```
M1  a raw multi-row SELECT with no ORDER BY appears  -> named as an offender   1 failed | 5 passed
M2  the raw detector stops matching                  -> self-check red         1 failed | 5 passed
restored                                                                       6 passed
```

**A process note worth keeping.** M2 initially reported the suite still green, which would have
read as "the self-check is not load-bearing". The mutation had not applied — a `perl -pi -e`
substitution whose escaping silently matched nothing. The rerun asserts the occurrence count before
writing and prints `MUTATIONS APPLIED: 1`. A mutation that does not apply looks exactly like a
mutation the tests survived, and only the count tells them apart. Same lesson as the zsh
word-splitting sweep in V-1187, from a different tool.

---

## V-1204 — thirteen annotations that are true only because someone remembered to cast

Following the postgres-js numeric trap this session already hit from the other side (a raw bigint
read that needed `Number(size_bytes)`), I went looking for the version TypeScript cannot see.

`sql<number>` tells the compiler an expression yields a number. It does not make it one. Postgres
`count(*)` and `sum(...)` return bigint/numeric, and postgres-js hands those back as STRINGS rather
than silently truncate past 2^53:

```
const [row] = await db.select({ n: sql<number>`count(*)` }) …
row.n            // typed number, actually "7"
total + row.n    // "07"   — concatenation, not addition
row.n > limit    // coerces, so this one accidentally works
```

The comparison working is what makes it dangerous. The bug hides until something ADDS, and then it
yields a plausible wrong figure rather than an error — no throw, no log, and `tsc` structurally
cannot help, because the generic is an assertion by the author about what the database returns.

**Measured first.** Every `sql<...>` generic in the repo: 13 `sql<number>`, 6 `sql<string>`,
2 `sql<Date>`, 1 `sql<Date | null>`. All 13 numeric ones already carry a cast —
`count(*)::int` ten times, `coalesce(sum(…), 0)::int` twice, one more `count(*)::int`. The schema is
equally disciplined: all six `bigint` columns and the one `numeric` column declare `mode: 'number'`,
so the Drizzle path converts. Four raw aggregate queries, all cast.

So this axis is clean, and the finding is that its cleanliness rests on thirteen separate acts of
remembering.

**Why repo-wide rather than more per-file pins.** Several `*-content-parity` tests already pin an
individual `count(*)::int` inside the repo file they cover. That is real coverage for those lines
and none at all for the fourteenth occurrence, written next month, in a file that does not exist
yet — the same argument as V-1200's scope sweep. The guard has no allowlist and should never need
one: `::int` / `::float8` / `::numeric` is always available, and an uncast `sql<number>` is always a
defect waiting on its first addition.

```
M1  drop ::int from one real occurrence  -> sessions-repo named as offender  1 failed | 2 passed
M2  the cast pattern stops seeing ::int  -> self-check + offender arm red    2 failed | 1 passed
restored (source 0 dirty)                                                    3 passed
```

Both mutations printed their applied count before running, per the V-1203 correction — a mutation
that never landed looks exactly like one the tests survived.

---

## V-1205 — retracting a claim of my own that I had carried for three turns

While checking the retention scrubber for defects ahead of any decision on D-7, I verified the
premise I had been repeating rather than inheriting it. It is wrong.

I have been reporting D-7 as: the published "session metadata — 90 days operational" commitment has
no working enforcement, its only enforcer has never run, and turning it on would delete production
rows. Every part of that is stale.

What is actually there, from V-759:

```
bootstrap.ts:1711  new RetentionScrubSweeperService({ repo: new DrizzleRetentionScrubRepo(…) })
bootstrap.ts:1715  registerRetentionScrubJob({ scheduledJobs, sweeper, logger })
bootstrap.ts:1720  await enqueueNextRetentionScrub({ scheduledJobs })      // unconditional
retention-scrub-repo.ts:65   export const RETENTION_WINDOW_DAYS = 90;
```

Registered and enqueued on every boot with no flag gate, daily interval, re-arming itself, and
alarming on a failed step because a failure means data held past its disclosed window. The window
constant is 90, matching the published table rows for session metadata and for authentication data
after revocation.

It also does not delete, which was the specific risk I attached to enabling it. It ANONYMISES —
`sessions.label` / `sessions.metadata` nulled, `api_keys.name` replaced with a sentinel — because
`usage_records` cascades from `sessions` and §9 requires billing data be kept seven years, and
revoked `api_keys` are RESTRICT-referenced by `admin_audit_log` so the row cannot be removed at all.
§9's closing paragraph authorises anonymisation as the alternative. Only `session_operations` is
deleted, and the comment says why: nothing references it.

**And the guards I was about to write already exist.** `privacy-retention-window-matches-the-sweeper`
pins every published window against `RETENTION_WINDOW_DAYS` across both published copies, checks its
own extraction found the rows, and pins that §9 still authorises anonymisation.
`retention-sweeps-are-unconditional-invariant` pins that the retention job is not gated behind a
flag. Grepping prior art first is what stopped this becoming a duplicate of both.

**Scope of the retraction, stated precisely.** What I verified is that the three surfaces the
sweeper covers — session metadata, session operations, revoked api-key names — are enforced at 90
days, wired unconditionally, and guarded. I did NOT re-verify the separate half of D-7 about other
tables carrying no retention bound; that may still stand, and nothing here speaks to it.

The lesson is not new but it is mine this time: a claim repeated across turns stops being read as a
claim. This one survived three reports because each one inherited it from the last rather than from
the source. The instrument for that is the same as for everything else here — go look.

---

## V-1206 — the other half of D-7, verified rather than inherited

V-1205 corrected my claim that the 90-day session-metadata commitment had no enforcement, and
explicitly left the second half unverified: that other tables carry no retention bound. Having just
been wrong once by inheriting a claim, I went and checked it.

**It is also wrong as I was carrying it.** Every §9 category with an active deadline has a wired,
unconditional enforcer:

```
Session metadata            90d   RetentionScrubSweeperService        (V-759, bootstrap:1720)
Authentication data         90d   same sweep, api_keys.name sentinel
Customer-Provided Secrets   30d   AccountDeletionPurgeSweeper         ACCOUNT_DELETION_RETENTION_DAYS
Status-subscriber address   90d   wireDailyMaintenanceSweep -> processPurge(now)
```

and the tables I had assumed were unbounded are not: `admin_audit_log` and `webhook_deliveries` are
archived then deleted by `audit-archive` at a 90-day hot tier, `agent_turn_receipts` has its own
purge, and `auth_tokens` is swept by `auth-flows-sweeper` via `deleteStaleAuthTokens` (consumed
before / expired before). `account_audit_log` has no age-based delete, which is consistent with it
falling under "Account data — duration of Subscription + 7 years", a horizon nothing needs to
enforce yet.

**The real gap was narrower and different from what I had been reporting.** `RETENTION_WINDOW_DAYS`
is pinned against the published number by `privacy-retention-window-matches-the-sweeper`, which
reads the figure OUT of both published copies so the two cannot drift in either direction.
`ACCOUNT_DELETION_RETENTION_DAYS` had **no test reference anywhere**. The policy text was pinned on
its own side by the legal content-parity tests, and the code was pinned on its own side — which
catches an edit to either and cannot catch a drift BETWEEN them. That is the number a customer is
promised their credentials are gone by.

The constant is now exported and pinned into the existing cross-source guard, beside the window it
belongs with rather than in a new file. Proved in both directions, which is the whole point of a
cross-source pin:

```
M1  sweeper drifts 30 -> 90   policy says 30, sweeper uses 90   1 failed | 3 passed
M2  policy drifts 30 -> 60    policy says 60, sweeper uses 30   1 failed | 3 passed
restored (both published copies back at 30)                     4 passed
```

**What is left of D-7 is a decision, not a defect.** The enforcement exists, runs, and now has its
numbers pinned. What no test can settle is whether `account_audit_log` and the incident tables
should carry a bound shorter than the 7-year account-data horizon they currently inherit. That is a
policy judgement about disclosed processing, and it still needs a human.

Recording the shape rather than only the fix: I reported the first half of this for three turns and
the second half for four, and both were wrong. The failure was not the original analysis, which was
probably right when written. It was that each report inherited the previous report instead of the
source, and a claim restated often enough stops being read as a claim at all.

---

## V-1207 — the contract test caught a drift I had introduced myself, two commits earlier

The second of the twenty-nine V-1197 recorded as owed. I picked `OAuthLinksRepo` for its small
surface and because identity binding is security-relevant. It found something before I finished
writing it.

**V-1201 changed one implementation of a shared interface and left the other behind.** That commit
gave `DrizzleOAuthLinksRepo.listForAccount` an `ORDER BY linked_at, id` so the customer's "Connected
accounts" list stops reordering between page loads. `InMemoryOAuthLinksRepo.listForAccount` still
returned `rows.filter(...)` — insertion order. Two implementations of one interface, one of them
changed, and nothing in the suite could see it, because no test compared them.

This is exactly the failure V-1198's template was built for, and the demonstration is empirical
rather than argued: written first, run before any fix, and the ordering arm red on the in-memory
half while passing on Drizzle.

```
before fixing the double:   1 failed | 10 passed     (× in-memory: the list is in insertion order)
after fixing the double:    11 passed
```

**Why the ordering arm needs a backdate.** Both implementations stamp `linkedAt` at insert time, so
insertion order and `linkedAt` order agree in any fixture that merely inserts twice — the arm would
pass on both and prove nothing about either. `backdate` pushes the second link's `linkedAt` behind
the first so the two orders DISAGREE, which is the only way the assertion can tell "sorted by
linkedAt" apart from "whatever order it was written in". Fourth time this session a positive control
needed forcing to stop being vacuous.

**The security arm is `findByProviderSub`.** It is deliberately account-unscoped — it IS the login
lookup, mapping an IDP identity onto whichever account holds it — so the only thing separating one
customer from another is that it matches on BOTH provider and subject. A subject issued by one
provider resolving a link created for another is an account takeover with no credential involved.
The contract pins the unscoped-ness alongside it, the same asymmetry V-1198 pinned for
`findApiKeyUnscoped`, because pinning the escape hatch is what keeps the scoped claim honest.

Mutation-proved in three directions, each printing its applied count:

```
M1  the DRIZZLE side loses its ORDER BY          drizzle ordering arm red    1 failed | 10 passed
M2  the DOUBLE loses its sort                    in-memory ordering arm red  1 failed | 10 passed
M3  findByProviderSub matches on sub alone       provider-confusion arm red  1 failed | 10 passed
restored (source 0 dirty)                                                    11 passed
```

M1 and M2 are the pair that matters: the same arm fails on whichever side drifts, which is the
property a per-implementation test cannot have.

**A fixture bug of my own, caught by the first run.** `backdate` on the Drizzle side passed a bare
`Date` and a bare uuid string to postgres-js and threw a type error inside the driver rather than
failing an assertion. Fixed with the explicit `::timestamptz` / `::uuid` casts the repo layer
already uses for its own raw statements. Worth noting because the failure surfaced as a driver
stack trace under a test name that suggested an ordering defect — the arm was fine; the fixture
never ran.

**Owed remaining: 27.** The template now has a second instance and the shape is confirmed on a
repo whose contract was NOT already correct, which is the case that matters.

---

## V-1208 — the second half of the same drift, found only because I went back to look

V-1207 found that V-1201 had given `DrizzleOAuthLinksRepo.listForAccount` an `ORDER BY` and left
`InMemoryOAuthLinksRepo` behind. What I did not do at the time was ask what ELSE that commit
touched. It touched two repos:

```
DrizzleEmailPreferencesRepo.list   ->  .orderBy(asc(accountEmailPreferences.eventType))
InMemoryEmailPreferencesRepo.list  ->  for (const r of this.rows.values())     // Map write order
```

Same commit, same class, second file — and it had gone unexamined because finding one instance felt
like finding _the_ instance. That is the repo-wide-not-named-file rule, applied to my own change
rather than to a report's claim.

Demonstrated before fixing, the same way:

```
before fixing the double:  1 failed | 10 passed   (× in-memory: the list is in write order)
after fixing the double:   11 passed
```

**The fixture writes `tier-changed` before `billing-receipt`** so write order and alphabetical order
disagree. Any pair chosen in alphabetical order would pass against a double that never sorts —
the same vacuity trap as V-1207's backdate, and the fifth positive control this session that had to
be forced before it could fail.

**The semantic arm is the one worth keeping.** The interface documents a default-opted-in
convention: opting back IN deletes the row rather than storing `true`, so absence and consent are
the same state. That is easy to reimplement as "store true" — which still answers `isOptedOut`
correctly while leaving a row behind in `list`. The two implementations would agree on the question
customers ask and disagree on the one the preferences UI renders. M3 confirms the arm catches it.

```
M1  the DRIZZLE side loses its ORDER BY      drizzle ordering arm red     1 failed | 10 passed
M2  the DOUBLE loses its sort                in-memory ordering arm red   1 failed | 10 passed
M3  opting back in STORES true               "a row survived opting back in"  1 failed | 10 passed
restored (source 0 dirty)                                                 11 passed
```

**Owed remaining: 26.** Both halves of the V-1201 drift are now closed, and the pattern that found
them is worth stating plainly: after a contract test catches a drift, the next question is not
"what else is owed" but "what else did that same commit touch".

---

## V-1209 — sweeping for the class instead of waiting to trip over it, and a control that could not fail

V-1207 and V-1208 each found one instance of a double drifting from its Drizzle sibling's ordering.
Rather than wait for a third, I swept every pair: for each Drizzle method carrying an `ORDER BY`,
does its double impose the same order?

**Eight candidates, three of them my own false positives.** `in-memory-billing.ts` implements
max-`createdAt` selection with a loop rather than `.sort(`, and documents that it mirrors the SQL
(V-741, V-767) — my detector keyed on `.sort(` and could not see it. Checking each candidate against
its source instead of trusting the count is the same discipline the batch rules impose on the sweep
report, applied to a sweep I wrote myself.

Four are real:

```
platform-secrets-repo::listMeta                    double returns Map values unordered
team-members-repo::listMembers                     double returns write order
team-members-repo::listPendingInvites              double returns write order
webhooks-repo::findEndpointsNeedingForceRotation   double breaks at `limit` in Map order
```

The webhooks one is worth naming separately: its double filters and applies `limit` correctly, so
the divergence is not presentation. Order plus a limit is SELECTION — the real repo rotates the
oldest secrets first, the double rotates arbitrary ones.

**This entry closes the team-members pair**, the customer-visible one. The divergence there is not
merely a different order but the REVERSE one: `ORDER BY created_at DESC` against write order, so a
unit test asserting the team list was asserting it upside down relative to what the customer sees.

**The control could not fail, and the run said so.** My first draft backdated the SECOND-written row,
which makes write order `[first, second]` and newest-first `[first, second]` coincide. All nine arms
passed — against a double that does not order at all. Only the sweep that found the pair contradicted
it. Backdating the FIRST row makes the two orders disagree in both positions:

```
draft (backdate second):  9 passed          <- vacuous, and it looked like a clean result
fixed (backdate first):   2 failed | 7 passed   (× in-memory member + invite lists)
after fixing the double:  9 passed
```

That is the sixth vacuous positive control this session. The pattern is now specific enough to state
as a rule: when an arm asserts an ORDER, the fixture must make the two candidate orders disagree in
EVERY position, and the way to check is to run it against the unfixed implementation first. An arm
written after the fix cannot tell you this.

Mutation-proved, each printing its applied count:

```
M1  DRIZZLE listMembers loses its ORDER BY       1 failed | 8 passed
M2  the DOUBLE loses its member sort             1 failed | 8 passed
M3  listPendingInvites stops excluding accepted  1 failed | 8 passed
restored (source 0 dirty)                        9 passed
```

**Owed remaining: 25**, and two of the four measured divergences are still open —
`platform-secrets::listMeta` and `webhooks::findEndpointsNeedingForceRotation`. They are named here
rather than left implicit, because a measurement reported without its residue reads as completion.

---

## V-1210 — order plus a limit is selection, and a second divergence measured but not half-fixed

The fifth of the twenty-nine, closing the first of the two divergences V-1209 measured and left
open. This is the consequential one:

```
DrizzleWebhooksRepo   .orderBy(webhookEndpoints.secretCreatedAt).limit(args.limit)
InMemoryWebhooksRepo  for (const r of this.endpoints.values()) … if (out.length >= limit) break;
```

The double filtered correctly and honoured the limit — that part was faithful. What differed is
WHICH endpoints came back when more were eligible than the limit allowed. Ordering plus a limit is
SELECTION, and the endpoints most overdue for rotation are exactly the ones arbitrary iteration can
keep skipping, tick after tick. The double now sorts by `secretCreatedAt` before slicing.

**What was already guarded, stated plainly.** `db-webhooks-force-rotation-selection-drizzle.test.ts`
pins the Drizzle side thoroughly, including that the due set is oldest-first and the limit is
honoured. The Drizzle half was never the gap. Nothing guarded the double, and nothing compared the
two — that comparison is the entire value here, and presenting the Drizzle arms as new coverage
would be dishonest.

**A second divergence, found by my own broken fixture, measured and left open.** The first run
failed with `Webhook signing secret must match whsec_<32 lowercase base32 characters>` — from the
Drizzle half only. The real repo validates the secret before storing; the double accepts any string,
so unit tests build endpoints production would refuse.

I enforced it in the double, ran the full suite, and it red **43 tests across six files**. The suite
carries 72 `secret: '…'` literals — `'whsec_test'`, `'secrettest456'`, `'s'`, `''` — and several are
invalid ON PURPOSE because they test rejection. So tightening the double is right, and it is its own
piece of work with its own fixture sweep and its own judgement about which literals are deliberate.
Doing it as a side effect of an ordering fix would have meant rewriting six files of unrelated tests
late in a long session.

Reverted: the double's validation, the `validatePlaintext` → `assertValidWebhookSecret` export it
required, and the contract arm that asserted it. What shipped is the ordering fix, fully proved. The
divergence is recorded here with its blast radius so the decision to tighten is explicit rather than
implied — a finding named with its cost is actionable; a finding half-applied is a broken suite.

**Two vacuity traps in one file, both caught by running before fixing.** First: creating the three
endpoints in age order makes Map iteration coincide with secret age, and every arm passed against a
double that never sorts. Creating them middle, newest, oldest breaks the coincidence. Second: the
sweep is PLATFORM-WIDE — it takes no account id, because force-rotation is an operator action across
every customer — so rows seeded by other arms on the shared database landed in each result. Every
assertion now scopes to its own account; without that the arms pass or fail on whatever else is in
the table, which is a flake dressed as a contract.

```
M1  DRIZZLE loses its ORDER BY           1 failed | 8 passed
M2  the DOUBLE reverts to break-at-limit 1 failed | 8 passed
restored (source 0 dirty)                9 passed
```

**Owed remaining: 24**, plus two named items: `platform-secrets::listMeta` from the V-1209
measurement, and the webhook-secret validation divergence above.

---

## V-1211 — the last of the four, and a shape claim the type system does not enforce

The sixth of the twenty-nine, closing the final ordering divergence the V-1209 sweep measured:

```
DrizzlePlatformSecretsRepo.listMeta   .orderBy(platformSecrets.name)
InMemoryPlatformSecretsRepo.listMeta  [...this.meta.values()]        // Map insertion order
```

Demonstrated before fixing: the ordering arm red on the in-memory half, passed on Drizzle, then
9 passed once the double sorted by name.

**The fixture writes the z-name first**, because writing them alphabetically makes Map insertion
order coincide with name order and the arm would pass against an implementation that never sorts.
Third time this session the DIRECTION of a fixture decided whether an ordering arm could fail at
all, after V-1209's backdate and V-1210's creation order. It is now a standing check rather than a
lesson: write the fixture so the two candidate orders disagree, then run it against the unfixed
implementation before fixing anything.

**The second arm is the one worth more than the ordering.** This double's own header claims
`listMeta` never exposes ciphertext, "same contract as the drizzle repo's metadata-only select".
That is a claim about RUNTIME SHAPE, and `PlatformSecretMeta` not declaring the field does not
enforce it: a `.select()` with no projection returns every column, and the extra key rides along
behind a type asserting it cannot be there. `platform_secrets.ciphertext` holds the decryptable
platform credentials. So the arm reads the actual keys of the returned objects and rejects anything
matching `/cipher|secret|blob|payload|plaintext/i` — the same reason V-1204 refuses to trust
`sql<number>`.

Both implementations pass it today; there is no leak. The arm exists because the projection is the
only thing preventing one, and nothing else in the suite was watching it.

```
M1  DRIZZLE loses its ORDER BY              1 failed | 8 passed
M2  the DOUBLE loses its sort               1 failed | 8 passed
M3  DRIZZLE selects every column            2 failed | 7 passed   (the shape arm among them)
restored (source 0 dirty)                   9 passed
```

M3 is a crude mutation — injecting a bare `.select()` disturbs more than the projection, so it reds
two arms rather than one. It is reported that way rather than as a clean single-arm kill.

**Also pinned here**, because a contract is cheaper to write once than to revisit: `upsert` reports
`created` then `updated` for the same name and actually replaces the stored ciphertext, and `remove`
distinguishes removing something from removing nothing. Both are outcomes an operator reads as
confirmation, and neither had a cross-implementation pin.

**Owed remaining: 23.** All four divergences from the V-1209 sweep are now closed. The webhook-secret
validation divergence from V-1210 stays open with its measured cost: 43 tests across six files,
72 secret literals, several invalid on purpose.

---

## V-1212 — doing the deferred work, and the measurement that was five times too large

V-1210 found that the in-memory `WebhooksRepo` double accepts any string as a signing secret while
the real repo refuses anything that is not `whsec_` + 32 lowercase base32. I enforced it, saw
**43 tests across seven files** go red, reverted, and recorded it as its own piece of work.

Deferring with a measurement means doing it next, not never. This is that.

**The measurement was right about the failures and wrong about the scope.** I reported "72 secret
literals" as the blast radius. The actual work was **13 literals across seven files** — the other 59
belong to `webhook-secret-encryption.test.ts` and its siblings, which exercise the encryption module
directly and never touch the double. Several of those 59 are invalid ON PURPOSE because they test
rejection, and none of them needed to change. Counting the population instead of the affected subset
made the job look five times larger than it was, which is exactly the kind of number that turns a
deferral into a permanent one.

Every one of the 13 was incidental — a fixture that needed _a_ secret, not one testing format. They
now carry `whsec_` + 32 base32 characters with their readable stems kept (`whsec_agedaaa…`), so the
tests still say what they are about.

**Three follow-on failures the first pass did not predict**, each worth naming:

- Two assertions still compared against the OLD literal. Changing an input without changing what the
  test claims about it produces a test that passes for a reason nobody chose.
- One fixture built its secret from a template literal, `whsec_old_${i}_…`. The loop index is a
  DIGIT, and the base32 alphabet is `a-z2-7` — `0` and `1` are not in it. The index is now encoded
  as a letter. A generated fixture has to satisfy the same rule as a literal one, and generation is
  where that is easiest to forget.

**The double rejects the same WAY, not just the same cases.** The Drizzle method is `async`, so its
validation failure arrives as a rejected promise; the double's `insertEndpoint` is synchronous, and
a synchronous throw would need different handling at every call site. That is its own divergence, so
it is pinned separately:

```
M1  the double stops validating                     1 failed | 10 passed
M2  the double throws SYNCHRONOUSLY instead         1 failed | 10 passed
restored                                            11 passed
full suite                                          3136 files, 30880 passed, 0 failed
```

The double now calls the exported `assertValidWebhookSecret` rather than carrying its own copy of
the regex — a duplicated rule is how these two drifted in the first place, and a second copy would
only reset the clock on the same failure.

**Owed remaining: 23**, with no named side items outstanding. All four V-1209 divergences and both
V-1210 findings are closed.

---

## V-1213 — the truncate-before-ordering class, third instance, on a work queue

Two findings this batch: one sweep that came back empty, and one contract that did not.

**The empty sweep, recorded so nobody re-derives it.** V-1212 closed a divergence where the double
skipped validation the real repo enforces. I swept every pair for more of that class: Drizzle methods
that raise where the double never does. The naive query returned 27 hits, and **26 of them are not
the class** — they are internal invariant guards ("insert returned no row") for states a double
cannot reproduce, and a double correctly has no equivalent. Filtering to caller-triggerable input
validation left `recipes-repo` and `account-proxies-repo` (neither has a double at all) and
`profiles-repo`'s wrapped-DEK precondition — which the double already enforces, with the identical
message. So the webhook secret was the only instance of that class, and it is closed. Reporting the
27 would have been reporting my heuristic, not the repo.

**The contract that did find something.** `ScheduledJobsRepo`, seventh of the twenty-nine, and the
third instance of the truncate-before-ordering class V-1210 named — the worst of the three, because
the list being truncated is a work queue:

```
Drizzle   SELECT id … WHERE run_at <= $now ORDER BY run_at ASC LIMIT $batchSize FOR UPDATE SKIP LOCKED
double    for (const r of this.rows.values()) { if (due.length >= batchSize) break; … }
          due.sort((a, b) => a.runAt - b.runAt)      // AFTER truncating
```

The double sorted — its comment says "for deterministic order" — but it sorted the batch it had
already chosen. Under a backlog the real repo takes the oldest due jobs and the double took an
arbitrary subset. A job the Map iteration keeps passing over is not served late; nothing else
advances it, so it can starve while the queue drains around it.

**The arm asserts the SET, not the returned order — and that correction came from the run.** My
first version asserted the array order and failed on BOTH halves. The Drizzle repo returned the
right rows newest-first: `ORDER BY … LIMIT` governs which rows get locked, and the outer
`UPDATE … RETURNING` promises nothing about the order it hands them back. Pinning that order would
have frozen an accident of the statement rather than the property that decides which work gets done.

```
M1  DRIZZLE loses ORDER BY run_at             1 failed | 10 passed
M2  the DOUBLE truncates without sorting      1 failed | 10 passed   (the original defect)
M3  the DOUBLE stops deduping null accounts   1 failed | 10 passed
restored (source 0 dirty)                     11 passed
```

M2 took two attempts, and the first attempt is the more useful record: reversing the batch changed
the ORDER and the arm stayed green, exactly as designed, because the arm asserts the set. The
mutation was wrong, not the arm. A mutation that fails to red is a claim about the test that has to
be checked before it is believed.

M3 covers the NULL-account dedup branch specifically. Every platform-wide recurring sweep enqueues
with `accountId: null`, so the real repo takes an `isNull()` branch there rather than `eq()`; a
double deduping only non-null accounts would let a self-rearming job pile up a queue of itself.

**Owed remaining: 22.**

---

## V-1214 — two more classes swept clean, and a contract that pins rather than finds

**Three sweeps, all empty, recorded so the next reader does not re-derive them.**

The truncate-before-ordering class had surfaced three times (V-1210, V-1213, and the ordering pair in
V-1207/1208), each found by tripping over it. Rather than wait for a fourth I measured it in both
directions:

```
doubles applying a cap with no sort, or before sorting          0
Drizzle methods with a LIMIT whose double never bounds its result   0
```

Both clean after the fixes already landed. The second direction is the one I would not have thought
to check from the failures alone — a double that ignores a limit entirely never exercises the
boundary, and no test would notice.

The normalisation class — real repo trims or lowercases where the double does not — returned exactly
one hit, `scheduled-jobs-repo::claimDue`, and it is a comment about normalising a timestamp at the
repository boundary. A false positive from my own regex, verified rather than reported.

Together with V-1213's validation sweep, that is four mechanical parity classes measured and closed.
What remains between doubles and repos is semantic, not mechanical, which is a useful thing to know
before writing twenty-two more contracts.

**The contract, and what it is honestly for.** `StripeWebhooksRepo`, eighth of the twenty-nine,
chosen for consequence rather than suspicion — this is the money path. `recordEvent` is the replay
guard for every Stripe webhook, and Stripe retries aggressively.

Both implementations already agree, and the upgrade rule is SHARED rather than reimplemented: each
calls `isCryptoTierUpgrade`. That structure is exactly what prevents the V-1197 divergence, and it is
why there was nothing here to find. **13 passed on the first run.** This file pins the agreement so a
later edit has to break an assertion to land. It is owed work, not a finding, and the header says so.

`inserted` is not a convenience flag — it is the caller's only signal that this delivery is the first
one, so both directions are asserted: a first delivery reporting false drops a real event, and a
replay reporting true re-runs the side effects the ledger exists to suppress. A third arm covers a
retry whose PAYLOAD differs, because the conflict target is the event id alone and a differing body
must not slip past as new.

```
M1  DRIZZLE reports every delivery inserted        2 failed | 11 passed
M2  the DOUBLE stops suppressing replays           2 failed | 11 passed
M3  the DOUBLE drops the upgrade-only guard        1 failed | 12 passed
M4  DRIZZLE drops the upgrade-only guard           1 failed | 12 passed
restored (source 0 dirty)                          13 passed
```

M3 and M4 are the pair worth having: the same downgrade arm fails on whichever side loses the guard,
which is the property no per-implementation test can give. A late or out-of-order Stripe delivery for
a cheaper plan must not strip entitlements a customer is still paying for.

**A type error vitest could not see.** The first full run failed
`the-server-source-type-checks`: the double's `registerAccount` seam requires `stripeCustomerId`,
and this contract omitted it. Every arm passed under vitest because esbuild strips types without
checking them, so the file was green and wrong at the same time. It is the reason that gate exists,
and worth recording each time it catches something rather than treating a green vitest run as proof.

**Owed remaining: 21.**

---

## V-1215 — splitting a file is an interface change, and three readers depended on it

V-1214 split this log because Prettier could no longer parse it under the pre-commit hook's 8 GB
heap. That commit landed green on the hook and red on the suite, because I checked for readers AFTER
splitting rather than before. There were three.

```
a-verification-log-number-resolves-to-one-finding.test.ts   uniqueness across every V-number
docs-verification-log-content-parity.test.ts                the charter + historical V-anchors
every-command-the-docs-tell-you-to-run-exists.test.ts       excludes history by filename pattern
```

That is rule 2 of this sweep — enumerate every occurrence with BOTH patterns before touching the
thing — applied to a file rather than a symbol, and I did not apply it. Moving 1081 entries out of a
file is an interface change to everything that reads it.

**The worst of the three was self-inflicted.** I replaced the log's header with wording of my own.
That header is a pinned charter — "reality wins, code reflects reality, planning is updated" — and
rewriting it is not a formatting choice, it is editing the document's constitution while claiming to
reorganise it. The original is restored verbatim and the split note now sits BELOW it, where a note
belongs.

**The two guards that read the log now read both halves.** This matters more than it looks: the
uniqueness invariant spans the whole history, so a guard reading only the live tail would let a
V-number be reused the moment its first use aged into the archive — the exact point at which a human
reader is least able to notice the collision. Proved by appending a `## V-900` heading to the live
file, a number that exists only in the archive: the guard reds. Restored, green.

The third needed no logic change, only its `HISTORY` filename pattern extended to cover
`verification-log-archive-*.md`. It already excluded the log for the right reason — a command that
was correct when written is not a defect now — and the archive is the same record under a new name.

**Suite: 3138 files, 30904 passed, 0 failed.** The split stands: entries through V-1200 archived and
frozen, the live file formats in 58ms under the hook's heap, and nothing was dropped — 1081 entries
in the archive, 15 live, charter intact.

---

## V-1216 — the warning that did not exist when the log outgrew the hook

V-1214 and V-1215 dealt with a file that grew until Prettier could not parse it under the
pre-commit hook's 8 GB heap. Nothing warned first. The file crossed a line and the next commit that
touched it — which, during this sweep, is every commit — failed inside a V8 out-of-memory stack
trace rather than at anything resembling a rule.

**First, whether anything else is close. Measured at the hook's own heap, not guessed:**

```
packages/sdk-python/openapi.json                    1.95 MB   OK  0.38s
docs/internal/A2-PRODUCTION-READINESS-ASSESSMENT.md  440 KB   OK  0.47s
apps/gui-client/src/views/SimulatorWindow.tsx        467 KB   OK  0.32s
apps/server/src/lib/openapi.ts                       270 KB   OK  0.26s
```

Nothing else is near it. JSON and TypeScript are cheap — a 1.95 MB JSON checks in under half a
second — and it is markdown's parser that blows up, somewhere between 440 KB and the 3.4 MB that
killed the hook. So the answer to "is this about to happen again" is no, and that is worth stating
rather than leaving as an assumption.

**The guard is the signal that was missing.** A budget of 1.5 MB on markdown that the hook actually
formats: well above every real file, far below the size that broke it, so it fires as a nudge to
split rather than as an emergency. It reads `.prettierignore` instead of restating it, because a
private copy would keep passing after the real list changed and this guard would then be enforcing a
rule the hook no longer follows.

The second arm is deliberately two-sided: the frozen archive MUST be ignored, and the live log must
NOT be. An ignore pattern that widened to catch the live file would silently drop it from formatting
altogether — the opposite failure, and a quieter one.

```
M1  a formatted markdown file crosses the budget   named as oversized      1 failed | 2 passed
M2  the frozen archive is un-ignored               ignore arm + budget arm 2 failed | 1 passed
restored                                           3 passed
```

M2 reds two arms rather than one, and correctly: an un-ignored 3.4 MB archive is both un-ignored and
over budget. Reported as it behaved rather than as a clean single-arm kill.

**What this does not do**, stated so nobody reads more into it: it does not measure Prettier's
memory, and the budget is a proxy chosen from two data points — one file that works at 440 KB and one
that died at 3.4 MB. If the parser gets cheaper or a pathological 900 KB file appears, the number is
wrong in one direction or the other. It is a tripwire with room, not a model.

---

## V-1217 — the double was counting usage production never counts

Ninth of the twenty-nine, and a real divergence on a metered path:

```
DrizzleUsageRepo   ne(recordType, 'session_minute'), ne(…, 'agent_decomposer'),
                   ne(…, 'agent_decomposer_bundled')      -- excluded from the SUM
InMemoryUsageRepo  totals[e.recordType] += e.quantity     -- every stored row, no exclusions
```

Two exclusions, two different reasons:

- `session_minute` is LIFECYCLE-DERIVED. Production computes it from real session lifetimes in the
  `sessions` table and never sums stored `session_minute` rows. A double that sums them reports
  metered minutes a customer was never charged for.
- `agent_decomposer` and `agent_decomposer_bundled` are internal accounting, excluded outright with
  nothing added back, so counting them inflates a customer-visible total with rows they should never
  see.

**The limitation is stated in the double rather than papered over.** It has no sessions to derive
minutes FROM, so it omits `session_minute` where production reports a derived figure. Excluding the
stored rows makes the two agree about what must NOT be summed; it does not make the double a source
of lifecycle minutes. The arm asserts the stored quantity is not counted — which both can satisfy
honestly — rather than a derived value the double cannot produce.

Applying the exclusions broke nothing: the full server suite stayed green, so no test depended on
the double counting rows production drops.

```
M1  the DOUBLE reverts to counting everything   2 failed | 9 passed   (the original defect)
M2  DRIZZLE stops excluding session_minute      11 passed             -- see below
M3  the DOUBLE stops counting real usage        2 failed | 9 passed   (positive control)
restored                                        11 passed
```

**M2 stayed green, and the reason is in the source rather than in the test.** `totalsForPeriod` ends
with `totals.session_minute = lifecycleRows[0]?.total_minutes ?? 0`, an unconditional assignment
after the loop, carrying the comment "legacy session_minute ledger row must never replace lifecycle
truth". So the Drizzle side has the SQL exclusion AND an overwrite that absorbs it; removing either
alone changes no behaviour, and no test can separate them.

That is the V-1202 shape again — a redundant safeguard makes the real rule untestable — but the
verdict is different. There the redundancy was mine and I removed it. Here both layers are
deliberate and documented, and defence in depth on the figure a customer is billed against is worth
more than a mutation score. Recorded as a limit on what M2 proves, not filed as a defect.

M3 matters as much as M1: without a positive control, "excludes the internal types" is satisfied by
an implementation that counts nothing at all.

**A cumulative drift the last nine contracts caused, caught on this one.** The full run failed
`no-permanently-skipped-tests`: its header states how many conditional skips the repo has, and the
guard tolerates a drift of 10 before failing. Every DB-gated contract in this sweep adds skips, so
the stated 144 had quietly become a real 155 — no single commit moved it far enough to trip, and the
tenth did. Updated to 155. Worth noting because a tolerance band means the commit that finally reds
is not the one that caused the drift, and attributing it to this contract alone would have been
wrong.

**Owed remaining: 20.**

---

## V-1218 — a sweep and three spot-checks that found nothing, written down so they are not redone

V-1217 found the usage double summing rows the real repo excludes with `ne()` predicates. That is a
class, so I swept it: Drizzle methods carrying an exclusion predicate (`ne`, `not`, `notInArray`,
`NOT IN`, `<>`) whose double filters nothing.

**One hit, and it is my own detector's fault.** `webhooks-repo::resetDeliveryToPending` excludes
`ne(status, 'in_flight')`, and the double does too — as an early return:

```
if (!row || row.status === 'in_flight') return Promise.resolve(null);
```

My regex looked for `!==`, `!=`, `continue;` or `.filter(`, and a guard written with `===` and an
early return matched none of them. Verified rather than reported, which is the fifth time this
session a detector of mine has over-reported and the check has been to read the source.

**Three pairs spot-checked while choosing the next contract, all faithful:**

- `sessions-repo::countActiveSessions` — the cap that enforces concurrent-session limits keys on
  `destroyedAt IS NULL`, NOT on status, so a session in a terminal status that was never destroyed
  still holds a slot. The double keys on exactly that. This one is worth naming because "active"
  meaning two different things in two places is precisely how a cap leaks.
- `rate-limit-overrides-repo::listAll` — keyset pagination on `(createdAt desc, id desc)`. Both
  agree, INCLUDING the edge case where the cursor row has since been deleted: Drizzle looks the
  cursor row up and only adds the keyset filter `if (c)`, the double uses `findIndex` and only
  slices `if (idx >= 0)`, so both fall back to page one rather than returning nothing. Different
  mechanisms, same behaviour.
- `legal-repo::latestAcceptancesForAccount` — the `accepted_at DESC, id DESC` tiebreak that decides
  which terms version a customer is recorded as accepting. The double sorts identically and
  documents that it mirrors the production query.

**Nothing to fix, so nothing was changed.** Recording it because the alternative is that the next
person to notice the usage divergence sweeps the same class again, and because "we found nothing"
and "we did not look" are indistinguishable from the outside — the same reason V-1203 recorded an
empty raw-SQL gap rather than staying quiet about it.

**Owed remaining: 20**, unchanged — this batch closed a class rather than a contract.

---

## V-1219 — "active" means two different things, and only one of them is the cap

Tenth of the twenty-nine. `countActiveSessions` enforces a tier's concurrent-session limit, so its
answer is the difference between a customer starting another session and being told they are at
their cap.

**The property is what "active" means, because it is not what it sounds like:**

```
.where(and(eq(sessions.accountId, accountId), isNull(sessions.destroyedAt)))
```

It keys on `destroyed_at IS NULL` and NOT on status. A session that has ERRORED but was never
destroyed still holds a slot, deliberately — the driver session may still exist and this row is the
only record that it might. An implementation that tidied this up to count only live-looking statuses
would free slots the platform has not reclaimed and let the customer past their limit.

Both sides key on the same thing today. Nothing asserted it, and the two things that would drift
apart — "active" the status and "active" the cap — are the same word.

**This is the contract V-1218 declined to write.** I checked the pair, found it faithful, and skipped
it because the Drizzle fixture needs an account and an api key. That is deferral-on-cost, the exact
pattern this log criticised in V-1212 and then had to correct. The fixture is eleven lines.

**A fixture bug that is the same shape as the subject.** My first run passed `purpose: 'automation'`
— the in-memory double accepted it and Postgres rejected it as an invalid `session_purpose` enum
value. Four Drizzle arms failed and four in-memory arms passed on a value that cannot exist in
production. That is the V-1197 shape reproduced accidentally in my own test data, and it is worth
naming: the double does not validate enums, so a fixture is free to build a session the database
would refuse. Not filed as a defect — `purpose` is validated by Zod at the API edge, so nothing
reaches the repo unchecked — but it is exactly how a green unit test can describe an impossible row.

```
M1  DRIZZLE counts by status instead of destroyedAt   4 failed | 5 passed
M2  the DOUBLE counts by status instead               1 failed | 8 passed
M3  the DOUBLE drops account scoping                  1 failed | 8 passed
restored (source 0 dirty)                             9 passed
```

M1 reds four arms rather than one, and that is reported as it behaved: swapping the predicate for a
status test also makes destroyed sessions count, so the entire Drizzle half moves rather than the
cap arm alone.

The fourth arm pins that `listActiveByAccount` and `countActiveSessions` describe the SAME set.
Different callers read them — the dashboard lists, the cap counts — and a customer shown two
sessions while being refused a third at a limit of five is looking at two answers to one question.

**Owed remaining: 19.**

---

## V-1220 — a replay guard written two ways, and the boundary that would open it

Eleventh of the twenty-nine. `consumeTotpCounter` is what stops a TOTP code being used twice inside
its own validity window. A code is valid for a 30-second step, so without a monotonic counter claim
an attacker who observes one — over a shoulder, in a screenshot, in a log — has the rest of that
window to replay it. The claim is the whole defence.

The two implementations express the same rule in different shapes, which is precisely the pair worth
pinning:

```
Drizzle  UPDATE … WHERE account_id = $1
           AND (last_used_totp_counter IS NULL OR last_used_totp_counter < $counter)
         RETURNING account_id          -> result.length > 0

double   if (r.lastUsedTotpCounter !== null && r.lastUsedTotpCounter >= args.counter) return false
```

A conditional UPDATE whose row count is the answer, against a guard clause. `NULL or strictly less`
and `not (non-null and >=)` are the same rule, and nothing asserted that they were.

**The failure that matters is the boundary, and it is invisible from a happy path.** Written `<=` in
the SQL or `>` in the double, the SAME counter is admitted a second time and the replay window
reopens — while first use, rewind and advance all still behave. So the arms are the four cases the
predicate can face rather than one success path:

```
M1  DRIZZLE  <  becomes <=     the replay arm reds        1 failed | 10 passed
M2  double   >= becomes >      the replay arm reds        1 failed | 10 passed
M3  double refuses everything after the first             advance arm reds, 1 failed | 10 passed
restored (source 0 dirty)                                 11 passed
```

M1 and M2 are the matched pair this whole exercise is for: the same off-by-one on either side fails
the same arm. M3 is the control that stops the other three being satisfied by an implementation that
refuses every code after the first — which is not a security hole but locks the customer out on
their next login, and would otherwise look like three passing security arms.

The fifth arm pins that the claim is per-enrolment. A counter shared across accounts would let one
customer's successful login refuse another customer's identical step, on the same 30-second boundary
every authenticator in the world lands on.

**Owed remaining: 18.**

---

## V-1221 — same destination, opposite order of operations

Twelfth of the twenty-nine. `consumeAuthTokenFamily` makes a password-reset link single-use AND
retires every other outstanding link for that account in the same act. Both halves matter: without
the first a captured link stays live, and without the second a customer who clicked "forgot
password" three times leaves two working links behind after using the third.

The two implementations reach the same place by opposite routes:

```
Drizzle  UPDATE t SET consumed_at = $at WHERE account_id = $acct AND consumed_at IS NULL
         RETURNING id   ->   rows.some(r => r.id === args.id)

double   if (target missing || wrong account || already consumed) return false
         …then consume every unconsumed row for that account, return true
```

The SQL **consumes first and asks afterwards** whether the target was among the rows it burned. The
double **asks first and consumes only if the answer is yes**. On every path a caller can reach they
agree, because all three call sites pass an `id` and `accountId` taken from a row
`findActiveAuthToken` has just returned — unconsumed, unexpired, account-matched.

**Where they diverge, and why it is recorded rather than pinned.** If the target is already consumed
while other tokens for that account are not, Drizzle still burns the others and returns false; the
double returns false and burns nothing. Reaching that needs a family call whose target was consumed
by the single-token path, and nothing in the service produces it. The concurrent-double-click race
does not either — the first call consumes the whole family, so the second finds nothing left to
differ about.

So the arms pin the reachable contract, and the divergent path is asserted only as the thing both
agree on: a stale target reports false. Pinning either side's choice about what to burn on the way
there would freeze an unreachable behaviour into a test and make whichever implementation changes
first look broken. That is the opposite mistake to the one V-1201 fixed, where an unasserted
difference was real and customer-visible; the discipline is the same either way — establish
reachability before deciding whether a difference is a defect.

```
M1  DRIZZLE scopes the family to the token id, not the account   2 failed | 7 passed
M2  the DOUBLE stops retiring the rest of the family             1 failed | 8 passed
M3  the DOUBLE drops the account check on the target             1 failed | 8 passed
restored (source 0 dirty)                                        9 passed
```

M1 and M2 are the matched pair: whichever side stops retiring the family, the same arm reports that
an earlier reset link survived. M3 covers the `(id, accountId)` pairing, so an id harvested
elsewhere cannot be redeemed against an account that does not own it.

**Owed remaining: 17.**

---

## V-1222 — two caps, two meanings of "still counts", and that is correct

Thirteenth of the twenty-nine. What makes it worth writing is that it states the OPPOSITE rule to
V-1219, three days of log entries apart:

```
session cap   counts a session whose STATUS is terminal but which was never destroyed
              -> an errored session STILL HOLDS a slot
profile cap   excludes a profile that has been trashed
              -> a trashed profile FREES a slot
```

Both are right, and the difference is not sloppiness. A session row may correspond to a driver
session that still exists somewhere, so the platform cannot reclaim the slot on status alone. A
trashed profile is inert: its row, DEK and sealed blob survive only for restore and purge. But two
caps with two meanings of "still counts", a few files apart, is exactly the pair someone harmonises
in the wrong direction while tidying. Pinning both is what makes the asymmetry deliberate rather
than accidental — and neither pin says so on its own, which is why both entries name the other.

**V-1194 got this boundary wrong once already** — trashing freed no cap slot, and the bin leaked
into the live grid — and fixed the Drizzle side. Whether the double reflected those fixes was never
asserted. It does. This is what keeps that true.

**The bin arm is the load-bearing one.** "Trashed profiles are hidden from findById and list" is
satisfied by an implementation that hard-deletes the row — same observable surface, and a
recoverable trash silently becomes a destructive delete. Asserting the profile is still in
`listTrashed`, and that `restore` returns it to both the count and the live list, is what separates
hidden from gone. M3 confirms it: making the double `rows.delete(id)` instead of stamping
`deletedAt` reds the bin arm and the restore arm while the two hiding arms stay green.

```
M1  DRIZZLE cap counts trashed again (the V-1194 defect)   cap arm reds, 1 failed | 10 passed
M2  the DOUBLE cap counts trashed                          cap arm reds, 1 failed | 10 passed
M3  the DOUBLE hard-deletes instead of trashing            bin + restore red, 2 failed | 9 passed
restored (source 0 dirty)                                  11 passed
```

M1 and M2 are the matched pair — whichever side stops excluding trashed rows, the same arm reports
the slot was not released.

**Owed remaining: 16.**

---

## V-1223/V-1224 — making a claim true, and the third shape of single-use

**V-1223 first, because it is a correction.** V-1222's commit message said the two cap contracts
"each name the other". They did not. V-1222 pointed at V-1219 from the start; V-1219, written three
entries earlier, said nothing back. The claim was true in one direction and I wrote it as though it
were true in both.

That matters more than a missing comment because the whole point of the pair is that neither file
makes the asymmetry visible alone — an errored session KEEPS its cap slot, a trashed profile FREES
its own — and a reader arriving at the session contract had no way to learn the other rule exists.
The back-reference is now in `session-cap-repo-contract.test.ts`, and it says when and why it was
added rather than pretending it was always there.

**V-1224 — the status-subscriber double opt-in.** Fourteenth of the twenty-nine. An address is only
mailed after it confirms and only until it unsubscribes, and both transitions are claimed by a token
hash under compare-and-swap.

Three properties pinned, none expressed by the types:

- **The confirmation link is single-use, and this is the THIRD distinct mechanism for that** in as
  many contracts. V-1220 compared a monotonic counter, V-1221 stamped `consumed_at`, and here the
  claim NULLS the token it matched on, so a replay finds no matching row. Same guarantee, three
  implementations, and each needed its own arm because none of them looks like the others.
- **Confirming RESURRECTS a previously unsubscribed address** — `unsubscribed_at` goes back to NULL.
  That is the entire re-subscribe path and it is easy to read the SET clause as merely establishing
  confirmation. Both sides do it; nothing asserted it. M2 proves the arm: dropping
  `unsubscribedAt: null` from the Drizzle SET leaves the row confirmed AND unsubscribed, and the
  address is never mailed again.
- **`expectedUnsubscribeTokenHash: null` is the deliberate admin branch** — the operator
  force-unsubscribe from V-1200, carrying admin authority instead of a token. Pinned beside the
  token-checked arm, because a null arriving from a customer-facing caller is an unauthenticated
  unsubscribe of anyone whose id is known, and it looks like a normal call while doing it.

```
M1  DRIZZLE confirm drops the token check      2 failed | 9 passed
M2  DRIZZLE confirm stops resurrecting         1 failed | 10 passed
M3  the DOUBLE unsubscribe ignores the token   1 failed | 10 passed
restored (source 0 dirty)                      11 passed
```

The resurrect arm also carries its own precondition check — it asserts the unsubscribe actually took
before re-confirming, because otherwise "the address is on the confirmed list at the end" is
satisfied by an unsubscribe that never happened.

**Owed remaining: 15.**

---

## V-1225 — a fourth way to say "only once", and a claim sweep that came back clean

**The sweep first.** V-1224 noticed that three contracts had pinned the same single-use guarantee
through three unrelated mechanisms. That raised the obvious question: is any claim in the db layer
implemented as read-then-write instead of an atomic conditional, which two concurrent requests would
both win?

My first detector said 14 of 32 claim-shaped writes were unguarded. **It was wrong about all of
them** — its "guarded" pattern looked for `isNull(` and missed both `notDeleted` (a named const) and
`eq(lockedBy, workerId)`. Re-run with a precise definition — a claim is unguarded when its `WHERE`
contains ONLY row identity — it found three:

```
byok-anthropic-repo::clear           Promise<void>
byok-anthropic-repo::touchLastUsed   Promise<void>
fleet-nodes-repo::revoke             Promise<void>
```

All three return `void`. No caller can branch on whether it won, so a concurrent double-write is
unobservable and the missing guard is correct rather than a defect. The class is clean. That is the
seventh detector of mine this session to over-report, and the seventh time the verdict came from
reading the source rather than the count.

**The contract.** `AccountLifecycleRepo`, fifteenth of the twenty-nine, where every method answers
"am I the caller that gets to send this email?" and the cost of a wrong answer is a customer mailed
twice or not at all. It adds a FOURTH shape of the same guarantee:

```
V-1220  compare a monotonic counter   last_used_totp_counter < $n
V-1221  stamp a consumed_at           SET consumed_at WHERE consumed_at IS NULL
V-1224  null the token matched on     SET confirm_token_hash = NULL WHERE hash = $x
V-1225  win an INSERT                 ON CONFLICT (stripe_event_id, kind) DO NOTHING RETURNING …
```

Four mechanisms, one promise, no shared code. None is covered by another's test, and a reader who
has internalised one shape will not recognise the next as the same thing.

**The composite key is the arm that matters.** `claimBillingEmail` dedups on (event, KIND), not on
the event alone — one Stripe event legitimately drives more than one kind of mail. Keyed on the
event, the first kind sent suppresses every other kind for that event: a customer charged and never
told, because the renewal reminder went out first. The SQL names both columns as its conflict
target; the double keys a Set on `${stripeEventId}:${kind}`. Same key, no shared code, nothing
asserting they agreed.

```
M1  DRIZZLE billing claim keys on the event alone   2 failed | 9 passed
M2  the DOUBLE keys on the event alone              1 failed | 10 passed
M3  DRIZZLE first-failure drops its isNull guard    1 failed | 10 passed
M4  the DOUBLE collapses the two flags into one     1 failed | 10 passed
restored (source 0 dirty)                           11 passed
```

M4 is the arm I would not have written without asking what the columns are for: the first-success
and first-failure claims are separate on purpose, and an implementation collapsing them into one
"welcome email sent" flag silences the success notice for every customer whose first session failed.

**Owed remaining: 14.**

---

## V-1226 — the third way a session dies, and the one that leaves no trace

Sixteenth of the twenty-nine, on the hot auth path. `findActiveWebSession` is what turns a cookie
into an authenticated request, and three separate things stop it — but only two of them look like
stopping it.

Expiry and revocation are the visible two, and V-1193 found an expired web session authenticating,
so both are pinned rather than assumed.

**The auth epoch is the third, and it writes nothing to the session row.** `setPassword` bumps
`accounts.auth_epoch`; every session carrying the old epoch stops matching the join, with
`revoked_at` still NULL on every one of them. That is how a password change signs out every other
device — and an implementation checking only expiry and revocation would keep authenticating exactly
the sessions a customer resets their password to kill.

The epoch arm asserts BOTH halves: the session stops resolving AND it was not revoked. "No longer
authenticates" alone is equally satisfied by an implementation that revokes everything, which is a
different and also defensible design whose behaviour differs everywhere else revocation is visible.

**A live trap found on the way, recorded rather than removed.** `InMemoryAuthRepo` carries its own
`findActiveWebSession` fallback that checks expiry and revocation and knows nothing about epochs.
It is unreachable today — `buildTestApp` wires `setWebSessionFinder` to the auth-flows double, which
does compare epochs, and the local seeding seam `upsertWebSession` has **zero callers**. But a
future test seeding through that seam gets a session that survives a password change and nothing
would say so. Left in place — it is another agent's helper and the removal is theirs — and
documented at the seam, pointing at the contract that pins the real behaviour.

```
M1  DRIZZLE drops the auth-epoch join condition   1 failed | 8 passed
M2  the DOUBLE drops the epoch comparison         1 failed | 8 passed
M3  the DOUBLE stops checking expiry              1 failed | 8 passed
restored (source 0 dirty)                         9 passed
```

**Both M2 and M3 failed to land on the first attempt, in different ways worth separating.** M2
aborted on its occurrence-count assertion — the string appears twice — so nothing was written and
the green run afterwards meant nothing; the assert did its job. M3 was worse: it applied to 1 of 2
occurrences and the suite stayed GREEN, because the line it removed was a token-expiry check in a
DIFFERENT method. A mutation that lands on the wrong site is indistinguishable from one the tests
survived, and the only tell was that the count said "1 of 2". Re-run against the exact lines inside
`findActiveWebSession`, both red.

That is the same lesson as V-1203 sharpened once more: asserting the count is necessary but not
sufficient. When a pattern appears more than once, the mutation has to name WHICH one.

**And the type-check gate caught a third thing.** `insertWebSession` returns
`WebSessionRow | null` and the fixture dereferenced it directly. All nine arms passed under vitest,
because esbuild strips types without checking them — the same catch as V-1214, on a different file.
Three separate failures in one contract, none of which a green vitest run would have shown.

**Owed remaining: 13.**

---

## V-1227 — filter first, then take the newest, and the fixture that makes the difference visible

Seventeenth of the twenty-nine. Three lookups sit on the entitlement path and differ only in which
statuses they accept, so what they share is an ORDER OF OPERATIONS:

```
findActiveSubscription      status ∈ {active, trialing}           -> newest of those
findCollectingSubscription  status ∈ {active, trialing, past_due} -> newest of those
findCurrentSubscription     any status                            -> newest overall
```

Filter FIRST, then take the newest of what survives. Reversed — newest row first, then check its
status — a customer who cancelled and resubscribed reads as having no active subscription, because
the cancelled row is newest and fails the status test.

That inversion is a recorded defect, and the double's own comment is the best statement of it: the
old guard "read the newest ROW regardless of status, so a canceled row sorting newer than a live one
let a second concurrently-billed subscription through", and the twin had the same bug, "which is why
no existing test could catch it". Fixed in V-741 and V-767; nothing pinned the fix across the pair
until now.

**The fixture puts the cancelled row NEWEST on purpose.** With the live row newest, filter-first and
filter-second agree and the arm proves nothing — the fourth time this session a fixture's ordering
decided whether an assertion could fail at all.

`findCurrentSubscription` is pinned alongside them BECAUSE it must not filter: it is the lookup that
should return the cancelled row, backing customer-facing copy about what happened to a subscription.
Without it, "filter first" is satisfied by an implementation that filters everywhere, including
where it must not.

```
M1  DRIZZLE findActive drops its status filter    2 failed | 9 passed
M2  the DOUBLE findActive drops its status filter 2 failed | 9 passed
M3  the DOUBLE findCurrent starts filtering       1 failed | 10 passed
restored (source 0 dirty)                         11 passed
```

**M2 and M3 both aborted on their first attempt, and that is the point.** M2's substring matched two
lines — the `past_due` variant contains the shorter string as a prefix — and M3's line offset was
simply wrong. Both asserts fired BEFORE writing, so nothing was mutated and the green runs that
followed proved nothing about the arms. Re-run against exact line numbers with the target line
printed, both red.

This is the rule from V-1226 working one entry after it was written: assert the count, name WHICH
occurrence, and print the line you are about to change. Two mutations that never landed would
otherwise have read as two arms that are not load-bearing.

**The type-check gate caught two more, in the same file.** The account snapshot was missing `name`
and `tier`, and `DrizzleBillingRepo` takes `Pick<Database, 'db'>` — no `client`, no `close` — while
the fixture passed all three. Eleven arms passed under vitest either way, because esbuild strips
types without checking them. That is the third contract in a row where `the-server-source-type-checks`
found something a green vitest run showed no sign of, which is worth stating plainly: for these
files a green vitest run is not evidence the fixture is well-formed.

**Owed remaining: 12.**

---

## V-1228 — a coin-flip assertion I nearly shipped, and a guarantee no double can hold

Eighteenth of the twenty-nine. Two findings, and the first is about my own test.

**I wrote an ordering arm that was FLAKY, not vacuous, and it passed twice before I caught it.**
The arm asserted the two snapshots came back in reverse creation order. Mutating the double's sort
left the suite green, which is what exposed it. The reason is a resolution mismatch nothing else in
this sweep has surfaced:

```
in-memory double   createdAt = new Date()      -> MILLISECOND precision
Postgres           created_at timestamptz      -> MICROSECOND precision
```

Two inserts back to back TIE in the double and do NOT tie in Drizzle. So the id tiebreak decides on
one side and `createdAt` decides on the other, and an arm asserting creation order is a coin flip on
two random uuids — passing until it does not, for a reason nobody could reproduce from the failure.
A rewrite pinning the id tiebreak instead was ALSO flaky, for the mirror-image reason: it is only a
tiebreak on the side that ties.

Fixed by making the fixture wait 5ms between inserts so `createdAt` genuinely differs on both sides,
then asserting newest-first. Five consecutive runs green, and mutating either implementation's sort
now reds it.

This is the fifth fixture-ordering trap this session and the first one that was not vacuous but
UNSTABLE, which is strictly worse: a vacuous arm never fails, so it is found by mutation; a flaky
arm fails later, in someone else's run, on a test they did not write.

**The second finding is a guarantee that CANNOT be a contract arm.** Snapshots exist to outlive the
profile they came from, and what makes that work is in the schema:

```
profile_snapshots_parent_profile_id_fkey   ON DELETE SET NULL
profile_snapshots_account_id_fkey          ON DELETE CASCADE
```

Purging the parent NULLs `parent_profile_id` and leaves the snapshot standing — which is why
`parentProfileId` is nullable and why restore falls back to `parentArchetype`/`parentName`. Deleting
the account takes the snapshots with it.

No in-memory double can hold that: it has no `profiles` table for a foreign key to point at, so
there is nothing to cascade FROM. The behaviour is not unimplemented in the double, it is
unimplementable there. Putting it in the shared block would produce an assertion that runs against
one implementation while reading as though it ran against two — the exact failure these contracts
exist to prevent. It sits in a labelled Drizzle-only block instead.

The two FK arms prove each other rather than needing a schema mutation: if both keys cascaded, the
survival arm fails; if both set null, the account arm fails. They can only both pass if the two
foreign keys genuinely differ.

```
M1  DRIZZLE list drops account scoping        2 failed | 9 passed
M2  the DOUBLE list reverses createdAt order  1 failed | 10 passed
M3  the DOUBLE delete drops its account check 1 failed | 10 passed
M4  DRIZZLE list orders oldest-first          3 failed | 8 passed
restored (source 0 dirty)                     11 passed
```

M4 is reported as it behaved rather than as a clean kill: swapping `desc` for `asc` also removes an
identifier that is not imported, so the Drizzle arms error rather than merely disagreeing. It
demonstrates the arm depends on that clause; it does not isolate ordering from compilation.

**Owed remaining: 11.**

---

## V-1229 — a sweep whose premise I had wrong, and a tiebreak tested where it can be tested

**The sweep, and the correction.** V-1228 found a flaky ordering arm caused by the double stamping
millisecond `Date`s where Postgres stores microseconds. That is a mechanism, so I swept for other
tests exposed to it: seven doubles stamp `createdAt` and sort by it, and two of those —
team-members and status-subscribers — carry NO id tiebreak.

**No latent flakes.** Every existing order assertion against those two is a single-element array —
a filtering check, not an ordering one — and my own V-1209 arms backdate one row, so the timestamps
differ on both sides.

**And my framing of the two as "outliers" was wrong.** I was about to add tiebreaks to make them
match the other five. Reading the convention first: `api-keys-repo` has BOTH shapes — `orderBy(desc(createdAt))`
on its simple lists and `orderBy(desc(createdAt), desc(id))` on its keyset-paginated one. The
tiebreak is there because keyset pagination REQUIRES a total order, not as a house style. Team-members
is non-paginated and follows the simple pattern correctly. Changing only it would have created the
inconsistency I thought I had found. Left alone.

What remains true and unfixed is narrow: for a non-paginated list, tie order is unspecified in
Postgres and happens to be insertion order in the double. Reaching it needs two rows written in one
transaction, since `now()` is transaction-scoped. Recorded rather than acted on.

**The contract.** `LegalRepo`, nineteenth of the twenty-nine — which version of each document a
customer is recorded as accepting, i.e. the record produced if anyone ever has to show that a
specific human agreed to a specific text.

```
Drizzle  SELECT DISTINCT ON (document_key) … ORDER BY document_key, accepted_at DESC, id DESC
double   sort by (acceptedAt DESC, id DESC), then first-hit-per-documentKey wins
```

`DISTINCT ON` and a first-hit loop over a sorted list are not obviously the same thing, and nothing
asserted they resolve to the same row.

**The tiebreak is tested where it can be tested honestly.** `accepted_at` is not monotonic-unique —
a customer clicking through terms and privacy in one request produces two rows with one timestamp —
but a tie CANNOT be forced through the shared interface, because `recordAcceptance` stamps the time
itself and the two implementations do not tie at the same resolution. That is V-1228's lesson applied
before writing the arm rather than after: the shared arms assert what is deterministic on both (with
distinct timestamps, newest wins), and the tie is exercised in the Drizzle-only block by writing two
rows with an identical `accepted_at` and deliberately chosen low/high uuids.

```
M1  DRIZZLE drops the id DESC tiebreak       tie arm reds        1 failed | 9 passed
M2  DRIZZLE resolves oldest-first            newest arm reds     1 failed | 9 passed
M3  the DOUBLE resolves oldest-first         newest arm reds     1 failed | 9 passed
M4  the DOUBLE collapses document keys       independence reds   1 failed | 9 passed
restored (source 0 dirty)                                        10 passed
```

M2 and M3 are the matched pair. M1 can only exist on one side, and says so.

**Owed remaining: 10.**

---

## V-1230 — a fixture bug wearing a finding's clothes

Twentieth of the twenty-nine. Two properties that fail in opposite directions, and one lesson about
how I nearly misread my own test.

**Visibility is a disclosure boundary.** `incidents.public` decides whether an incident reaches the
public status page, and `get(id, { publicOnly })` is what stops an internal incident — carrying
which customer tripped it, which node, what the operator suspects — from reaching an unauthenticated
reader who guesses an id. The status page is the one surface with no authentication in front of it,
so that predicate is the whole control.

**The create invariant fails the other way.** `createWithInitialUpdate` writes the incident and its
first update together, so an incident never exists with zero updates. The Drizzle repo treats a
missing initial update as unreachable and throws — right posture for a state nothing should produce,
and also the reason nothing ever checks that the write produces one. A double that created the
incident and forgot the update satisfies every test that only reads the incident, and the status page
renders an incident with no story attached.

**The near-miss.** The first run reported `expected +0 to be 1` on exactly that arm — the in-memory
double appearing to create an incident with no initial update, which is the defect the arm was
written to catch. It was my fixture. `createWithInitialUpdate` returns
`{ outcome, incident, update }`, not the incident row, so `row.id` was `undefined` and
`listUpdates(undefined)` returned nothing. The double writes the update correctly on line 83.

Worth recording because the failure was indistinguishable from a real find, and the tempting move
was to write it up as one. The check that settled it took one grep of the double's body. **A red arm
is a claim about the code that has to be verified exactly as carefully as a green one** — the same
discipline as V-1188, where a composite primary key made a "hole" unreachable, arriving from the
opposite direction.

`tsc` did NOT catch this one, which is worth stating after two entries praising it: the shape error
was inside an inferred return type the arm then destructured, not at an annotated boundary. Running
`tsc` first is a filter, not a proof.

```
M1  DRIZZLE get() drops the publicOnly predicate       1 failed | 10 passed
M2  the DOUBLE get() drops its publicOnly guard        1 failed | 10 passed
M3  the DOUBLE creates without its initial update      2 failed | 9 passed
restored (source 0 dirty)                              11 passed
```

M1 and M2 are the matched pair on the disclosure boundary. M3 reds both the create arm and the
scoping arm, because the scoping arm asserts the incident's own update is present — reported as it
behaved rather than as a single-arm kill.

Two other fixture errors the first run surfaced: `degraded` is not a member of `incident_severity`
(`minor | major | outage`), and the update body field is `message`, not `body`. Both were caught by
Postgres and by an assertion respectively, not by the type checker.

**A run-environment finding, because it cost more than the contract did.** Verifying this entry
took six full-suite attempts. The first hit the 10-minute tool cap and was SIGTERMed, which orphaned
a Postgres transaction holding `SELECT … FOR UPDATE` — every later test touching that row blocked,
and one reported a 950-second duration. I cleared that, then made it worse: `pkill -f vitest`
matched the shell wrapper and NOT the re-parented node process, so a 32-minute-old suite kept running
while I started another. Two full suites against one database on a 16 GB machine drove swap to
3.58 GB of 5.12 GB, and every subsequent run failed with `[vitest-pool]: Failed to start forks
worker` — 14 such errors matching exactly 14 ailed\ files, which are starvation and not
assertions.

The fix that worked is worth keeping: **`--maxWorkers=4` completes the suite in 294s with zero
starvation**, where default parallelism could not finish at all under memory pressure. Baseline at
full parallelism on a healthy machine is ~197s, so the constrained run costs about 50% wall-clock and
buys reliability. `--minWorkers` is not a valid flag in vitest 4.1.10 and fails the run outright.

Two operational rules from this: verify `pkill` by PID before starting another suite, because a run
you think you stopped will halve your database throughput and poison every read after it; and never
read `Failed to start forks worker` as a test failure — count it, and if the count matches the
failed-file count, the machine is the defect.

**Owed remaining: 9.**

---

## V-1231 — an inclusive boundary, and the first contract where the interface handed the value back

Twenty-first of the twenty-nine. `countActionsSince(accountId, action, since)` answers "how many
times has this account done this in the last window?", which is what abuse and rate-of-change
controls read. Under-report and the control does not fire; over-report and a customer is locked out
for activity they did not perform.

```
Drizzle  count(*) WHERE account_id = $1 AND action = $2 AND timestamp >= $since
double   rows.filter(r => r.accountId === … && r.action === … && r.timestamp >= since).length
```

**The boundary is INCLUSIVE on both sides, and that is the arm worth having.** Off by one changes
the count by exactly the entry sitting on the window edge — which is the entry a caller passing "the
timestamp of the last thing I saw" is asking about.

**And unlike the last two contracts, it is testable through the shared interface.** V-1228 and
V-1229 both hit the same wall: the repo stamps the timestamp itself, and a JavaScript millisecond
`Date` does not tie where a Postgres microsecond `timestamptz` does, so a fixture cannot force the
boundary and the property had to move to a DB-only arm. Here `insert` RETURNS the row, so the test
reads the stamp back and passes it as `since`. Exact on both sides, no race, no workaround. Worth
recording as the counter-example: the wall in those two entries was a property of those interfaces,
not a general limit on contract tests.

```
M1   DRIZZLE gte -> gt              5 failed | 6 passed   -- see below
M1b  DRIZZLE boundary shifted +1ms  4 failed | 7 passed   (clean)
M2   the DOUBLE >= -> >             4 failed | 7 passed
M3   the DOUBLE ignores the action  1 failed | 10 passed
restored (source 0 dirty)           11 passed
```

M1 is reported as it behaved and then replaced. `gt` is not imported in that module, so substituting
it made the identifier undefined and every Drizzle arm errored — the arm depends on that clause, but
the mutation proved compilation rather than boundary semantics. M1b shifts `since` by a millisecond
instead, which is exclusive-by-construction and needs no import, and it reds precisely the inclusive
arm. Same correction as V-1228's M4, applied deliberately this time rather than noticed afterwards.

M2 and M3 are the pair that matter: whichever side loses the inclusive boundary, the same arm fails.

**Owed remaining: 8.**

---

## V-1232 — a composite key that can fail in two opposite directions

Twenty-second of the twenty-nine. This is the record of "have we already mailed THIS subscriber
about THIS incident?", read before every incident notification. The whole surface is two methods and
one composite key, and everything that can go wrong is that key being too wide or too narrow.

```
Drizzle  INSERT … ON CONFLICT (subscriber_id, incident_id) DO UPDATE
             SET last_sent_at = excluded.last_sent_at
         SELECT last_sent_at WHERE subscriber_id = $1 AND incident_id = $2

double   Map keyed on `${subscriberId}::${incidentId}`
```

**Too wide** — keyed on the subscriber alone — and the first incident someone hears about silences
every later one. During a real outage that is the customer told the API is degraded and never told
it is fixed. **Too narrow** — keyed on the incident alone — and one subscriber's send suppresses
everyone else's, so the first person on the list is the only person notified.

Both failures are silent. The throttle reports "already sent" and the mail does not go; nothing
errors, and the absence of an email is not something a test notices unless it asks. So the arms hold
the key from BOTH sides — same subscriber different incident, different subscriber same incident —
rather than only asserting that a repeat is suppressed, which is the arm that would have been
written by looking at the happy path.

M1 and M2 are the same mutation in opposite directions, and each reds a different arm:

```
M1  the DOUBLE keys on the SUBSCRIBER alone   "throttled a different incident"   1 failed | 10 passed
M2  the DOUBLE keys on the INCIDENT alone     "throttled another subscriber"     1 failed | 10 passed
M3  DRIZZLE drops the incident predicate      "throttled a different incident"   1 failed | 10 passed
M4  the DOUBLE keeps the first timestamp      "did not advance last_sent_at"     1 failed | 10 passed
restored (source 0 dirty)                                                        11 passed
```

M4 covers the part that is not a claim. `markSent` returns void and calling it twice is expected on
a re-notify, so the upsert must ADVANCE `last_sent_at` rather than keep the first value — the
throttle window is measured from it, and a stuck timestamp turns a throttle into a permanent mute for
that pair. An implementation using insert-if-absent would satisfy every other arm here.

**A correction about my own process, and it invalidates a claim I made three times.** The suite
failed this entry on `the-server-source-type-checks`: my import took
`IncidentUpdateNotificationsRepo` from `services/incident-notifications.js`, which does not export
it — the interface lives in `db/incident-update-notifications-repo.ts`.

I had run `tsc --noEmit -p apps/server/tsconfig.json` before the mutation work and called it clean.
It was not clean; it was **empty**:

```
apps/server/tsconfig.json   include: ['src/**/*']   exclude: ['dist', 'node_modules', 'tests']
```

That project EXCLUDES tests, so it never checked the file I had just written — and an empty grep
over its output reads exactly like a pass. The gate itself runs two projects, `tsconfig.json` AND
`tsconfig.test.json`; only the second covers these contracts.

So the "tsc clean first time" noted in V-1228, V-1229 and V-1231 was vacuous — those runs checked
nothing about the new files. The type errors those entries credit the SUITE with catching were
caught by the suite precisely because my own check could not see them. The correct command for a
contract file is `tsc --noEmit -p apps/server/tsconfig.test.json`, and the result must be read from
the EXIT CODE, not from whether a grep printed anything. Both are now verified for this file: exit 0,
0 errors.

This is the same shape as every vacuous-arm finding in this log, turned on my own tooling: a check
that cannot fail reads identically to a check that passed.

**Owed remaining: 7.**

---

## V-1233 — two asymmetric edges, and the property that makes them correct together

Twenty-third of the twenty-nine. The staff-action trail — who did what to which customer — read a
window at a time: an export, a review, a page between two timestamps.

```
Drizzle  gte(timestamp, from)   AND   lt(timestamp, to)
double   timestamp >= fromMs    &&    timestamp <  toMs
```

`from` inclusive, `to` exclusive. Either edge alone looks arbitrary, and that is why the asymmetry
is easy to "tidy". What makes it correct is the consequence: adjacent windows `[a, b)` and `[b, c)`
PARTITION the log — every entry in exactly one, none counted twice, none dropped between pages.

Make `to` inclusive and the boundary entry appears in two consecutive exports; make `from` exclusive
and it appears in neither. Both are silent, and both corrupt a record whose only job is to be an
accurate account of what staff did. So the third arm asserts the partition DIRECTLY — the two
windows, their contents, and an explicit check that their intersection is empty — rather than
trusting that two individually-plausible edges compose.

```
M1  DRIZZLE `to` becomes inclusive     2 failed | 9 passed   (the `to` arm AND the partition arm)
M2  the DOUBLE `to` becomes inclusive  2 failed | 9 passed
M3  the DOUBLE `from` becomes exclusive  "stamped exactly at `from` was excluded"  1 failed | 10 passed
restored (source 0 dirty)              11 passed
```

M1 and M2 red two arms each, which is the right shape: an inclusive `to` is visible both as the
boundary entry appearing in a window that should exclude it AND as the intersection of two adjacent
windows becoming non-empty. The partition arm is not redundant with the edge arms — it is the one
that would still fail if someone "fixed" both edges to be inclusive, which is self-consistent and
still wrong.

**The corrected type check earned its keep immediately.** Running
`tsc --noEmit -p apps/server/tsconfig.test.json` — the project that actually covers tests, per the
V-1232 correction — caught FOUR errors in this file before a single test ran: `admin.support_note`
is not a member of `AdminAuditAction`, `ListAuditFilters.limit` is required, and `ListAuditPage`
exposes `items` rather than `data`. The old command would have reported all four as clean, and the
suite would have found them twenty minutes later.

**Owed remaining: 6.**

---

## V-1234 — a safety switch, and the write that ends the tick

Twenty-fourth of the twenty-nine. These schedules drive the recurring archetype-validation runs, and
two properties decide whether the scheduler behaves or misbehaves forever.

```
Drizzle  WHERE enabled = true AND next_run_at <= $now  ORDER BY next_run_at ASC  LIMIT $n
         markRun: SET next_run_at = $now + cadence_seconds
double   filter(r => r.enabled && r.nextRunAt <= now).sort(by nextRunAt).slice(0, limit)
         markRun: nextRunAt = now + cadenceSeconds * 1000
```

**`enabled` is a safety switch, not a display filter.** An operator turning a schedule off is saying
"stop running this", usually because it is producing bad results. A due-query that ignored the flag
would keep executing exactly the validation someone disabled — and the row would read as correctly
disabled the entire time, so the disabling would look like it worked.

**`markRun` advancing is what ENDS the tick.** It returns void and is not a claim, so nothing about
its signature suggests it is load-bearing. But a `markRun` that failed to move `next_run_at` forward
leaves the schedule satisfying `next_run_at <= now` on the very next sweep and every sweep after —
firing forever at the sweeper's interval rather than its own cadence. The arm asserts the schedule
stops being due at the same instant, which is the observable consequence rather than the field.

Worth noting the double gets right what three earlier doubles got wrong: it sorts BEFORE slicing, so
its limit selects the oldest-due rather than an arbitrary subset. That is the V-1210/V-1213 class,
absent here.

```
M1  DRIZZLE findDue ignores `enabled`      "a disabled schedule was selected"       1 failed | 10 passed
M2  the DOUBLE findDue ignores `enabled`   same arm                                  1 failed | 10 passed
M3  the DOUBLE markRun does not advance    "still due at the same instant"           1 failed | 10 passed
M4  the DOUBLE boundary <= becomes <       "due exactly at `now` was not selected"   1 failed | 10 passed
restored (source 0 dirty)                                                            11 passed
```

M1 and M2 are the matched pair on the safety switch. M4 covers the inclusive boundary, where `<`
instead of `<=` defers every schedule by one sweep interval — invisible except as everything running
slightly late, forever.

`upsert` derives `next_run_at` from the cadence and RETURNS the row, so the boundary is queried at
exactly that instant through the shared interface. Third contract running to that technique now, and
`tsc -p tsconfig.test.json` was clean first time — this time verified by exit code.

**Owed remaining: 5.**

---

## V-1235 — the string that TypeScript says is a number, caught at runtime

Twenty-fifth of the twenty-nine. `countByTargetSince` is what the SLA report reads — ok versus
failed probes per target over a window, plus when each target last failed. Those numbers become an
uptime figure on a page customers read to decide whether the platform is behaving.

**The first property is invisible to TypeScript.**

```
Drizzle  count(*) filter (where ok = true)  ->  declared sql<string>, then Number(...)
double   cur.okCount += 1                   ->  a number all along
```

The SQL count is a bigint and postgres-js returns bigints as STRINGS. The repo is honest about it —
the annotation says `sql<string>` and the mapping calls `Number()` — but that honesty is a
convention, not a guarantee. Drop the conversion and the field is TYPED `number` while HOLDING
`"7"`; the first arithmetic concatenates, `okCount + failCount` becomes `"70"`, and the uptime
percentage derived from it is nonsense that still renders.

So the arm checks `typeof` at RUNTIME, which is the only place the difference exists. M1 confirms
it: replacing `Number(r.okCount)` with a cast produced `expected 'string' to be 'number'` — a defect
no type checker in this repo can see, caught by an assertion about the value rather than the type.
This is V-1204 from the consuming side: that guard requires the cast in the SQL, this one requires
the conversion to survive to the caller.

**Last-failure is not last-probe.** Computed as `max(probed_at)` overall rather than
`max(probed_at) filter (where ok = false)`, a target that failed and then RECOVERED reports its
recovery moment as the last failure — the incident reads as still happening after it is over. M2 and
M3 are the matched pair on that, one per implementation, and M3 reds a second arm too: the same
mutation gives a never-failed target a phantom failure time.

```
M1  DRIZZLE drops Number()                 "okCount is not a number at runtime"  1 failed | 12 passed
M2  DRIZZLE lastFailureAt = last probe     "followed the recovery"               1 failed | 12 passed
M3  the DOUBLE tracks any probe            same arm + phantom failure time       2 failed | 11 passed
M4  the DOUBLE boundary >= becomes >       "not inclusive-start"                 1 failed | 12 passed
restored (source 0 dirty)                                                        13 passed
```

`recordProbe` takes `probedAt` as a parameter, so unlike the previous four contracts the timestamps
are chosen outright — every boundary arm is exact without reading a stamp back. Worth noting because
it is the third distinct arrangement now: some repos let the caller choose the time, some hand the
stamp back, and some do neither and force a DB-only arm.

**Owed remaining: 4.**

## V-1236 — a chained regex froze the gap between two statements, not the statements

A peer landed `089264371` ("Test a proxy the moment it is entered, not the moment it is needed") —
34 lines into `apps/gui-client/src/views/ProxiesView.tsx`, no tests, no ratchet — and left the
suite red on `gui-client-views-ProxiesView-content-parity.test.ts`. I deferred it last turn because
that file was being written concurrently; the commit is now 12 minutes old with nothing since and
the file is clean in the tree, so it is safe to take.

**The source was right and the pin was wrong.** The assertion was one regex chained across a whole
branch:

```
if \(editor\.kind === 'add'\) \{\s*\n?\s*await addProxy\(draft\);\s*\n?\s*\} else if \(…'edit'\) \{
```

That freezes the ADJACENCY of the call and the `} else if`, so a statement added inside the branch —
here `testAfterSave = 'added';` — reads as a removed dispatch. The failure message says the add path
is gone when the add path is fine. Split into two independent branch anchors: what happens between
them is the branch's own business.

**The comment on the new code described a mechanism that is not there.** It claimed the post-save
probe is "deliberately NOT inside the save's try". It is inside it — `try` at 232, `catch` at 295,
the block at 271. And it must be, or it would run after a save that failed. What actually stops a
failed probe reporting a successful save as failed is two catches: `listProxies().catch(() => null)`
and `void handleTest(target).catch(() => undefined)`. Anyone trusting the comment could delete either
one and reintroduce exactly the bug the comment says cannot happen. Comment corrected to name the
real mechanism; both catches pinned individually, because they are load-bearing rather than habit.

**A sentinel of mine was vacuous and the first mutation hid it.** To pin that a label-only rename
does not re-probe, I wrote `if \(connChanged\) \{[\s\S]{0,600}?testAfterSave = 'edited';`. My first
M3 de-indented the assignment, the suite stayed green, and that reads as "the arm is not
load-bearing" — but de-indenting does not move a statement out of a block, so the mutation was
testing nothing. The real defect was worse: `[\s\S]*?` spans the branch's closing brace, so the
regex matches just as happily with the line moved OUT of the branch. Rewritten as
`(?:(?!\n {8}\})[\s\S])*?`, which forbids that brace in the gap, and re-proved by actually
relocating the statement below it.

```
M1  drop listProxies().catch          "await listProxies().catch(() => null)"    1 failed | 11 passed
M2  drop handleTest().catch           the fire-and-forget pin                    1 failed | 11 passed
M3  de-indent the assignment          NOTHING — the mutation was inert           12 passed
M3' MOVE it below the closing brace   the tightened nesting pin                  1 failed | 11 passed
M4  remove the add dispatch           the split add-branch anchor                1 failed | 11 passed
restored (source 0 dirty, sha equal)                                             12 passed
```

Both `tsc -p apps/server/tsconfig.test.json` and `tsc -p apps/gui-client/tsconfig.json` exit 0 —
read as exit codes, not as empty output, and not through a pipe into `tail`, where `$?` is `tail`'s
status and always 0. No ratchet change: one `it()` added to an existing file, no new file.

## V-1237 — two paging algorithms that agree until an admin changes a row

Twenty-sixth of the twenty-nine. `AccountsAdminRepo.list` is the staff account browser — filter,
page, count. The counters were fine. The paging was two different algorithms wearing one interface:

```
Drizzle  keyset.  cursor row looked up BY ID, then
                  WHERE (created_at, id) < (cursor.created_at, cursor.id)
                  ORDER BY created_at DESC, id DESC   LIMIT $n + 1
double   offset.  findIndex(r => r.id === cursor) inside the ALREADY-FILTERED array,
                  slice from that index + 1
```

They agree exactly while the cursor row still satisfies the filter, which is why nobody noticed.
`findIndex` returns **-1** when it does not, and the double read -1 as "start from the top".

The workflow that separates them is the one the browser exists for: filter by `status: 'active'`,
read page one, **suspend** an account you just read, ask for page two. The cursor row has left the
filtered set, so the double restarts and page two re-lists accounts already on page one — staff
acting twice on the same account. The keyset query continues from where it left off, because it
resolves the cursor against ALL accounts and lets the cursor row be gone from the filtered set.
Resolving against `all` rather than against `filtered` is the load-bearing line; M1 proves it.

Fixed the double to keyset. Its ordering and its cursor boundary now share one `compareKey`, so the
boundary cannot disagree with the ordering it is a boundary in.

```
M1  double resolves the cursor in `filtered`   the suspend-mid-page arm     1 failed | 24 passed
M2  double boundary < becomes <=               partition (cursor repeats)   1 failed | 24 passed
M3  double drops the limit cap                 101 rows returned for 100    1 failed | 24 passed
M4  double countCreatedSince >= becomes >      the inclusive arm            1 failed | 24 passed
M5  double countByTier stops zero-filling      enum-key + attribution arms  2 failed | 23 passed
M6  DRIZZLE gte(since) becomes gte(since+1ms)  the inclusive arm            1 failed | 24 passed
M7  DRIZZLE drops the limit cap                the cap arm                  1 failed | 24 passed
restored (both files 0 dirty, sha equal)                                    25 passed
```

**M6 first went in as `gt(...)` and that proof was worthless.** `gt` is not in this module's import
list, so the arm reddened on a ReferenceError rather than on a moved boundary — a mutation that
crashes proves the test file runs, not that the assertion discriminates. Redone as
`gte(since + 1ms)`, which is the same semantics using only symbols already in scope.

**Two fixture faults, both caught before they could be read as findings.** A raw
`INSERT INTO accounts (…, tier, status, created_at, …)` through postgres-js throws
`TypeError: The "string" argument … Received an instance of Date` — `tier` and `status` are Postgres
ENUMS and the mixed enum/timestamp parameter list is mis-serialised. Seeding through Drizzle's own
insert fixes it, because Drizzle knows the column types. And the cap arm's 101 sequential inserts
timed out at 10 s, so seeding is batched into one statement.

**A zsh trap worth recording.** `FILES=$(grep -rl …); npx vitest run $FILES` runs **two** files, not
39: zsh does not word-split an unquoted expansion, so the whole list arrives as a single argument
that matches nothing, and the run reports green. `${=FILES}` splits it. Re-run properly: 41 files,
517 tests, all green — the keyset rewrite moves nothing under the existing consumers
(`build-test-app.ts`, `auth-cache.test.ts`, the shape-parity guard, and 38 admin route tests).

Every method here is global — `list` has no account scope and the counters take no filter — so list
arms scope with a unique `emailContains` token and counter arms assert a DELTA across a seed. That
is the fourth fixture arrangement in this campaign: caller-chosen time, stamp-returned,
DB-only-arm, and now unscoped-so-measure-the-delta.

Ratchets: 2989 → 2990, 3156 → 3157, conditional skips 166 → 167.

**Owed remaining: 3.**

## V-1238 — two lists of the same two strings

Twenty-seventh of the twenty-nine. `AdminBillingRepo.countActiveSubscriptionsByTier` produces the
paying-customer count per tier on the admin cockpit. The Drizzle repo filtered on a module-private
`ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing']`; the in-memory double restated the same set
as `s.status === 'active' || s.status === 'trialing'`.

Nothing is wrong today — the lists agree. Nothing would have reported the day they stopped. Stripe
keeps billing a `past_due` subscription through its retry window, so a third billed status is a
plausible edit rather than a hypothetical one, and making it would have moved the real revenue
figure while every test standing on the double went on asserting the old one and agreeing with
itself. Exported the constant; the double reads it.

**The contract derives both sets rather than naming them.** Billed comes from the constant, unbilled
is `subscriptionStatus.enumValues` minus it, and `it.each` covers each. A status added to either
enum extends the contract on its own instead of quietly falling outside it — a test that hardcoded
'active' and 'trialing' would have been a third copy of the list this entry is about.

`it.each` over an EMPTY array registers zero tests and reports green, so a derivation that produced
nothing would look like a passing contract rather than an absent one. Two ungated arms guard that:
both sets non-empty, and the two together partitioning the enum exactly.

```
M1  double: only 'active' counts             the trialing arm                2 failed | 25 passed
M2  double: an unbilled status counts         the canceled/past_due arms      5 failed | 22 passed
M3  double: stops zero-filling tiers          enum-key + attribution         11 failed | 16 passed
M4  DRIZZLE: drop the ::int cast              "not a number at runtime"       1 failed | 26 passed
M5  DRIZZLE: drop the status filter           six unbilled arms               6 failed | 21 passed
restored (both files 0 dirty, sha equal)                                     27 passed
```

## V-1239 — a test that corrupted the prices it was checking

Twenty-eighth of the twenty-nine. `PricingRepo` is two methods over a table whose primary key is
`tier`, so a re-edit must REPLACE rather than accumulate — on the Drizzle side that is the
`ON CONFLICT (tier)` target, on the double it is `Map.set`. Six arms, including a price of ZERO
surviving as zero rather than being swallowed by a truthiness check, which is the value a comped
tier has and the value a `|| default` silently replaces with the old number.

Neither side orders `listAll`, and no arm asserts an order: `pricing-repo.ts::listAll` is already in
the reviewed-unordered list, because every consumer folds the rows into a map keyed by the primary
key. Asserting an order would freeze a property the repo does not promise.

**The first draft corrupted the local database, and the second draft hid it.** `pricing` is a
seeded global config table, so the fixture snapshots it and restores it. That restore shared a
connection pool with the repo under test, deadlocked, and was killed by vitest's 10-second hook
timeout — leaving `api_starter` at 4900 and `api_scale` at 19900 where migration 0067 seeds 14900
and 149900. The next run then snapshotted the corrupted values and faithfully restored THEM, so the
damage presented as a clean pass, and the row COUNT was right the whole time.

It was caught by comparing the values against the migration rather than counting rows. Repaired all
six tiers to their seeded values and verified.

Three fixes, in order of how much they matter:

1. The contract now writes to `free` and `enterprise` — the two tiers migration 0067 does NOT seed.
   The worst a dead hook can now leave is two rows that were never there, instead of two prices
   that are wrong and look right. Choosing the blast radius beats restoring it correctly.
2. The restore closes the repo's pool FIRST and runs on a connection of its own, so it cannot queue
   behind connections that pool never frees.
3. The snapshot/restore stays as well. Defence in depth on a global config table is cheap.

```
M6  double: a zero price is dropped           "a zero price was dropped"      1 failed | 12 passed
M7  DRIZZLE: re-edit does nothing on conflict  the replace/zero/tier arms     4 failed |  9 passed
restored (both files 0 dirty, sha equal)                                     13 passed
```

**Do not create test files while the suite is running.** The full run this turn reported
`2 failed | 3155 passed (3157)` — collection matched the ratchet exactly, and both failures were
guards that count test files ON DISK at execution time, reacting to two contract files written
while the run was in flight. Real breakage and this artefact look identical in the summary; the
only way to tell them apart is to re-run the two guards once the tree has stopped moving. They pass.

Ratchets: 2990 → 2992, 3157 → 3159, DATABASE_URL gate 124 → 127, conditional skips 167 → 169.

**Owed remaining: 1** — `AccountAuthRepo`.

## V-1240 — the last of the twenty-nine, and the same duplicated number one file over

Twenty-ninth of the twenty-nine. `findApiKeyByPrefix` is the first step of authenticating every API
request; `touchApiKeyLastUsed` is the write that follows, and it is throttled so the hot auth path
does not update a row on every authenticated request.

**A throttle and a broken write are the same observation.** From one call, both leave `last_used_at`
where it was. Only calling twice and moving the clock separates them — and that is not hypothetical
here: the double did not throttle originally, and an unthrottled double MASKED a real Drizzle bug in
which `last_used_at` never updated at all. So the contract asserts a write that must land, a write
that must not, and the boundary between them.

**The same finding as V-1238, one file over.** `API_KEY_LAST_USED_THROTTLE_MS = 30_000` was
module-private, and the double carried its own `const THROTTLE_MS = 30_000` under a comment saying
it mirrored that one. An acknowledged duplicate is still a duplicate: two numbers that agree until
someone edits one, and widening the window would have left every test on the double asserting the
old cadence. Exported; both sides read it, and so does this contract — hardcoding 30_000 in the test
would have made it the third copy. The boundary arm derives from the constant, so moving the window
moves the arm.

The boundary is STRICT on both sides — a touch exactly one window later is still throttled. That is
the difference between "at least 30s apart" and "more than 30s apart", and it is worth pinning
precisely because either reading looks defensible alone.

**Prior art, checked before writing rather than after.** `db-auth-repo-last-used-throttle-drizzle.ts`
already covers this write — but Drizzle-only, in a single `it` carrying three behaviours, with no
in-memory arm and no boundary case. It establishes that the repo works; it cannot establish that the
two implementations agree, which is what this campaign is for. Its 10s/40s offsets are only correct
for a 30s window, but they fail LOUDLY if the window moves, so they were left alone.

```
M1  double: window becomes 0                  inside-window + boundary arms  2 failed | 14 passed
M2  double: boundary < becomes <=             the strict-boundary arm        1 failed | 15 passed
M3  double: never-used key is skipped         first-touch + 3 dependents     4 failed | 12 passed
M4  DRIZZLE: window sign flipped, no throttle  inside-window + boundary       2 failed | 14 passed
M5  DRIZZLE: isNull arm retargeted, no throttle inside-window + boundary      2 failed | 14 passed
restored (both files 0 dirty, sha equal)                                     16 passed
```

**M3 first went in by deleting the `lastUsedAt === null ||` branch, and that proof was worthless** —
it made the next term dereference null, so the arm reddened on a TypeError. Same mistake as V-1237's
first M6, two entries apart: a mutation that CRASHES proves the file runs, not that the assertion
discriminates. Redone as `!== null &&`, which skips a never-used key without throwing.

**`tsc` caught what a green vitest run could not.** The first version omitted `createdAt` from the
seeded `ApiKeyRow`. All 16 tests passed — esbuild strips types, so a structurally invalid literal
runs perfectly well — and `tsc -p tsconfig.test.json` exited 2. A vitest pass is not a type check.

The scope fixture also had to be corrected: `scopes` is a Postgres ENUM array (`api_key_scope`), and
'profiles:read' is not a member — the enum spells it 'read:profiles'. The in-memory half accepted
the invalid values happily, so the Drizzle half is what found it.

Ratchets: 2992 → 2993, 3159 → 3160, DATABASE_URL gate 127 → 128, conditional skips 169 → 170.

**Owed remaining: 0 against the twenty-nine that were on the list.** Superseded by V-1241: that
closing count was taken from the number of contract FILES, and enumerating the doubles afterwards
turned up one pair with no contract at all. The totals matched while the coverage did not.

## V-1241 — the thirtieth pair, which a matching total had hidden

V-1240 closed this campaign by reporting the full set covered. That count came from the number of
contract FILES, and it was wrong. Enumerating the doubles instead of counting them:

```
29 doubles.  29 contract files.  Not a bijection.
  InMemoryAuthRepo        named by 3 contracts   (pulled in as a collaborator)
  InMemoryAuthFlowsRepo   named by 2
  InMemoryRateLimitOverridesRepo   named by NONE
```

`DrizzleRateLimitOverridesRepo` is wired in `bootstrap.ts` and serving production. The totals
matched exactly while one live pair had no contract at all — which is the entire argument for
enumerating a set rather than reporting its size, arrived at the hard way one entry after
declaring the work finished.

**Precision the database cannot hold.** `refill_per_second_centi` is an INTEGER of hundredths:

```
Drizzle  write  Math.max(1, Math.round(refillPerSecond * 100))    read  centi / 100
double   write  input.refillPerSecond                             read  the same float back
```

The double answered with whatever the caller passed; the column answers with what it can store. A
test asserting a refill of 1.234 passed while production served 1.23. Worse, `Math.max(1, …)` floors
any rate below half a centi — INCLUDING ZERO — at 0.01, because a bucket that never refills is a
permanent lockout rather than a rate limit. The double reported 0 for that: the exact lockout the
floor exists to prevent, in the one place a test would have looked for it.

Both now call the exported `quantizeRefillPerSecond`, and so does the contract. Asserting a literal
1.23 in the test would have made it a third copy of the rounding rule — the V-1238 and V-1240
finding a third time, which is why the helper was exported rather than the number duplicated again.

**And the V-1237 paging split, in a repo where it is easier to hit.** The double resolved its
cursor with `findIndex` inside the already-filtered array; `findIndex` returns -1 when the cursor
row no longer passes the filter, which the slice read as "start from the top". In V-1237 that
needed an admin to suspend an account between pages. Here the filter is `expiresAt > now`, so the
cursor row leaves the set BY ITSELF: page one at 10:00, page two at 10:01 after the boundary
override lapsed, and page two re-lists overrides already seen. No one has to do anything.

```
M1  double stores the caller's float          quantised + zero arms       2 failed | 21 passed
M2  double cursor boundary < becomes <=       expired-cursor + partition  2 failed | 21 passed
M3  double re-set resets createdAt            the createdAt arm           1 failed | 22 passed
M4  double lists expired as active            the expiry arm              1 failed | 22 passed
M5  DRIZZLE drops the one-centi floor         the zero arm, BOTH halves   2 failed | 21 passed
M6  DRIZZLE drops the expiry filter           the expiry arm              1 failed | 22 passed
restored (both files 0 dirty, sha equal)                                  23 passed
```

M5 reddens both halves from a single edit, which is the point of the shared helper: there is one
place left to get this wrong.

**Four frozen occurrences, enumerated with both grep patterns before any edit.** Moving the
arithmetic into `toRefillCenti` broke content-parity pins that had frozen the literal expression in
`db-rate-limit-overrides-repo-content-parity.test.ts` and
`db-rate-limit-overrides-repo-v016-cross-source-invariant.test.ts` — two pins each, on the floor and
on the read-side divide. Repointed at the new home, `it(` counts unchanged at 8 and 9, and both
test TITLES updated too: they quoted the old expression, and a title that describes code that no
longer exists is the same defect as a comment that does. Three negatives, each reddening both
guards: remove the floor, inline the scale in `toRecord`, inline the call site.

`setByKeyId` is NOT NULL and typed `string`, so the first draft's `null` was a type error — found by
`tsc`, again, after a vitest run had already reported the arm failing for what looked like a
different reason. Second time this turn that a green-or-red vitest result said nothing about types.

Ratchets: 2993 → 2994, 3160 → 3161, DATABASE_URL gate 128 → 129, conditional skips 170 → 171.

**Owed remaining: 0, and this time the set was enumerated rather than counted.**

## V-1242 — the class behind V-1237 and V-1241, enumerated instead of stumbled into

V-1237 found an offset-vs-keyset paging split in the admin-accounts double. V-1241 found the same
thing in rate-limit overrides. Two instances is a class, so this time the doubles were enumerated
rather than waited for:

```
offset by POSITION (defective)          keyset already (correct)
  in-memory-sessions-repo.ts       x2     in-memory-incidents-repo.ts
  in-memory-api-keys-repo.ts              in-memory-webhooks-repo.ts
  in-memory-admin-audit-repo.ts           in-memory-profiles-repo.ts
  in-memory-account-audit-repo.ts         in-memory-admin-accounts-repo.ts   (V-1237)
  in-memory-profile-snapshots-repo.ts     in-memory-rate-limit-overrides-repo.ts (V-1241)
```

**Six defective sites, not two.** All five Drizzle counterparts page by keyset — verified in source,
one repo at a time — and all five scope the cursor-anchor lookup by TENANCY only, never by the
mutable filter. That last detail is the whole mechanism: the cursor row is deliberately allowed to
have left the visible page.

**The fix already existed in this codebase and was never swept.** `in-memory-profiles-repo.ts`
carries it under a comment labelled "FIX 3", describing the same pagination loop in the same words —
someone hit this, fixed the one double in front of them, and the class went unexamined. That is the
argument for a shared `keysetPage` helper rather than a seventh correct copy.

**The triggers are ordinary, and they get worse down the list.** A staff member suspending an
account (V-1237). A customer revoking an API key. An override expiring. A session FINISHING — that
listing filters on `status`, which a session changes by itself, so page two of a `running` listing
restarted at the top on an ordinary clock tick with nobody touching anything. None of these is an
error; each is a page of duplicates handed to a caller that has already acted on them.

This entry converts the two sessions sites and the api-keys site. The three remaining — both audit
doubles and profile snapshots — follow in the next commit, together with a guard so the class cannot
return.

```
api-keys contract, revoked-between-pages arm (drives BOTH implementations)
M1  double resolves the anchor in the filtered set   the old defect      1 failed | 10 passed
M2  DRIZZLE anchor lookup scoped by revoked too      same, prod side     1 failed | 10 passed

keysetPage's own semantics
N1  anchor resolved in `rows` not `anchorSet`        the defining arm    1 failed |  5 passed
N2  boundary id < becomes <=                         partition           2 failed |  4 passed
N3  id tie-break dropped                             same-timestamp arm  1 failed |  5 passed
N4  cursor handed out on the last page               terminating null    1 failed |  5 passed
N5  parseUuidCursor guard removed                    malformed cursor    1 failed |  5 passed
restored (all files 0 dirty, sha equal)                                  6 passed / 11 passed
```

**N5 passed the first time, and that was the finding.** The malformed-cursor arm asserted that a
non-uuid cursor falls back to page one — but a lookup for a non-uuid MISSES whether or not the guard
is there, so removing the guard changed nothing and the arm pinned nothing. Fixed by putting a row
whose id IS the malformed cursor into the anchor set, positioned so that anchoring on it returns a
visibly different page. Same shape as V-1237's inert de-indent and V-1240's crashing mutation: the
mutation is what tells you whether the arm discriminates, and a green mutation run is a result, not
a formality.

Sessions has no both-implementations contract, so those two sites rest on the helper's own arms plus
the fact that they now call the same proven function. Stated here rather than left implied.

Ratchets: 2994 → 2995, 3161 → 3162. The gate and conditional-skip counts do not move: `keyset-page.ts`
is a helper rather than a test file, and the new unit test gates on nothing.

## V-1243 — the last three sites, and a guard so the class stops coming back

V-1242 converted three of the six positional-cursor sites. This closes the other three — both audit
doubles and profile snapshots — and adds the guard.

Each double now mirrors the anchor scope its Drizzle counterpart actually uses, which is not the
same answer three times:

```
account-audit      and(eq(id, cursor), eq(accountId, accountId))   -> anchorSet = account-scoped
profile-snapshots  and(eq(id, cursor), eq(accountId, accountId))   -> anchorSet = account-scoped
admin-audit        eq(id, cursor)                                  -> anchorSet = UNSCOPED
```

**The admin-audit anchor lookup is unscoped, and I mirrored it rather than corrected it.** The
profile-snapshots repo carries a comment explaining why IT scopes: an unscoped anchor lets a forged
cross-account cursor resolve to another account's `(createdAt, id)`, mis-positioning the caller's
page and answering whether a given id exists. The same argument applies to `admin_audit_log`
between staff members, where the main query filters on `adminAccountId` but the anchor lookup does
not. It is staff-only and the severity is low, and `unscoped-cursor-listings-stay-admin-only.test.ts`
does not cover it because that guard is about listings whose MAIN query is unscoped — a different
thing. A fixture is the wrong place to decide this: the double copies production, and changing
production cursor scoping is its own change with its own pins. **Recorded here as an open item, not
silently fixed.**

The profile-snapshots sort also compared ids with `localeCompare`; it now uses plain byte order,
which is what Postgres compares uuids by, and the keyset boundary derives from the same comparator
so ordering and boundary cannot drift apart.

**The guard looks for the defect's signature, not for use of the helper.** Three doubles page
correctly with cursor shapes `keysetPage` does not model — a composite `{ startedAt, id }` object,
a delivery cursor with a legacy created_at-only form, and the profiles anchor variant. Demanding the
helper would mean churning correct code to satisfy a test.

```
G1  reintroduce a positional cursor in one double   named the exact file:line   1 failed | 2 passed
G2  comment-stripper disabled (raw scan)            2 arms                      2 failed | 1 passed
restored (both files 0 dirty, sha equal)                                        3 passed
```

**G2 is the arm that matters most, and it exists because of how this class was found.** Every
converted double now carries a comment explaining the defect it used to have — prose containing
both `findIndex` and `cursor`. A scanner reading raw source reports all six explanations as six
defects. The guard strips comments first and has an arm proving it does, because an audit that
cannot tell code from prose measures nothing. The first hand-grep in this campaign returned mostly
comment lines for exactly this reason.

The guard also carries a positive control: the scan must find more than twenty doubles, and the
signature must still match a synthetic positional cursor. A guard reporting zero because it looked
nowhere reads identically to one reporting zero because the defect is gone.

Class now closed: 6 sites converted, 3 already correct, 1 guard, and the shared helper covered by
its own arms in V-1242.

Ratchets: 2995 → 2996, 3162 → 3163.

## V-1244 — a constant that was named to have one home, and a fixture that never got the message

The restated-constant class again (V-1238 billed statuses, V-1240 throttle window, V-1241 centi
scale), found this time by enumerating rather than by stumbling. Scanning the doubles for numeric
literals, with comments stripped, turned up the page size:

```
src/db/profiles-repo.ts           const DEFAULT_PAGE = 50; const MAX_PAGE = 100;   NAMED
_helpers/in-memory-profiles-repo  Math.min(args.limit ?? 50, 100)                  copied

src/db/admin-accounts-repo.ts     Math.min(args.limit ?? 50, 100)                  literal
_helpers/in-memory-admin-accounts Math.min(args.limit ?? 50, 100)                  literal

src/db/profile-snapshots-repo.ts  Math.min(args.limit ?? 50, 100)                  literal
_helpers/in-memory-profile-snaps  Math.min(args.limit ?? 50, 100)                  literal
```

**Profiles is the sharp one, and this entry fixes it.** That repo had already gone to the trouble of
NAMING both numbers — which is a decision that the page size should have one home — and the fixture
still carried a copy. Raising `MAX_PAGE` would have served larger pages in production while every
test standing on the double went on asserting the old cap and agreeing with itself. Exported; the
double imports them.

**Deliberately not one shared constant across all three.** They carry the same two numbers today,
but a customer profile page, a staff account browser and a snapshot list are separate product
limits that merely coincide. Folding them together would mean raising one silently raised the other
two — a worse defect than the one being fixed, and harder to see.

```
N1  drop the `export` keyword                      the content-parity pin    1 failed | 15 passed
N2  repo MAX_PAGE = 7 AND the double back to 100   the clamp arm             1 failed |  3 passed
restored (both files 0 dirty, sha equal)                                     16 passed / 4 passed
```

N2 is deliberately the PAIR of edits it would take to reintroduce the drift, because either alone
proves less: moving the constant alone moves the double with it (that is the fix working), and
restoring the literal alone happens to agree with the current value. Only both together separate
them, which is exactly the situation the old code was one edit away from.

**The two arms import the constants rather than naming 50 and 100.** They pin the WIRING — that the
double clamps to whatever the repo's `MAX_PAGE` is — not the values, so raising the page size moves
the arms with it instead of leaving a third copy to update.

The `export` is now load-bearing, so the content-parity pin was updated to require it, in this same
commit, with N1 as its negative.

**Still owed on this class, enumerated not forgotten:** the admin-accounts and profile-snapshots
pairs each restate `50, 100` in BOTH repo and double. Same drift risk, one step earlier — nothing is
named on either side. Fixing them means introducing constants and updating roughly six pins that
quote `Math.min(args.limit ?? 50, 100)` verbatim across four guard files. Worth doing, and larger
than it looks; recorded here so it is a queued item rather than a thing I noticed and dropped.

Also recorded from V-1243 and still open: `DrizzleAdminAuditLogRepo`'s cursor-anchor lookup is
unscoped where `profile-snapshots-repo.ts` documents why it scopes its own.

No ratchet change: two arms added to an existing file, no new file.

## V-1245 — the staff page size, and a flake of my own that only a parallel run could show

V-1244 fixed the profiles half of the page-size class and queued the other two pairs. This closes
admin-accounts: both the repo and its double carried `Math.min(args.limit ?? 50, 100)`, so the two
agreed only until somebody edited one. Named `ADMIN_ACCOUNTS_PAGE_DEFAULT` / `_MAX`, exported, and
the double imports them. Its own constants, not shared with the profiles or snapshot listings — the
same reasoning as V-1244: three product limits that coincide at 100 today, and folding them together
would mean raising one silently raised the others.

Four frozen occurrences, enumerated with all three patterns (import path, quoted basename, and the
regex-escaped expression) and updated in this commit:

```
db-admin-accounts-repo-content-parity.test.ts        text pin + title + header
db-admin-accounts-repo-cross-source-invariant.test.ts  text pin + title + header
db-admin-accounts-repo-drizzle.test.ts               behavioural: 101 seeds, expects 100
admin-accounts-list-repo-contract.test.ts            behavioural: 101 seeds, expects 100
```

The two behavioural arms now derive BOTH the seed count and the expectation from the constant, so
they follow the cap instead of becoming the fifth and sixth copies of it.

```
N1  drop `export` on both constants        both text pins    2 failed | 22 passed
N2  inline the literals at the call site   both text pins    2 failed | 22 passed
N3  repo cap 7 AND double back to literal  the contract arm  1 failed | 24 passed
restored (both files 0 dirty, sha equal)                     24 passed / 25 passed
```

**A flake of mine, surfaced by running nine files together.** Two `countCreatedSince` arms failed
with a NEGATIVE delta — `expected -2 to be 1`. They passed alone, and passed as a pair, at both the
old and new revisions, so the change was not the cause. The cause is that `countCreatedSince` takes
no account filter: it counts the whole table. My window started yesterday, so the delta picked up
every account every parallel test file inserted or deleted in between, and a concurrent sweep
deleting its fixtures drove the count DOWN.

Fixed by dating the counter fixtures into the far future and anchoring the window there, past every
other fixture's `now()`. That scopes an unscopeable counter to exactly the rows this file seeded.
Verified over five consecutive nine-file runs rather than one, because a single green run does not
retire a race.

The `countByStatus` and `countByTier` deltas have the same shape and cannot be fixed the same way —
those counters have no time parameter to anchor. Their exposure is far smaller: two queries with one
insert between them, rather than a window spanning the whole run. Recorded rather than left implied.

**I broke rule 6 and it cost exactly what the rule exists to prevent.** Restoring a mutated fixture,
I reached for `git checkout -- <file>` instead of a scratchpad snapshot. That file held UNCOMMITTED
work — the double's wiring from earlier in this same batch — and the checkout discarded it silently.
Caught by grepping for the constant afterwards rather than by anything failing. Re-applied, then
snapshotted properly. A mutation harness that restores from git is only safe when the file is clean,
which during a batch it never is.

Two of the mutation runs also printed no summary at all: `mut "$A $B"` passes two paths as ONE
argument, vitest matches nothing, and a run that tested nothing looks like a run that printed
nothing. Re-run with `${=VAR}`. Third time this session that zsh's lack of word-splitting has turned
into a silent no-op.

Still owed on this class: the profile-snapshots pair, same shape.

## V-1246 — the last page-size pair, and a negative that proved nothing until it was rebuilt

Third and last of the pairs V-1244 enumerated. `profile-snapshots-repo.ts` and its double both
carried `Math.min(args.limit ?? 50, 100)`; named `SNAPSHOT_PAGE_DEFAULT` / `_MAX`, exported, and the
double imports them. Separate constants again — all three listings cap at 100 today, and one shared
constant would mean raising the snapshot page silently raised the customer profile list and the
staff account browser with it.

Three frozen occurrences updated in this commit: the content-parity chained regex, the v312
cross-source pin, and the behavioural arm in `db-profile-snapshot-restore-dek-drizzle.test.ts`,
which now derives both its seed count and its expectation from the constant.

**The first N3 passed, and reading it as proof would have been wrong.** The plan was: move the repo
cap to 7, put the literal back in the double, run the behavioural arm. It reported `2 passed`. Two
separate reasons, both worth stating:

1. That file does not touch the double at all, so half the mutation was invisible to it.
2. Its seed count AND its expectation both derive from the constant, so moving the constant moves
   them together and the arm stays green. That is the arm working as intended — it follows the cap
   rather than freezing it — but it means the arm cannot detect a change TO the cap, and a green
   run there says nothing about the double.

So the negative was rebuilt rather than recorded. Which exposed the actual gap: **nothing anywhere
asserted that the snapshots DOUBLE clamps to the same number the repo does.** Two arms added to the
parentage contract, which drives both implementations, importing the constants rather than naming
100 — they pin that both sides clamp to the SAME cap, which is precisely what stopped being
guaranteed once each carried its own literal.

```
N1  drop `export` on both constants          the v312 pin              1 failed | 16 passed
N2  inline the literals at the call site     both text pins            2 failed | 15 passed
N3' repo cap 7 AND double back to a literal  both new contract arms    2 failed | 13 passed
N4  double back to a literal, cap UNCHANGED  passes, and should        15 passed
restored (both files 0 dirty, sha equal)                               17 passed / 15 passed
```

N4 is recorded deliberately. Restoring the literal on its own passes, because 100 is what the
constant says today — which is the whole reason the honest negative is the PAIR of edits. A single
edit cannot separate a fixture that reads the constant from one that happens to agree with it.

Page-size class now closed: three pairs, three sets of exported constants, and every arm that
touches a cap derives it. No ratchet change — arms added to existing files, no new file.

## V-1247 — a recovery window written twice, and the arm that should have existed

The page-size class is closed, so the same enumeration was run over the doubles' other named
constants — numeric literals with comments stripped, then each candidate checked against its repo.
Four of the five were unit conversions (`MS_PER_DAY`, `DAY_MS`): a day is a day, and two sides
computing 86,400,000 cannot meaningfully drift. One was a policy value:

```
src/db/scheduled-jobs-repo.ts:97   new Date(opts.now.getTime() - 5 * 60_000)   inlined
_helpers/in-memory-scheduled-jobs  const STALE_LOCK_MS = 5 * 60_000;           its own copy
```

This is the lock-staleness override: how long a held lock may go untouched before another worker
may reclaim the job. It is a RECOVERY window, not a timeout — too short and two workers run the
same job at once, too long and a crashed worker's jobs stall for that long. Written twice, it would
have agreed only until somebody widened one, and widening production would have left every test on
the double asserting the old cadence and agreeing with itself.

Named `SCHEDULED_JOB_STALE_LOCK_MS`, exported, and the double reads it.

**The pins here did not need rewriting, which is worth stating because it is unusual.** Three
guards cover this code — a content-parity SQL chain, a v202d cross-source pin, and the
`drizzle-date-param` structural allow-list — and none quotes the arithmetic. They pin the SQL clause
`AND (locked_by IS NULL OR locked_at < ${lockStaleAtIso})`, the CTE structure, and the set of
interpolated variable NAMES. All three survive untouched because the variable kept its name and the
clause kept its shape. Only a test TITLE described the old expression, and it was corrected: a title
quoting code that no longer exists misleads exactly as a stale comment does.

**Nothing asserted this behaviour on both sides.** The contract had six arms and none touched
locking; the only stale-lock coverage was a Drizzle-only fixture. So the constant could have drifted
with nothing to catch it, which is the same gap V-1246 found for the snapshot cap. Two arms added,
importing the window rather than writing five minutes.

```
N1  repo window 60m AND double back to 5m   the within-window arm    1 failed | 14 passed
N2  repo drops the override (locks forever)  the reclaim arm          1 failed | 14 passed
N3  double stops honouring locks at all      both arms                2 failed | 13 passed
restored (both files 0 dirty, sha equal)                              15 passed
```

N1 is the pair of edits that reintroduces the drift, for the reason recorded in V-1246: a single
edit cannot separate a fixture that reads the constant from one that merely agrees with it today.

Class status: three page-size pairs closed (V-1244, V-1245, V-1246), the billed-status set
(V-1238), the api-key throttle (V-1240), the centi scale (V-1241), and now the stale-lock window.
Every remaining named constant in the doubles is a unit conversion. No ratchet change — arms added
to an existing file.

## V-1248 — a measurement that can tell interference from a defect

V-1245 fixed the `countCreatedSince` flake by anchoring its window past every other fixture's
`now()`, and recorded that `countByStatus` and `countByTier` share the shape with no time parameter
to anchor against. Closing that.

There is no way to scope those two: they count the whole table. But the interference is
DETECTABLE, which is nearly as good. A clean measurement has a known shape — the bucket I seeded
moves by exactly what I seeded, and every other bucket does not move at all. Any other vector means
somebody else wrote inside the window, so the reading is discarded and the arm re-runs on fresh
fixtures, up to five times.

Two side effects worth having:

- The arms got STRONGER, not just steadier. The tier arm used to check two buckets — the seeded
  one and one control. It now asserts the whole eight-tier vector, so an implementation that
  dribbles a count into a third tier is caught rather than ignored.
- A failure now carries the observed delta, which the old `toBe(1)` did not.

**My first version of the failure message was itself the defect this contract exists to catch.** It
said, unconditionally, that a concurrent writer had moved a bucket inside every window. Mutating the
double to miscount — a real, deterministic defect — produced that message, blaming the database for
something the fixture had done. Exactly the misattribution class: a message asserting a cause it
cannot know.

It can know, though, and the attempts contain the evidence. A dirty vector identical across all five
attempts is deterministic, and no concurrent writer reproduces the same interference five times
running; a vector that varies is interference. The helper now reports which:

```
M1  double counts every account under one tier   "the counter is MISCOUNTING"   1 failed | 24 passed
M2  double ignores the status it was asked for   "the counter is MISCOUNTING"   1 failed | 24 passed
M3  double stops zero-filling the tier map       the structural arm             2 failed | 23 passed
restored (0 dirty, sha equal)                                                   25 passed
```

M1 and M2 are the ones that matter here: both are genuine deterministic defects, and both are now
reported as miscounts rather than as a busy database. Verified over four consecutive nine-file runs.

**A process note, because it nearly shipped wrong.** The first attempt to rewrite the helper failed
its own occurrence assert — Prettier had reflowed the block after I wrote it, so the match string
was stale — and the three runs AFTERWARDS were exercising the old helper while appearing to confirm
the new one. The assert caught it; without one, `s.replace(old, new)` silently changing nothing
would have produced three green runs that proved nothing about the code I thought I had written.
Re-done by line number against the reflowed text.

No ratchet change: no new file, `it(` count unchanged at 13.

Still open: `DrizzleAdminAuditLogRepo`'s cursor-anchor lookup is unscoped where
`profile-snapshots-repo.ts` documents why it scopes its own.

## V-1249 — the last unscoped cursor anchor, and an arm that passed until the fixture was reordered

V-1243 mirrored `DrizzleAdminAuditLogRepo`'s unscoped cursor-anchor lookup into the double rather
than correcting it, on the grounds that a fixture is the wrong place to decide production
behaviour, and recorded it as open. Deciding it now.

`profile-snapshots-repo.ts` documents why IT scopes its anchor, and `api-keys-repo.ts` and
`sessions-repo.ts` both do the same conditional scoping. Admin audit was the last one that did not:

```
api-keys-repo.ts        opts.accountId === undefined ? eq(id, cursor) : and(eq(id, cursor), eq(accountId, …))
profile-snapshots-repo  and(eq(id, cursor), eq(accountId, args.accountId))
admin-audit-repo.ts     eq(adminAuditLog.id, filters.cursor)                            <- unscoped
```

`adminAccountId` is optional on this listing, so the fix is the conditional form: scope the anchor
when a filter was given, leave it alone when the caller is listing everything.

**What this is and is not.** Unscoped, a cursor naming another operator's entry resolves to a real
`(timestamp, id)`, so a caller filtering by operator A while holding a cursor from B's listing has
its page silently mis-positioned. It is a CORRECTNESS fix for the caller. The id-exists oracle
argument that applies to snapshots is much weaker here — staff can already list the whole log — and
overclaiming it would be the kind of inflated finding this campaign keeps retracting.

No pin needed rewriting: the guards over this repo freeze the keyset COMPARISON
(`lt(adminAuditLog.timestamp, …)`, `lt(adminAuditLog.id, cursorRow.id)`) and the CTE shape, not the
anchor lookup's WHERE. Enumerated with all three patterns before touching anything.

**The arm I wrote to prove it passed both mutations.** First version stamped the foreign entry LAST.
The page is timestamp DESC and the keyset selects rows strictly OLDER than the anchor — so a
foreign entry at the newest position excludes nothing, both implementations returned all three of
my entries, and reverting the scoping changed nothing. The arm asserted a true thing that could not
fail.

Fixed by stamping the foreign entry in the MIDDLE of mine. An unscoped anchor then resolves to it
and drops every entry of mine newer than it — two rows returned where three are owed.

```
N1' DRIZZLE anchor back to unscoped   "a foreign cursor moved this operator's page"  1 failed | 12 passed
N2' DOUBLE anchorSet back to unscoped  same arm, in-memory half                      1 failed | 12 passed
restored (both files 0 dirty, sha equal)                                             13 passed
```

Third time this session a mutation has come back green and been the actual finding — V-1237's inert
de-indent, V-1246's fully-derived arm, and now a fixture ordered so the defect could not show. The
pattern is the same each time: the arm asserted something true, and the mutation was the only thing
that could reveal it was not asserting the thing that mattered.

Cursor-anchor scoping is now consistent across every repo that pages. No ratchet change.

## V-1250 — a double that was STRICTER than production, and a token that can never validate

With ordering, truncation, cursors and constants all swept, the next enumerable parity class is
what the doubles THROW. Scanning every double for `throw new` with comments stripped gave five
sites. Three are fixture-internal invariant guards — "a profile with a wrapped DEK requires a
preallocated id" and similar — which model nothing and are fine. One (`NotFoundError` in the
incidents double) matches its repo. One did not:

```
Drizzle  rotateUnsubscribeTokenHash   UPDATE … WHERE id = $1     no rows matched, nothing thrown
double   rotateUnsubscribeTokenHash   throw new Error('… not found')
```

**Stricter is still wrong.** A double that throws where production waves the caller through fails
loudly in tests for a reason production cannot produce, and that is harder to notice than the lax
direction: nobody investigates a test that fails "correctly". Nothing depended on the throw —
checked both ways before changing it — so the double now no-ops silently, and two arms pin the pair:
a rotate on a real row replaces the hash, and a rotate on an unknown id resolves quietly.

```
N1  double throws again on a missing row     "did not resolve quietly"   1 failed | 14 passed
N2  double stops writing the hash            the replace arm             1 failed | 14 passed
N3  DRIZZLE writes the wrong hash            the replace arm             1 failed | 14 passed
restored (both files 0 dirty, sha equal)                                 15 passed
```

N2 and N3 are the pair that stops the no-op arm being satisfied by a rotate that never writes
anything at all.

**FLAGGED, not fixed — a product call I am not making unilaterally.** The reason the mismatch was
worth chasing is what sits behind it. `StatusSubscribersService.rotateUnsubscribeToken` generates a
plaintext, calls the repo, and returns the plaintext **regardless of whether any row matched**. The
fan-out embeds that token in the unsubscribe link of one outgoing email. So if the subscriber row
disappeared between `listConfirmed()` and the rotate, the platform emails a working-looking
unsubscribe link whose token matches nothing in the database.

Severity is genuinely low and worth stating honestly rather than inflating: the window is a race
between two calls, and if the row is gone the bigger problem is that the fan-out is emailing a
deleted subscriber at all. But the shape is the one this campaign keeps finding — a write that
silently matches nothing, and a caller that cannot tell.

The fix is a design choice with more than one defensible answer: have the repo report whether it
matched and let the service skip that recipient, or accept the dead link as the cheaper failure.
Changing it means changing what a fan-out does mid-batch, which is beyond a parity sweep and is not
mine to decide alone. Recorded here with the mechanism spelled out so whoever picks it up does not
have to re-derive it.

Class status: five throw-sites enumerated, one divergence, one flagged design question. No ratchet
change — arms added to an existing file.

## V-1251 — a fixture that could reach into a row the caller was already holding

Next enumerable parity class: doubles that hand back the OBJECT they store rather than a copy.
Scanning for in-place property assignment on a stored row, comments stripped, gave three:
`status-subscribers` (13 sites), `team-members` (10), `oauth-links` (1). All three also return
those objects from their reads.

> Counts corrected by V-1252: the pattern used here required the assignment to start the line, so
> it missed `if (row) row.lastLoginAt = at;` and similar. The SET of three doubles was right; two of
> the three tallies were low. Re-run figures are in that entry.

**Proved before fixing.** A throwaway probe against the status-subscribers double: read a
subscriber, unsubscribe them, then re-read the value captured BEFORE the unsubscribe. It had
changed. Postgres cannot do that — a SELECT is a point-in-time copy and a later UPDATE does not
reach into a result the caller already holds.

**The damage is not a crash, it is a vacuous test.** Any before/after comparison against such a
double reads "nothing changed" whatever the code under test did, because `before` and `after` are
the same object. That arm then passes forever and asserts nothing. It is the same failure this
campaign keeps catching by mutation, reached from the fixture side instead — and this session has
written a number of before/after arms.

Every read on the interface now returns a shallow snapshot. Shallow is the right depth and
deliberately so: the columns are scalars and Dates, nothing mutates a Date in place, and a deep
clone would imply a guarantee the repo does not make either.

```
N1  getById hands back the stored object again   "mutated underneath it"        1 failed | 16 passed
N2  markUnsubscribed stops writing               "the arm above proves nothing"  3 failed | 14 passed
restored (0 dirty, sha equal)                                                    17 passed
```

N2 exists because the snapshot arm on its own is satisfied by a write that never lands: if nothing
ever changes, `before` is trivially unchanged. The arm carries its own second half asserting the
write DID land, and N2 is what proves that half is load-bearing.

**My first cut over-applied the rule and two tests went red for it.** I snapshotted `getAll()` as
well. That method is not on `StatusSubscribersRepo` — it models nothing in production — and the
tombstone tests use it to ARRANGE state (`getAll()[0]!.unsubscribedAt = …`). Copies sent those
writes into a throwaway object, the store never changed, and `processPurge` found no candidates.
Caught by running the 44 consumers rather than by the contract, and attributed by reverting the
double to HEAD and watching the red disappear — it was mine, not a peer's.

The rule belongs to the INTERFACE, which is what production must agree with. `getAll` is a hatch
into the fixture's own state and is allowed to behave like one; it now says so in a comment
explaining exactly why it is the exception, so the next person does not "fix" it back.

**Still owed on this class, enumerated not forgotten:** `team-members` and `oauth-links` alias the
same way. Same fix, same shape, larger diff for team-members; recorded as queued rather than swept.
(Site counts here were low — see the correction above and the figures in V-1252.)

## V-1252 — the oauth-links half, and a count I had to correct twice

Second of the three aliasing doubles. `InMemoryOAuthLinksRepo` mutates stored rows in place
(`row.lastLoginAt`, `row.lastRevokedAt`, `row.consumedAt`) and returned those objects from four
read paths. Every interface read now returns a shallow snapshot, same as V-1251.

```
N1  listForAccount hands back stored rows again   "mutated underneath it"       1 failed | 12 passed
N2  markLoginAt stops writing                     "proves nothing"              1 failed | 12 passed
restored (0 dirty, sha equal)                                                   13 passed
```

N2 again guards the half of the arm that would otherwise be satisfied by a repo that never changes
anything: if no write ever lands, the held row is trivially unchanged and the snapshot assertion
means nothing.

**MY ENUMERATION WAS WRONG, IN BOTH DIRECTIONS, AND THAT IS THE ENTRY.** V-1251 reported the class
as three doubles with 13, 10 and 1 in-place mutation sites. The pattern behind those numbers
required the assignment to begin the line, so it never saw `if (row) row.lastLoginAt = at;` —
oauth-links has three sites, not one, and team-members eleven, not ten. V-1251 has been corrected
in place with a pointer here.

Re-running with a looser pattern then produced the opposite error: it reported a FOURTH double,
`probes`. Reading it, the two hits are `cur.lastProbeAt` and `cur.lastFailureAt` on a local
aggregate object built inside `countByTargetSince` — not a stored row, no aliasing, a false
positive. Had I trusted the second count the way I trusted the first, this entry would have claimed
a defect in a double that does not have one.

So the corrected set is the same three doubles, with different tallies:

```
status-subscribers   13 sites   fixed in V-1251
oauth-links           3 sites   fixed here
team-members         11 sites   still owed
probes                0 sites   false positive — local aggregate, not a stored row
```

The lesson is one this campaign keeps re-learning from a new angle: a grep is a hypothesis, and the
count it returns is worth exactly as much as the reading that follows it. V-1241 said "enumerate the
set, never report the size". This is the sharper version — enumerate the set, then OPEN each member,
because a pattern tight enough to avoid false positives is tight enough to miss real ones, and a
pattern loose enough to catch them all invents some.

Still owed: `team-members`, 11 sites.

## V-1253 — the aliasing class closed

Third and last of the three doubles that handed back their own stored objects. `TeamMembersRepo`'s
double mutates rows in place across eleven sites — invite fields, membership fields, the
`acceptedAt` stamp — and returned those objects from six interface reads. All six now return a
shallow snapshot.

```
N1  listPendingInvites hands back stored rows   "mutated underneath it"   1 failed | 10 passed
N2  markInviteAccepted stops writing            "proves nothing"          1 failed | 10 passed
restored (0 dirty, sha equal)                                             11 passed
```

`getAllInvites` and `getAllMembers` are deliberately left aliasing, and now say so at the
definition rather than only in this log. They are not on `TeamMembersRepo`, so they model nothing
in production, and fixtures use them to ARRANGE state as well as to assert — snapshotting them is
what turned two unrelated tombstone tests red in V-1251. The rule belongs to the interface; these
are hatches into the fixture's own state, and the comment says why so the next person does not
"fix" them back.

Class closed:

```
status-subscribers   13 in-place sites   6 reads snapshotted   V-1251
oauth-links           3                  4                     V-1252
team-members         11                  6                     V-1253
probes                0                  —                     false positive (V-1252)
```

> Premature — corrected by V-1255. The three were the ones an in-place-mutation scan surfaced, but
> the observable defect lives on the READ side, and scanning there found a fourth double this table
> does not list. "Closed" was a claim about my enumeration, not about the code.

Every one of the three carries a contract arm with the same two halves: the row a caller holds does
not change, AND the write it was holding it across actually landed. The second half is not
decoration — without it the first is satisfied by a repo that never changes anything, which is
precisely the vacuity this class produces in the first place.

## V-1254 — every guard that reports a line number was reporting the wrong one

Setting out to write an aliasing guard, the detector prototype needed comment stripping, and
checking it against the file it flagged showed the reported line did not contain the finding.
Chasing that instead.

**The shipped cursor guard was misreporting locations.** V-1243's `stripComments` deleted block
comments outright — newlines and all — so the output had fewer lines than the input and every hit
below a block comment was named at a line that did not contain it. Measured, not assumed: the same
planted regression that guard reported at `in-memory-profile-snapshots-repo.ts:60` last commit is
actually on line 71. An eleven-line drift, exactly the height of the header above it. A guard's
`file:line` is the only part of its output anybody acts on, and it was sending them to innocent code.

**The shared scanner had the same defect, and I had not looked.** `tests/unit/_helpers/code-only.ts`
already exists for precisely this job, and its header explains at length why the obvious two-`replace`
one-liner is wrong: the block pass runs first and cannot tell that the `/*` in `// … /v1/agent-sessions/*`
is inside a LINE comment, and string and regex literals have to be modelled too. My guard shipped
that exact rejected one-liner as a private copy. But `codeOnly` swallowed newlines in block comments
as well, so pointing at it would have fixed the wrong-code problem and kept the wrong-line one.

Both are fixed at the one place that matters: `codeOnly` now emits the newline when it consumes one
inside a block comment. Nothing else about its output changes — the characters are still gone. Line
comments already emitted theirs; this was the missing half. The cursor guard drops its private
regex and calls the shared scanner, so it stops carrying a worse duplicate of something the
repository had already thought carefully about.

```
N1  revert the newline emit          line-fidelity arms, BOTH files   2 failed |  8 passed
N2  guard scans raw source           the comments-are-not-code arm    2 failed |  2 passed
verified: planted regression now reported at 71, which is where it is
restored (0 dirty, sha equal)                                         10 passed
```

All eight `codeOnly` consumers re-run: 134 tests, green. The change can only add newlines to a
string these guards search with `includes` and regexes, and its own test asserts both directions
over every server source file.

**The pattern, again, one layer up.** V-1252 said a grep is a hypothesis and the count is worth what
the reading that follows is. This is the same mistake in the tool rather than the query: I wrote a
scanner, believed its output, and only caught it because a prototype for an unrelated guard happened
to print a line I could check. The prototype was not even the work — it was the thing that made the
error visible.

The aliasing guard this started as is still owed.

## V-1255 — the guard found a fourth double the hand sweep had missed

The aliasing class was declared closed in V-1253 on three hand-fixed doubles. Writing the guard for
it — the thing that stops a fourth being written — found a fourth that already existed.

**Why the hand sweep missed it.** I enumerated by scanning for in-place mutation of a stored row,
which is only half the defect. Aliasing is observable through the READ, so the read side is where
the scan belongs. `InMemoryIncidentsRepo.get` returned the stored row, and resolve/reopen/update
mutate incidents in place — the same defect, invisible to a mutation-shaped query because I had
already stopped looking once three files matched.

The guard scans reads: a bare `return row;` where `row` came off `this.<store>.find(…)`, a
`return this.<store>;`, an array-spread `return [...this.rows];`, and filter/sort chains that do not
end in a `.map(`. `getAll`-style methods are exempt BY NAME with the reason recorded, because they
are absent from the production interfaces and fixtures arrange state through them — snapshotting one
is what turned two tombstone tests red in V-1251.

**The array-spread case was a detector gap I nearly recorded as a stale exemption.** The guard
flagged my `admin-audit::getAll` seam entry as naming nothing, and the tempting read was that I had
invented the entry. The method exists; it returns `[...this.rows]`, which copies the ARRAY and hands
back the very same row objects — the same defect, one shape further out, and the detector did not
model it. Extending it also surfaced `sessions::getEvents`, verified as a genuine seam: not on
`SessionRepo`, and session events are append-only, so nothing can change underneath a caller.

```
N1  reintroduce the aliasing read in incidents   named it at line 177, which is where it is
N2  blank the LIVE_SEAMS list                    the seam-staleness arm         1 failed | 4 passed
restored (both files 0 dirty, sha equal)                                        5 passed
```

N1's line number is worth stating: 177, and the read is on 177. That is V-1254's fix showing up
where it matters — a guard that names the wrong line sends whoever acts on it to innocent code.

The guard carries the three arms this campaign now treats as mandatory: a positive control (the
signature still matches a synthetic aliasing read), a negative control (a snapshotting read is NOT
flagged, so the fix is distinguishable from the defect), and a comments-are-not-code arm that also
asserts the reported line survives stripping.

**The shape of the mistake.** V-1252 said a grep is a hypothesis. This is the next layer: the
hypothesis can be well-formed, correctly executed, and still aimed at the wrong side of the defect.
Three doubles matched a mutation-shaped query and I read that as the population. Ratchets 2996 →
2997, 3163 → 3164.

## V-1256 — three guards were scanning an empty string and reporting nothing wrong

V-1254 repointed the cursor guard at the shared comment scanner and stopped there. The private
stripper it had been carrying was not the only copy.

**Verified, not assumed, and my first two enumerations were both wrong.** A grep for the block-comment
regex returned ten guards — but one of them, `every-env-var-the-server-reads-is-documented`, matched
in PROSE: its comment explains at length that it deliberately does NOT strip comments, because a
naive strip once swallowed fourteen real reads in `bootstrap.ts`. Re-running with the comment lines
excluded then returned nothing at all, because adding `-E` to that grep changed the escaping dialect
and the pattern stopped matching. Only the third attempt, run against a known-true control, gave the
real answer: nine private strippers, one prose mention.

**The damage, measured on real files.** The private pass runs block comments FIRST, so it cannot tell
that the `/*` in `// AI-D — /v1/agent-sessions/* routes` is inside a line comment. It opens a comment
there and closes it at the next `*/`:

```
routes/agent-sessions.ts     imports: 61 in source   0 after the private strip   61 after codeOnly
lib/internal-fleet-auth.ts   imports:  3             0                            3
```

Eighteen files under `apps/server/src` carry that shape, nearly all route paths with a wildcard.
Three of the nine guards walk directories containing them: the routes-response guard, the
admin-audit-reachability guard, and the bootstrap-wiring guard. All three were reading an empty
string for those files and reporting nothing wrong — a guard that passes because it saw nothing.

Repointed at `codeOnly`, which models line comments, string literals and regex literals, and keeps
line numbers.

**Stripping ORDER is what decides this, and two of the nine get it right by accident.**
`no-ts-vocabulary-outgrows-its-database-enum` and `schema-enums-match-their-migration-history` strip
LINE comments first, which removes the whole `// … /* …` line before the block pass runs. They are
not exposed to this failure. Recorded because it is the difference between a correct guard and a
lucky one, and the luck is one refactor deep.

```
N1  restore the private block-first stripper   "scanning nothing": +0 where 61   1 failed | 3 passed
N2  stripper becomes a pass-through            the prose-is-not-code arms        1 failed | 3 passed
restored (0 dirty, sha equal)                                                     4 passed
```

N1 is the arm worth keeping: it asserts the stripper still sees into the specific file that breaks
it, rather than asserting the stripper is a particular implementation. A plain revert of the three
repointings would NOT have failed anything — the blindness is latent, nothing those guards check
currently lives in the blanked files — so proving the change is load-bearing needed an arm about the
blindness itself.

**Still owed, enumerated:** three more block-first TS strippers —
`the-built-api-types-agrees-with-its-source`, `the-egress-claim-gate-has-one-definition`,
`a-field-count-in-a-test-title-is-derived`. Same fix. `migrations-destructive-statements-are-declared`
strips SQL rather than TypeScript and `codeOnly` does not apply to it.

## V-1257 — the last three private strippers, and one whose stripping turns out to be inert

Closes the set enumerated in V-1256. `the-built-api-types-agrees-with-its-source`,
`the-egress-claim-gate-has-one-definition` and `a-field-count-in-a-test-title-is-derived` all
carried block-first private strippers; all three now call `codeOnly`.

The egress guard is the interesting repoint. Its private version defended the `//` in `https://`
with a negative lookbehind, `(?<!:)\/\/[^\n]*` — a workaround for not modelling string literals at
all. `codeOnly` tracks quotes, so a URL inside a string survives because it is inside a string,
not because of a lookbehind that happens to spare it. The workaround was correct for the case it
was written for and silent about every other one.

```
N1  egress guard: stripping becomes a pass-through        1 failed | 3 passed
N2  field-count guard: pass-through                       1 failed | 4 passed
N3  built-api-types guard: pass-through                   4 PASSED
restored (all files 0 dirty, sha equal)                   13 passed
```

**N3 passed, and it is reported rather than quietly dropped.** Removing comment stripping entirely
from the built-api-types guard changes none of its four arms. Its stripping is inert today: it
compares a source file against its built output, and whatever comments each carries are removed
from BOTH sides, so taking the removal away changes both sides equally and the comparison lands in
the same place. So this repoint is hygiene — it deletes a wrong implementation rather than fixes a
wrong result — and saying "all three proven" would have been false.

That distinction matters because it is the one this session keeps mishandling in the other
direction. A green mutation has meant, at various points: an inert mutation (V-1237), an arm that
could not fail (V-1249), a fully-derived expectation (V-1246), and now a call site where the
transformation genuinely does not affect the outcome. They look identical in the log line and are
four different facts. The only way to tell them apart is to go and read why.

Private-stripper set now closed:

```
a-published-response-is-the-one-returned        repointed   V-1256   (was blanking route files)
every-declared-admin-audit-action-is-reachable  repointed   V-1256
bootstrap-unwired-optional-deps-are-declared    repointed   V-1256
the-egress-claim-gate-has-one-definition        repointed   V-1257
a-field-count-in-a-test-title-is-derived        repointed   V-1257   (only 1 of 3 sites — see V-1258)
the-built-api-types-agrees-with-its-source      repointed   V-1257   (stripping inert)
no-ts-vocabulary-outgrows-its-database-enum     line-first, not exposed
schema-enums-match-their-migration-history      line-first, not exposed
migrations-destructive-statements-are-declared  strips SQL; codeOnly does not apply
every-env-var-the-server-reads-is-documented    deliberately does not strip — prose match only
```

## V-1258 — the guard caught my own half-finished fix on its first run

Two things here: the last two private strippers centralised, and the guard that stops the class
coming back. The guard is the point, and what it found on its first run is the reason it exists.

**It flagged `a-field-count-in-a-test-title-is-derived` — which V-1257 reports as repointed.** That
file has THREE hand-rolled strip sites, not one. The V-1257 edit matched on a string that included
the following line, which made it unique to the first site and silently left the other two. The
occurrence assert passed, because one occurrence is exactly what it asserted; the assert was
guarding against matching the wrong thing, not against matching too few. V-1257's table is corrected
in place.

That is the whole argument for guarding a class rather than sweeping it. My sweep was careful — it
enumerated, it verified against source, it mutation-proved — and it still finished two-thirds of one
file. The guard found that in its first second of running.

**The staleness arm also caught an exemption I added out of caution rather than evidence.**
`code-only.ts` was on the allow-list on the assumption that the shared scanner must itself contain
the pattern. It does not: it is a hand-written character scanner, and the only place the regex
appears is its own header, which the scan strips. Entry removed, and its absence is now explained at
the list, since "why isn't the scanner exempt?" is the obvious question.

**The last two strippers, repointed as hygiene rather than as a fix.**
`no-ts-vocabulary-outgrows-its-database-enum` and `schema-enums-match-their-migration-history` strip
LINE comments first, which dodges V-1256's trap. They have their own hole — `//` is stripped inside
string literals too, so a URL in a scanned file would be truncated mid-token — and I checked before
claiming: `schema.ts` contains no URL in a string, and enum counts are identical under both
strippers. Latent, not live. Called hygiene here for the same reason V-1257 called the
built-api-types repoint hygiene.

```
N1  reintroduce a hand-rolled stripper   named it at line 123, which is where it is
N2  guard scans raw source               prose arm + main arm      2 failed | 2 passed
restored (both files 0 dirty, sha equal)                            4 passed / 9 passed
```

N2 is the arm that matters most. Twice while enumerating this class by grep I matched the regex
inside PROSE, once flagging a guard whose comment explains it deliberately does NOT strip — the
opposite of an offender. A guard for "do not hand-roll this" that could not tell code from a comment
about code would re-make that mistake on every run, so it scans with `codeOnly` itself.

Class closed: nine private strippers, seven repointed, two exempt by language (SQL) with the reason
recorded. Ratchets 2997 → 2998, 3164 → 3165.

## V-1259 — one more restated page number, found by re-running the enumeration the guards cannot

The three guards written this session all pass, so the cursor, aliasing and hand-rolled-stripper
classes are provably swept — a guard is the only thing that can say that about a class. The
restated-constant class has no guard, so it was re-enumerated by hand instead.

Three of the four remaining numeric literals in the doubles are unit conversions already cleared
(`24 * 60 * 60 * 1000`, seconds-to-milliseconds). The fourth was real:

```
src/db/incidents-repo.ts:79                  const limit = opts.limit ?? 100;
_helpers/in-memory-incidents-repo.ts:122     const limit = opts.limit ?? 100;
```

Named `INCIDENT_PAGE_DEFAULT`, exported, and the double imports it. Unlike the three pairs in
V-1244 to V-1246 this is a DEFAULT with no `Math.min` beside it: it decides what an unparameterised
listing returns, and nothing bounds what a caller may ask for. Worth saying because "page size"
covered two different things in this class and only one of them is a cap.

No pin needed rewriting — enumerated all three ways first. The two incidents guards mention the
default only in prose describing the method, and prose is not a frozen occurrence.

```
N1  repo default 7 AND double back to 100    "does not match the repo default"  1 failed | 12 passed
N2  double back to 100, default UNCHANGED    passes, and should                 13 passed
restored (both files 0 dirty, sha equal)                                        13 passed
```

N2 is recorded for the reason established in V-1246: restoring the literal on its own passes,
because 100 is what the constant says today. A single edit cannot separate a fixture that reads the
constant from one that merely agrees with it, so the honest negative is the pair.

**What made this findable.** Re-running an enumeration after the guards were in place is cheap, and
the guards narrow what still needs hand-checking to exactly the unguarded classes. That is the
argument for writing them beyond preventing regressions: they turn "have I swept this?" from a
question about my memory into a question a test answers.

## V-1260 — the last unguarded class gets its guard, and the guard's own first arm was vacuous

The restated-constant class has been fixed by hand six times — V-1238, V-1240, V-1241, the three
page-size pairs, V-1247 and V-1259 — and each time the entry ended by noting the shape would recur.
It now has a guard, which makes every class this campaign has swept answerable by a test rather than
by my memory of having looked.

The rule is exact because the fix is exact. Centralising a value leaves the literal in the repo and
an import in the double, so a policy number present in BOTH files is the defect and a number in one
is the fix. Verified against the five pairs already repaired: every one of them now carries its
number in the repo alone.

```
auth-repo             30_000   repo:1  double:0
rate-limit-overrides     100   repo:1  double:0
admin-accounts           100   repo:1  double:0
incidents                100   repo:1  double:0
scheduled-jobs        60_000   repo:1  double:0
```

**What it does not model, said in the guard itself rather than only here.** It sees NUMBERS. V-1238
was a set of STRINGS — `['active', 'trialing']` in the repo, restated as two `===` comparisons in
the double — and this guard walks straight past it. Strings are shared between a repo and its double
constantly and legitimately, so a string rule would be noise. Five of six historical instances
covered; the sixth is named at the top of the file so a green run is not read as more than it is.

**Its own first arm could not fail.** The arm meant to show that a number in one file only is not
flagged compared two `Set`s built inside the test and never called the real function. It passed, as
it would have against any implementation whatsoever. Caught by reading it back rather than by any
tool. The comparison is now extracted to work over source strings, and the arm drives it twice: once
with the number in both files (must flag), once with the double importing instead (must not).

```
N1  restate a policy number in a double     "incidents-repo.ts  restates 100"   1 failed | 4 passed
N2  guard scans raw source                  the prose arm                       1 failed | 4 passed
N3  blank SHARED_UNITS                      the MAIN arm — see below            1 failed | 4 passed
N4  add a bogus exemption                   the staleness arm                   1 failed | 4 passed
restored (0 dirty, sha equal)                                                   5 passed
```

**N3 was mislabelled when I ran it.** I recorded it as proving the staleness arm; it reds the main
arm, because an empty exemption list makes the three unit conversions look like restatements. The
staleness arm needs the opposite mutation — an entry naming a pair that carries nothing — which is
N4. Both arms are proven, but only after checking WHICH arm went red rather than counting that one
did. A failure count is not an attribution.

Guarded classes now: positional cursors (V-1243), aliasing reads (V-1255), hand-rolled comment
stripping (V-1258), restated policy numbers (here). Ratchets 2998 → 2999, 3165 → 3166.

## V-1261 — running all thirty contracts together found a flake in the one that guards against flakes

With every class guarded, the next thing worth verifying was the campaign's own central claim: that
each contract really does drive BOTH implementations. Running all thirty together confirms it —
thirty reachability arms, a hundred and eighty Drizzle describe blocks, 394 tests — and turned up a
failure that does not appear when the files run alone.

`countByStatus counts only the status asked for` failed about one run in five. That is V-1248's own
arm, the one written to make an unscopeable counter measurable.

**Its attribution logic was right, which is how the cause was found.** The message read: deltas
VARIED between attempts, so another writer landed inside every measurement window — not
MISCOUNTING. The helper correctly distinguished interference from a defect under real interference,
which is the property V-1248 built it for and could only test synthetically at the time.

**The cause is the column defaults.** `accounts.status` defaults to `'active'` and `accounts.tier`
to `'free'`, and nearly every fixture in the suite inserts `(id, email)` and takes them. Under a
thirty-file run those two buckets move inside essentially every window, so five attempts is not
enough and never would be — requiring them to sit still is requiring the rest of the suite to stop
working.

So `cleanDelta` gained an `ignore` set, and the two arms leave exactly those two buckets
unconstrained. Everything else stays constrained, which is what preserves the property:

```
M1  countByStatus ignores its filter        caught — `deleted` still constrained   MISCOUNTING
M2  countByTier files everything as 'free'  caught — agency_manual never moves     MISCOUNTING
```

M2 is the one worth reading twice. It hides the miscount in the bucket the arm no longer watches,
and the arm still catches it — because the seeded tier failing to move is itself the signal. The
ignore list removes a constraint, not the assertion.

Eight consecutive thirty-file runs clean, from roughly one failure in five.

**A typing detail that cost a compile.** `ignore: ReadonlySet<K>` drove the inference of `K` and
narrowed it to whatever the ignore set contained, so `expected` then rejected its own keys. Typed on
`string` it stops participating in inference. Worth a line because the error pointed at the
`expected` literal, several lines from the parameter that caused it.

**On the general shape.** This is the third time a measurement of mine has been correct alone and
wrong in company — V-1245's negative delta, V-1248's retry, and now the retry's own ceiling. Each
was found by running more things together than the test was designed against. Running the thirty
contracts as a set is cheap and is now something to repeat, not a one-off.

## V-1262 — the string half of the restated-constant class, and a snapshot taken at the wrong moment

V-1260's guard covers restated NUMBERS and says in its own header that it walks past restated
STRINGS, naming V-1238 as the instance it would have missed. Closing that gap by hand, since the
reason the guard does not model strings still holds: a repo and its double share string vocabulary
constantly and legitimately.

Enumerating string literals that appear in a comparison or an array on both sides of each pair gave
seven candidates. Five are shared VOCABULARY — incident statuses, session result kinds, webhook
delivery states — values both implementations must name because they are enum members, not
decisions restated. Two are the real shape:

```
usage-repo.ts            INTERNAL_RECORD_TYPES = ['agent_decomposer', 'agent_decomposer_bundled']
                         LIFECYCLE_DERIVED_RECORD_TYPE = 'session_minute'
in-memory-usage-repo.ts  its own copy of both
```

Both were module-private, so the double had no way to read them and carried duplicates. Adding a
record type to the internal list would have kept it out of customer aggregates in production while
every test on the double went on counting it. Exported; the double imports both.

```
N1  repo drops a type AND double restates the old set   3 arms   1 failed x3 | 8 passed
N2  double restates the CURRENT set, repo unchanged     passes, and should
restored to the FIXED state (sha equal, exports intact)          11 passed
```

N2 is the pair-of-edits rule from V-1246 again: a single edit cannot separate a fixture that reads
the constant from one that merely agrees with it today.

**I restored a mutation onto a snapshot of the PRE-FIX file and silently undid the whole batch.**
The snapshots were taken at the top of the batch, before the export was added — so `cp snap file`
after the first mutation reverted not just the mutation but the fix. The contract then went green,
because it was green before the fix too, and three arms failed in between for a reason I initially
read as the mutation working.

Caught by grepping for the exported constant afterwards and finding nothing. The rule that already
exists — restore from a scratchpad snapshot, never `git checkout` — is only half of it: the snapshot
has to be of the state you want to return TO, which during a batch is the fixed state, not the state
you started from. Re-applied, snapshotted after the fix, and the restore verified by checking the
export is still present rather than by the sha alone.

That is the second snapshot-shaped loss this session. The first was `git checkout` discarding
uncommitted work (V-1245); this one used the right mechanism at the wrong moment.

**Still open, and not fixed here:** `stripe-webhooks-repo.ts` writes `['active', 'trialing']` inline
twice and its double restates it twice, while V-1238 already exported
`ACTIVE_SUBSCRIPTION_STATUSES` from `admin-billing-repo.ts` — four copies of one policy set across
three files. The fix needs a home decision: importing a constant from one repo module into another
is the low-churn option and reads oddly, and the alternative is a neutral module that does not exist
yet. Recorded rather than guessed at.

## V-1263 — one policy set that lived in four places, and the arm that was missing under it

V-1262 recorded this as needing a home decision rather than guessing at one. Deciding it.

`['active', 'trialing']` — which subscription statuses Stripe actually bills — existed four times
across three files: exported from `admin-billing-repo.ts` (V-1238), written inline TWICE in
`stripe-webhooks-repo.ts`, and restated TWICE in that repo's double.

**The home could not be `admin-billing-repo`.** A Stripe webhook handler reaching into the admin
cockpit's repo for a billing rule makes that module the accidental owner of something it does not
own. The set describes the `subscriptions` table, which both repos read, so it now lives in
`src/db/subscription-status-sets.ts` — a module named for what it holds and owning nothing else.
`admin-billing-repo` re-exports it so the importers V-1238 created keep resolving unchanged, which
kept the pin surface at zero.

**Both first mutations passed, and the second one was the finding.** Adding `past_due` to the shared
set changes nothing in the admin-billing contract, because that contract derives its billed and
unbilled cases FROM the constant — the V-1246 shape, working as intended. But making the stripe
double restate a wrong set also changed nothing, and that is not by design: **nothing anywhere
exercised the billed-status filter on the stripe pair.** Its contract's Subject is a narrow façade
that never exposed the two methods that apply it.

So the Subject grew a subscription seeder and `setAccountTierToBestActive`, and the arm is the
concrete workflow: a customer paying for `solo_manual` with a CANCELED `team_manual` subscription
must not be raised to the higher tier.

```
N2' double restates a wrong billed set    "a canceled subscription decided the tier"  1 failed | 14 passed
N3  DRIZZLE stops filtering by status     same arm, production side                   1 failed | 14 passed
restored (both files 0 dirty, sha equal)                                              15 passed
```

Four copies became one, and the behaviour under it is now asserted on both implementations rather
than on neither.

**A flake found while verifying, and attributed before investigating.** Running the 34 consumers
together, `admin-billing-active-tier-repo-contract` failed about one run in four with
`expected +0 to be 1`. `git status` says that file is untouched by this batch: its arms are plain
before/after deltas on `countActiveSubscriptionsByTier`, which is unfiltered and table-wide — the
same class as V-1248 and V-1261, and pre-existing since V-1238. It is the next thing to fix, not a
consequence of this one.

## V-1264 — fixing one racy measurement made its neighbours racier

The flake V-1263 recorded: `admin-billing-active-tier-repo-contract` failing about one run in four
under a 34-file run, `expected +0 to be 1`. Its arms measured `countActiveSubscriptionsByTier` — a
counter that takes no filter and counts the whole `subscriptions` table — with a plain before/after
delta, the same shape fixed twice already for accounts.

`cleanDelta` moved out of the admin-accounts contract into `_helpers/counter-delta.ts`. A second
contract needing it is the moment to give it one home rather than a second copy, which is the rule
this campaign has been applying to production constants all session.

**Ten arms, not two.** The two obvious deltas were the attribution and accumulation arms. The
`it.each` billed and unbilled arms — eight more — carried the identical shape on `api_scale`, and
converting the first two and stopping would have been the one-of-N mistake the stripper guard caught
me on earlier. `leftover plain deltas: 0` is checked, not assumed.

**And the fix made a neighbour worse.** After converting, the set still failed once in twelve —
but in a DIFFERENT file, `db-admin-billing-repo-drizzle`, which `git status` confirms I never
touched. That test asserts no other tier moved while it seeds, and already exempted `api_scale`
with a comment naming the concurrent writer that forced it. Now `api_starter` moved too.

The cause is my own fix. `cleanDelta` RETRIES on an interfered reading, so an arm that seeded three
subscriptions once may now seed them up to five times. The retry that makes one measurement robust
raises the write volume every other measurement of the same table has to survive. Extended that
file's exemption with exactly that reason recorded at the line, rather than absorbing it silently.

```
before: ~1 failure in 4 runs (34-file set)
after converting the ten arms: 1 in 12, in a different file
after extending the exemption: 0 in 12
```

**What this says about the class.** Three contracts now measure unfiltered table-wide counters, and
the interference between them is not incidental — it is the direct consequence of many tests sharing
one database and one accounts/subscriptions table. Each fix so far has been local: anchor the
window (V-1245), detect and retry (V-1248), stop constraining the default buckets (V-1261), and now
share the helper and pay for the extra writes. That is four local fixes to one structural fact, and
the honest reading is that the structure is the thing — a counter with no filter cannot be measured
cleanly by concurrent tests, and every technique here is a way of tolerating that rather than
removing it.

## V-1265 — the full suite caught what my consumer sweep did not

The full run after V-1263 was RED: `every-drizzle-repo-is-driven-against-a-real-postgres` failed
with `neither a repo class nor listed as having none`. The new
`src/db/subscription-status-sets.ts` holds a constant and no repo class, and that guard requires
every `db/*.ts` to be one or the other.

**My consumer enumeration was keyed on the wrong thing.** Before committing V-1263 I ran every test
mentioning `stripe-webhooks`, `admin-billing`, `ACTIVE_SUBSCRIPTION_STATUSES` or the new module —
34 files, all green. But this guard mentions none of those. It scans the DIRECTORY. Adding a FILE
to `src/db/` has consumers that no symbol-based grep can find, because what they consume is the
directory listing.

That is a new shape of the enumeration mistake this campaign keeps making. Previous ones were about
the pattern being wrong (V-1252), the query dialect changing under me (V-1256), or scanning the
wrong side of the defect (V-1255). This one had a correct query aimed at the right side — it simply
cannot see a consumer that never names what it consumes.

The rule that follows: **adding or removing a file under a scanned directory is itself a change with
consumers.** For `src/db/**` those are the guards that enumerate it, and the only reliable way to
find them is the full suite — which is exactly what found it.

Listed with the reason, and the reason is the interesting part: the module exists BECAUSE it has no
repo. Two repos and two doubles needed one policy value, and giving it to either repo would have
made that module its accidental owner (V-1263). A file with no persistence class is what that
decision looks like on disk.

```
N1  remove the exemption entry   the classification arm   1 failed | 2 passed
restored (0 dirty, sha equal)                             3 passed
```

Nothing about V-1263's substance changes — the four copies are still one, and the arm underneath is
still there. What changed is that the tree was red between two commits, and it was red because I
verified a change against the consumers I could name.

## V-1266 — a storage scale restated between two production modules, which no guard could see

V-1260's guard compares a double against ITS OWN repo. That shape cannot see a value restated
between two production modules, and enumerating repos that do arithmetic on a column value turned
one up:

```
rate-limit-overrides-repo.ts   REFILL_CENTI_SCALE = 100, used in three places   (V-1241)
auth-repo.ts                   r.refillPerSecondCenti / 100                     hardcoded
```

Both read the same `rate_limit_overrides` rows. V-1241 named and centralised the scale in the repo
that owns that table and stopped there, because the double was the thing being fixed — and the
second production reader was never in that frame.

**This one is a production risk rather than a fixture one.** `auth-repo.findActiveRateLimitOverrides`
is the read that feeds actual rate limiting. Moving the scale to 1000 in the owning repo would have
left the auth path dividing by 100 and reporting every override ten times too permissive, while the
owning repo and its double agreed with each other perfectly. Exported from the owner; `auth-repo`
imports it.

No new module this time, and deliberately: unlike V-1263's subscription set, this value has a clear
owner — the repo for the table whose column it encodes — so importing from it does not make anything
an accidental owner. That also avoids adding a file under `src/db/`, which is what reddened the tree
last commit.

Three occurrences updated in this commit: the two auth pins that quoted `/ 100` and a header comment
that described it.

```
N1  auth-repo back to a hardcoded 100        both auth pins       2 failed | 24 passed
N2  drop the export                          tsc exit 2, TS2459   "does not export REFILL_CENTI_SCALE"
N3  scale 1000 AND auth-repo keeps its 100   both auth pins       2 failed | 47 passed
restored (both files 0 dirty, sha equal)                          43 passed
```

**What protects this is a text pin and the type system, not a behavioural arm — worth stating.** The
in-memory auth double never sees centis: it stores overrides already de-scaled, so no contract
exercises the auth-side divide. N2 is the strongest of the three precisely because it is not a text
match — removing the export fails compilation, so the two modules cannot silently drift apart
without `tsc` saying so. N3 reds the pins rather than an assertion about behaviour, and the
rate-limit contract stays green throughout because it derives from the constant, which is the
V-1246 shape doing what it should.

Also checked, and clean: the other three repos doing arithmetic on a column (`termDays * 24`,
`cadenceSeconds * 1000`) are unit conversions, not policy — a day has 24 hours regardless of who
writes it down.

## V-1267 — a guard prototyped, measured, and deliberately not built

V-1266 found a policy value restated between two PRODUCTION modules, which V-1260's guard cannot
see: it compares a double to its own repo. The obvious extension is to flag any `src/db` module
carrying a literal equal to another module's exported constant. Prototyped before writing it, which
is the only reason it did not get built.

```
exported numeric policy constants in src/db:  11
other db files carrying one of those literals in arithmetic or a comparison:  34 hits
```

Every one is noise, and not the kind that tuning fixes. Every page constant in this codebase is 50
or 100, so `ADMIN_ACCOUNTS_PAGE_MAX`, `SNAPSHOT_PAGE_MAX`, `MAX_PAGE`, `INCIDENT_PAGE_DEFAULT` and
`REFILL_CENTI_SCALE` all collide with each other by value.

**And flagging them would have been actively wrong.** V-1244 through V-1246 decided DELIBERATELY
that the customer profile page, the staff account browser and the snapshot list are separate product
limits that happen to coincide — one shared constant would mean raising one silently raised the
others. A guard on equal values would flag exactly those four pairs and push toward the coupling
those entries refused on purpose. It would be a guard arguing against its own campaign.

What made V-1266 a real finding is not that two modules share the number 100. It is that both read
the SAME TABLE COLUMN, so its storage encoding is one fact with two readers. That is not expressible
as "same literal", and no amount of threshold-fiddling turns one into the other.

The reasoning now sits in the guard file rather than only here, because "why doesn't this compare
repos to each other?" is the obvious question and the answer belongs where it is asked. The repo
reached the same conclusion once before: V-908 tried scoring matchers to find weak assertions and
abandoned it because a matcher census cannot tell a precondition from a weak assertion. A signal
that cannot tell two things apart is not a weaker guard, it is a wrong one.

**Also checked and clean.** `recipes-repo.ts` names its own `DEFAULT_RECIPE_PAGE` / `MAX_RECIPE_PAGE`
and appeared in the prototype's hits. It has no in-memory double at all, so there is no pair to
drift and nothing to fix — module-private is correct there.

No code changed beyond the comment. The finding is that the next obvious step is a mistake, which is
worth a log entry precisely because it looks like work that should be done.

## V-1268 — measuring the doubles' dead surface, and being wrong four times on the way

The parity classes are swept and four are guarded, so the question worth asking is not "what else
diverges" but "what could diverge with nothing to notice". A double method that no test, no other
double and no production path ever calls is exactly that.

**Result: 4 of 260 double methods have no caller anywhere.** The fixtures this campaign has been
correcting all session are, on this measure, essentially fully exercised. That is a positive
verification rather than a to-do list, and it is worth recording as one.

**Getting to that number took four corrections, each a different mechanism.**

```
1st run   11 dead   corpus excluded _helpers — but doubles call each other
                    (in-memory-rate-limit-overrides calls authRepo.clearRateLimitOverride)
2nd run    8 dead   corpus excluded production — most repo methods are reached through a
                    service, never named in test source at all
3rd run    5 dead   a "reference" was a COMMENT: the web-session contract says in prose that
                    `upsertWebSession` has zero callers, which my grep counted as a caller
4th run    4 dead   `activateMfaEnrollmentSession` was an INTERFACE member declared inside the
                    double's own file, which my `^  method(` extractor read as a class method.
                    It is called, through the MfaSessionAuthority collaborator.
```

Four instruments, four different ways of being wrong, and each intermediate number looked like an
answer. This is V-1252's lesson at a third remove: a grep is a hypothesis, a count is worth what
the reading behind it is worth, and the tool that produces the count needs the same scrutiny as the
claim.

**Only ONE of the four was safe to delete.** `setMinter` writes a map that `insertApiKey` already
populates on the real path, so removing it changes nothing. Removed.

The other three are the sole writers of state that live code reads:

```
seedMintedApiKey   only writer of `mintedApiKeys`, read by removeMemberWithInvites
upsertWebSession   only writer of `webSessionsByTokenHash`, read by three fallback paths
revokeWebSessionById  reads that same map
```

Deleting those would not remove dead code. It would leave live methods whose bodies can never do
anything — which compiles, passes, and reads as working. Demonstrated rather than argued: removing
`seedMintedApiKey` leaves `tsc` at 0 and the team-members contract green at 11 passed. Nothing goes
red; the code just quietly stops being able to return anything.

So they are annotated at their definitions with why they are kept, because "this has no callers,
delete it" is the obvious next move and it is wrong here. The annotation is the durable part — the
next person to measure dead surface finds the answer at the seam rather than repeating the four
runs above.

## V-1269 — the delivery worker's crash recovery existed in production and not in the fixture

Last entry measured the doubles' dead surface. The mirror question is which PRODUCTION repo methods
have no parity assertion at all, and answering it needed the denominator fixed first: 123/330 across
every repo is meaningless, because a repo with no double has nothing to be in parity with. Over the
27 PAIRED repos it is 106/223, and every one of them has some coverage.

That number is not a defect — each contract in this campaign took one coherent property cluster per
pair, by design. But it locates the thin ice, and `webhooks-repo` at 2/28 was the thinnest.

**The divergence, verified in source before writing anything.**

```
Drizzle  claim  selects pending-and-due  OR  in_flight whose updated_at is older than
                RECLAIM_STALE_IN_FLIGHT_MS (5 min) — a crashed worker's rows are re-claimed
double   claim  selects `status === 'pending'` only
```

A worker that dies mid-batch leaves rows `in_flight` forever. Production re-claims them; the double
never did. So a crash-recovery test written against this fixture would have asserted the opposite of
what production does — and the fixture is where such a test would naturally be written, because the
real path needs Postgres.

Fixed by giving the double the same reclaim, reading the window from the repo rather than restating
five minutes.

```
N1  double back to pending-only            "it is stuck forever"                  1 failed | 4 passed
N2  reclaim with NO lease window           "displaced the worker holding it"      1 failed | 4 passed
N3  drop the export                        tsc exit 2, TS2459 in two files
restored (both files 0 dirty, sha equal)                                          5 passed
```

N2 is the half that keeps N1 honest: reclaiming everything would satisfy "stuck deliveries get
picked up" while stealing rows from workers that are alive and working on them.

**What I did NOT change, and why.** The Drizzle claim also caps deliveries per endpoint at 5 so one
endpoint's backlog cannot monopolise a batch. The double has no such cap — but `perEndpointCap` is
not on the `WebhooksRepo` interface, production callers never pass it, `webhook-claim-fairness-parity`
already guards the two PRODUCTION claim implementations, and `db-webhook-delivery-fair-claim` proves
the property against real Postgres. A fixture omitting a parameter its interface does not declare is
defensible; adding it would be inventing surface. Recorded rather than silently done.

**And the arm is honest about what it is.** It exercises the double only. The Drizzle side of the
same property is covered by `db-durable-webhook-claim-reclaim-drizzle` against real Postgres, so the
two halves are asserted in different files rather than by one shared contract — building a
both-implementations Subject here means a delivery fixture with secret decryption, signing and HTTP.
The arm says so at its own site instead of implying a contract that does not exist.

## V-1270 — the MFA compare-and-swap token had its rule written six times

Continuing down the coverage list from V-1269, `mfa-repo` was next thinnest at 2/10. The
security-critical methods there are the single-use and compare-and-swap paths, so those were read
first. `markRecoveryCodeUsed` matches its Drizzle sibling exactly. `replaceRecoveryCodesIfCurrent`
matches structurally — and restates the rule it swaps on:

```
mfa-repo.ts               function nextRevision(now, previous) = max(now, previous + 1)
                          module-private, called in THREE places
in-memory-mfa-repo.ts     the same expression written inline in FIVE places
```

`updated_at` is the CAS token for MFA credentials: every conditional update matches on it, so the
rule for advancing it decides whether a stale snapshot can collide with a fresh one. Widening the
step here — to avoid millisecond collisions, say — would have left the double minting different
tokens while every MFA test standing on it agreed with itself. Exported; the double calls it in all
five places.

**The arm passed its own mutation twice before it discriminated.**

First version: the CAS returned false on BOTH halves, which looked like a defect and was a fixture
error — `enrolled()` only STARTS enrolment, so `enrolledAt` is null and the swap correctly refuses.
Completing enrolment first is what puts the row in the state the CAS is written for.

Second version: the Drizzle half still refused, because `completeEnrollmentIfPending` re-reads the
account's auth epoch under lock and demands an unrevoked, unexpired web session at that epoch. The
Subject grew a live-session seeder — a real row for the Drizzle half, an id for the double, which
has no such check unless a session authority is wired.

Third version passed, and its mutation passed too. `at` was five seconds ahead of `previous`, so
`max(now, previous + step)` is `now` whatever the step is, and the arm could not see the rule at
all. **Advancing when the clock has NOT is the entire property** — two writes inside one millisecond
must still mint distinct tokens. Pinning `at` to the previous revision is what made +1 versus +1000
visible.

```
N1  repo step +1000ms AND double restates +1   "the two sides mint different tokens"  1 failed | 12 passed
N2  drop the export                            tsc exit 2, TS2459
restored (both files 0 dirty, sha equal)                                              13 passed
```

That is the third arm this campaign has written which asserted something true and could not fail —
V-1249's foreign cursor stamped last, V-1260's two locally-built Sets, and now a clock set far
enough ahead that the rule under test never applied. The pattern is the same each time: the fixture
was arranged so the mechanism had no opportunity to matter, and only the mutation said so.

Contracts re-run as a set three times, 398 passed each — the concentrated-interference check from
V-1261, now that this contract seeds `web_sessions` as well.

## V-1271 — one arm of a two-arm guard, described as if it were the whole guard

`sessions-repo` was next on the coverage list at 5/19. Two of its uncovered methods turned out
clean on inspection, and saying so matters as much as the finding:

- `claimSessionOperation` — the double sets `busy` unconditionally where the repo's UPDATE also
  requires `status = 'ready'`. Equivalent, because the enum is
  `creating | ready | busy | destroyed | errored` and the branches above have already returned for
  four of the five. Checked against the enum rather than assumed.
- `insertSessionIfUnderLimit`'s cap — both count `accountId AND destroyed_at IS NULL`. Identical.

**The profile guard is not.** `DrizzleSessionsRepo` refuses a bind on EITHER a live legacy session
holding the profile OR a live row in `agent_sessions` with that profile and status not `closed`.
The double models the first arm only — it has no agent-session state — and its comment described
the guard as though that were all of it.

So the double UNDER-REFUSES: a bind production rejects because an agent session holds the profile
succeeds here. And `profile-in-use-guard.test.ts` has two describes, one per side, each testing its
OWN guard — neither crosses, so nothing made the gap visible.

**Not modelled, deliberately, and the reasoning is the decision.** The two routes to modelling it
are adding a lookup to `InMemoryAgentSessionsRepo` — which lives in PRODUCTION source, so that
means growing production surface to feed a fixture — or throwing without the live session's id,
which the error carries and callers assert on. Either buys the cross-arm at the price of a new
divergence. The real arm is proven against Postgres in `db-profile-in-use-concurrency-drizzle`.

**What changed instead: the gap is asserted rather than described.** A comment saying "this
under-refuses" is read once. An arm that binds a profile held by a live agent session and asserts
the double ALLOWS it is checked on every run — and its message says that if it ever fails, the
double has learned to gate and the arm should be deleted.

```
N1  teach the double to gate on agent sessions   the gap arm fires: "delete this arm"  2 failed | 11 passed
N2  remove the legacy arm entirely               the driver-side refusal arm            1 failed | 12 passed
restored (0 dirty, sha equal)                                                           13 passed
```

N1 is an unusual negative: it proves the arm fails when the code gets BETTER. That is the point of
a gap arm — it is a tripwire on a known limitation, not an assertion that the limitation is
correct, and it has to be written so that closing the gap is what breaks it.

Three fixture corrections were needed on the way, none of them findings: `createIfUnderActiveCap`
takes `tokenBudgetTotal`, not the `archetype`/`cap` shape I first guessed, and copying the call from
the arms already in the file was faster than reading the type twice.

## V-1272 — the aliasing guard could not see the shape three doubles actually used

Working down the coverage list to `auth-repo` (3/10), `findActiveRateLimitOverrides` turned out
clean — both sides filter `expiresAt > now` strictly, and the de-scale reads the shared constant
since V-1266. But the double returns its rows through a shape the V-1255 aliasing guard cannot see:

```
const out: Row[] = [];
for (const r of this.rows.values()) { if (…) out.push(r); }
return Promise.resolve(out);
```

The detector matched `return row;`, `return this.rows;`, `return [...this.rows];` and filter/sort
chains. None of those. Three interface reads — `email-preferences.list`,
`mfa.listUnusedRecoveryCodes`, `auth-flows.listActiveWebSessionsForAccount` — sat outside the rule
the guard states, and the guard reported clean the whole time.

**Nothing was broken by it, and that is worth separating from the fix.** None of the three mutates
its rows in place, so the aliasing was not observable. But "not currently observable" is a weaker
property than "reads hand back snapshots", and the guard claims the second. All three now copy, and
the detector was widened rather than the finding written off.

**My enumeration produced five candidates; two were false.** `admin-billing.upsertSubscription`
pushes an INPUT into the store — a write, not a read. `scheduled-jobs.claimDue` pushes into an
internal working array and returns freshly-built projections. Reading each is what separated them;
the regex could not.

**And the widened detector did not work on its first two attempts.** The accumulate branch was
correct and never fired, because every one of these doubles returns `Promise.resolve(out)` rather
than `return out;` — and the bare-return regex the branch fed into only matched the second form.
Its own mutation is what said so: reverting a snapshot went unnoticed, which is the same "green
mutation is the finding" pattern this campaign keeps hitting, this time inside a guard I was in the
middle of extending.

```
N1' revert one snapshot           named: email-preferences-repo.ts::list (line 29)   1 failed | 4 passed
N2' drop the accumulate branch    the same revert goes UNNOTICED                     5 passed
restored (both files 0 dirty, sha equal)                                             5 passed
```

N2' is the arm that makes N1' mean something: it shows the new branch is what sees the revert,
rather than some pre-existing branch catching it incidentally.

All four class guards green together: cursors, aliasing, comment strippers, restated numbers.

## V-1273 — the full suite went red on the counter class, in a fifth file

The run after V-1272 failed: `db-webhooks-dlq-keyset-paging-drizzle`, with
`expected 21 to be 20`. `countDlqDeliveries` takes no filter — it counts the whole table — and the
arm measured it with a bare before/after delta, so another file dead-lettering a delivery inside the
window moves it by two.

**Attributed before investigating.** The file is committed, not dirty, and nothing this turn goes
near webhooks; `git log` shows it from an earlier arc of this campaign. It passes alone (8/8) and
passes three times with its eight DLQ neighbours — the interference comes from further out than any
neighbourhood run reaches, which is why only the full suite sees it.

Converted to `cleanDelta`, the shared detect-and-retry from V-1264. That is the fifth file in this
class: admin-accounts (V-1245, V-1248), admin-billing (V-1264), the drizzle sibling it perturbed
(V-1264), and now this.

```
N1  seed TWO dlq rows instead of one   "the counter is MISCOUNTING"   deterministic, all 5 attempts
N2  countDlqDeliveries returns 0       "the counter is MISCOUNTING"   deterministic
restored (both files 0 dirty, sha equal)                              8 passed
```

Both negatives report MISCOUNTING rather than interference, which is the V-1248 attribution logic
doing its job: a wrong delta identical across all five attempts is not something a concurrent writer
reproduces.

**Two process notes.** A `python` replace aborted on its occurrence assert mid-edit, so nothing was
written and the file stayed in its previous state — the assert did exactly what it is for, and the
retry was done by line number against the reflowed text. And `tsc` rejected the first conversion:
`repo` is module-scope and nullable, and the `if (!repo) return` guard narrows it in the arm body
but NOT inside the callbacks `cleanDelta` takes. Binding the narrowed value once is the fix, and it
is worth a line because the error pointed inside the callback while the cause was the signature of
the thing receiving it.

**The pattern is now unambiguous.** Five files, one shape: a counter with no filter, measured by
difference, in a suite where many files write the same table. Each was found by a different route —
a nine-file run, a thirty-file contract run, a thirty-four-file consumer run, and twice by the full
suite. The class does not have a natural boundary at which "I have found them all" can be asserted,
which is the argument for the helper being shared rather than the fixes being local.

---

## V-1274 — the aliasing class had a shape the guard could not see, and it was in a repaired file

The obvious next move after V-1273 was a sixth guard, for the unfiltered-counter class. It was
prototyped and measured before being written, and it is **not buildable at acceptable precision**.
The signature "a bare before/after delta on an unfiltered count" returns three hits and only one
kind is a defect: `admin-accounts-list-repo-contract` takes an exact delta but dates its fixtures
into the far future so the window excludes every other file's rows, and `db-admin-accounts-repo-
drizzle` asserts `>=` and says why in its own title — _a delta around a seed, because the table is
shared with every other db-_ file running concurrently\*. Three legitimate mitigations — anchor the
window, tolerate with `>=`, detect-and-retry — and the signature cannot tell which is in force. The
reasoning now lives at the top of `counter-delta.ts`, where the question next arises. Same verdict,
same reason, as the repo-to-repo constant guard rejected in V-1267.

So the turn went to the coverage list instead, and `profiles-repo` produced a better finding by a
side door. Its `insertWithLimit` returns `Promise.resolve({ record: row })` — the row it has just
stored. The V-1255 guard reads bare returns, whole collections, spreads, filter/sort chains and
V-1272's accumulators. **A row that leaves inside an object was none of those.**

Widening the detector and re-running it over all 29 doubles found four:

```
in-memory-incidents-repo.ts::createWithInitialUpdate   incident: row
in-memory-incidents-repo.ts::resolve                   { incident, update }
in-memory-incidents-repo.ts::reopen                    { incident, update }
in-memory-profiles-repo.ts::insertWithLimit            { record: row }
```

**Three of them are live defects, and they are in a file that already carries the fix.**
`in-memory-incidents-repo.ts` has had a `snapIncident` helper since V-1251 and applies it on every
bare read — while `resolve` and `reopen` bind the stored incident, mutate it in place, and hand that
object straight back. A caller holding the result of a create watched its status turn `resolved`
underneath it when somebody else resolved the incident. Postgres cannot do that; `INSERT..RETURNING`
is a point-in-time copy. This is the "FIX 3" story again exactly — the repair applied to the reads
of a file and not to the three methods that return through a wrapper.

The fourth is not currently observable. `in-memory-profiles-repo` is copy-on-write throughout: every
write builds `{ ...r }` and stores the new object, so a held row never changes. That is a **weaker
property than the rule**, and it holds only until someone adds a write that mutates in place — which
is precisely what the incidents double is. Fixed alongside the other three.

**The detector was wrong twice on the way, and both are the point.** Judging the line a return opens
on rather than the whole statement reported the _repaired_ `listAll` in the status-subscribers double
as a defect: it begins `return [...this.rows]` and maps every row through `snap` four lines later —
the guard accusing the fix. And the first widening missed `return { incidents: this.incidents }`,
because the name arrives after a dot; the staleness arm caught that immediately by reporting my own
brand-new `LIVE_SEAMS` entry as an exemption nothing needed. Both halves are now asserted: a
multi-line chain that snapshots is not flagged, and the same chain with the `.map` removed is.

Mutation proofs, restored byte-identical from a scratchpad snapshot of the fixed state:

```
M1  drop snapIncident from resolve+reopen   guard  RED, names both methods and lines
M2  same, against the behavioural arm       17 passed — PROVED NOTHING
M3  drop snapIncident from create           in-memory RED "changed status underneath it"
                                            drizzle GREEN
M4  drop snapIncident from resolve          in-memory RED "the row resolve() returned changed
                                            status underneath the caller", drizzle GREEN
```

**M2 is the one worth reading.** The first behavioural arm holds a row from
`createWithInitialUpdate` and resolves it — so reverting `resolve` cannot reach it, and a full green
run said the arm was fine when it simply was not looking there. Three methods carried the defect and
one arm reaches one of them; the second arm exists because proving one leaves the other two asserted
by nothing. That arm needed a real admin account and key on the Drizzle side — `reopen` is
admin-only and types its poster ids non-null, where `resolve` is nullable for V-295b auto-resolve,
and both columns carry an FK — so `Subject` grew an `admin()` seam per implementation.

`tsc` caught the null ids; `vitest` had passed them happily, which is the standing lesson that a
green suite is not a typecheck.

Suites: guard 7 passed; incident contract 17 passed both halves; the eight `insertWithLimit`
consumers 117 passed; neighbours 50 passed. No test files added, so the `EXPECTED_TEST_FILES`
ratchets are untouched.

---

## V-1274b — the profiles double could reach a state Postgres cannot: a retired profile with no successor

Two divergences in `in-memory-profiles-repo`, both from the same cause and both **proven on both
sides against a real database** rather than read off the source.

Production validates a wrapped DEK inside `preallocatedProfileId(input)`, which is evaluated where
the row is BUILT — inside `.values({...})`, after the cap count and, in `transferAtomic`, after the
source has been retired. The double hoisted that check to the top of `insertWithLimit`. Same rule,
different position, and position is the whole finding.

```
A  at-cap + wrappedDek with no preallocated id
     production   {"limitExceeded":true,"current":1}
     double       THREW a profile with a wrapped DEK requires a preallocated id

B  transferAtomic whose insert is malformed
     production   threw / sourceLive=true      (one transaction; the retire rolls back)
     double       threw / sourceLive=false     (retired, no successor)
```

**B is the one that matters.** The double retired the source with a plain `set` and then delegated,
so a failed insert left the account holding a soft-deleted profile and nothing in its place. Postgres
cannot produce that, and a fixture that can teaches every test standing on it that losing the
original is an acceptable outcome of a failed transfer. The double now captures the row before
retiring and puts it back if the insert throws — a model of the rollback rather than a bet that
nothing downstream can fail. A is smaller but the same species: one request, two different refusals,
so a service test can agree with the fixture and disagree with the database.

Contract arms on `profile-trash-cap-repo-contract`, both halves, each mutation-proven:

```
M5  hoist the validation back above the cap check   in-memory RED, drizzle GREEN
M6  drop the rollback from transferAtomic           in-memory RED "the source profile was
                                                    retired by a transfer that failed",
                                                    drizzle GREEN
```

**Both mutations silently failed to apply on the first attempt, and the suite went green.** M5's
`python` assert aborted (`validation block x2` — `insert()` carries the identical check, so the
anchor was not unique) and M6's `perl -0777 -pe 's/\Q…\E/'` never matched, because `\Q` quotes the
`\n` escapes into literal backslash-n. Nothing was mutated, and both runs reported 15 passed — a
green that says only that the file was never edited. The fix is procedural and now standing: **print
a marker proving the mutation landed BEFORE running the suite**, never after. The M6 line
`rollback lines remaining = 0 (expect 0)` is that marker; the first attempt printed `1` and I ran
vitest anyway.

Verified clean on the way past, recorded because a negative result is a result:
`sumSizeBytesByAccount` sums LIVE rows only on both sides, and the hoarding hole that opens (trash a
large profile to free reported quota) was closed on 2026-06-30 by re-checking the quota on `restore`
— so the "live bytes ≤ cap" invariant holds at every instant and the asymmetry with the profile
COUNT cap, which deliberately includes trashed rows, is coherent rather than an oversight.
`transferAtomic`'s cap ordering, its source-claim predicate and `preallocatedProfileId` itself agree
between the two.

Suites: 11 files, 154 passed, `tsc` clean.

---

## V-1275 — bounding the two classes V-1274b opened, both negative

A torn write in a double is worth generalising, so both mechanisms behind it were swept.

**Transactional production method, multi-write double, no rollback.** Thirty-one production repo
methods run inside `db.transaction(...)` and have a paired double. Nine of those doubles perform
more than one mutating write with no restore path:

```
api-keys::rotateApiKeyAtomic  incidents::createWithInitialUpdate  mfa::deleteForAccount
mfa::replaceRecoveryCodesIfCurrent  platform-secrets::upsert  team-members::removeMemberWithInvites
webhooks::recordDelivered  webhooks::recordDlq  webhooks::recordRetry
```

**None is a defect.** A missing rollback only matters if something between the first and last write
can fail, and in all nine every refusal — not-found, revoked, expired, wrong account — is decided
before the first write, after which only map assignments remain. `rotateApiKeyAtomic`, the widest at
three writes, was read by hand to check the instrument rather than trusting it. So the class is
bounded at one: `transferAtomic` was singular in DELEGATING to a method that throws, and the two
doubles that already model a rollback (`transferAtomic` now, `destroySessionSerialized` since
earlier) are the whole population. A guard on "multi-write without rollback" would flag nine correct
implementations, which is the V-1267 rejection again.

**Throwing helper evaluated inside a query builder.** The mechanism that made position matter is
that `preallocatedProfileId` is called from inside `.values({...})`, so its throw happens after the
count rather than before it. Eight throwing module-level helpers exist across seven files in
`src/db`; exactly one is called from inside a query-builder argument, and all three of its call
sites are in `profiles-repo`. Two are the methods V-1274b repaired. The third is plain `insert()`,
which goes straight to the insert with no earlier return path — so the double validating up front is
observationally identical there, and it is left alone.

Two sweeps, two negatives, and the reason each is a negative is recorded so the next pass does not
re-derive it. The measurement instrument was wrong once on the way and the wrongness is the usual
one: a non-greedy body regex stopped at the closing brace of a multi-line ARGUMENT object rather
than the method body, under-reporting write counts across the board. Extracting the body by
"the first line that is exactly two spaces and a brace" fixed it, and the corrected sweep found
three multi-write doubles the first run had scored as zero.

---

## V-1274c — the webhooks double kept a counter production deleted, and the worker's comments agreed with the double

Two divergences in `in-memory-webhooks-repo`, both in the three delivery-outcome writers, and the
second one had spread beyond the fixture.

**D1 — `recordRetry` advanced `consecutiveFailures`; production stopped doing that on purpose.**
That counter is the customer-facing signal: the docs say an endpoint "is auto-disabled after 50
consecutive failed deliveries" and tell customers to watch it. A retry is an ATTEMPT within one
delivery, and MAX_ATTEMPTS is 6, so counting retries billed a single failed delivery up to six
times — an endpoint tombstoned after roughly NINE failed deliveries instead of fifty, permanently,
about 6x sooner than the headroom the customer was promised. The Drizzle repo carries a long comment
explaining exactly this. The double still incremented.

**D2 — none of the three fenced on `in_flight`.** Production matches
`and(eq(id), eq(status, 'in_flight'))` and no-ops on zero rows, because the worker only writes for a
row it claimed. The double honoured any write for any row, so a >5-minute-stalled worker's late
report — the case the production comment says the fence exists for — resurrected a delivered
delivery into the DLQ and pushed its endpoint toward an auto-disable it never earned.

**The blast radius is what makes this more than a fixture fix.** The worker's own header said
_"recordDlq (if attempts == MAX). Both bump endpoint.consecutiveFailures"_, its retry-path comment
justified the auto-disable check by _"recordRetry bumps endpoint.consecutiveFailures by 1"_, and
`maybeAutoDisable`'s docblock claimed _"recordRetry/recordDlq have already committed their +1"_.
All three describe the pre-fix model. Two content-parity tests PIN that header text, so the stale
sentence was frozen in place by tests whose job is to keep it accurate. The repo was fixed and
nothing else was — the double, three comments and two pins all still agreed with each other.

Six arms in `webhook-worker.test.ts` seeded the counter by calling `recordRetry` in a loop on one
delivery, which only counts on the double. **Arm #6 asserted a scenario production cannot reach** —
"a RETRY that crosses the 50-consecutive-failure threshold auto-disables the endpoint" — and it is
now inverted to assert the invariant instead: an endpoint at 49 survives a retry. Seeding is a real
failed delivery per failure (enqueue → claim → DLQ), and the arms that arrange a nearly-exhausted
delivery claim it first, because an unclaimed write is a no-op in production.

The worker CODE needed no change. `maybeAutoDisable` re-reads the live counter, so it is correct
under either model; the retry-path call is now defensive rather than load-bearing, and says so.

```
M7  restore the increment on the retry path   3 arms RED, incl. "the retry advanced the failure
                                              counter — it counts attempts, not failed deliveries"
M8  drop the in_flight fence                  RED "a stale write resurrected a delivered row
                                              into the DLQ"
```

Each mutation printed a marker proving it landed before the suite ran, per V-1274b.

**A gap left open, stated rather than papered over.** The fence is now asserted on BOTH sides —
a new arm in `db-webhooks-repo-consecutive-failures-drizzle` and its mirror in `webhook-worker` —
but they are two arms in two files, not one contract parameterised over both implementations. The
trio still has no shared contract, which is exactly the structure that would have caught D1 the day
the repo was fixed. `webhooks-repo` remains the widest coverage gap on the V-1269 list.

Suites: 11 files, 176 passed, `tsc` clean.

---

## V-1276 — the contract that would have caught V-1274c on the day the repo was fixed

V-1274c closed by naming what was still missing: the three delivery-outcome writers were asserted on
both sides, but as separate arms in separate files. That is the structure that let the divergence
live. The counter semantics sat in a Drizzle-only integration test; the fence and the worker
behaviour sat in unit arms driving the double. **Neither could see the other**, so when the Drizzle
repo stopped counting retries as failed deliveries, every arm stayed green: the Drizzle test asserted
the new behaviour, the double kept the old one, and both were right about themselves.

`webhook-delivery-outcome-repo-contract.test.ts` runs SEVEN arms against both implementations:

```
the arrangement really yields an in_flight delivery on a zeroed endpoint
a RETRY does not advance consecutive_failures
a DLQ advances it exactly once
a lifecycle of five retries then a DLQ counts as ONE failed delivery
a SUCCESS zeroes it
a late write from a stalled worker is a no-op once the row is finalised
a write for a delivery nobody claimed is a no-op
```

The first is there because every other arm is about what happens to a CLAIMED row: an arrangement
that quietly produced a pending one would make the two fence arms pass by describing the wrong
situation, and the counter arms would be measuring a no-op. It asserts the setup, not the subject.

**The arrangement is a subject seam rather than `claim()`, and the reason is the shared table.** Both
invariants need an in_flight delivery, and claiming is the obvious way to get one. That is safe on
the double, whose state is process-local, but `DrizzleWebhooksRepo.claim` takes due rows from the
WHOLE `webhook_deliveries` table — it would claim and then finalise rows belonging to every other
file running concurrently. So each subject arranges its own in_flight row (the double claims, Drizzle
inserts straight to `in_flight`) and only the BEHAVIOUR under test crosses the shared interface.
Everything the arms read — `findEndpointById`, `findDeliveryById` — is on `WebhooksRepo`, so no arm
reaches around the interface to raw SQL.

Mutation-proven by re-introducing the two defects V-1274c fixed, which is the only proof that
matters for a contract written after the fact:

```
M9   restore the increment on the retry path   3 in-memory arms RED (retry, lifecycle,
                                               unclaimed), drizzle GREEN
M10  drop the in_flight fence                  2 in-memory arms RED (stale write, unclaimed),
                                               drizzle GREEN
```

Both mutations printed a marker proving they landed before the suite ran.

**Four pinned numbers moved, each measured rather than incremented.** `EXPECTED_TEST_FILES`
2999 → 3000, `EXPECTED_TEST_FILES_ALL` 3166 → 3167, the prose "129 test files gate on DATABASE_URL"
→ 130, and "this repo uses 171 of them" → 172. The 129 looked stale at first: the exact
`skipIf(!process.env.CI && !process.env.DATABASE_URL)` string appears in only 128 files at HEAD. It
is not stale — one file writes the same gate through local aliases as `skipIf(!CI && !DATABASE_URL)`,
and counting every form gives exactly 129. Incrementing on the first grep would have written a wrong
number into a gate whose whole job is to be exact.

Full suite: 3167 files, 31279 passed | 16 skipped — the collected count matching the raised ratchet
rather than merely exceeding it.

---

## V-1277 — a documented disagreement was pinned on one side only, and I re-derived the finding the long way

Working down the coverage list to `stripe-webhooks-repo` (6 of 13 methods untouched by any contract),
`findAccountIdFromCustomerOrRef` looked like a live defect: it compares Stripe's arbitrary
`client_reference_id` against `accounts.id`, which is `uuid`. Probed against the real database, it
raises `22P02 / string_to_uuid`, while the in-memory double compares two strings in a Map and
returns null.

**All of which is already written down**, in `db-stripe-webhook-attribution-drizzle.test.ts`, in more
detail than I would have put it — including the arm that pins the SQLSTATE rather than the message,
the note that all five call sites pass null so the branch is unreachable, and an instruction for
whoever adds validation later. The correct move was to grep prior art BEFORE probing, not after. It
cost a probe cycle and produced no new finding; recording it because the near-miss is the useful
part. It also nearly produced a WRONG finding: the first framing in my head was "a Stripe webhook
500s", and that is false today — every caller passes null, which is exactly the distinction that
file spends a paragraph making.

**What was genuinely missing is the shape V-1276 is about.** The file states that the double "quietly
returns null" where Postgres throws, and pins the Postgres half. Nothing pinned the double's half.
That sentence was prose: someone teaching the double to throw — a reasonable thing to attempt in the
name of fidelity — would have broken the agreement the file describes without failing anything, and
the description would have gone quietly wrong while continuing to be read as true.

A documented DISAGREEMENT needs both halves pinned for the same reason an agreement does. Two arms
added, ungated because they need no database (every existing arm early-returns without one, so a
local run proved nothing about attribution at all):

```
M11  teach the double to throw on a non-uuid   the divergence arm RED
M12  drop the customer-id predicate            the live-branch arm RED, "resolved an unknown
                                               stripe customer to somebody"
```

The live-branch arm exists so the pair is comparable: a fixture that disagreed about the branch
production actually runs would make the pinned disagreement look like the only one.

**Verified clean in passing**, against source rather than assumed: `setAccountTier` matches its
double including the missing-account case; `downgradeAccountTierToBestRemaining` mirrors the
best-remaining-subscription ordering and the crypto-entitlement floor, and its `BILLED_STATUSES` is
an alias for the constant exported in V-1263 rather than a fourth restatement of `['active',
'trialing']`; `revokeCryptoEntitlementByOrderId` revokes by pulling `expiresAt` forward, so the
`gt(expiresAt, at)` filter in the tier floor already excludes revoked rows and the boundary is
strict on both sides; and `listExpiredUnprocessedCryptoEntitlements` agrees on filter, ordering and
limit.

---

## V-1278 — 79 invariants are asserted on one implementation only, and the first one opened had a real divergence

V-1276 and V-1277 were both the same shape: a behaviour pinned against ONE of two implementations,
which reads like coverage and is not parity. That shape is measurable, so it was measured.

Across the 194 methods that exist on both a Drizzle repo and its double, **79 are exercised by a
`db-*-drizzle` file and by no contract at all.** Ranked:

```
webhooks-repo 14   sessions-repo 11   profiles-repo 8   auth-flows-repo 7
stripe-webhooks-repo 6   auth-repo 6   team-members-repo 5   scheduled-jobs-repo 4   mfa-repo 3
```

This is a sharper instrument than the V-1269 coverage count. "Uncovered" includes methods nobody has
tested at all, which are honestly unknown. These 79 are worse: a Drizzle test exists, so the method
reads as tested, while the double it shares an interface with is free to disagree — and the double is
what the service and route tests actually run against.

**The first one opened had a divergence.** `team-members-repo::acceptInviteAtomic`, taken for being
security-shaped, turned out to diverge on something quieter. `member_email` is NOT a column on
`team_members`: production returns `attachMemberEmail(row, input.memberEmail)`, so the address on the
returned membership is always the one the CALLER presented. The double stored the address at
creation and returned that on the existing-member path, so re-accepting an invite after the member
changed their email handed back the OLD one — on the single path where the caller has just supplied
the current address. Re-inviting an existing member is how a role change is performed, so this is the
ordinary path rather than an edge.

Proven on the double before the fix (`email=old@x.test role=admin` — the role refreshed correctly
while the address did not), and production's side is a single unambiguous return with no column to
read a stale value from.

Two arms added to the existing `team-members-repo-contract`, both mutation-proven:

```
M13  drop the caller-presented email        in-memory RED "carried an address the caller did not
                                            present", drizzle GREEN
M14  drop the token-hash comparison         in-memory RED "an invite was accepted against the
                                            wrong token hash", drizzle GREEN
```

M14's arm covers the compare-and-swap the method exists for: the accept must match the exact
presented credential, so a stale link whose invite was re-issued misses rather than accepting on the
id alone. It was absent from the contract, which is how the one-sided count is 79 rather than 0.

**Verified clean on the way past:** `auth-flows-repo::consumeAuthToken` — the single-use claim that
decides whether a magic link or reset token can be replayed — matches exactly, both returning true
only for the first consume of an unconsumed row.

Suites: 10 files, 117 passed, `tsc` clean.

---

## V-1279 — the active-status set had two homes and a guard holding them together; now it has one

Continuing down the 79 one-sided assertions from V-1278, `sessions-repo` (11) was next.

**Most of it is clean, verified against source rather than assumed.** `failSessionOperation` and
`settleSessionOperation` reproduce all five components of the Drizzle predicate — id, accountId,
driverSessionId, `status = 'busy'`, `destroyedAt IS NULL` — and the double even serialises them
through a mutation lock; `activateSessionReservation` matches its four. The operation lifecycle is
the same fence-on-the-claimed-state shape that diverged in the webhooks trio (V-1274c), and here the
double has it.

`listExpiredForAutoDestroy` and `listActiveByAccount` are where the repo names its active-status set,
and **the double spelled the three literals out again, twice**. This is the V-1238 class, and the
V-1260 guard states in its own header that it only sees NUMBERS — a set of STRINGS walks past it.

**It was already known.** `db-sessions-repo-cross-source-invariant.test.ts` carries an arm (V-1063)
that parses the repo's declaration, parses the double's two hard-coded chains, and asserts the sets
match — and its title says exactly why: _"The constant is not exported, so nothing links them:
adding a status makes the shipped sweeper reap it and leaves every test wired to the double
modelling the old set, silently."_ **That is the second time this turn I have re-derived documented
prior art.** V-1277's lesson was to grep prior art before probing; the sharper version, which I am
writing down because the first phrasing was not enough to change my behaviour, is to grep it when
opening the METHOD, not after comparing the two sources and finding something.

The residual improvement is real, and it is the remedy V-1260 prescribes: _name it, export it from
the repo, import it in the double_. The guard existed BECAUSE the constant was private, holding two
copies together by comparing their text. The constant is now exported and the double imports it at
both sites, so there is one home and adding a status moves the shipped sweeper and every
double-backed test in the same edit.

The arm was rewritten rather than deleted, because the copy can come back. It now asserts the export
survives, the repo still uses it exactly twice, the double imports it and calls it at both mirroring
sites, and no hand-written chain has reappeared — with the chain detector exercised on a control
first, since an arm asserting "zero chains" passes just as happily when its regex has stopped
matching anything.

```
M15  a hand-written chain returns to the double   RED "the double stopped using the constant at
                                                  both of the sites that mirror the repo queries"
M16  the export is taken away                     RED "no longer EXPORTED as an array literal"
```

Both pin-parsers that read this declaration — the arm above and
`every-non-terminal-session-query-agrees`, which derives the TERMINAL set as the enum minus this one
— use unanchored regexes, so `export ` prefixing them changes nothing. Checked before editing rather
than discovered by a red run.

Suites: 138 session-touching files, 1654 passed, `tsc` clean.

---

## V-1280 — the double accepted a key envelope, validated it, and threw it away

Having re-derived documented prior art twice in one turn (V-1277, V-1279), the fix was to put the
prior-art check INTO the instrument rather than into a resolution. The V-1278 list of one-sided
methods was filtered against every source-reading guard in the tree — 1172 `cross-source`,
`content-parity`, `no-*` and `every-*` files — keeping only methods **no guard so much as names**:

```
78 one-sided  →  11 watched by nothing
profiles-repo 3   stripe-webhooks-repo 3   auth-flows-repo 2   scheduled-jobs-repo 2   api-keys-repo 1
```

That is the list worth opening, and the first three items produced one real finding and two clean
verifications.

**`getWrappedDek` in the double was a stub: `(_args) => Promise.resolve(null)`.** Production selects
`profiles.wrapped_dek` under three predicates — the id, the owning account, and not-trashed. The
double accepted a `wrappedDek` on insert, validated that it arrived with a preallocated id, and then
discarded it.

Two consequences, and the second is the one that matters.

`ProfilesService.getProfileDek` returns null the moment this does, so **no double-backed test could
reach `unwrapProfileDek` at all** — which is why `profiles-service.test.ts` monkey-patches
`repo.getWrappedDek` over the fixture to test the unwrap. The workaround was load-bearing.

And the stub's null is **indistinguishable from a tenancy refusal**. An arm asserting "another
account cannot read this profile's key envelope" passes against the double whatever the predicate
does, including nothing at all. The Drizzle-only tenant-scope test asserts it properly; every
double-backed route or service test that thought it was covering the same ground was asserting a
constant.

The double now keeps the envelopes in a map deliberately separate from `ProfileRecord`, mirroring
production's reason for the column being off the customer-facing row, and reads them under the same
three predicates. The read is gated on the live ROW rather than on the envelope map, so a trashed or
purged profile answers null without the map needing a cleanup pass.

Two contract arms, paired so neither can pass by returning a constant — one demands the real value
back, the other demands null for a profile stored without an envelope:

```
M17  restore the stub                  RED "the owner could not read the key envelope it just stored"
M18  drop the owning-account predicate RED "another account read this profile's key envelope"
M19  drop the not-trashed predicate    RED "a trashed profile still hands out its key envelope"
```

Each predicate proven separately, because an arm that only ever sees one of them removed cannot tell
which one it is holding.

**Verified clean on the way past:** `purgeTrashed` and `purgeTrashedBefore` match exactly, including
the strict `<` cutoff boundary and the requirement that the row already be trashed;
`findAccountByCanonicalEmail` matches; and in `sessions-repo`, `failSessionOperation` and
`settleSessionOperation` reproduce all five components of their Drizzle predicate.

Out of scope and named so it is not mistaken for covered: `migrateWrappedDekEnvelopes` re-wraps
legacy envelopes and has no counterpart in the double at all.

Suites: 69 profile-touching files, 938 passed, `tsc` clean.

---

## V-1282 — RETRACTION: the unfiltered-counter class was not bounded at five, and my own fix is what made the sixth site collide

A full-suite run came back with eight failures. Attribution first, per the standing rule: the tree
held only the three foreign files that are never mine to commit, and no peer commit sat on top, so
the red was mine or environmental. All eight pass in isolation. Four of them are neither.

**The retraction.** The V-1274 entry recorded a measurement of the racy-counter class and concluded
it had a known, closed population — five converted sites plus two that were safe by other
mitigations. That conclusion was wrong, and the reason is the instrument, again. The detector looked
for a delta expression naming the baseline local immediately before a comma. Every site it found
spells that `before,`. The four it missed spell it `before[TIER],` — the same expression with an
array subscript between the name and the comma — so the pattern could not match, and a whole file of
exact deltas on `countActiveSubscriptionsByTier` scored as clean. Allowing a subscript finds them
immediately. The population is seven, not five-plus-two.

**And the collision is mine.** `db-admin-billing-repo-drizzle` measures its deltas on
`agency_manual`. V-1264 added an arm to `admin-billing-active-tier-repo-contract` that seeds exactly
that tier — and `cleanDelta` RETRIES on an interfered reading, so it may seed it up to five times in
a run. A latent raciness that had been surviving on luck became a reliable collision the moment the
remedy for a different site started writing the same bucket.

Worse, I was standing in front of it. V-1264 edited this very file to add `continue` exemptions to
its per-tier loop for `api_scale` and `api_starter`, with a comment explaining that the retry made
the deltas noisier. Naming the interference and stepping around it, in the one file where the shared
helper was the answer, is the mistake the entry should record: **an exemption list that grows once
per neighbour is a measurement asking to be replaced, not tuned.**

All four arms now use `cleanDelta`. The per-tier loop with its accumulating `continue`s is gone —
the helper states the whole vector directly, and it distinguishes a MISCOUNT from a concurrent
writer, which the loop could only ever paper over. The unbilled-statuses arm gained strength on the
way: it used to assert one bucket did not move, and now asserts an EMPTY vector, so every
constrained tier must sit still.

```
N1  seed TWO active rows where the vector expects one   "the counter is MISCOUNTING: the same wrong
                                                        delta appeared in all 5 attempts …
                                                        agency_manual: 2 (want 1)"
N2  seed an ACTIVE row inside the unbilled arm          "… agency_manual: 1 (want 0)"
```

Both deterministic across all five attempts, which is the helper correctly saying "this is the
counter, not a neighbour". Restored byte-identical from a snapshot of the FIXED state.

**The other four failures are not resolved, and are recorded as such rather than absorbed.** Two are
customer-dashboard jsdom page tests, a known order-dependent class. One is a docs parity arm. One is
a Stripe contract arm that is account-SCOPED — it creates its own account and reads that account's
tier, so it is immune to the counter race by construction. All four pass in isolation and none
reproduced; the run itself took more than 600 seconds against a normal 250, so load is the visible
difference. No cause is claimed for them here, because none was established.

Suites: the converted file 7 passed, `tsc` clean.

---

## V-1281 — eight aliasing reads wearing a variable name

Reading the last of the eleven unwatched methods from V-1280, `listApiKeysMintedBy` turned out to
match production exactly — and to hand back the rows it stores:

```
const rows = Array.from(this.byId.values()).filter(…).sort(…);
return Promise.resolve(rows);
```

`Array.from` copies the ARRAY, never the row objects inside it, so every element is still the stored
row. This is `return [...this.rows]` — which the V-1255 guard has caught since the day it was
written — wearing a local variable. The guard models bare returns of a bound row, whole collections,
spreads, filter/sort chains, V-1272's accumulators and V-1274's wrapped returns. **A materialised
local was none of them.** Eight interface reads across five doubles sat outside the rule the guard
states, invisible to every branch it had:

```
api-keys::listApiKeysMintedBy   api-keys::listApiKeys        profiles::listTrashed
sessions::listActiveByAccount   webhooks::listEndpoints      webhooks::listEndpointsSubscribedTo
validation-schedules::list      validation-schedules::findDue
```

**None was observable**, and the measurement says why: the same sweep checked whether each of those
five doubles mutates a stored row in place, and none does. That is the V-1274 argument again, and it
is worth repeating because it keeps being the thing that makes a defect look like a non-defect:
"not currently observable" is weaker than the rule, and it holds only until someone adds a write
that mutates in place. The incidents double was exactly such a file, and its aliasing reads had been
sitting harmlessly until they were not.

All eight now map each row through a copy on the way out. The detector gained a branch that
recognises the shape, with the exclusion keyed on whether anything between the materialisation and
the return maps the rows through something — so the fix is not flagged as the defect.

```
M22  drop the copy from listApiKeysMintedBy   RED, naming the file, method and line
```

Both halves asserted in the control arm, per the standing rule that a detector which cannot tell the
fix from the defect is worse than the narrower one it replaced.

**Verified clean on the way past**, completing the eleven: `pruneFinished` (OR of the two terminal
timestamps, strict `<` on both sides), `jobTypesWithPendingWork` (DISTINCT over rows with neither
timestamp set), `deleteStaleAuthTokens` (consumed-before OR unconsumed-and-expired, split the same
way), and `listApiKeysMintedBy` itself, which filters on the minter rather than the owner in both.

Suites: 70 files over the five doubles, 909 passed, `tsc` clean.

---

## V-1283 — the terminal set is the active set's complement, and only production knew it

V-1279 gave the active-status set one home. Its complement still had two.

The restated-STRING-set class is the gap V-1260 names in its own header: that guard sees NUMBERS
only, and a naive string rule would be noise because doubles legitimately share literals like `'id'`
with their repos. A narrow detector was prototyped instead — groups of two or more lowercase string
literals appearing as a SET on both sides, either as an array literal or an `||`-chain — and across
all paired doubles it returns exactly two, both in `sessions-repo`: `['destroyed', 'errored']` and
`['creating', 'busy']`.

**Only one is a finding, and checking that mattered.** `['creating', 'busy']` is inlined identically
by production and the double at the same branch, with no named constant on either side to import; a
double reproducing production's branch logic is what a double is for, and "name this" is a refactor
rather than a divergence. `['destroyed', 'errored']` is different, because production's four inlined
`notInArray` sites are already TIED to a derivation: `every-non-terminal-session-query-agrees`
derives the terminal set as the enum minus `ACTIVE_SESSION_STATUSES` and requires every inlined
predicate to equal it.

**That guard scans `apps/server/src`.** The six copies in the double were outside its population and
tied to nothing. Adding a terminal status would have moved every guarded production query and left
the fixture that service and route tests actually run modelling the old split — the V-1279 argument
one level down, and reachable only because V-1279 exported the active constant in the first place.

The double now derives the complement the same way the guard does. Production is deliberately left
alone: its inlined sites are pinned by `EXPECTED_SITES` counts, and introducing a constant there
would dismantle the derive-and-pin design that already works.

```
M23  a hand-written comparison returns   RED "the double compares against a terminal status by
                                         name", listing the literals it found
M24  the derivation becomes a literal    RED "no longer derives its terminal set from the enum
                                         minus the active constant"
```

The new arm exercises its literal-detector on a control before asserting zero, because an arm
asserting an empty list passes just as happily when its pattern has stopped matching anything.

**One existing arm had to change to stay honest.** The V-1279 arm counts uses of
`ACTIVE_SESSION_STATUSES.includes(` in the double and required exactly two — the sites mirroring the
repo's two queries. The terminal derivation reads the same constant, which would have made the total
three and quietly turned that number into something its own message no longer described. It now
strips the derivation before counting, so it still measures what it claims to.

`tsc` caught the one behavioural trap: `status` is optional on the insert input, and the `===` chain
being replaced simply evaluated false when it was absent, where `.includes(undefined)` does not
typecheck. Guarded explicitly — a green vitest run would have shipped it.

Suites: 138 session-touching files, 1655 passed, `tsc` clean. Full suite before this batch: 3167
files, 31290 passed | 16 skipped, confirming the V-1282 counter conversion cleared the four
admin-billing failures and that the other four did not recur.

---

## V-1284 — two instruments retired, and the crypto activation verified clean

Three negative results, recorded because each cost a measurement and the next pass should not pay
for them again.

**No general restated-string-set guard.** The narrow detector that found V-1283 returns two sets
across every paired double, and after that fix the population is one — `['creating', 'busy']`,
inlined identically on both sides with no constant on either to import, which is a refactor rather
than a divergence. A guard would be watching a set of size zero for the shape it can distinguish,
and the one real instance now has its own tripwire in the sessions cross-source arm. The V-1260
header's judgement stands: string sets are noise in general, and the narrow version earns its keep
as a one-off sweep rather than a standing rule.

**The predicate-gap ranking does not find divergences.** Built to prioritise the ~67 one-sided
methods still watched only by a guard, it counts decision tokens on each side and ranks by the gap.
Its top hits were all indirection, not disagreement: `incidents::listPage` and `publicFeed` scored
zero on the production side because they delegate to a module function; `sessions::listSessions` and
`listAllSessions` scored low on the double side because the keyset logic lives in the shared
`keysetPage` helper. And `stripe-webhooks::activateCryptoEntitlement`, the largest gap where both
sides genuinely carry logic, turned out to be clean — Drizzle spells one decision across several
builder calls (`eq`, `and`, `gt`), so the metric counts verbosity. Following delegation would fix
it, at a cost well above reading the methods.

**`activateCryptoEntitlement` agrees on every outcome**, checked against source on both sides: a
missing account returns the un-inserted window without touching anything; a replay returns the
ORIGINAL grant's window and applies no tier change; a new grant stacks off the account's latest
unexpired SAME-tier expiry (production takes it with `orderBy(desc(expiresAt)).limit(1)`, the double
by keeping the maximum) and applies the tier only when `isCryptoTierUpgrade` says so. The
day-length arithmetic differs in spelling — `24 * 60 * 60 * 1000` against a named `DAY_MS` — and
that is already covered: `stripe-webhooks-repo.ts::1000` sits in the numeric guard's `SHARED_UNITS`
with the reason that milliseconds-per-second is a unit rather than a decision.

The remaining one-sided population is now the tail: every method in it is named by at least one
source-reading guard, every paired method is reached by some test, and the eleven that were watched
by nothing are done. What is left is read-by-hand work with no instrument that beats reading.

---

## V-1285 — the aliasing guard was looking for the one binding form nobody uses

Reading `webhooks::rotateSecret` off the one-sided list — verified clean, all four of its behaviours
mirrored, including the customer-grace guard and the force-window `secretPrev` preservation — its
no-op path returns `Promise.resolve(r)` where `r` came from `this.endpoints.get(...)`. The V-1255
guard should have flagged that, and it was green.

**It binds on `this.x.find(` and nothing else.** Almost every double here is Map-backed, so `.get()`
is the ordinary way a row is bound. Measured per method scope:

```
find  0 live instances   (the form the guard checks)
get   7                  (invisible)
for-of 3                 (invisible)
```

The guard has been passing because its signature stopped describing the code — which is exactly the
failure its own first arm exists to catch on the other side, and the reason that arm exists at all.
All ten are now snapshotted and the detector recognises all three forms, each asserted separately so
losing one cannot hide behind the others.

**Three instrument errors on the way, each worth its line.**

_File-wide binding scope._ Widening the forms immediately produced six false positives: `createAccount`
builds a fresh row, and it was flagged because a DIFFERENT method in the same file binds a local
called `row` out of a map. The set is now computed per method span. The scope is part of the
signature, and a name is not a binding.

_A regex that thought `true` was a row._ An attempt to also catch rows stored inside an object
literal matched every identifier in the storing call's arguments and flagged seventy-two sites,
including `return Promise.resolve(true)`.

_My own per-site attribution was wrong_ in the first measurement, for the same file-wide-name reason
— it reported `findActiveAuthToken` as a `.get()` bind when it is a `for-of` one.

**A class measured and deliberately NOT swept.** A principled version of the stored-inside-a-literal
rule flags twenty more sites: every insert-style method that builds a row, stores it, and returns
that same object. They are genuine instances of the rule as stated. They are also a distinct class
with a much larger blast radius, and sweeping them in at the end of a long batch would be a decision
made by momentum. Population recorded, deferred deliberately.

**One test depended on the aliasing, in writing.** `webhook-secret-force-rotation` backdated a secret
by mutating the row `findEndpoint` handed back, under the comment _"The InMemory repo stores rows by
reference; mutate in place."_ Four arms rested on it. That arrangement cannot work against Postgres —
a SELECT returns a copy, so the same test against the real repo would age nothing and rotate nothing.
The double gained a fixture-only `backdateSecretCreatedAt` seam, mirroring the `backdate*` idiom the
team-members contract already uses, and the interface read is free to return a snapshot. This is the
V-1251 lesson exactly: the snapshot rule belongs to the INTERFACE, and an arrangement that needs a
live row needs a seam that says so.

```
M25  drop the copy from sessions::findSession (a .get bind)         RED, names file/method/line
M26  drop the copy from auth-flows::findActiveAuthToken (a for-of)  RED, names file/method/line
```

Suites: 521 files across auth, sessions, profiles, webhooks and mfa — 6245 passed, `tsc` clean.

---

## V-1286 — the deferred class, decided and swept

V-1285 measured a class and deliberately left it: insert-style methods that build a row, store it,
and return that same object. Deferring was right — it was the end of a long batch — but leaving it
deferred indefinitely would be worse, so it was decided here on evidence rather than momentum.

**Two measurements made the decision cheap.** No test in the suite arranges state by mutating a row
a repo returned — zero, after V-1285's `backdateSecretCreatedAt` seam removed the last one — so the
sweep carries no test risk. And a per-row-type check corrected my own earlier framing: the four sites
I had flagged as "observable" are not. `auth-flows` REPLACES `slot.account` with a fresh object
rather than mutating the account, and `incidents` mutates incident rows in place but `addUpdate`
returns an UPDATE row. So the population is 25 and none of it is observable today — which is
precisely the property that has gone stale twice in this campaign, and the reason to fix it anyway.

All 25 now copy on the way out, and the guard grew the branch that keeps them fixed.

**The block-first strip bit me, in a script, three files after the guard that documents it.** The
first sweep detected on a comment-stripped view and wrote back by line index into the raw file. Its
stripper ran the block-comment pass first — so a `/*` inside a LINE comment swallowed everything to
the next `*/`, collapsing lines, and the indices no longer matched. `auth-flows` came out with a
`return` spliced into the middle of a `.set(` call, which `tsc` caught immediately. This is V-1256's
finding, in my own tooling, and the fix is the same one `code-only.ts` exists to provide: detect on
raw lines and blank anything that starts a comment, or use the shared scanner. Restored from HEAD —
the file held only committed work plus the bad edit — after snapshotting the damage.

**The guard is stricter than the script that preceded it, which is the right way round.** It found a
twenty-fifth site the sweep missed: `validation-schedules::upsert` declares its row through a
ternary, which the "declaration is an object literal" rule does not match, but the guard also treats
a name passed directly to `set(key, value)` as stored. One rule catching what another misses is why
the guard is the thing that ships, not the sweep.

```
M27  drop the copy from profiles::insert   RED, naming file, method and line
```

Suites: the entire server project — 2358 files, 24157 passed | 10 skipped — plus `tsc` clean. Full
suite before this batch: 3167 files, 31292 passed, confirming V-1285 including the force-rotation
seam.

**Noted for attribution, not investigation:** a peer is editing `apps/gui-client/` in this shared
worktree (`ProfilePhoneCard.tsx`, `ProfilesView.tsx`, `visual-harness/gallery.tsx` and that
component's test) and running its project's vitest concurrently. Those files are untouched here and
must not be committed by this agent; any gui-client red in a full-suite run during this window
belongs to that work, not to this sweep.

---

## V-1288 — a naming convention hid an entire repo pair from every parity sweep

The billed-status set was given one home in V-1263, and the entry closing that work named the next
edit precisely: _Stripe grants `past_due` a retry window in which the subscription is still charged,
so a third member here is a plausible edit rather than a hypothetical one._

**It was not hypothetical. It already existed, in a file no sweep could see.**

`billing-repo.ts` spelled `['active', 'trialing']` inline for `findActiveSubscription`, and
`['active', 'trialing', 'past_due']` inline for `findCollectingSubscription`. Its double restated
both as `!==` chains. Four spellings of the paying set — the canonical constant, two repos importing
it correctly, and these two — plus a collecting set with no home at all.

**Why every sweep missed it.** Each pairing guard, and every coverage measurement in this campaign,
resolves `in-memory-<X>.ts` against `src/db/<X>.ts`. The billing double is `in-memory-billing.ts`,
named for the TWO classes it exports rather than for a repo — deliberately, and documented as such
in the shape-parity guard. As a side effect it resolved to no counterpart, so it was dropped from
the pairing silently. My "194 paired methods", the one-sided list, the unwatched-by-any-guard list
and the string-set sweep were all computed without it.

That is the failure mode this campaign keeps meeting from a new angle: **an absence and a clean
result are indistinguishable.** A guard that skips a file reports the same green as a guard that
checks it and finds nothing.

Fixed on both axes. `COLLECTING_SUBSCRIPTION_STATUSES` now lives beside the paying set and is
DERIVED from it, so adding a billed status extends both and the relationship stays a fact rather
than a coincidence; the repo and its double both read the two constants. And the pairing itself now
resolves an alias, with a new arm that makes an unresolvable double a FAILURE rather than an
absence — plus an `UNPAIRED` list for the one double that genuinely has no `src/db` counterpart,
which may only shrink.

```
M28  remove the billing alias           RED "double(s) resolving to no repo", naming the file
M29  restate the billed set in the double   GREEN — and correctly so
```

**M29 is the informative one.** It proves the numeric guard does not cover string sets, which is
exactly what that guard's own header says. It also means V-1284's decision not to build a standing
string-set guard was taken on a population measured through the broken pairing. Re-run with the
pairing corrected, the sweep returns ONE restated set — `['busy', 'creating']` in sessions, already
judged legitimate in V-1283 because both sides inline it identically with no constant to import. The
decision stands; it now rests on a number that was measured correctly.

**A retraction, and the process fix behind it.** Before this, `usage-repo::dailyBucketsForRange`
looked like a divergence: production reconstructs session minutes from `sessions` and
`agent_sessions` and merges them in as `session_minute`, and the double produces none. It is
documented — V-1217, in the double's own file header, as a stated limitation with a stated remedy
("a test needing those has to use the real repo"), and the admin route tests that touch it assert
only authorization, never bucket content. So the decision holds and there is no finding. That is the
THIRD time this campaign I have re-derived documented prior art, and the pattern is now clear enough
to name: my prior-art check greps the method name and the guard files, and all three times the
documentation lived in the FILE HEADER of the double. Read both headers before comparing a method.

Suites: the whole server project — 2358 files, 24158 passed | 10 skipped — `tsc` clean.

---

## V-1289 — the same shape again: a filter that shrinks a population instead of failing

V-1288's cause was a guard whose population came from a filter, so a member that failed to resolve
was dropped silently — and an absence reads exactly like a clean result. That is a SHAPE, so it was
swept for rather than assumed unique.

**Most of the sweep was a negative, and the negatives are the useful part.** Two hundred and one
guards build a population by scanning, which is far too coarse to act on; ranking them by whether
they assert a size floor or name a member turned out to be another weak instrument, so it was
abandoned rather than dressed up. The `every-drizzle-repo-is-driven-against-a-real-postgres` guard
looked like a candidate and is not: it ENUMERATES `src/db` and requires every file to either carry a
Drizzle class or sit in an exemption list, so all 55 files are covered by construction. That is the
distinction worth keeping: **enumerate-and-classify is sound; pair-by-name-and-filter-on-existence
is not.**

Filtering for the second shape leaves a handful, and all but one are the safe direction — "this
cited path must exist", which FAILS when something is missing. One is not.

`rate-limit-bucket-disclosure-invariant` filters its two declared disclosure pages down by
existence. One of its three arms asserts the resolved count equals the declared count; **the other
two do not.** A page renamed or deleted would leave those two arms checking one page instead of two,
green, and silent about the one that vanished — in a guard whose subject is whether customers are
told the truth about which routes consume a rate-limit bucket.

The check now lives in the helper rather than in one arm, so every caller gets it by construction.

```
M30  rename a declared page   RED in ALL THREE arms — "a declared rate-limit disclosure page no
                              longer resolves" — where previously only one would have failed
```

That count is the whole point of the fix: the mutation reddens three arms now and would have
reddened one before.

---

## V-1290 — the read with nothing to bind, and a guard that reads types instead of keeping a list

Two veins this batch, one negative and one finding.

**The negative first, because it validates prior art from the side prior art could not check.**
V-1201 reviewed every array-returning read with no `ORDER BY` and recorded, per entry, why arbitrary
order is unobservable there — verified against CONSUMERS on 2026-08-20. What it could not check is
the other direction: whether a TEST asserts an order on one of those reads, which would contradict
the review and pass anyway, because a double returns insertion order for free. Cross-checking the
twelve allowlisted reads against every test assertion produced four candidates and **all four are
false positives**, each confirmed against source: `rate-limit-overrides::listAll` is a DIFFERENT
`listAll` from the allowlisted `pricing-repo` one and orders by `(createdAt desc, id desc)`; the
pair-mode test sorts BOTH sides before comparing, which is the correct order-insensitive idiom, and
my `[1]` match was an index into the test's own fixture array; `dailyBucketsForRange` sorts in JS
after the query; and the session-cap contract's `toEqual([kept])` is a one-element array whose comma
my detector counted from the trailing formatting. Zero violations. The review holds.

**The finding.** While confirming V-1288 I noticed `in-memory-billing::getAccount` returns
`this.accounts.get(accountId) ?? null` — a stored row handed straight out with no local at all.
Every branch of the aliasing guard needs a NAME to check, so a read with nothing to bind walked past
all of them. Ten interface reads are written that way, across seven doubles. None is observable, for
the reason that keeps recurring: the doubles that mutate rows in place do not mutate these row
types. All ten now copy on the way out, written as ten explicit edits rather than one clever regex —
this session has lost enough time to detectors that were too broad.

**The guard reads the declaration rather than keeping a list.** Widening it flagged seven, and only
three were defects. The other four read collections that hold `string`, `Date` or `Buffer` — a copy
protects nothing there, and no amount of syntax tells you which is which. Rather than a hand-kept
exemption list that has to be re-argued each time it grows, the detector now resolves
`this.<name>` to its `new Map<K, V>` declaration in the same file and skips the read when `V` is a
primitive. The three genuine seams — `account-lifecycle::read`, `sessions::getSession`,
`stripe-webhooks::readAccount`, all returning fixture-internal types or `| undefined` where the
interface returns `| null` — went to `LIVE_SEAMS` with their reasons.

```
M31  restore one inline read                    RED, naming webhooks::findEndpointById
M32  make the value-type check always say "objects"   RED with exactly the scalar reads it exists
                                                to suppress — getWrappedDek and findAccountEmail
```

M32 is the one worth keeping: it proves the exclusion is load-bearing rather than decorative, by
showing precisely which false positives return when it is removed.

One instrument error, found by checking rather than assuming: the declaration regex had no `\s*`
before `=`, so it matched nothing and every scalar collection stayed flagged. The symptom looked
like "the exclusion does not work"; the cause was that it never ran.

Suites: the whole server project — 2358 files, 24159 passed | 10 skipped — `tsc` clean.

---

## V-1291 — enumerating the residual instead of waiting for the next form to bite

The aliasing guard has been widened five times, each widening finding real sites. That is a pattern
worth interrupting: rather than guess a sixth form, the RESIDUAL was enumerated — every return in
every double that touches stored state, classified as flagged, provably safe, or neither. Eighty-two
returns, thirty-three safe on the line, and the rest read by hand.

Most of the remainder is benign in ways a one-line classifier cannot see: locally computed counts,
registered `getAll` seams, and delegations where the question moves to the delegate. **Two are not.**

**`incidents::findOpenAutoIncident` is an observable defect**, and the most serious one this guard
has turned up since V-1274. The row is bound off the END of a chain —
`this.incidents.filter(…).sort(…)[0]` — and returned through a coalesce. Neither shape had a
binding the guard could recognise, so V-1274 snapshotted every other read in that file and left this
one live. It matters because this is the double that writes `status`, `resolvedAt` and `updatedAt`
STRAIGHT onto a stored incident in `addUpdate`: a caller holding what this returned watched the
status change underneath it, and the probe path that calls this decides from what it is holding
whether to open a NEW incident. Postgres returns the row as it was and cannot do that.

**`auth-flows::setPassword`** returns `slot.account` — a stored row reached through a property of a
bound local. Not observable, because that double replaces `slot.account` rather than mutating it,
but the same rule.

Both fixed. The guard now recognises the chain-bound form and the property-of-a-bound-local form,
and a behavioural arm on the incidents contract asserts the invariant on BOTH implementations rather
than only the shape.

```
M33  drop the snapshot from findOpenAutoIncident   guard RED, naming file/method/line
M34  drop the copy from setPassword                guard RED, naming file/method/line
M35  drop the snapshot again, against the contract in-memory RED "the held auto-incident changed
                                                   status underneath the caller", drizzle GREEN
```

M35 is the one that matters: it is the difference between "this shape is wrong" and "the caller sees
the wrong thing".

**Two instrument errors, both caught by checking rather than by a green run.** The chain-bind pattern
was first added to the per-line `BINDINGS` list, where it could never match a declaration spanning
four lines — it reported zero, which reads as "no such sites" rather than "this pattern cannot span
a newline"; it now matches against the joined method body. And widening the bare-return regex to
allow a property access immediately flagged `return Promise.resolve(row.id)` in two writes that
return an id string. That is now gated on the enclosing method's declared return type, the same
technique V-1290 used for collection value types, and for the same reason: the signature already
says whether a row can escape, so the guard reads it instead of carrying a list of exceptions
somebody has to re-argue.

Suites: the whole server project — 2358 files, 24162 passed | 10 skipped — `tsc` clean.

---

## V-1292 — finishing an enumeration I had reported as finished

V-1291 said the residual had been enumerated and read. It had not: the listing was capped at thirty
of forty-seven, and the seventeen I never saw were reported as though they had been. Correcting that
is the entry.

The tail holds nothing new, and the reasons are worth keeping because three of them look like
findings until read:

`status-subscribers::listPurgeCandidates`, `team-members::listMembers` and
`team-members::listPendingInvites` all sit in doubles that mutate rows IN PLACE, which is exactly
where an aliasing read is observable — and all three end in `.map((r) => snap(r))`. They surfaced in
the residual only because the classifier reads one line and the `.map` sits three lines below the
`return`. The remaining entries are locally computed scalars, delegations where the question moves
to the delegate, and `getAll`-style seams already registered.

**One shape survives unmodelled, and the measurement is what makes skipping it defensible.**
`return Array.from(this.subs.values());` returned inline, with no local to bind, is invisible to
every branch of the guard. Three sites are written that way and all three are fixture seams absent
from any production interface — so a branch for it would buy three `LIVE_SEAMS` entries and no
defect. That is recorded in the guard's header rather than acted on, alongside the numeric guard's
note about string sets, because the population is the reason and populations change: an interface
read written that way would slip through, and whoever writes one should meet the paragraph instead
of a silence.

The aliasing class now stands at: six forms modelled, one measured-and-named, 82 returns classified,
and every double read to the end rather than to the thirtieth line of a capped listing.

---

## V-1293 — the same discipline on the cursor guard, and it comes back empty

The residual enumeration found two real defects in the aliasing class, so it was applied to the other
guard that closed a class of shipped paging bugs: positional cursors (V-1242, V-1243).

That guard has ONE signature — `findIndex`/`indexOf` near the word `cursor`. Anything resolving a
cursor by some other spelling is outside it, and a green run says nothing about those. So every
method in every double that mentions a cursor was enumerated and read:

```
14 cursor-using methods
 6 resolve through the shared keysetPage helper
 8 resolve by an explicit keyset comparison
 0 positional
```

The eight were read individually rather than pattern-matched. `admin-accounts::list`,
`profiles::list` and `rate-limit-overrides::listAll` each compare `(createdAt, id)` against the
cursor row and carry a comment recording the conversion from the offset form they used to have.
`incidents::listPage` filters on the same comparison. Both webhooks listings resolve through
`decodeDeliveryCursor` + `afterDeliveryCursor`, a shared key comparison rather than a position.

The class is closed, and closed by reading rather than by the guard agreeing with itself.

**One instrument note, because it produced two entries that looked like findings.** The method-span
parser matched `if (` as a method signature — `  if (opts.cursor) {` has the same shape as
`  listPage(opts) {` to a regex that only checks for an identifier followed by a parenthesis. It
reported two "hand-rolled comparison" methods in the webhooks double named `if`. Harmless here
because every entry was read, which is the point: an enumeration whose entries are all inspected
survives a sloppy classifier, and one whose entries are merely counted does not.

---

## V-1294 — a table-wide counter with no time bound at all, found by enumerating the third class

The residual discipline was applied to the counter class — the one that already forced a retraction
in V-1282, when the detector missed four sites because they wrote `before[TIER],` and the pattern
demanded `before,`. So this time the enumeration was NAMING-AGNOSTIC: every local bound from an
awaited call, re-read from the SAME call within twenty lines, with an assertion relating the two.
Sixty-five hits.

**Sixty-four are not counters.** They are idempotency and replay arms — `createIdempotent` twice,
`app.inject` twice, `repo.create` twice — where comparing two results is the entire point. A broad
signature over a suite this size returns mostly the thing it is not looking for, which is why every
hit was read rather than counted.

**One is, and it is worse than the four V-1282 corrected.**
`db-incidents-public-feed-drizzle` takes exact before/after deltas on
`publicFeed().openOutageCount`, in two arms. Reading `publicFeed` to check the window explains why
that is unsafe: **`since` is passed to the RESOLVED page only.** The open page and the open-outage
page carry no date filter at all. So `openOutageCount` counts every public, open, outage-severity
incident in the table, unbounded in time — and `db-incidents-truth-drizzle` seeds three public open
outages of its own. Their fixed `startedAt` of 2026-07-18 puts them outside no window, because there
is no window. I nearly dismissed this on exactly that date: the feed asks for the last 24 hours, the
neighbour's incidents are a month old, so they cannot collide. They can, and only reading the query
says so.

Neither detector could have reached it. The read is `publicFeed()` — no `count` in the name — and
the compared value is a FIELD of the result, so the corrected V-1282 pattern misses it too.

Both arms now measure through `cleanDelta` against a one-key vector. The second arm became two
deltas rather than one span: opening the outage raises the banner by one, resolving that same
incident lowers it by one, each retried on its own, so a neighbour opening an outage between the
halves is retried rather than blamed on the resolve.

```
N3  seed the "private" outage as PUBLIC   MISCOUNTING, "openOutage: 1 (want 0)"
N4  drop the resolve UPDATE               MISCOUNTING, "openOutage: 0 (want -1)"
```

Both deterministic across all five attempts, which is the helper distinguishing a miscount from a
neighbour rather than guessing.

**Process note.** N4's first attempt never applied: the anchor contained a backtick and a `!`, and
the shell rewrote both inside the python one-liner. The marker printed `anchor: 0` and I stopped
instead of running the suite — the rule from V-1274b holding on the exact failure it was written
for. Rewriting it through a quoted heredoc, with the marker checked before the run, applied cleanly.

Suites: the whole server project — 2358 files, 24162 passed | 10 skipped — `tsc` clean.

---

## V-1295 — the last two class residuals, both negative, both measured rather than assumed

Three of the five guard classes had been enumerated. These are the other two, and both come back
empty — but for reasons worth writing down, because "we looked and found nothing" and "we looked at
the wrong thing" produce identical green runs.

**Restated numbers: zero below the threshold.** That guard's `POLICY_NUMBER` matches three-or-more
digits, or digits grouped with underscores. Two-digit policy values are invisible to it — and this
campaign centralised page sizes of exactly 50, so the gap is not hypothetical. Every double was
compared against its repo for shared two-digit literals, excluding the time units (24, 60, 12) that
are legitimately shared: **zero**. The threshold is not currently hiding anything, and single digits
are genuine noise (indices, 0, 1) rather than an omission.

**Hand-rolled comment strippers: fourteen, none damaging, and the reasoning is per-case.** That
guard's signature is one specific block-comment regex, so a stripper spelled another way is outside
it. Fourteen test files strip LINE comments with a private regex instead of the shared scanner. The
guard's own header already calls this form "not currently damaging, which is luck rather than
design" — this checks whether that is still true instead of inheriting it.

A file-level scan says four of them read source containing `//` inside a string literal, which is
what a naive line strip truncates. **That measurement over-reports, and the correction is the
point:** the risk is not that the FILE contains such a string, it is that the STRIPPED REGION does.
Three of the four strip a bounded slice — an array literal of webhook event names, a schema union of
`z.literal` type names — whose contents cannot contain a URL. The fourth strips the whole of
`bootstrap.ts`, which genuinely holds `'https://driftstack.dev/docs'`, and is safe for a different
reason: the stripped text feeds a PRESENCE assertion, so a truncated line makes the arm fail loudly
rather than pass quietly. The dangerous direction — an absence assertion over truncated text — does
not occur in any of the fourteen.

All five classes now have measured residuals rather than assumed ones:

```
aliasing reads      six forms modelled, one named and left with its population as the reason
positional cursors  14 methods read, zero positional
racy counters       65 candidates read, one real member found and fixed (V-1294)
restated numbers    zero below the guard's digit threshold
comment strippers   14 private strippers, none damaging, each checked by region and direction
```

The through-line of the last several entries is one habit: a guard's green run is evidence about its
signature, not about its class, and the two only coincide when somebody has enumerated the
difference. Four of these five enumerations found nothing. The fifth found a table-wide counter with
no time bound.

---

## V-1296 — RETRACTION: I measured a guard-decay gap four times and it was my instrument every time

The habit that closed the five classes generalises: a guard that stops matching reports the same
green as a guard with nothing to find. So the question was asked of the whole tree — how many guards
assert an ABSENCE over a regex-derived list with nothing to catch their own decay?

**Four answers, each smaller, each produced by reading a file the previous instrument had
misclassified.**

```
125   first pass — control detection matched lowercase variable names only
 39   second — after allowing UPPERCASE (an-unredactable-auth-token has `const PROBE = …`)
 23   third — after allowing a floor compared against a VARIABLE, not a literal
      (every-sdk-path-id-is-url-escaped: `.toBeGreaterThanOrEqual(floor)`)
  0   demonstrated — four of four sampled from the 23 turned out protected
```

The four sampled were each defended by a DIFFERENT idiom, which is why no single pattern found them:

```
an-unredactable-auth-token-is-never-logged     a synthetic PROBE the detector must match
every-sdk-path-id-is-url-escaped               a per-language floor against a variable
unscoped-lookup-containment-invariant          an exact-set pin — an emptied scan fails it
webhook-backoff-schedule-agrees-everywhere     an exact-count pin in a SIBLING arm
every-job-chain-rearms-on-a-throwing-tick      `toHaveLength(12)` on the population
```

**I nearly committed redundant churn.** Believing `every-sdk-path-id-is-url-escaped` had no
protection, I added per-language floors, ran the mutation, and watched it fail correctly. That
proves an arm works; it does not prove it was needed. The counterfactual — the SAME mutation against
the file as it stood — is what settled it, and the pre-existing arm caught the dead pattern with a
better message than the one I had written: _its verdict below would be a perfect score over an empty
set_. The arm was reverted. Running the mutation against the unmodified file costs one command and
is the only thing that distinguishes a fix from a duplicate.

Recorded so the next pass does not re-run this: **no guard-decay gap was demonstrated.** The
population of absence-asserting source guards is 271, they protect themselves through at least four
distinct idioms, and a classifier that recognises fewer than all four will keep reporting a gap that
is not there. Verified along the way: the SDK path-escaping extractors still find 57 TypeScript, 86
Python and 56 Go interpolation sites — exactly the counts recorded when that guard landed.

---

## V-1297 — the production question V-1294 left open, answered; and the plan this campaign cites is gone

**The open question, closed.** V-1294 fixed a racy TEST measurement and noted, without settling it,
that the production query behind it applies `since` to one sub-query and not the others. Sweeping
every `src/db` method that issues two or more sub-queries through a shared page reader, looking for
a filter passed to some and not all, returns exactly ONE method — `incidents-repo::publicFeed`, the
same one. So the shape is unique rather than a class.

And its asymmetry is deliberate on both axes. `severity` is absent from two of the three sub-queries
because one of them IS the outage page and the others are deliberately all-severity. `since` is
absent from the two OPEN pages because an open incident should appear regardless of age; only
resolved history is windowed. The obvious worry — an incident opened long ago and never resolved
pinning the banner forever — is covered for the incidents nobody is watching: `health-probe`
auto-resolves an open auto-incident after N consecutive successes. A human-declared incident stays
open until a human resolves it, which is the intended contract rather than a leak.

No production defect. The V-1294 fix stands as a test-measurement fix, which is what it claimed.

**A material correction about this campaign's framing.** Every batch is requested "working from
`apply-plan.md` (the re-verified plan) and `sweep-report.md`". **Neither file exists.** Not in the
session scratchpad (1221 files), not anywhere under the session directory, not in the repository, not
in `/tmp`. They are absent, not stale — `find` returns nothing for either name.

That has a concrete consequence worth stating rather than working around: the numbered action list
those batches carry (5, 7, 8, 12, …) cannot be re-verified against its source, and neither can the
V-1150 derivation that the list was already spent. Everything from V-1274 onward has been
self-directed defect-hunting under the batch rules, which has been productive — a torn write, a
key-envelope stub, a counter with no time bound, a repo pair invisible to every guard — but it is not
the same thing as executing that plan, and a reader of this log should not infer that it was.

Resuming plan-driven work needs one of: the two files restored to the scratchpad, or the remaining
actions restated in the request itself.

---

## V-1298 — the guards hardened one double per repo, and there are thirty-seven others

A new class, and the first one in a while that is structural rather than a single defect: Postgres
enforces constraints a `Map` cannot. Twenty-six unique indexes exist in the schema. The one worth
opening first is `profiles_account_name_unique` — PARTIAL, on `(accountId, name) where deleted_at is
null`, so trashing a profile frees its name.

**Production leans on that index for a real branch.** Every insert path does a
`findByAccountAndName` pre-check and then a raw insert, so two same-name creates — the double-click —
can both pass the pre-check before either commits. The loser's INSERT raises 23505, and
`ProfilesService.create` catches it and throws a `ConflictError`: a clean 409 instead of an uncaught 500. The shared double enforced nothing, so **that branch was unreachable through the fixture**, and
its only coverage was content-parity pins asserting the source TEXT contains
`if (isProfileNameRaceViolation(err)) {`. A text pin survives the branch being reordered, or the
detector narrowed to a constraint name that no longer matches.

The double now models the partial index and throws the shape `isUniqueViolation` reads — SQLSTATE
and constraint name at the top level, where postgres-js puts them. All 69 profile-touching files
still pass, so nothing was relying on creating two live profiles with one name.

**Then the arm failed, and the reason is the bigger finding.** Driving two concurrent creates through
`profiles-service.test.ts` produced two SUCCESSES. The double was enforcing correctly — a direct
probe throws `code=23505 constraint=profiles_account_name_unique` — but that file never touches it.
`makeRepo` there is a hand-rolled object literal typed `ProfilesRepo`, and **the guards scan
`_helpers/in-memory-*.ts` only**. Measured across the tree: **37 file-local stubs typed as a
production interface, over 26 distinct interfaces** — `RateLimitStore` ×4, `ApiKeysRepo` ×3,
`ProfilesRepo` ×2, `IncidentsRepo`, `WebhooksRepo`, `UsageRepo`, `AuthCache` and twenty more.

Everything this campaign hardened — the aliasing forms, the cursor keysets, the counter helper, the
restated sets — applies to one double per repo. Those 37 inherit none of it, and every guard reports
green over a population that excludes them. That is V-1288's lesson again at a larger scale: the
guards are not wrong, their POPULATION is smaller than the thing they are read as covering.

The arm now drives the shared double rather than the local stub, which is what makes the branch
reachable at all.

```
M37  disable the race catch in ProfilesService.create   RED "the race loser saw a raw unique
                                                        violation rather than the translated
                                                        conflict — a 500 where the customer
                                                        should get a 409"
```

That mutation is against PRODUCTION source, not a fixture: the arm guards the 409 a customer sees
when they double-click Create.

Not swept, and named with its size rather than left implied: the other 25 unique indexes, and the 37
stubs. Extending the guards' population to file-local stubs would flag most of them and need an
exemption each, so it is a decision to take deliberately rather than at the end of a batch.

Suites: the whole server project — 2358 files, 24162 passed | 10 skipped — `tsc` clean.

---

## V-1299 — the unique-violation class enumerated to the end: one gap, already closed

V-1298 modelled one constraint because a production branch hung off it. The obvious question is how
many others do, so the class was enumerated from production source rather than from the schema:
every site that translates a Postgres 23505 into a domain error.

```
profiles_account_name_unique      profiles-repo + services/profiles   409 on the create race
accounts_slug_unique              auth-repo                           SLUG_TAKEN → 409
accounts_email_unique             services/auth-flows                 signup race
accounts_canonical_email_unique   services/auth-flows                 alias-variant signup race
api_keys_prefix_unique            services/api-keys ×2                retry-then-rethrow
(unnamed)                         routes/agent-sessions               idempotency-key replay
```

**Five of the six are covered behaviourally, and finding that out took three retractions of my own
hypotheses.**

`api_keys_prefix_unique` looked like an unexercised bounded-retry loop — the mint path counts
`attempt = 0; attempt < MAX` and the rotate path `attempt = 1; attempt <= MAX`, checking
`attempt === MAX_KEY_MINT_ATTEMPTS`, which is the shape an off-by-one hides in. Both are correct:
the 1-based loop pairs with the `=== MAX` check, the 0-based one rethrows after the loop. And both
are driven — `api-keys-service.test.ts` builds a repo that throws a real 23505 for its first
`failTimes` calls, asserts the retry re-minted (`insertCalls === 2`), and covers the bounded
exhaustion. Prior art, found by grepping first.

`accounts_slug_unique` looked uncovered: every hit for `SLUG_TAKEN` was a content-parity text pin at
two layers, repo and route. It is covered — `account-me.test.ts` has _409 when slug is already taken
by another account_. **My search term was the internal error name while the test asserts the
customer-visible outcome**, which is the third time this campaign a grep has missed coverage by
looking for the mechanism instead of the result. The double models the conflict too, rejecting with
`Error('SLUG_TAKEN')`.

The two email constraints and the agent-sessions idempotency race each have their own harness
constructing the 23505 shape.

**So V-1298 was the only gap, and that claim is now verified rather than assumed.** The 409 tests for
duplicate profile names all drive the PRE-CHECK — two sequential requests — and the only
`Promise.allSettled` concurrent create in the tree is the arm V-1298 added. The pre-check path was
well covered; the branch that fires when two requests pass it and the INSERT loses was not.

Left standing, with its size: 21 of the 26 unique indexes back no translation site, so nothing hangs
off them and modelling them would be work without a branch to reach. The 37 file-local stubs from
V-1298 remain outside every guard's population.

---

## V-1300 — a test-count that did not move, attributed rather than assumed

V-1298 added one arm. The next full run reported the same total as the run before it — 31299 passed,
16 skipped, 3167 files. A total that does not move when an arm is added is the shape of a test lost
somewhere else, which is the failure this campaign's rule about `it(` counts exists to catch, so it
was chased rather than waved through.

It balances exactly. A peer commit landed between V-1297 and V-1298 —
`ee8f7db11 fix(agent): a plan one step too long discarded the whole billed turn` — and among its
five files it removed one arm from `agent-decomposer-error-classification-cross-source.test.ts`
(14 → 13). One removed, one added, net zero.

Nothing of mine was lost: the V-1298 arm is in HEAD, the file reports 62 of 62, and the arm's own
mutation still fails correctly.

**Two things worth keeping from the chase.** I first compared against `HEAD~1` believing it was the
pre-arm state; it is the V-1298 commit itself, so it already contained the arm and the comparison
proved nothing. And the peer commits under `Driftstack <dev@driftstack.dev>` — the same identity
this agent uses — so `git log --format='%an'` cannot separate us. Attribution here has to be by
CONTENT and timing, not by author, which is worth knowing before the next red run gets attributed to
the wrong side.

---

## V-1301 — the aliasing rule applied to the unguarded population: the shape is there, the damage is not

V-1298 measured 37 file-local stubs typed as a production interface, all outside every guard's
population. The obvious follow-up is not "sweep them" but "does the rule the guards enforce actually
matter there" — so the aliasing detector was pointed at that population instead of `_helpers`.

**Seven stubs carry the shape**: a row bound off a local collection, mutated in place, and/or handed
back without a copy.

```
webhooks-service                10 in-place mutations,  4 bare row returns
status-subscribers-service      10                      4
validation-harness-service       7                      1
admin-accounts-service           3                      2
profiles-service                 3                      1
profile-snapshots-service        1                      0
legal-service                    0                      1
```

**No arm is damaged by it.** The damage model is specific — an arm holds a row, triggers a write,
then compares, and passes forever because `before` and `after` are one object. Searching all seven
for a local bound from an awaited call whose FIELD is later asserted returns exactly one candidate,
and reading it settles it: `first` and `second` are two different profiles compared against each
other, not one row held across a write.

So the population has the shape and none of the defect. That is worth recording rather than fixing:
snapshotting seven stubs that no arm depends on, in files no guard scans, buys nothing today and
decays the moment someone writes the eighth. What protects the shared doubles is the guard, not the
copies — and extending the guard to file-local stubs is the deliberate decision V-1298 named and
did not take.

**The instrument was wrong first, and caught before it was reported.** The first pass returned ZERO
stubs with both shapes. Validating against a known positive — `profiles-service`'s stub does
`src.deletedAt = new Date()` on a row bound from its array — showed the collection regex had found
`calls`, `captured`, `deleted` and `purgedIds` but not `rows`, because `rows` is declared
`const rows = [...initial]` and the pattern demanded `= []` or `= new Map<`. A zero from a detector
that has not been shown to find a known positive is not a measurement. Widening the declaration
pattern turned that zero into seven.

---

## V-1302 — correcting how the constraint class was framed, and a runtime check

**A correction to V-1299.** That entry closed the unique-violation class by saying the other 21
indexes "back no translation site, so nothing hangs off them". That is the wrong inference from the
right measurement. A constraint with no `isUniqueViolation` catch is not necessarily unhandled — it
may be handled EARLIER, by the write itself.

Checking the one an ordinary user reaches most often makes the point. Inviting the same person twice
would trip `team_invites_owner_email_pending_unique`, and there is no catch for it — but
`upsertInvite` writes through `onConflictDoUpdate`, so a repeat invite refreshes the pending row's
token and expiry instead of erroring. Correct behaviour, no 500, and no catch needed. There are 20
`onConflictDo{Update,Nothing}` clauses in `src`, against 5 constraints translated by a catch.

So the class has at least three handling mechanisms — translate the violation, avoid it with
ON CONFLICT, or accept a 500 for a collision that cannot realistically happen (the token-hash
indexes). "No catch site" distinguishes none of them, and the V-1299 phrasing implied the third
where the second was often the answer.

**A runtime check, since this session widened one guard six times.**
`no-double-hands-back-the-row-it-stores` now resolves per-method spans and runs six detector branches
over 29 files. Measured: 32ms of test time, 175ms wall, against 8ms for the simpler cursor guard next
to it. Twelve arms for 24ms more than a four-arm sibling is not a CI cost worth acting on — recorded
because "I widened a scanner six times" is exactly the kind of thing that quietly becomes one, and
because the alternative to measuring it is assuming.

---

## V-1303 — a seventh aliasing form, found by comparing two fixtures for one interface

V-1298 left a question rather than a sweep: several interfaces now have TWO fixtures — the shared
double in `_helpers` and a file-local stub — and if they disagree, which one a test happens to use
decides the result. `ApiKeysRepo` was opened first because it is the auth surface: the shared double
carries 11 methods, the local stub 12, and NINE are implemented by both.

**They agree.** `findApiKey` applies the same two predicates on each side (id, owning account), and
`revokeApiKeyAtomic` on the local stub reproduces the not-found / already-revoked / revoked
three-way outcome. No divergence.

**But reading the shared one produced a form the guard had never modelled.**

```
const r = this.byId.get(id);
return Promise.resolve(r && r.accountId === accountId ? r : null);
```

That is a stored row leaving through a TERNARY. Not a bare return, not an inline map read, not a
wrapper, not a materialised local — all six branches walked past it, and the tenancy check sitting
in front of the row makes it READ like a guarded return rather than a leaked one. One site across
every double; the guard now models it and the fix is a spread.

The form was found by reading a method while comparing two fixtures, not by a signature. That is now
true of every form after the first: the accumulator, the wrapper, the materialised local, the
binding-form blindness, the built-then-stored, the inline read, and this. **The detector has never
predicted the next shape; reading has, every time.** Worth stating plainly, because the instinct
after six widenings is to write a smarter regex, and the evidence says the return on that is zero.

```
M38  restore the ternary handing back the stored row   RED, naming file, method and line
```

Not observable today — `in-memory-api-keys-repo` is copy-on-write throughout, so nothing mutates the
row a caller holds — which is the same weaker-than-the-rule property that has now been recorded
seven times and has twice turned out to matter later.

Suites: the whole server project — 2358 files, 24163 passed | 10 skipped — `tsc` clean.

---

## V-1304 — a file-local stub was masking a production regression, proven by counterfactual

V-1303 established the method: an interface with TWO fixtures — the shared double and a file-local
stub — is worth reading, because if they disagree the test's choice of fixture decides the result.
Sixteen interfaces have both. `MfaRepo` was next, being auth.

**The security semantics agree.** `consumeTotpCounter` rejects a counter that is not strictly newer
on both sides; `markRecoveryCodeUsed` does the conditional single-use flip on both, reporting whether
THIS call consumed the code. No divergence in what either refuses.

**The POLICY SOURCE does not.** `mfa-repo` exports `nextRevision(now, previous)` —
`max(now, previous + 1ms)` — whose entire purpose is that a stale snapshot cannot share the persisted
revision. Production uses it, the shared double imports it, the replay contract imports it. The local
stub restated it **five times**, inline.

**The counterfactual is what makes this a finding rather than tidiness.** Breaking `nextRevision` in
production — returning `now`, dropping the strictly-newer guarantee — is now caught: the MFA suite
fails. Against the stub as it stood, the same production break leaves it **green, 28 of 28**. The
file that tests MFA would have gone on passing while the guarantee it depends on was gone. That is
the first demonstrated case of the unguarded stub population hiding a real regression, and it turns
V-1298's measured blind spot from a structural observation into a demonstrated one.

All five now read the exported rule.

```
M39  nextRevision returns `now`, dropping the +1ms   fixed stub: RED
                                                     pre-fix stub: GREEN, 28 of 28
```

**Attribution, before investigating.** The server run showed two failures, neither mine. A peer is
mid-edit across `customer-dashboard`, `marketing-site` and four server parity tests;
`dist-reading-suites-have-fresh-artifacts` reads built artifacts against source they are changing,
and `rate-limit-overrides-repo-contract` — which measures a before/after delta on a shared table —
passes in isolation, 23 of 23. Concurrent load, not this change. Only `mfa-service.test.ts` is mine
in the working tree, and only it is committed here.

---

## V-1305 — the same shape in four more stubs, and a counterfactual that says it does not matter yet

V-1304 found a file-local stub restating a rule production exports, and proved it was masking a
regression. The shape generalises cheaply: for each of the sixteen fixture pairs, compare what the
SHARED double imports from `src/` against what the local stub does. Eight pairs import a production
constant the stub does not.

Eight is not eight findings. "Does not import" is not "restates" — the stub may simply not implement
the method. Resolving each constant to its value and looking for the literal narrows it to five, and
reading those five in context narrows it to **four**, all page-size defaults in a paging fallback:

```
admin-accounts-service     const limit = args.limit ?? 50            ADMIN_ACCOUNTS_PAGE_DEFAULT
incidents-service          limit = 100                               INCIDENT_PAGE_DEFAULT
profile-snapshots-service  .slice(0, limit ?? 50)                    SNAPSHOT_PAGE_DEFAULT
profiles-service           .slice(0, limit ?? 50)                    DEFAULT_PAGE
```

The fifth was a false positive worth naming: `sizeBytes: 100` in a storage-quota fixture is a byte
count, not `MAX_PAGE`. A literal match is not a restatement, and this class is built entirely out of
numbers common enough to appear for other reasons.

**The counterfactual says this is not a V-1304.** Moving `DEFAULT_PAGE` from 50 to 2 in production
leaves the profiles service suite green at 62 of 62 — BEFORE and AFTER the fix alike. No arm in that
file exercises the paging fallback, so nothing was being masked. Stated plainly because the previous
entry earned a strong claim by counterfactual and this one does not: the value here is prospective,
not demonstrated. I tested the profiles pair; the other three were not individually counterfactualled.

Kept anyway, and the distinction from V-1301 is deliberate. There I declined to snapshot seven stubs
because a snapshot fix does not stop the eighth stub leaking — it decays without a guard. An import
cannot decay for the site that holds it: the rule has one home and that line follows it. Four
one-line imports that are self-maintaining are a different trade from seven copies that are not.

**Attribution.** The server run showed three failures, none mine. A peer is mid-commit — several
files are staged-and-modified — and both `incident-visibility-repo-contract` and
`rate-limit-overrides-repo-contract` pass in isolation, 42 of 42, while
`dist-reading-suites-have-fresh-artifacts` reads artifacts against Astro pages they are editing.
Only the four stub files are mine, and only those are committed.

---

## V-1306 — the guarded copy was repaired and the unguarded one kept the defect

`TeamMembersRepo` is the fourth fixture pair read. Its `acceptInviteAtomic` is the compare-and-swap
that decides who joins an account.

**The authority checks agree.** The local stub compares the presented token hash against the
invite's, refuses an already-accepted invite, and sources role, invited-at and inviter from the
consumed invite rather than from the caller. Nothing it admits differs from the shared double.

**The returned row does not.** On the EXISTING-member path the stub returned `existing` — the stored
row, carrying the address the membership was created with. Production has no `member_email` column:
it returns `attachMemberEmail(row, input.memberEmail)`, so the address is always the one just
presented. That is the defect V-1278 found and fixed in the shared double, and this copy kept it.
**The guarded fixture was repaired; the unguarded one, implementing the same interface, was not** —
the concrete form of the blind spot V-1298 measured.

**Prospective, not demonstrated.** No arm in that file calls `acceptInviteAtomic` — the only
occurrence is the stub's own definition. The divergence was unreachable, so nothing was masked. Same
category as V-1305, not V-1304.

**Hit rate, since it should govern how much the next pass invests.** Four pairs read:

```
ApiKeysRepo      agreed on all nine shared methods — reading it produced a seventh aliasing form
MfaRepo          restated `nextRevision` five times; counterfactual PROVED it masked a regression
page defaults    four stubs restated a page size; counterfactual showed nothing masked
TeamMembersRepo  reproduced a defect already fixed in the shared double; unreachable, masking nil
```

One demonstrated finding in four pairs, the other three real but prospective. Reading a pair costs
minutes; that ratio justifies working through the remaining ten and does not justify a sweep that
rewrites every stub unread.

### An operational incident, recorded because it cost this entry once

This entry was written, formatted, and then **lost before it was ever committed**. A peer committed
in the shared worktree while it sat unstaged; their `lint-staged` run opens with _"Backing up
original state in git stash"_, which captures the whole working tree — including an unstaged edit to
a file they never touched — and the restore did not bring it back. It is not in `HEAD`, not in either
surviving stash, and not in any dangling blob or commit: `git fsck --lost-found` finds nothing
carrying the text.

Nothing was corrupted and no committed work was at risk; the cost was one re-write. The lesson is
narrow and practical: in a worktree with a concurrent committer, an append to a shared file should be
committed in the same breath as it is written, not left unstaged across another agent's hook. The
same applies to the earlier habit of preparing an edit and applying it later — that window is exactly
what closed on this file.

---

## V-1307 — three more pairs read, all clean, and a triage that says which of the rest are worth reading

Continuing the fixture-pair enumeration. Three read in full, five triaged.

**WebhooksRepo — a specific hypothesis, retracted.** V-1274c found the SHARED double incrementing
`consecutiveFailures` on the retry path, which production deliberately does not, and the obvious
worry was that the local stub kept the pre-fix behaviour — the V-1306 shape exactly. It did not: its
`recordDelivered`, `recordRetry` and `recordDlq` are pure no-ops, commented as satisfying the
interface for a create/update suite that never drives them. A no-op cannot be calibrated on a wrong
counter. Clean by absence rather than by fidelity, which is worth distinguishing.

**UsageRepo — clean.** The shared double imports `INTERNAL_RECORD_TYPES` and
`LIFECYCLE_DERIVED_RECORD_TYPE`; the local stubs do not. But they do not restate the exclusion rule
either — `session_minute` appears in them as a fixture VALUE (totals keys, expected numbers), with
the filtering left to the service under test. A literal in a fixture is not a policy copy.

**StatusSubscribersRepo — semantics identical.** Eleven methods implemented for real on both sides.
`markConfirmed` performs the same compare-and-swap on `(id, expectedConfirmTokenHash)` and the same
five field writes in both. The only divergence is that the shared double returns `snap(row)` where
the local returns the stored row — the aliasing shape V-1301 already measured across these files and
declined to fix, with no arm depending on it.

**Triage of the remaining pairs, because reading them is not uniformly worth it.** Counting methods
implemented by BOTH fixtures, and how many local implementations are pure no-ops:

```
StatusSubscribersRepo    11 shared   0 no-ops   read — done above, clean
ValidationSchedulesRepo   6 shared   0 no-ops   worth reading
ScheduledJobsRepo         7 shared   2 no-ops   worth reading
AccountAuthRepo          10 shared   9 no-ops   little to diverge
LegalRepo                 0 shared   —          nothing in common to compare
```

A stub that no-ops a method cannot disagree with production about it, and a pair with nothing in
common cannot disagree at all. That leaves two pairs genuinely worth reading rather than eight, which
is the useful output of this batch.

Seven pairs read now: one demonstrated regression-mask, two real-but-prospective, four clean.

---

## V-1308 — the two pairs the triage flagged, both clean, and the enumeration's shape

V-1307's triage said only two of the remaining pairs were worth reading. Both were, and both are
clean — which is the triage working rather than a wasted pass.

**ScheduledJobsRepo — clean by design.** The shared double's `claimDue` models the real query: skip
completed and failed rows, skip a job whose lock is still fresh against `SCHEDULED_JOB_STALE_LOCK_MS`,
sort by `runAt` BEFORE applying the batch limit (V-1213 fixed the reverse, which starved the oldest
job under a backlog), then claim and bump attempts. The local stub is a canned queue —
`claimDue: () => { const batch = due; due = []; return batch; }` — so the service test controls what
arrives. It models no lock, no ordering and no filter, and therefore cannot disagree about any of
them. The stale-lock window is not restated anywhere in it.

**ValidationSchedulesRepo — semantics identical.** `findDue` applies the same predicate
(`enabled && nextRunAt <= now`), the same sort and the same slice on both sides. `markRun` computes
`now + cadenceSeconds * 1000` in production, in the shared double, and in the local stub alike — and
that `* 1000` is milliseconds-per-second, already carried in the numeric guard's `SHARED_UNITS` with
exactly that reason. A unit shared three ways is not a policy restated three ways.

**Where the enumeration stands.** Nine pairs read in full, four more read for their constants during
the V-1305 scan, and three triaged as unable to diverge:

```
demonstrated   1   MfaRepo — restated revision rule, counterfactual proved it masked a regression
prospective    2   page defaults in four stubs; TeamMembersRepo's member-email path
clean          6   ApiKeys, Webhooks, Usage, StatusSubscribers, ScheduledJobs, ValidationSchedules
unable         3   LegalRepo (no methods in common), AccountAuth (9 of 11 no-ops), plus no-op paths
```

`ApiKeysRepo` is filed clean and still earned its read: comparing it is what surfaced the seventh
aliasing form (V-1303). The pairs that remain genuinely unread are `PricingRepo` and
`AccountAuditRepo`.

One in nine demonstrated is a real rate for this kind of work, and the honest reading of it is that
the file-local stub population is in better shape than V-1298 implied — the blind spot is real, the
defects behind it are mostly not.

---

## V-1309 — the fixture-pair enumeration finished: sixteen of sixteen

The last two pairs, and the close of the sweep V-1303 started.

**AccountAuditRepo — identical.** `countActionsSince` applies the same three predicates in production
and in both fixtures, and crucially the same BOUNDARY: `gte(timestamp, since)` in the Drizzle query,
`timestamp >= since` in each double. An inclusive-versus-exclusive window is the classic way a
windowed count diverges, and it does not here.

**PricingRepo — clean, and the reason is a design worth naming.** The "local stub" is not a fixture
at all: it is a pair of failure injectors — `listAll: () => Promise.reject(new Error('db down'))` —
used to drive error handling, while the happy path in the same file calls the SHARED double directly.
A stub that only ever rejects cannot disagree with production about behaviour. This is the pattern
the other files could have used, and where it is used the whole class of divergence does not arise.

**All sixteen pairs, closed:**

```
demonstrated  1   MfaRepo — restated `nextRevision`; counterfactual proved it masked a regression
prospective   2   page defaults across four stubs; TeamMembersRepo's member-email path
clean         8   ApiKeys, Webhooks, Usage, StatusSubscribers, ScheduledJobs,
                  ValidationSchedules, AccountAudit, Pricing
unable        3   LegalRepo (nothing in common), AccountAuth (9 of 11 no-ops), no-op paths
undercut      2   Profiles and ProfileSnapshots — read for constants in V-1305, and their
                  behaviour is exercised through the shared double by their own suites
```

**What the sweep is worth, stated as a rate rather than a claim.** One demonstrated regression-mask
in sixteen pairs, from roughly a turn and a half of reading. The other fifteen produced two
prospective fixes, one new aliasing form found while reading a pair that turned out clean, and a
triage rule that saved reading six of them at all: a stub that no-ops a method cannot disagree about
it, and a stub that only rejects cannot disagree at all.

The blind spot V-1298 measured — 37 file-local stubs outside every guard — is real and stays real.
What this sweep establishes is that it was not hiding much: the population is mostly no-ops, failure
injectors, and canned queues, none of which can drift, and the one place it did hide something was
found and proved. That is a better answer than either "sweep them all" or "assume they are fine",
and it took reading them to earn it.
