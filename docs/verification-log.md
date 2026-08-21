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
