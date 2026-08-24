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

---

## V-1310 — the collected-files pin is one behind, and it is not mine to move

The full suite is green at **3168 files, 31306 passed | 16 skipped**. `EXPECTED_TEST_FILES_ALL` is
**3167**.

The extra file is `apps/gui-client/tests/unit/a-proxy-is-tested-against-the-registry-not-the-draft.test.tsx`,
added by `88b9a976e` — _"Guard the add-time proxy probe against the row it is supposed to test"_ — a
peer commit that did not raise the pin alongside it.

**Nothing is failing, and the distinction matters.** `judge()` only reports a problem when
`collected < expectedFiles`; a surplus passes silently. So the gate is not broken — it is WEAKENED by
exactly one. Its purpose is that a worker dying, or a file failing to collect, shows up as a smaller
count rather than as a green run over less code. With the pin one behind, the first file that
silently stops collecting is absorbed and reported as healthy.

**Not fixed here, deliberately.** The standing rule is to raise these pins only for files this agent
adds, never to absorb a peer's — because a pin quietly moved by whoever noticed last stops recording
who added what, and the bump belongs in the same commit as the file for exactly the reason the pin
exists. Recorded instead, with the commit named, so it is visible and attributable rather than
silently corrected.

Both agents commit under `Driftstack <dev@driftstack.dev>`, so this is attributed by content and
timing, as V-1300 established it must be.

---

## V-1311 — a scoping correction: the parity apparatus covers 28 of 47 repos, not all of them

Chasing `session_operations_one_live_per_session` — a partial unique index enforcing at most one
LIVE operation per session — turned up something larger than the constraint. `session-operations-repo`
has no shared double at all, so it was never in the paired population any of this campaign's
measurements ran over.

**Measured: 19 of 47 production Drizzle repos have no shared double.**

```
account-deletion-purge  account-proxies  agent-decomposer-usage-recorder  agent-sessions
agent-turn-receipts     atlas-priority-events  audit-archive  bundled-llm  byok-anthropic
byok-anthropic-rotation-reminder  cost-nightly-accounts-provider  crypto-orders  fleet-nodes
health-probes  oauth-store  recipes  retention-scrub  session-operations
webhook-rotation-reminder
```

That reframes numbers this log has been quoting. "198 paired methods", "every paired method is
reached by a test", "zero never-tested" — all true, and all scoped to the **28 repos that have a
double**. The parity apparatus this campaign built — the contracts, the aliasing guard, the cursor
guard, the counter helper, the restated-set rules — applies to those 28. It says nothing about the
other 19, and I have been reporting its results without that qualifier.

**No coverage hole behind it, and an existing guard is why.** Every one of the 19 is driven against
real Postgres by an integration test. `every-drizzle-repo-is-driven-against-a-real-postgres` already
enforces exactly that — its first arm is _"every repo class is constructed by some integration
test"_ — across all integration tests, and its third arm requires every `src/db/*.ts` to either
carry a repo class or sit on a reviewed no-persistence list. The classification is complete by
construction.

**And one false negative of my own, worth recording.** My first pass reported
`atlas-priority-events-repo` as having no Drizzle test at all. It has one —
`atlas-priority-events-end-to-end.test.ts`, which probes `DATABASE_URL`, constructs
`DrizzleAtlasPriorityEventsRepo`, and skips gracefully when the database is unreachable. The detector
only scanned files named `db-*.test.ts`, and that repo's coverage is an end-to-end file. A prefix is
not a population, which is the same mistake in a new costume: V-1288's pairing dropped a double for
its filename, and this dropped a test for its filename.

Nothing to fix. The 19 are covered where it matters and guarded for the thing that would matter if
they were not; what changes is the scope this log claims for its own results.

---

## V-1312 — the two constraint-backed concurrency fences, both thoroughly covered

V-1311 was a scoping correction; this is the substantive half of the same thread. Both constraints
that prompted it are enforced by Postgres and exercised against it.

**`session_operations_one_live_per_session` — covered past the point of doubt.**
`db-session-operations-fences` drives every branch the schema declares, against a real database and
with a reachability arm so a green cannot mean "no database":

```
FENCE 1  concurrent admissions on one session produce exactly ONE operation
FENCE 1  the exclusion is on LIVE rows only — a session runs another once the first settles
FENCE 2  a retry with the same Idempotency-Key returns the SAME operation, no second row
FENCE 2  scoped per account — two customers sharing a key each get their own operation
FENCE 2  in isolation — a retry AFTER settle still replays rather than resubmitting credentials
FENCE 2  same key, DIFFERENT body is a conflict, never a silent replay of the wrong request
FENCE 3  a result from a SUPERSEDED driver incarnation is discarded, not applied
FENCE 3  terminal is terminal — one settle wins a race, losers do not overwrite
```

The partial index — unique on `session_id` WHERE status IN ('queued','running') — is what makes
"one live operation" true under concurrency rather than by convention, and the first two arms are
its direct test.

**`crypto_orders_idempotency_key_unique` — handled by ON CONFLICT, and tested.** The repo writes
through `onConflictDoNothing` targeted at the idempotency key, guarded `WHERE idempotency_key IS NOT
NULL`, then re-reads by the SCOPED key. That is V-1302's second mechanism rather than a translated
violation, and it is exercised by a dedicated per-account namespacing test plus four Drizzle
integration files covering sweep ordering, entitlement reconcile and lock exclusivity.

Neither needed anything. Recorded because the thread began by asking whether a constraint with no
double behind it was being taken on trust, and the answer is that these two are the best-tested
invariants I have read in this repository — the coverage lives in integration tests against real
Postgres, which is exactly where a constraint's behaviour can actually be observed.

---

## V-1313 — every skipped test in a full run, enumerated: sixteen, all legitimate

A test that does not run is a claim nobody is checking, and a full run reports sixteen skipped. The
`no-permanently-skipped-tests` guard already proves none is UNCONDITIONAL; this asks the next
question — whether each condition still holds — because a conditional skip whose condition went stale
is dormant coverage that reports as green.

```
6   gui-jsdom  profiles-lifecycle-actions   Clone (2) and Import (4), flag-gated
2   node       marketing-egress-claim-sweep
8   node       one arm each across eight doc-parity files
```

**The six GUI skips are self-healing, and the chain was checked end to end.** They read
`describe.skipIf(!CLONE_ENABLED)` / `(!IMPORT_EXPORT_ENABLED)`, and the flags are not restated —
`viewFlag()` reads `const <NAME> = (true|false);` straight out of `ProfilesView.tsx` and THROWS if
the constant has moved. So the flag lives in one place, flipping it un-skips six tests on the next
run with nobody in the loop, and renaming it fails loudly rather than skipping silently. A separate
guard ties each skip to its stated justification. This is the shape the restated-policy findings
elsewhere in this log wish they had.

**The doc-parity skips are inverted, and their precondition is asserted.** They read
`it.skipIf(hasEgressImpl)('does not claim customer-controlled egress while no impl exists')` — a
guard against a PREMATURE marketing claim, which correctly retires once the feature ships. The
obvious worry is that retiring leaves the claim unverified. It does not: the same file carries a
CRITICAL arm asserting the gate was computed and HAS retired — `expect(hasEgressImpl).toBe(true)` —
so the reason for the skip is itself under test. Its header records why: an earlier version branched
on the gate INSIDE the test body, so once egress shipped "the arm below asserted nothing while
reporting as a pass".

Nothing to fix. Recorded because "16 skipped" appears in every run summary in this log and has never
been broken down, and because the two mechanisms found here — a flag read from its single home, and
a skip whose precondition is asserted — are the two ways to make a conditional skip trustworthy
rather than merely permitted.

## V-1314 — the published-SDK suite reached five of nine resources; the envelope it guards differs on the one it skipped

`sdk-typescript-against-the-real-server.test.ts` imports the SDK by package name, so it exercises
the built `dist/` against a real server — the only place the published artifact is checked end to
end. Its own header names the risk it exists to catch: both list responses "key their rows under
`data`, and an SDK reading `items` would return undefined against a perfectly healthy server".

That risk is per-resource, and the suite reached five call sites: `account.me`, `apiKeys.create`,
`apiKeys.list`, `archetypes.list`, `sessions.list`. Not reached: `profiles`, `webhooks`, `usage`,
`recipes`. Two of those matter for the stated risk:

- **`profiles.list`** is the listing customers reach for first, and its envelope is built
  independently of the sessions one (`routes/profiles.ts` versus `routes/sessions.ts`). One route
  proving the shape does not prove the other.
- **`usage.series` is the response where the shape genuinely differs.** It keys its rows under
  `buckets` and carries `from_date`/`to_date` instead of a cursor. It is the single endpoint where
  applying the pagination envelope would be wrong — so it is the one endpoint where the mistake the
  suite guards against cannot be caught by the guard as it stood.

Three arms added. `usage.current` came with them because its `totals`/`quotas` are records keyed by
record type, and an SDK treating either as a list reads `length` off an object and reports zero
usage against a real bill.

**A weak assertion caught before it was committed.** The first draft asserted
`typeof summary.totals === 'object'`, which an ARRAY satisfies — precisely the confusion the arm's
own comment describes. Mutating the route to `Object.values(s.totals)` would have passed it. The
assertion is now `Array.isArray(...) === false`, and that mutation fails it.

Each arm mutation-proven against the route that builds the response, one at a time:

| mutation (production route)                     | arm that failed                        |
| ----------------------------------------------- | -------------------------------------- |
| `buckets: series.buckets` → `data:`             | `daily rows come back under 'buckets'` |
| `data: page.data.map(publicProfile)` → `items:` | `profile rows come back under 'data'`  |
| `totals: s.totals` → `Object.values(s.totals)`  | `totals is a RECORD ..., not a list`   |

Each mutation failed exactly its own arm and nothing else; every route file was restored
byte-identical from a snapshot. The series arm also carries the negative — the paginated envelope is
NOT what that endpoint returns — which held under all three.

Where `/v1/usage` and `/v1/usage/series` live is worth recording: `routes/admin.ts`, despite the
name. Grepping `routes/usage*.ts` finds nothing and the file does not exist.

Still not round-tripped through the published SDK: `webhooks`, `recipes`, and the profiles/webhooks
write paths. Named rather than left implied.

## V-1315 — the Python live-contract header overstated how much of that SDK validates: 48 of 276

Extending V-1314 to the other two published SDKs surfaced a documentation defect first.

`test_live_contract.py`'s header justified the file's existence on the claim that every resource
method funnels its 2xx body through `parse_model`, so a shape mismatch is an exception in the
customer's process rather than a silent degradation. Measured twice — once with a regex sweep, once
with Python's `ast` module over `src/driftstack/resources`, both agreeing exactly — **48 of 276
public resource methods parse into a model. The other 228 return the decoded JSON as an unvalidated
`dict[str, Any]`.**

The file's own first arm shows it: `test_authenticates_against_an_authed_route` calls
`client.account.me()` and asserts `isinstance(me, dict)`, because that method does not parse. The
arms were right; the header describing them was not.

The consequence runs the opposite way from how the header read. For 82% of the surface — including
`account.me`, `profiles.list` and `usage.series` — drift is exactly as silent in Python as in
TypeScript: the caller gets a dict without the key it expected and finds out at their own access
site. An engineer reading the old text would believe pydantic was standing behind calls it never
touches. Header rewritten with the measurement, and it now says which kind each arm is: where a
method parses, "no exception" is itself the assertion; where it does not, only an explicit field
check notices.

**Coverage, the reason for looking.** Both live contracts reached the same three resources as the
TypeScript one did before V-1314 — `account.me`, `archetypes.list`, `sessions.list` — so neither
reached `profiles` or the one endpoint whose envelope genuinely differs. Two arms added to each:

- `profiles.list` — its own route builds its own envelope; the sessions arm proves nothing about it.
- `usage.series` — rows under `buckets`, `from_date`/`to_date` instead of a cursor.

Go needs these for a reason of its own: `encoding/json` leaves a field whose tag stopped matching at
its zero value and returns **no error**, so `err == nil` passes on a body that filled in nothing.
Both Go arms assert emptiness, matching the pattern the existing arms already established.

All four proven by mutating the route that builds the response — `buckets:` → `data:` and
`data:` → `items:` — with the markers printed before the run. Each failed exactly its own arm in
both languages (`TestLiveProfilesPageDecodes`, `TestLiveUsageSeriesDecodes`,
`test_profiles_page_envelope`, `test_usage_series_is_the_envelope_that_differs`); every other arm
stayed green; both route files restored byte-identical from snapshots.

**The harness floors were exact and were kept exact.** Each harness asserts its live suite ran
rather than skipped, and floors the passing count — the Go one counting `--- PASS`/`--- SKIP` per
test because `go test` prints PASS and exits 0 for a package whose tests all skipped. Both floors
read 4 against 4 actual, so both moved to 6. A floor left at 4 would have gone on passing while two
of the six silently stopped running.

That apparatus was checked before being extended and needed no repair: three harnesses exist, one
per SDK, and both language-side floors were exact. No finding there.

Not round-tripped through any published SDK: `webhooks`, `recipes`, and the profiles/webhooks write
paths. Named rather than left implied.

## V-1316 — the third envelope shape, and a mutation that proved nothing

Closing the gap V-1314 and V-1315 both named rather than leaving it named a third time: `webhooks`
and `recipes` were not round-tripped through any published SDK.

**A third envelope shape exists.** `GET /v1/webhooks` returns `{ data }` and nothing else — no
`has_more`, no `next_cursor` — while sessions, profiles, recipes and deliveries all carry the full
paginated envelope and `/v1/usage/series` carries its own. So the API has three list shapes, not
two. A caller looping until `has_more` goes false reads undefined on the first pass, which is
correct only by accident and would be wrong the day that route learns to paginate. Now pinned in all
three SDKs.

**Recipes turned out to be unreachable, and the reachable thing was better.** The harness builds an
app with the recipes disabled-stub registered (the gate needs both `recipesRepo` and
`agentSessionsRepo`), so `recipes.list()` answers 503. Rather than rewire a builder shared by many
suites, the arm became the one the stub makes available: a deployment gate must surface as the
documented typed error — `FeatureUnavailableError` in TypeScript and Python, `ErrFeatureUnavailable`
via `errors.Is` in Go. That maps a real 503 and a real problem type end to end, where every existing
test of that mapping fed the parser a body a test author wrote.

**A mutation that landed in the file and not in the running system.** Proving the typed-error arm
first tried editing `packages/api-types/src/problem.ts` to corrupt the problem-type URL. The marker
printed, the file changed — and the suite stayed green with only the unrelated webhooks arm failing.
`api-types` resolves to `dist/index.js`, so the server never read the edit. **A marker proves the
file changed, not that the running code did.** Re-proven by mutating the server's own stub
(`FeatureUnavailableError` → `NotFoundError`), which vitest loads from source; the arm then failed
in all three languages.

**A weak assertion caught before commit, again.** The Python webhooks arm first asserted
`not hasattr(page, "has_more")`. But `page` is a parsed model, so it carries the fields the model
declares whatever the body held — the check was true by construction and could not fail from server
drift. Dropped; what the arm proves live is that `data` still maps. The Go side needs no equivalent:
its struct has no such field.

Six arms, each mutation-proven against the route that builds the response, markers printed first:

| mutation                                      | arms that failed                       |
| --------------------------------------------- | -------------------------------------- |
| `data:` → `endpoints:` on `GET /v1/webhooks`  | webhooks arm, all three languages      |
| stub throws `NotFoundError`                   | typed-feature arm, all three languages |
| `has_more: false` added to `GET /v1/webhooks` | the TypeScript bare-shape negative     |

Every other arm stayed green; every route restored byte-identical from a snapshot. Both harness
floors moved 6 → 8, since each was exact and two of eight could otherwise stop running unnoticed.

Live SDK coverage now: account, api-keys, archetypes, sessions, profiles, usage (both shapes),
webhooks, and the disabled-feature path. Still not round-tripped: the profiles and webhooks WRITE
paths, and recipes' actual envelope, which needs a deployment with the feature on.

## V-1317 — pagination's off-by-one boundary: 21 files go red, and 19 of them prove nothing

Every paginated repo overfetches by one and derives `hasMore = rows.length > limit`. The classic
defect is `>=`, which only shows when the final page is exactly FULL — when the row count is an exact
multiple of the limit. Under it the repo hands back a cursor onto a page that does not exist, and the
customer's own paging loop makes one more request and gets nothing.

**The population is 14 sites across 12 repo files**, not the 12 first counted: `head -20` on the
enumeration silently cut `api-keys-repo.ts` and `rate-limit-overrides-repo.ts` below the fold. The
truncation was caught only because the mutation script reported two sites still unmutated. Rule 2
exists for exactly this, and a pipe to `head` defeats it as thoroughly as a wrong pattern does.

**Mutating all 14 to `>=` turned 21 test files red — and 19 of those reds are worthless as evidence.**
Classified by reading each failure rather than counting them:

- **2 behavioural catches.** `db-incidents-truth-drizzle` and `db-profiles-repo-keyset-drizzle` —
  DB-backed, no `readFileSync`, failed on real paging behaviour.
- **13 source-text pins.** Every `db-*-content-parity` and `db-*-cross-source-invariant` file that
  went red reads the repo source with `readFileSync` and matches the literal
  `hasMore = rows.length > opts.limit`. They fired because the TEXT changed. They would fire on a
  correct refactor just as loudly, and if someone updated the pin to match a wrong new text, nothing
  would notice. Freezing a line is not verifying what it does.
- **6 unrelated**, attributed via `git status` before investigating: four are the peer's in-flight
  gui-client and customer-dashboard work, one is the file-count pin against a transient 3001, and
  the V-917 egress gate. All six pass at clean source; none are mine.

So the honest number: **of 14 pagination boundaries, 2 are verified behaviourally and 12 are held
only by text.**

**Route-level tests cannot close this.** `buildTestApp` wires the in-memory doubles, not Drizzle — so
`agent-sessions-routes`, `profiles`, `recipes-routes` and the rest exercise the doubles' paging and
were structurally incapable of seeing a Drizzle mutation. Checked while there: every double derives
its own `hasMore` with `>` too, so the doubles are correct and the route tests are not wrong, merely
aimed elsewhere. Closing this needs DB-backed arms.

**Why the existing DB-backed walks missed it.** They page until the cursor goes null and every one
ends on a SHORT final page — nine rows at limit two leaves one. The exact-multiple case is never
reached, so `>` and `>=` are indistinguishable to them.

One arm added to `db-account-audit-repo-keyset-drizzle.test.ts`, on the harness already there: four
rows, then a page of four (full and last) and a walk of two pages of two (the second exactly full).
Both assert `nextCursor` is null. Mutation-proven — `>` → `>=` in `account-audit-repo.ts` fails the
new arm on the message about a cursor onto an empty page, while both pre-existing arms in the same
file stay green, which is the counterfactual showing they never covered it. Source restored
byte-identical from a snapshot.

**Still uncovered behaviourally, named rather than implied — 11 sites:** `admin-audit-repo`,
`api-keys-repo`, `rate-limit-overrides-repo`, `sessions-repo` (×2), `webhooks-repo` (×2),
`profile-snapshots-repo`, `recipes-repo`, `agent-sessions-repo`, `admin-accounts-repo`. Several have
a `db-*-keyset-drizzle` harness already, so the arm above transfers to them nearly verbatim.

## V-1318 — the boundary arm transfers: two more of the eleven closed

V-1317 left eleven pagination boundaries verified only by source-text pins and noted that several
already have a `db-*-drizzle` harness, so the arm should transfer nearly verbatim. It does.

- **`agent-sessions-repo`** — `db-agent-sessions-page-cursor-drizzle.test.ts` already had
  `seedAccount`/`seedSession` helpers and a `pageThrough` walker. Four sessions, then a page of four
  and a walk of two pages of two.
- **`admin-audit-repo`** — `db-admin-audit-repo-keyset-drizzle.test.ts`, same shape, with the
  `accounts` + `api_keys` FK seeding that file already established.

Both assert the same two things: a page equal to the whole population offers no cursor, and a walk
whose final page is exactly full ends there. Both mutation-proven by flipping that repo's own
`rows.length > limit` to `>=` — each time the new arm failed on the full-final-page message while
every pre-existing arm in the same file stayed green. That counterfactual is the point: it shows the
existing walks never reached the boundary, rather than merely that the new arm works. Both repo files
restored byte-identical from snapshots.

Behaviourally covered boundaries: 5 of 14 (incidents and profiles already, plus account-audit,
agent-sessions, admin-audit).

**Still text-pinned only — 9 sites:** `api-keys-repo`, `rate-limit-overrides-repo`, `sessions-repo`
(×2), `webhooks-repo` (×2), `profile-snapshots-repo`, `recipes-repo`, `admin-accounts-repo`.

## V-1319 — both webhook delivery listings, proven per-occurrence

`webhooks-repo.ts` carries two of the nine boundaries left text-pinned by V-1318, and one fixture
reaches both: the operator DLQ view (`listDlqDeliveries`) and the customer's own delivery log
(`listDeliveriesForEndpoint`) read the same four seeded rows.

One arm on the existing `db-webhooks-dlq-keyset-paging-drizzle.test.ts` harness, which already had
`seedEndpoint`/`seedDelivery`. For each listing: a page the size of the whole population offers no
cursor, and a walk whose second page is exactly full ends there.

**Proven per occurrence rather than together.** Mutating both lines at once would have failed the arm
without showing which half did the work. Each was flipped alone, by line number:

| mutated line                                          | failing assertion                                      |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `webhooks-repo.ts:1083` (`listDlqDeliveries`)         | a full final DLQ page must not offer a cursor          |
| `webhooks-repo.ts:1176` (`listDeliveriesForEndpoint`) | a full final delivery-log page must not offer a cursor |

Each run failed exactly one test with the message belonging to that listing; the other listing's
assertions and all eight pre-existing arms stayed green. Source restored byte-identical from a
snapshot after each.

Behaviourally covered boundaries: 7 of 14.

**Still text-pinned only — 7 sites:** `api-keys-repo`, `rate-limit-overrides-repo`, `sessions-repo`
(×2), `profile-snapshots-repo`, `recipes-repo`, `admin-accounts-repo`.

## V-1320 — four more boundaries, every one proven against its own line

Four of the seven sites V-1319 left text-pinned, on the `db-*-keyset-drizzle` harnesses that already
existed for each:

- **`sessions-repo`, both listings.** One fixture reaches both — the customer's own session list
  (`listSessions`) and the staff-wide one (`listAllSessions`), the latter scoped by `accountId`
  because the `sessions` table is shared with every other suite and only a filtered population is
  exact.
- **`api-keys-repo`** (`listAllApiKeys`) and **`rate-limit-overrides-repo`** (`listAll`), both
  account-scoped for the same reason.

Each arm asserts the same two things: a page the size of the whole population offers no cursor, and
a walk whose final page is exactly full ends there.

**Proven per occurrence, by line number.** The two `sessions-repo` sites are textually identical
lines in one file, so mutating both together would have failed the arm without showing which listing
did the work:

| mutated line                               | failing assertion                                      |
| ------------------------------------------ | ------------------------------------------------------ |
| `sessions-repo.ts:438` (`listSessions`)    | a full final page must not offer a cursor              |
| `sessions-repo.ts:540` (`listAllSessions`) | a full final staff page must not offer a cursor either |
| `api-keys-repo.ts:222`                     | a full final page must not offer a cursor              |
| `rate-limit-overrides-repo.ts:130`         | a full final page must not offer a cursor              |

Every run failed exactly one test, carrying the message belonging to that listing, with all
pre-existing arms in the same file green. Each repo restored byte-identical from a snapshot after
each flip.

Behaviourally covered boundaries: 11 of 14.

**Still text-pinned only — 3 sites:** `profile-snapshots-repo`, `recipes-repo`, `admin-accounts-repo`.

## V-1321 — the pagination boundary class closed: 14 of 14

The last three sites from V-1320.

**`admin-accounts-repo`** took an arm on its existing harness, using the `submarker` fixture already
there to carve an exact four-row population out of a table every other suite writes to. This listing
returns `hasMore` directly rather than deriving it from the cursor, so the arm asserts both.

**`recipes-repo` and `profile-snapshots-repo` had no paging harness to extend.** Both appear in
DB-backed tests only for encryption and tenant scoping, and a pagination arm bolted onto either
would sit outside what those files are about. New file:
`db-paging-boundary-recipes-and-snapshots-drizzle.test.ts`, with the reachability arm these DB files
carry so a silent skip cannot read as a pass.

Each of the three proven by flipping its own repo's `rows.length > limit` to `>=`:

| mutated site                    | failing arm                                       |
| ------------------------------- | ------------------------------------------------- |
| `admin-accounts-repo.ts:99`     | a full final page has no rows behind it           |
| `recipes-repo.ts:266`           | recipes: a page the size of the whole population… |
| `profile-snapshots-repo.ts:127` | profile snapshots: the same boundary              |

Each failed exactly one test and left every sibling green; each repo restored byte-identical.

**All 14 boundaries are now verified behaviourally**, where the class began at 2. The other 12 reds
the original sweep produced were source-text pins, which fire when the line changes and say nothing
about what it computes.

**The ratchets moved by one, not two.** Disk collects 3002 test files; the pin stood at 3000. Two
files were added — mine and a peer's `abandoned-crypto-orders-are-actually-swept.test.ts`, still
untracked in the shared worktree. `EXPECTED_TEST_FILES` goes to 3001 and `_ALL` to 3168, my share
only. The exact-match arm in `scripts/tests/verify-suite.test.ts` therefore reads 3001 against a disk
of 3002 and is RED until the peer commits their file with their own bump. That is the correct
outcome rather than a problem to route around: absorbing another writer's count is how a pin stops
meaning anything, and the arithmetic — 3002 minus the 3000 baseline, one file each — is what shows
3001 is exactly mine.

## V-1322 — a second frozen occurrence I missed: adding a DB-gated test file moves a stated share

The new file in V-1321 gates on `DATABASE_URL`, and the count of files that do is written in prose
inside `scripts/verify-suite.mjs` — "130 test files gate on `DATABASE_URL`" — which
`a-gate-that-does-not-name-its-blind-spot-reads-as-total.test.ts` parses with a regex and holds
against a live walk of `apps`. Adding one DB-gated file made it 131 and the gate went red.

Bumped to 131 in the same breath as noticing.

**The miss is the finding.** Rule 2 says enumerate every frozen occurrence with both patterns, and I
ran that enumeration against the thing I was CHANGING — the fourteen boundary sites — rather than
against the thing I was ADDING. A new test file has frozen occurrences of its own: the two
`EXPECTED_TEST_FILES` ratchets (which I did move) and this stated share (which I did not). The
question to ask when adding a file is not only "what does this file touch" but "what counts this
file into a total".

Attribution of the other two reds in the same run, checked before investigating:
`job-chain-liveness.test.ts` expects 16 job names against 15 — the peer is mid-edit on
`src/services/job-chain-liveness.ts` and its test, and has added
`crypto-order-expiry-sweep-job.ts` untracked. `verify-suite.test.ts` is the count pin at 3001
against a disk of 3002, which is their untracked test file and stays theirs to bump.

## V-1323 — the imperative limit bound, measured then closed

**The sweep that led here.** Five repos cap their own page size with `Math.min(limit, MAX)`.
Neutralising all five ceilings at once — replacing each MAX with 100000, which isolates the cap from
the default — turned 14 files red. Unlike the pagination boundary, this class is in good shape: six
of the catches are behavioural (`admin-accounts-list-repo-contract`, `db-admin-accounts-repo-drizzle`,
`db-profiles-repo-keyset-drizzle`, `db-recipes-encryption-drizzle`,
`db-profile-snapshot-restore-dek-drizzle`, `profile-snapshot-parentage-repo-contract`), none of them
reading source. Four of the five caps are covered that way. The fifth,
`atlas-priority-events-repo`, was caught by nothing — but its route declares the same 1000 ceiling in
Zod, so the repo cap is a second line rather than the only one. Recorded, not repaired.

**A hypothesis raised and retracted.** Three route schemas declare `limit` as
`z.string().regex(/^\d+$/)` with no numeric bound — including `/v1/billing/crypto-orders`, which is
customer-facing. That reads like an unbounded page. It is not: all three refuse out-of-range values
in code immediately after parsing, at 100, 200 and 1000, and each ceiling matches the message it
returns. Verified by reading all three rather than inferring from the schema.

**What was actually missing.** `openapi-admin-list-limit-bounds-parity.test.ts` compares the
spec-advertised `limit` max against the route-enforced one — the drift that once had
`/v1/admin/accounts` advertising 200 while the route enforced 100, so an integrator sending 150 got a 400. Its extractor reads a declared Zod `max(N)`, and its own header named the gap: an endpoint
bounding imperatively is invisible to it, spec and route agreed by hand-check, and nothing would
notice if they stopped. The yield was measured before the work — all three agree today — so this
closes a gap rather than fixing a live defect.

Three endpoints added, each compared two ways:

- **spec ↔ enforced**, the original invariant.
- **enforced ↔ the refusal message**, which is new. These bounds carry their ceiling twice, and a
  route refusing above 200 while telling the caller the limit is 500 misinforms the integrator just
  as surely as spec drift. The message is the part they actually read.

One is `/v1/billing/crypto-orders`, a CUSTOMER path — outside this file's admin-scoped completeness
arm, so it would have stayed uncovered even had the extractor learned imperative bounds.

**A defect in the existing extractor, found by using it.** `specLimitMax` matched only the
single-line Zod chain, so it returned null for `/v1/billing/crypto-orders`, whose declaration
prettier had wrapped across six lines once it grew a `.describe(...)`. Null reads as "no bound"
unless the caller asserts otherwise; every arm does, so this surfaced as a failure rather than a
silent pass. The pattern is now whitespace-tolerant, and the six pre-existing admin arms still read
the same numbers, which is what shows the change did not loosen them.

Mutation-proven, each restored byte-identical:

| mutation                                                | result                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `n > 100` → `n > 250` in the customer route             | 2 fail: spec-parity AND the message arm — the condition moved away from both |
| the message alone says 500, still refuses above 100     | 1 fails: only the message arm, isolating it                                  |
| a fourth imperative marker added to `admin-sessions.ts` | completeness arm fails, naming the file and its count                        |

## V-1324 — the guard's own reader could borrow a neighbour's number

Extending the limit-bounds guard in V-1323 meant using its spec extractor on new anchors, and using
it is what exposed two ways it can return the wrong answer. Both were latent — no entry in the table
hit either — so both would have stayed invisible until someone added the endpoint that did.

**It could read a bound belonging to a different endpoint.** An inline path block was sliced from its
`path: '…'` to the next `registerRoute(`. Named query consts are declared BETWEEN routes, so that
slice swallows one. `/v1/admin/usage/accounts/{id}` publishes no `limit` at all and resolved to
**1000** — the atlas queue's bound, declared in the const sitting between it and the next route. This
is the worse of the two failures: every arm asserts against null, so a missing bound is caught, while
a borrowed one simply agrees with whatever it was compared to.

**It could miss a bound that is published.** The anchor was resolved with `indexOf`, taking the first
block. A path registered under two methods has two: `/v1/recipes` is both the create and the list,
and the create carries no query. First-match therefore read "no bound" for an endpoint advertising 100.

Both fixed — the slice now also terminates at the next named query const, and every block for an
anchor is collected with the matches required to agree (differing maxima throw rather than picking
one). The six pre-existing admin arms still read the same numbers, which is what shows the change
tightened the reader without loosening them.

Two arms added, pinned to the real spec paths that exhibit each failure, and each proven by reverting
its own fix:

| mutation                        | failing arm                                                |
| ------------------------------- | ---------------------------------------------------------- |
| named-const terminator removed  | a path with no limit borrowed a neighbouring bound         |
| loop reduced to the first block | a multi-method path did not resolve to its published limit |

Each failed exactly one arm with the other fifteen green.

**A measurement error of mine, retracted before it became a claim.** The sweep that found this
started with a script that sliced each spec block from one `path:` to the next, which reported
`/v1/admin/usage/accounts/{id}` as advertising a limit of 1000 while its route file contains no
`limit` at all — reading like a live spec/route mismatch. It was my slice over-reaching, not a
defect. Checking the block before writing it down turned a false finding into a real one about the
instrument: the guard's own reader had the same over-reach, which is the part that mattered.

## V-1325 — two classes swept, both already covered, and a filter with a 100% false-positive rate

Neither sweep found a defect. Recording what was measured, because "we looked" is only worth
anything if what was looked at is written down.

**Conflict-handling clauses.** Eight `.onConflictDoNothing(...)` calls guard idempotency where a
customer feels the failure: duplicate billing emails keyed on the Stripe event, replayed Stripe
webhooks, double crypto entitlements, retried usage records, agent turn receipts, session operations,
incident creation, crypto orders. Removing all eight — a paren-balanced strip, tsc clean afterwards —
turned 19 files red, and the behavioural ones map one-to-one onto the eight sites:

| site                                     | behavioural test that caught it                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `account-lifecycle-repo.ts:63`           | `db-account-lifecycle-repo-billing-claim-drizzle`, `lifecycle-email-claim-repo-contract` |
| `session-operations-repo.ts:96`          | `db-session-operations-fences`                                                           |
| `agent-turn-receipts-repo.ts:83`         | `db-agent-turn-receipts-drizzle`                                                         |
| `incidents-repo.ts:143`                  | `db-incidents-truth-drizzle`                                                             |
| `crypto-orders-repo.ts:133`              | `db-crypto-orders-sweep-ordering-drizzle`                                                |
| `agent-decomposer-usage-recorder.ts:102` | `db-usage-record-retry-idempotency`                                                      |
| `stripe-webhooks-repo.ts:41`             | `db-stripe-event-idempotency-drizzle`, `stripe-webhooks-repo-contract`                   |
| `stripe-webhooks-repo.ts:408`            | `db-crypto-entitlements-drizzle`                                                         |

Every site has a DB-backed test of its own. Unlike the pagination boundary, this class needed
nothing. Source restored byte-identical.

**Vacuous guards — and the instrument was the story.** A guard that derives a set and asserts it is
empty passes whether the violation is absent or the SCAN is broken. Filtering for that shape:
412 files assert `toEqual([])`; 108 carry no numeric floor; 24 of those build their set from a regex
over source; 9 survive once a non-empty set-equality counts as a floor too.

Four of the nine were read. **All four were protected, and none of them by the shape being filtered
for.** The floor takes at least four forms here:

- a numeric floor (`toBeGreaterThan`) — the only one the filter knew;
- an exact-set equality, where an empty scan fails because the set is pinned —
  `unscoped-lookup-containment-invariant` pins the two known unscoped lookups;
- a symmetric difference against a pinned roster, where an empty scan reports the whole roster
  missing — `admin-scope-refusal-coverage`;
- an instrument self-test naming a specific finding the scan must produce —
  `a-published-route-that-can-never-succeed-is-listed` asserts the segment walk reports 1 rather than
  7, and `a-customer-doc-may-not-cite-a-file-that-does-not-exist` names a citation that must be
  found "rather than counting how many were".

So the useful output is about the filter, not the code: **a sweep for vacuity that looks only for a
numeric floor produces false positives at a rate near 100% in this repo**, because the repo defends
the class four different ways. The five unread candidates are named here rather than implied:
`docs-internal-postmark-approval-request-content-parity`, `legal-refunds-doc-parity`,
`gui-flag-gated-suites-track-their-flag`, `v2-12-error-kind-catalog-parity`,
`pricing-comparison-doc-parity`, `webhook-backoff-schedule-agrees-everywhere`.

## V-1326 — the write paths the live SDK suite never reached, named twice and now closed

V-1314 and V-1316 both ended by naming the same remaining gap: the profiles and webhooks WRITE paths
were not round-tripped through the published SDK. Naming a gap twice and leaving it is how it becomes
permanent.

The suite had one write arm, `apiKeys.create`. Two more:

- **`profiles.create`** — the resource customers create first, and its create response is assembled
  in its own route, so the api-keys arm proves nothing about it. Creates, checks the name it sent
  came back, then finds the row through `profiles.list`.
- **`webhooks.create`** — this one carries the same class of field as the api-key plaintext. The
  signing secret is returned ONCE and is not retrievable afterwards, so an SDK that dropped or
  renamed it hands the customer an endpoint whose deliveries they can never verify, with no retry
  that recovers it. The endpoint is created successfully either way, which is what makes the loss
  silent: nothing else in the system reports it.

Both mutation-proven against the route that builds the response, markers printed first:

| mutation                                                                        | failing assertion                       |
| ------------------------------------------------------------------------------- | --------------------------------------- |
| `webhooks.ts:150` — the create response drops `secret: created.plaintextSecret` | the one-time signing secret is surfaced |
| `profiles.ts:174` — the create echoes `'mutated'` instead of the name sent      | the name the caller sent came back      |

Each failed exactly one arm, the other eleven green, both routes restored byte-identical.

Live SDK coverage is now: account, api-keys (read + write), archetypes, sessions, profiles (read +
write), usage (both envelope shapes), webhooks (read + write), and the disabled-feature typed error.
Still not round-tripped: recipes' real envelope, which needs a deployment with the feature enabled —
the harness registers the disabled stub, and that stub's 503 is itself covered.

## V-1327 — the other two live contracts performed no write at all

V-1326 closed the write gap in the TypeScript live suite. The Python and Go contracts had eight arms
each and **every one of them was a read** — account, archetypes, sessions, profiles, usage, webhooks,
the paginated envelope, the typed errors. Nothing in either file had ever sent a body to the real
server.

One write arm each, on `api_keys.create` / `APIKeys.Create`, which carries the field with the
sharpest consequence: `plaintext` is surfaced once and is not retrievable afterwards, so an SDK that
drops or renames it hands back a key nobody can use and no retry recovers.

The two languages fail differently, which is why each needs its own arm rather than one standing for
both:

- **Python** parses the create response into a model — `api_keys.create` is one of the 48 methods
  that do (V-1315) — so a response the models cannot describe raises inside the customer's process on
  a call that SUCCEEDED. For a create that is worse than for a read: the key exists by then, and the
  plaintext is gone with the exception.
- **Go** reports no error at all for a tag that stopped matching; the field decodes to the empty
  string. Only the length check notices, which is why the arm asserts on the value rather than on
  `err == nil`.

Proven by dropping `plaintext: created.plaintext` from the create response in `routes/admin.ts`,
marker printed first. Both new arms failed — `TestLiveWriteRoundTripsAndSurfacesThePlaintext` and
`test_a_write_round_trips_and_surfaces_the_one_time_plaintext` — with every read arm on both sides
still green, and the route restored byte-identical.

Both harness floors moved 8 → 9. Each was exact, so leaving them would let the new arm stop running
unnoticed.

All three published SDKs now round-trip a write against a real server. Still not round-tripped
anywhere: recipes' real envelope, which needs a deployment with the feature enabled.

## V-1328 — fifteen tests passing against a database that does not exist

A DB-backed suite failed during a full run with "postgres reachable and the table present: expected
false to be true", then passed alone. Contention, not an outage — but it raised the question the
flake only hints at: **when the probe fails, do the other DB suites say so, or do they go quiet?**
Because the same pressure that failed one file loudly would make the quiet ones pass having verified
nothing.

172 test files open a Postgres probe with `connect_timeout: 2`; the server allows 100 connections.

**The classification took four attempts, and the first three were wrong.** Searching for
`expect(dbReachable)` said 62 files were unguarded. Adding the `process.env.CI` throw idiom said 61.
Matching on arm titles mentioning reachability said 19. Every candidate checked by hand at each stage
turned out to be protected — by a differently-named variable, by a helper called `unusable()` that
throws in CI, by an arm whose title says "vacuously" instead. Only a filter requiring the absence of
BOTH idioms got to a set small enough to read, and that set was **2**.

That is the fourth time today a single-pattern sweep over-reported a gap in this repo, and the
lesson has stopped being incidental: **this codebase expresses the same protection in many idioms, so
any grep for "files lacking X" is an upper bound, never a finding.** The finding is whatever survives
reading them.

**The two that survived were real, and proven rather than argued.** Pointing `DATABASE_URL` at a dead
port with `CI` set, then running both files: **15 tests passed, 0 failed.** Against a database that
does not exist, in the mode where an absent database is a broken job rather than a legitimate skip.

- `database-check-enums-agree-with-the-code` routes every arm through `guardUnreachable()`, which
  emits `console.warn` and returns. A console warning is not a test result. The file already reasons
  about vacuity for its PARSE — one arm exists because "a parse that recovered no values would report
  all ten enumerations verified having read none of them" — and had the identical hole one level
  down, at the connection.
- `atlas-priority-events-end-to-end` opens every arm with `if (!app) return;`, and `app` stays null
  when the probe or the table check fails.

One arm each, in the idiom the other 170 already use: quiet locally where an absent database is
legitimate, loud in CI where it is not. After: the healthy run is 17 green, and the dead-port CI run
fails exactly the two new arms — the same 15 that used to pass in silence now report nothing new,
which is correct, because they still cannot run.

## V-1329 — the whole corpus checked by counterfactual: 176 of 181 fail when the database is gone

V-1328 found two vacuous DB suites by narrowing a grep four times and reading the survivors. That
works but it is the wrong instrument, and the entry said so. This is the right one: **break the thing
the guards guard, and see who notices.** `DATABASE_URL` at a dead port, `CI` set, the whole node
project.

Population first, and deliberately wider than the obvious pattern: 172 files open a probe with
`connect_timeout: 2`, and **9 more reach Postgres by another route** — the same many-idioms problem
that made the greps in V-1328 wrong three times running. 181 files total.

**176 of the 181 failed.** The five that passed do not connect at all:

| file                                   | why it legitimately passes                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `db-fleet-nodes-list-livekit-orderby`  | builds the query and asserts on `.toSQL()`; its own comment says no connection is opened |
| `db-client-cross-source-invariant`     | reads source                                                                             |
| `e2e-destructive-target-guard`         | reads source                                                                             |
| `global-scope-db-tests-are-isolated`   | reads source                                                                             |
| `no-postgres-client-leaks-raw-notices` | reads source                                                                             |

So after V-1328 every file that actually talks to Postgres reports it when Postgres is not there. The
class is closed, and closed by measurement rather than by inspection.

**The instrument was controlled before the result was believed.** The two files repaired in V-1328
appear in the failure list — they passed this same counterfactual before the fix and fail it now,
which is the before/after that makes the fix real rather than plausible. A third file nobody touched
fails too, confirming the run reaches ordinary DB suites and not only the repaired ones.

Worth stating plainly because it changes how the next sweep should start: this took one command and
produced a complete, exact answer, where four successive greps produced three wrong numbers and an
upper bound. When a guard's subject can be broken cheaply — a dead port, a removed clause, a flipped
operator — breaking it answers "would this notice?" directly. A pattern only guesses at it.

## V-1330 — the scope surface is two layers, and both notice when it is removed

Same instrument as V-1329, pointed at authorization. Two runs, because scope enforcement is
implemented **twice** and one mutation reaches only half of it.

**The surface is bigger than a route-layer grep shows.** `requireScope(` in `routes/` finds 176 call
sites across 42 files. That is not the whole thing: 11 service files import the same helper under an
alias — `import { requireScope as throwIfMissingScope }` — for another **48 call sites**, and one
route file uses the aliased import rather than the decorator. 224 sites, two idioms, two layers. The
route-only map also missed three scopes enforced nowhere else: `read:webhooks`, `read:audit`,
`read:api`.

**Both layers are covered behaviourally.**

| neutralised                                                | tests that failed   | scopes represented in the failures                |
| ---------------------------------------------------------- | ------------------- | ------------------------------------------------- |
| the route decorator (`services/auth.ts::requireScope`)     | 249 across 38 files | all 11 the routes gate on, `gui_control` included |
| the service helper (`lib/errors-helpers.ts::requireScope`) | 48 across 19 files  | 8, including the three the routes never use       |

Both files restored byte-identical from snapshots; `tsc` clean under each mutation, so the failures
are behavioural rather than compilation noise.

**A claim raised and fully retracted.** The route-only map showed `read:webhooks` declared in the
scope enum with zero enforcement sites, and every webhook route gated on `requireAuth` alone — which
reads as a customer-selectable least-privilege scope that grants nothing, and webhook WRITES
reachable by any authenticated key. It is enforced, in the service layer, at four sites, with
`account_owner` required for the writes. The gate was in a different layer behind an aliased import.
That is the third enumeration of this shape to come up short today, and the pattern is consistent:
counting call sites of one spelling in one directory measures the spelling, not the rule.

**The duplication is already guarded, and better than a hand-written check would be.** Two
implementations exist — inlined in `services/auth.ts`, delegating to `scopesSatisfy` in
`lib/errors-helpers.ts` — kept in step by hand and by comment. `scope-check.test.ts` compares all
three entry points across every granted subset of size 0, 1 and 2 drawn from `ApiKeyScopeSchema.options`
against every required scope, and states why size 2 is the floor: several rules read one scope while
a second is present, and a singleton sweep cannot catch an implementation consulting the wrong
element. Nothing to add.

## V-1331 — a coverage guard that claimed every route, and could not see half the enforcement

`customer-scope-refusal-coverage` opens by stating that every customer-facing route enforcing a scope
refuses a key lacking it, proved by calling each one. The measurement in V-1330 makes that untrue:
the roster is built by reading each handler's own window in its route file, so a gate enforced
anywhere else is invisible to it — and 48 of the server's 224 scope call sites live in service
methods behind an aliased import, with `read:webhooks`, `read:audit` and `read:api` enforced ONLY
that way.

This is the same defect shape as the Python SDK header in V-1315: a file whose opening sentence
claims more than its implementation delivers, where the claim is what a reader trusts.

The routes concerned are neither unprotected nor untested — neutralising the service helper failed 48
tests across 19 files. They are outside what THIS file proves, which is a different statement and the
one the header now makes.

**Named, then pinned, because a blind spot recorded only in prose decays.** The file already carries
a scar of exactly this kind (V-776: the `controlKeyOrAccountAuth` wrapper form made 13 routes
invisible to the same scan), so the correction follows that precedent and adds an arm holding the gap
in place from both directions, using `/v1/webhooks` as the live example:

| mutation                                                                 | failing assertion                                                                       |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| the `read:webhooks` gate deleted from `services/webhooks.ts`             | the webhook read gate is gone from the service layer, and no route file carries one     |
| a `requireScope('read:webhooks')` preHandler added to `GET /v1/webhooks` | a webhook route gained a route-file scope gate — the header blind spot needs revisiting |

The first is the serious direction: it fires when the only gate those routes have disappears. The
second fires when the blind spot stops being one, so the header gets revisited rather than quietly
becoming wrong in the other direction. Each mutation failed its own assertion and nothing else that
matters — the second also registers a new refusal case for the route it just gated, which is the
roster doing its job. Both source files restored byte-identical.

## V-1332 — a cross-tenant escalation that only a source-text pin would have noticed

**The code is correct. Nothing behavioural was checking that it stayed correct.** That distinction is
the whole entry: this is a coverage finding, not a live vulnerability.

`resolveEffectiveAccount` is what stands behind `X-Driftstack-Account`: a team member may act as the
owner whose team they belong to, and nobody else. The check is one line — find a membership whose
`ownerAccountId` equals the requested account, refuse if absent.

Neutralising it so that ANY membership satisfies ANY requested account — one member of one team able
to act as any account on the platform — **failed exactly one test in the entire node project**, and
that one is `server-resolve-effective-account-parity`, a `readFileSync` pin matching the literal
return statement against a regex. It fired because the TEXT changed. Nothing observed the
impersonation.

**Why the existing end-to-end arm could not see it.** `team-rbac-x-driftstack-account-end-to-end`
does carry "pointing at a non-member account → 403", and it is a good arm — its own title records
V-1043, where it once asserted only `statusCode < 500` and would have passed a server that granted
the impersonation. But its fixture seeds no membership at all, and says so in a comment. With
`ctx.teams` empty, every header but the caller's own is refused by the emptiness alone. It proves a
STRANGER is refused. It cannot prove membership is checked against the account the header names —
and those two properties only come apart once the caller belongs to some team, which is every real
customer who has one.

The arm added seeds the caller as a genuine admin of one team, asserts acting as that owner returns
200 (so the escalation attempt is a real request rather than a malformed one), then asserts a third
account returns 403 with the RFC 7807 forbidden type.

Proven by re-applying the same mutation: it now fails the new arm on "a team member acted as an
account they are not a member of", where before it failed only the text pin. Source restored
byte-identical.

**The general shape, since it has now cost three findings this session.** A fixture that omits a
precondition can make an assertion pass for a reason unrelated to the property under test. The empty
`ctx.teams` here, the short final page in the pagination walks (V-1317), the `if (!app) return`
suites (V-1328) — each proved something narrower than its title claimed, and in each case the gap was
invisible to reading and obvious to a mutation.

## V-1333 — the tenant boundary swept end to end: 127 predicates, 3 gate copies, one prior gap already closed

V-1332 found a real hole on the cross-tenant boundary. This asks whether it was the only one, on the
two layers beneath it. Neither sweep found a defect; both are recorded because an unwritten sweep is
indistinguishable from one never run.

**The repo predicate — 127 sites, 24 repos.** Every `eq(<table>.accountId, …)` in `src/db` was
rewritten to `eq(t.accountId, t.accountId)`, always true — the technique the original ownership sweep
used, which back then left the ENTIRE suite green across two repos and 14 predicates. Today it fails
**242 tests across 85 files**, including all three deliberate boundary files
(`db-repo-account-ownership-boundary`, `db-repo-account-scoped-reads-boundary`, and the
`tenant-scope-drizzle` family). Every repo carrying a predicate is represented. The class those two
prior passes opened is closed.

**A false alarm of my own, worth recording because it is the fourth of its kind today.** Attributing
by NAME said four repos had no failing test. Three were covered by files named for the boundary
rather than the repo. The fourth, `stripe-webhooks-repo`, looked real — five predicates inside
`downgradeAccountTierToBestRemaining`, `setAccountTierToBestActive` and `activateCryptoEntitlement`,
which compute an account's TIER from its subscriptions and entitlements; unscoped, one customer's
tier is derived from the whole platform's rows, and a free account inherits whatever the best
subscription on the platform happens to be. It is covered: `db-account-tier-best-active-drizzle` and
`db-crypto-entitlements-drizzle` both failed. I had grepped the failure list for the repo's name and
those files do not carry it. **Name matching is not attribution** — the same error in four different
shapes today.

**The write-path role gate — three copies.** `effectiveAccountIdForWrite` is defined separately in
`routes/profiles.ts`, `routes/webhooks.ts` and `routes/profile-snapshots.ts`, logically identical,
differing only in variable name and message. Removing the `role !== 'admin'` check from all three
failed nine files, of which three are behavioural and cover one family each: `team-rbac-auth-path`
(profiles and webhooks, both as MEMBER role), `webhook-replay-customer`, and
`profile-snapshots-team-write-requires-admin`. The remaining five are content-parity and
cross-source pins, plus the source-typecheck arm reacting to the now-unused import.

**The completeness question was already answered, and better than the guard I was about to write.**
`every-team-scoped-write-is-gated` (V-1069) exists precisely for the fourth copy: it measures that 47
live `/v1` writes resolve an effective account and all 47 carry one of five recognised gates, refuses
the forty-eighth, holds a roster so a DELETION is visible rather than dropping the route out of the
scan, shares its gate vocabulary with V-837 so a helper cannot be known to one and not the other, and
carries a vacuity arm. Its header records that its first version was a false green a mutation caught.
Nothing to add.

## V-1334 — every refusal path in the server now executes under test: 104 of 104

`mfa-step-up-gate-actually-denies` (V-1069-era) was written after intersecting per-line coverage with
deny-throw sites and finding **108 such sites, 31 of which no test reached** — among them both
refusal paths of the MFA step-up gate, which was "extensively pinned and never run". That file closed
two. This re-runs the same measurement to see what became of the rest.

Instrument: a full `vitest run --coverage` with a JSON report, intersected against every
`throw new (Forbidden|Unauthorized|MfaStepUpRequired|InvalidKey|RevokedKey|ExpiredKey)Error(` in
`apps/server/src`. That yields **104 sites**, close enough to the 108 the earlier work counted to
confirm the two instruments are measuring the same population.

**All 104 are reached. None is unexecuted.** The campaign that file opened is finished.

**The zero was controlled before it was believed**, because "0 unreached" and "the parser matched
nothing" read identically. Across `apps/server/src` the same coverage data shows **1,434 never-executed
statements in 164 files** — 8% of 17,402. The instrument sees zeros in quantity; refusal throws
simply are not among them.

Where the remaining dead statements are, since the next sweep should start from a set rather than a
percentage: `lib/bootstrap.ts` (300), `routes/agent-sessions.ts` (110), `drivers/playwright.ts` (62),
`services/durable-webhook-delivery.ts` (52), `routes/account-me.ts` (40),
`services/proxy-connectivity-probe.ts` (33), `scripts/seed-local-fleet-node.ts` (30),
`services/agent-runtime.ts` (26). Bootstrap and the seed script are wiring that a test process does
not execute; the rest are worth a look on their own terms, and none of them is a refusal.

The coverage run that produced this was itself green — 3172 files, 31328 passed, 16 skipped.

## V-1335 — RETRACTION of the V-1334 count, and the seven refusals it hid

**V-1334 said every refusal path in the server executes under test. That conclusion was wrong, and
wrong twice over.** Recording the correction before the finding, because the finding only exists
because the instrument was rebuilt.

**Error one: the population came from a hand-written list.** I enumerated six error classes and
called the result "refusal paths". `apps/server/src` throws **52 distinct error classes across 744
sites**. `BundledLlmConsentRequiredError` and `ByokAnthropicRequiredError` refuse an agent turn and
were never in the list — the same defect rule 2 exists to prevent, committed while quoting rule 2.

**Error two: the coverage lookup masked the zeros it was looking for.** For each throw line I took
the MAXIMUM execution count over every statement spanning that line. An enclosing block that ran
reports a nonzero count, so an inner throw that never ran was recorded as reached. Matching the
NARROWEST statement instead — the throw is its own statement — changes the answer from 14
never-executed sites to **68**. The first number was produced by an instrument that could not see
what it was measuring, and it agreed with the conclusion I had already published.

The corrected sweep over all 744 sites: **68 never executed**, led by `BadRequestError` (14),
`NotFoundError` (11), `DriverNotIntegratedError` (10), `ForbiddenError` (7), `ConflictError` (7).

**Seven of them are one refusal, replicated.** Every copy guards the window between the auth cache
loading a team membership and the handler reading the owner row — the owner account deleted in
between:

| site                                     | route                                    |
| ---------------------------------------- | ---------------------------------------- |
| `routes/profiles.ts:382`                 | `POST /v1/profiles/:id/clone`            |
| `routes/profiles.ts:454`                 | `POST /v1/profiles/import`               |
| `routes/admin.ts:182`, `:219`            | api-key rotate, `/v1/usage`              |
| `routes/agent-sessions.ts:4066`, `:4070` | tier resolution for an owner-run session |
| `routes/profile-snapshots.ts:235`        | snapshot writes                          |

**What the branch is actually worth, measured rather than argued.** My first draft of the new arm
said that without the guard the handler would carry on with the caller's own account and tier,
writing to the wrong account. Disabling it and running showed otherwise: `owner.id` is read off null
and the caller gets a **500**. So the guard converts an unexplained server fault into a 403 that
names its cause — a smaller claim than the one I wrote first, and the true one. The description now
says that, because a comment that misstates its own line is the defect this campaign keeps repairing
in other files.

One arm added, on the clone route, with the fixture correct in every other respect so an earlier
guard cannot answer first: membership resolves, role is admin, body parses. Mutation-proven —
`if (false && !owner)` fails it on `expected 500 to be 403`. Source restored byte-identical.

Six copies remain uncovered and are named above rather than left implied.

## V-1336 — the second of the seven deleted-owner copies

`POST /v1/profile-snapshots/:id/restore` carries its own copy of the branch V-1335 covered on clone.
Covering one proves nothing about the next: each route reaches the branch through a different
fixture — clone needs a `prof_` id and accepts `{}`, restore needs a `psnap_` id and a body carrying
a name — so a single arm cannot stand in for the family.

Restore matters on its own terms: it rebuilds a profile from a snapshot under the OWNER's tier, so a
half-resolved owner decides what the restored profile is permitted to be.

Mutation-proven with `if (false && !owner)`, which fails it on `expected 500 to be 403` — the same
signature as the clone arm, confirming the same null read behind it. Source restored byte-identical.

Two of seven copies now covered. Remaining, unchanged from V-1335: `routes/profiles.ts:454`
(`POST /v1/profiles/import`), `routes/admin.ts:182` and `:219`, `routes/agent-sessions.ts:4066` and
`:4070`.

## V-1337 — the deleted-owner refusal on a READ, and behind a third gate variant

Two more of the seven copies, chosen because each is reached by a path the earlier arms do not use.

**`GET /v1/usage` is the read side, and it has no role gate in front of it.** The clone and restore
arms both go through `effectiveAccountIdForWrite`, which demands admin before the owner lookup.
`/v1/usage` calls `resolveEffectiveAccount` directly, so ANY member reaches the branch. The fixture
therefore uses role `member` on purpose: copying the write arms' admin fixture would have re-proved
the write gate instead of this path. What the branch prevents here is a usage summary — a billing
figure — computed from a half-resolved owner.

**`POST /v1/api-keys/:id/rotate` sits behind `effectiveAccountIdForKeyWrite`**, the third of four
gate variants in the route layer (`effectiveAccountIdForWrite`, `effectiveAccountIdForKeyWrite`,
`effectiveAccountIdForLiveOperation`, `callerCanAccessAgentSession`). Covering the branch through one
variant says nothing about the others, so each is reached on its own. Rotate mints a replacement
credential on the OWNER account, so a half-resolved owner decides which account the new key belongs
to.

Mutation-proven per occurrence rather than together, since both live in `routes/admin.ts` and a
single flip would not show which arm did the work:

| mutated line                                       | failing arm                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `admin.ts:215` (`if (!owner) {` on the usage read) | reading usage for a deleted owner must be refused — expected 500 to be 403 |
| `admin.ts:182` (rotate)                            | rotating for a deleted owner must be refused — expected 500 to be 403      |

Each failed exactly one arm with the other eight green, and both produce the same `500` signature as
the clone and restore arms — the same null read behind all four. Source restored byte-identical.

Four of seven copies covered. Remaining: `routes/profiles.ts:454` (`POST /v1/profiles/import`, which
needs a valid envelope body to reach the branch) and `routes/agent-sessions.ts:4066` / `:4070`.

## V-1338 — the fifth deleted-owner copy: profile import

`POST /v1/profiles/import` parses a complete export envelope BEFORE it resolves the effective
account, so any shortcut in the fixture answers with a validation error and never reaches the branch
— the V-1332 trap in its plainest form. The payload here is therefore a valid envelope end to end
(version, `exported_at`, both source ids, and a profile carrying a selectable archetype), so the only
thing wrong with the request is the owner being gone.

Import mints a fresh profile on the OWNER account under the OWNER tier, so a half-resolved owner
decides both where the profile lands and what it is permitted to be.

Mutation-proven with `if (false && !owner)` on `routes/profiles.ts:454` — fails on
`expected 500 to be 403`, the fifth arm to show that same signature. Source restored byte-identical.

**Five of seven covered. The remaining two are in `routes/agent-sessions.ts` and are harder for
reasons worth writing down rather than discovering again:**

- `:4070` needs an agent-session record whose `accountId` is an account that does not exist, and the
  caller must not be that account — so the fixture has to seed a session owned by the ghost, not just
  a membership pointing at it.
- `:4066` (`'Owner account tier is unavailable.'`) fires only when the route is registered with no
  `authRepo` at all. `buildTestApp` always wires one, so reaching it means building an app that is
  deliberately incomplete — which is a different kind of fixture from every arm above, and possibly a
  branch that only a misconfigured deployment can reach.

## V-1339 — an arm that passed while measuring the wrong layer, and the branch it proved is shadowed

Attempting the sixth deleted-owner copy — `routes/agent-sessions.ts:4070`, reached through
`POST /v1/agent-sessions/:id/mode` — produced an arm that passed on the first run. It was wrong, and
the mutation is what said so: disabling line 4070 left all eleven arms green.

**What it was actually measuring.** Enumerating every producer of the message found NINE, not the
seven the coverage sweep had listed — the two extra (`routes/profiles.ts:166`, `routes/admin.ts:95`)
were already covered, and the ninth is **`middleware/rate-limit.ts:178`**, which lives in a
preHandler. On the mode route the effective-owner limiter resolves the owner and refuses a deleted
one BEFORE the handler body runs, with the identical string. Mutating that line to a different
message failed the arm immediately. So the arm exercised the middleware, asserted on a message shared
by both layers, and read as coverage of a branch it never reached.

**The branch is shadowed, which is why coverage shows it unexecuted.** `agent-sessions.ts:4070`
cannot fire on that route while the effective-owner limiter answers first on the same condition. The
limiter's own comment says it "Mirrors routes/admin.ts, profiles.ts and profile-snapshots.ts, which
already answer 403 on exactly this condition" — the duplication is deliberate and known; what was not
recorded is that on routes carrying the effective-owner limiter, the route-level copy is unreachable.
That is a different thing from untested, and the log said untested.

The arm was removed rather than relabelled. `middleware/rate-limit.ts:178` already had coverage — it
was never in the unreached set — so keeping it would have added a redundant assertion under a name
claiming something else.

**Why the five committed arms are unaffected:** each was proven by mutating its OWN route line, and
each failed. Those routes do not carry the effective-owner limiter, so the route-level branch is the
first guard on that condition. The proof method is what distinguishes them from this one, not the
fact that they passed.

Standing count: 9 producers of the refusal, 5 newly covered and proven at their own line, 2 already
covered, 1 shadowed by the rate limiter (`agent-sessions.ts:4070`), 1 reachable only from an app
registered without an `authRepo` (`agent-sessions.ts:4066`).

## V-1340 — the profile cap's race backstop was enforced on two creation paths out of four

Four service methods can add a profile to an account — `create`, `clone`, `importProfile`,
`transferProfile` — and each carries the cap TWICE: a `countByAccount` pre-check that fails fast, and
a conditional `insertWithLimit` that re-checks under an account-row lock. The second exists because
the first cannot settle a race: two calls both read a count under the limit, and only the conditional
insert decides which one loses.

Coverage over all 744 throw sites put two `TierLimitError` throws in the never-executed set:
`services/profiles.ts:819` (clone) and `:967` (import) — **both of them the conditional-insert
branch**. `create` and `transferProfile` have theirs covered; the transfer arm even spells the race
out. So the backstop was verified on two paths of four, and the two left out are the two a customer
reaches for when adding profiles in bulk.

A cap enforced on three paths out of four is not a cap: the loser of the race is written anyway and
the account ends up over the allowance it is billed against.

Two arms, in the idiom the transfer arm already established — pre-check made to see room,
`insertWithLimit` made to report the account at ten:

| mutated branch                      | failing arm                                                      |
| ----------------------------------- | ---------------------------------------------------------------- |
| `services/profiles.ts:818` (clone)  | CLONE refuses when the atomic insert reports the account at cap  |
| `services/profiles.ts:966` (import) | IMPORT refuses when the atomic insert reports the account at cap |

Proven per occurrence — the two branches are textually identical lines in one file, so a single flip
would not show which arm did the work. Each failed exactly one arm with the other 63 green, and the
service was restored byte-identical after each.

This is the third replicated-guard finding in a row where only some copies were exercised: the
deleted-owner refusal (7 copies, 5 unreached), the pagination boundary (14 sites, 12 unverified), and
now the profile cap (4 conditional branches, 2 unreached). The shape is consistent enough to be worth
naming — a rule implemented once per call path is a rule tested once per call path, and the count of
copies is never the count of covered copies.

## V-1341 — the replicated-guard pattern, measured instead of anecdotal

Three findings in a row had the same shape: a rule implemented once per call path, tested on some
paths and not others — the deleted-owner refusal, the pagination boundary, the profile cap. Rather
than wait for a fourth, here is the whole class, from the coverage run intersected against all 744
throw sites and grouped by the refusal MESSAGE each site raises.

**12 refusal messages appear at more than one site with at least one copy never executed.** Ranked
by how many copies are dark:

| dark / total | refusal                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| 6 / 9        | `Owner account no longer exists.`                                                |
| 2 / 2        | `Another turn is already running for this agent session.`                        |
| 2 / 2        | `Agent message admission did not resolve.`                                       |
| 2 / 12       | `Invalid id format. Expected …`                                                  |
| 2 / 12       | `invalid_request` (OAuth)                                                        |
| 1 / 2        | `Proxy … not found.`, `Session … not found.`, `atlas-priority-event … not found` |
| 1 / 3        | `Confirmation link is invalid or has been used.`, `Unsubscribe link is invalid.` |
| 1 / 33       | `AgentSession … not found.`                                                      |
| 1 / 2        | `Subscriber … not found.`                                                        |

**The snapshot predates this session's work.** The coverage run is from before V-1335–V-1338, so the
`Owner account no longer exists.` row still shows six dark; five have since been covered and proven,
and one (`agent-sessions.ts:4070`) is shadowed by the rate limiter rather than untested (V-1339). The
other rows are untouched by that work and stand as measured.

**The most interesting new entry is dark on BOTH copies.** `Another turn is already running for this
agent session.` guards the same condition on two paths — the manual-transcript admission
(`agent-sessions.ts:4514`) and the LLM-driven one (`:4837`) — converting the runtime's
`turn-in-progress` result into a 409. Two concurrent turns on one session is a billing and
transcript-ordering problem, and neither copy has ever run.

It is not covered here, and the reason is worth recording rather than rediscovering: the result comes
from `activeTurnSessionIds`, an in-memory `Set` private to the `AgentRuntime` instance, and
`buildTestApp` constructs that runtime internally with no override. Producing the state needs either
an injectable runtime or a controllable slow point in a first turn so a second overlaps it. A test
built on real timing would be the flaky kind this repo treats as a defect, so the seam comes first.

Same reason, same shelf: `routes/account-me.ts:865` (avatar upload with R2 unconfigured — the fixture
always wires an R2 fake) and `:901` (an R2 write failing — the fake has no failure seam and the
fixture exposes only its store, not the client).

The pattern itself is the durable part: **the count of copies is never the count of covered copies**,
and grouping throw sites by message turns that from something noticed three times by hand into a list
that can be worked down.

## V-1342 — the id-format refusal, and the half of it a regex cannot do

Two entries from the V-1341 worklist: `Invalid id format. Expected …` appears at 12 sites and two
were dark — `routes/admin-rate-limit-overrides.ts:19` and `routes/admin-sessions.ts:19`, each a
private copy of `uuidFromPrefixedId` in its own route file.

Both parse the `account_id` query filter, and both had their happy path covered (`admin-sessions`
even has an arm named "filters by account_id (prefixed)") while the refusal had never run.

**The valuable half is the prefix check, not the regex.** `PUBLIC_ID_RE` matches ANY three-letter
prefix, so `key_<uuid>` is a well-formed id by that pattern; only `value.startsWith(`${prefix}\_`)`
separates an api-key id from an account id. Drop it and a caller passing one resource's id where
another is expected has its uuid looked up against the wrong table — with no complaint, because the
shape was valid.

One arm per copy, asserting both halves: a malformed value is a 400, and a well-formed `key_<uuid>`
is also a 400 whose detail names the shape it wanted.

Mutation-proven per occurrence, removing ONLY the `startsWith` clause so the regex still passes the
input — which is precisely the state that makes the wrong-prefix id acceptable:

| mutated copy                              | failing assertion                                                  |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `routes/admin-sessions.ts:18`             | an api-key id where an account id is expected must not be accepted |
| `routes/admin-rate-limit-overrides.ts:18` | same                                                               |

Each failed exactly one arm in its own file; both routes restored byte-identical.

**Two worklist entries closed as NOT gaps.** `services/status-subscribers.ts:133` and `:168` are dark
because they are deliberately unreachable: both carry a comment saying purged rows clear the token
hash, so the branch exists for type-narrowing only. The code said so before I wrote anything, which
is the cheapest kind of verification available and the reason to read the site before building a
fixture for it. They are not defects and need no arm.

## V-1343 — an abandoned OAuth consent screen, and two guards that cannot be told apart from outside

Two more worklist entries from V-1341, and they resolved in opposite directions.

**`services/oauth.ts:518` is shadowed, not untested.** It refuses a PKCE `code_challenge_method`
other than `S256` — a real security control, since `plain` sends the verifier as the challenge. But
`service.authorize()` has exactly one caller, `routes/oauth.ts:242`, and that route's schema pins
`code_challenge_method: z.literal('S256')` at line 55. The request is refused before the service is
reached. `oauth-pkce-s256-only.test.ts` already proves that by SENDING a `plain` request, and its own
header records the same lesson from the other side: relaxing the route schema reds only source-text
guards. So the service check is defence in depth behind a validator that always answers first — the
second shadowed branch found this way, after `agent-sessions.ts:4070` in V-1339.

**`services/oauth.ts:564` is a real gap, now covered.** The consent flow has a gap between recording
a pending authorization and a human approving it; `CODE_TTL_SECONDS` bounds it. The branch one line
above — an `authorization_id` that resolves to nothing — is exercised; the one distinguishing "no
such authorization" from "this one is too old" was not. New file with three arms: an approval inside
the window still mints a code (so the refusal arms cannot be satisfied by a service that refuses
everything), an approval past the window is refused, and the refusal carries `invalid_request`.
Driven against the service with an injected clock, because the alternative is waiting five real
minutes.

**The mutation proof needed correcting, and the correction is the interesting part.** Disabling the
pre-check alone left all three arms green — the tell that an arm is measuring something else. It was
not: changing only the pre-check's MESSAGE failed the arm, which proves the arm does execute line 564. What masks the first mutation is that `consumeAuthorizationForCode` returns `'expired'` a few
lines later and raises the **identical code and message**. The two guards are observationally
identical from outside, so neither is provable alone; disabling BOTH fails both refusal arms while
the inside-window arm stays green. The entry says "these arms pin the behaviour, guaranteed by two
redundant guards" rather than claiming a specific line, because the stronger claim is not available
through the public surface.

**An imprecision in the V-1341 instrument, for the record.** That sweep grouped throw sites by their
first quoted argument. `OAuthError`'s first argument is the error CODE, so both OAuth rows were
grouped as `invalid_request` rather than by message — which is why two unrelated refusals appeared as
one row. The grouping is still useful; it is looser than it reads for error classes whose first
argument is not the message.

`EXPECTED_TEST_FILES` 3003 → 3004 and `_ALL` 3168 → 3169 for the one file added. The new file is a
pure unit test and gates on nothing, so the stated `DATABASE_URL` share is unchanged.

## V-1344 — what a half-wired deployment does, and why nothing was checking

Chasing two more V-1341 entries turned up a class rather than two sites. `routes/*.ts` contains **9
branches of the shape "an optional dependency is absent, so refuse"** — distinct from the
subsystem-level activation gates `every-activation-gate-has-a-refusing-disabled-variant` already
covers, because here the route IS registered and serving; only the service behind one field is
missing.

**7 of the 9 are dark:**

| branch                            | dependency              | refusal                  |
| --------------------------------- | ----------------------- | ------------------------ |
| `agent-sessions.ts:2023`          | `profilesService`       | 404                      |
| `agent-sessions.ts:2040`          | `accountProxiesService` | 404                      |
| `agent-sessions.ts:2091`          | `driverSessionsRepo`    | 404                      |
| `agent-sessions.ts:3839`          | `pairModeLock`          | 503                      |
| `agent-sessions.ts:4065`          | `authRepo`              | 403                      |
| `agent-sessions.ts:5148`, `:5216` | `pre`                   | 500 (internal invariant) |

They are dark for a structural reason, not neglect: `buildTestApp` wires every dependency, so no test
can produce the state. **The two that ARE covered say how to fix that** — `agentTurnReceipts:5004` is
reachable because the fixture already carries `disableAgentTurnReceipts`, an option whose only
purpose is to leave one dependency out.

So the seam is the deliverable, following that precedent exactly: `disableAccountProxies`, additive
and defaulted, leaving `accountProxiesService` unwired while the agent-session create route still
registers and still accepts `proxy_id`.

The arm asserts the create is REFUSED rather than dispatched. A session that quietly ignored the
proxy would run the customer's automation from the wrong egress — the exact failure the field exists
to prevent — and would look like a success. The 404 rather than a 503 is deliberate and the route
says so: confirming "the proxy subsystem is off here" for an id the caller may not own would answer a
question about another account's resources.

Mutation-proven: `if (false && accountProxiesService === undefined)` fails the arm on
`expected 500 to be 404` — without the branch the route dereferences the absent service and the
caller gets an unexplained fault instead of a clean refusal. Source restored byte-identical.

Six remain dark and are named above. Each needs its own seam; `profilesService` and
`driverSessionsRepo` are the same shape as this one and would transfer directly, `pairModeLock` and
`authRepo` need theirs, and the two `pre` branches are internal invariants rather than deployment
states — worth classifying before assuming they are gaps at all.

## V-1345 — the seam transfers: three of the seven half-wired branches now covered

V-1344 added one fixture seam and predicted two others would transfer directly. They do.

`disableProfilesService` and `disableDriverSessionsRepo`, both additive and defaulted like the
`disableAgentTurnReceipts` precedent, leave one dependency out while the agent-session create route
stays registered and keeps accepting the field that needs it.

- **`profile_id` with no profiles service** — launching anyway binds the session to nothing while
  reporting success, and the customer learns of it from automation behaving as though no profile were
  attached.
- **`driftstack_session_id` with no driver session repo** — that column is a real foreign key, so
  persisting a pointer nothing validated writes a dangling reference the database would later reject.

Each refused by its own branch, so covering one says nothing about the next — which is why the
fixture gained a seam per dependency rather than one switch for "degraded mode".

Mutation-proven per occurrence:

| mutated branch                                  | failing arm                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `agent-sessions.ts:2023` (`profilesService`)    | unresolvable profile reference must not launch a session — expected 500 to be 404 |
| `agent-sessions.ts:2091` (`driverSessionsRepo`) | unresolvable session reference must not be persisted — expected 500 to be 404     |

Both show the same signature as the proxy arm: without the branch the route dereferences the absent
dependency and the caller gets an unexplained fault where a clean 404 was available. That is the
whole value of these branches, and it is now measured on three of them.

Four of the nine remain dark: `pairModeLock` (503) and `authRepo` (403) each need their own seam, and
the two `pre` branches raise `InternalError` — an internal invariant rather than a deployment state,
which is a different question from "is this tested" and worth classifying before treating them as
gaps.

## V-1346 — two of the four remaining dark branches are unreachable, and now say so

V-1345 left four half-wired branches dark and flagged the two raising `InternalError` as needing
classification before being treated as gaps. Classified: **they are unreachable by construction**, and
the reasoning is short enough that it should have been written at the site rather than rediscovered.

`prepareAgentMessage` is typed `Promise<AgentSessionRecord>` — it never returns undefined. So `pre` is
unset only when the catch around it ran, and each site is preceded by a rethrow that makes that
impossible:

- **`agent-sessions.ts:5148`** is inside `if (!wantsEventStream)`, and the catch rethrows every error
  unconditionally on that lane (`if (err instanceof RateLimitedError || !wantsEventStream) throw err`).
  Reaching the check means the catch did not continue, so `pre` is set.
- **`agent-sessions.ts:5216`** is preceded one line up by `if (admissionError !== undefined) throw
admissionError`. Past it, the catch stored nothing, so `pre` is set.

Both are TypeScript narrowing guards. Coverage reports them as unexecuted throws, which is accurate
and misleading at the same time — the same shape as `services/status-subscribers.ts:133` and `:168`,
which carry a comment saying exactly that and were therefore dismissed in V-1342 in one reading.
These two had no such comment, and cost a classification pass twice: once landing in the V-1341
worklist, once in the V-1344 enumeration.

A four-line comment at each site now records the invariant and names the coverage artefact, so the
next sweep dismisses them the way the status-subscriber pair already gets dismissed. Comment-only —
no behaviour changed, `tsc` clean, and all **27** test files that read this route's source still pass,
which is the check that matters when editing a file this heavily pinned.

Two genuinely dark branches remain from the class of nine: `pairModeLock` (503) and `authRepo` (403).

## V-1347 — the last seam-reachable half-wired branch, and a comment that had to change with it

`pairModeLock` unwired: pair mode still runs, but the takeover-via-input-event transition — the one
that needs the lock to serialise two clients racing for control of one session — is refused as
unavailable rather than granted to whichever request arrived first.

The setup came free. An arm two lines above already fires that exact transition with the lock
present; this is the same request against a deployment without it, which is what the new
`disablePairModeLock` seam produces.

Mutation-proven: `if (false && pairModeLock === undefined)` fails the arm on
`expected 500 to be 503`. Same signature as the other three — without the branch the route
dereferences the absent dependency and the caller gets an unexplained fault instead of a refusal
naming the cause. Source restored byte-identical.

**A comment had to change with the code, which is the part worth recording.** The fixture line
wiring this lock said it was "always wired so the takeover/handback routes register for tests." After
the seam that is false, and a stale "always" is exactly the kind of statement this campaign keeps
finding in other files and correcting. It now says wired by default, and names the option that leaves
it out and why.

**The class of nine, closed out:** 4 covered behaviourally by a seam per dependency (proxies,
profiles, driver sessions, pair-mode lock), 2 already covered before this work, 2 classified as
unreachable narrowing guards and documented at the site (V-1346), and **1 left**:
`agent-sessions.ts:4065`, which fires when `authRepo` itself is absent. That one is not a partial
deployment but a broken one — `authRepo` is what authenticates every request, so an app without it
serves nothing at all. Reaching the branch would mean building a fixture that cannot answer a single
authenticated call, which measures the fixture rather than the route. Recorded as deliberately not
pursued rather than left on a list implying it is pending.

## V-1348 — the prompt-injection scheme guard on navigate had never run

`services/sessions.ts:722` refuses a `navigate` whose URL is not `http(s)`. Its own comment says why
it lives at the SERVICE layer rather than only in the route schema, and the reason checks out:
`services/agent-executor.ts:378` calls `sessions.navigate(account, sessionId, { url: intent.url })`
directly, and `intent.url` is produced by the model. A page that talks the agent into fetching
`file:///etc/passwd` never passes through the route schema at all — this check is the only thing
between a prompt injection and the driver.

Coverage put it in the never-executed set, so the defence existed and nothing had ever watched it
refuse.

Four refusals covered — `file:`, `ftp:`, `javascript:`, `data:` — plus two things that make them mean
something:

- **The driver must not have been reached.** A navigate that got as far as the driver and failed
  there would already have resolved DNS for whoever wrote the injected page. Asserted on the stub's
  own `operationCalls` recorder.
- **An `https` URL is NOT refused by this guard**, so the four arms cannot be satisfied by a method
  that rejects everything. It is allowed past and fails later in the driver, which is what shows the
  guard let it through.

The arms reuse the existing `buildService`/`buildCtx` factory in `sessions-failure.test.ts` rather
than standing up a new fixture: the guard is the first statement in `navigate`, so nothing downstream
is touched and a fresh fixture would only add surface the refusal never reaches.

Mutation-proven — `if (false && !/^https?:\/\//i.test(body.url))` fails all four refusal arms while
the https arm stays green. Source restored byte-identical.

**A wrong assumption of mine, caught by the first run.** The driver assertion was written against
`driver.calls`, which this stub does not have; four arms failed on `expected undefined to deeply equal
[]`. The stub records non-lifecycle work in `operationCalls`. Reading the stub rather than guessing
its shape would have been quicker, and the failure mode is worth noting: an assertion against a
property that does not exist fails loudly here, but the same mistake inside a `.some()` or an
optional chain would have passed silently.

## V-1349 — same shape, opposite answers: when a service-layer guard is reachable and when it is not

V-1348 covered a service-layer check that the route schema also enforces. This is the same shape
three sites over, and it resolves the other way — which is the point of writing both down.

`routes/account-me.ts:532`, `:551` and `:573` sit in `buildVpnSecretAndConfig` and refuse a proxy
whose scheme and config block disagree: an `openvpn` scheme with no `openvpn` block, the same for
`wireguard`, and a VPN block supplied alongside `socks5`/`http`. All three are dark.

**They are shadowed, and by design.** The helper has exactly two callers — the proxy create
(`:622`) and the proxy update (`:693`) — and both parse first:

- `AccountProxyInputSchema` is a discriminated union whose `openvpn` variant REQUIRES the block, each
  arm `.strict()`, so a stray block on `socks5` is a parse error.
- `AccountProxyUpdateSchema` is the same, plus a fifth "scheme unchanged" arm whose own comment spells
  the intent out: `scheme` must be the omitted key so that a request like `{ scheme: 'wireguard' }`
  with no matching block "fails closed against THIS branch too, instead of silently falling through".

So the schema refuses every input that could reach these three, and they are the belt behind that
brace. No arms written; writing them would have meant asserting a 400 that a different layer produces.

**Why V-1348 went the other way, stated because the two look identical from a coverage report.**
`services/sessions.ts:722` is also a service-layer check behind a route schema — but its second
caller is `services/agent-executor.ts:378`, which passes a model-produced `intent.url` and never
touches the route schema at all. One extra caller is the whole difference between defence in depth
that cannot fire and the only check standing between a prompt injection and the driver.

The reusable step is cheap: **before writing an arm for a dark guard, list its callers.** If every
caller validates first, the guard is unreachable and the arm would measure the validator. If one
caller does not, that caller is the reason the guard exists — and the arm belongs there, driving the
service directly rather than through the route.

## V-1350 — a twice-observed flake, and a type error of mine the peer fixed first

**The flake.** `db-webhooks-force-rotation-selection-drizzle` failed under a full run with
`limit 1 returns exactly one row: expected [] to have a length of 1`, and passed alone. It did the
same thing during the V-1328 investigation, so this is the second observation, both times under load.

The cause is in the query, not the timing: `findEndpointsNeedingForceRotation` takes no account
filter and scans the whole `webhook_endpoints` table, so every other suite writing that table shares
this result set. The arm read it twice in a row — once unlimited to check ordering, once with
`limit: 1` — and a concurrent cleanup between the two reads empties it. The failure message then
reads like a leaked limit and is actually interference, which is the worst property a flake can have.

Fixed by taking an uncontaminated reading rather than trusting one: retry up to five times, requiring
both seeded endpoints to be present BEFORE and AFTER the limited read, so the comparison only happens
against a set known to hold at least two rows — the only state in which "limit 1 returns one" means
anything. Exhausting the retries fails with a message naming interference instead of blaming the
limit.

The retry does not weaken the assertion: mutating the repo's `.limit(args.limit)` to `.limit(500)`
still fails the arm. Source restored byte-identical.

**A defect of mine, and how it was caught.** The V-1348 arms called
`service.navigate(ctx, id, { url })` while `NavigateRequest` also requires `wait_until`. Vitest does
not typecheck, so 48 tests passed and I committed it; the `the-server-source-type-checks` gate caught
it on the next full run. I had run `tsc` against the OAuth file in V-1343 and did not run it here —
the same lesson that is already written down as "a vitest pass is not a strict tsc pass", skipped
because the arms were an append to an existing file rather than a new one.

By the time I reached it the peer had already committed the repair
(`55af0135a "Make the scheme-refusal arms typecheck as well as pass"`), and the file now uses the
`wait_until: 'load'` idiom the other twenty call sites in it already used — which is what reading a
neighbouring call would have given me for free.

## V-1351 — a guard that failed for a reason unrelated to what it guards

`the-egress-claim-gate-has-one-definition` reported two failures in a full run and passed alone. The
failing arms took **10044ms and 10102ms** — a timeout signature, not an assertion. It had shown the
same behaviour once before, during the V-1317 sweep, where it was set aside as transient.

The cause is in the file, not the machine. `gateDefiners()` reads and comment-strips EVERY `.test.ts`
in the unit directory, and each of the four arms calls it — four full passes over a few thousand
files for four identical answers. Alone that is merely wasteful; sharing a machine with the rest of a
parallel run, two of the passes crossed the timeout and the file reported a failure that had nothing
to do with egress gates.

Memoised. The filesystem does not change during a run, so one pass is the same answer as four; kept
as a lazy memo rather than a `beforeAll` so the arms stay independently runnable. Test time for the
file is now 3.6s.

**Checked that the speed-up did not buy vacuity**, which is the obvious way to make a scanning guard
fast and useless: breaking the scan's own filter so it matches nothing still fails the arm that exists
for exactly that — "files defining an egress gate", which requires at least five. The memo caches a
real answer, not an empty one.

Worth noting alongside V-1350: two flakes in one turn, both load-sensitive, both previously written
off. One was a shared-table read racing a concurrent cleanup, one a scan too slow under parallelism.
Neither was random, and neither would have been found by re-running the file alone — which is the
first thing one does with a flake and the thing that hides both of these.

## V-1352 — the suite has a load-sensitive tail, measured rather than tuned

Three full runs this turn produced three different red sets, and every failure resolved to one of two
things: a test that raced a concurrent writer, or a test that ran out of time.

The timing half is now precise. `vitest.node.config.ts` sets `testTimeout: 10_000`, and the arms that
failed took **9958ms, 10005ms, 10809ms** — the ceiling, not an assertion. The same signature produced
the egress-gate failure fixed in V-1351 (10044ms, 10102ms). Runs alone, or in a group of four, they
pass: the four DB files that failed together pass together in 38 tests when they are not competing
with the whole suite.

The standing shape, for whoever picks this up:

- No `maxConcurrency` or `poolOptions` is configured, so vitest uses its default worker pool against
  **10 CPUs**, while Postgres allows **100 connections** and every DB-backed file opens its own.
- 181 files touch Postgres (V-1329). Under a full run they contend for connections and for CPU, and
  the slowest arms cross a 10-second ceiling that is generous in isolation.

**Two instances were real defects and are fixed** — a shared-table read racing a cleanup (V-1350) and
a scan repeated four times per file (V-1351). Both were in the test, not the environment, and both had
previously been written off as transient.

**The remainder is not something to fix quietly.** Raising `testTimeout`, capping worker concurrency,
or pooling connections across files are all changes to what CI enforces and how long it takes, and
each trades one property for another. Recorded with the numbers so the choice is made deliberately
rather than discovered as a slow drift in flake rate.

Attribution for this run, since a red set that changes every time invites guessing: four DB files —
`db-health-probes-repo-drizzle`, `db-incidents-public-feed-drizzle`, `db-recipes-encryption-drizzle`,
`incident-visibility-repo-contract` — timed out under contention and pass together in isolation. The
fifth, `ConfirmProvider.test.tsx`, is the peer's, from `97451cffb feat(gui): animate shared
confirmation dialogs`.

## V-1353 — a server-signed webhook header, verified by executing the SDKs rather than reading them

Two guards stand next to this property and neither covers it. `cross-sdk-webhook-signature-parity`
compares the three SDKs by READING their source and asserting they describe the same format — its own
header calls the property security-critical, because SDKs that disagree let customers "silently miss
real webhooks OR accept forged ones", but a text comparison cannot see a parser that reads the format
correctly and applies it wrongly. `durable-webhook-signature-sdk-verify` DOES feed a real emitted
header to a verifier, and closed a genuine bug that way — the durable path once signed bare hex, which
the SDK verifier silently rejected — but it verifies with **TypeScript only**.

So Python and Go customers were covered by the text comparison alone.

New file: sign with the server's own `signWebhookPayload`, then hand the result to the verifiers as a
customer's process receives it. **The rotation case is the point.** During a secret rotation the server
emits `t=…,v1=<curr>,v1=<prev>` — two signatures in one header — and a verifier reading only the FIRST
`v1=` accepts the current secret while silently rejecting every delivery a customer is still verifying
with the previous one, which is exactly the window rotation exists to make safe. A precondition arm
asserts the header under test really does carry two signatures, so the others cannot pass on a
single-signature header that says nothing about the grace window.

Mutation-proven against the server's signer, both directions:

| mutation                                    | result                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| the `v1=<prev>` entry is not emitted        | all 3 arms fail — precondition, TypeScript, Python                     |
| the signed string separator `.` becomes `:` | 2 fail (both verifiers); the shape precondition correctly still passes |

**Go is deliberately NOT covered here, and that is the honest part.** A `go test` arm was written and
worked when driven by hand. Inside the vitest harness it PASSED under the separator mutation while the
fixture on disk provably carried a colon-separated signature — the same command run by hand against
that same file fails. Go's test-result caching was ruled out directly: same path, changed content, no
`-count=1`, still fails. The cause is not understood.

An arm that can go green on an input it should reject is worse than an absent one, because it reads as
coverage — so it was removed along with the Go-side fixture test it drove, rather than shipped with a
caveat. Go remains covered by the source comparison only. Recorded as an open item with what was ruled
out, so the next attempt starts from the evidence instead of the idea.

`EXPECTED_TEST_FILES` 3005 → 3006, `_ALL` 3169 → 3170, for the one file added.

## V-1354 — the Go arm was mine to fix, not Go's to blame

V-1353 dropped the Go half of the signature bridge because it passed under a mutation while the
fixture provably carried a bad signature, and said the cause was not understood. It is now, and the
earlier account was wrong in a way worth stating: the entry claimed test-result caching had been
ruled out. It had not been. That experiment used a **different fixture path**, which is a different
cache entry — so it exonerated something other than the thing under suspicion.

The arm omitted `-count=1`. Instrumented properly — writing the captured spawn result to a file,
since vitest swallows console output from a passing test — the same command returns status 1 with
zero `--- PASS` lines the moment `-count=1` is present. The verifier was never at fault; the harness
was reading a cached green.

Restored, with `-count=1`, and now load-bearing on both mutations:

| mutation                             | arms that fail                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| signed-string separator `.` → `:`    | TypeScript, Python, **Go** (the header-shape precondition correctly still passes) |
| the `v1=<prev>` entry is not emitted | all four, precondition included                                                   |

**The generalisation was checked and is narrow.** `sdk-go-against-the-real-server` counts
`--- PASS`/`--- SKIP` the same way and could in principle have had the same hole — it already passes
`-count=1`. The exposure was in the arm I wrote, not in the pattern the repo uses.

Two things worth keeping from the detour. `go test` exits 0 and prints `PASS` for a package whose
tests all skipped, for a cached result, and for `-run` matching nothing — so neither the exit code nor
a bare `PASS` is evidence, which is why the arm counts `--- PASS:` lines by name and asserts the skip
count is zero. And when a probe's own output disappears, write it to a file: the console.log that
would have shown this immediately was swallowed because the test it lived in passed.

## V-1355 — a list that is non-empty as a string and empty as a list

`GET /v1/admin/cost/overview` takes `account_ids` as a comma-separated string and derives the list by
splitting, trimming and dropping empties. The schema requires `min(1)` on the STRING, which `","`
satisfies while producing no ids at all. Coverage put the refusal that catches this in the
never-executed set: nothing had ever sent the shape that produces it.

The mutation says what the check is worth, and it is more than a tidier error. With
`if (ids.length === 0)` disabled the request returns **200**, not a crash — the empty list reaches the
cost lookup and answers for zero accounts. To a staff caller that reads as "these accounts cost
nothing" rather than "you asked about no accounts", which is the more expensive of the two
misreadings. Arm added, proven on `expected 200 to be 400`, source restored byte-identical.

**A defect I talked myself into and then out of, before it was written down as one.**
`routes/account-me.ts:883` throws `data_base64 is not valid base64` from a `catch` around
`Buffer.from(value, 'base64')`. Node does not throw there — verified directly: garbage decoded to 18
bytes without error — so the catch is unreachable and that message can never be returned. Nothing
downstream sniffs the image either; the bytes go straight to R2 under the caller-declared
content-type. That reads like malformed base64 being stored as a customer's avatar.

It is not. `UploadAvatarRequestSchema` constrains the field with `/^[A-Za-z0-9+/=]+$/`, so a garbage
payload is refused at parse with "Must be base64-encoded" — the intended outcome, from the layer
above. Dead defence behind a validator, the same classification as V-1349 and V-1346, and the third
time this session that reading one more layer reversed a conclusion. The check I nearly skipped was
the one that mattered: what does the SCHEMA already reject.

## V-1356 — my own fix made one arm worse, and the real cost was elsewhere

V-1351 memoised `gateDefiners()` in the egress gate so four identical scans became one. Total work
fell fourfold and the file's isolated time dropped to 3.6s. Under the next full run it failed again —
**14036ms on the FIRST arm**, past the 10s ceiling.

The memo did what it said and still made that arm worse. Four scans at roughly 2.5s each kept every
individual arm under the limit; one scan of ~10s, paid entirely by whichever arm runs first, does not.
Reducing total work is not the same as reducing the worst arm, and the ceiling applies per arm.

The actual cost was never the repetition — it was comment-stripping every `.test.ts` in the directory.
Stripping can only REMOVE text, so a file whose stripped body contains `const hasEgressImpl =` must
contain `hasEgressImpl` in its raw source. That makes a plain substring test a sound pre-filter, and
it moves the expensive step from thousands of files to the handful that could possibly match.

File test time is now **476ms** — about seven times faster than the memoised version and roughly
thirty times faster than the original, with the same answer.

Both filters proven load-bearing, because a fast scan that matches nothing is the obvious way to make
this useless: breaking the regex fails the vacuity arm, and breaking the new substring pre-filter
fails it too. The pre-filter is not a no-op that happens to let everything through.

The lesson is the ordering one: when a scan is slow, look at what it does per file before looking at
how many times it runs. Four passes of an expensive strip and one pass of the same strip differ by a
constant; skipping the strip differs by the corpus.

## V-1357 — a cursor test that was really a clock test

`rate-limit-overrides-repo-contract` failed a full run on "page two did not continue after the
cursor", and passed alone. The message is about cursors and the cause was a deadline.

The arm creates four overrides and gives the second one `expiresAt: now + 250ms`, then reads page one
and page two, both of which must still contain it. That leaves a **250ms budget for several database
round-trips**. Under a full parallel run the budget is spent before page two is read, the row has
lapsed, and the assertion fails describing a cursor defect that is not there.

Rewritten to remove the clock rather than widen it. The row is now born with the far-future expiry
every other row uses, and is expired LATER by rewriting it with a past `expiresAt` — deterministic
where sleeping past a deadline is not. That depends on the upsert leaving `createdAt` alone so the row
keeps its place in the ordering, which was checked in BOTH implementations rather than assumed: the
Drizzle `onConflictDoUpdate` set-clause does not list `createdAt`, and the double uses
`existing?.createdAt ?? now`. A contract test that runs against two implementations has to be true of
both seams, not just the one that happened to fail.

The property is unchanged and still load-bearing. What it asserts is subtle and worth restating: the
cursor row is resolved by a SEPARATE query that deliberately does not filter on expiry, so a cursor
naming a row that has since lapsed still anchors the page. Neutralising that resolution — `if (c)` →
`if (false && c)` — fails this arm and a sibling that shares the mechanism, which is what shows the
determinism change bought speed and not silence.

Third flake this session whose message pointed away from its cause: a limit that was interference, a
gate that was a timeout, and now a cursor that was a deadline. The pattern is worth naming — under
load, the assertion that fails is rarely the one that is wrong.

## V-1358 — the wall-clock-budget class is empty, and the instrument took three passes to say so

V-1357 fixed a test that gave a row a 250ms life and then required two database round-trips to finish
inside it. Three load-sensitive flakes in one session is enough to ask whether that shape is a class,
so: every `Date.now() + <n>` in the test tree, evaluated, looking for a short deadline that has to
survive intervening work.

**The class is empty.** Apart from the one already repaired, nothing in the suite budgets real time
against real work:

- `db-webhooks-repo-consecutive-failures-drizzle` (two sites) stores `nextAttemptAt: now + 1000` and
  then asserts on `failuresOf()`, which reads the `consecutive_failures` COLUMN. The count does not
  consult the clock, so the deadline is stored and never raced.
- `services-oauth-client-service` passes `now: new Date(Date.now() + 1000)` as an INJECTED clock
  argument. That is the opposite of a wall-clock dependency — it is the fix, not the risk.

**The instrument is the part worth recording, because it was wrong twice and confident each time.**

| pass | reported               | why it was wrong                                                                                       |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| 1    | **33** short deadlines | the regex captured the first number only, so `Date.now() + 10 * 60_000` read as 10ms                   |
| 2    | **4**                  | arithmetic evaluated, but `Date.now() + 24 * HOUR` still read as 24ms — a NAMED factor is not a number |
| 3    | **3**                  | matches followed by `* <identifier>` rejected                                                          |

Each pass produced a clean-looking number and a list I could have acted on. The first would have sent
me to eleven "7ms deadlines" in `team-members.test.ts` that are seven days. The tell each time was the
same one that has worked all session: open the file and read the line, rather than trusting the
extraction — the first two candidates I opened were both false positives, which is what prompted the
re-measure instead of the fix.

Related: the same shape is already recorded for grep classifiers and for coverage intersection. This
adds a third medium — arithmetic in a matched expression — where the pattern that looks complete stops
one token short of the meaning.

## V-1359 — would plaintext-at-rest be noticed? Measured at both ends of the class

`apps/server/src` has **32 encrypt/decrypt/wrap boundaries** across eight modules. The question worth
asking of that class is not whether a round-trip works — every one of them tests that — but whether a
regression that stopped encrypting would be caught. A round-trip test cannot see it: if `encrypt`
returns the plaintext and `decrypt` hands it back, the round-trip still passes.

So the counterfactual is an **identity pair**, both halves mutated together, leaving the stored value
readable and unencrypted.

Probed at both ends of the coverage distribution:

| module                                                         | arms across its test files | identity pair caught by |
| -------------------------------------------------------------- | -------------------------- | ----------------------- |
| `account-proxy-secret-encryption` (customer proxy credentials) | 76                         | **8 tests**             |
| `platform-secret-value-encryption` (thinnest in the class)     | 25                         | **10 tests**            |

Both are caught, and the mechanism is worth recording because it is not the obvious one. Nothing
asserts "the stored value differs from the plaintext" directly. What fails are the **tamper and
wrong-context arms** — assertions that a modified blob, a foreign account, or a mismatched AAD is
REJECTED. Those cannot pass without real authenticated encryption, so they catch the absence of
encryption as a side effect of testing its integrity.

A first attempt mutated only `encrypt`, and 3 tests failed on decrypt-side format errors. That is
detection by round-trip breakage, which says nothing about the property in question — the pair is
what makes the question answerable, and it is the difference between "the format changed" and "the
secret is in the clear".

No arms added. The useful output is the mechanism: if someone later notices there is no direct
ciphertext-is-not-plaintext assertion and adds one, it is redundant rather than a gap being closed —
the AAD arms already stand in front of it, and they fail louder because they name what broke.

## V-1360 — a run disturbed mid-flight, attributed rather than chased

The full run after V-1359 reported **6 failed files but only 1 failed test**, with skips up from the
usual 16 to 39. That shape is worth reading carefully: five files failed without any assertion
failing, which means they broke at import or setup rather than in a test.

Attribution, before investigating:

- **Five are the peer's gui-client work in flight.** The errors are React — `useToasts requires
<ToastProvider>` and `view exploded` — raised as unhandled errors, and `git status` shows them
  mid-edit on `SettingsView.tsx`, `src/lib/settings.ts` and an auto-update test. Not server surface,
  not mine.
- **The one failing test reports a duration of 4,246,556ms** — roughly seventy minutes, for an arm
  that is not slow. That is not a 10-second timeout being exceeded; it is a stalled or suspended
  process being measured. Both files involved
  (`db-durable-webhook-list-keyset-drizzle`, `db-durable-webhook-reclaim-fence-drizzle`) pass together
  in **1.7s** immediately afterwards, and Postgres answers `select 1`.

The elevated skip count fits the same story: DB-gated suites skip when the probe cannot complete, and
a run competing with a peer's build and a `.husky/pre-commit` change is exactly when that happens.

Recorded rather than chased because the alternative is to spend a batch reproducing a suspension.
What would change the reading is the same failure with a plausible duration, or the keyset arm failing
in isolation — neither is true here.

## V-1361 — hashing, measured the same way as encryption, and the detector is again a side effect

V-1359 asked whether a regression that stopped ENCRYPTING would be noticed. The same question applies
to hashing, and a round-trip cannot answer it there either: if `hash(x)` returns `x` and the lookup
compares hash to hash, authentication still works and every end-to-end path passes.

Two boundaries, two counterfactuals.

**`tokenHash` as an identity — 100 tests across 17 files.** One function on both the store and lookup
sides, so an identity keeps every pair agreeing. The failures reach well past the lib: `auth-flows`,
`cli-authorize`, `account-web-sessions`, the MFA suites, `full-lifecycle`. Thoroughly guarded.

**`hashApiKey`/`verifyApiKey` as an identity pair — 18 tests across 9 files**, and the composition is
narrower: only **two are behavioural** (`api-keys`, `auth-tokens`); the rest are content-parity and
cross-source pins that fire because the source text changed. **No integration test noticed.**

That looked like a gap until the realistic version was tested. A one-sided wiring bug — the route
persisting the plaintext into `key_hash` — is not silent: `verifyApiKey` would fail on it and
authentication would break everywhere. The silent regression is an **algorithm downgrade**: a
consistent, weaker pair that still hashes and still round-trips.

**Downgraded to unsalted sha256 on both sides — 15 tests across 8 files, behavioural detection
included.** The arm that catches it is not one about algorithms at all: _"produces different hashes
for the same plaintext (random salt)"_. sha256 is deterministic, so the two hashes match and the arm
fails. Its sibling does the same for passwords.

So both classes are covered, and in both the detector is a side effect rather than the obvious test:
authenticated-encryption **tamper** arms catch the absence of encryption (V-1359), and a **salt**
arm catches the absence of a strong hash. In neither case does a direct "the stored value differs
from the input" assertion do the work — `api-keys.test.ts:43` has one, and it passes happily under
the sha256 downgrade.

Worth keeping for the next security-property sweep: ask what a weaker-but-consistent implementation
would still satisfy. The identity pair finds the absent property; the downgrade finds the degraded
one, and they are caught by different arms.

## V-1362 — when a source-text guard is the RIGHT instrument, with the criterion

Much of this session has been spent showing text pins standing in for behavioural coverage: the
pagination boundary, the deleted-owner refusals, the SDK signature comparison. This is the other half
of that picture, because two security properties here are **not behaviourally observable at all**, and
for those a source scan is the only instrument that exists.

**A CSPRNG downgrade.** Replacing `randomBytes` in `generateApiKey` with a `Math.random()` byte
generator produces keys that are well-formed, distinct, round-trip, hash, and authenticate — merely
predictable. `api-keys.test.ts` stayed **fully green**, exactly as it must: nothing about a single
generated value distinguishes a CSPRNG from a seeded PRNG. What fired was
`no-insecure-randomness-for-secrets`, naming the file: "Math.random() in non-allowlisted server
file(s): apps/server/src/lib/api-keys.ts".

**A constant-time comparison downgrade.** Replacing `timingSafeEqual` with `a === b` in
`constantTimeStringEq` is functionally identical for every input; only the timing differs. Six tests
across five files caught it and **every one is a source-text guard**, including a dedicated
`timing-safe-equal-pattern-cross-source-invariant`. Zero behavioural arms, which is the correct
outcome — a behavioural timing test would be the flaky kind this repo treats as a defect.

**The criterion, since "is a text pin acceptable here?" keeps coming up:** ask what a behavioural test
could observe. If a mutation changes an observable answer — a refusal that stops refusing, a page that
gains a row, a header a verifier rejects — a behavioural arm is available and a text pin is a weaker
substitute for it. If the mutation is observationally identical by construction, the source IS the
only evidence, and pinning it is correct engineering rather than thin coverage.

Both guards here are also honest about their reach. The timing one states in its own header that it
derives its set FROM the files already calling `timingSafeEqual`, so it enforces "every constant-time
comparison stays one" and cannot enforce "every comparison that should be constant-time is one" — a
brand-new plain `===` on secret material would pass it. That is a real residual, already named at the
site, and closing it means deciding which values are secret, which is static analysis with an unknown
yield. Recorded rather than reopened.

## V-1363 — the residual the timing guard names has no current instances

`timing-safe-equal-pattern-cross-source-invariant` states its own limit: it derives its set FROM the
files already calling `timingSafeEqual`, so it keeps existing constant-time comparisons constant-time
and cannot see a brand-new plain `===` on secret material. V-1362 recorded that as a real residual.
This measures it.

Sweeping `apps/server/src` for `===`/`!==` where BOTH sides carry a secret-shaped identifier
(secret/token/hash/key/password/signature/nonce/code) gives **17 sites**. Read individually, none is a
secret comparison in the sense that matters — a timing oracle needs the attacker to control one side
and to learn something they do not already have:

- **length and shape checks** — `secretBytes.length !== SECRET_RAW_BYTES` (mfa-totp).
- **public identifiers** — `code.clientId !== token.client_id`, `code.accountId !== …` (oauth-store,
  services/oauth). A client id is not a secret.
- **server-side against server-side** — `row.secret !== newSecret` during rotation (webhooks), and the
  auth cache revalidation comparing a freshly loaded key to the cached copy (services/auth ×4).
  Neither side is attacker-supplied.
- **content hashes** — legal document version/contentHash comparisons, agent turn-receipt idempotency
  hashes. Not credentials; learning one grants nothing.

The one that looked serious on first pass is `routes/auth-oauth-client.ts:229`,
`cookie.nonce !== stateNonce` — a CSRF binding check. It is not exploitable by timing, and the reason
is upstream rather than at the line: `stateNonce` is extracted from a **signature-verified** state JWT
and `cookie` from a **signature-verified** PKCE cookie. To reach the comparison at all an attacker
must already hold both validly-signed artefacts, so a byte-by-byte timing leak of one reveals
something they possess. It is a binding check between two authenticated values, which is what its own
comment says it is.

So the residual is real in principle and empty in practice. Nothing to fix, and the useful part is the
shape of the check: a comparison needs constant time when one side is **attacker-supplied** and the
other is a **secret the attacker is trying to learn**. Most secret-named comparisons fail one of those
two tests, which is why a scan for "compares something called a token" would be noise rather than a
guard — and is presumably why the existing one derives its set the way it does.

## V-1364 — the one upload cap that was not injectable was the one that was never enforced under test

`lib/upload-caps.ts` names three ceilings, and its own header explains the technique its arms use:
every behavioural arm over these caps "INJECTS a small value (that is the only way to drive a
rejection without moving gigabytes)". Two of the three have that seam. The per-file one did not:

| cap                          | injectable                           | its rejection      |
| ---------------------------- | ------------------------------------ | ------------------ |
| session lifetime bytes/count | `deps.sessionUploadMaxLifetimeBytes` | exercised          |
| per-account in-flight        | operator-configurable                | exercised          |
| **per-file decoded size**    | **no — a fixed const**               | **never executed** |

Coverage had `routes/agent-sessions.ts:3206` in the never-executed set, and the reason was structural:
`UPLOAD_MAX_FILE_BYTES` was read straight from the imported default, so crossing it needed a **64 MiB
decoded / ~85 MiB base64** body. Nothing was going to write that test, and the Fastify body limit
above it (96 MiB) is deliberately higher, so the handler is the authoritative enforcer with nothing
watching it.

Made injectable exactly like its siblings — `uploadMaxFileBytes?: number`, defaulted to
`UPLOAD_MAX_FILE_BYTES_DEFAULT` in the same destructuring the other two use — and covered with an arm
that runs at **8 bytes** instead of 85 MiB. The arm asserts both sides: a file exactly at the cap is
accepted (so it cannot be satisfied by a route that rejects everything), and one byte over is a 400
that never reaches the node.

It also distinguishes two rejections that look alike from outside: the lifetime caps answer **200**
with `status: 'error'` because the request was well-formed and the budget was spent, while an
oversized file is a malformed request and answers **400** before any reservation is taken.

Mutation-proven twice, and the second one is the interesting one:

- `if (bytes.length > UPLOAD_MAX_FILE_BYTES)` disabled → the oversized upload returns **200 and is
  relayed**, which is what the cap prevents.
- the destructuring default changed to a literal → `the-documented-upload-caps-are-the-enforced-ones`
  fails, so the new seam did not weaken the guarantee that the route applies the shared constant.

**A pin I had to move, in the same commit.** That guard pins the literal text
`UPLOAD_MAX_FILE_BYTES = UPLOAD_MAX_FILE_BYTES_DEFAULT` to prove the route defaults to the shared
constant. Making the cap injectable moved that default into the destructuring — the exact form its two
siblings are already pinned in one and two lines above. The pin now reads
`uploadMaxFileBytes = UPLOAD_MAX_FILE_BYTES_DEFAULT`, same property, same shape as its neighbours, and
the mutation above proves it still fires.

## V-1365 — two shared parsers documented a duplicate-header behaviour that cannot happen

`lib/idempotency-key.ts` and `lib/effective-account-header.ts` both narrow the header with
`Array.isArray(raw) ? raw[0] : raw`, and both described that line as the duplicate-header path:
a header sent twice resolves to its first value. Both descriptions were frozen by content-parity
pins, and the effective-account pin justified the line with a threat model — an attacker appending
a second header value to force an account scope.

The arm that read like coverage of that threat handed the parser a hand-built `[a, b]`. It proves
the parser can handle an array. **Nothing proved an array is what arrives.**

Measured on a socket. It is not:

| header sent twice      | what the handler receives   | verdict                                                                    |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `Idempotency-Key`      | `key-one, key-two` (string) | **400** — the joined value trips the whitespace rule                       |
| `X-Driftstack-Account` | `acc_A, acc_B` (string)     | **403** — clears the `acc_` format check, refused at the membership lookup |
| `Authorization`        | `Bearer first`              | first really does win — Node special-cases it                              |

Node puts only `set-cookie` in an array. A short list of headers discards duplicates, which is
where "first wins" is true; everything else — including both of these — is **joined with `', '`**.
So the array branch is unreachable for the two headers these parsers read, and the documented
behaviour was not the behaviour.

Both outcomes are fail-closed, and neither is fail-closed **by design**, which is why they are now
executed rather than described:

- The idempotency refusal rests on the **space** in the separator, not on anything noticing the
  duplication. Disabling the whitespace rule does not merely relax validation — the duplicated
  request **returns 201 and mints a session** under the key `key-one, key-two`, which is neither
  value the customer sent. A retry with either real key would then miss the dedup entry it was
  supposed to hit.
- The account refusal happens one step **later** than the pin assumed, and in a different file:
  the joined string keeps the `acc_` prefix, so it passes the format check and dies at the
  membership lookup.

The new arms open a socket, and they have to. `app.inject()` joins a duplicated value with a comma
and **no space**, which the idempotency contract accepts as a well-formed key — so an inject-based
version of this test exercises the accepting path while production takes the rejecting one. One arm
pins that divergence so the file does not get rewritten the easy way.

**Mutation-proven, five ways.** Allowing whitespace in the key → the duplicate mints a session
(201, not 400). Implementing the documented first-wins in the account parser → the duplicated
header resolves to self and returns **200 instead of 403**. Rejecting commas → the inject-divergence
arm goes red, so it is load-bearing on the specific property it names. And both corrected pins fail
when their source framing is reverted.

⚠️ **One of those five nearly went down as "not load-bearing".** The account-pin mutation was first
applied with BSD `sed` against a line containing an em dash; it silently matched nothing, the pin
stayed green, and that reads exactly like a pin that does not fire. Re-applied in Python with an
assertion that the target string was present first, it fails as it should. A mutation that does not
turn something red is a claim about the guard **only after** the mutation is proven to have landed.

Corrected in the same commit: two source comments, the two content-parity pins that froze them, and
the two shared-parser unit files whose titles asserted the same thing — six files, enumerated with
both grep patterns, no occurrence left. Each parser also gains the arm it was missing: what it does
with the joined string a customer can actually produce.

`EXPECTED_TEST_FILES` 3006 → 3007 and `EXPECTED_TEST_FILES_ALL` 3170 → 3171, for the one file added
here. Noted rather than fixed: `_ALL` was already six behind the 3176 the root config collects at
HEAD. `judge()` only fails on _fewer_ files than the pin, so the drift is silent and safe-direction,
and it is not mine to absorb.

## V-1366 — the third narrowing of that header guards a money path, and both shapes it names are unreachable

`POST /v1/billing/crypto-checkout` deliberately does **not** use the shared parser. Crypto purchases
are self-workspace only, so the route refuses `X-Driftstack-Account` outright instead of resolving
it, and a drift-guard beside it explains why the exception exists: the route is **stricter**, and
tidying it into the shared parser would make `'   '` and `['', 'acc_x']` start reading as absent, so
the self-workspace rule would silently stop rejecting them.

Measured on a socket, **neither shape can arrive**:

| what a client sends                 | what the handler receives                                |
| ----------------------------------- | -------------------------------------------------------- |
| `X-Driftstack-Account:` + spaces    | `''` — Node strips optional whitespace off a field value |
| the header twice, first value empty | `', acc_x'` — a joined **string**, never `['', 'acc_x']` |

So the justification named two inputs that cannot reach the guard, while the input a client _can_
send — the joined string — had never been executed against it. It holds, and for a reason worth
pinning: the guard tests **length**, not well-formedness, so a value no resolver would accept is
still enough to refuse. Both mutations confirm it. Disabling the refusal, and separately narrowing
the string branch to demand an `acc_` prefix, each turn the duplicated request into a **201 with a
persisted order** — an acting-as purchase completing on a money path.

The whitespace case goes the other way, and the arm now says so: `X-Driftstack-Account:    ` arrives
empty, is absent before any of our code runs, and the checkout correctly proceeds as a self-workspace
purchase. Treating it as absent is right. The claim that this route is stricter _about that shape_ is
not.

**And the exception's premise does not survive the measurement.** On every reachable input, refusing
on presence and using the shared parser now agree: `''` → absent for both, `', acc_x'` → present for
both. The route keeps its own guard anyway, and the drift-guard now says why in terms that are true —
its rule is _refuse on presence_, not _resolve_, and that intent should not become contingent on the
shared parser's trimming staying exactly as it is. What changed is the rationale, not the code: I am
not rewriting a money path to remove a redundancy that is currently harmless.

Three arms added to the socket file from V-1365, with a vacuity floor (a checkout carrying no
acting-as header is a 201 that persists exactly one order), so the two refusals cannot be satisfied
by a route that rejects every purchase.

## V-1367 — a repeated query parameter silently turned a filter off

`GET /v1/account/me/oauth-links` read its filter straight off the request:

```ts
app.get<{ Querystring: { active_only?: string } }>(…)
const activeOnly = request.query.active_only === 'true';
```

The generic is a claim, not a check. A repeated query key parses to an **array**, so the real type is
`string | string[] | undefined` — and an array is simply not equal to `'true'`. Sending
`?active_only=true&active_only=true` therefore returned **200 with the revoked links the caller asked
to hide**, `last_revoked_at` and all. Not an error: a wrong answer, on the read the dashboard's
"Connected accounts" view uses. A revoked integration renders as connected.

**This is the one site of five that had no validation.** Every direct `req.query.<x>` read in
`apps/server/src`:

| site                                                 | guard                   | array behaviour              |
| ---------------------------------------------------- | ----------------------- | ---------------------------- |
| `auth-oauth-client.ts` ×4 (`error`, `code`, `state`) | `typeof … === 'string'` | falls back to `''` → refuses |
| **`account-oauth-links.ts:58` (`active_only`)**      | **none**                | **silently answers false**   |

And the two other boolean query params in the codebase — `revoked` in `admin-api-keys.ts`,
`include_expired` in `admin-rate-limit-overrides.ts` — both parse through
`z.enum(['true','false']).optional()` first, which rejects an array and 400s. The customer-facing one
was the only one reading the parameter unvalidated.

**Fixed with `z.string().optional()`, deliberately not the siblings' enum.** Measured, the difference
is exactly the values a customer can already send:

| value                 | `z.string()`                  | `z.enum(['true','false'])` |
| --------------------- | ----------------------------- | -------------------------- |
| `['true','true']`     | reject                        | reject                     |
| `'1'`, `''`, `'TRUE'` | accept — "show all", as today | **reject (400)**           |

Adopting the enum would newly 400 requests that work today on a documented customer endpoint. That is
a different change from fixing the array, and it is not the one this defect calls for. The parameter's
**type** was wrong, not its accepted values.

Three arms, and the third is the one that pins the boundary: the repeat is a 400; the single-value
filter still filters (so the refusal is not satisfied by a route that rejects every filtered read);
and `1`, `''`, `TRUE`, `yes` are all still 200 with the full list. Mutation-proven both ways —
reverting to the raw read reds the repeat arm, and swapping in the enum reds the lenient-values arm
plus the pin that forbids it.

The pin over the read moved with it, in the same commit.

## V-1368 — the same untyped query read, on the bulk sign-out confirmation, answering 500

Sweeping the class from V-1367 rather than stopping at the one site: **16 routes declare a
`Querystring` generic**. The generic is a claim about the shape, and a repeated query key parses to
an array regardless of it. Classified by what actually stands between the array and the code:

| how the query is read                                               | routes | array behaviour                                     |
| ------------------------------------------------------------------- | ------ | --------------------------------------------------- |
| `parseOrThrow(<zod>, req.query)` / `safeParse`                      | 12     | rejected — the schemas are `z.string()`-based → 400 |
| `typeof … === 'string'` in a preHandler (`ds_token`) or at the read | 2      | falls back → 401 / dropped                          |
| **nothing**                                                         | **2**  | `active_only` (V-1367) and `keep`, below            |

⚠️ My first classifier called 12 of the 16 unvalidated. It was searching for `safeParse(req.query)`
and this codebase mostly uses a `parseOrThrow` helper, and two more validate in a **preHandler** the
route body never mentions. Reading each of the twelve is what produced the table above — the grep
would have published ten false positives.

**The second unvalidated site.** `DELETE /v1/account/web-sessions` requires `?keep=current` as an
explicit confirmation before signing out every other session:

```ts
const keep = (request.query?.keep ?? '').toLowerCase();
if (keep !== 'current') throw new BadRequestError('Bulk revoke requires `?keep=current`. …');
```

`.toLowerCase()` is not a method on an array. `?keep=current&keep=current` therefore threw a
TypeError and answered **500 Internal Server Error** — measured, not inferred — on a customer
endpoint whose entire job is to refuse anything that is not exactly this confirmation. Every _other_
unusable value of `keep` already gets a 400 naming the parameter to pass.

Nothing is revoked in either case: the throw happens before the revoke. So this is not a destructive
bug — it is the route answering "we broke" where it means "you did not confirm", and the arm asserts
both sessions are still alive afterwards so that stays true.

Fixed the same way as V-1367, `z.string().optional()`, and again **not** the tighter form. A
`z.literal('current')` would fold the confirmation into the schema and silently drop the
case-insensitivity the gate commits to — `?keep=CURRENT` works today. The second arm pins that, and
swapping the literal in reds it.

Both mutations land: reverting to the raw read reds the repeat arm **and both source pins**; the
literal reds the case arm and the pin that forbids it. Three pins moved with the source in one
commit — the content-parity read, its imports line, and the V-355 cross-source invariant.

⚠️ **Two mutation runs in this session reported nothing at all and I nearly read that as "the guard
does not fire".** The file list was in a shell variable, and **zsh does not word-split unquoted
variables** — so vitest received one argument containing spaces, matched no file, and printed no
summary. An empty result is not a passing result. Re-run with literal paths, and check for the
summary line before concluding anything.

## V-1369 — the class, guarded: a `Querystring` generic is a claim, and now something checks it

V-1367 and V-1368 were the same defect twice, and they failed in opposite directions — one answered
**200 with the wrong data**, the other answered **500** where it meant 400. Both are fixed and
behaviourally covered. Neither fix stops the third one.

So the population is now discovered from source and ruled on. Every route declaring a `Querystring`
generic must validate the querystring **where it reads it**, or appear in an `EXCEPTIONS` map with
the reason it does not. 16 routes, 13 validated, 3 excused:

| excused route                             | what actually stands in the way                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/v1/account/me/notifications` (SSE)      | `requireAuthEventSource` preHandler narrows `ds_token` with `typeof … === 'string'` and 401s otherwise; the handler never reads the query                          |
| `/v1/agent-sessions/:id/transcript` (SSE) | same preHandler                                                                                                                                                    |
| `/v1/auth/oauth/{provider}/callback`      | forwards the IDP query verbatim, appending only `typeof v === 'string'` entries, so a repeated key is dropped and the SPA exchange refuses the incomplete callback |

Three properties, because a list like that rots in three different ways:

- **The population is discovered, not listed.** A new route with a `Querystring` generic and no
  schema fails here rather than waiting for someone to send the parameter twice.
- **Exceptions are keyed by file + the declared generic**, so reshaping a route re-opens its
  exemption instead of carrying it. Proven: adding a second field to the notifications generic makes
  its excuse go stale and the route unaccounted-for, and both arms fire.
- **No exception may outlive its route.** An entry matching nothing is an excuse the next route in
  that file would inherit.

**The detector is floored on both sides and tested against known inputs**, because this guard's whole
value is its classifier. A discovery regex matching nothing satisfies the rule vacuously; one
matching everything satisfies it just as well. So the arm asserts ≥16 discovered and ≥13 classified
validated, and then feeds the classifier a `safeParse(req.query)` (must be true) and the exact raw
read from V-1368 (must be false — a classifier that clears that line would have cleared both
defects).

⚠️ **The first version of this classifier was wrong in exactly the way it now tests against.** It
accepted any `typeof x === 'string'` anywhere in the handler, which cleared two routes that validate
somewhere else entirely, and it searched only for `safeParse` while most of this codebase uses a
`parseOrThrow` helper — between them, ten false results. The rule is query-rooted now:
`safeParse(req.query)`, `parseOrThrow(X, req.query)`, or `typeof req.query.<k> === 'string'`.
Comments and string literals are blanked (newlines preserved, so reported line numbers still point at
the source) — otherwise a route that merely _mentions_ `safeParse` in a comment reads as validated.

Mutation-proven three ways, all source-side: reverting `active_only` to its raw read reds the rule,
the floor, and the arm that pins the two repaired routes to the validated side; removing one
`Querystring` generic reds the population floor; reshaping an excused route reds the staleness arm.

`EXPECTED_TEST_FILES` 3007 → 3008, `_ALL` 3171 → 3172.

## V-1370 — a customer surface inherited a staff exemption because of its filename

`unknown-request-fields-coverage-invariant` requires every customer-facing write to report the
fields it ignored, and waives three groups. The first waiver is `admin-*`, with a stated reason: a
mistyped field on a staff surface is a mistyped admin action, "not a customer's resource silently
configured as something they did not ask for". Alongside the prefix sat one exact filename —
`admin.ts`.

**`routes/admin.ts` registers no staff routes.** Every one of the six is customer self-service behind
plain `requireAuth`:

| route                                                                  | gate                                   |
| ---------------------------------------------------------------------- | -------------------------------------- |
| `POST` / `GET` / `DELETE /v1/api-keys`, `POST /v1/api-keys/:id/rotate` | `requireAuth`                          |
| `GET /v1/usage`, `GET /v1/usage/series`                                | `requireAuth` + `requireScope('read')` |

Its own comment calls the rotate route "customer self-service rotation". The exemption was granted by
filename, not by gate — and the file's two writes reported nothing.

**What that dropped.** `scopes` is required on create, so a mistyped one is a 400. `expires_at` is
**optional**, so a mistyped one is stripped and the key is minted with **no expiry at all** — a
credential that outlives what its owner asked for, answered **201 with nothing said**. Measured:
`expiresAt` instead of `expires_at` returns 201, `expires_at: null`, no header. That is exactly the
case the admin rationale says it is _not_ covering.

Both writes report now, and the exemption is gone from the prefix list. Three arms: the mistyped
create is named back in `x-driftstack-unknown-fields` **and** the response proves the drop was real
(`expires_at` null); a clean create carries no header, so the first arm cannot be satisfied by a
route that reports on everything; and a rotate carrying `nmae` reports it while the name stays
unchanged.

**Rule 2 earned its keep here.** The import-style grep found the coverage invariant. A second guard —
`an-exempt-surface-that-can-drop-a-field-is-listed` — keeps its **own copy** of the exempt-prefix
list and pins `admin.ts (CreateApiKeyRequestSchema)` in its droppable set. It passed the whole time,
because it was reading its own stale copy. Only the quoted-basename pattern found it. Both lists and
the pinned entry move in this commit.

⚠️ **A gap I am recording rather than closing.** The coverage invariant derives its population from
schema **parse sites** (`XSchema.parse(req.body)`, `parseOrThrow`). The rotate route validates its
body by hand — `typeof body.name === 'string'` plus a length bound — so it has no parse site and the
invariant cannot see it at all. Mutation shows this precisely: unwiring the **create** reporter reds
the invariant _and_ the behavioural arm; unwiring the **rotate** reporter reds only the behavioural
arm. It is wired here because it is a customer-facing write, not because anything structural
demanded it. A hand-validated body is invisible to that derivation, and extending it is a change to
569 lines of load-bearing machinery that this batch is not the right place for.

## V-1371 — the header the docs tell customers to read, that no browser could read

`unknown-request-fields.ts` sets `x-driftstack-unknown-fields` on customer-facing writes, and
`apps/docs/src/pages/api/versioning.md` instructs integrators plainly:

> Log `x-driftstack-unknown-fields` in non-production. Its presence means a field you sent was
> ignored — usually a typo, occasionally a field removed on our side.

The page even walks through the example: `PATCH /v1/account/me` with a mistyped `timezonee` returns
200, applies the `name` change, and names the dropped key back.

**It was not on `Access-Control-Expose-Headers`.** A response header absent from that list is
unreadable from JavaScript on a different origin — `headers.get()` returns null — and the dashboard
at `app.driftstack.dev` is a different origin from `api.driftstack.dev`. So the entire
report-never-reject mechanism, ~33 call sites of it, was invisible to every browser caller including
our own dashboard. Server-side SDK callers were never subject to CORS and could always read it, which
is why nothing looked broken.

Measured, not inferred: a cross-origin `PATCH /v1/account/me` carrying `timezonee` answers 200 with
`x-driftstack-unknown-fields: timezonee` on the wire and an expose list of
`x-request-id, idempotent-replayed, x-ratelimit-*, retry-after` — the one header the docs point at,
missing.

One line to fix, and nothing new is disclosed by it: the value is the caller's **own** top-level keys
echoed back, bounded and sanitised at the send site, and never set for an anonymous caller — that
last part is why `status-subscribe` is exempt from the mechanism in the first place. Exposure changes
who can _read_ what was already on the wire, not who receives it.

**Two arms, because the obvious one is not enough.** Asserting the allowlist on `/version` passes
while the write that produces the header answers without it, so the second arm drives the documented
example end to end: the header is sent, carries `timezonee`, and is exposed on that same response.
Mutation confirms the split — removing the entry reds both arms and the source pin; leaving the entry
and deleting the `reply.header` call reds **only** the second.

⚠️ **A second gap in the same header, not fixed here.** It is sent on ~33 routes and declared in
`packages/sdk-python/openapi.json` **zero** times, which is precisely what V-944's guard exists to
catch. That guard misses it: `sentHeaders()` matches `.header('literal')` only, and this is the one
header in the server set via a constant — `reply.header(UNKNOWN_FIELDS_HEADER, …)`. Measured across
`apps/server/src`: 19 header names visible to the guard, exactly 1 invisible, and it is this one.
Next batch.

## V-1372 — a guard whose population was defined by how a name is spelled

V-944's rule is two-sided and good: every response header the server sends is declared in the
published spec, or exempt with a stated reason. Its scan was
`.matchAll(/\.header\(\s*'([A-Za-z0-9-]+)'/g)` — **quoted literals only**.

Measured across `apps/server/src`: **19 header names visible to it, exactly 1 invisible.** The
invisible one is `reply.header(UNKNOWN_FIELDS_HEADER, …)` — and it is the header
`apps/docs/api/versioning.md` gives a worked example of and tells integrators to log.

The consequence is subtler than "one header unchecked": it was outside the rule in **both**
directions. Never reported as sent-but-undeclared, and not listable as exempt either — an exemption
for it would have failed the staleness arm, because nothing the scan could see sent it. A guard whose
population depends on a coding style has a blind spot shaped like that style, and the one header
written differently was the one with a documented customer workflow.

The scan now resolves `const SOME_HEADER = 'x-name'` across the source tree and follows
`reply.header(IDENT, …)` through it. Constants are collected in a first pass, because a send can
precede its declaration in file order and the constant is routinely exported from another module.

**Then the rule had to be answered, which is the point of fixing a detector.** Declaring this header
means editing ~40 of the **232 hand-written 2xx blocks** in `openapi.ts` — it is sent on 40
customer-facing writes and no error path — and keeping that subset in sync by hand, with no shared
2xx construct to hang it on. That is the same cost the X-Request-Id decision above this one already
declined for success responses.

So it is exempt, on the ground the rule actually cares about: **not invisible to customers.** The
docs give it a section and a worked example, and V-1371 put it on `Access-Control-Expose-Headers` so
a browser can read it at all.

⭐ **And that ground is checked rather than asserted**, in the style this file already uses for its
`.strict()` exemptions. A new arm reads the docs page and `lib/app.ts` and fails if either premise
goes away — because an exemption whose reason has quietly stopped being true still reads as
considered.

Four mutations, each hitting a different arm:

| mutation                      | what reds                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| detector back to literal-only | the constant-resolution arm **and** the staleness arm — the exemption instantly names a header "nothing sends" |
| drop the EXEMPT entry         | the undeclared rule, proving the header is genuinely in the population now                                     |
| un-expose it in `app.ts`      | the checked-premise arm                                                                                        |
| remove the docs instruction   | the checked-premise arm                                                                                        |

## V-1373 — the two waiver lists that produced V-1370 were held in agreement by nothing

`unknown-request-fields-coverage-invariant` waives route files from the report-unknown-fields rule.
`an-exempt-surface-that-can-drop-a-field-is-listed` audits _which of those waived surfaces can
actually drop a field_. The second is meaningless if its population is not the first's — and it kept
its **own copy** of both lists, duplicated by construction and independent by code.

That is exactly how V-1370 hid. `admin.ts` sat on both under a staff-surface rationale it did not
qualify for; the sibling guard stayed green throughout because it was reading its own stale copy, and
only the quoted-basename grep found it. Fixing one copy would have left the other silently waiving a
customer surface.

The second guard now reads the first's source and asserts the two waiver sets are identical —
prefixes and files — with comments blanked so a commented-out entry cannot count as declared, and a
floor so a broken extraction reds instead of agreeing with anything.

Three mutations, and the first is the point:

| mutation                                                                | result                                                                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `admin.ts` back on the **sibling's** list only — the exact V-1370 shape | caught: _"the two files disagree on which route-file PREFIXES are waived"_ |
| a file removed from **this** guard's list only                          | caught, plus the droppable-set arm reds on the now-stale entries           |
| extraction broken so both lists parse empty                             | caught by the floor: _"nothing parsed out of the coverage invariant"_      |

⚠️ **The third mutation's first attempt did not run and printed `Tests 6 passed`.** Its target string
had been reflowed by prettier across two lines, so the replacement matched nothing and the "proof"
was an unmutated run reporting green — the same shape as the zsh word-splitting incident earlier this
session, from a different cause. The `assert` on the target caught it. A mutation proof needs both:
the target asserted present _before_ the run, and a real failure _after_ it.

### Negative result, recorded so it is not re-run

Before this, I generated candidates by finding refusal messages in `apps/server/src` that appear in
no test file. It reported **114**. It is a bad detector, and both halves of that are worth writing
down:

- At the **service layer** the refined count is **0** — every refusal message there has all its
  distinctive words present somewhere in the test tree.
- At the **route layer** it flagged three SSRF refusals on customer proxy config
  (`account-me.ts:460/537/556`). All three are thoroughly covered: `account-me-proxies.test.ts` drives
  a metadata-address OpenVPN `remote`, a private-address WireGuard endpoint, and a metadata-address
  WireGuard `dns` — each asserting `.toMatch(/metadata|private|loopback/i)` rather than the literal
  message. The heuristic cannot see an assertion that matches on a pattern, which is how a
  well-written arm is usually written.

Two other veins checked and found sound rather than left implied: the five `expiresAt` gates in
`services/auth.ts` are already the declared subject of `auth-slow-path-denials-actually-deny` (32
throws enumerated across four functions) plus two named cache-revalidation files; and
`packages/webhook-delivery`'s in-memory double warns that production must inject an SSRF-guarded
fetch, which `durable-webhook-delivery.ts` and `webhook-worker.ts` both do by **default** rather than
by injection — a stronger posture than the comment asks for.

## V-1374 — two private comment-strippers, one of them mine, and a guard that could only see one spelling

The full run after V-1373 went red on `no-guard-strips-comments-by-hand`: my new cross-check
hand-rolled `.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/\/\/[^\n]*/g,' ')` when the repo ships
`tests/unit/_helpers/code-only.ts` for exactly that. Its rationale is right — a private copy models
comments but not string or regex literals, and gets it wrong **silently**, because the guard keeps
passing while scanning a file it has blanked.

**It caught one of my two copies.** Its signature is the escaped regex-literal shape
`/\*[\s\S]*?\*\//`, so it sees the two-`replace` idiom and nothing else. A hand-written character
scanner is invisible to it. Measured across the test tree, three exist:

| private stripper                                                                      | seen by the guard |
| ------------------------------------------------------------------------------------- | ----------------- |
| `an-exempt-surface-…` (V-1373, mine) — two-regex form                                 | **yes**, flagged  |
| `every-querystring-route-…` (V-1369, mine) — character scanner                        | no                |
| `a-published-response-…` and `bootstrap-unwired-optional-deps-…` — character scanners | no                |

Both of mine now call `codeOnly`. My V-1369 copy was also **misnamed** — `blankCommentsAndStrings`
skipped _past_ string literals rather than blanking them, which is what `codeOnly` does and why it is
safe to swap: the string handling exists so a `//` inside a literal is not read as a comment, not to
remove the literal. The two pre-existing scanners are recorded here, not touched: writing an honest
`ALLOWED` reason for a guard I have not read is how a waiver becomes decoration.

⚠️ **And a claim I nearly made about my own guard, which the control refuted.** I mutated an exempted
route to carry a comment mentioning `safeParse(req.query)`, expecting the comment handling to be what
kept it classified as unvalidated. It stayed green — but so did the **control** with comment
stripping disabled entirely. The mutation site could never have shown anything: flipping an
_exempted_ route to "validates" is invisible to both arms, since it is neither unaccounted-for nor a
stale key.

The real conclusion is about the guard, not the experiment: with every route currently either
validating or excepted, **nothing in the population exercised the comment handling at all.** Dropping
`codeOnly` would have gone unnoticed until the first unvalidated route landed — precisely the moment
the guard exists to speak. So the classifier floor now feeds itself a parse that appears **only
inside a comment** and asserts it does not read as validation. Removing `codeOnly` from that one
expression reds it, which is the proof the route-level mutation could not give.

V-1373's cross-check was re-proven through `codeOnly`: `admin.ts` back on the sibling's list alone
still fails with _"the two files disagree on which route-file PREFIXES are waived"_.

## V-1375 — the base64 malleability guard was never once executed, and its test always passed

Fresh coverage over `apps/server/src` (v8, statements resolved to the **narrowest** covering
statement, never the max over spanning ones) put `services/recipe-payload-encryption.ts:118` in the
never-executed set:

```ts
if (blob.length < MIN … || blob.length > MAX || blob.toString('base64') !== ciphertext) {
  throw new Error('Recipe payload ciphertext is not canonical bounded base64.');
}
```

That third clause is the malleability check. Base64 has spellings that decode to identical bytes —
the final character carries slack bits a canonical encoder always writes as zero — so without
re-encoding and comparing, one payload has several valid stored forms, and anything keyed or compared
on the stored string can be bypassed by respelling it.

**An arm already claimed to cover it.** It ended in a fallback:

> the respelling did not decode identically, so it is refused by the shape/auth path instead — still
> refused, which is the property

Coverage says that branch is what ran **every time**. Its respelling flipped the _second-to-last_
character between `'A'` and `'B'` whichever it happened to be — which usually changes bits outside
the slack, so the bytes differ, and the coarser shape/auth path answers one layer up. The arm passed
on a property it never reached.

**Proven with the same mutation on both versions of the test** — only the test differs, so the
comparison is honest:

| test                 | `blob.toString('base64') !== ciphertext` replaced with `false` |
| -------------------- | -------------------------------------------------------------- |
| the arm at HEAD      | **10 passed** — deleting the check entirely goes unnoticed     |
| the arm as rewritten | **fails**: _expected [Function] to throw an error_             |

The rewrite is deterministic instead of probabilistic. It pads the JSON with trailing whitespace
(still valid JSON) until the blob length forces one `=`, then flips the low bit of the final data
character — the only way to respell base64 without changing what it decodes to. Four controls stand
in front of the assertion so a failure can only be the canonicality check: the respelling differs
from the canonical form, decodes to the **same bytes**, clears the shape regex and the `%4` check
(otherwise it never reaches the comparison), and the canonical spelling of that very payload **reads
successfully**.

Two other candidates from the same coverage set were checked and are **not** defects, recorded so the
next sweep does not re-open them: `status-subscribers.ts:133` and `:168` are the purge-row guards
whose own comments say they are unreachable and exist for type-narrowing; and the proxy SSRF refusals
at `account-me.ts:460/537/556` — which the message-grep heuristic wrongly flagged in V-1373 — are
absent from the never-executed set, confirming the coverage instrument and the earlier hand check
agree.

⚠️ **Process note.** To run the control I overwrote the working test with its HEAD version and lost
the rewrite, which had to be re-applied from scratch. A control that needs the old file should copy
the **new** one aside first; `git show HEAD:… > file` is not a read.

## V-1376 — the same canonicality check at six sites, swept by mutation: four live, one dark, one arithmetic

V-1375 found the re-encode canonicality check in `recipe-payload-encryption.ts` had never executed.
The same idiom — decode, re-encode, compare to the stored string — appears at **six** places in the
server. Statement coverage cannot answer this one: every site writes it as
`length-wrong || re-encode-differs`, so the throw shows as covered whenever the _length_ clause
fires. Only mutation separates them. Each canonicality clause replaced, one at a time, against every
test that names its module:

| site                                         | verdict                        |
| -------------------------------------------- | ------------------------------ |
| `lib/account-proxy-secret-encryption.ts:125` | **live** — reds its own arm    |
| `lib/livekit-secret-encryption.ts:44`        | **live**                       |
| `lib/mfa-totp.ts:221`                        | **live**                       |
| `lib/profile-key-hierarchy.ts:61`            | **live**                       |
| `services/recipe-payload-encryption.ts:116`  | **was dark** — fixed in V-1375 |
| `lib/webhook-secret-encryption.ts:73`        | **survives** — see below       |

⭐ The proxy arm's own title records this exact class being found there before: _"the case the payload
test is named for and does not contain"_. V-1375 was the same shape one module over.

**The survivor is not a gap.** Removing the clause leaves **594** webhook tests green, and that is
correct: this envelope is fixed-length, and at this length base64 has nothing to respell.
12 (IV) + 16 (tag) + 38 (secret) = **66 bytes**, and **66 % 3 === 0**, so the encoding is exactly 88
characters with no padding and no slack bits. The shape check one line above — 88 chars, alphabet
only, no `=` — therefore already admits only the canonical spelling. Confirmed empirically as well as
arithmetically: **0 of 200,000** random 88-character alphabet strings re-encode differently.

So the honest fix is not to "cover" the check but to pin **why** it cannot fire, because that reason
is a length relationship somebody could change without noticing what it was holding up. The new arm
asserts the blob is a multiple of 3, that it encodes to the pinned 88-character width with no
padding, and then makes the claim itself falsifiable: 2,000 generated 88-character alphabet strings,
every one of which must re-encode identically. A single counter-example reverses the finding.

Both halves mutation-proven: changing the secret length from 38 to 39 bytes reds it with _"the blob
length gained slack bits — the re-encode check is now live"_, and letting `=` into the generated
candidates reds the counter-example loop. If that arm ever goes red, the webhook check has become
reachable and needs the deterministic respelling arm recipe payloads got in V-1375.

## V-1377 — a bound nobody had crossed was a bound nobody had checked

Cloning a profile whose name is taken derives `"src (copy)"`, `"src (copy 2)"`, … and gives up after
99 attempts with a 409. Coverage put that refusal in the never-executed set.

An arm already proved the loop **advances** — seed `src` and `src (copy)`, get `src (copy 2)`.
Nothing proved where it **stops**, and the two failures at that edge point in opposite directions:
one candidate too generous hands back a name that already exists, so the insert then races the unique
index; one too strict refuses a clone the customer could have had.

Two arms, and the second is the one that makes the first mean something. With all 99 candidates taken
the clone is refused, with `status: 409` and `extensions: { resource: 'profile', field: 'name' }`.
With **98** taken — the last candidate still free — it must be _used_, not refused. Mutation
separates them cleanly: deleting the refusal reds only the first, and changing the loop bound from 99
to 98 reds only the second.

⚠️ **The first draft was unreachable and said so loudly.** Seeding 100 profiles on the tier the
neighbouring arms use tripped the tier cap first — _"Tier 'team_manual' permits at most 50"_ — so the
copy-name loop was never entered. The refusal needs 101 rows to be reachable at all, which is why
these two arms run on `agency_manual` (200) while their neighbours do not. A bound behind another
bound is only testable from outside the tighter one.

### Two dark lines checked and NOT defects, recorded so the next sweep does not re-open them

Both are second-layer defence behind a zod schema that answers first, which is the dominant shape in
this file's never-executed set once the `if (!ctx)` type-narrowing idiom is filtered out (142 throws
remain of 261).

- **`services/oauth.ts:518`** — `only S256 PKCE is supported`. The route schema is
  `z.literal('S256')`, so nothing else reaches the service. The dedicated test file already documents
  this exactly: PKCE is enforced in two places and _"relaxing EITHER one alone leaves `plain` still
  refused, so a single-layer mutation makes this file look vacuous when it is not"_. Known, correct,
  and better documented than most guards.
- **`services/webhooks.ts:991`** — `Invalid URL`. Both `CreateWebhookRequestSchema` and
  `UpdateWebhookRequestSchema` are `z.string().url().refine(startsWith('https://'))`, so a malformed
  URL is a 400 at the route and never reaches `parseHttpsUrl`. Worth noting the sibling at `:994`
  throws **409** for `http://` while the published spec declares only `['201','400','401','403','429']`
  on that operation — an undeclared status, but unreachable for the same reason, so it is a latent
  mismatch rather than a live one.

## V-1378 — four refusals on the LiveKit secret envelope, each the encoding half of a guard whose length half was already pinned

Coverage put four throws in `lib/livekit-secret-encryption.ts` in the never-executed set. Every one of
them sits beside a check that IS exercised, which is why nothing looked thin:

| dark line                                        | its exercised neighbour                             |
| ------------------------------------------------ | --------------------------------------------------- |
| `:53` context field is not valid Unicode         | the `1..maxBytes` length bound in the same function |
| `:132` API secret is not valid Unicode (encrypt) | `assertSecretBytes` length bound, one line down     |
| `:119` decrypted plaintext is not valid UTF-8    | the same length bound, on the read side             |
| `:107` stored blob exceeds the API-secret bound  | the _minimum_ blob-length check, one line up        |

`assertBoundedUtf8` is the clearest case: it checks encoding **before** length, and an arm two
screens up already pins the length half — including a `CRITICAL bounds context fields from ABOVE`
arm whose own header records that deleting the upper bound once left 22,425 tests green. The encoding
half had the same status and nobody had noticed, because the compound guard reads as covered.

**Why each matters, not just that it is dark.** The sibling module states the principle: a lone
surrogate "encodes to U+FFFD replacement bytes, so the value sealed into the envelope is NOT the
value the caller passed".

- A **context field** that way makes the AAD bind a tuple that differs from the row the credential
  came from, so every later decrypt under the real value fails authentication.
- An **API secret** that way mints LiveKit room tokens signed with a secret nobody can reproduce.
- On the **read** side authentication has already succeeded — the envelope is genuine — so nothing
  before that point objects, and the caller would receive a lossy rendering of the secret and sign
  with it.
- The **size bound** guards a shape the encrypt path cannot produce (it caps plaintext at 4096), so
  it can only arrive from storage, which is exactly what it is for.

Each arm carries its own control so it cannot pass for the wrong reason: the Unicode arms assert the
premise (the value does not survive a UTF-8 round trip) and that a well-formed sibling still
encrypts; the read-side arm builds the identical raw envelope with valid bytes and round-trips it;
and the size arm asserts that a blob **exactly at** the bound clears the size gate and fails on
authentication instead — so the check is a bound, not an off-by-one refusal of legitimate rows.

Four mutations, four distinct reds, one per arm.

## V-1379 — three dark storage bounds in one module, and only one of them was a gap

`lib/byok-anthropic-encryption.ts` had three never-executed throws around the same property. They are
not the same kind of dark, and the difference is the whole finding:

| line                               | status                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `:70` encrypt-side plaintext bound | **unreachable** — `looksLikeAnthropicKey` runs first and admits exactly the same maximum |
| `:94` decrypt-side plaintext bound | **unreachable** — the payload range above it is the same inequality plus 28              |
| `:80` payload byte-range           | **a real gap** — never ran in either direction                                           |

The arithmetic: GCM does not pad, so ciphertext length equals plaintext length and
`blob = 12 (iv) + 16 (tag) + plaintext`. `MAX_PLAINTEXT = len('sk-ant-') + 512 = 519`, and
`MAX_PAYLOAD = 547`. So `plaintext ≤ 519 ⟺ blob ≤ 547` exactly, and the regex
`/^sk-ant-[A-Za-z0-9_-]{1,512}$/` accepts a 519-byte key and refuses a 520-byte one. Two of the three
bounds are therefore defence in depth — but only while those three numbers agree.

**Reaching the one that is real took a second look.** Driving it through `decryptByokAnthropicKey`
failed with _"BYOK v2 envelope is 61 bytes; outside the bounded storage shape"_ — the v2 reader gates
the whole envelope on the same numbers before `decryptPayload` ever sees it, so the range check is
subsumed on that path too. It is reachable through exactly one caller:
`decryptLegacyByokAnthropicKey` hands its blob straight to `decryptPayload` with no envelope gate,
which is the path a pre-v2 stored row takes. Both halves are now driven there, and the upper one
pins the boundary — a blob at **547** must clear the size gate and fail on authentication instead, so
the range cannot start refusing legitimate rows a byte early.

The third arm pins the subsumption rather than the dead branches, in the shape V-1376 used for the
webhook canonicality check: the longest accepted key **is** the bound, one character more is refused,
and a max-length plaintext produces a blob of exactly `iv + tag + 519`. Widening the shape regex from
512 to 600 reds it — which is the point. Move any of those numbers and a dead branch becomes a live,
untested one.

Mutations: dropping the range's lower half reds the short arm, dropping its upper half reds the long
arm, and widening the regex reds the arithmetic arm (alongside the module's own shape test).

Named and not pursued: `lib/account-proxy-secret-encryption.ts:150` is the same read-side plaintext
bound for proxy slots (`password` 4 KiB, `openvpn-config` 2 MiB, `wireguard-private-key`), still dark
and reachable the same way through a stored envelope. Same shape, different module — a batch of its
own rather than a footnote to this one.

## V-1380 — closing a deferral the file itself had written down

`account-proxy-secret-encryption.test.ts` carried a note listing three read-path guards as
deliberately unmeasured, and it named the method: their reachability had to be settled empirically,
the way the webhook module's was, before writing a test. Coverage now says two of them are driven by
arms added since, and exactly **one statement in the whole module is dark** (91/92) — the plaintext
bound after decrypt.

**Settled by measurement, not by reading the source.** Forging a genuine v2 envelope one byte past
each slot's bound and reading it back:

| forged plaintext                   | which guard answers                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| 44 bytes (WireGuard, at the bound) | the slot schema — _"WireGuard private key is invalid"_                         |
| 45, 46, 60, 4096 bytes             | _"outside its canonical bounded base64 shape"_ — the envelope gate, every time |

So the bound is unreachable, and the reason is structural: `decodeCanonicalEnvelope` bounds the blob
at `iv + tag + maximumPlaintextBytes(slot)` — the **same** per-slot number — and AES-GCM does not pad,
so ciphertext length equals plaintext length. `plaintext > max` and `blob > 28 + max` are one
inequality, and the gate reaches it first on every path: `decryptPayload` is the only route in and it
always decodes through that gate. That is the difference from V-1379's BYOK module, where a legacy
reader skips its equivalent and the same-shaped check _was_ live.

The arm pins **which guard answers** across all three slots rather than restating the arithmetic, and
the mutations show why that is the right property:

- Widening the gate by 4096 makes the failure message change to _"plaintext exceeds its byte bound"_ —
  the dead branch becoming live and untested, caught immediately.
- Shrinking it by one byte reds the at-bound control, so the gate cannot start refusing legitimate
  rows early.

The stale note is rewritten to record the measured outcome rather than the open question.

⚠️ **The probe's own output vanished the first time.** It ran as a passing test and vitest swallows
`console.log` from those, so the run reported `Tests 1 passed` and told me nothing. Re-run writing the
results to a file, it produced the table above. A probe that cannot show its work has not been run.

## V-1381 — the one storage bound in the family that is not subsumed

Five modules carry the same shape — refuse a plaintext past a byte bound — and four of them turned
out to be unreachable, each because the stored blob is bounded at `iv + tag + max` and AES-GCM does
not pad, making the two checks one inequality 28 bytes apart:

| module                                       | verdict                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `livekit-secret-encryption`                  | covered directly (V-1378)                                                                           |
| `webhook-secret-encryption`                  | unreachable — fixed-width encoding (V-1376)                                                         |
| `byok-anthropic-encryption`                  | encrypt + decrypt sides unreachable; the payload range live only through the legacy reader (V-1379) |
| `account-proxy-secret-encryption`            | unreachable — the envelope gate uses the same per-slot number (V-1380)                              |
| **`recipe-payload-encryption` encrypt side** | **reachable**                                                                                       |

The decrypt side here is subsumed like the rest, by `decodeCiphertextBase64`. The **encrypt** side is
not, and the reason is upstream rather than local: `AgentIntentSchema` types `url`, `selector` and
`value` as bare `z.string()` with **no length cap**, so a single intent can carry an arbitrarily long
value straight through `RecipeIntentLogSchema.parse` into `encryptJson`. This bound is the only thing
between a customer-supplied intent and a multi-megabyte encrypted row, and it had never executed.

Cheap to drive despite the size: the check reads `Buffer.byteLength` **before** any cipher touches
the data, so nothing encrypts 64 MiB — building the payload costs ~75 ms and ~240 MB RSS, measured
before committing to the approach.

The arm asserts its own premise first, because that premise is exactly what would silently invalidate
it: the intent schema must **not** refuse the oversized value. If a length cap is ever added upstream,
this bound joins its four siblings as subsumed and the arm says so rather than continuing to pass for
a new reason.

Mutations: removing the bound reds the arm; shrinking it to 32 bytes reds four _pre-existing_ arms in
the same file — which is the ordinary-payload control working, since a bound that small refuses
routine round-trips.

## V-1382 — a wire codec that documented a refusal it never performed

Coverage put `services/harness-control-codec.ts:95` in the never-executed set. It is the catch arm of:

```ts
try {
  json = Buffer.from(base64, 'base64').toString('utf8');
} catch {
  throw new HarnessWireCodecError('inputParams/outputData is not valid base64');
}
```

**`Buffer.from(x, 'base64')` throws for no input.** Measured across `'not-base64!!'`, `'$$$$'`,
`'A'`, `'AAA'`, `'===='`, `'ÿþ'` and `''`: every one returns a Buffer. Node drops characters outside
the alphabet and hands back whatever bytes remain. So that catch could never fire — and the JSDoc
above it promised _"Throws HarnessWireCodecError on malformed base64 or invalid JSON"_, which is only
half true.

The dead branch is harmless. The doc comment is not: it reads as though the wire field were
validated. What actually happens to `'not-base64!!'` is that it decodes to garbage bytes and is
reported as a **JSON** failure, which misattributes the fault — and a string outside the alphabet
that still decodes to valid JSON is simply **accepted**, so the field has more than one accepted
spelling.

⚠️ **This is the same trap in the opposite direction from earlier this session**, where I nearly
published `account-me.ts:883` as a defect for the same dead catch — and retracted after finding that
`UploadAvatarRequestSchema` validates the base64 with `/^[A-Za-z0-9+/=]+$/` before the route sees it.
There the dead catch sits behind a real validator. Here nothing validates, which is the whole
difference and the reason one is a footnote and the other is this entry.

Corrected: the unreachable catch is removed and the doc says what the function does. Two arms pin the
behaviour — malformed base64 surfaces as the JSON error and specifically **not** as a base64 refusal,
and a respelled-but-decodable payload is accepted.

**Deliberately not fixed: the permissiveness itself.** Tightening this to reject non-canonical base64
— the way the storage envelopes in `lib/` do, with a shape check and a re-encode comparison — changes
what the harness is allowed to put on the wire. That is a control-plane contract shared with the box
side, not a local call. Mutation shows the arms would force that decision to be deliberate: adding a
base64 shape check reds both of them rather than passing quietly.

Mutations: reinstating a base64-specific refusal reds both new arms; making the JSON refusal silent
reds them and the pre-existing non-JSON arm.

Still dark in this module and left for the next batch: `:205`, the `InlineVpnProxyWire` contract
refusal on `inlineProxyConfig`.

## V-1383 — two sibling refusals, one covered and one not

`serializeSessionAssign` splits `inlineProxyConfig` on `type`: `openvpn`/`wireguard` are validated
against `InlineVpnProxyWireSchema`, everything else against `SocksProxyConfigWireSchema`. Both
branches refuse a config that fails their contract. Coverage showed only the socks refusal executing.

The happy paths were not the gap — both VPN shapes are already driven, and their arm pins the FLAT
wire (type plus sibling fields, never nested). What nothing did was hand the serializer a **malformed**
VPN config. That refusal is what stops a half-formed config being base64'd onto a `sessionAssign`
frame; the box side validates too, but a frame that fails there fails _after_ the session has been
assigned, which is a considerably worse place to find out.

The arm drives both members of the union — a WireGuard config missing `private_key`, and an OpenVPN
one missing `config_blob` — and controls on the same fixture WITH the field restored, so the refusal
is the missing key rather than anything else about the input.

Mutations: disabling the VPN contract check reds it, and routing VPN configs down the socks branch
reds it with the _other_ contract's message (`SocksProxyConfig` instead of `InlineVpnProxyWire`),
alongside the pre-existing flat-wire arm. The second is the one that matters — it proves the arm
distinguishes _which_ contract answered, not merely that something refused.

⚠️ **Both mutations silently failed to apply on the first attempt** and the runs that followed
reported 45 passed, which meant nothing. The target strings were indented 6 spaces where I had
guessed 8. The `assert old in s` guard is what turned a fake green into an error; without it this
entry would have claimed two proofs that never ran. Third time this session, and the fix is always
the same: print the exact bytes with `repr()` before writing a mutation.

## V-1384 — the other half of two refusals that answer the same failure differently

`DurableWebhookDelivery.replay()` and `dlq.requeue()` both work by conditional update: match the row
AND its expected status. When that misses, each re-reads the row and refuses in one of two ways —
the id resolved but the status is wrong, or the id resolved to nothing. Coverage had the
**wrong-status** half of both driven and the **not-found** half of neither.

They are not interchangeable to whoever is holding the console. _"has status 'in_flight'"_ means the
right row in the wrong state, so waiting for the lease to expire is the correct move. _"not found"_
means the id itself is wrong and waiting never helps.

One arm covers both methods, asking each for a well-formed uuid that was never inserted — not a
malformed one, because the branch under test is the lookup succeeding and finding nothing. It then
asserts the negative in both directions: neither refusal may carry the other's wording, so the two
cannot be swapped without notice.

Mutations: rewording either not-found message into the wrong-status form reds it, one method at a
time.

⚠️ **Two more mutations that silently did not apply**, on top of the three last turn. Both inline
`python3 -c` targets guessed the indentation — 6 and 8 spaces where the file has 4 and 6 — and the
runs after them reported 9 passed, which meant nothing. The `assert` caught both. The fix that
actually holds: stop matching on text. Mutate **by line index**, read the line back, and assert the
substring is present before rewriting it. That is what produced the two proofs above on the first
attempt.

## V-1385 — the repo-contract invariant whose violation is silent

What remains in the never-executed set, once the `if (!ctx)` narrowing idiom and the
behind-a-zod-schema second layers are set aside, is mostly **repo-contract invariants**: "the
repository returned a combination it cannot return". `api-keys.ts:493`, `sessions.ts:1077/1209/1286`,
`incidents.ts:237` and `audit-archive.ts:448` are all of that shape, and covering them means handing
the service a lying double.

Most are not worth it — the violation is a repo bug and it fails loudly either way. **This one is
different**, and the difference is why it is the one that got an arm.

`revokeApiKeyAtomic` returning a revoked outcome whose row carries no `revokedAt` is impossible from
the real repo. The value it guards feeds
`revoked_at: revokedAt.toISOString()` on the customer-facing `api_key.revoked` webhook — **inside a
`try { … } catch {}` that swallows**, deliberately, so a webhook failure cannot break revoke
correctness. Without the guard, a null would throw exactly there and be eaten. Measured by mutation:
`svc.revoke()` then **resolves `true`**. The key is revoked, the caller is told it worked, and the
customer's integration is never told the key was revoked at all.

That is the failure nobody reports, and the guard converts it into a loud one. The arm hands the
service a repo whose `revokeApiKeyAtomic` returns exactly that impossible row, and asserts both that
the call rejects and that **nothing** was emitted or audited on the way out — so it cannot pass
against an implementation that throws after already firing the webhook.

Recorded rather than pursued: the sibling invariants above. Their violations surface as an exception
on the next line rather than as a silently dropped notification, so an arm for each would pin a
type-narrowing convenience rather than a customer-visible property.

## V-1386 — the production key-invalidation path had never run

Switching instrument from never-executed _throws_ to never-executed _functions_: **211** functions in
`apps/server/src` never ran during the suite. Most are bootstrap wiring and driver adapters. One is
not.

`RedisAuthCache.invalidateKey` — **dark**. Its neighbours are not, which is exactly why nothing
looked thin:

| function                           | status                                   |
| ---------------------------------- | ---------------------------------------- |
| `RedisAuthCache.invalidateAccount` | run — has its own CRITICAL arm           |
| `InMemoryAuthCache.invalidateKey`  | run — the double every service test uses |
| **`RedisAuthCache.invalidateKey`** | **never executed**                       |

That is the path `revoke()` and `rotate()` take in production. It is what makes a revoked key stop
authenticating **now** rather than when its cache entry expires. Every service-level test constructs
`new ApiKeysService(repo, null, …)` — a null cache — so the call site is exercised and the
implementation behind it never was.

Three arms, and the second is the one worth having. The source names its own ordering as
load-bearing: bump the key generation FIRST so an in-flight `set()` that captured the old value lands
an entry the next `get()` reads as stale, and only then drop the rows. So:

1. the generation moves and **both** cache rows are dropped;
2. the generation still moves when the **reverse index has already expired** — that lookup is how the
   entry is found, so skipping the bump on a miss would leave a live cached context authenticating a
   revoked key until TTL, which is precisely the case entry-deletion cannot cover;
3. a Redis outage warns and does not throw, matching the account-level sibling — revocation is
   authoritative in the database and must not be turned into a failed request by a cache problem.

The fake Redis gained `del`, which it had never needed because nothing had ever called this method.

Mutations: making the generation bump conditional on the reverse-index hit reds all three (the
outage arm included — with no `incr` there is nothing left to fail); suppressing only the entry
deletion reds the first alone, so the two properties are pinned separately rather than as one lump.

## V-1387 — a 40-entry redaction list pinned as text, and nothing checking it took effect

`createLogger` is 155 lines and **never executed** — the suite boots through `createTestLogger`, and
every serializer the real factory installs is tested in isolation. This file's own header says it
"proves the exact serializer that createLogger() wires". It proves the serializer. Nothing proved the
wiring.

That gap is narrow and severe. `redact.paths` is a 40-entry list — Authorization, cookies, Stripe and
NOWPayments signatures, the BYOK Anthropic header, the GUI control key, passwords, MFA codes,
recovery codes, OAuth client secrets, the nested VPN credentials — and its own comment says new
sensitive fields MUST be added to it. A cross-source guard freezes that list as **source text**.

**Text is not effect.** Renaming the `redact` key so pino silently ignores the whole block:

|                                                                              | under that one-word change                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------ |
| `logger-v494-redaction-cross-source-invariant` + `lib-logger-content-parity` | **40 tests, all green**                          |
| the new arm                                                                  | fails — `ds_live_LEAK_APIKEY` is in the log line |

The arm drives the real factory in a child process and reads what it actually writes to stdout — a
child rather than an in-process capture because pino writes through sonic-boom to fd 1, which
`process.stdout.write` does not intercept.

⚠️ **The first version proved only half the wiring, and the mutation said so.** Disabling
`serializers` left it green, because every secret it carried was also covered by `redact.paths`. The
one field that separates the two halves is `req.url` — not in the path list, stripped only by
`redactReqSerializer` — so the payload now carries a `?ds_token=` URL. Each mutation fails on its own
leak: killing `redact` surfaces the API key, killing `serializers` surfaces the ds_token.

Absence alone would also be satisfied by a logger that dropped the payload entirely, so the arm pins
that `[redacted]` appears and that an ordinary field survives.

⚠️ **One run in this batch reported `Tests no tests`** — a shell loop split my mutation spec on the
colon inside `redact: {`, wrote `{: {` into the source, and vitest reported no tests rather than a
failure. Exactly the shape the batch rules warn about. Re-run without shell string-splitting, both
mutations land.

## V-1388 — the bounce tracker bootstrap wires, whose SQL had never run

Continuing the never-executed-_function_ sweep. `createDrizzleAccountEmailDeliveryTracker` and all
three of its methods were dark. `bootstrap.ts:728` passes it to `createEmailService`, so this is what
runs in production — and its only other reference anywhere is `lib-bootstrap-content-parity`, which
pins the wiring **line** as source text. The same shape as V-1387: the text is frozen, the effect was
not checked.

The email service's call sites (`findAccountIdByEmail`, `clearDeliveryFailed`, `markDeliveryFailed`)
are all covered — through a **double**. The SQL that reads and writes
`accounts.email_delivery_failed_at` had never executed.

The two ways it can be wrong are not symmetric, so the arms are split accordingly:

- a lost or wrong `WHERE` marks **every** account undeliverable at once, and the dashboard then tells
  every customer their address is bouncing;
- a write that lands nowhere means a genuinely bouncing address is never flagged, so a customer
  locked out of password reset gets no signal at all.

Three arms against real Postgres: the lookup resolves by email and normalises case and surrounding
whitespace (Postmark reports the address as the remote gave it, so an exact-bytes match would fail to
attribute the bounce and silently track nothing); the stamp lands with the time given and clears; and
both writes touch exactly one row — including the mirror case, where **both** accounts are marked and
clearing one must leave the other's bounce standing.

Mutations, each by line index: dropping `.trim().toLowerCase()` reds the lookup arm; dropping the
`WHERE` on either write reds the scoping arm.

`EXPECTED_TEST_FILES` 3008 → 3009, `_ALL` 3172 → 3173.

⚠️ Worth noting for the next drizzle test: `postgres`'s timestamptz comes back in a representation
that is not a `Date`, so `?.toISOString()` on it is a TypeError rather than a comparison. The helper
normalises to an ISO string, which keeps the arm about the column's value rather than the driver's
type mapping.

## V-1389 — a dead alternative lifecycle carrying the defect its live sibling was fixed for

`WebhookDeliveryWorker.run()` and `.stop()` were both in the never-executed set, and nothing in the
repo called them. Bootstrap drives `tickOnce()` through a bounded drain loop instead. So `run()` — the
method whose doc comment reads _"Start the loop"_ — was the obvious entry point for whoever wires
this next, and it had quietly gone stale:

|                       | `tickOnce()` (live)        | `run()` (dead)                         |
| --------------------- | -------------------------- | -------------------------------------- |
| batch delivery        | `Promise.allSettled`       | `Promise.all`                          |
| an escaping rejection | costs that one delivery    | discards **every** outcome in the tick |
| metrics               | `countOutcome` per outcome | **none at all**                        |

The `Promise.all` form is precisely what V-781 replaced, and its comment says why. `run()` kept it,
and counted nothing — so a deployment wired to `run()` would deliver webhooks while both delivery
counters read flat zero, which the neighbouring arm in this file already calls out as
_"indistinguishable from 'no webhooks configured'"_.

`run()` now delegates to `tickOnce()`, so the two cannot drift again, and two arms drive the loop
itself. The mutation makes the old state concrete: restoring the previous body fails the metrics arm
with **`expected [] to deeply equal [Array(2)]`** — both counters empty — and fails the content pin,
which had been freezing the drift rather than catching it. Removing the re-entrancy guard fails the
second arm with `expected 3 to be 2`: a second concurrent loop draining an extra batch, which is
unbounded concurrency against customer endpoints and the same hazard bootstrap guards its interval
against.

⚠️ **Two mutation runs in this batch produced no output and I read them as hangs.** They were neither:
`timeout` is not a macOS binary, so the command never ran and the shell's _command not found_ was
swallowed by the grep. Re-run without it, both mutations red cleanly. This is the same failure family
as the five silent no-ops earlier — an experiment that did not execute, reported as a result — and
the lesson generalises past mutation anchors: **check the command exists before believing its
silence.**

### V-1389 correction — the source fix was reverted before it was committed, and my own check confirmed the wrong thing

The commit above landed the updated pin and the two new arms but **not** the source change. The full
run caught it: both new guards failed against a `run()` that still had the old body.

The cause is a snapshot taken at the wrong moment. I copied `webhook-worker.ts` to the scratchpad at
the START of the batch, edited it, then mutated and restored — and the restore put back the
**pre-edit** file, undoing my own fix. Every `restored byte-identical: True` afterwards compared
against that same stale snapshot and reported success, so the check could not detect the problem it
was there to catch. Snapshot the file you intend to keep, after the edit, not before.

Two of the results reported above were confounded by it and are corrected here:

- the metrics arm failing during the re-entrancy mutation was the **stale body**, not the guard;
- re-run against the correct baseline, removing the re-entrancy guard alone fails exactly one arm —
  `expected 3 to be 2`, the extra batch a second concurrent loop drains — and reverting the
  delegation alone fails the pin plus the metrics arm with `expected [] to deeply equal [Array(2)]`.

The two mutations are now separated, which is what they were meant to show.

## V-1390 — the cached team memberships nothing had ever put a member in

Two `teams.map(...)` callbacks — one in `serialize`, one in `deserialize` — were in the
never-executed set for a single reason: **no cached context in the suite carries a team
membership.** Every arm in the auth-cache file builds an account with `teams: []`, so the array
round-tripped as empty and the mapping either side of Redis never ran.

That array is what `resolveEffectiveAccount` consults to decide whether an `X-Driftstack-Account`
header may act for another account, and `role` is what separates a member from an admin on the team
surfaces. A field lost across the cache round trip is not a cache bug in isolation — it is an
authorisation answer computed from a different context than the database returned, for the whole
30-second TTL.

Two arms:

- every membership field survives `serialize → Redis → deserialize`, **`role` included**;
- a pre-fix entry with no owner identity deserialises to its documented fallbacks — the bare
  `acc_<uuid>` form and a null name — rather than `undefined`. Those two fields are optional in the
  type precisely so an older cache entry still parses, and the route serializers read them directly.

Mutations separate cleanly: dropping `role` from the serialized membership reds both arms; removing
only the `ownerEmail` fallback on deserialize reds the second alone.

### The mutation procedure itself

Three failures last turn — two commands that never ran, and a restore that reverted my own source fix
while the byte-identical check confirmed it against the same stale copy — all came from doing this by
hand each time. It is now a script:

- the snapshot is taken **immediately before mutating**, so a restore can never undo an edit made
  earlier in the batch;
- the target is a **line number plus a substring that must be on that line** — no multi-line
  literals, no indentation guessing, no shell quoting of backticks or `${…}`;
- every step asserts and prints, so `APPLIED` / `RESULT` / `RESTORED byte-identical: True` appear in
  the transcript;
- a run producing no summary line is reported as **"the run did not complete; this is not a result"**
  rather than silence.

Both mutations above went through it and landed first try.

### Checked and not pursued, recorded so the next sweep does not re-open them

`lib/r2.ts` has three dark functions including `listObjects`, which feeds the profile-blob orphan
**sweeper** — a delete path, so worth looking at closely. Every failure mode is fail-safe: the
sweeper filters candidates through `SEALED_KEY_RE` (so a missing `Prefix` would still not widen what
it reaps), skips any object with a null `lastModified`, and requires an age past the grace window.
Broken pagination reaps fewer orphans, never more.

## V-1391 — staff elevation recomputed on every cache hit, in a branch nothing had taken

Switching to the finest signal in the coverage artifact: **branch arms whose sibling ran but which
never ran themselves.** 1415 of them across `apps/server/src`, so filtered to `??`/`||`/ternary
fallbacks in security-relevant modules — the shape that produced V-1390 — leaving 62. This is the one
that mattered.

`services/auth.ts:358`, on the **cache-hit** revalidation path for web sessions:

```ts
const scopes = staffEmails.has(liveAccount.email.toLowerCase())
  ? [...baseScopes, 'driftstack_internal_admin']
  : baseScopes;
```

The grant arm had never been taken — every cache hit in the suite was a non-staff one. A source-text
pin covers the _slow path_'s copy of this line; the cached path had neither.

It recomputes the scope set from the **live** staff list on every hit rather than trusting what the
entry was written with, and that matters in both directions:

- someone **added** to the list gets internal-admin on their next request, not after the TTL;
- someone **removed** loses it on their next request — the case that counts, because an offboarded
  staff account holding a warm cache entry would otherwise keep internal-admin authority for the
  remainder of the TTL, from an entry written while they still had it.

The cached entry's own `scopes` array is what makes this testable: the code ignores it. So the
de-elevation arm writes an entry **carrying** `driftstack_internal_admin`, hands `authenticate` an
empty staff set, and asserts the hit comes back with base scopes only. Replacing the live-list lookup
with the cached array reds both arms.

⚠️ **A third arm exists because the mutation refused to confirm the second property.** Dropping
`.toLowerCase()` from the live email left all arms green: the fixture's address is already lowercase,
so the normalisation was a no-op there and entirely unpinned. With a mixed-case live row —
`A@Example.Test` against a lowercase staff list — it reds. Without that, elevation would depend on
the casing the accounts row happens to hold, so the same person is staff or not according to how they
typed their address at signup.

That is the second time this session a mutation has said "your arm does not test what its title
claims", and both times the fix was a fixture that could tell the difference rather than a reworded
assertion.

## V-1392 — the identity guards on the OAuth sign-in path, one `if` from a shared account

Continuing the never-taken-branch sweep. Every `typeof … === 'string' ? … : ''` fallback in
`lib/oauth-client-exchange.ts` was in the never-taken set: no test had handed those parsers a
userinfo body missing a field, so the guards that read the resulting empty strings had never run.

That would be unremarkable if `providerSub` were a display field. It is not.
`account_oauth_links` carries a **unique index on `(provider, provider_sub)`**, and sign-in resolves
an account by exactly that pair (`findByProviderSub`). A link stored with an **empty** sub is an
identity that any later empty-sub response matches — so a malformed IDP body would not merely fail,
it would resolve to whoever got there first.

Between that and a normal sign-in stands one `if`, at `oauth-client-exchange.ts:294`, which had never
executed:

```ts
if (sub.length === 0 || email.length === 0) {
  return { kind: 'idp-error', status: 200, body: 'missing sub/email' };
}
```

Seven arms across both providers. Google: `sub` missing, `sub` non-string, `email` missing, `email`
non-string. GitHub: `id` missing, `id` an object, `id` null — three ways rather than two, because its
id arrives as a **number** on the happy path and is stringified, so the fallback is reachable both by
absence and by an unaccepted type.

Two of the seven are there to stop the others passing for the wrong reason:

- a well-formed Google body with `email_verified: false` must still reach the verification check and
  return `unverified-email` — otherwise every arm above is satisfied by a parser that refuses _every_
  Google response;
- a **string** GitHub id must be **accepted**, since that ternary arm exists for a provider that
  returns one, and refusing it would lock those customers out.

Mutations separate cleanly: removing the Google guard reds its four arms; removing the GitHub guard
reds its three; collapsing the string arm of the GitHub ternary reds only the acceptance arm.

Checked and not pursued: `services/oauth.ts:293`, which the same filter surfaced, is inside
`InMemoryOAuthStore` — a test-only store with no `new` in `apps/server/src`.

## V-1393 — a fleet-JWT lifetime check that cannot fire, and an arm crediting it for a refusal it never made

Branch coverage put `services/fleet-node-auth.ts:165` — the **absolute-window** lifetime check — in
the never-taken set. Measured directly: replacing `exp - now > MAX + CLOCK_SKEW` with `false` leaves
all **22** fleet-node auth arms green.

That is arithmetic, not a coverage gap. Anything reaching that line has already cleared the two
checks above it:

```
exp - iat <= MAX          (the iat→exp cap, line 154)
iat       <= now + SKEW   (the future-iat allowance, line 164)
⟹ exp - now <= MAX + SKEW
```

which is exactly the threshold it tests with `>`. Its own comment argues for its existence against a
future-dated `iat` carrying `exp = iat + 300` — the case the future-iat check now takes first.

**An existing arm credited it anyway.** The one titled _"exp more than the lifetime cap from NOW, even
with a not-future iat"_ signs `iat: NOW-100, exp: NOW+3600` — a **delta of 3700**, so the iat→exp cap
answers and the absolute check is never consulted. Its inline comment said the absolute window
rejected it. Corrected in place.

The property worth holding is not that the check fires but that no route to it exists, so the new arm
walks both directions out of the extremal accepted token (`iat` at the skew allowance, delta at the
cap, `exp - now` exactly at the threshold).

⚠️ **Only one of those directions is attributable, and finding that out is what fixed the arm.**
Pushing `iat` is refused as `future_iat` — a distinct reason, and widening `CLOCK_SKEW_SECONDS` reds
it. Pushing `exp` is refused as `too_long_lived`, which is the reason **both** lifetime checks return:
disabling the delta cap leaves that half green, because the absolute check answers with the same
string. My first title claimed the arm pinned _which_ check answered. It cannot, and that
indistinguishability is precisely what subsumption looks like from outside — so the title now says
what it shows and stops there.

That is the third time this session a mutation has corrected a claim rather than confirmed one, and
the second where the honest fix was to narrow the assertion rather than strengthen the fixture.

Checked and not pursued from the same sweep: `lib/oauth-pkce.ts`'s `base64UrlDecode` has an untaken
`pad === 0` arm, unreachable because `CHALLENGE_PATTERN` pins the challenge to exactly 43 characters
and `43 % 4 = 3`; and `verifyPlainChallenge` is exported with no caller in `src`, guarded by the
route layer's `z.literal('S256')` as V-1377 recorded.

## V-1394 — the Stripe signature guards that only a malformed header reaches

Re-filtered the never-taken branch arms on **what the line does** — a refusal keyword — rather than on
the filename, which was my own heuristic and had been excluding files. 55 candidates outside
`routes/` and bootstrap; `lib/stripe-signing.ts` carried three of them, all on input a forger
controls:

| line                    | guard                                                       |
| ----------------------- | ----------------------------------------------------------- |
| `parseHeader:98`        | `if (!Number.isFinite(n)) return null` — a non-numeric `t=` |
| `constantTimeHexEq:109` | `if (a.length !== b.length) return false`                   |
| `constantTimeHexEq:111` | `if (!/^[0-9a-f]+$/i.test(…)) return false`                 |

The file's existing arms are thorough about **well-formed** headers — altered hex, wrong secret,
tolerance edges, multiple `v1` during a secret roll, an empty `v1` — and every one supplies a
syntactically valid signature. Nothing had handed the verifier a header it could not parse.

The hex guard states its own reason in the source: `Buffer.from(hex, 'hex')` **silently truncates** at
the first invalid pair. Without it a 64-character non-hex `v1` decodes short, `timingSafeEqual` throws
on the length mismatch, and an unhandled throw on the Stripe webhook route is a **500 where a refusal
belongs**. Fail-closed either way — the difference is whether the money path answers or falls over.

Eight arms, with a control that the same payload's real signature still verifies. Mutations separate
cleanly: dropping `isFinite` reds the two timestamp arms, dropping the hex shape guard reds the two
non-hex arms, dropping the length guard reds the short-`v1` arm.

⚠️ **One arm asserted the wrong reason and the run corrected it.** I grouped `t=` (empty) with the
non-numeric cases, expecting `malformed_header`. `Number('')` is **0**, not `NaN` — so an empty
timestamp parses as the epoch, is finite, never reaches the `isFinite` guard, and is refused by the
**tolerance** check instead. It now has its own arm saying that, because the refusal is real but comes
from a different line than the shape of the input suggests.

### Checked and not pursued

- `canonicalizeEmailForDedup` (`auth-flows.ts:288`): the untaken arm is a `?? ''` on
  `split('+')[0]`, which `String.prototype.split` cannot produce. The canonicalisation itself is
  covered by a dedicated security file, a SQL/runtime parity test, a DB dedup-enforcement test and a
  recovery variant test — including the case that matters most, that a **non-Gmail** domain keeps its
  dots.
- `fleet-upgrade-auth.ts:82/107`: both untaken arms are inside log-field expressions
  (`tokenSource`, `nodeIdSource`). Getting them wrong misleads an operator; it grants nothing. The
  security check beside them — declared node id must equal the signed `iss` — is covered.

## V-1395 — a corrupt MFA challenge payload, and the removal that stops it repeating

`parseMfaChallengePayload` guards the payload the challenge store holds between the password step and
the code step. Branch coverage put **all five** of its type checks in the never-taken set, plus the
shape check above them: nothing had handed `completeMfaChallenge` a stored payload it could not parse.

The consumer's own comment states what the null return is for — corrupt state "can never become a
valid customer retry", removed so malformed Redis data fails closed "instead of a repeatable 500 or a
verifier call with an invalid account identity". Both halves were unexercised:

- the **consume**. Without it the corrupt entry survives its whole TTL and every retry hits the same
  failure — the repeatable case the comment names.
- the **parse**. `payload.account_id` is what the code verifier is called with, so a payload missing
  it would put `undefined` where an account id belongs.

Eleven malformed payloads: not JSON, a JSON array, JSON `null`, a JSON string, missing and empty
`account_id`, missing `email`, a numeric `source_ip`, a string `issued_at`, an `issued_at` of `1e999`
(which parses as `Infinity` — `typeof` alone would accept it), and a numeric `issued_user_agent`.
Each asserts the refusal **and** that the entry was consumed.

The twelfth arm is the one that makes the other eleven mean something: a **well-formed** payload
refused for an IP mismatch must **not** be consumed, so the legitimate customer can retry from the
right address. Without it, every arm above is satisfied by a method that consumes on any failure —
which would quietly destroy a live challenge on a benign refusal.

The store is not reachable from the HTTP fixture, so the service is constructed directly with a
recording challenge store, and the injected verifier **throws** if it is ever reached — a refusal that
came from the wrong place cannot read as the guard working.

Mutations: removing the consume reds eleven arms and leaves the well-formed one green; dropping the
`account_id` guard reds exactly its two; dropping the `issued_at` finiteness guard reds exactly its
two.

`EXPECTED_TEST_FILES` and `_ALL` each +1 for the file added here.

## V-1396 — the strict base64 layer, whose three rejections are not equally reachable

`base64DecodedByteLength` is the strict half of the harness wire: arithmetic-only, so an oversized
payload is refused **without allocating a decoded copy of it**. It has three rejection points, and
they turned out to have three different statuses.

| rejection     | status                          |
| ------------- | ------------------------------- |
| `length % 4`  | had an arm, but see below       |
| alphabet loop | **never ran**                   |
| padding loop  | **unreachable by construction** |

**The alphabet loop is the real gap.** The existing arm passes `'***'` — three characters, so the
length check refuses it and the loop underneath is never entered. Nothing had ever passed a
length-valid string containing a character outside `[A-Za-z0-9+/]`. That matters because of what sits
downstream: `decodeWireData` on the codec side is deliberately permissive (V-1382 — Node drops
characters outside the alphabet and keeps the rest), so **this schema is the layer that refuses a
malformed payload rather than silently delivering a truncated one to the harness**.

**The padding loop cannot reject anything.** `padding` is derived from the trailing-`=` test, so the
region it scans contains only `=` by construction. Brute-forced over all **4096** four-character
strings from an alphabet mixing letters, digits, `+`, `/`, `*` and `=`: zero rejections. Mutation
agrees — deleting it changes nothing.

**And the `% 4` check turned out to be unpinned too, which my own first draft missed.** Removing it
left every arm green, including the `'***'` one: that input is _also_ alphabet-invalid, so the
alphabet loop answers it either way. A length-invalid string built from **legal** characters is what
separates them — and without the guard those return a **fractional** byte count (`'AAA'` → 2.25,
`'Ab'` → 1.5) which is then compared against an integer byte bound. Four such cases now cover it, and
the mutation reds.

The second arm is an **independent oracle** rather than a hand-picked list: canonical base64 written
from RFC 4648 rather than from the implementation, checked against every four-character string over a
mixed alphabet. A list of bad inputs cannot show that nothing else slips through; a sweep against a
separately-derived predicate can, and it is what turns "the padding loop is untested" into "the
padding loop is redundant".

Mutations: dropping the alphabet check reds both arms; dropping the `% 4` check reds the first;
dropping the padding check reds nothing, as predicted before it was run.

### Checked and not pursued

`services/cli-authorize.ts` — its `parseStoredCode` field guards are all exercised; the untaken outer
shape check is defence behind them, the empty-secret guard at `:523` returns the same `expired` the
decrypt catch below it already produces, and the two expiry arms sit in the in-memory store rather
than the Redis one.

## V-1397 — the cursor guard whose sibling arm cannot reach it

`decodeDeliveryCursor` turns a tampered pagination cursor into a graceful first page rather than a 500. It has two refusals a hand-crafted cursor can hit, and only one was reachable from the existing
arms.

The file already carries a careful arm titled _"a date JS accepts but Postgres cannot store"_ —
year zero, the extended `±YYYYYY` forms, year 0001. Every one of those is refused **one line
earlier**, by the shape regex and its 1970 floor: year zero fails the floor, and the extended forms
do not match a four-digit year at all. So the `Number.isNaN(createdAt.getTime())` guard beneath them
had never executed.

It is reachable, because the regex pins the **shape** and not the **calendar**. Measured:

| cursor                                 | matches the regex | `new Date` |
| -------------------------------------- | ----------------- | ---------- |
| `2026-13-01T00:00:00.000Z` (month 13)  | yes               | Invalid    |
| `2026-00-10T00:00:00.000Z` (month 0)   | yes               | Invalid    |
| `2026-01-32T00:00:00.000Z` (day 32)    | yes               | Invalid    |
| `2026-01-15T25:00:00.000Z` (hour 25)   | yes               | Invalid    |
| `2026-01-15T00:61:00.000Z` (minute 61) | yes               | Invalid    |

Without the guard that Invalid Date goes straight into the keyset comparison — the 500 this module's
header says it exists to prevent. Both cursor forms are driven, composite and legacy, with a control
that an in-range cursor of the same shape still decodes.

⭐ **A second arm pins where the boundary actually falls, because it is not where it looks.**
`2026-02-30` is _not_ refused: JS rolls it forward to `2026-03-02` rather than returning Invalid Date,
so it decodes and the NaN guard never sees it. That reads like a gap and is not one — a cursor is a
position, not an identity, and paging resumes two days later at worst. It is pinned so that anyone
tightening it knows they are changing behaviour rather than fixing a bug.

Mutations separate cleanly: dropping the NaN guard reds the new arm and leaves the Postgres-range one
green; dropping the 1970 floor does the reverse. Each guard answers for exactly one class.

### V-1398 — a dispatch-time shape guard I could not prove, recorded rather than shipped

`account-proxies.ts:183` — `if (typeof parsed.config_blob !== 'string') return null` — sits in
`resolveForDispatch`, and a null there is genuinely load-bearing: both call sites treat it as
**refuse to launch**, the route's own comment calling the alternative an egress-identity leak, and the
pre-launch gate turning it into a 422. The branch had never been taken, so it looked worth covering.

Writing the arms found the reason, in stages, and none of it was what I expected:

1. A malformed OpenVPN secret **cannot be written through the system**: `encryptAccountProxySecret`
   runs `validatePlaintext`, which refuses every shape I tried. So the guard defends a row corrupted
   outside the write path — the same justification this file's header already gives for its SSRF
   arms.
2. Forging the envelope with a raw cipher under the correct AAD gets past that, and the arms passed.
3. **But nothing I removed made them fail.** Deleting the shape guard, the `JSON.parse` catch, the
   wire-schema parse at the end of the function, and the decrypt-side shape throw — four mutations,
   all green.

The input is refused by several independent layers, so an arm asserting the outcome cannot attribute
it to any of them, and this one could not be shown to depend on any single guard at all. Under rule 6
that is not a test to ship: it would read as coverage of `:183` while proving nothing about it.
Reverted.

What is true and worth writing down: a corrupt stored OpenVPN secret resolves to null and refuses the
launch, and that outcome is enforced redundantly — at write time, at decrypt time (twice), and by the
wire schema before the config leaves the server. `:183` is the fourth of those, and unreachable while
the others stand.

### V-1399 — the frame gate's structural refusals are redundant; the control run proves the file is not

`services/fleet-inbound-frame-gate.ts` carried the largest untaken-refusal cluster left in the branch
artifact: seven `return null` arms in `readLargeDownloadResultHeader`, the scanner whose whole reason
for existing is to reject an ~85 MiB frame _without_ the Buffer→string→JSON.parse→Zod allocation an
unsolicited frame would otherwise force. Its existing arms cover only string-level damage — an
unterminated string, a raw control byte, a bad escape, nesting past the depth cap — and every one of
them still supplies a well-formed JSON object with quoted keys and a colon. Nothing had ever handed
the scanner a frame that was structurally wrong.

Nine such frames were written: not an object, an array, a bare word, empty, a key with no colon, a
comma where the colon belongs, and a correlation key given a number, an object, and a bare null. All
nine are refused. **None of them is attributable.** Five mutations, each removing one guard on its
own, left all twenty tests green:

| removed                                                                          | line |
| -------------------------------------------------------------------------------- | ---- |
| `if (raw[cursor] !== 0x7b) return null` — must start with `{`                    | 153  |
| `if (raw[cursor] !== 0x3a) return null` — colon after the key                    | 175  |
| `if (raw[valueStart] !== 0x22) return null` — correlation value must be a string | 185  |
| `type !== 'downloadData'` in the final acceptance gate                           | 208  |
| `cursor !== raw.length` — no trailing bytes                                      | 207  |

The function is a recogniser that returns a value on exactly one shape, so every malformed frame
reaches `null` down several paths at once and removing any single one changes no observable output.

The difference from V-1398 is the control, and it is worth stating because it is what stops this from
being a claim about the file's quality: the arms already in the file **are** load-bearing. Removing
the control-byte check reds `a raw control byte inside a SKIPPED string is rejected`; removing the
depth cap reds `nesting past the depth cap is rejected` — one failure each, precisely targeted. The
existing arms name guards that are the sole refuser for their input; the nine I wrote name guards that
are not. So the file is not outcome-pinned by design, and the right conclusion is about my additions
rather than about it. Reverted under rule 6.

What this leaves recorded: the scanner's structural refusals are defence in depth, deliberately so for
a parser reading attacker-controlled bytes off an authenticated-but-compromised node, and branch
coverage of them is reachable but not provable one guard at a time. Anyone tightening this function
should expect coverage to say a line is dark while its behaviour is fully pinned by its neighbours.

### V-1400 — the PKCE length guard is reachable because the two alphabets are not the same one

`lib/oauth-pkce.ts:82` — `if (provided.length !== expected.length) return false` — was in the
never-taken set, and it reads as unreachable: sha256 is 32 bytes, a challenge that cleared
`CHALLENGE_PATTERN` is 43 base64url characters, and 43 characters decode to exactly 32. The only
reference to it anywhere was `lib-oauth-pkce-content-parity`, pinning the line as source text — the
"text pinned, effect unchecked" shape that V-1387 and V-1388 also turned on.

It is reachable, because the challenge pattern is the _verifier's_ alphabet with the length narrowed:

    VERIFIER_PATTERN   ^[A-Za-z0-9\-._~]{43,128}$    RFC 7636 §4.1 unreserved
    CHALLENGE_PATTERN  ^[A-Za-z0-9\-._~]{43}$        the same set, on a base64url value

`.` and `~` are unreserved URL characters and are not in the base64url alphabet. Node's base64 decoder
skips out-of-alphabet characters rather than refusing them, so a 43-character challenge holding one
decodes to **31** bytes (measured; three of them give 30), and `timingSafeEqual` raises
`RangeError: Input buffers must have the same byte length` on a length mismatch.

Nothing upstream narrows it. The authorize route validates the challenge as `z.string().min(43).max(128)`
(`routes/oauth.ts:54`) with no character class, and the exchange calls the helper bare —
`if (!verifyS256Challenge({ ... })) throw new OAuthError('invalid_grant', ...)` at `services/oauth.ts:625`,
no try/catch. So `:82` is the whole distance between a client registering a challenge with a dot in it
and that client's own token exchange answering with an unhandled RangeError instead of `invalid_grant`.
The module header's promise for this function is "Returns false (not throws)"; this line is what keeps it.

Twelve arms, and the mutations separate cleanly:

| mutation                                       | result                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| remove the S256 length guard (`:82`)           | **8 failed** — every malformed-challenge arm, the four controls green    |
| remove the plain-method length guard (`:96`)   | **1 failed** — exactly the plain arm                                     |
| remove the challenge shape gate (`:73`)        | 12 passed — the arms are _past_ it, which is what makes them about `:82` |
| remove the plain-method alphabet check (`:95`) | 12 passed — subsumed                                                     |

The third row is the one that makes the finding attributable rather than merely true: if these inputs
were being refused by the shape gate, removing `:82` could not have reddened them.

The fourth is recorded as a negative. `:95` cannot change an outcome: the verifier is already known to
match `VERIFIER_PATTERN`, so a challenge that fails it either differs in length — and `:96` answers —
or matches in length and differs in bytes, which the compare answers. Defence in depth, not a gap; no
arm written for it.

No source change. Both length guards are correct as they stand, and tightening `CHALLENGE_PATTERN` to
the true base64url set would be a behavioural no-op that makes `:82` genuinely dead — a design call,
not a defect fix. What was missing was the record of why the line is load-bearing, so that is what
this adds.

### V-1401 — three probe guards that were dark because every test injects a dialler

`services/proxy-connectivity-probe.test.ts` is a thorough file: 25 arms across SOCKS5, HTTP
CONNECT, and connect-level failures, standing up a real local TCP server to play the proxy. Every one
of them passes its own `dial`. That is what makes them deterministic, and it is also what left the
production dialler entirely unexecuted — `defaultDial`'s whole body was in the never-executed set.

Its post-connect SSRF re-check is the part that matters. The comment above it says why it exists:

> a customer host that is a DOMAIN resolving to an internal IP slips the literal-host guard, but the
> connected peer address is the real resolved IP — reject it so the probe never reaches Driftstack's
> internal network.

The literal-host guard runs before DNS, so it cannot see where a name resolves; `socket.remoteAddress`
after connect is the only place the real address is visible, and `account_proxies.host` is customer
supplied. Nothing had ever run it. Building the probe with **no** `dial` and pointing it at the local
fake server exercises it: the peer is 127.0.0.1, `classifyUnsafeHost` returns non-null, and the dial
rejects with `unreachable` + "proxy host resolved to internal address". The arm asserts that detail
rather than just the reason, because a generic dial failure also produces `unreachable` — without the
detail the arm would pass on any connection that merely did not work.

Two more were dark for the same injected-dialler reason, both on the reader:

- **The 256 KiB buffer cap** (`SocketReader`, the `errored ??=` path and the `throw` at `:612`). The
  far end chooses how much to send and whether to ever send a delimiter, so `readUntil` has no natural
  end. A proxy that writes 300 KiB with no CRLFCRLF is cut off with `egress_blocked` + "exceeded probe
  buffer cap". The arm asserts the detail: with the cap gone the flood is simply buffered until the
  6 s deadline and the result is `timeout`, which is a green-looking wrong answer.
- **The reason split at `:391`** — `status === 0 ? 'unreachable' : 'egress_blocked'`. `status` is 0
  when no three-digit code could be parsed from the CONNECT reply, i.e. nothing on that port is
  speaking HTTP. The existing arms cover 200, 407 and 502 and so never reach it. A reply of
  `SSH-2.0-OpenSSH_9.6` — the host/port pointed at an SSH daemon — now pins `unreachable`. The
  distinction is customer-facing: `a-reason-an-sdk-branches-on-must-be-documented` exists because the
  SDKs branch on these values.

Each mutation reds exactly one arm and nothing else: defeating the peer-address check (`:158` → `if
(false)`), collapsing the reason split (`:391` → the constant), and removing the cap (`:545` → `if
(false)`). 25 arms → 28; no new file, so no ratchet movement.

The general shape is worth keeping: **a dependency injected for determinism is a dependency nothing
tests.** The default is what production runs, and here the default carried a security guard.

### V-1402 — the SOCKS5 method byte is the proxy's choice, and both refusals of it were dark

Continuing in the same service as V-1401. The greeting advertises NO-AUTH alone when no credentials
are configured (`const methods = hasAuth ? [0x00, 0x02] : [0x00]`), but what comes back is chosen by
the far end. Two of the three answers the code handles had never been received:

**A proxy selecting USERNAME/PASSWORD that was never advertised.** The guard is `if (!hasAuth)`, and
what sits under it is the tell:

    const user = Buffer.from(proxy.username as string, 'utf8');
    const pass = Buffer.from(proxy.password as string, 'utf8');

Two casts. The type system was overridden here, and this guard is the entire reason the override is
sound. Without it `Buffer.from(undefined, 'utf8')` raises `TypeError: The first argument must be of
type string...` (confirmed directly), which the outer catch maps to `egress_blocked` with that Node
message as the customer-facing detail — the wrong reason, and a detail naming an internal type error
rather than the one thing the customer can fix. The arm asserts the detail says the credentials were
not configured, because a bare `auth_failed` is indistinguishable from _wrong_ credentials and points
at the opposite fix.

**A proxy selecting a method that is neither NO-AUTH, USER/PASS, nor 0xff** — GSSAPI (0x01) is the
realistic one. Refused as `unreachable`, naming the method in hex. Falling through instead would send
CONNECT to a proxy still waiting to negotiate, so the probe would spend the whole budget and report
`timeout` — a slower and less actionable answer than the mismatch it can already see.

Mutations red exactly one arm each: `if (!hasAuth)` → `if (false)`, and `} else if (chosen !== 0x00)`
→ `} else if (false)`. 28 arms → 30, no new file.

Both belong to the pattern V-1400 turned on: **a cast is a claim, and the guard above it is the proof.**
`proxy.username as string` and `authResp[1] ?? 0xff` are the same kind of marker — somewhere a value's
type depends on a check, and it is worth asking whether anything has ever taken that check's other arm.

Recorded as a negative from the same pass: `(authResp[1] ?? 0xff)` at `:314` is unreachable, because
`SocketReader.read(n)` loops until the buffer holds n bytes before slicing, so index 1 of a 2-byte read
is always present. Narrowing only; no arm written.

### V-1403 — the same length guard, swept across every constant-time compare in the server

V-1400 found a length guard before a `timingSafeEqual` that had never fired. That is a class, not a
file, so this pass enumerated **all 15 constant-time compare sites** in `apps/server/src` and measured
the branch coverage of each one's length check rather than picking the next plausible file.

Five had never fired. Two were the `oauth-pkce` pair already closed by V-1400. The other three are all
in the OAuth browser flow, and two of them take input chosen directly by whoever drives the browser:

| site                              | operand                                 | guard arm   | now                 |
| --------------------------------- | --------------------------------------- | ----------- | ------------------- |
| `lib/oauth-client-state.ts:105`   | the `state` query parameter's signature | never taken | **covered**         |
| `routes/auth-oauth-client.ts:442` | the PKCE cookie's signature             | never taken | **covered**         |
| `services/oauth.ts:741`           | two client-secret hashes                | never taken | recorded, see below |

Both covered sites fail the same way. The signature is base64url-decoded with `Buffer.from`, which
**shortens rather than rejects** out-of-alphabet or truncated input, so the caller chooses the length
of the decoded buffer; `timingSafeEqual` then raises `RangeError: Input buffers must have the same
byte length` instead of returning false. The length guard is the whole distance between a crafted
input and a raise.

What each raise would break is stated by the code itself. `oauth-client-state`'s doc says the tagged
union exists so the route "can map each failure mode to a distinct response (404 vs 401 vs explicit
retry-prompt) **without the lib leaking the difference via thrown exception types**" — a RangeError out
of `verify` is precisely that leak. On the cookie path every other bad-cookie shape answers 400; the
arms pin that a wrong-length one does too, rather than becoming a 500.

Why the existing arms missed it, in both files, is the same reason: they tamper _content_, not
_length_. `tampered payload` re-signs nothing but keeps the signature, `wrong secret` still yields a
full-width HMAC, and the cookie arm deliberately flips the FIRST signature character (with a long
comment about why not the last). All three arrive at the compare with 32 bytes on each side.

Mutations: removing `:105` reds all five state arms and none of the twelve others; removing `:442`
reds all three cookie arms. **One arm was dropped rather than shipped** — an empty signature after the
final dot does not reach `:442`, because `if (!verifier || !nonce || !sig) return null` at `:434`
answers it first. It passed, and its title claimed the length guard was what refused it, which was
false. Removing `:434` reds nothing now, confirming the subsumption.

Two negatives recorded rather than covered:

- **`services/oauth.ts:741`** fires only when two client-secret hashes differ in width. Both are
  produced by `secretHasher`, which is injectable (`:466`), so within a single deployment they are
  the same width and the guard is reachable only across a hasher change or from a row predating one.
  Same category as V-1398's corrupt-row guard; not covered.
- **`db/oauth-store.ts:247`** holds a third copy of the helper (`constantTimeHashEqual`) and is absent
  from the coverage artifact — but that artifact is the **node-project** run, and this file is
  exercised by nine Postgres-backed `db-oauth-*-drizzle` integration files that the run does not
  include. Absence from this artifact is not evidence of absence of tests, so this copy was not
  assessed here.

Also confirmed dead, as in `oauth-pkce`: the `try/catch` around the base64url decode at `:100-104`.
Replacing the catch body with a `throw` leaves all 17 arms green, because `Buffer.from(s, 'base64')`
does not throw. Left in place; noted so nobody reads it as live error handling.

### V-1404 — the IPN canonicaliser's array branch, and what "falls back to raw" actually means

`lib/nowpayments-signing.ts` canonicalises an IPN body by sorting keys at every level before the
HMAC, because NowPayments signs the sorted form. Two branches of that had never been taken, and the
existing arms explain why each was missed:

- **`sortKeys` recursing into an array (`:95`).** The file already has `canonicalises nested object
keys` — but its fixture nests an object inside an _object_. Nothing had ever put one inside an
  **array**, which is a different branch. If array elements were passed through unsorted, a genuine
  IPN carrying a list would canonicalise differently from what NowPayments signed and be rejected as
  forged — a real payment notification dropped, which fails in the expensive direction.
- **A body that parses as JSON but is not an object (`:87`).** The existing `falls back to raw-body
HMAC when body is non-JSON` arm sends `a=1&b=2&c=3`, which does not parse at all, so it exits at the
  `JSON.parse` catch one branch earlier and never reaches this decision. The fixture here is a
  top-level array — `[{"z":1,"a":2}, 7]` — carrying both unsorted keys and whitespace, so it passes
  only if the verifier signs exactly the bytes that arrived.

Both expected signatures are written out **by hand** rather than produced through this file's local
`sortKeys` mirror. That mirror is a faithful copy of the source's, so signing through it would make
the arm agree with the implementation even where the implementation is wrong — the trap recorded in
`a-faithful-test-double-hides-the-real-artifact`. Hand-writing the canonical string is what makes the
mutations below meaningful.

Each mutation reds exactly one arm: `:95` → `return value` (stop recursing) reds the array arm;
`:87` → `if (false)` reds the fallback arm. 10 arms → 12, no new file.

Recorded as a negative from the same pass: **only the array shape distinguishes `:87`.** A JSON
scalar, string, or `null` body re-serialises to the identical bytes (`42` → `42`, `"hello"` →
`"hello"`, `null` → `null`), so removing the guard changes nothing for them and an arm built on one
would pass either way. They are inside the guard's condition but not observable through it, and no
arm was written for them.

Note the length guard at `:68` in this same file was already exercised (its refusal arm fires), which
is why it did not appear in V-1403's list of never-fired length guards.

### V-1405 — the suite's test COUNT is not a reliable fingerprint; its FILE count is

Chasing what looked like a discrepancy turned into a measurement worth keeping. After V-1403 and
V-1404 the node-project suite reported 29895 tests against a previous 29882 — a delta of 13, while
the three files I touched account for 11.

Attributed rather than assumed, in this order:

1. **Not a peer.** `git log 3f0160369..HEAD` shows only my two commits, and `git diff --stat` over
   that range shows exactly four paths changed — the three test files and the log.
2. **My contribution is exactly +11**, established two independent ways: parsing `it(` declarations
   plus `it.each` rows in both versions (6 + 3 + 2), and reverting all four paths and re-running the
   full suite, which gave **29884** — 29895 − 11.
3. **So the baseline moved.** The same content that measured 29882 measured 29884 on re-run.
4. **Not a runner difference.** The first figure came from `scripts/verify-suite.mjs` and the second
   from a direct `vitest run --project node`, so that was the obvious suspect — but running
   `verify-suite.mjs` again on the reverted tree also gave **29884**. Same runner, same content, two
   different totals.
5. **HEAD is stable across three runs** (29895 twice via `--project node`, once via `verify-suite`),
   so the variance is intermittent rather than a fixed offset.

Ruled out as the source: the 27 test files that build arms by scanning a directory (265 arms, byte
identical with and without my changes), the verification-log guard, and
`dist-reading-suites-have-fresh-artifacts` (a fixed 4 arms, not one per artifact). The `10 skipped`
figure was identical in every run, so this is **arms not materialising**, not arms being skipped.

Not root-caused. What matters for anyone else sweeping here:

- ⛔ **Do not use the test count as a tree fingerprint.** Two runs of identical content can differ by 2. I briefly suspected a peer commit and then a discovery-based guard on the strength of it.
- ✅ **The file count is stable** — 3011 in all five runs — which is the quantity `EXPECTED_TEST_FILES`
  actually ratchets on, so the gate itself is not affected by this.
- To attribute a count delta to your own work, revert your paths and re-run, or parse the arms
  statically. Both are exact; comparing against a remembered total is not.

### V-1406 — an exported decoder whose contract was pinned only as source text

Sweeping the class this time: every `JSON.parse` in `apps/server/src` whose following shape guard has
a never-taken refusal arm. Only two survived, and they split cleanly.

**`services/proxy-connectivity-probe.ts:99` — closed, no arm written.** Its shape guard is dark, but
the `typeof o.ip !== 'string'` check below it already fires (branch counts 3/6), and every input the
shape guard would refuse reaches the same `undefined` through that check or the enclosing catch.
Subsumed; recorded, not covered.

**`services/crypto-orders.ts` — `decodeCursor` had no behavioural test at all.** `encodeCursor` was
imported by the unit file; `decodeCursor` was not, and nothing had ever called it. Both of its refusal
arms were dark. Meanwhile `services-crypto-orders-content-parity` pins the phrase "decodeCursor null
on malformed" as a regex over the source — the same "text pinned, effect unchecked" shape as V-1400
and V-1403.

The token is an admin `?cursor=` parameter, so its bytes are the caller's. `Buffer.from(token,
'base64url')` does not reject bad input, so `JSON.parse` sees whatever decodes.

The two guards divide the input space, which the arms now reflect after a first draft got it wrong:

| removed                       | result                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| the field-type check (`:261`) | **5 failed** — exactly the object/array arms                 |
| the shape check (`:259`)      | 155 passed — **subsumed**, primitives fall through to `:261` |
| **both**                      | **8 failed** — the primitive arms too                        |

My first draft put all seven malformed payloads in one `it.each` titled "without the field-type check
the decoder hands back an object…". Removing that check reddened only five of them: a JSON number or
string exits at the _shape_ check instead. The claim was false for those two, so the block was split —
five arms that name the field-type check and genuinely depend on it, and three that state the outcome
and say plainly that attribution is to the **pair**, since either check alone still answers a
primitive. The third mutation above is what establishes that, and it is the reason the split is not
just cosmetic.

Scope stated honestly: this is **not** a customer-visible bug today. `listForAdminPage` turns a null
cursor into an empty page, and a malformed-but-returned cursor would fail the anchor lookup and
produce the same empty page. What is pinned is the exported function's own contract — that a
`CryptoOrderCursor` it returns really has a numeric `ts` and a string `id`, which is what its type
claims and what nothing was checking.

### V-1407 — the coverage gate documents what it excludes, not what it never included

Two instruments were run this pass. The first produced nothing and is recorded so nobody runs it
again; the second found a real blind spot in the coverage gate.

**Closed with no findings: "exported functions no test names".** 326 exported functions across
`lib/` and `services/`; 12 are never named anywhere under `tests/`. All 12 **execute** — between 1 and
1,240 times each. `loopback-host.ts` is the clearest case: neither `isLoopbackHost` nor
`hostOfConnectionString` appears in a test, and forcing `isLoopbackHost` to return `true` reds five
arms in `seed-target-guard.test.ts`, exactly as `A2-PRODUCTION-READINESS-ASSESSMENT` already recorded.
`parseSessionId` is covered too, refusal arm included (1 of 6 calls). **Naming is a bad proxy for
exercise in a repo that tests through consumers**, and this instrument has a 100% false-positive rate
here. The first version of it was worse — it reported 326 of 326 unreferenced, which is a broken
instrument rather than a finding, and was caught only because a symbol I had written arms for an hour
earlier appeared in the output.

**The finding.** Every coverage sweep this session ran against an artifact spanning `apps/server` and
nothing else — 283 files, no `packages/`. That is not an accident of how I invoked it.
`vitest.config.ts` sets

    include: ['apps/server/src/**/*.ts', 'packages/sdk-typescript/src/**/*.ts'],

and carries a comment enumerating what it EXCLUDES, bullet by bullet with a reason each: the Drizzle
repos, the Astro sites, the GUI client, the generated SDKs. Nothing states what it simply never
included. **Six workspace packages have their own TypeScript source and their own tests and are
measured by nothing** — `api-types`, `behavioural-simulation`, `recapture-automation`,
`recipe-library`, `webhook-delivery`, `webrtc-streaming`. Their tests run and pass inside the gate's
own file count; no part of their source can move the 85/83/84/75 thresholds, so any of them could
regress toward zero with the gate still green.

Measured rather than asserted, over the whole node-project run:

|                                | lines | statements | functions | branches |
| ------------------------------ | ----- | ---------- | --------- | -------- |
| the five excluding `api-types` | 98.25 | 97.14      | 95.97     | 89.51    |
| all six                        | 83.84 | 83.64      | 88.45     | 87.11    |
| thresholds                     | 85    | 83         | 84        | 75       |

So they are **unmeasured, not untested** — five of them would clear the existing bar with room, and
`api-types` alone (25.1% statements) is what drags the combined lines figure under it. Closing this is
two decisions, not one.

The include list was NOT changed. This file's own precedent governs: "changing what CI enforces is
still a decision somebody makes, not one a measurement makes for them." What landed instead is the
remedy this repo already uses for exactly this shape — a derived census in
`a-gate-that-does-not-name-its-blind-spot-reads-as-total`, asserting that every package with source
and tests is either inside the include or named as outside it, with what it measures. Membership only;
the percentages live in a comment because a pinned percentage rots the moment someone writes a test.

Both directions are proven. Adding `packages/webhook-delivery/src/**/*.ts` to the include reds the
anti-rot arm (the entry now overstates the blind spot); renaming an entry so a real package falls off
the list reds both arms. A new package cannot join the unmeasured set quietly, which is the failure
this file exists to prevent: not measured and not run must never look the same from a green.

### V-1408 — the same guard class in the SDK, found only because V-1407 opened the door

V-1403 swept the constant-time-compare class across `apps/server/src` and closed it. That sweep could
not see `packages/`, for the reason V-1407 records: the coverage artifact never spanned them. With the
packages measured for the first time, the same instrument was re-run over them — and the SDK's own
webhook verifier came back with five never-taken refusals. This is the "verify scope repo-wide, not
the named file" rule paying out: a class closed in one tree was still open in another.

`packages/sdk-typescript/src/webhook-signature.ts` is code the **customer** runs, in their runtime, to
decide whether a webhook is genuine. Both failure directions are theirs: rejecting a real delivery, or
accepting a forged one. Three arms added.

**The header may arrive as an array.** `verifySingleHeader` takes `string | string[]` and reads
`rawHeader[0]`; the array branch had never been taken, though a duplicated `driftstack-signature` is
exactly how one reaches a Node handler. Without that branch the value fails the `typeof` check and a
genuine delivery is rejected — an outage with a correct signature on the wire. The second arm pins
that the **first** element wins, because a proxy that duplicates a header repeats the genuine one and
anything appended after it is the part an attacker could influence.

The two mutations separate exactly, which is the point of writing them as two arms:

| mutation                                                | result                                 |
| ------------------------------------------------------- | -------------------------------------- |
| treat `rawHeader` as a plain string                     | **2 failed** — both array arms         |
| read `rawHeader[rawHeader.length - 1]` instead of `[0]` | **1 failed** — only the first-wins arm |

So the second arm pins the security-relevant half rather than merely "arrays are handled".

**A runtime without WebCrypto must fail closed.** `getSubtleCrypto` probes `globalThis.crypto` and
`verifySingleHeader` returns false when it is absent — the SDK ships into browsers and older Node, so
the probe is deliberate. Nothing exercised it. Flipping that `return false` to `return true` reds the
new arm; both the missing-`crypto` and the `crypto`-without-`subtle` shapes are covered, since they
are the same situation and must answer the same way.

Two recorded as unreachable, not covered:

- **`:193`** — `if (ab.length !== bb.length) return false` inside `constantTimeHexEq`. Line 189 already
  refused unequal _string_ lengths, and `hexToBytes` returns exactly half its input, so the two byte
  arrays cannot differ in length by the time control reaches 193.
- **`:170`** — the odd-length-hex refusal in `hexToBytes`. Its only two callers are lines 190 and 191,
  both after 189, and the left operand is always the 64-character `expectedHex`, so an odd length
  cannot arrive.

Both are defence in depth behind a guard that already fires, in the same shape as V-1403's `:95` and
`services/oauth.ts:741`. No arms written for either.

### V-1409 — an arm titled for a path it never reached, and the path itself

Mining the packages artifact further (the tree V-1407 opened) put `sdk-typescript/src/http.ts` at the
top with the largest dark cluster. The interesting part is why it stayed dark: **there was already a
test for it.**

`http.test.ts` carried `it('non-2xx with non-Problem body throws TransportError')`. Its body is
`<html>oops</html>`, which fails `JSON.parse` and exits at the catch **one branch earlier** with a
different message, and its only assertion was `rejects.toBeInstanceOf(TransportError)` — which both
paths satisfy. So the arm named the Problem-shape check, exercised the JSON-parse catch, and could not
tell them apart. Coverage saw through it: `:147` arm 0 read 0 of 17.

Retitled to the path it actually walks, and it now pins the message that distinguishes it. Changing
that message string reds it — which it could not have done before.

**The path nothing reached** is a non-2xx body that PARSES as JSON and is not RFC 7807: `{}` from
nginx, a vendor envelope from a CDN, a bare string from an API gateway. Seven arms, and the
consequence is in the status rather than the message. Without the shape check the body goes straight
to `errorFromProblem`, whose first line reads `p.type`:

- for `null` that raises a **TypeError** out of the customer's `catch`;
- for an object missing the members it builds a `DriftstackError` whose type, title and status are all
  `undefined`, and since `undefined >= 500` is false, **a gateway's 502 is reported to the customer as
  a bad_request**.

Mutations separate cleanly: removing `if (!isProblem(problem))` reds exactly the seven; letting
`isProblem` accept `null` reds exactly the JSON-null arm, so that one genuinely exercises the
`x === null` half of `:443`.

The control earned its place immediately. I first wrote it with `PROBLEM_TYPES.NOT_FOUND`, which does
not exist — the key is `NotFound` — so `type` serialised away and the well-formed Problem was refused
as not-a-Problem. The arm failed on its first run and the fixture was wrong, not the client. Without a
control asserting that a _valid_ Problem still maps to `NotFoundError`, seven green arms would have
been consistent with a client that refuses every non-2xx body alike.

Enumerated with both grep patterns, which is what surfaced the rest:

- `sdk-typescript-http-content-parity` pins this exact block **as source text** — the third
  text-pinned-effect-unchecked instance this session, after V-1400 and V-1403.
- The Go and Python SDKs both carry the same guard, so this is a TypeScript-only coverage gap rather
  than a missing check. Their wording differs — both say "non-problem body" where TypeScript says
  "but body is not a Problem" — and **Go has an empty-body case TypeScript does not**. An arm now
  records what TypeScript actually does with an empty non-2xx body (the JSON-parse catch answers it),
  so that divergence is a measured fact in the suite rather than a reading of the source.

### V-1410 — the half of fc00::/7 that networks actually use, and the allow side of the v6 branch

`packages/webhook-delivery/src/in-memory.ts` is a real implementation, not a double — its own header
says it backs unit tests, GUI-client integration tests, and small self-hosted single-process
workloads. It carries `isLiteralUnsafeWebhookHost`, a belt-and-braces SSRF check run immediately
before every send.

My first reading of it was wrong and the comment corrected me, which is worth recording because it is
the third time this session. The predicate is visibly weaker than `apps/server/src/lib/
webhook-target-guard.ts` — no `BlockList`, no numeric/hex/octal IP encodings, no IPv4-in-IPv6
canonicalisation — and "two copies of a safety predicate that disagree" is exactly the failure
`loopback-host.ts` exists to prevent. But the divergence is **documented and deliberate**: `packages/*`
has no dependency on `apps/server`, this package has no endpoint-registration surface of its own, and
the doc says so in the sentence above the function. Not a defect. No change made.

The real gap is coverage, and it is on the two halves nobody would guess:

- **`fd00::/8`.** The check is written `host.startsWith('fc') || host.startsWith('fd')`, and only the
  `fc` half was exercised. Coverage shows `startsWith('fd')` was never even **evaluated**, because
  `fc00::1` short-circuited the only case present. That is backwards from how the block is used:
  fc00::/8 is reserved and effectively unassigned, while **fd00::/8 carries every locally-assigned
  ULA** — the half a real private network actually uses was the untested one.
- **The unspecified address.** `host === '::'` was evaluated but never once matched.
- **The ALLOW side of the whole IPv6 branch.** Every v6 case in the file is one the guard rejects, so
  `return false` at the end of the v6 arm had never executed. Nothing showed the predicate lets a
  legitimate IPv6 endpoint through — an over-broad v6 rule would refuse every delivery to a customer
  on IPv6, and the existing "passes public IPs through" arm would not have noticed, because its four
  cases are two IPv4 literals, a DNS name, and an unparseable string.

Added to the two existing arms rather than new ones — their titles already cover these shapes, so
nothing needed retitling. Each mutation reds exactly one arm: dropping the `fd` operand, dropping the
`=== '::'` operand, and flipping the v6 fall-through to `return true` (the over-block direction).

Worth carrying forward: **a short-circuit `||` hides its right operand from coverage entirely.** The
line reads as covered and the second half has never run. Same instrument as the compound-condition
note in the dark-throw triage, and it is how the more important half of this one stayed dark.
