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
