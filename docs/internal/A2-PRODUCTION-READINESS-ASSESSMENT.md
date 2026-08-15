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

| area                      | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope enforcement         | All **163** scope-enforcing routes refuse a key lacking the scope. Staff surface (65 routes) and customer surface (98) each pin an independent roster, because a table generated from the source it grades cannot see a deletion — verified: removing one gate took the run from 67 passed to 66 passed, all green.                                                                                                                                                          |
| Cross-account ownership   | Sessions 2 guarding tests → 16, profiles 1 → 12, agent sessions **0** → 12, snapshots **0** → 3, proxies (route level) 0 → 4, crypto orders ~1 → 7. Webhooks + api-keys measured at 23 and deliberately left alone.                                                                                                                                                                                                                                                          |
| Credential secrecy        | BYOK Anthropic key, proxy secrets and api-key plaintext are absent from every response including write and error paths, asserted against the secret **value** rather than its public prefix or its field name.                                                                                                                                                                                                                                                               |
| Rate-limit disclosure     | Every dedicated bucket's consumers are named on every page describing it, per page and forward of the mention. Roster derives from the canonical enum.                                                                                                                                                                                                                                                                                                                       |
| PKCE                      | `plain` is refused, proved by sending one and requiring S256 to succeed on the identical request.                                                                                                                                                                                                                                                                                                                                                                            |
| MFA credential management | API keys cannot enroll, disable or regenerate recovery codes — 6 tests hold that gate.                                                                                                                                                                                                                                                                                                                                                                                       |
| SSE resource bound        | The public unauthenticated stream refuses past its per-IP cap with 503 + `Retry-After`, over real sockets.                                                                                                                                                                                                                                                                                                                                                                   |
| AUP refusal               | Evasion-resistant: zero-width splitters and full-width confusables normalise before matching, and the normalize order itself is pinned.                                                                                                                                                                                                                                                                                                                                      |
| SDK consistency           | Three SDKs expose the same 19 resources and the same methods modulo language idiom; two deliberate aliases are allowlisted with reasons.                                                                                                                                                                                                                                                                                                                                     |
| Production dependencies   | `npm audit --omit=dev` is zero at any severity, now gated in CI. All 12 remaining advisories are build/lint tooling.                                                                                                                                                                                                                                                                                                                                                         |
| Billing idempotency       | A retried usage write cannot charge a turn twice — one row id per row, reused across attempts, insert `onConflictDoNothing`. Both halves guarded because they fail independently: a stable id with a plain insert still double-writes, and a conflict-safe insert with a per-attempt id does too.                                                                                                                                                                            |
| Intent replay safety      | `intentReplayMayDuplicateEffect` fails safe: it enumerates the SAFE kinds and treats anything unrecognised as effectful, so a new intent kind is not auto-retried after an ambiguous WebDriver failure until someone says it can be.                                                                                                                                                                                                                                         |
| Retention erasure         | Five arms erase 30 days after termination — BYOK key, wrapped proxy credentials, profiles+snapshots (one arm, two metric labels), agent-turn receipts and agent sessions — with sealed R2 blobs dropped. Safety predicates live in SQL beside the delete target. Each arm's status predicate is proved load-bearing by a case seeding an active account that still carries a `deleted_at`, a state unreachable today but the only protection if reinstatement is ever added. |
| Webhook fairness          | One broken endpoint cannot starve the rest — the claim ranks per endpoint rather than global FIFO. Held on BOTH implementations so the staged cutover cannot reintroduce it.                                                                                                                                                                                                                                                                                                 |
| SDK retry safety          | A create is never auto-retried without an Idempotency-Key, in all three SDKs. Go had no coverage of the gate at all; PATCH was untested everywhere.                                                                                                                                                                                                                                                                                                                          |
| Observability             | Retention purge outcomes are labelled per arm with a `skipped` value, and a scrape-time gauge reports a dead job chain as 0 rather than as an absent series. Every emitted metric is registered at boot.                                                                                                                                                                                                                                                                     |

### 13. CLOSED — repo-layer account boundaries, swept across all 24 repos

Every `eq(table.accountId, …)` predicate in `apps/server/src/db` — **120 across
24 repos** — was neutralised to `eq(t.accountId, t.accountId)` (always true) and
measured. Sixteen repos reacted immediately. **Five repos, holding 17
predicates, did not, and every one was escalated to a FULL 26,592-test run
before being called unproven:**

| repo                   | predicates | what the missing check exposes                          |
| ---------------------- | ---------- | ------------------------------------------------------- |
| `agent-sessions-repo`  | 8          | another account's agent sessions and transcripts        |
| `account-proxies-repo` | 6          | another account's proxies, incl. an irreversible delete |
| `crypto-orders-repo`   | 1          | a customer's crypto payment history                     |
| `oauth-links-repo`     | 1          | linked Google/GitHub identities + provider email        |
| `bundled-llm-repo`     | 1          | the monthly spend total the BUDGET CHECK reads          |

Closed by `83710e2f5` and `849c90ab9`.

_Severity, stated precisely and differently for the two groups._ For
agent-sessions and proxies this was never a live vulnerability: the service and
route layers check ownership first and are well tested — but against a repo
DOUBLE, so those tests never reach the SQL. For the three scoped reads there is
**no service-side filter at all**, so the predicate is the entire boundary; they
were correct in production and simply unverified.

`bundled-llm-repo.sumMonthlySpendCents` is the one worth singling out because
its failure mode is not disclosure. Unscoped, it sums every account's spend, so
one customer gets refused for another's usage — and to that customer it is
indistinguishable from their own budget running out.

_Two things the method taught, both reusable._ **A predicate whose sibling
condition already excludes the fixtures is untested no matter how many cases
surround it** — that shape produced all five findings here plus three retention
arms. And **a conditional predicate hides a break in both directions**:
`listAll`'s `accountId` is optional so an admin view can list everything, which
means an unscoped result looks exactly like the admin call it is supposed to be,
so the guard has to assert the admin path still works too.

_Residual._ `recipes-repo` (6 predicates) and `session-operations-repo` (2) each
red exactly one test. Both are covered, so neither is a finding, but one failing
case across six predicates is thin enough to be worth a look if this area is
revisited.

### 14. CLOSED — expired and revoked OAuth bearer tokens were unproven

Second sweep, same method, different predicate class: the 17 expiry comparisons
in `apps/server/src/db`. Six repos reacted. **`oauth-store.ts` did not.**

`findTokenForAuthentication` is the credential check behind OAuth bearer auth —
`services/auth.ts` calls it on the request path. It resolves a token only while
four conditions hold, and **all four could be neutralised with the full
26,599-test suite green**:

| predicate                             | what its absence allows                  |
| ------------------------------------- | ---------------------------------------- |
| `gt(oauthAccessTokens.expiresAt)`     | an expired access token authenticates    |
| `isNull(oauthAccessTokens.revokedAt)` | a revoked access token authenticates     |
| `gt(apiKeys.expiresAt)`               | an expired API key's token authenticates |
| `isNull(apiKeys.revokedAt)`           | a revoked API key's token authenticates  |

Closed by `f88df9d49`.

_This one has no second line._ The repo ownership predicates closed in item 13
had a well-tested service check in front of them; this query IS the check —
whatever it returns is treated as an authenticated caller. Revocation is what a
customer reaches for after a key leaks, and expiry is what bounds a leak they
never noticed. Two of the four sit inside an `innerJoin`, which is where a
condition is easiest to drop without any caller noticing.

_The method caught a flaw in the guard written to close it._ The token-expiry
mutation initially red only one case instead of two: the caller's-clock case
seeded the API key with the default one-hour expiry, so at NOW+2h the result was
null because the KEY had expired, not the token. **A sibling predicate masking
the one under test — the same trap the sweep keeps finding in source — written
straight into a brand-new guard.** Worth stating plainly: writing this kind of
test does not confer immunity to the mistake it exists to catch. Only the
mutation showed it.

### 16. CLOSED — a suspended or deleted account could activate MFA; plus two clean sweeps

Fourth and fifth predicate sweeps.

**Status predicates (34).** The `eq(accounts.status, 'active')` check inside
`completeEnrollmentIfPending`'s authority lock could be deleted with a clean
typecheck and the full suite green at 2,568 files / 26,613 tests. A suspended
account — an enforcement state, billing lapse or abuse — or a soft-deleted one
could still activate MFA. Closed by `20af122eb`.

The uncomfortable part is where it was: **the same method guarded one commit
earlier.** Item 15's guard closed the five session conditions and never touched
the authority lock's own status check, three lines above them. Guarding a
method is not guarding every predicate in it, and nothing but the mutation said
which was which.

**Single-use predicates (9): CLEAN.** Every `isNull(consumedAt)` /
`isNull(usedAt)` across auth-flow tokens, MFA recovery codes and OAuth pending
links reacts — including both atomic consume-CAS forms that the bulk pattern
missed and that were therefore mutated individually. Replay protection on magic
links, password resets and recovery codes is genuinely covered.

_Sweep scoreboard so far_ — five classes, 205 predicates measured:

| class             | predicates | unproven |
| ----------------- | ---------- | -------- |
| account ownership | 120        | 17       |
| expiry            | 17         | 4        |
| revocation        | 25         | 3        |
| single-use        | 9          | **0**    |
| status            | 34         | 1        |

All 25 closed. The two clean classes are worth as much as the findings: they say
where NOT to spend the next sweep.

### 15. CLOSED — MFA activation authority, and a flake I introduced

Third sweep, revocation predicates (25 across six repos). Five repos reacted;
`mfa-repo` did not.

`completeEnrollmentIfPending` turns a pending TOTP secret into an active
credential, gated on five conditions. **Three proved nothing** — deleting both
`isNull(webSessions.revokedAt)` checks, the `authEpoch` equality and the
`accountId` equality, each with a clean typecheck, left the full suite green at
2,567 files / 26,606 tests. Only expiry red anything. Closed by `043c6533a`.

The revocation one carries the most weight: killing sessions is the first thing
a customer does after a compromise, and an unenforced check there means a
session they believe is dead can still add an authentication factor to their
account.

_Also closed: a flake I introduced two fires ago (`84c2aaee8`)._
`agent_turn_receipts` has two independent foreign keys and nothing requires them
to agree. My receipts test hung its session off the same terminated account, and
`agent_session_id` is ON DELETE CASCADE — so the agent-session purge test
deleted that session and took the receipts with it whenever the two overlapped.
Demonstrated in SQL rather than inferred, because scheduling would not reproduce
it: three paired runs were green before the fix and three after.

_Three method notes, all earned the hard way this session._

1. **Typecheck every mutation.** One earlier mutation used `or`/`isNotNull` that
   were not imported; it could not compile, and its green result meant nothing.
2. **Diff the file before believing a mutation.** A bound mutation reported
   green because shell `${…}` expansion had eaten the pattern and it never
   applied. `!! NOT APPLIED` is a result; silence is not.
3. **Assert the script wrote.** A Python edit asserted its anchor AFTER two
   replacements but BEFORE `write_text`, so a failed anchor silently discarded
   the whole edit and the file was left half-changed in a way that typechecked.

### 17. Route authorization swept CLEAN; and one known limitation, quantified

**Route-layer authorization refusals: 28 across 13 files, ZERO unproven.** Every
`throw new ForbiddenError(...)` in `src/routes` was turned into a no-op
construction (`void new ForbiddenError(...)`, which keeps control flow going)
and every one of them red something. Combined with the existing 163-route scope
roster and the service-layer status gates (10 sites, also swept clean), the
authorization surface is genuinely covered.

_Two apparent findings were scoped-filter false negatives_ — `account-me.ts` and
`auth-cli.ts` showed zero reds under a name-matched subset and both turned out
to be covered by test files whose names did not match the filter
(`account-organization-team-effective-account`, `device-key-deny`). Escalating
every zero-red to a FULL run is what caught it, and it is why the earlier
findings in items 13–16 can be trusted: each was escalated the same way.

**Incident notification fan-out: a KNOWN limitation, now quantified.**
`incident-notifications.ts` already says dispatch is serial and points at the
scheduled-jobs pattern for scale, so this is not a new finding. What the note
does not say, and what is worth recording:

- The recipient list is loaded whole (`listConfirmed`, no `LIMIT`), and each
  subscriber costs a DB read (on `updated`), a DB write (token rotation) and an
  email round-trip — **serially**, so duration grows linearly with subscribers.
- The fan-out is **fire-and-forget and purely in-process** (`void … .catch()`,
  by design per W427 so the admin create is not blocked). **It is therefore lost
  on restart with no resumption and no record of who was reached.** Incidents
  and deploys coincide more often than either does alone, which is precisely
  when a redeploy would silently truncate the notification to an arbitrary
  prefix of the subscriber list.

_Not a defect at current scale_ — zero confirmed subscribers locally, and the
serial design is a deliberate, documented choice. _Recommendation:_ when the
scheduled-jobs migration the source comment already anticipates happens, make
durability the reason for it rather than throughput. Throughput is the visible
problem; silently notifying half the list is the one that matters.

### 18. CORRECTED — key rotation is deliberately fail-closed; what is missing is the runbook

**This item's first version was wrong about the mechanism and unfair to the
design. Corrected here rather than quietly edited, because the wrong version was
published to the bus.**

_What I originally wrote:_ nine unwrapped boot migrations decrypt to validate,
so a malformed or undecryptable row prevents boot — framed as an oversight
generalised from the item-11 flake.

_What is actually true, established by running it rather than reading it:_

- A **legacy plaintext** row converts fine under a new key — no decryption is
  involved, so it does NOT block boot. My stated mechanism was wrong.
- A **v2** row read with a rotated key throws `unable to authenticate data`.
- v2 rows are excluded from the conversion sweep, so that alone would let the
  server boot and then fail per-request at use time — silently, which would be
  worse.
- **It does not, because every one of the nine migrations opens with an explicit
  key-verification probe:** it reads back one existing v2 row with the current
  key and throws if it cannot. All nine. That is a deliberate, consistently
  implemented "can I still read my own secrets?" check.

So the conclusion — rotating a key prevents boot — stands, but it is **intended
behaviour, not a defect**. The system fails loudly at boot instead of quietly at
request time, which is the correct trade for a credential store.

_What remains genuinely open, and it is narrower than the original item claimed:_

1. **No rotation runbook.** The probe tells an operator the key is wrong; nothing
   tells them how to roll one. Recovery needs re-encryption by a process that
   will not start, so the procedure has to exist before it is needed.
2. **The compartmentalisation question is still unanswered.**
   `byok-anthropic-key-storage-design.md:78` weighs reusing `MFA_ENCRYPTION_KEY`
   against a dedicated key — "dedicated wins on key-rotation independence" — and
   ends with "Founder verdict?". One key is wired at 33 points across seven
   customer-facing subsystems, so today rotation is all-or-nothing.

_Recommendation:_ unchanged in substance — decide compartmentalisation, then
write the runbook or add dual-key reads. But the framing matters: this is
finishing a deliberate design, not repairing a broken one.

_Follow-up: are the probes themselves proven?_ Eight of the nine react to being
neutralised — each reds exactly one test. The ninth,
`migrateTranscriptEnvelopes`, does not: disabling its v1 probe leaves the FULL
suite green.

That is **not** a coverage gap, and the distinction took several attempts to
establish. Two independent mechanisms protect the same property — the probe, and
the fact that `prepared` computes every conversion before the first UPDATE (the
source says so: "One bad legacy array/envelope therefore cannot leave a
partially converted page"). Disabling the probe leaves the structure; breaking
the structure leaves the probe. **Disabling BOTH still left the property
holding**, so the redundancy is deeper than two layers.

_I wrote a guard for this and then deleted it._ A byte-identical "a wrong key
rewrote nothing" assertion passed under every mutation I could construct,
including both mechanisms disabled at once. A test that cannot be made to fail
proves nothing, and shipping it would have added the appearance of coverage to
something already covered. That is the same standard applied to everyone else's
guards in this document, and it has to apply to mine.

_Lesson for my own method:_ I generalised from a test-fixture flake to a
production claim without running the production path. The probe was ten lines
above the code I had already read twice. **Reading further beats reasoning
faster**, and a claim about behaviour should be executed before it is published.

### 19. The WIRED path boots, key rotation refuses to boot — both now executed, not argued

Follow-up to item 18's correction. Last time I established the mechanism by
reading; this time the whole thing was run against a real process and a fresh
database. Both encryption keys are locally generatable 32-byte values, so the
wired path needs no external credentials to exercise.

**Wired boot.** With `MFA_ENCRYPTION_KEY` and `PROFILE_MASTER_KEY` set, every
"not set — disabled" warning disappears and the seven gated subsystems come up.
`POST /v1/account/mfa/enroll` returns **401 (registered, unauthenticated)**
rather than 404 (route absent) — the cheapest possible proof that the flag
actually registers routes rather than merely being read.

**Rotation, proven end to end.** Seed a legacy plaintext webhook secret → boot
with key A → the boot migration converts it to v2 and logs "legacy webhook
signing secrets migrated to record-bound v2 before serving" → boot the SAME
database with key B:

```
exit code 1 · 0 "listening" lines · port closed
"msg":"bootstrap failed — exiting"
"message":"Unsupported state or unable to authenticate data"
```

So item 18's corrected conclusion is confirmed in a real process: the
key-verification probe fires, the server refuses to serve, and it fails loudly
rather than serving with unreadable secrets. **This is the system working as
designed.**

**What running it revealed that reading it did not — the diagnostic.** The
operator-visible failure is a raw Node crypto error. Nothing in the message says
"the encryption key does not match the stored data"; the only clue is a stack
frame naming `webhook-secret-encryption.ts`. During a rotation — which is when
this fires, by definition — an operator sees `Unsupported state or unable to
authenticate data` and has to infer the cause from a stack trace.

_Recommendation:_ wrap each probe's read so the thrown error names the subsystem
and the likely cause (key mismatch), never the key itself. It is a diagnostic
change with no behavioural effect: it still fails closed.

_A2 did not implement it this fire, deliberately._ The nine probes have three
different shapes — one read, two reads, or a differently-structured check — so it
is not a uniform one-line edit, and every one of them sits on a fail-closed boot
path in a security-critical file. A careless wrap there could convert a loud
failure into a swallowed one, which is strictly worse than the cryptic message it
would replace. It wants a shared helper and unhurried review, not a late-session
sweep.

### 20. Six parameterised routes may return an undocumented 404 — unverified

Five were found and fixed (`2744199bc`): three customer-facing proxy routes, the
profile-snapshots list, and the admin incident update all throw `NotFoundError`
while the spec documented no 404. That matters because the spec drives codegen —
`packages/sdk-python/openapi.json` encodes each operation's response status set,
so an omitted status is one customers' generated clients never model.

**Six remain unverified and were deliberately left alone:**

| route                                                     |
| --------------------------------------------------------- |
| `POST /v1/admin/validation-schedules/{archetype}/trigger` |
| `DELETE /v1/admin/oauth/clients/{id}`                     |
| `POST /v1/admin/oauth/clients/{id}/rotate-secret`         |
| `PUT /v1/admin/owner/secrets/{name}`                      |
| `PATCH /v1/admin/owner/pricing/{tier}`                    |
| `POST /v1/sessions/{id}/proxy`                            |

Each has a plausible 404 path, and "plausible" is exactly why they are not
fixed. Adding 404 to a route that cannot return it is as wrong as omitting one
that can — it tells an SDK to model a branch that never occurs. The five that
shipped were each confirmed at a specific throw site with a line number.

_Also worth recording: one apparent gap was a correct omission._
`DELETE /v1/profiles/{id}` does `if (!ok) return` — an idempotent 204 that never
404s. A scan by path shape would have "fixed" it wrongly.

_Recommendation:_ verify the six against their handlers, then add a roster guard
requiring every parameterised route to either document 404 or carry an explicit
exemption with a reason. The guard is deliberately NOT added yet: with six routes
undecided it would either fail the suite or encode "unknown" as "fine", and the
second is how a stale allowlist starts lying.

## Assumed, not proven

- **Deploy-time behaviour — PARTLY CLOSED.** Still nothing deployed and nothing
  pushed (item 1). But the boot path itself was finally executed rather than
  assumed, against a FRESH database:
  - **All 110 migrations applied from empty** — the whole chain, not an
    incremental step. `__drizzle_migrations` matched the journal exactly.
  - **The server boots** with every optional integration absent (Sentry, R2,
    Postmark, Stripe, NOWPayments, MFA/PROFILE keys) and says so explicitly per
    subsystem rather than failing or silently degrading.
  - **Contract holds against a live process:** `/health`, `/ready`, `/version`
    200; protected routes 401; unknown route 404; errors are RFC 9457
    `application/problem+json` with `type`/`title`/`status`/`detail`/`instance`.
  - **Graceful shutdown works end to end: 0.13s** from SIGTERM to exit, with
    `shutdown signal received` → `tearing down` → `teardown complete` and no
    fatal — against a 10s drain budget and a 20s stop window. That is the
    concurrent-teardown fix from `2522213df` observed in a real process.

  _What is still unproven:_ behaviour under the production env (real Sentry,
  Postmark, LiveKit, R2 credentials), and anything about the Hetzner units.
  Running with all integrations ABSENT proves the degradation path, not the
  wired one.

- ~~First-run volume of the BYOK arm.~~ **Closed.** All six erasure paths are
  now bounded at 500 rows per tick, and the BYOK candidate query — which had no
  test coverage of any kind, only in-memory doubles — is now exercised against
  real Postgres.
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

### 1. 1,068 commits have never reached CI

`git rev-list --count @{u}..HEAD` = **1,068** (was 1,031, and 1,022 before
that). The count is re-checked each time this item is touched, because the
evidence below decays with every commit that lands after it. Upstream's tip is `6b3a856cd`, dated **2026-07-12** —
nineteen days. Every "gates green" any agent has reported, including all of
mine, is a LOCAL result.

_Doing nothing:_ the divergence grows and the eventual push is a single
high-risk event. _Evidence it would land:_ CI's entire job list re-run locally
at 1,068 commits — build (all five Astro sites + server), SDK build, typecheck
across eight workspaces, lint, format, `npm audit --omit=dev --audit-level=high`
(0 vulnerabilities), `vitest run --coverage` (**2,732 files / 28,200 passing**;
lines 89.74 / statements 88.00 / functions 88.40 / branches 79.17, against
80/80/80/75), Playwright e2e (199 passed), Python SDK (337 passed, mypy clean
over 43 files) and Go SDK (vet clean, tests ok). _Recommendation:_ push — but read item 11 first: there is one
intermittent failure that CI can hit and local runs mostly do not.

Branch coverage sits at 79.24% against a 75% floor. That is 4.24 points of
headroom and it is the metric that drifts down as source is added, so it is
worth watching rather than acting on.

### 12. CLOSED — agent transcripts and turn receipts were retained forever; both are now purged

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

_Closed._ Both arms now exist on the established pattern — bounded per tick,
independently optional, per-arm metric, each with a real-Postgres guard. The
sweeper carries five independently-optional arms emitting six metric labels —
profiles and snapshots share an arm because deleting a profile does not reach
its snapshots, so they must succeed or fail together.

Two things are worth recording from the implementation rather than the finding.

**Neither purge is bound to `MFA_ENCRYPTION_KEY`.** Both repo classes require
that key, because reading or writing these rows means decrypting. A DELETE
decrypts nothing, so both purges are standalone key-free functions. Wiring the
arms to the repos would have made an unrelated flag switch off two more
retention promises — the exact defect `2eeddefa7` had to fix for the first
three, reintroduced by the obvious implementation.

**The cascade rules decide whether this erasure destroys data it has no licence
to touch**, and they differ: `agent_turn_receipts.agent_session_id` is ON DELETE
CASCADE, so receipts go with a purged session; `recipes.agent_session_id` is ON
DELETE SET NULL, so a customer's saved recipes survive with the link cleared.
That was checked against the live schema, not assumed, and both directions are
now guarded. If the recipe rule were ever changed to CASCADE, purging a
terminated account would quietly destroy recipes and no assertion about
`agent_sessions` would notice.

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

### 11. CLOSED STRUCTURALLY — the global-sweep file now has its own database

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

_Update after a dedicated 5-run capture: all five passed._ Post-fix the count is
**1 failure in 8 full-suite runs**, against 3 in 6 before. The data mechanism
was evidently the dominant one.

_But the intermittency is NOT confined to that file, which is the more important
finding._ A later full-suite run went red on three entirely different tests —
`account-byok-anthropic-active`, `stripe-webhooks`, and a customer-dashboard
BYOK page test — all three of which pass in isolation, and the immediately
following full run was green at 2,563 files. So this is not one flaky file with
one bad assertion; it is an ambient failure rate across the suite under
full-parallel load, and item 11's original framing was too narrow.

That reframes the risk for item 1: the question is not "is this one file fixed"
but "what fraction of CI runs go red for reasons unrelated to the change under
test". Observed across this session: roughly 1 in 4 full-suite runs shows at
least one failure that does not reproduce in isolation.

_Two hypotheses tested and BOTH FALSIFIED._ Postgres was sampled throughout two
full-suite runs:

- **Connection exhaustion: no.** Peak was **8 concurrent connections against a
  `max_connections` of 100**. Not close.
- **Lock contention: not observed.** A second run sampled `pg_locks` for
  ungranted locks every 2s and captured **zero** blocked backends. An earlier
  single sample had shown 8 backends waiting simultaneously, which is what
  prompted the check; it did not recur, and the likeliest explanation is the CAS
  test's deliberate `FOR UPDATE` block, which is by design and brief.

Four consecutive green full-suite runs followed, so the failure did not
reproduce this session at all. Sampling cannot characterise a rare event without
catching a failing run, and this approach has now been tried and did not.

_Update — the rate collapsed after a cause was fixed, and the cause was mine._
`84c2aaee8` fixed a real cross-test cascade: the receipts test hung its session
off the same terminated account it was testing, and the agent-session purge test
deleted that session with `ON DELETE CASCADE` taking the receipts with it. Since
that commit, **8+ consecutive full-suite runs have been green**, including a
dedicated 4-run measurement (4/4, no failing logs retained). The pre-fix record
was 3 failures in 6.

That is NOT closure. The two receipts failures are explained; the three
unrelated files seen failing once — `account-byok-anthropic-active`,
`stripe-webhooks`, a dashboard BYOK page — are not, and have simply not
recurred. What changed is the prior: what I called "ambient flakiness across the
suite" was partly a real defect I had introduced, so the remaining unexplained
rate is lower than this item originally claimed and may be zero.

**CLOSED, structurally rather than by fixture discipline.** The file that calls
the global sweep now runs against **its own database**, created and migrated on
demand. No other file's rows can exist in what the sweep sees, so the property
holds BY CONSTRUCTION.

_Proved that way too._ Both historical poisons were seeded into the SHARED
database simultaneously — an unconvertible legacy secret AND a fake v2 row, each
of which previously made this file throw — and it passed three consecutive runs.
That is a stronger result than any number of green runs on a clean database.

_Why the two fixture fixes were not enough, stated once:_ a row is always in
exactly one of two sets — the sweep selects NOT-v2, the probe selects v2 — so no
fixture value is invisible to both. Each fix stopped one mechanism and left the
other reachable. Choosing better values was always one clever fixture away from
the next variant; removing the shared state is not.

Only this file needed it: it is the only integration file that calls the sweep.
The earlier fixture fixes are kept as hygiene, now backed by a guard rather than
load-bearing.

**CORRECTION — that fix regressed it, and I called it closed too early
(`4768e03a5`).** Making the fixtures v2-SHAPED moved them out of the legacy
sweep and into the key probe, where they are not encrypted under anyone's key,
so the probe threw instead. A row is always in exactly one of two sets — the
sweep selects NOT-v2, the probe selects v2 — so "hide it from the sweep" was
never available. Fixtures now use a VALID `whsec_<32 base32>` plaintext, the
only option that throws in neither set.

**Still not closed, and this time said plainly.** Once converted, such a row IS
v2 under whichever key ran, so a later probe under a different key can still
object. No fixture choice substitutes for isolating the real-Postgres
integration files; that remains the structural answer.

_Worth recording: the diagnostic wrapper shipped in `791246263` named this
regression on the first read_ — `Caused by: Unsupported state or unable to
authenticate data at decryptV2Payload` — where the previous incarnation of the
same class cost days of hypotheses. It was written for operators mid-rotation
and paid for itself against my own bug instead.

**ROOT CAUSE, captured at last (`1877f1848`).** A failing run was finally caught
with its assertion text, and it was not a count mismatch and not timing:

```
Error: Webhook signing secret must match whsec_<32 lowercase base32 characters>
  at validatePlaintext -> convertWebhookSecretToV2 -> encryptLegacySecrets
```

`encryptLegacySecrets` sweeps `webhook_endpoints` GLOBALLY for non-v2 secrets and
converts each one. Five real-Postgres test files seeded values that are neither
valid legacy plaintext nor v2-shaped — `'whsec_test_secret'`, `'whsec_test'`,
`'v2:secret'`. When the sweep reached one of those rows it THREW, failing
whichever test had called it.

All five fixtures now carry a syntactically v2 secret, so the sweep excludes
them and never touches another test's rows.

**Three hypotheses were wrong, recorded so they are not re-tried:** connection
exhaustion (measured peak 8 of 100), lock contention (zero blocked backends
across a sampled full run), and timing on the CAS `pg_stat_activity` poll. The
real cause was the same global-scan class as the count mismatch fixed in
`024eb4f6c` — but a different failure mode, which is exactly why fixing the
counts did not close it and why the residual looked like ambient noise.

_What actually worked:_ keeping a full log of a failing run. Every sampling
approach failed for many fires because it measured the system's state rather
than the failure's message.

_Recommendation, revised:_ stop sampling and capture instead. The next step that
would actually settle it is a persistent reporter over repeated runs that
preserves the assertion text of any failure — the three non-webhook failures
were only ever seen as test NAMES, never as messages, which is why the cause is
still open. Establishing CI's own rate remains worthwhile, since its
containerised Postgres has different CPU and connection limits, and that
measurement decides whether this blocks the push or is a developer-machine
artefact.

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

- **CLOSED — "Revoked API keys retained 90 days for audit then deleted."** Nothing
  deleted `api_keys` rows and nothing could: `apiKeys.id` carries **five RESTRICT
  references** (admin_audit_log, incidents, incident_updates, rate_limit_overrides,
  sessions), and sessions are retained seven years under the Dutch tax-law line in
  the same table. Of the two options — reword or change the FK — **reworded**:
  changing the FK would delete audit rows that exist precisely so an audit entry
  can never point at a vanished actor, and would break the statutory seven-year
  line to satisfy a contractual one.

  The row now reads _"90 days after revocation the record is anonymised — the key
  hash and key name are destroyed"_, which is what `retention-scrub-repo` actually
  does and what §9's own closing paragraph authorises (_"deletes the Personal Data
  or anonymises it"_). Corrected in **both published copies** — `docs/legal` and
  the marketing site ship the policy twice.

  ⚠️ **The content-parity pin had frozen the false promise**: it asserted the
  sentence verbatim, so the unhonourable claim was protected by a passing test for
  as long as it stood. Replaced with the corrected text plus a **negative** pin so
  the old wording cannot return.

  Guarded by `a-retention-promise-matches-what-the-sweeper-does`, which pins
  neither side: it extracts the verb from the sweeper's SQL (UPDATE = anonymise,
  DELETE = delete) and the verb from the policy row, and fails on disagreement —
  **bidirectionally**, so implementing real deletion later fails until the policy
  is updated to promise it. Proved by mutation: reverting the policy reds the verb
  and mirror arms; turning the sweeper into a DELETE reds the verb arm; removing
  every RESTRICT reds the premise arm; renaming the row reds anti-vacuity; drifting
  the mirror reds the mirror arm.

- **"Session metadata: 90 days operational."** Coherent, and item 2's archiver is
  the mechanism — it archives rather than deletes, so it does not conflict with
  the seven-year billing line. Resolves itself once the archiver runs. _(This
  corrects an earlier reading of mine that called the line ambiguous.)_

### 4. CORRECTED — webhook delivery is capped near 500/minute, not 25

**This item was wrong on both of its technical claims, and overstated the
severity by roughly 20×.** Re-read from source 2026-08-15:

- **"The batch is delivered serially" — false.** `tickOnce` runs
  `await Promise.all(claimed.map((d) => this.deliver(d)))`. Deliveries within a
  batch are concurrent.
- **"Capped near 25 deliveries/minute" — false.** The poller does not run one
  batch per tick. It calls `drainWebhookDeliveries`, which drives `tickOnce`
  until a claim comes back empty, bounded by `WEBHOOK_DRAIN_MAX_BATCHES = 20`
  and `WEBHOOK_DRAIN_BUDGET_MS = 30_000`.

So the real ceiling per 60s tick is **up to 20 × 25 = 500 deliveries globally**,
and — because `claim` takes at most `perEndpointCap` (5) rows per call — **up to
100/minute for any single endpoint**, whichever the 30-second wall-clock budget
allows first. The drain was added in `dd7f4f95c` precisely because stopping on a
partial batch drained a recovering endpoint at 5 per poll; the fairness fix
`84dc306b1` cited here landed after it. The item was written as though neither
existed.

_Doing nothing:_ far less pressing than recorded. 500/min is not obviously
binding for the current customer base, and the per-endpoint 100/min is the number
that would matter first. _Recommendation:_ **no longer act on this without
measuring** — the case for giving webhook delivery its own interval rested on a
ceiling that is 20× off. If it is revisited, size it against the 30s drain budget
rather than the batch size, since the budget is what actually binds under load.

The three customer-facing numbers on `webhooks/replay.md` are now checked against
these constants by `the-documented-replay-cadence-matches-the-poller`, including
an arm that fails if webhook delivery is ever moved off the shared interval — so
that change cannot silently invalidate the published cadence.

### 5. CORRECTED — an abandoned paid session bills indefinitely, and this was never blocked on A1/A3

The exposure is real and unchanged: billed minutes derive from the `sessions`
table, an `active` row with no `destroyed_at` accrues to `now()`, and
`MAX_SESSION_MINUTES_PER_TIER` caps `free` at 20 minutes while leaving **all seven
paid tiers `null`** — `durationCutoffsFor` skips a null cap outright.

**What was wrong is the premise.** This item claimed "there is **no liveness
signal on driver sessions**" and routed the question to A1/A3. Checked from this
repo 2026-08-15, that is false, and it was A2's to check:

- **Fleet nodes report liveness.** `/v1/fleet/events` (V-820) carries `heartbeat`
  frames with `bootId` and `activeSessionStates`, gated on
  `config.fleetControlPlaneEnabled` — which bootstrap does wire.
- **The control plane already consumes it.** A `bootId` change closes the sessions
  a restarted node cannot still be running (`node-boot-reconcile`), worker-reported
  orphans are reconciled (`cp-daemon-reconcile`), and there is an orphan sweeper
  with its own reap job and terminal reasons (`node_shutting_down`,
  `reaped_during_provisioning`).

**All of that is wired to `agent_sessions`, not to `sessions`.** The table that
bills has no equivalent — and no node column to hang one on, so the bootId reaper
cannot simply be pointed at it. `sessions.last_state_at` IS maintained
(monotonic `GREATEST`) and exposed on the API, but **nothing reads it as a
staleness anchor**; it is the obvious hook for a sweep that needs no node
attribution and no new column.

So this is an **engineering task in A2's own scope**, not a cross-agent question —
and a cheap one. `durationCutoffsFor` iterates the whole tier enum and its own
comment notes that "a future capped paid tier is picked up automatically with no
sweep change". **Capping a paid tier is one value in one table.**

_Doing nothing:_ unchanged — a silently-dead driver keeps billing.
_Recommendation:_ the only genuinely open question is the **number** — how long a
paid session runs before it counts as abandoned, or how stale `last_state_at` may
get. That is a product call with real customer consequences (a long-running
session is a legitimate use of the product), so A2 has not invented one. Everything
else is ready.

Held by `an-unbounded-paid-session-is-a-visible-choice`, which asserts the cap
table from SOURCE, that exactly one tier is capped, that the sweeper never targets
an uncapped tier (behaviourally), and that `sessions` still has no node column —
that last arm expiring the moment one is added, because the reaper becomes
extensible at that point.

⚠️ **Found while proving it:** three mutations of the cap table failed to red
anything, because `@driftstack/api-types` resolves to `dist` and a local
`npm test` does not rebuild it. **CI is safe** (`npm run build` precedes the test
job) but the **local loop is not** — a developer can change a cap in `src`, run the
suite, and see green against a build artifact from days earlier. The guard now
reads source and asserts the built copy agrees.

### 5b. NEW — 192 test files validate a build artifact, not source (local only)

`@driftstack/api-types` declares `main: dist/index.js` and has no vitest alias, so
every import resolves to the **built** copy. **192 test files import it** (plus 9
importing `@driftstack/sdk`). A local `npm test` does **not** rebuild, so those
files assert against whatever `dist/` happens to contain — i.e. against the last
build, whenever that was.

⚠️ **Correction (2026-08-15).** This item first said the artifact was "a build
dated Jul 14 against source modified since". **That was wrong** — Jul 14 was the
`dist/` DIRECTORY mtime, which does not track in-place file rewrites. File-level
mtimes were 2026-08-13, i.e. **newer** than the last `src` commit (`885caddfc`,
08-11), and a fresh `npm run build` wrote nothing. The artifact was current; the
staleness window is "since your last build", not weeks.

The mechanism is unaffected, and is now proved directly rather than by mtime:
edit `MAX_SESSION_MINUTES_PER_TIER` in `src`, run the suite **without** rebuilding
— the behavioural arm that reads the built package does **not** red. Rebuild, and
it does. So a source edit is invisible to any behavioural assertion until the
package is rebuilt.

**CI is not affected**: `.github/workflows/ci.yml` runs `npm run build` before the
test job, so CI always tests a fresh artifact. **The local loop is the hazard** — a
developer changes a constant in `packages/api-types/src`, runs the suite, sees
green, and the change was never exercised.

_How it was found:_ three mutations of `MAX_SESSION_MINUTES_PER_TIER` failed to
red anything while proving item 5's guard. A mutation that changes nothing looks
exactly like a guard that is too weak.

_Doing nothing:_ CI still catches it, one push later, with a failure that does not
point at the cause. _Recommendation:_ pick one — a vitest alias mapping
`@driftstack/*` to `src`, or a `pretest` build step. **A2 did not choose**: the
alias changes what 192 files actually test (source rather than the artifact CI
builds), and the build step slows every local run. Either is a workflow decision
rather than a defect fix. A targeted mitigation is in place for the one table that
mattered here — `an-unbounded-paid-session-is-a-visible-choice` reads the cap
table from source and asserts the built copy agrees.

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

### 10. CLOSED — Prettier is pinned exactly

A caret range on a formatter. The lockfile pins 3.8.3 and the installed copy only
caught up on 2026-07-31, at which point the format gate went red on 24 files
formatted under an older version — while `.husky/pre-push` runs `format:check`,
so the next push would have failed. Fixed in `940cd90d7`.

**Now pinned exactly** (`"prettier": "3.8.3"`); the lockfile declaration follows,
and no other dependency moved — the sync is a one-line diff. The blocker recorded
here was timing, not objection: the last dependency commit was 2026-08-08 and
nothing has touched `package.json` since except A2's own heap fix, so the
concurrent-writer hazard had passed.

Guarded by `the-formatter-cannot-change-under-us`, which derives the formatter
from the `format*` scripts rather than naming Prettier, and asserts three things:
it is pinned exactly, the pin agrees with the lockfile, and `format` and
`format:check` resolve to the same binary. The reason it needs a guard rather
than just this commit is that `^` is the default — `npm install --save-dev`
writes a caret and nothing warns, so the property decays back without an
assertion holding it. Proved by mutation: a caret reds the pin and lockfile arms,
a mismatched exact version reds the lockfile arm, a divergent check binary reds
the last arm, and de-referencing both scripts reds the anti-vacuity arm.

`npm run format:check` green with the pin in place.

### 21. Item 20 closed — every parameterised route decided

All six undecided routes were resolved at their handlers rather than inferred
from their paths. Two were real gaps and now document 404:
`DELETE /v1/admin/oauth/clients/{id}` and `POST /v1/sessions/{id}/proxy`. Four
were correct omissions: rotate-secret answers **401** because the service throws
`OAuthError('invalid_client')` and `oauthErrorToHttp` maps it there; owner
secrets is an upsert; pricing validates the tier as an enum so unknown is 400;
the validation-harness trigger never looks the archetype up. With every route
decided, the roster guard held back in item 20 is in — document 404 or carry an
exemption naming the behaviour that makes it unreachable, and the exemption list
may only shrink.

Worth noting as an API inconsistency rather than a defect: `DELETE` on an OAuth
client 404s while `rotate-secret` on the same resource 401s. Both are defensible
alone; together they are surprising. Not changed, because changing either is a
customer-visible status change and that is a product decision.

### 22. Five route-security guards had a root narrower than their claim

Auth coverage, admin authorization, the effective-account header, mutation
rate-limiting and the free-desktop policy all scan `src/routes`. `src/lib/app.ts`
registers five more routes.

Measured, not argued. Stripping `requireAuth` from `/v1/whoami` reds **exactly
one** test — the content-parity pin that quotes that line — and none of the five
notice. Adding a new unauthenticated route there reds three, but all three check
**documentation** coverage, so documenting the route and giving it a consumer
silences them with no auth check ever having run.

Latent, not live: all five routes there are correct. Closed by making the shared
assumption checked rather than teaching five parsers a sixth file shape.

### 23. `errors-site` sat outside both public-surface sweeps

The V-211 personal-name and V-205 attribution sweeps each listed five app
directories inline while describing their scope as "public-visible apps".
errors-site is the sixth, deploys to `errors.driftstack.dev`, and every RFC-9457
problem+json the API emits carries a `type` URI pointing at it — developers land
there from any error response. It was clean; the sweeps were not reporting it
clean, they were not looking.

The roster now derives from the `deploy-frontend.sh` case statement. The part
worth carrying: widening the directory alone would have scanned **zero** new
files, because the extension list omitted `.mjs` and errors-site generates every
page from one dependency-free `build.mjs`. A widening that reports success while
matching nothing also retires the suspicion, which is worse than the gap it
replaced. Both widenings were confirmed load-bearing by planting a violation in
`build.mjs` and removing each in turn.

### 24. The privacy policy's status-page storage claim was unverified

`legal/privacy.md` §3.9 states the status page sets no analytics cookies and
declares "Cookies: none" for it; §3.8 names Article 5(3) of the ePrivacy
Directive as why no consent mechanism is required. Nothing checked the status
page — the tracker guard scans marketing-site only, correctly, since the footer's
"No trackers on this site" is scoped to that site.

True today and verified before pinning: no cookie, no client storage, no
off-domain origin. A cookie added there would not merely make a page disagree
with a document; it would remove the ground the disclosure stands on. The guard
also pins the claim side, because checking only code keeps passing if the
document is rewritten to promise more than the code delivers.

### 25. Two instruments were built, found invalid, and discarded before publishing

A1's diagnostic — _a source-text pin asserts an expression verbatim and exercises
no behaviour_ — was run over this suite. The first instrument matched test names
against behaviour verbs and returned **2121 cases across 1431 files**. Nearly all
were `*-content-parity.test.ts`, which are self-declared text pins whose names
say so. A sharpened version excluding them returned **143**, nearly all
`*-cross-source-invariant`, a deliberate repo pattern for pinning that two
sources agree on a constant.

Both measured naming, not the defect. Publishing either would have cost whoever
chased it far more than checking cost. Recorded because the instinct to ship the
first list is strong and the list looks like work.

The valid instrument asks a behavioural question: which exported symbols does no
test ever CALL? 394 exports, 87 never imported by a test, 11 security-relevant
and mentioned only as text, of which 5 are route registrars reached through
`buildApp`. Six real candidates, each then measured by mutation rather than
judged by reading.

**Four were already covered** and were verified out, not asserted out:
`extractBearerToken` (127 reds), `isIndependentDeviceKeyDeniedRoute` (25),
`consumeEffectiveOwnerRateLimit` (6), and `verifyTotpCodeWithCounter`, which is
exercised through the `verifyTotpCode` wrapper that has real assertions.

### 26. `validateGuiControlKey` — four fail-closed branches nothing could see

Reachable only transitively, through eight integration files that send the header
at a route. Whether that covered its branches was measured against the 584-test
control-key integration set:

| mutation                                                      | result       |
| ------------------------------------------------------------- | ------------ |
| accept any presented key (drop the constant-time compare)     | 3 RED        |
| drop the expiry condition entirely                            | 2 RED        |
| undecryptable ciphertext rethrows as 500 instead of 401       | 1 RED        |
| **no encryption key configured falls through instead of 401** | **584 PASS** |
| **expiry comparison becomes exclusive (boundary off-by-one)** | **584 PASS** |
| **unknown session gets its own message**                      | **584 PASS** |
| **repeated header takes the last value**                      | **584 PASS** |

The first uncovered branch is the deployment-level switch: with
`MFA_ENCRYPTION_KEY` absent, a presented key must be a hard 401 rather than a
silent fallthrough to account auth. The third is an enumeration oracle —
distinguishing "no such session" from "wrong key" confirms a session id exists
for another account. The fourth would let a proxy-injected trailing header
override the real credential.

Nothing was wrong in the source. What was missing was any test that would notice
if a branch stopped. Eleven cases now drive the real function, including a
positive control, because a suite of negative assertions passes against a
function that throws unconditionally.

### 27. The profile-session advisory lock key had no behavioural coverage

Both customer session-create surfaces serialize on
`profileSessionAdvisoryLockKey` before binding a persistent profile. The module
exists because the legacy and agent repos drifted into independent locks once
already. Content-parity regexes pin that both repos CALL the shared helper —
which is a connection code cannot express, so they stay — but nothing checked
what it returns.

Measured against 85 files / 1019 tests: a constant key passes 1019, and a
per-call-unique key passes 1019 with a clean typecheck. The second makes
`pg_advisory_xact_lock` take a fresh uncontended lock every call, so two
concurrent creates against one profile both proceed — exactly the race the lock
closes.

Determinism and injectivity are separate properties and are covered separately;
a single "contains the id" assertion satisfies neither.

### 28. Two parity guards degraded to a skip when their directory moved

The Python-to-server and Go-to-server path-parity guards each opened with
`it.skip('… SDK not present')`. Neither SDK is optional — 21 and 64 git-tracked
files in workspace packages, and the repo has no submodules — so that branch
could only fire when a directory was renamed, moved, or deleted, which is
precisely when the guard mattered.

Measured: pointing the path at a non-existent directory left the run green at
"1 passed | 1 skipped". The parity assertion's own vacuity guard was already
correct and failed on a zero-literal scan, so only the presence path was silent.
A missing directory is now a failing case.

### 29. Eight tests had been skipped unconditionally, with no explanation

Four in the customer-dashboard webhooks page parity file, four in marketing
trust/security-overview. Every full run reported "22 passed | 8 skipped".

Un-skipping resolved it: **3 passed immediately** — idle coverage — and **5
failed because the page copy had been rewritten into plain customer language with
the internal V-numbers stripped**, and the pins were skipped rather than updated.

Four of those five properties were still true on the page and their pins are
re-anchored on the claim rather than the sentence: the MFA step-up gate on
destructive admin paths; the per-provider inbound webhook algorithms plus the
shared raw-body guarantee; the four drilled chaos failure modes plus
dry-run-by-default; and the signing-secret shown-ONCE posture, which now also
pins the DOM wipe that makes it true rather than only the sentence claiming it.

The fifth was genuinely obsolete and is the one worth remembering. It pinned
"Delivery counts coming soon" and the claim that `/v1/webhooks` carries no
aggregate `delivery_counts`. V-185 shipped the counts and the cards render them,
so un-skipping it would have re-pinned a claim the product had outgrown. **A
skipped test is not a paused test — it is a decision to stop checking something,
recorded nowhere, that decays into a false claim about the product.**

A guard now forbids unconditional `it.skip` / `describe.skip` / `test.skip`
anywhere under `apps/` or `packages/`, with a deliberately empty exemption map.
Conditional skips are untouched; `describe.skipIf` on a missing `DATABASE_URL` is
a real re-evaluated condition and ~63 of those remain.

The first version of this sweep was scoped to `apps/server/tests` and found
**zero** — all eight offenders were in other apps. Narrowing the guard's root
back to that is one of the four mutations proving it.

### 30. The e2e harness would DROP SCHEMA on whatever `DATABASE_URL` pointed at

The highest-severity finding of this run. `startTestServer` executed, before any
test body ran:

```
DROP SCHEMA IF EXISTS "drizzle" CASCADE
DROP SCHEMA IF EXISTS "public"  CASCADE
CREATE SCHEMA "public"
```

and `resetState()` then TRUNCATEd `accounts`, `api_keys`, `profiles`, `sessions`
and eleven more tables RESTART IDENTITY CASCADE, followed by `redis.flushdb()`.

**Which database that hit came from `process.env.DATABASE_URL` with no check of
any kind**, defaulting to the shared local dev database. Not a TRUNCATE — a DROP
SCHEMA CASCADE, every table, before a single assertion.

The accident is specific and easy: a shell exporting a remote `DATABASE_URL` from
a profile, an `.env`, or a pasted command, and someone runs the e2e suite. The
convention that protected it — each agent pointing at a disposable scratch
database — was a convention, not an enforcement.

Loopback-or-nothing costs nothing, which is why it is a refusal rather than a
warning: CI sets localhost for both URLs, docker-compose publishes both on
localhost, every scratch database is localhost, and managed Postgres/Redis are
never on loopback. The rule cannot fire on a legitimate run and cannot fail to
fire on the accident.

Redis is checked independently because `flushdb` is destructive alone. An
unparseable URL is refused rather than assumed harmless — a guard that cannot
identify its target must not conclude the target is safe, or malformed input
becomes the bypass. `DRIFTSTACK_E2E_ALLOW_NONLOCAL_RESET=1` covers a genuine
compose-network topology; `NODE_ENV=production` is refused even with it set.

Verified end to end rather than only in unit tests: a real spec against a local
scratch database still passes 4/4, and a remote `DATABASE_URL` through the real
harness fails fast inside `startTestServer`, naming the offending variable and
host, before any connection opens.

One of the six mutations is worth keeping: moving the call to _after_ the
connection is opened reds the wiring case while all nine behavioural cases stay
green either way. Behaviour cannot see ordering, so the pair is orthogonal.

### 31. `db:seed` would mint a full-admin key into any database it was given

`seed.ts` creates an account and an API key scoped `['read', 'write', 'admin']`
and prints the plaintext so a developer can paste it into a curl command. Correct
locally. Anywhere else it is a credential-issuing incident: a working full-admin
key exists in that environment and its plaintext is in a shell scrollback or a CI
log — and the script's output never names the database it landed in, so the
mistake does not announce itself.

The target came from `config.databaseUrl` with no check. The accident needs no
unusual state: a staging or production `DATABASE_URL` exported, and
`npm run db:seed`.

Same rule as the e2e guard, with the host classification shared in
`lib/loopback-host.ts` so the two cannot drift. The **policy** is deliberately not
shared — each owns its message and its own override name, because otherwise
someone who set the e2e override to run tests against a compose network would
silently also authorise seeding an admin key into a remote database. A case pins
that separation, and a mutation that collapses the two names reds it.

Verified end to end in both directions: a remote URL through the real npm script
fails fast naming the host, and migrate-plus-seed against a scratch database
(created and dropped for the check) still works.

### 32. The destructive-target class is now closed, and most of it was already safe

Having found two instances, the whole repo was swept for operations that destroy
or issue credentials against whatever `DATABASE_URL` names. The result is mostly
a list of things that were already correct, which is worth recording so the sweep
is not repeated:

- **Integration tests** — verified safe by construction, not assumed. They run on
  isolated databases via `ensureIsolatedDatabase` _and_ create uniquely-named
  schemas, and the clients that issue unqualified `TRUNCATE` set
  `search_path=<TEST_SCHEMA>` with an assertion confirming it took effect.
- **`scripts/`** — four scripts read `DATABASE_URL`; none is destructive.
- **`db:migrate`** — additive, and running it against production is a normal
  deploy step, so a locality guard would be wrong.
- **Retention purges and the account-deletion sweeper** — destructive by design in
  production, gated on account status rather than on host; covered separately.

Only the two fixed above lacked a guard.

### 33. A fire of verified negatives — five areas probed, nothing broken

Recorded because "we checked and it holds" is worth as much as a fix, and because
the next person should not repeat any of it.

**Error responses do not leak internals.** `normaliseError` wraps anything
unexpected as `InternalError('An unexpected error occurred.', err)`, and `cause`
goes to the native `Error` cause while `toProblem()` spreads only `extensions` —
so a Postgres error's table, column and SQL never reach the customer. Mutating
`toProblem()` to spread the cause reds 3 tests, including a dedicated behavioural
end-to-end file. Guarded.

**`AUTH_EXPOSE_DEBUG_TOKEN` cannot be on in production.** Read with an exact
`=== 'true'` (the comment explains that coercion would invert it: `'false'` is
truthy) and production refuses to boot if set. Guarded.

**All six production boot refusals are behaviourally covered** — debug token,
localhost auth URLs, missing `DASHBOARD_ORIGIN`, the decomposer fallback bypass,
the Stripe live-key cutover, and the task-refusal pattern misconfiguration.

That last one first measured as UNCOVERED and it was **my mutation that was
wrong**: I changed the message text rather than the behaviour, so it measured
whether a message pin exists, not whether the refusal fires. Re-run as `if
(false)`, it reds 6. **A message-only mutation does not measure coverage** — it
measures whether someone pinned the string.

### 34. The route-coverage instrument does not work here — seven flaws, no finding

I tried to answer "which registered routes does no test ever request". The first
run reported 53 of 250. Every candidate I hand-checked was covered, through seven
distinct defects in the instrument:

1. `acc_${id}` normalised to `acc_:p`, never matching a registered `/:id`.
2. Literal placeholders (`agt_xxx`, `ord_x`) are not `${}` and were not
   parameterised at all.
3. e2e builds `${server.baseUrl}/v1/...`, so paths did not start at `/v1`.
4. The scan root was `tests/integration` + `tests/e2e`; plenty of request-level
   tests use `app.inject` from `tests/unit` — `GET /v1/archetypes` is tested
   exactly there. **My own scan-root defect, the one I have been finding in others
   all day.**
5. Request detection missed `request.get(...)` and template-literal forms.
6. `admin-scope-refusal-coverage.test.ts` GENERATES requests via `it.each` over
   routes derived from source, so no literal path string exists to match. That
   single suite covers the whole admin surface.
7. `cross-account-session-isolation.test.ts` builds
   `` `/v1/sessions/${id}${suffix}` `` from a table, so nine session action routes
   have no literal path either.

Successive fixes took 53 → 45 → 13 → 6 → 1 → 0.

**The near-miss is the part worth keeping.** At "1" I concluded that
`POST /v1/sessions/:id/extract` had no request-level coverage, having mutated its
id decoding and watched 18,981 unit tests and 1,163 "sessions"-filtered tests
pass. Both runs were wrong: the unit project excludes integration, and the filter
`sessions` never matches `cross-account-session-isolation`. Run against the suite
that actually drives the route, the same mutation reds immediately. **A green
result from a run that could not have covered the code is not evidence** — the
filter has to be shown to include the covering suite.

No route-coverage finding exists. The instrument is not sound for this repo and
should not be rebuilt from scratch by the next person.

### 35. The cross-SDK bug was the ONLY instance of its class

Having found that `revokeAllOtherWebSessions` omitted the `?keep=current` the
endpoint requires, the obvious question is how many more like it exist. Swept
three ways; the answer is none.

**Required query parameters.** Exactly one query field in `api-types` is required
(no `.optional()`, no `.default()`): `ClearQuotaOverrideQuerySchema.bucket_key`.
It belongs to an admin route with no SDK surface at all.

**Inline query requirements.** The first sweep only looked at `*QuerySchema`
definitions — and would have missed the original bug, which was an inline
`request.query?.keep` check with no schema behind it. Redone for that shape:
**exactly one** such requirement exists in the entire route surface, and it is
the one already fixed.

**Required bodies.** Four SDK write-methods send an empty or absent body
(`testByokAnthropicKey`, `createPortalSession`, MFA `enroll` and
`regenerateRecoveryCodes`). None of those four routes reads `request.body`.

**Method-and-path agreement, all three SDKs.** 124 TypeScript, 206 Python and 125
Go method+path pairs, every one matching a registered server route with that
exact verb. The Go measurement first reported 35 mismatches; that was my parser
failing to rebuild `"/v1/agent-sessions/" + url.PathEscape(id) + "/message"` in
order, not a finding.

**And the reverse direction is guarded.** Changing a SERVER route's verb —
`/v1/account/mfa/enroll` from POST to PUT, which would 404 every SDK call — reds
`openapi-route-coverage` and the route's own cross-source invariant.

So the gap that produced the bug was genuinely narrow: an **absent** query
parameter is invisible to a source-text pin, which can only see what the source
says, not what it fails to say. Nothing else in the wire surface has that shape.

### 36. Go BYOK credential handling now driven

Fourteen of `AccountResource`'s fifteen methods had no test reference. The four
carrying the customer's own Anthropic key now assert credential-handling
properties rather than plumbing: the key must travel in the request **body**,
because a credential in a path or query string ends up in access logs, proxy logs
and browser history — the request succeeding is not enough, it has to succeed the
right way. The read path is fed a response containing an `api_key` the server
would never send, and the value handed back is re-encoded and checked for it, so
a struct that later grows a field able to hold the key fails there.

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

### 5c. NEW — the suite verifier was unreachable, and I reported skipped runs as green

`scripts/verify-suite.mjs` judges a run rather than its exit code: it re-reads the
summary, compares the collected count against `EXPECTED_TEST_FILES`, and reports
files that were **collected but never executed**. It is unit-tested. It was also
referenced **nowhere** — no npm script, no CI step, no hook — so nothing invoked
it. Built, tested, never run, in the same shape as item 2.

⚠️ **The consequence was mine.** I verified every slice with a bare `npm test`
and reported "suite green, 2,797 files". `DATABASE_URL` was unset in that shell,
so **65 `db-*` integration files plus one more were silently skipped** and the
summary line looked like a full pass — the exact caveat this document already
carried under _Current state_, which I read past.

Measured both ways on the same tree:

| run                            | files                        | tests                          |
| ------------------------------ | ---------------------------- | ------------------------------ |
| `npm test`, no `DATABASE_URL`  | 2,797 passed, **66 skipped** | 28,675 passed, **273 skipped** |
| `npm test` with `DATABASE_URL` | **2,863 passed, 0 skipped**  | **28,940 passed**, 8 skipped   |

**265 tests never ran in any per-fire verification I reported.** All of them pass,
so no defect was hidden — the claim was narrower than it sounded, not wrong about
the code.

Fixed by making the instrument reachable: `npm run verify` now runs it. Without a
database it prints `NOTE — 66 test file(s) were collected but never executed`;
with one it is silent. That NOTE is the line that would have corrected me on day
one.

_Caveat on the verifier itself:_ it spawns `vitest run --config
vitest.node.config.ts`, so it judges the **node project only** — the 162
gui-jsdom files are outside it, and `EXPECTED_TEST_FILES` (2,701) is a node-project
count, not the 2,863 a full `npm test` collects. Two different numbers for two
different runs, which is worth knowing before comparing them.

### 5d. NEW — a DB-suite race that only the runs I had been skipping can show

Surfaced immediately by running the `db-*` files (see 5c).
`database-check-enums-agree-with-the-code` reads `pg_constraint` on the SHARED
database and failed with:

```
PostgresError: could not open relation with OID 4250187
```

which is what a catalog scan returns when a relation is dropped underneath it.

**Frequency, measured rather than guessed:** 3 full runs with `DATABASE_URL` set —
**2 green, 1 red**. The file passes **3 of 3** in isolation, so it is not broken;
it loses a race.

**Mechanism, as far as it is established:** dozens of integration files share
`DB_URL` rather than an isolated database, and several of them run **migrations**
against it (`db-*-envelope-migration-drizzle`, `db-account-proxies-hardening`,
`db-recipes-encryption`, `db-webhooks-concurrency` each open a `migratorClient`
on `DB_URL`). Vitest runs files concurrently, so a migration's DDL can drop a
relation while this file's catalog scan is walking it. Data-only writes cannot
cause this; only DDL can.

_Recommendation:_ **not fixed here, deliberately.** The candidate fixes — moving
this file onto an isolated database, serialising the migration files, or
retrying the catalog read — are each changes to shared test infrastructure, and
this document's own standing rule is no speculative fix to that. The evidence
above is enough for whoever takes it to choose without re-deriving: it is a race
between catalog reads and concurrent migrations on one shared database, not a
defect in the assertion.

⚠️ It is worth saying plainly that **this had been invisible, not absent.** A
suite run without `DATABASE_URL` skips this file along with the other 65, so the
flake could not appear in any verification that reported green.

### 5e. NEW — 53 source files sit outside the coverage gate on an expired reason

`vitest.config.ts` excludes `apps/server/src/db/**` from coverage, justified as
"exercised by e2e against real Postgres, **not by vitest**", captured by the V-086
audit. That is no longer true. **66 files under `apps/server/tests/integration`
import from `src/db/`** — `sessions-repo`, `agent-sessions-repo`, `profiles-repo`,
`webhooks-repo` and others directly — and they run under vitest whenever
`DATABASE_URL` is set. The audit predates the `db-*` integration suite.

So **53 source files** are outside the gate for a reason that has expired, and
nobody can see how well covered the repo layer is: a regression there moves no
number.

_What was measured:_ coverage on the current scope is lines **90.20**, statements
**88.60**, functions **89.41**, branches **79.93**, against thresholds of
85/83/84/75 — gaps of 5.2, 5.6, 5.4 and 4.9 points, so the config's stated "~5
points under its own measurement" policy still holds exactly.

_What was NOT measured:_ coverage with `src/db/**` included. Removing the
exclusion to measure it reds `workspace-vitest-config-content-parity`, which pins
the exclude list — the pin doing its job. Forcing past it would have changed what
the thresholds mean on a number I had not yet seen.

**MEASURED 2026-08-15.** Taken without perturbing the tree — `--coverage.include`
on the CLI, thresholds zeroed for the run, config and pins untouched. Three
earlier attempts that edited the config or moved a file each tripped a guard
(the exclude-list pin, then the on-disk file-count pin); those guards were right
and the measurement route was wrong.

| scope                      | lines     | branches  |
| -------------------------- | --------- | --------- |
| current gate scope         | **90.20** | **79.93** |
| `apps/server/src/db` alone | **62.21** | **51.41** |

So including the directory wholesale would pull the gate down by roughly 28
points on lines. **Not proposed.** The useful output is which files are low, not
the aggregate:

- **Legitimately unmeasurable under vitest (2):** `migrate.ts`, `seed.ts` are CLI
  entrypoints run as processes, exactly like the already-excluded `index.ts`.
- **Zero, and tied to a known-unwired subsystem (1):** `audit-archive-repo.ts` —
  `AuditArchiveService` is item 2's "built, tested, never run".
- **Zero or near-zero Drizzle repos (8)** — six now closed, see progress below:
  `admin-accounts-repo`,
  `email-preferences-repo`, `health-probes-repo`,
  `incident-update-notifications-repo`, `legal-repo`, `validation-schedules-repo`,
  `cost-nightly-accounts-provider`, plus `admin-billing-repo`,
  `byok-anthropic-rotation-reminder-repo` and `webhook-rotation-reminder-repo` at
  8–11% (module-level code only).
- ⚠️ **Security-adjacent and low:** `oauth-store.ts` **7.79%**, `oauth-links-repo`
  **20%**, `auth-repo` **26.47%**, `auth-flows-repo` **42.37%**.

**What this does and does not mean.** Low line coverage on a Drizzle repo does not
mean the behaviour is untested — the service above it is usually well covered
against an in-memory double. What is untested is **the SQL itself**, which is the
same gap V-086's own BYOK finding closed for one query: "no test coverage of any
kind, only in-memory doubles".

_Recommendation:_ treat the 8 near-zero repos as a coverage backlog, closed the
way the BYOK candidate query was — a `db-*` integration file per repo against
real Postgres. Do **not** fold `src/db/**` into the gate until that work lands;
folding it in first would force the thresholds down, and this file's own policy
is never to ratchet downward.

**Backlog progress (updated 2026-08-15).** Enumerated rather than counted, since
the bullet above lists ten names under a heading of eight.

**Closed** — each a `db-*` integration file against real Postgres with a mutation
ledger in its header: `admin-accounts-repo`, `legal-repo`,
`email-preferences-repo`, `incident-update-notifications-repo`,
`health-probes-repo`, `validation-schedules-repo`,
`byok-anthropic-rotation-reminder-repo`.

Also closed since: `webhook-rotation-reminder-repo`, `admin-billing-repo`,
`cost-nightly-accounts-provider`.

**Open: one.** `audit-archive-repo`, blocked on item 2. Re-verified here rather
than inherited from that item — `grep -rn 'new DrizzleAuditArchiveRepo' src/`
returns nothing, so the class is constructed nowhere in the server and a repo
test would cover SQL that nothing calls. It should land with the wiring, not
before.

**So the item-5e backlog is closed except for the one blocked entry.** Ten
`db-*` integration files covering the SQL behind the public status page, the
validation harness, both rotation-reminder sweeps, the nightly cost recompute
and the admin billing cockpit.

⚠️ _One caveat on those ten, checked rather than assumed:_ **six record a
mutation ledger in their header** (`health-probes`, `validation-schedules`,
`byok-anthropic-rotation-reminder`, `webhook-rotation-reminder`,
`cost-nightly-accounts-provider`, `admin-billing`). The earlier four —
`admin-accounts`, `legal`, `email-preferences`,
`incident-update-notifications` — were mutation-proved when written, but the
result was reported to the bus rather than written into the file, so **nothing
in the repository evidences it**. An unrecorded proof is indistinguishable from
an unperformed one to the next reader.

✅ **Backfilled 2026-08-15 — all ten now carry a ledger.** Deliberately
re-measured rather than transcribed from memory, since a ledger written from
recollection would reintroduce the exact unverifiable claim the exercise removes.
That decision paid for itself: it was filed as a documentation gap and **turned
up two real defects**, both in `admin-accounts`.

1. ⛔ **The page-size cap had no arm at all.** Removing
   `Math.min(args.limit ?? 50, 100)` left all ten original arms green — none had
   ever asked for a limit above 100. The HTTP schema caps `limit` at 100 too, so
   this is defence-in-depth rather than the only gate, which is exactly why it
   was easy to leave untested: nothing on the request path notices it going. The
   day a second caller reaches this repo without a Zod schema in front of it, one
   call pulls the whole `accounts` table into memory. Arm added; the mutation now
   reds it.

2. ⚠️ **The keyset-tiebreaker arm was probabilistic.** It caught the dropped
   `id DESC` on 3 runs out of 4. The fixture is not at fault — it forces a real
   tie — the _mutation's effect_ varies: under a timestamp-only sort Postgres may
   return a tie group in any order, and when that order happens to stay
   consistent across the separate paged queries nothing is dropped and the
   set-completeness assertions hold. A guard that reports "fine" one run in four
   on a live pagination bug is not a guard. It now compares the traversal against
   the canonical `ORDER BY created_at DESC, id DESC` read from the database.
   Re-measured after the change: **5 reds out of 5**.

_Worth carrying past this item:_ **a mutation that survives _sometimes_ is a
louder signal than one that survives always**, because it means the guard's
verdict depends on something nobody chose. A single-run mutation ledger cannot
see that class at all — which is an argument for re-running a ledger when the
file it documents changes, not for trusting the number in the header forever.

#### 5i. The VPN-config SSRF/RCE guards were never CALLED by a test — closed

⛔ **The highest-value item currently open**, and a textbook instance of the
"not CALLED" shape from 5f: the classifier works, the route's use of it is
unexercised.

`routes/account-me.ts` refuses a customer-supplied VPN proxy whose real egress
targets something it should not:

| line          | guard                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 490           | OpenVPN — private/loopback/link-local/metadata target, **or a script-executing directive** (`up`/`down`/`route-up`/`tls-verify`, `script-security 2+`) |
| 509           | WireGuard — `endpoint`/`dns` targeting the same address classes                                                                                        |
| 485, 504, 526 | the scheme/config mismatch refusals                                                                                                                    |

The OpenVPN one is not only SSRF: a config carrying `up /bin/sh` is **remote code
execution on the egress host**. **None of these five has ever executed**
(2026-08-15 statementMap).

⚠️ **What makes this subtle rather than an obvious hole.** Both halves look
covered when read separately:

- `classifyUnsafeVpnTargets` is thoroughly unit-tested —
  `webhook-target-guard.test.ts:243+` drives `169.254.169.254`, `10.0.0.5` and
  friends across `endpoint`/`dns`/`remote`.
- `account-me-proxies.test.ts` has a 29-arm suite that **does** register OpenVPN
  and WireGuard proxies, and a dedicated "SSRF host guard" arm.

But that SSRF arm posts `{ label, host, port }` — a **socks5/http display host**.
The route's own comment states the problem it is not testing: _"the real egress is
the embedded `remote <host>`, NOT the display host — guard it."_ **No test ever
posts an UNSAFE VPN config.** Delete the `classifyUnsafeVpnTargets(...)` call from
the route and every existing test stays green: the classifier's own tests still
pass, and the registration tests still pass because their configs are safe.

✅ **CLOSED 2026-08-15.** 6 arms in `account-me-proxies`, 4 mutations, all red.
Every payload keeps a **safe display host**, so a refusal cannot be the
already-tested host guard doing the work — only the embedded target is unsafe.

|                                                 | new arms | guard-lib pin |
| ----------------------------------------------- | -------- | ------------- |
| the route stops calling the guard for OpenVPN   | 3 red    | **green**     |
| the route stops calling the guard for WireGuard | 2 red    | **green**     |
| WireGuard checks endpoint but not DNS           | 1 red    | **green**     |
| `script-security` threshold slips `>=2` → `>=3` | 1 red    | 1 red         |

The first three are the finding stated as a measurement: the classifier is
untouched and all 32 of its own tests still pass, and what broke is that the
ROUTE no longer asks it. Before these arms, that mutation left the entire suite
green.

The fourth is the opposite case and confirms the division of labour: a change to
the CLASSIFICATION logic is caught by the classifier's unit test, as it should
be. ⚠️ It took a second attempt — the RCE arm trips **both** halves of the guard
at once (a dangerous directive AND the level), so it could not distinguish a
slipped threshold from a working one. A level-only arm (`script-security 2` with
no dangerous directive) was added to separate them, plus a `script-security 1`
arm asserting the guard bounds the level rather than banning the keyword, since
refusing level 1 would reject working configurations.

#### 5k. NEW — one query schema, two feeds, and only the route knows which params belong where

✅ **Closed 2026-08-15.** 7 arms in `admin-incidents`, 5 mutations, all red,
**parity pin green on all five**.

`ListIncidentsQuerySchema` serves BOTH `/v1/admin/incidents` and the public
`/v1/status/incidents`, so it necessarily accepts the union of what either
understands — `window` for the public feed, `state` and `cursor` for the admin
one. **Nothing in a shared schema can express "this half belongs to that
endpoint."** Two route-level refusals are the entire enforcement, and neither had
ever executed.

⚠️ What their absence costs is **not an error**, which is what makes it easy to
miss: an operator passing `window` to the admin feed would have it silently
dropped and read an unfiltered page as filtered. _A parameter that appears to
work and does nothing is worse than one that is rejected._ On the public side the
same gap would hand an anonymous caller a lifecycle-state filter the status page
never exposes, and a cursor that pages past the window the feed exists to bound.

⭐ **Every refusal is paired with the same parameter SUCCEEDING on the feed that
owns it.** Without that pair, all three refusal arms would also pass against a
build where `window`, `state` and `cursor` simply did not work anywhere — which
is a different bug wearing the same green.

Also closed here: a malformed pagination cursor answers **400 rather than 500**
(it is customer-supplied base64, JSON-parsed and round-trip checked against its
own ISO timestamp — every step can fail on a hand-edited value), and idempotent
create-by-id refuses a body with no `started_at`, without which a retry mints a
row whose start is the moment of the retry rather than of the incident.

_Note the split arms._ The public refusal is a single `||` over `state` and
`cursor`; dropping either side leaves the other still refusing, so one combined
arm would pass at half strength. They are asserted separately, and the mutation
that drops only `state` proves it.

#### 5l. The OAuth state token's own verification was never driven at the route — closed

`routes/auth-oauth-client.ts` has three cold refusals, and the first is the CSRF
defence for social login:

| line | refusal                                                               |
| ---- | --------------------------------------------------------------------- |
| 201  | `State token invalid: ${stateRes.kind}` — signature, expiry or tamper |
| 222  | `Provider "${provider}" is not configured.`                           |
| 253  | `Userinfo fetch failed: ${userinfo.kind}`                             |

⚠️ **Same split as 5i, on a different control.** `auth-oauth-client.test.ts` has
21 arms and drives the callback 24 times, including a careful set on the
nonce-scoped PKCE cookie binding — "rejects a valid state when only a DIFFERENT
flow's cookie is present", "rejects a tampered value under the correct
nonce-scoped cookie name", "a state+cookie from the SAME flow passes the binding
check". Every one of them supplies a **valid state token** and exercises the
COOKIE. `verifyOauthClientState` returning non-ok is what line 201 refuses, and
`lib-oauth-client-state.test.ts` covers that function in isolation — so once
again the helper is tested, the route's use of it is not.

✅ **CLOSED 2026-08-15.** 4 arms, 4 mutations, all red. All three non-ok kinds
(`malformed`, `bad-signature`, `expired`) driven, plus a genuinely-minted state
asserted to get PAST this check — without which a callback that refused every
state would satisfy all three refusals while breaking social login outright.

|                                          | new arms | verifier's own pin |
| ---------------------------------------- | -------- | ------------------ |
| the route ignores the verifier's verdict | 3 red    | **green**          |
| the route refuses only a MALFORMED state | 2 red    | **green**          |
| the signature comparison always succeeds | 1 red    | 2 red              |
| the TTL check is removed                 | 1 red    | 2 red              |

⛔ The first two are route-WIRING failures the verifier cannot see: it still
classifies every token correctly and all 11 of its arms pass, while the route
acts on a verdict it no longer reads. **The second is the one worth remembering**
— refusing only `malformed` still rejects hand-written junk, so the endpoint
looks defended, while a FORGED token (correct shape, wrong signature) sails
through. That is the login-CSRF bypass, wearing a green suite.

The last two are CLASSIFICATION failures and both layers catch them, which is the
division of labour working as intended: the verifier owns _is this token valid_,
the route owns _do we act on that answer_.

#### 5m. `vi.stubGlobal('fetch')` could not reach the OAuth IDP calls — seam added, closed

⛔ **An existing test helper does not do what its name says**, and it took trying
to use the same technique to notice.

`lib/oauth-client-exchange.ts:51` captures the implementation once, at module
load:

```ts
const DEFAULT_FETCH: typeof fetch = globalThis.fetch;
```

`vi.stubGlobal('fetch', …)` replaces `globalThis.fetch` **afterwards**, so
`DEFAULT_FETCH` still points at the original. Verified rather than reasoned: a
module-scope capture compared against a later stub is not the same reference.

Two consequences:

- **`rejectTokenExchange()` in `auth-oauth-client.test.ts` is decorative.** The
  arms that call it pass because the exchange fails anyway, not because the
  helper made it fail. They are not wrong about their assertions — they assert
  the failure lands past the state/cookie binding — but they do not control the
  IDP interaction they appear to control.
- **`Userinfo fetch failed:` (`routes/auth-oauth-client.ts:253`) is not
  reachable from an integration test.** Driving it needs the token exchange to
  SUCCEED and only the userinfo call to fail, which requires controlling `fetch`.

⛔ **CONFIRMED 2026-08-15: the suite was making real outbound calls.** The
observation above is now measured, not suspected — a `POST` to
`https://github.com/login/oauth/access_token` from this machine answers **404 in
~250ms**, a genuine response, which is exactly why the exchange reported
`idp-error` rather than `network-error`. Every arm that got past the state and
cookie checks was talking to GitHub on each suite run: slow, dependent on network
and third-party availability, and sending fixture credentials off-box.

✅ **CLOSED 2026-08-15.** `RegisterOAuthClientRoutesDeps` gained an optional
`fetch`, threaded through `app.ts` and `buildTestApp` (additive at every layer;
production leaves it unset and the helpers keep their global fallback). That one
seam does three things: closes the `Userinfo fetch failed` branch, turns
`rejectTokenExchange()` from decorative into real, and stops the outbound calls.

3 new arms, 6 mutations, all red — including the token-exchange refusal asserted
as **distinct** from the userinfo one, since they are adjacent branches of
near-identical shape and collapsing them sends an operator reading logs to the
wrong side of the IDP round-trip.

⚠️ **One mutation survived at first and is the reason this entry is worth
reading.** Dropping the seam from the userinfo call left every arm green: the
helper falls back to the global fetch, really reaches `api.github.com`, really
gets a 401, and produces the _same_ 400. The refusal assertion could not tell the
two apart. It now records the injected client's calls and asserts the userinfo
URL went through it — **asserting WHICH client made the call, not only what came
back**, which is what actually pins "this suite makes no outbound request".

_Fix shape:_ `exchangeCodeForTokens` and `fetchUserInfo` both already accept an
`opts.fetch` override — the route simply does not thread one through. Adding that
seam to the route deps closes the branch and makes the existing helper real. Same
shape as the `agentDecomposerKind` harness gap in 5f: **the branch is unreachable
by construction, so the honest move is to add the seam rather than bend a fixture
into it.**

_Meanwhile:_ `Provider "…" is not configured.` (`:222`) **is** now covered —
2 mutations, both red — by replaying a genuine google flow against a server that
has only github wired, same signing secret so state and PKCE cookie both still
verify and only the provider lookup can fail. That models a provider being
de-configured mid-flow, which is the deploy this branch exists for.

#### 5j. NEW — the avatar upload's "invalid base64" branch is dead code

Small, and recorded mainly because the investigation nearly produced a
fabricated vulnerability.

`routes/account-me.ts:776` refuses `'data_base64 is not valid base64.'` from
inside a `try/catch` around `Buffer.from(x, 'base64')`. It is **unreachable, for
two independent reasons**:

1. **`Buffer.from` with `'base64'` never throws.** Verified rather than assumed —
   it silently drops non-alphabet characters (`'!!!!'` → 0 bytes, no throw).
2. **The schema already rejects the input.** `UploadAvatarRequestSchema` carries
   `.regex(/^[A-Za-z0-9+/=]+$/, 'Must be base64-encoded.')`, so a non-base64
   payload is a Zod 400 long before the route runs.

⚠️ _The near-miss worth recording._ Reading only the route, the shape looked
alarming: a `catch` that cannot fire, no magic-byte validation, and bytes handed
straight to R2 with a **customer-supplied `content_type`** — which reads like
stored-XSS on a public bucket. Two checks closed it: `content_type` is
`z.enum(['image/png','image/jpeg','image/webp'])`, a closed set with no
scriptable type, and the base64 regex means the decoded bytes cannot be arbitrary
attacker text. **No vulnerability.** The pattern is the same one 5f produced with
the owner-vanished checks — _the route's own guard is insufficient in isolation
and the real control sits one layer up, in a schema this time rather than a
`where` clause._

_What IS reachable and untested:_ `:779` `'Avatar image is empty.'`, via a
payload of pure padding (`'===='` passes both `.min(4)` and the regex and decodes
to zero bytes). One arm, worth having.

_Not proposed:_ deleting the dead branch. It costs nothing, and a future change
to either the schema regex or the decode call would make it live again.

#### 5h. NEW — 76 text-pin anchors name a control they cannot guard

Generalisation of the `services/auth.ts` finding in 5f, now measured repo-wide
rather than asserted. A `toMatch(/…/)` anchor that matches its target source
**more than once** asserts the block exists somewhere, not that it still guards
the site it was written for: mutating any single occurrence leaves the others
satisfying it. Proved on `auth.ts`, where the anti-enumeration block appears
twice and the pin only reds when BOTH change.

**Measured 2026-08-15** across every `*-content-parity` and
`*-cross-source-invariant` test:

|                                                   |            |
| ------------------------------------------------- | ---------- |
| pins scanned                                      | **439**    |
| anchors extracted                                 | **16,060** |
| anchors matching their source >1×                 | **1,241**  |
| of those, naming control flow or a thrown outcome | **76**     |
| regexes that did not answer within 0.5s           | **2**      |

The 1,241 figure is **not** a defect count and should not be quoted as one. Most
are type and field fragments — `accountId: string;`, `status,` — which
legitimately recur and where "appears at all" is the honest property. The **76**
are the interesting subset: anchors containing `throw new`, `if (`, `=== '` or a
boolean operator, i.e. standing in for a per-site behavioural guarantee. Even
those are a **candidate list** — each needs reading before it is called a defect.

The largest, and they are real controls rather than plumbing:

- `throw new TierLimitError(` — **10 sites** (profile tier caps)
- `if (opts.effectiveAccountId === undefined) { throwIfMissing…` — 6
- `throw new RateLimitedError(` — 5 and 4, in two different pins
- `if (!parsed.success) throw new ValidationError(…)` — 5 (request validation)
- `throw new NotFoundError(\`Account "${accountId}" not found.\`)` — 5
- `if (row === null) throw new AuthFlowError('invalid_auth_token')` — 4

✅ **First 5h entry closed, and it was a real gap.** `throw new TierLimitError(`
— the 10-site anchor above — turned out to name a control with a genuinely
unguarded site. Of the four operations enforcing the profile tier cap
(`create`, `clone`, `importProfile`, `transferProfile`), the first three each had
an execution arm and **`transferProfile` had none**, despite carrying three
distinct refusals: the recipient's profile cap, their monthly import allowance
(`limit * 2`), and the race-safe `limitExceeded` from the conditional insert.

Transfer is the one path that adds a profile to an account the caller does not
own, so an unguarded cap there means a customer can be pushed past the limit they
are billed against, by someone else, without their involvement. Four arms added
(`profiles-service.test.ts`), all four mutations red — **and the pin stayed green
on all four**, which is 5h demonstrated rather than argued.

⚠️ One of the four needed a second look and is worth recording, because the first
reading would have been wrong. Removing the profile-cap **pre-check** changed
nothing under the obvious fixture: the atomic insert's `limitExceeded` catches
the same condition and still throws. That is not a hole in the arm — the
pre-check is a fast path over an authoritative check, and in production both read
the same count, so removing it does not weaken enforcement. What it decides is
**which** limit the customer is told about, profile cap or import cap, and only
one of those tells them something they can act on. The discriminating arm asserts
that, rather than a contrived fixture where the double disagrees with itself.
Same shape as the redundant-predicate case in 5f: a surviving mutation is a
question about the source, not automatically a gap in the test.

⚠️ **Do not read the remaining 75 as unguarded.** A quick scope-check of the next
three candidates suggested `RateLimitedError` had **13 throw sites and zero
execution tests** — a striking-looking result that was **wrong**. The pattern
matched `rejects` and the error name on the same LINE, and prettier splits
exactly that assertion across lines:

```
    await expect(gate(req, reply), 'the request past capacity').rejects.toBeInstanceOf(
      RateLimitedError,
    );
```

`a-rate-limit-store-outage-does-not-remove-the-gate` executes that refusal on
four arms. This is the **second** time in one session that prettier's multi-line
formatting has silently emptied a line-oriented scan — the first was the anchor
detector above. Any grep-based coverage claim over this repository needs to be
multi-line aware before it is quoted, and the failure mode is always the same
direction: it under-reports, which reads as a clean result.

_Corrected scoping for the next slices_ — re-run whole-file rather than
per-line. **These are test-FILE counts, not site coverage**: a file may drive one
of thirteen throw sites. Separating covered sites from uncovered ones needs the
per-line coverage intersection, not grep, and is not done here.

| error              | throw sites in `src` | test files executing it |
| ------------------ | -------------------- | ----------------------- |
| `ValidationError`  | 85                   | 2                       |
| `AuthFlowError`    | 37                   | 2                       |
| `RateLimitedError` | 13                   | 1                       |
| `TierLimitError`   | 12                   | 2                       |

_Fix shapes, in preference order:_ execute the sites separately (what 5f did for
`auth.ts`); or assert the **count** — `expect(matches).toHaveLength(10)` — so a
site disappearing reds even without execution; or anchor to the enclosing
function so the pattern is unique. Deleting the pins is **not** proposed: 5f also
showed the opposite case, a redundant predicate with text but no behaviour, which
only a text pin can see.

⚠️ _Termination, because the first two attempts failed differently._ A naive
sweep never finished — several anchors chain unbounded wildcards (`[\s\S]*?`
between many literals) and backtrack exponentially against a 2000-line source.
Declining "dangerous-looking" patterns was not enough and was also unprincipled.
The measurement above puts a hard **0.5s per-regex wall-clock timeout** on each
match and reports the 2 that did not answer, so the number carries its own
uncertainty rather than hiding it behind a silent skip.

⚠️ _And the detector nearly under-reported._ Its first version required `)`
immediately after the regex; prettier writes multi-line assertions as
`toMatch(\n  /…/,\n)`. That silently skipped 52 of 169 anchors on the first file
tried — **including the anchor the tool existed to find**. A tool that misses its
own motivating case reports a clean bill of health.

#### 5g. NEW — nine keyset guards seed tie groups; one was probabilistic, now all measured

The `admin-accounts` finding above raises an obvious question about its
neighbours, and it should not be answered by assertion. **Nine `db-*` files seed
a deliberate `created_at` tie group** to guard a compound-cursor tiebreaker:

`db-account-audit-repo-keyset-drizzle`, `db-admin-accounts-repo-drizzle`,
`db-admin-audit-repo-keyset-drizzle`, `db-api-keys-repo-keyset-drizzle`,
`db-durable-webhook-list-keyset-drizzle`, `db-legal-repo-drizzle`,
`db-profiles-repo-keyset-drizzle`, `db-rate-limit-overrides-repo-keyset-drizzle`,
`db-sessions-repo-keyset-drizzle`.

✅ **RESOLVED 2026-08-15 — all nine measured, all nine now stable.** Each repo's
compound `ORDER BY` had its `id` half stripped, and the guarding test was then
run **5×**. A stable guard reds 5/5; anything less reports "fine" some fraction
of runs on a live pagination bug.

| guard                                         | detection                    |
| --------------------------------------------- | ---------------------------- |
| `db-account-audit-repo-keyset-drizzle`        | 5/5                          |
| `db-admin-audit-repo-keyset-drizzle`          | 5/5                          |
| `db-api-keys-repo-keyset-drizzle`             | 5/5                          |
| `db-durable-webhook-list-keyset-drizzle`      | 5/5                          |
| `db-legal-repo-drizzle`                       | 5/5                          |
| `db-profiles-repo-keyset-drizzle`             | 5/5                          |
| `db-rate-limit-overrides-repo-keyset-drizzle` | 5/5                          |
| `db-sessions-repo-keyset-drizzle`             | 5/5                          |
| `db-admin-accounts-repo-drizzle`              | 5/5 _(was 3/4; fixed above)_ |

So `admin-accounts` was the **only** weak one, and the eight neighbours were
sound. The tie-group-larger-than-the-page-size construction they share is what
makes the difference: it forces the group to span a page boundary every run,
where `admin-accounts` seeded 4 tied rows through pages of 2 and could land a
boundary that happened not to expose the bug.

⛔ **A near-miss worth recording, because it would have been a confident wrong
finding.** The first sweep reported `db-durable-webhook-list-keyset-drizzle` as
**0/5 — BLIND**, a keyset guard that could not see its own tiebreaker vanish.
It was wrong. The driver mutated `src/db/webhooks-repo.ts`, and that test drives
`DurableWebhookDeliveryService`, whose list keyset lives in
`src/services/durable-webhook-delivery.ts:218`. Mutating a file the test never
executes produces exactly the signature of a blind guard. Re-run against the
right source: 5/5. **A derived measurement is only as good as the key it was
computed against, and "no reds" is the one result that looks identical whether
the guard is blind or the instrument is pointed at nothing.**

_Superseded framing, kept because the reasoning was sound at the time:_ two
things were known about the eight and neither settled it:

- They are built more strongly than `admin-accounts` was — each seeds a tie group
  **larger than the page size** (typically 5 tied rows through pages of 2), which
  forces the group to span a page boundary, the exact condition a missing
  tiebreaker mishandles. `admin-accounts` seeded 4 tied rows through pages of 2
  and still passed 1 run in 4.
- `db-legal-repo` already survived one round of this: its arm's own comment
  records an earlier version that "passed with the tiebreaker removed", fixed by
  making insertion order disagree with id order and repeating the read 3×.

⚠️ _A methodology note on how this list was produced,_ because the first attempt
was wrong in both directions. A grep for `tie` returned nine files — a candidate
list, not a result. A refined detector then reported only **two** genuinely seed a
tie, which was **also wrong**: it keyed on one variable-naming convention and
missed seven files that seed tie groups under different names. The list above is
the hand-verified version. Both errors are the same one — trusting a pattern's
output as a measurement — and the second was more dangerous, because a smaller
number reads like a more careful result.

_Done:_ 45 runs across nine files (5 per file, plus the re-run against the
corrected source). No further hardening needed — `admin-accounts` was the only
guard that required a change.

⚠️ **`validation-schedules-repo` changed what this item means.** It was not an
uncovered repo sitting unguarded — a source pin
(`db-validation-schedules-repo-v218-cross-source-invariant`) has been pinning it
for a long time, which is why the hole was easy to miss. That pin reads the
source and regex-matches it; it never executes a line, so coverage reads zero
while the repo looks guarded. Running the ten mutations against BOTH files, the
pin is blind to **four**, including the one its own header names — "SET excludes
nextRunAt (preserved)", which no arm asserts. The others: `markRun` never
advancing `next_run_at` (the schedule stays due forever, so the harness re-runs
that archetype every tick), `findByArchetype` losing its predicate, and `list`
losing its order. The `markRun` miss is instructive — the pin _does_ assert
`/nextRunAt,/`, but that substring also appears in `upsert`'s insert values, so a
different occurrence keeps it green.

_Generalises past this item:_ a repo with a cross-source-invariant pin should not
be read as covered. The pin freezes what the source **says**; these four
mutations left the text saying the same thing while the behaviour inverted.

**Swept 2026-08-15.** All 53 modules under `apps/server/src/db`, classified by
opening each of the 2,713 test files rather than grepping names: a module counts
as executed only if some test has a real `import … from '…/<module>.js'`, and as
pinned only if a test names its `src/db/<module>.ts` path as a string.

Re-run after the backlog landed, so the same instrument reports both states:

| classification                | before | after  |
| ----------------------------- | ------ | ------ |
| imported by at least one test | 46     | **50** |
| **pinned but never imported** | **5**  | **3**  |
| neither imported nor pinned   | 2      | **0**  |

The three remaining are `migrate`, `seed` and `audit-archive-repo` — the two CLI
entrypoints whose pins are the right instrument, and the one blocked on item 2.
**Every `src/db` module that a test can execute now is executed by one.**

The reasoning behind the "before" column, kept because it is what made the
remaining three defensible rather than merely small — the five
pinned-but-never-imported were **not** five open items:

- `migrate`, `seed` — CLI entrypoints run as processes, already listed above as
  legitimately unmeasurable under vitest. Their pins are the right instrument.
- `audit-archive-repo` — blocked on item 2, as above.
- `byok-anthropic-rotation-reminder-repo` — **closed 2026-08-15**, 11 arms, 8
  mutations. `webhook-rotation-reminder-repo` is the last of this shape.

⭐ **The BYOK one came out the MIRROR of `validation-schedules-repo`, and that is
the more useful result.** Its content-parity pin caught **all eight** mutations,
including one this file's execution arms could not — dropping
`not(isNull(byokAnthropicApiKeySetAt))` left all 11 arms green. That is not a
gap: the predicate is **redundant**. The age gate `lt(setAt, thresholdCutoff)`
sits in the same `and`, and under SQL three-valued logic `NULL < <timestamp>` is
NULL rather than TRUE, so a keyless account is already excluded without it —
confirmed against the database, not argued: `SELECT (NULL::timestamptz < now())
IS TRUE` returns `f`. A clause with text but no behaviour is invisible to every
behavioural test and visible only to a text pin.

_So neither instrument dominates._ The pin sees edits that do not move behaviour;
only execution distinguishes **which way** a change broke. Both halves of the
BYOK dedupe `or` red the pin identically at one arm, while they red one and five
arms here — the pin reports that the text moved, not that customers would now be
spammed rather than silenced. The right reading of the
`validation-schedules-repo` finding is therefore **"a pin is not coverage"**, not
"pins are weak": four repos need execution added _alongside_ their pins, and
none of those pins should be removed.

The two neither-imported-nor-pinned are `admin-billing-repo` and
`cost-nightly-accounts-provider`, already named above.

So the sweep corroborates the coverage figures from a second, independent
direction — the 8–11% those three show is transitive import by a covered
service, not a test of their own — and it closes the question this paragraph
originally left open: **the pinned-but-unexecuted class is four repos wide, not
a systemic hole.**

_No guard shipped for this._ The obvious one — "every repo is imported by some
test, or declared" — was checked against the coverage data and disagrees on 4 of
52 files, because a repo pulled in transitively by a service under test shows
8–11% without any test importing it. A 92%-accurate ratchet would spend more on
its exception list than it earns.

### 5f. 31 of 108 security denial paths had never executed — now 8, all residuals (measured at HEAD)

✅ **RE-MEASURED at HEAD, 2026-08-15 (second run): 8 of 108.** A fresh
`coverage-final.json` was generated against current HEAD — the previous snapshot
predated roughly ten slices, so every figure derived from it had become
arithmetic rather than measurement, and this item exists precisely to avoid that.

⭐ **The arithmetic held.** The interim figure was stated as "8 by arithmetic, not
by re-measurement"; the measurement returns **8**, and the same 8 sites named
individually. Labelling it rather than asserting it cost nothing and the label
turned out to be conservative in the right direction.

_Repo-wide over the same run:_ **1,175 throw sites, 188 never executed** — down
from 202 at the previous snapshot, i.e. 14 closed by the intervening work.

**All 8 remaining are residuals, each verified individually:**

| site                       | why it is a residual                                      |
| -------------------------- | --------------------------------------------------------- |
| `admin.ts:183`, `:220`     | owner-vanished null check                                 |
| `agent-sessions.ts:3920`   | owner-vanished null check                                 |
| `profile-snapshots.ts:217` | owner-vanished null check                                 |
| `profiles.ts:347`, `:411`  | owner-vanished null check                                 |
| `agent-sessions.ts:3916`   | wiring guard (`authRepo === undefined`)                   |
| `services/auth.ts:532`     | only caller always passes `fallThroughOnPrefixMiss: true` |

The six owner-vanished checks are unreachable because `findTeamMemberships`
filters owner status **in SQL** one layer up, so a non-active owner never
produces a grant. **No customer-reachable security refusal in this population is
now unexecuted.**

_The wider picture from the same data, which had never been taken:_ **1,175
`throw new …Error(` sites under `apps/server/src`, of which 202 have never
executed**, plus 105 outside the coverage scope entirely (`src/db/**` is
excluded — item 5e). Security classes are the healthiest slice of that by some
margin; the bulk is `Error` (78 cold of 430) and `BadRequestError` (31 of 121).

**The 13 that remain are not one population.** Six are the owner-vanished
residuals enumerated above and verified unreachable — `admin.ts` ×2,
`profiles.ts` ×2, `profile-snapshots.ts:217`, `agent-sessions.ts:3920`. One more
is `services/auth.ts:532`, the non-fall-through `InvalidKeyError` in
`slowPathApiKey`, reachable only if that function is called WITHOUT
`fallThroughOnPrefixMiss` — and `authenticate`, its only caller, always passes
`true`. It is a residual for a second caller that does not exist yet.

That leaves **six genuinely actionable**, and one is an authorization boundary
rather than a residual:

- ✅ `routes/profile-snapshots.ts:44` — the snapshot-write RBAC gate.
  **Closed 2026-08-15** (`profile-snapshots-team-write-requires-admin`): 6 arms
  across all three routes the gate guards, 5 mutations, all red.

  ⛔ Two of those mutations — a route silently dropping the shared helper — are
  **invisible to the source pin**, which keeps matching the `throw` and the
  `!== 'admin'` while that write path stands open to any team member. The gate
  being CORRECT and the gate being REACHED are different properties, and only one
  is visible in source text. That is why the file drives capture, restore and
  delete rather than proving the helper throws once.

  ⚠️ **The gate enumeration here was wrong, twice over.** It first said five such
  gates existed, from a grep for `require admin role` — which misses the
  `requires` verb form. Verb-agnostic there are **11**, and checked per-site
  against the coverage statementMap: **9 executed, 2 cold**. One was this
  snapshot gate; the other is below. Third time this session a too-narrow pattern
  under-reported, always in the same direction.

- ✅ `routes/sessions.ts:345` — the profile-launch RBAC gate. **Closed
  2026-08-15**, 2 arms in `sessions.test.ts`, 3 mutations, all red, parity pin
  green on all three. **With this, all 11 admin-role gates are executed** — 9 by the coverage statementMap, and these 2 by mutation evidence, which is the stronger of the two: an arm that reds when a line changes has necessarily run that line.

  ⭐ The mutation worth keeping: move the gate BELOW the owner rate-limit/tier
  resolution. The gate is still present and still correct — only its position
  changes — and the member stops receiving the role refusal entirely, getting a
  404 from the owner-scoped profile lookup instead of the 403 that names the
  reason, after `consumeEffectiveOwnerRateLimit` has already charged the owner's
  bucket for a request that was never allowed. A refusal that arrives after the
  metering is not the same refusal, and no text pin can see the difference.

- `routes/agent-sessions.ts:3916` — `'Owner account tier is unavailable.'` is a
  WIRING guard (`authRepo === undefined`), fail-closed for a route registered
  without its dependency, not a customer-reachable path.

- ✅ `routes/agent-sessions.ts:4632` — the bundled-LLM **tier-ineligible**
  refusal. **Closed 2026-08-15**, 1 arm in `bundled-llm-tier-gate`, 3 mutations,
  all red.

  It needed three conditions at once — no resolvable key,
  `bundledLlmTierIneligible`, and `agentDecomposerKind === 'claude'` — and the
  third was **unreachable from every integration fixture**: `buildTestApp` never
  passed it and `buildApp` defaults to `'deterministic'`. So the harness gained
  an `agentDecomposerKind` option rather than the fixture being bent into
  reaching the branch some other way.

  ⭐ That flag changes only what the **route believes** is wired; the runtime's
  decomposer stays deterministic. Faithful rather than sloppy: every branch the
  flag opens REFUSES before any decomposer call, so the instance behind it is
  never consulted on those paths. The third mutation proves the option is
  load-bearing — flip the condition to `'deterministic'` and the arm reds,
  because it reaches the branch through exactly that flag.

  _Why the refusal is worth its own error:_ consent is already on, so the blocker
  is the plan. The consent error would point the customer at a toggle that is
  already ticked; the generic `ByokAnthropicRequired` 502 would tell them to
  supply an API key when upgrading is the simpler fix. The existing spy-based arm
  covers the turn-time tier RE-CHECK and legitimately never reaches this throw,
  because on a deterministic deployment the turn succeeds through the generic
  decomposer and there is no refusal to assert.

### 5n. The two classic authorization-code attacks, and a blocker of mine that was wrong

`exchangeCode` in `services/oauth.ts` runs a chain of guards, and two of them had
never executed at HEAD. Neither is caught upstream, so neither was redundant:
the token route's schema checks **shape only** (`redirect_uri: z.string().url()`),
and nothing at the route layer knows which client a code was issued to.

- **`:612` redirect_uri rejected.** The allowlist refuses credentials embedded in
  the URL, a fragment, and any non-https scheme except localhost — each a way to
  land an authorization code somewhere the client never nominated. Three arms,
  one per rejection class, because they fail through **different clauses**; the
  ledger shows dropping the credentials/fragment line reds exactly the two arms
  that depend on it rather than all three. Four mutations, all red.

- **`:620` code issued to a different client.** A code minted for client A must
  not be redeemable by client B even when B authenticates correctly as itself.
  Four mutations, all red.

Left alone deliberately: **`:518`**, the PKCE-downgrade guard. The authorize
route's schema is `z.literal('S256')`, so the service's own copy is a second
layer HTTP cannot reach, and the route-level refusal is already covered.

⭐ **The part worth recording is that I got the second one wrong first.** I
reported `:620` as blocked and committed that claim, on the reasoning that
earning a code requires `POST /v1/oauth/authorize/complete`, which refuses an API
key:

    if (ctx.webSession === null) …
    // Accepting an API key here lets a stolen limited credential launder its
    // authority into an independent OAuth token that survives key revocation.

That refusal is real and correct. My conclusion from it — "the harness cannot
mint a web-session credential" — was not: signup + verify-email issues one, and
**ten integration suites already authenticate that way**. One grep would have
shown it.

The actual obstacle was two lines further down, `requireTierFeature(ctx.account.tier,
'apiAccess')`. A signup account is `free`, the one tier with `apiAccess: false`,
and the harness seeds the tier of the **API-key** account while leaving the
**signup** account at the production default. Two correct gates in sequence, fed
by two different accounts. `signupTier` is that missing knob, and it is additive
— unset keeps the service's own `?? 'free'`.

⚠️ **The lesson is about the shape of the evidence, not the miss.** A 403 is
equally consistent with "wrong credential kind" and "wrong tier". I read the
first gate, found a sufficient explanation, and stopped — so the claim was
untested where it was most load-bearing. **A recorded blocker is a claim like any
other and earns the same verification as a finding**; being an admission of a gap
makes it feel humble, which is exactly what stops it being checked. Consent is
the entry point to the whole provider surface, so the wrong blocker would have
written off every branch downstream of a real authorization code.

⭐ Two mutations in this slice are worth keeping as patterns. **Comparing the
authenticated client back to the body-supplied id** (`client.client_id !==
args.client_id`) is a tautology after `authenticateClient` — the guard reads
correctly, reviews cleanly, and enforces nothing. And **refusing every exchange**
leaves the attack assertion passing; only the "rightful client still succeeds
afterwards" leg tells a working binding check apart from a build that refuses
everyone, which is why the arm spends a second exchange on it.

### 5o. Two clusters that must stay cold, and how one nearly became false coverage

Not every never-executed refusal is a gap. Three sets measured this fire are
**shadowed** — a correct guard sitting behind another correct guard that HTTP
reaches first. They are worth recording precisely because the next coverage sweep
will surface them again.

- **`account-me.ts:485 / :504 / :526`** — scheme↔config coherence.
  `AccountProxyInputSchema` is a `.strict()` discriminated union on `scheme`, so a
  missing or stray VPN block is rejected before the route runs. The schema's own
  comment records that it took the job over from these lines.

- **`agent-sessions.ts:3916 / :3920`** — the `/mode` flip's owner-resolution
  refusals. The `app.rateLimit('global')` preHandler resolves the effective owner
  first and answers **the identical message** from `middleware/rate-limit.ts:178`.

- **`services/oauth.ts:518`** — PKCE downgrade, behind `z.literal('S256')`.

⛔ **The second one nearly shipped as false coverage, and the way it failed is the
point.** I wrote an arm asserting a control key cannot outlive its owner, saw a
403 whose body read exactly `Owner account no longer exists.`, and had a green
test naming `agent-sessions.ts:3920`. It never reached that line. Disabling
`:3920` left the arm **green**; disabling `middleware/rate-limit.ts:178` reddened
it. That message appears at **nine sites across five files** — `rate-limit.ts`,
`profiles.ts` (×3), `admin.ts` (×3), `profile-snapshots.ts`, `agent-sessions.ts`
— so matching on it identifies nothing at all.

⚠️ **A response body cannot attribute a refusal when the string is shared.** The
only instrument that can is disabling the specific site and seeing whether the
test notices. I had grepped the message within `agent-sessions.ts`, found one
hit, and treated that as uniqueness — the file was the wrong scope, and my own
rule about verifying repo-wide rather than in the named file is exactly what I
skipped.

⭐ The same measurement answered the question I had actually been chasing. I
suspected a bug: a vanished owner appearing to block a flip back to `manual`,
against the source's rule that handback is never tier-refused. It is not a bug
and it is not a tier refusal — it is the uniform owner-validity check in the
rate-limit preHandler. And `rate-limit.ts` already answers the reachability
question in its own comment: accounts are **soft-deleted**, so the production
shape is `status === 'deleted'`, not a null row. Mutating away that half reddens
existing tests, so the live case is covered; the null-row half is defence in
depth for a state production does not produce.

**Nothing was committed for this cluster.** The arms were dropped rather than
reworded, because an arm that reaches a different layer than it names is worse
than no arm: it reports the shadowed site as covered and stops anyone looking
again.

### 5p. The isolation census — what it found, and why it cannot certify anything

After finding six uncovered ownership routes on agent sessions, I stopped picking
targets by reading files: enumerate every parameterised route the running app
registers, drop staff surfaces (`/v1/admin/*`, `/v1/internal/*` — scope-gated
rather than row-owned), and ask which are mentioned by no cross-account test.

**70 customer-facing parameterised routes. 7 unmentioned.** Final disposition:

| route                                            | verdict                                                      |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `POST /v1/profiles/:id/launch`                   | **real gap — closed** `d0b14e54a`                            |
| `POST /v1/profiles/:id/transfer`                 | **real gap — closed** `d0b14e54a`                            |
| `GET`+`DELETE /v1/recipes/:id`                   | **real gap — closed** `4429f4184`                            |
| `DELETE /v1/team/members/:id`                    | **real gap — closed** `4429f4184`                            |
| `POST /v1/webhook-deliveries/:deliveryId/replay` | **false positive** — covered all along                       |
| `GET /v1/status/incidents/:id`                   | **not applicable** — served `publicOnly`, no per-account row |

⛔ **The false positive is the part worth keeping, because the instrument had the
exact bug it was built to find.** The census read only test files whose NAME
contained `cross-account` or `isolation`. `webhook-replay-customer.test.ts`
carries an explicit _"404 when an UNRELATED account replays the delivery"_ arm and
was scored as uncovered — coverage living under a different filename was
invisible. **Filtering a corpus by filename is the same wrong-scope error as
grepping a single route file**, which is what produced the gaps this census was
built to find in the first place.

⚠️ Widening the corpus to every test carrying a cross-account signal (150 files)
flips the answer to **70 of 70 mentioned** — which is equally useless in the other
direction. A string match cannot tell "an arm drives this route" from "this path
appears somewhere in a file". The census is a **discovery heuristic that produced
four real findings**, and it certifies nothing.

⭐ The instrument that does certify is unchanged and unglamorous: **disable the
ownership check and see whether anything reds**, after confirming the owner's own
request succeeds. Every route above was accepted or rejected on that basis, not
on the census output — including `/transport-report`, which passed its arm and
kept passing with ownership disabled because it could not see the fixture's
session ids at all.

### 5q. Two guards measured and deliberately NOT covered, with the arithmetic

Coverage work needs a stopping rule as much as a target list, or the tail turns
into busywork that slows every future suite run. Two sites measured this fire:

- **`agent-sessions.ts` empty-upload guard** (`Uploaded file is empty…`) —
  **already covered.** Ignoring it reds an existing arm. No work needed; recorded
  so the next sweep does not re-derive it.

- **`agent-sessions.ts:3102`, the 64 MiB per-file cap** — genuinely uncovered
  (ignoring it leaves 226 agent-session tests green), and deliberately left that
  way. Reaching it needs a payload **above 64 MiB decoded**, which is ~85 MiB of
  base64 plus a JSON envelope, allocated in the test process on **every suite
  run**. `UPLOAD_MAX_FILE_BYTES` is a `const` inside the route registration, so
  there is no seam to shrink it without changing production code.

  What that buys is coverage of a single `bytes.length > CAP` comparison that
  already sits behind Fastify's own `bodyLimit` of 96 MiB — the source says so
  directly: _"Beyond this Fastify 413s before the handler; the handler is the
  authoritative 64-MiB-decoded enforcer."_ So the window the guard uniquely owns
  is 64–96 MiB, and an escape costs one oversized file reaching a harness that
  has its own cap.

⭐ The honest form of this is a recorded decision with the numbers in it, not a
silent skip. If the cap ever becomes injectable, or the outer `bodyLimit` is
raised, the arithmetic changes and the arm becomes worth writing.

### 5r. The money surfaces swept — and they are in good shape

Widened the mutation sweep off agent-sessions onto the paths where a bug costs a
customer money. Every site neutralized in turn against the billing / Stripe /
crypto test set.

| surface                    | sites probed | uncovered                                  |
| -------------------------- | ------------ | ------------------------------------------ |
| `webhooks-stripe.ts`       | 4            | 1 (`:73` empty body — **now covered**)     |
| `billing-crypto-orders.ts` | 5            | 0                                          |
| `routes/billing.ts`        | 4            | 1 (`:50` — **schema-shadowed**, see below) |
| `services/billing.ts`      | 6            | 1 (`:251` — **deferred**, see below)       |

⭐ **The headline is the negative result.** `Invalid Stripe signature` — the
boundary that stops anyone forging a billing event into a tier upgrade — reds
**4** existing arms. The crypto-order money paths are 5 for 5. This is the first
surface swept all session that came back essentially clean, and that is worth
recording as precisely as a gap: it bounds where the risk is not.

**`routes/billing.ts:50` is schema-shadowed.** `validateReturnUrl` refuses twice —
malformed URL, then disallowed origin. The origin half is covered; the parse half
is unreachable, because `CreateCheckoutSessionRequestSchema` already carries
`success_url: z.string().url()`. Two arms were written for it and **removed** when
the request came back as a Zod validation error naming neither field. Same class
as `AccountProxyInputSchema` and `oauth.ts:518`.

⚠️ Worth noting what that does NOT mean: the open-redirect boundary is the ORIGIN
allowlist, and that half is covered. The shadowed half is a message-quality guard,
not the control.

**`services/billing.ts:251` is deferred on a behavioural question, not on cost.**
`getBillingState` throws `Account not found.` when the BILLING repo has no row for
an account that `resolveEffectiveAccount` already accepted — i.e. an account that
exists in auth but has never touched billing. Whether that should be a 404 or a
`subscription: null` is a product decision, and an arm either way would freeze an
answer nobody has given. Recorded rather than encoded.

### 5s. `services/webhooks.ts` swept — 28 sites, 6 uncovered, 3 driven

| uncovered site                                | disposition                                       |
| --------------------------------------------- | ------------------------------------------------- |
| `:707` deliveries list for a missing endpoint | **covered** — a fixed bug with no regression test |
| `:532` endpoint deleted mid-UPDATE            | **covered**                                       |
| `:598` endpoint deleted mid secret-ROTATION   | **covered**                                       |
| `:751` delivery replay, endpoint vanished     | open — same shape as `:532`                       |
| `:942` delivery "disappeared mid-requeue"     | open — the source calls it unreachable            |
| `:988` malformed webhook URL                  | **schema-shadowed** — `url: z.string().url()`     |

⭐ **`:707` is the find of this sweep, and it is a regression risk rather than a
gap.** Its own comment records that listing deliveries for a nonexistent endpoint
used to answer an **empty list** — "indistinguishable from a real endpoint that
has never fired, so a customer debugging a mistyped id was shown 'no deliveries'
instead of 'no such webhook'". Someone found that, fixed it, wrote the comment,
and pinned nothing. The bug could return exactly as it left.

The mutation for it deletes the existence check and returns the empty list again
— **the code that actually shipped before the fix** — rather than only
neutralizing the throw. A ledger row should reproduce the historical bug when one
is known.

⚠️ `:988` is the third instance today of a URL-parse guard shadowed by
`z.string().url()` (after `routes/billing.ts:50`). The pattern is worth naming:
**a `try { new URL(x) } catch` inside a service is almost always dead when the
request schema already validates the field** — and it reads like the validation.

⚠️ `:942` is left alone deliberately: the source says the value "is guaranteed
non-null because we just found the row above" and the guard exists for strict
type-narrowing. Driving it means forcing a state the code says cannot occur, and
the arm would pin the narrowing rather than a behaviour.

### 5t. The refusal-coverage frontier is closing — seven services swept

Seven services have now been swept site-by-site with mutation, and the yield per
sweep is falling in a way worth recording, because it changes what the next fire
should do.

| service                                | sites | uncovered | driven |
| -------------------------------------- | ----- | --------- | ------ |
| `auth.ts`                              | 42    | 6         | 5      |
| `profiles.ts`                          | 33    | 8         | 4      |
| `webhooks.ts`                          | 28    | 6         | 3      |
| `recipe-payload-encryption.ts`         | 14    | 8         | 4      |
| `cli-authorize.ts`                     | 13    | 3         | 3      |
| `sessions.ts`                          | 19    | 5         | 1      |
| money surfaces (stripe/crypto/billing) | 19    | 3         | 1      |

⭐ **What is left uncovered is now mostly two kinds of thing, and neither is a
gap.** In `sessions.ts`, three of the five are the same
`destroySessionSerialized returned destroyed without destroyedAt` internal
invariant, and `:474` (archetype not selectable) is shadowed by
`SelectableArchetypeIdSchema` on the create request. Across all seven sweeps the
residue is: **internal "cannot happen" invariants**, and **guards shadowed by a
request schema**.

⭐ The single recurring finding across every sweep was structural rather than
per-file: **a rule implemented more than once, tested in only some of its
copies.** Six instances — `/handback` vs `/takeover`, `validateReturnUrl` origin
vs parse, the auth cache session-block vs key-block, the auth cache-write key vs
session branch, the recipe intent-log vs transcript key check, and `destroy`'s
three not-found copies. That is the pattern to search for first in anything not
yet swept, ahead of "which lines are cold".

⚠️ **Implication for the next fire.** Continuing to sweep by refusal count has
diminishing returns; `agent-decomposer-claude.ts` (23) and
`status-subscribers.ts` (13) are the last large ones, and if they follow the
trend most of their residue will be invariants and schema shadows. The higher
yield now is **property-shaped work** — asking what a subsystem must never do —
rather than enumerating throws.

### 5u. One rule, eight implementations — and a correction to 5-something

The guard-condition census found `key.length !== AES_256_KEY_BYTES` at **eight
independent modules**, one per secret type: BYOK Anthropic, platform secret,
platform secret value, LiveKit secret, GUI control key, webhook secret, profile
key hierarchy, recipe payload.

All eight are covered for a SHORT key. Measured against the whole unit suite,
relaxing `!==` to `<` **survived in five of the eight** — a test that only sends
short keys cannot tell an equality from a floor, and an over-long key is the
realistic shape (a 64-byte key pasted where 32 was wanted, base64 that decoded
with trailing bytes).

Three now carry an over-long arm as well (`platform-secret-encryption`,
`webhook-secret-encryption`, `profile-key-hierarchy`), each mutation-proved.

⛔ **Correction to the recipe-crypto commit (`ae600488d`) and its bus post.** Both
said an over-long key "is silently truncated by the cipher". **It is not.**
Measured: `createCipheriv('aes-256-gcm', <48 bytes>)` throws `Invalid key
length` — node rejects 16 and 48 alike and accepts only 32. So relaxing the check
trades a named, module-level refusal for a crypto-internal error that says
nothing about which secret or key was misconfigured. That is the same argument as
the `PROFILE_MASTER_KEY` fail-closed refusal — an operability property, **not a
plaintext hazard**. The claim was wrong in the direction that made the finding
sound worse than it is, which is the direction that most needs correcting.

⭐ The uncovered five were found by asking "is this rule the same everywhere?"
rather than "which lines are cold" — all eight lines were already _executed_.
**Coverage and correctness are different questions, and the census asks the
second one.**

### 5v. Two designs for one rule — and only one of them can fail

The prefixed-id parser exists in two shapes, and the difference is the whole
finding. The guard-condition census grouped them because their conditions
normalise alike; their risk profiles do not.

**Design A — the prefix is IN the regex.**
`PROFILE_ID_RE = /^prof_(<uuid>)$/`. A wrong prefix does not match. There is no
separate clause, so there is nothing to drop, forget, or refactor away. Used by
`routes/profiles.ts` and `routes/team.ts`.

**Design B — a permissive regex plus a second condition.**
`PUBLIC_ID_RE = /^[a-z]{3}_(<uuid>)$/` and then
`value.startsWith(\`${expectedPrefix}\_\`)`. The regex deliberately accepts ANY
three-letter prefix, so correctness rests entirely on the extra clause. Used by
the admin routes and, until this week, `routes/webhooks.ts`.

⛔ **Design B's clause was untested everywhere it was probed.** Dropping it from
three copies at once left the 2,747-test integration suite green; dropping it
from `admin.ts` and `admin-api-keys.ts` left the 481-test admin/profiles/team set
green. Every existing arm probes malformed junk, which the REGEX rejects on its
own — so none of them could see the clause at all.

Two sites are now covered (`webhooks.ts`, `admin-api-keys.ts`), each with the
same two mutations: the clause dropped, and the clause comparing the value to its
own slice — the second being the shape a refactor produces, still present and
still reading like a prefix guard while matching everything.

⭐ **The recommendation follows from the measurement rather than from taste.**
Design A removes the failure mode instead of testing it: the same rule, one
fewer thing that can silently stop being true. Migrating the remaining Design-B
parsers to a per-resource regex would delete this class of gap rather than
covering it — worth doing when those files are next touched, and not worth a
dedicated sweep on its own.

⚠️ What Design B buys is a shared helper across resources (`expectedPrefix` is a
parameter), so the migration is not free — it trades one generic function for a
regex per resource. That is the actual trade, stated so the next person can weigh
it rather than reading this as "the admin routes are wrong".

## Current state

Node suite **2,722 files / 27,557 passing** with `DATABASE_URL` set, so the
real-Postgres integration files run rather than skip (refreshed 2026-08-15; the
figure had read 2,559 / 26,548). e2e **199 / 0**, from
187/10 at the start of the run. Python SDK 337 tests + mypy strict over 43
files; Go SDK vet and tests clean; all five Astro sites typecheck clean;
`npm audit --omit=dev` 0 vulnerabilities.

One caveat on reading any of these numbers, including mine: a suite run without
`DATABASE_URL` silently SKIPS every `db-*` integration file, and the totals it
prints look like a full pass. The figures above are from a run with the database
present. See item 11 for the one intermittent failure that configuration can
surface.
