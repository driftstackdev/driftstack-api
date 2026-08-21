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
