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
