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

**This header described the section as it was, not as it is.** It claimed "ten
items … ordered by what it costs to keep waiting". There are now **36 numbered
entries**, in arbitrary order, with closed ones left inline — and most of the
entries above 20 are work RECORDS appended here rather than decisions anybody is
waiting on. A reader looking for "what needs deciding" was being handed a
chronological log.

Corrected rather than reordered, because renumbering 36 entries would break every
cross-reference in this document. What follows is the index the header used to
imply.

**Still pending a decision — nothing more to engineer:**

| #      | item                                                                 | cost of waiting                                                                                                                                                                                    |
| ------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | 1,554 commits have never reached CI                                  | grows every commit; the eventual push is one high-risk event                                                                                                                                       |
| 2      | Three subsystems built, tested, never run                            | unknown-unknowns surface in front of a customer                                                                                                                                                    |
| ~~6~~  | ~~Unrecognised request fields are silently dropped~~                 | **CLOSED 2026-08-16** — decided under the auto-decide directive: REPORT, don't reject. Eleven routes surface ignored keys in a header + server log; no response body changed, so no client breaks. |
| 7, 8   | Free-tier OAuth consent + free-tier API-key minting                  | abuse surface open on the unpaid tier                                                                                                                                                              |
| 9      | GUI signing identity                                                 | ships unsigned or signed by the wrong identity                                                                                                                                                     |
| ~~37~~ | ~~Concurrent profile transfers duplicate a profile across accounts~~ | **CLOSED 2026-08-16 (`87914bdd7`)** — decided under the auto-decide directive and fixed: one transaction, source retire is a checked claim.                                                        |

Everything else numbered in this section is CLOSED, CORRECTED, or a record of
completed work; the eight explicitly marked so are left in place for their
evidence.

⚠️ **Item 3 was in this index and should not have been** — corrected the same fire
it was written. Its first bullet is CLOSED (the retention line was reworded and is
now pinned positively AND negatively), and its second resolves itself once item 2's
archiver runs. It is subsumed by item 2, not a decision of its own. An index is only
worth having if its rows are checked, so each one was.

Each item below states the evidence, what happens if nothing is decided, and a
recommendation. None is blocked on more test coverage; every one is blocked on
somebody choosing.

### 1. 1,515 commits have never reached CI

`git rev-list --count @{u}..HEAD` = **1,554** (was 1,515, 1,068, 1,031, and
1,022 before that). The count is re-checked each time this item is touched, because the
evidence below decays with every commit that lands after it — and it had decayed
badly: the figure sat at 1,068 while the real number was **1,515**, a 42% under-
statement, which makes the item read as less urgent than it is. Upstream's tip is
`6b3a856cd`, dated **2026-07-12** — **35 days**, not nineteen. Every "gates green" any agent has reported, including all of
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

  **First end-to-end run done, 2026-08-16** — the "staging dataset first" the
  recommendation asks for, taken as far as I can within my rails: the real Drizzle
  repos against real Postgres with a recording R2 double
  (`db-audit-archive-end-to-end-drizzle.test.ts`). The unit tests cover the service
  against fakes; what had never run is the **SQL** — the window predicate choosing
  which rows are old enough, and the delete-by-id that removes them. Both work:
  aged rows upload and are deleted, a recent row is untouched, and the ledger
  records the sweep with a checksum over the uploaded bytes. Proved by mutation —
  inverting the window predicate and skipping the delete each red the arm.

  **Exactly two of the five tables carry a PROJECTION** — `session_events` and
  `webhook_deliveries` — and both projections are redactions rather than shape
  changes. (An earlier revision of this paragraph called them "the two
  high-volume tables"; that is wrong. `AUDIT_TABLES` classifies only
  `session_events` as high-volume, `webhook_deliveries` is audit-shaped, and the
  overlap is a coincidence.) Both are now exercised on the archive path against
  real rows:
  - `session_events`: an archived `navigated` event keeps the origin and drops
    the path and query, which is where customer data and tokens live. A seeded
    event carrying `/reset-password?token=…` archives as the bare origin. Proved
    both ways — skipping the projection in the archive, and making the projection
    keep the whole URL, each red the arm.
  - `webhook_deliveries`: a legacy `session.failed` delivery is rewritten through
    `projectSessionFailedData`, an ALLOWLIST (`session_id`, `duration_ms`,
    `operation`, `error_name`, `error_message`), with the response excerpt and
    delivery error nulled. `error_message` survives but is REPLACED by one of
    four canned strings, so the test asserts no key outside the allowlist
    survives and the message is canned — not that the field is absent. Its only
    prior coverage was a content-parity pin, which records what the source SAID
    and never whether it was true. Proved three ways — skipping the projection,
    keeping the excerpt and error, and passing the legacy payload through
    uncanonicalised, each red the arm.

  Without these, the live API would redact detail that the archive quietly
  shipped to R2 — the archive was the one path that could undo the redaction.

  What this does NOT establish: it has still never run against production data
  volumes, and wiring the tick remains a deploy decision outside my rails. Two of
  the five tables (`admin_audit_log`, `legal_acceptances`) are still unexercised
  end-to-end, though both are pass-through — no projection to get wrong. The
  unknown-unknown is smaller, not gone.

- **`WebhookSecretForceRotationService`**. Rotates webhook signing secrets past
  91 days and emails the customer a 7-day grace deadline.

  **Its SELECTION QUERY is now pinned (2026-08-16).** The policy decision below is
  still open, but the query is the part a policy cannot fix: it decides whose
  secret rotates, and if its predicates are wrong then the day someone wires the
  tick every endpoint rotates at once no matter what the policy says. It had no
  behavioural coverage at all — every test naming
  `findEndpointsNeedingForceRotation` used an in-memory fake returning `[]`, plus
  a content-parity pin over the source text. Measured: widening the age threshold
  until every endpoint is due, and dropping the already-force-rotated exclusion so
  endpoints re-rotate on every tick, each left all 22,428 tests green.

  Now covered against real Postgres in both directions for all five predicates —
  aged selected, fresh excluded, already-force-rotated excluded, disabled
  excluded, ordering oldest-first, limit honoured. Proved by mutating each in
  turn. This mirrors the discipline its sibling
  `findEndpointsNeedingRotationReminder` already had; the asymmetry mattered
  because the reminder only sends an email while this one changes the secret. Its sibling
  `WebhookGraceExpiringNoticeService` IS wired, so the half that warns about
  expiring grace windows runs while the half that opens them does not.
  _(Clarified 2026-08-16: that asymmetry does NOT make the notice service idle —
  `POST /v1/webhooks/:id/rotate-secret` opens a grace window on customer action,
  so it has real work regardless. What is missing is server-initiated rotation,
  not the notices.)_
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

  ⚠️ **The 90-day window itself was untested until 2026-08-16.** The integration
  arm asserted only the PAST-the-window direction for `api_keys` — an aged key is
  scrubbed — while the sessions sweep next to it had both directions. Widening the
  key window until it meant nothing (every revoked key anonymised at once, the
  instant it is revoked) left the entire suite green. The reworded promise above
  rests on that window, and destroying a key's name and hash early is
  irreversible. `recentKey` was already being seeded and simply never asserted;
  it now is. Not pinned: `<` vs `<=` at the exact cutoff instant, which needs a
  key revoked at that microsecond and is immaterial on a 90-day window.

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

### 5b. CLOSED — the verification GATE tested a build artifact it never rebuilt

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

**CLOSED 2026-08-16 — decided and fixed, and the framing above was too narrow.**

Re-read from source: the root `package.json` already has a `pretest` that runs
`npm run build --workspaces --if-present`, so plain `npm test` DOES rebuild, and
CI builds too. The hazard was never really "the local loop" in general — it was
one specific consumer. **`scripts/verify-suite.mjs` spawns `npx vitest run`
directly**, so it inherited neither the `pretest` nor CI's build step. That gate
is what every commit in this repo is validated against, including all of mine, so
the instrument whose green is most load-bearing was the one testing whatever
`dist/` happened to hold.

Neither of the two options above was the right fix, and the reason each was
rejected turned out to be measurable rather than a matter of taste:

- The **alias** would change what 253 server test files actually assert (source
  instead of the artifact CI publishes), and would leave that artifact
  behaviourally untested everywhere.
- A blanket **pretest on every vitest invocation** would tax ad-hoc runs, which
  is the loop used most.

So the build was wired into the GATE instead. `npm run build:packages` is
incremental — **measured at 2.02s with the artifact already current**, against a
multi-minute suite — which is what makes this affordable and is why the "slows
every local run" objection did not survive measurement.

Proved end to end, both directions:

- Edit a cap in `packages/api-types/src` without rebuilding, run the gate on one
  file, and `dist` now carries the edit (`1 * 2 ** 30` → `64 * 2 ** 30`). Before
  the change it stayed stale and the suite asserted against the old value.
- Inject a type error into the package: the gate exits 1 with
  _"the workspace packages failed to build, so the suite would have run against a
  stale artifact"_, and **vitest never runs** — it fails closed rather than
  falling back to the last good artifact, which would have been the worst
  outcome available.

The targeted mitigation remains and is still worth having:
`an-unbounded-paid-session-is-a-visible-choice` reads the cap table from source
and asserts the built copy agrees, so a divergence is caught by identity as well
as by rebuild. Its existence is also what makes the general hazard hard to
demonstrate with that particular table — it reds on divergence by design.

### 6. Unrecognised request fields are silently dropped — CLOSED

**CLOSED 2026-08-16.** The recommendation said "product call — making the schemas
strict is a breaking change for any client already sending extra fields", and that
framing is what kept it open: it treated the choice as binary. It is not.

**Decision: report, don't reject.** The request still succeeds exactly as before and
the ignored keys are surfaced in an `x-driftstack-unknown-fields` response header and
a server-side warning. No response body changes, so no existing integration can break
on it — and the header is precisely what a later API version needs before it can
tighten to a refusal, because it shows who is actually sending extras.

Eleven routes report: profile create/update/import, recipe create, snapshot
capture/restore, billing checkout, agent-session takeover/mode/input-event, and the
agent-message route entry. Each has its own route-level arm, because reporting and
silent stripping produce identical bodies and status codes — nothing else notices if a
route loses the call.

Deliberately excluded: **unauthenticated auth endpoints**. Echoing a caller's own keys
back to an anonymous caller discloses schema shape on the surface that attracts the
most probing, and the failure this item describes — a mistyped field silently changing
a resource — is a property of authenticated resource writes rather than of login.

Also excluded: the three helper-level re-parses of the agent-message body. They
re-parse the SAME body for one logical request, so the report sits once at the route
entry rather than up to three times beneath it.

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

### 37. Concurrent profile transfers duplicate a profile across accounts — CLOSED

**CLOSED 2026-08-16 (`87914bdd7`).** Decided under the auto-decide directive rather
than waiting further: the transfer now runs in ONE transaction that cap-checks the
recipient, CLAIMS the source by retiring it and checking that claim, then inserts.
The loser of a race matches zero rows and returns before writing anything, so there
is no compensating delete and no window in which two rows exist; the service maps
that outcome to a 409. Refusal checks still run before the first write, so a refused
transfer leaves the source intact.

Proved on real Postgres across two connections: with the claim's result discarded
both transfers win and the profile exists in two accounts; with it checked, exactly
one wins. The evidence below is left in place because it is the reproduction.

### 37. Concurrent profile transfers duplicate a profile across accounts

The only defect found across three independent concurrency enumerations (7l, 7n,
7o), and the only one of 31 audited persistence sites where the first write is not
a checked claim.

`transferProfile` reads the source with a plain `findById` — no lock, no claim —
inserts a fresh profile into the RECIPIENT under `insertWithLimit`, which takes the
**recipient's** account-row lock, then soft-deletes the source. Two transfers of one
profile to DIFFERENT recipients take DIFFERENT locks and never exclude each other,
and nothing at any layer serialises on the source: no advisory lock, no idempotency
key, no claim.

_Evidence:_ reproduced, not argued. A first probe returned `fulfilled, rejected` —
the benign ordering, and one sample of a race proves nothing. Forcing the
interleaving, so both callers had provably passed their own read before either
wrote:

    outcomes = fulfilled, fulfilled
    copies_in_recipients = 2
    source_remaining = 1 (soft-deleted)

One profile becomes two, owned by two different accounts, and both callers are told
they succeeded. DEK handling is sound — each recipient gets a freshly minted key, so
no key material crosses tenants — but the profile identity and its archetype/config
are duplicated across accounts never meant to share it. The repo already reports the
truth: `delete` is a soft delete carrying `notDeleted` and returning
`result.length > 0`; the service calls it as a bare `await` and discards it.

_Doing nothing:_ a double-clicked transfer, or a client retry, silently forks a
customer's profile into two tenants. `auth-flows.ts::signup` names that exact
scenario in its own comment ("a double-clicked submit") and handles it; this path
does not.

_Why it is a decision and not a fix:_ each obvious remedy trades one failure for
another. Checking the boolean turns silence into a 409, but the loser's copy is
already inserted and needs compensation. Delete-first gives exactly-once semantics
but breaks a property the current ordering was written for — "a refused transfer
leaves the source profile intact" — so a cap refusal would lose the profile
entirely.

_Recommendation:_ one transaction around the recipient insert and the source delete.
The loser's conditional delete then matches zero rows inside its own transaction and
rolls its insert back — no duplicate, no loss — and a cap refusal still aborts before
anything commits. Sized in 7n: the service cannot wrap it (it holds a repo, not a
database handle, and `insertWithLimit` opens its own transaction), so it is one new
repo method composing the two existing bodies, touching three files — the Drizzle
repo, the interface plus call site in `services/profiles.ts`, and the single
in-memory test double. No other path changes: `transferProfile` is the only
move-shaped method in the entire server, confirmed by scanning `routes/`,
`services/` and `db/`.

The 7l reproduction becomes its regression test the moment the behaviour is meant to
differ.

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

### 5w. The e2e suite is green — verified at HEAD, and here is how to re-verify it in 45s

**199 passed, 43.4s**, run today against HEAD. Recorded with the command because
the reason this suite rots is not that it is broken — it is that nobody runs it.

    cd apps/server
    DATABASE_URL="postgres://$USER@localhost:5432/driftstack_e2e_a2" \
    REDIS_URL="redis://localhost:6379/9" \
    npx playwright test --config=playwright.config.ts

⚠️ **The Redis index is the whole trick, and it is why this had felt unsafe to
run.** The e2e harness truncates twelve tables and calls `redis.flushdb()`. On the
default index that would wipe whatever another agent has live on this machine —
index 0 had 5 keys belonging to a concurrent writer while this ran. `flushdb`
only clears the SELECTED index, so `/9` makes it inert: index 0 was still at 5
keys afterwards, verified.

⭐ Two things this settles that were previously assumption:

- **The specs ARE type-checked.** `tsconfig.test.json` includes `tests/**/*`, so
  `tests/e2e` is inside the gate's `the-server-source-type-checks` test. A renamed
  export cannot rot them silently — structural drift reds the normal gate.
- **They are NOT executed by it.** `vitest.config.ts` carries
  `exclude: **/tests/e2e/**`, so none of ~30 full-gate runs today ran a single one.
  Semantic drift — a spec asserting behaviour that has since changed — is the gap
  the type-check cannot cover, and only running them closes it.

The suite is self-contained (`startTestServer`, `workers: 1`), so it needs no
docker-compose and no running server; the `test:e2e:setup` docker step in the root
package.json is optional for this path, which is the other reason it looked more
expensive than it is.

### 5w-b. Two webhook delivery implementations, two different SSRF guards

Chasing the e2e loopback spec nearly produced a false alarm, and the shape is
worth recording because anyone reading that spec will hit it.

There are **two** delivery implementations:

- `packages/webhook-delivery` — `InMemoryWebhookDeliveryService.deliverOnce`,
  guarded by `isLiteralUnsafeWebhookHost(url)`, a **string** check on the literal
  host. This is the one the e2e spec's comment describes.
- `apps/server/src/services/webhook-worker.ts` — `WebhookDeliveryWorker`, the one
  **bootstrap actually runs**, guarded by `ssrfGuardedFetch`: a connection-time
  DNS pin through undici that rejects a hostname resolving to a private or
  internal target.

⚠️ Searching the production worker for the string-check name returns **nothing**,
which reads exactly like a missing guard. It is not: the production path uses the
stronger of the two — a literal-host check cannot stop DNS rebinding, and a
connection-time pin can.

Both are covered, measured rather than assumed:

- swapping the worker's default from `ssrfGuardedFetch` to the plain global fetch
  **reds 3 tests**, so the default is protected;
- the worker's drain bounds are covered (5t/`648745f91`);
- the loopback refusal's WIRING is proved by the e2e spec — which is the half the
  vitest gate cannot see, since tests inject `config.fetch` and bypass the
  dispatcher by design.

⭐ That last point is the reason 5w matters. The SSRF wiring proof lives **only**
in the suite the gate never runs, so "e2e is green" is not a nice-to-have here —
it is the only evidence that one specific guarantee holds end to end.

⭐ The honest framing: a green suite that nothing runs is **evidence with an expiry
date**. This entry is dated for that reason, exactly like 5t on the readiness doc —
the number above is true for HEAD today and says nothing about HEAD next week.

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

## 5x — the Anthropic response-size cap was never uncovered (backlog item CLOSED)

`agent-decomposer-claude.ts:857` sat on the open list as UNMEASURED. It is
measured now, and the answer is that it was covered the whole time. Both
enforcement sites already had pre-existing tests, in the same file I was about to
add to:

| mutation                                 | reds                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `:855` streamed byte counter → `false`   | `cancels a chunked body on the first over-cap chunk and does not retry` |
| `:837` declared content-length → `false` | `rejects oversized Content-Length before reading and without retry`     |

Test total stayed 65 under both probes, so neither mutation was a broken
instrument. The pre-existing streamed-body test is also STRONGER than what I
drafted: it asserts `cancellations === 1`, the reader-cancel I had written off as
not worth observing.

The reason I believed it was uncovered is worth keeping, because the measurement
looked conclusive and was not. I grepped for the error CLASS name,
`AnthropicResponseTooLargeError`, and got zero hits across all test roots. That
is true and irrelevant: both tests assert on the message via
`/response body exceeded/i` and never name the class. A guard can be thoroughly
covered by tests that never mention the identifier you searched for — the class
name is an implementation detail, and the assertion surface is the message.

Cost: four redundant test arms written and reverted before commit. The mutation
run is what exposed it, by reddening pre-existing tests I had not accounted for —
a mutation that reds a test you did not write is a prior-art signal, not noise.
Related: the same-day tool `scripts/which-pins-cover.mjs` answers the file-level
version of this question but not the behaviour-level one; grepping the message
text a guard produces would have.

## 5y — mutation ledgers for the record-bound secret-encryption modules

Two modules that seal customer secrets under the tenant master key, measured by
neutralising every `throw new ` one at a time (`throw new ` → `void new `, which
keeps the syntax valid across multi-line call sites) and recording which sites no
test notices. A probe whose test TOTAL differs from the control is invalid, not a
finding; every probe below matched its control.

**`lib/webhook-secret-encryption.ts` — 10 sites, control 7. 7 covered, 3 not.**
One of the three was reachable and is now pinned (an input secret that is not
exact UTF-8). The other two are **structurally unreachable**, both because the
fixed 88-char shape check runs first and pins every downstream size:

- _"ciphertext is not canonical base64"_ — 66 bytes encodes to exactly 88 base64
  chars with no leftover padding bits, so every string that passes the shape
  check round-trips identically. Verified over 200,000 random 88-char samples:
  zero non-canonical, zero wrong-length.
- _"plaintext has the wrong authenticated byte length"_ — the shape check forces a
  66-byte blob, so the ciphertext is 66−12−16 = 38 bytes, and AES-GCM preserves
  length. An authenticated plaintext can only ever be 38 bytes.

Neither can be exercised without first disabling the guard above it. Left alone
deliberately rather than pinned with a test that proves nothing.

**`lib/account-proxy-secret-encryption.ts` — 15 sites, control 52 → 57. Was 7
covered, now 12.** Five reachable encrypt-path refusals had no test: unknown slot,
empty plaintext, OpenVPN secret that is not JSON, a JSON array where an object is
required (`typeof [] === 'object'`, so that is a real branch), and a right-key-set
/ wrong-value-type secret that only the schema check can catch. Each fixture is
valid in every respect except the guard under test. Re-running the same ledger
after the fix flipped exactly those five to COVERED at one test each.

Still unmeasured, and named rather than quietly dropped: the three read-path
guards at `:122`, `:130`, `:153`. They need a forged envelope, and because this
module's base64 is _bounded_ rather than fixed-width, their reachability has to be
settled empirically the way the webhook module's was before a test is written.

### On the instrument itself

The census that found these first reported **403 of 863** sites uncovered by
matching the full source message against the test corpus. Four sampled entries
were four false positives, and the fourth showed why: tests assert a distinctive
FRAGMENT (`.toThrow('accountId must be a UUID')`) of a longer message
(`'Recipe payload accountId must be a UUID.'`). Matching contiguous fragments
instead cut it to 150. Two further blind spots remain and are the reason the
output is split by directory: route-level refusals are frequently asserted by HTTP
status with no message at all, and a message built from a template collapses to a
short static prefix that cannot be fragment-matched. The census is a pre-filter
for where to spend mutation time — mutation is the verdict.

## 5z — the three read-path guards, settled

Follow-up on 5y, which named these rather than dropping them. All three are now
settled empirically, and none of the three was what the ledger's "UNNOTICED"
label suggested.

**`:153` plaintext exceeds its byte bound — UNREACHABLE.** Forging an
authenticated envelope whose plaintext is one byte over the slot bound produces
_"not canonical bounded base64"_, not this message. AES-GCM preserves length, so
a plaintext over the bound means a blob over `maximumBytes`, which the envelope
check rejects first. Same shape as the webhook module's length guard: a size
check upstream pins every size downstream. Left unpinned deliberately.

**`:122` and `:130` — LAYERED, not uncovered.** Neutralising either alone reds
nothing; neutralising BOTH reds the existing payload test. The reason is that the
test asserts `.toThrow()` with no message, so whichever guard survives satisfies
it. "No test notices this line" was literally true and would have been misleading
as "uncovered" — the behaviour is covered, the lines were not individually
attributable.

**The real gap was in that test's name.** It is called
_"rejects noncanonical, truncated, extended and tampered payloads"_ and contains
no non-canonical payload. Its four candidates are a trailing space (a SHAPE
violation), a truncated blob, an extended blob, and a byte-tampered blob — and the
last three are each produced by `Buffer.toString('base64')`, so they are canonical
by construction. Non-canonical base64 — non-zero trailing bits, which decode fine
and re-encode to a different string, meaning one stored secret has several
accepted spellings — was never exercised.

Three arms added, each asserting its own message so it names the guard that
answered: a genuinely non-canonical payload, a payload that clears the 40-char
floor but decodes to 28 bytes (below the 29-byte minimum envelope — the floor is
counted in characters, and padding makes those two different numbers), and an
out-of-alphabet payload that must be refused before any decode. After: `:122`
reds 1, `:130` reds 2, both previously 0. Control 14 throughout.

⭐ Method note: a 0-red site has three possible causes, and they need different
responses — genuinely uncovered (write a test), structurally unreachable (leave
it, record why), or layered behind a sibling with a message-free assertion (add
attribution, not behaviour). Reporting all three as "uncovered" would overstate
the first and hide the third.

### Census calibration, third correction

`profile-key-hierarchy.ts:65` (_"wrapped DEK is not canonical base64"_) was flagged
by the census and is **fully covered** — `profile-key-hierarchy.test.ts:144`
asserts `/canonical base64/` against a payload whose 80-character length is kept
while one base64 character is replaced with `\n`, which Node's permissive decoder
ignores. That test is better than the one I would have written: it also documents
why replacing the final character with `=` was the wrong fixture, since for some
preceding sextets `=` is the canonical encoding of a shorter 59-byte payload and
the fixed-length guard fires first.

The census missed it because the test asserts a TWO-WORD fragment
(`/canonical base64/`) and the matcher's floor is four words — the floor that
exists to stop a generic tail like "is invalid" from matching everything. Lower
it and precision collapses; keep it and short assertions are invisible. That is a
floor, not a bug, and it is the fifth distinct way this census produces a false
positive:

1. full-literal matching vs. fragment assertions (fixed in v2)
2. route refusals asserted by HTTP status, carrying no message
3. template messages collapsing to a short static prefix
4. guards that are structurally unreachable, so nothing CAN cover them
5. asserted fragments shorter than the matcher's floor

Worth keeping as a pre-filter, worth never quoting as a coverage number.

Also settled while checking that cluster: the trailing-bits path in that same
guard is unreachable (60-byte payload → exactly 80 base64 chars, no padding;
100,000 random valid samples produced zero non-canonical). It is reachable only
through characters outside the alphabet, because the length check above it tests
length ALONE with no alphabet regex — unlike the webhook module, where the shape
check carries `/^[A-Za-z0-9+/]{88}$/`. A DEK of 79 valid characters plus one
invalid one decodes to a full 60 bytes and would satisfy a decoded-length check;
only the canonicality round-trip rejects it. That guard is the de-facto alphabet
check on this path.

## 6a — platform-secret payload bound attributed; boot-migration bounds measured and handed to A3

**`lib/platform-secret-value-encryption.ts` — 7 sites, control 18 → 9 in its own
file. 6 covered, 1 attributed.** The payload byte-bound on the decrypt path was
the single unnoticed site, and it is the layered case again rather than an absent
one: the existing truncated/oversized envelope test feeds exactly these payloads
but asserts `.toThrow()` with no message, so neutralising the bound lets the
payload flow on and GCM authentication fails instead. Verified rather than
assumed — with the bound neutralised the thrown message is
`"Unsupported state or unable to authenticate data"`.

That is the trade this repo already refuses in `webhook-secret-encryption`'s
over-long-key arm: a named refusal says which secret and what length; the crypto
error says nothing actionable, and **a truncated column and a wrong key look
identical through it**. Two arms added asserting the byte count at each bound.
Reachable because the v2 envelope check upstream validates the PREFIX only —
everything after it is unbounded, so a truncated row arrives with a two-byte
payload.

### `lib/bootstrap.ts` — the nine boot-migration loops (measured, NOT mine to fix)

Nine value-migrations — webhook signing secrets, platform-secret values, two
LiveKit credentials, MFA TOTP secrets, recipe payloads, agent transcripts, profile
DEKs and account-proxy secrets — each carry the same two guards: _"made no
progress with N rows remaining"_ and _"exceeded the N-row boot bound"_. Together
they stop a boot that either spins forever on a row it cannot convert or runs
unbounded work before listening.

⭐ Checked for the N-places-updated-N−1 shape, since eighteen copies of one rule is
exactly where it appears: **all nine loops carry BOTH guards.** 9/9 paired, no
gap. The rule is complete and consistent; only its test coverage is missing.

Neutralising one reds **nothing** across all four unit importers (69 tests). Note
what that is NOT: the two content-parity pins on this file do not cover the line,
so this is a genuine unit-level gap rather than the parity confound I expected —
worth stating because a parity pin _would_ red on any source mutation and make
every site look covered. The two integration importers skip without
`DATABASE_URL`, so integration coverage is unknown from here, not absent.

They are not testable without a source change: `webhooksRepo` is constructed
inside `bootstrap()` rather than injected, so the loop cannot be driven from a
unit test. The established fix in this repo is extraction — `drainWebhookDeliveries`
is exactly this shape, pulled out of the boot path and bound-tested directly.
`bootstrap.ts` is A3's active area this session, so this is measured and handed to
them on the bus with the precedent, rather than edited underneath them.

## 6b — the migration journal was already guarded; I re-derived it

Surveyed the drizzle migration journal this fire: 113 migrations, 0-112, no
numbering gaps or duplicates, journal and `.sql` files in exact bijection, `idx`
contiguous. Found the `when` timestamps non-monotonic, worked out that drizzle
0.45.2 applies a migration only when `migration.folderMillis` exceeds the newest
recorded `created_at` (`pg-core/dialect.js:62`, with `lastDbMigration` read once
before the loop), concluded that a migration dated below the running maximum is
skipped on an already-migrated database while every fresh-database check stays
green — and wrote a four-arm guard for it.

**`tests/unit/db-migration-journal-when-watermark.test.ts` already existed and is
better.** Five arms to my four: the same forward-looking ascent check, the same
bijection and `idx` contiguity, plus one I did not have — the newest entry must
carry the highest `when`, so appending can never land under the head. Where I
pinned the boundary index, it pins the anomaly SET both ways: 0022-0057 exactly,
so a new violation cannot be absorbed into the allowlist and a future repair that
legitimately shrinks it must say so on purpose. Its diagnosis of the root cause is
sharper than mine too — the watermark is `0021_scheduled_jobs`'s hand-typed
timestamp, not the journal rebuild I assumed.

My file was deleted and the `EXPECTED_TEST_FILES` pin returned to 2731.

⛔ **Why I missed it**: the prior-art search was
`grep -rln "_journal" apps/server/tests | head -5`. The list was longer than five
and the watermark test was past the cut. Same windowing error as the enum reads
earlier today, applied to a prior-art check — where its cost is not a wrong
finding but a day's work rebuilt. **A prior-art grep must never be truncated.**

Two things from the investigation were worth keeping and are recorded here rather
than lost with the file:

1. **The deploy already catches this.** `src/db/migrate.ts` counts rows in
   `drizzle.__drizzle_migrations` after `migrate()` returns and exits 2 when it
   does not equal the journal entry count, with a hint naming "silent-skip from
   drizzle-orm migrator", which fires auto-revert. My first draft of this section
   claimed "the first symptom is a query against a column that does not exist in
   prod"; that was wrong before I found this, and wrong again as a severity claim
   after — the layered defence is CI-time guard plus deploy-time post-condition.
2. **Measuring this needs high-water semantics, not adjacent pairs.** An
   adjacent-pair scan reports ONE inversion; drizzle compares against the running
   maximum, so the real skippable set is 36 entries, 35 of them carrying real SQL.
   The existing guard already uses the correct semantics.

## 6c — the byte-vs-character ceiling on payment-provider responses

Changed how work is picked, after two re-derivations in a day. Instead of
hypothesising a gap and discovering prior art, enumerate the modules the test
corpus does not reference **at all** — a question that cannot be re-derived.

Census over `apps/server/src` and the workspace packages: 52 modules that no test
imports. 49 of those are named somewhere (routes, which integration tests exercise
over HTTP rather than by import — expected, not a gap). **Three are named
nowhere**: `scripts/seed-local-fleet-node.ts` (a dev seed), `lib/hijacked-reply.ts`
and `lib/bounded-response-body.ts`.

`hijacked-reply.ts` turned out to be covered — 8 test files exercise the hijack
concept including a dedicated `every-hijacked-stream-forwards-the-pipeline-headers`,
they just reach it through the routes rather than by filename. Established by an
exhaustive prior-art search BEFORE building anything, which is the fix for the two
re-derivations.

### `lib/bounded-response-body.ts` — a real gap, in the money path

Used by `stripe-api.ts`, `nowpayments-api.ts` and the OAuth client exchange: two
payment providers and an identity provider, none of them under our control. Its
two refusals are covered through those callers — mutating either reds 2 tests. Its
headline documented property was not:

> "The limit is measured in wire bytes, not UTF-16 string length, so multi-byte
> input cannot evade the ceiling."

**Measured before writing anything.** Rewriting the loop to count UTF-16 units
after appending — behaviourally identical for ASCII, which is all the existing
fixtures use — **passed all 46 tests across the three caller suites**. The stated
defence could be deleted and nothing would notice.

It matters because the two counts diverge in the sender's favour: a UTF-8
character costs up to 4 wire bytes and as little as one UTF-16 unit, so a body
counted in string length carries several times the intended bytes. `é` is the
cheapest demonstration at 2:1 — 60 of them are 60 string units and 120 bytes, so a
100-byte ceiling counted wrongly accepts them.

Six arms, and they also pin two behaviours no refusal sweep can ever reach because
neither throws: the empty-body early return (a 204 or HEAD is not a violation) and
the streaming decoder that reassembles a character split across chunk boundaries —
the thing that makes byte-counting safe to combine with text output.

Ledger, control 6: UTF-16 counting reds 1 (the arm that closes the gap), dropping
the decoder's `stream: true` reds 1, neutralising the empty-body return reds 1,
neutralising the declared-content-length refusal reds 1.

⚠️ The empty-body probe first reported 0 red and was a BROKEN probe, not a finding
— the perl pattern did not match the line, so nothing was mutated. Re-run with an
assertion that the substitution applied, it reds correctly. An unverified mutation
that reds nothing is indistinguishable from a real gap; the probe script now
asserts its own anchor.

### Census calibration (this instrument, like the last one, needed correcting)

Two systematic errors in the "no test imports this" check, found by verifying its
output rather than trusting it:

1. **Workspace packages are imported by NAME**, not by file path —
   `import { … } from '@driftstack/api-types'`. The check looked for `/<stem>.js'`,
   so every module under `packages/*/src` reads as un-imported. All the
   `api-types`, `recipe-library` and `behavioural-simulation` entries in the 49
   are false positives.
2. **The path form is not always single-quoted**, so at least one server module
   (`services/oauth-client.ts`, imported by 1 test) was misfiled too.

What survives both corrections and is worth the next pass: **`db/audit-archive-repo.ts`**
— 199 lines, imported by 0 tests, named by 4. That is the shape the admin-accounts
repo had before item 5e: a repo whose SQL nothing executes under vitest, where a
parity pin freezes the text of a query nobody has run. Named here rather than
started, so it is not lost.

### `db/audit-archive-repo.ts` — unwired ON PURPOSE; do not "fix" it

Followed the surviving candidate far enough to be sure, and the answer inverts the
action. `DrizzleArchiveTableRepo` and `DrizzleArchiveLedgerRepo` appear nowhere
outside their own file — nothing in `bootstrap.ts` constructs them, no job type
registers them, and A3's new daily-maintenance sweeps do not include them. The
service above them (`services/audit-archive.ts`) is tested against fakes, and the
`audit_archive_runs` ledger table exists in the schema.

That reads exactly like the webhook-delivery finding from earlier in this session —
"the API enqueues but no prod driver runs it" — and the obvious next move would be
to wire it up.

⛔ **It would be wrong.** `docs/adr/ADR-006-audit-log-retention-export.md` is
**Status: Proposed (pending founder review)**. The policy it describes archives
audit rows to R2 and then **DELETEs them from Postgres** on a monthly sweep across
four audit-shaped tables. Wiring the repo would enact an unapproved retention
policy whose main effect is deleting audit data. The implementation is staged
ahead of the decision, which is a reasonable place for it to sit.

What IS true and worth stating without acting on it: while ADR-006 stays Proposed,
those four tables have no retention at all and grow without bound —
`webhook_deliveries` fastest. That is a decision waiting on review, not a defect to
patch, and it belongs in the review rather than in a commit of mine.

## 6d — six wire serializers that no test would catch a field swap in

File-level census exhausted, so the same definitional question one level down:
which EXPORTED SYMBOLS does the test corpus never name? Scoped to `lib/` and
`services/` deliberately — routes are exercised over HTTP and packages are
imported by name, which is what made those false signals last time.

20 symbols across 11 modules. Two clusters were worth following.

### `lib/loopback-host.ts` — covered, needed nothing

Three unnamed exports, and the module decides whether a destructive script may
run: it backs `db/seed-target-guard.ts`, which stops the dev seed from minting a
full-admin API key in whatever database it was handed, and the e2e harness that
DROPs the public schema of `DATABASE_URL`. Both critical properties turned out
pinned through `assertSeedTarget`:

- `isLoopbackHost` forced to return `true` — every host looks local, the guard can
  never fire: **5 red**.
- the unparseable-URL refusal replaced with `return 'localhost'` — the exact
  "malformed input is the way past every check built on top of this" the module's
  own comment warns about: **1 red**.

Named nowhere, covered thoroughly. A symbol-name census cannot tell those apart;
mutation can.

### `services/harness-control-codec.ts` — six serializers, six gaps

`serializeCookiesRequest`, `serializeSetCookies`, `serializeNavigateHistory`,
`serializeUploadFile`, `serializeListDownloads`, `serializeFetchDownload`. All six
are live, reached through `services/fleet-control-registry.ts`, and all six are
named by no test.

Each builds a wire envelope and re-validates it through its zod schema, so a wrong
`type` literal cannot survive. **What zod cannot see is two same-typed fields
swapped**: `requestId` and `sessionId` are both strings, so a swap yields a
perfectly valid envelope naming the wrong session.

Measured, enumerated rather than generalised from one: swapping those two fields
inside EACH serializer in turn passed all 80 tests across the codec's own file and
`fleet-control-registry`. **Six for six, nothing noticed.**

It fails where CI cannot see. These envelopes go to a fleet node over WSS — a
swapped `sessionId` names a session the harness cannot find, and a swapped
`requestId` breaks the correlation the harness echoes on the reply, so the caller
waits on an id it never sent. The file-control pair carries customer file bytes to
and from the session's upload/download jail.

Six arms pin each envelope field-by-field, with deliberately distinct and
non-interchangeable ids — a fixture that reuses one id for both fields cannot
detect the swap it exists to catch. Re-running the identical probe after: control
80 → 86, all six COVERED at one red each.

⚠️ The `setCookies` fixture failed first because `CookieSchema`'s `sameSite` enum is
`Strict|Lax|None`, the WebKit spelling, not the lowercase form the Set-Cookie
header uses. Worth knowing before writing another cookie fixture.

### Symbol census calibration — low precision here, and why

Of the 20 unreferenced symbols, **6 were real gaps and they were all in one
cluster**. Everything else checked so far was covered through a caller:

- `lib/loopback-host.ts` (3 symbols) — covered via `assertSeedTarget`.
- `services/agent-executor.ts` `consequentialHalt` — the single-use approval
  property is pinned by `agent-executor-control-plane.test.ts`, which runs two
  identical "Buy Now" taps against ONE approval and expects
  `['success', 'confirmation_required']`. It even asserts the caller's approval set
  is unmutated. Nothing to add.

The pattern: this codebase covers behaviour through the caller that uses it, so a
symbol-name search says almost nothing on its own. It found the codec cluster only
because those six are pure envelope builders whose callers' tests never assert the
envelope — the caller exercises the path without checking the payload.

⭐ So the census earns its keep as a **pointer to where mutation is worth spending**,
never as a coverage claim. Three instruments now, all with the same shape: message
census, file census, symbol census — each a pre-filter, each needing mutation to
produce a verdict, and each with a precision problem that only showed up when its
output was checked rather than trusted.

### Measured, needs a decision before a fix: `parseSessionId` accepts a case it cannot resolve

`lib/session-id.ts` parses the customer-supplied `driftstack_session_id`. Its
`UUID_RE` carries the `/i` flag and the function returns the bare uuid
**unchanged** — no `toLowerCase()`. `parseProfileId` mirrors it exactly.

`agent_sessions.id` is `text('id')`, not `uuid`, so the lookup that follows is
**case-sensitive**. Ids are minted lowercase. So an uppercase uuid parses
successfully and then matches no row: the customer gets a 404 for a session that
exists, rather than the clean 400 the parser is there to produce. Clients that
uppercase UUIDs are not exotic.

The sibling surface already disagrees: `AGENT_SESSION_ID_RE` is pinned as
`/^agt_[0-9a-f]{8}-…$/` with **no** `/i`, so the `agt_` family rejects uppercase
outright while the `ses_` family accepts it and then fails to resolve it.

Not fixed here because the fix is a behaviour change to a customer-facing parser
with two defensible directions — normalise with `toLowerCase()` (matching the
"accepts EITHER form" intent), or drop `/i` to reject with a clean 400 (matching
the `agt_` sibling). That is a call to make deliberately, not at the end of a
fire, and it wants the same treatment applied to `parseProfileId` in the same
commit or it becomes the N-places split all over again.

### I shipped a type error last fire, and then misattributed it

`npm run verify` came back **NOT TRUSTWORTHY** with one failure:
`the-server-source-type-checks.test.ts`, the guard that runs `tsc` over the TESTS
because vitest transpiles them without checking. The diagnostic:

```
tests/unit/bounded-response-body.test.ts(41,26): error TS2345:
  Argument of type 'Uint8Array<ArrayBufferLike> | undefined' is not assignable…
```

That is item 6c's own test file, and the line is the one where eslint's `--fix`
stripped a non-null assertion during the commit hook. I noticed the strip at the
time, re-checked with `tsc --noEmit -p tsconfig.json`, and it passed — **because
that is the SOURCE project.** Tests are covered by `tsconfig.test.json`, which I
did not run. So the error shipped in `deaa320f8` and this suite caught it, which
is exactly what it exists for.

Fixed by binding the element before enqueueing rather than asserting non-null. The
assertion form cannot survive here: `noUncheckedIndexedAccess` requires it and
`eslint --fix` removes it on commit, so it type-checks locally and fails in CI
every time.

⛔ **The misattribution is the part worth recording.** While diagnosing, a separate
manual `tsc -p tsconfig.test.json` run of mine hit
`TS6053: File '…/zz-tmp-refute-gui-control-mint.test.ts' not found` — a genuine
transient, another agent's scratch probe appearing and vanishing under the
`tests/**` glob. I took that for the cause, wrote it up as a concurrent-writer
race, and **posted it to A3 on the bus.** It was not the cause; the verify failure
was mine both times, and re-reading the FIRST log showed the same TS2345 sitting
in it all along.

Two lessons, and the second is the one that cost something:

1. `tsc -p tsconfig.json` does not check the tests. After any test edit the project
   to run is `tsconfig.test.json` — and the suite's own type-check guard is the
   authority, not a hand-run tsc.
2. **A plausible transient found while diagnosing is not evidence.** I had a real
   observation and a real failure and connected them without checking that the
   first explained the second — the same shape as an arm that names a line it never
   reached. Re-reading the earlier log took thirty seconds and would have prevented
   a wrong message to another agent.

The `tests/**` glob observation stands on its own and was sent to A3 as a
correction rather than withdrawn: a scratch file under that path really is inside
every other agent's typecheck while it exists. It just did not cause this.

## 6e — a fire of negative results, and an instrument that was lying

No new guards this fire. Five investigations, five dissolved — four of them
correctly, and the fifth because my own tool reported a false gap. The tool fix is
the deliverable.

### The four that were genuinely fine

- **`serializeTrimProfile`** — I named it last fire as a likely seventh instance of
  the envelope gap, on the grounds that only a content-parity pin names it. Wrong:
  swapping `requestId`/`profileId` reds 2 tests in
  `trim-profile-request-correlator` and `profiles-trim-route`. Those two assert the
  serialized envelope; the six I did pin had callers that never asserted the
  payload. That is the actual discriminator, not "named by a parity pin".
- **`parseSessionId` accepting an uppercase uuid** — I published this last fire as a
  404-where-a-400-belongs. **It is not a defect.** I traced it to
  `agent_sessions.id`, which is `text`, but the function's single caller passes its
  output to `driverSessionsRepo.findSession` → `sessions.id`, which is `uuid`.
  Postgres normalises a uuid literal, so an uppercase id resolves fine. Proving the
  key stopped a behaviour change to a customer-facing parser that would have fixed
  nothing. `parseProfileId` is the same shape against a `uuid` column, so the
  "N-places split" I warned about does not exist either.
- **`AGENT_SESSION_ID_RE` defined twice with different flags** — `/i` in
  `agent-sessions-repo.ts:67`, none in `agent-sessions-livekit-token.ts:35`, against
  a case-sensitive `text` PK. Real divergence, harmless: the repo's copy is followed
  by an existence check (`if (c)`), so an uppercase cursor finds no anchor and falls
  through to the first page — exactly what the author documented. The two copies
  differ in flags and converge in behaviour.
- **`scroll.ts`** — 6 of 8, and both remainders legitimate. `:160` is a
  module-load-time self-check on constants that cannot fire today and throws at
  IMPORT if a future edit breaks the ratio, which is louder than a test. `:234`
  (`tickIntervalMs <= 0`) is layered behind the `MIN_TICK_INTERVAL_MS` floor at
  `:243`, since anything <= 0 also fails < 1.

### ⛔ The instrument was producing false gaps

`multi-touch.ts` came back 7 of 8 with `:255` — the per-finger `samples` ceiling —
UNNOTICED. It is not uncovered. Removing it produces:

```
FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap out of memory
```

The guard is holding back a 50,000,000-iteration allocation, and the existing test
(`generatePinchGesture rejects an absurd samples value (the exact repro: 50,000,000)`)
depends on it completely. The ledger misread it because a crashed run prints
`Tests   (28)` with **empty counts** — which matches neither a "failed" check nor a
total-mismatch check, so it fell through to "nothing noticed".

⭐ **A mutation that crashes or hangs the runner reads exactly like an uncovered
site.** The fix detects `heap out of memory` / `FATAL ERROR` / `timed out` and an
empty count, and reports the crash as COVERED — the guard was doing its job. With
it, multi-touch is **8 of 8**.

Blast radius checked rather than assumed: the earlier "unnoticed" verdicts in this
document are all validation guards on bounded inputs — none of those modules
contains an unbounded loop, so neutralising them throws or fails authentication
rather than exhausting memory. Those ledgers stand.

⚠️ Two further self-inflicted errors while chasing this, both from a filter rather
than the code: a `-t "pinch"` run matched a different test because the real title
capitalises `generatePinchGesture`, and a ledger run against
`tests/unit/multi-touch.test.ts` produced an EMPTY control and a uniform
all-UNNOTICED column because this package keeps that file at `tests/`. The empty
control line is what caught the second one — a ledger without a printed control is
not evidence.

## 6f — unbounded metric label cardinality, enforced instead of merely documented

Yesterday's instrument fix pointed at a class rather than a file: my ledger had
been blind to guards whose removal exhausts memory, which made allocation and DoS
bounds the LEAST reliably measured and the most consequential in production — an
OOM is an outage, not a 400. So this fire swept that class deliberately.

Census of input-driven allocations and loops: 34 modules, 16 carrying a `MAX_`
bound and 18 carrying none. Three of the unbounded ones were worth following, and
two of them needed nothing:

- **`sdk-typescript/src/pagination.ts`** — a bare `while (true)` auto-paginator.
  Already guarded both ways: `next_cursor === null` returns, and a repeated cursor
  throws rather than spinning. Covered — and the ledger classified it correctly
  only because of yesterday's fix, since removing that guard **hangs the runner**.
  A real case validating the repair.
- **`sdk-typescript/src/webhook-signature.ts`** — 8 allocation/loop sites and no
  bound, but each is proportional to input the caller already holds, so there is no
  new exposure. Its security-relevant property is the constant-time compare, and
  that IS pinned: `constantTimeHexEq` is named by 4 tests and the XOR-accumulate
  shape (`diff |=`) is structurally pinned, against a convention established in 37
  files.

### `services/metrics-registry.ts` — the real one

The registry states the rule in its own header: callers MUST keep label values
bounded, and `account_id` / `session_id` WILL blow up the scrape. It deliberately
does not enforce this at runtime, with a reason given — enforcement would punish
legitimate dynamic label use.

⛔ That comment is already pinned by `services-metrics-registry-content-parity`,
and pinning a comment freezes what a file SAYS, never whether it is true. Nothing
checked the registration sites. The convention holds today — all 16 label keys in
use across 22 registrations are enum-shaped — so this is a guard against drift,
not a live defect.

Why it earns a guard: the registry keys each series by a composite of its label
VALUES in a `Map` that is never evicted. An enum-shaped label costs a bounded
number of entries forever; one per-account label costs an entry per account for
the life of the process. The failure is not a wrong number, it is memory that
climbs until restart and a scrape that grows with the customer base — silent until
it is an outage, and invisible to every functional test.

Three arms: an anti-vacuity floor (a scan that silently stops matching would
otherwise pass everything), the identifier-shaped-key refusal, and an exact roster
of the 16 keys so adding one is a visible decision. Ledger, control 3: a
registration labelled `account_id` reds 2; a regex that matches nothing reds 2,
including the anti-vacuity arm that exists for exactly that.

⚠️ `prefix` looked like a violation and is not — it is the audit ACTION prefix
(`session.`, `api_key.`), bounded by the action taxonomy, not a per-key prefix.
Checked before writing a rule that would have blessed a real offender by name.

⚠️ Restoring a mutated NEW test file needs a scratchpad snapshot: `git checkout --`
fails on an untracked path, so the broken-regex probe survived its own cleanup
until I noticed and put the line back by hand.

### The rest of the sweep, checked and dismissed with evidence

- **`webrtc-streaming/src/frame-source.ts`** — allocates `targetWidth * targetHeight * 4`
  with no bound in the file, which reads like a straightforward DoS. It is not
  reachable: `targetWidth` appears only in `mock-codec-wrapper.ts` with a default of
  390, and **no file under `apps/server/src` imports the package at all**. Staged
  ahead of integration, like the audit-archive repo. Worth re-checking the day it
  is wired, since the allocation is exactly the shape that needs a ceiling then.
- **`lib/livekit-token.ts`** — a census false positive; the buffer is a fixed 16
  bytes and my loop pattern matched `bytes.length`. Its `Math.random()` fallback for
  `randomJti()` is unreachable on Node 20+ (`globalThis.crypto` always exists), and
  the jti is not a security control here — the token's integrity is its HMAC, and
  the code says jtis are not reused server-side.

Net for the class: 34 modules with an input-driven allocation or loop, and after
following every candidate the only actionable one was the metrics label roster —
a drift guard, not a live defect. The class that was least reliably measured turns
out to be in good shape; that is worth knowing precisely rather than assuming in
either direction.

## 6g — every mutation ledger this session ran with 80 test files switched off

The largest instrument defect yet, and `verify-suite` had been printing it after
every run:

> NOTE — 80 test file(s) were collected but never executed. Most gate on
> DATABASE_URL; set it to the local Postgres to run them.

I read that as a note about SUITE completeness and never applied it to my own
ledgers. Every "**_ UNNOTICED _**" verdict in this document was produced with
those 80 files skipped, so any of them could have been covered by an integration
test that never ran.

### How it surfaced

Chasing a different lead — lease ownership on `scheduled_jobs`. Three
ownership-sensitive mutations (`markComplete`, `markRetry`, `markFailed`) each
scope their UPDATE with `eq(scheduledJobs.lockedBy, workerId)`, and the existing
cross-source invariant pins what each method SETS but not that predicate.
Removing it from `markComplete` left the unit and invariant tests **fully green
(22 passed)**; only the content-parity pin reddened, and only because the source
TEXT changed.

That looked exactly like a real gap — a duplicate-execution hazard on a chain that
sends webhooks and runs retention purges — guarded by nothing but a text pin.

It is not. `db-scheduled-jobs-repo-drizzle.test.ts` contains
_"a settle from a worker that no longer holds the lock is rejected (fenced on
locked_by)"_, and with `DATABASE_URL` set the same mutation reds it. The predicate
is behaviourally covered; my measurement had the covering test switched off.

⭐ A local Postgres was running the whole time, with `driftstack_e2e_a2` already
present from earlier e2e work. The cost of the blind spot was zero setup — just
`DATABASE_URL=postgres://localhost:5432/driftstack_e2e_a2`.

### Re-verifying the committed conclusions rather than assuming they survive

Both sets of arms committed earlier were re-measured against their integration
importers with the database available:

| pinned earlier                                          | integration test alone, under the same mutations        |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `account-proxy-secret-encryption` — 5 encrypt-path arms | control 4 passed; all five mutations **still 4 passed** |
| `webhook-secret-encryption` — the exact-UTF-8 arm       | control 13 passed; mutation **still 13 passed**         |

Neither is covered by an integration test, so both sets were genuinely additive
and those conclusions stand. Checked rather than assumed, because the whole point
of this entry is that I had been assuming.

### The rule

A mutation ledger must run with `DATABASE_URL` set whenever the module under test
has ANY importer under `tests/integration/`. Enumerate importers first — the
skipped ones are exactly the ones a local run hides.

### Also swept clean this fire

Time-unit handling in expiry/TTL arithmetic — the classic seconds-vs-milliseconds
bug where a token never expires. Every seconds-named constant meeting a
millisecond clock is explicitly `* 1000`; no `_MS` constant is treated as seconds;
no `exp`/`expires_at` field takes a raw `Date.now()`. The three lines my heuristic
flagged were the correct conversions themselves.

### What the DB-enabled run immediately caught

The first `npm run verify` with `DATABASE_URL` set executed **2734 files with 2
skipped instead of 80** — 375 tests that had never run in any local verification
of mine — and came back NOT TRUSTWORTHY on one file:

```
marketing-site: built 2026-08-15T21:35:08Z but source changed 2026-08-15T21:40:28Z
  — REBUILD, do not repin assertions onto stale
```

Not a DATABASE_URL-gated test and not my change: `about.astro` was committed eight
minutes earlier by another agent (`df2ad92d3`) without rebuilding, so
`dist-reading-suites-have-fresh-artifacts` fired exactly as designed. `dist/` is
gitignored, so the fix is local and produces no commit, and the guard states the
remedy itself. Rebuilt (68 pages, 2.9s) and the guard is green.

⭐ Two things worth keeping from that: the repo has a guard for _stale build
artifacts feeding assertions_, which is the failure mode where a test "passes"
against a page that no longer exists — and it caught a real one within minutes of
the source landing. And the reason I saw it at all is that a committed change from
another agent had shifted the tree since my last verify; a green from ten minutes
ago is not a green now.

## 6h — the profile tenant boundary was proven only against a fake

First real use of the capability unlocked last fire. SQL-level tenant predicates
live in integration tests that skip without `DATABASE_URL`, so until now this
surface was not measurable locally at all.

`profiles-repo.ts` carries **20** `eq(profiles.accountId, …)` predicates. The
service does not re-check ownership — `ProfilesService.get` is
`const row = await this.repo.findById(args); if (row === null) throw NotFound` —
so those WHERE clauses ARE the isolation boundary, not a second line behind one.

### What the ledger showed

Neutralising each predicate in turn, with the database available:

| detector                                                                 | result                                  |
| ------------------------------------------------------------------------ | --------------------------------------- |
| `cross-account-profile-isolation` (routes)                               | **all 20 unnoticed**                    |
| `db-profiles-repo-keyset` + `restore-quota`                              | 4 covered (the LIST predicates), 16 not |
| `in-use-concurrency`, `terminated-account-purge`, `snapshot-restore-dek` | fetch-by-id still unnoticed             |

⛔ The route-level isolation test drives `buildTestApp`, which wires **InMemory**
repos. It proves the RULE against a double that re-implements the same filtering
by hand, and executes none of the shipped SQL. The uniform all-20 column was not a
broken instrument — it was a detector pointed at code the test never loads, which
is a fourth way a ledger can lie and the one hardest to tell from the others.

So: the list path is covered on real Postgres, and the single-row paths —
`findById`, `update`, `recordSave` — were covered by nothing that runs real SQL. A
refactor rewriting one WHERE clause could hand account A account B's profile, the
cookies and storage of somebody else's browser session, with a fully green suite.

### The guard

One integration test on the shipped `DrizzleProfilesRepo` against real Postgres,
two seeded accounts:

- **read** — a stranger's `findById` returns null, with an owner-side positive
  control first so the arm cannot pass because the fixture was invisible;
- **write** — a stranger's `update` rejects, AND the row is read back as the owner
  to prove the UPDATE did not land before failing to return;
- **silent path** — `recordSave` returns void, so a wrong-account call cannot be
  caught by a return value; the columns are read back directly, then the owner's
  call is asserted to succeed so the arm is a boundary and not a broken call.

Ledger: `findById`, `update` and `recordSave` predicates each red it; before, none
of the three reddened anything anywhere.

It carries the same CI contract as its siblings — quiet skip locally, hard failure
in CI if the database is unreachable. A vacuous pass on a tenant-isolation test is
worse than no test: it reports the boundary as proven when nothing ran.

### Still open, named rather than dropped

16 predicates in this repo remain unexercised by real SQL — trash/restore,
rename-on-restore, snapshot and quota paths among them. The three closed here are
the ones the customer-facing read/write path depends on. The same question applies
to `sessions-repo` (15 predicates) and `mfa-repo` (14), neither swept yet.

## 6i — the session tenant boundary had no real-SQL coverage at all

Second of the three repos named at the end of 6h, and worse than profiles:
**nothing in the suite constructed `DrizzleSessionRepo`**, so not one line of the
shipped session SQL had ever executed under vitest.

`SessionsService` fetches with `repo.findSession(sessionId, accountId)` and throws
NotFound purely on a null row — no independent ownership re-check — so the
`eq(sessions.accountId, …)` predicate is the boundary, exactly as in profiles.

### Measured before building

Neutralising the `findSession` predicate:

| detector                                                             | result                       |
| -------------------------------------------------------------------- | ---------------------------- |
| route + service tests (`account-web-sessions`, `sessions-lifecycle`) | **8 passed — unnoticed**     |
| `db-sessions-repo-content-parity` + `-cross-source-invariant`        | 2 red — **source TEXT only** |

The behavioural tests run against InMemory repos; the only thing that noticed was
a pin on the characters in the file. A rewritten WHERE clause could hand account A
account B's live browser session — its proxy configuration, archetype and the key
material it was launched with — past a fully green suite.

### The guard

One integration test on the shipped repo against real Postgres, two seeded
accounts (plus the `api_keys` row the FK requires), covering three DIFFERENT
failure shapes rather than three variations of one:

- **read** — `findSession` returns null for a stranger, owner-side positive control first;
- **control** — `claimSessionOperation` returns `not_found`; that lock is how a
  session is started, stopped and driven, so a stranger taking it is control of
  someone else's browser, not merely a read;
- **silent** — `touchSessionLastStateAt` returns void, so the column is read back
  directly, then the owner's identical call is asserted to succeed so the arm is a
  boundary and not a broken call.

Ledger: the `findSession`, `claimSessionOperation` and `touchSessionLastStateAt`
predicates each red it; before, none of the three reddened any behavioural test.

⚠️ Two fixture errors caught by running it rather than reasoning: the export is
`DrizzleSessionRepo`, not `DrizzleSessionsRepo` (the file is plural, the class is
not), and `session_status` has no `active` — it is
`creating|ready|busy|destroyed|errored`. Both would have been invisible in a test
that never ran against a real database, which is the condition this whole entry is
about.

### Noted, not a defect

`findSessionUnscoped` — deliberately account-unscoped, documented "admin
force-actions only" and pinned by three parity/invariant tests — currently has **no
caller anywhere in `src`**. It is not customer-reachable today. Worth knowing it
exists: it is the one method in this repo that returns another account's session by
construction, so it wants a scoped caller and a test the day something calls it.

### Still open

`mfa-repo` (14 predicates) is the last of the three named in 6h, and 16 predicates
in `profiles-repo` remain unexercised by real SQL.

## 6j — the recovery-code candidate set is the MFA boundary, and it was unproven

Third and last of the repos named in 6h. `mfa-repo` is in better shape than the
other two — three integration tests construct the Drizzle repo, and most of its
methods key on `accountId` alone rather than on a resource id, so they are not
IDOR-shaped at all. Two findings, one of which needed no fix.

### Checked and safe: the unscoped consume

`markRecoveryCodeUsed(id, now)` updates by id with NO account predicate, which is
the exact shape that has been a real defect elsewhere in this document. It is safe
here, and the reason is worth writing down: its caller obtains the id from
`listUnusedRecoveryCodes(args.accountId)`, so provenance is already scoped, and
the predicate it does carry — `isNull(usedAt)` — is what makes the consume atomic
so a code can never be spent twice. Verified by reading the caller, not assumed
from the signature.

### The gap

That makes the CANDIDATE SET the entire authorisation boundary for recovery-code
login. `MfaService.verify` scrypt-checks the submitted code against every row the
query returns, and the unscoped consume then inherits its safety from that same
query.

Neutralising the account predicate in `listUnusedRecoveryCodes` left the MFA
credential-issuance and enrollment-session-authority integration tests **green at
12 passed**. The sibling predicate in `findByAccount` IS covered — one red — so
this was a specific hole rather than an untested module.

⛔ The consequence is a change of kind, not degree. Without that predicate the
verify loop compares the submitted code against **every account's** unused codes,
which turns "guess this account's recovery code" into "guess any live recovery
code in the system" — and the unscoped consume then spends the stranger's row.

### The guard

One integration test on the shipped `DrizzleMfaRepo` against real Postgres: two
accounts, the owner holding one unused and one already-spent code, the stranger
holding one. It asserts the owner's own code IS a candidate first (a positive
control, since every other assertion also passes on a query returning nothing),
that the stranger's is not, that the spent one is not, that the set is EXACTLY the
one row rather than a superset, and that the stranger sees exactly their own — so
the arms are a boundary rather than a query that returns one row for everybody.

Ledger: dropping the account predicate reds it; dropping the `isNull(usedAt)`
filter in the same WHERE reds it. Before, neither reddened any behavioural test.

### Sweep complete

All three repos named in 6h are now closed at their customer-facing read/write
paths: profiles (`db5bae456`), sessions (`56801c354`), MFA recovery codes here.
Still open and named rather than dropped: 16 predicates in `profiles-repo`
(trash/restore, rename, snapshot, quota) remain unexercised by real SQL.

## 6k — the key envelope and the destructive paths, and a restore gated by a pair

Continues 6h's open list. Rather than pin all sixteen remaining predicates, mapped
each to its method and took the three whose consequence is different in KIND from
"a row leaks":

- **`getWrappedDek`** — everything else here leaks a row; this one leaks the
  wrapping of the material that decrypts it.
- **`delete`** — a soft-delete of somebody else's profile is data loss for another
  customer, caused by a caller who never owned the row.
- **`restore`** — the inverse write, and the only one that also resolves a NAME
  against the account.

Added to the existing tenant-scope file rather than a new one, so the related arms
sit together and the file-count pin does not move.

### Ledger

| predicate                              | result                                 |
| -------------------------------------- | -------------------------------------- |
| `getWrappedDek` `:279`                 | **COVERED** — single-line attributable |
| `delete` `:373`                        | **COVERED** — single-line attributable |
| `restore` `:433` (select gate) alone   | not attributable                       |
| `restore` `:496` (update gate) alone   | not attributable                       |
| `restore` `:433` + `:496` **together** | **COVERED**                            |

⭐ Restore is a LAYERED PAIR, and following that through was the useful part.
Removing the select gate lets the transaction find another account's trashed row —
but the UPDATE is still scoped, matches zero rows, and the method still answers
`not_found`. Removing only the UPDATE gate leaves the select blocking. Neither
single mutation changes anything observable, which is the correct shape for a
two-gate transaction and NOT a coverage hole: mutating both together reds the arm.

⚠️ Two of the four restore predicates are not gates at all, and assuming they were
would have produced a wrong finding. `:444` is the name-conflict lookup and `:473`
is the quota sum — removing either changes behaviour only when a name actually
collides or a quota is actually exceeded. I checked what each line was before
concluding anything about the ones that did not red.

The delete arm asserts the boolean AND reads `deleted_at` back, because checking
only the return value would miss a soft-delete that landed and then reported
nothing. Each destructive arm is followed by the owner performing the same call
successfully, so every refusal is demonstrably a boundary rather than a broken
call.

### Where the sweep stands

All three repos closed at their customer-facing read, write, destructive and
key-material paths. What remains in `profiles-repo` is the genuinely lower-consequence
tail — `countByAccount`, `listTrashed`, `findByAccountAndName`, `touch`, the list
cursor anchor, and the cross-account-by-design `migrateWrappedDekEnvelopes` — plus
`purgeTrashed`, which is worth a look on its own the next time this file is opened.

## 6l — the only unrecoverable delete in the repo, and why it had no coverage

`purgeTrashedBefore(cutoff)` is the retention sweep: the one HARD delete in
`profiles-repo`, and the one method with no account scope at all — by design. Its
entire safety is two predicates:

```ts
.where(and(isNotNull(profiles.deletedAt), lt(profiles.deletedAt, cutoff)))
```

Lose the second and every trashed profile for every customer is destroyed on the
next sweep regardless of age. Everywhere else in this sweep a wrong WHERE clause
leaks or blocks; here there is no soft-delete to reverse and no recycle bin left to
restore from.

### Why the absence of coverage was RIGHT

Four unit tests name the method, all against an in-memory repo that re-implements
the filter by hand. No integration test touched it — and
`global-scope-db-tests-are-isolated` explains why: it forbids a real-Postgres test
from calling a global operation on the SHARED database, because a whole-table
delete's behaviour depends on rows owned by whatever else is running. That guard
derives its roster from the sources, asserts the roster is non-empty and that it
sees real integration files, then requires zero offenders.

So this was a policy, not an oversight — and the policy has its own sanctioned
escape hatch. `ensureIsolatedDatabase` exists precisely for a sweeping file, and
the meta-guard skips any file that uses it. This test takes its own database, so
the sweep sees only rows it created and the property holds by construction.
Confirmed the meta-guard still passes with the new file present (3 passed).

### The guard

One account; a live profile, trash dated before the cutoff, trash dated after it.
The purge must return EXACTLY the stale id — a superset would satisfy `toContain`
while being the whole failure mode — and afterwards the live row and the fresh
trash must both still exist.

Ledger: dropping the age bound reds it. Dropping `isNotNull` does NOT, and that is
not a gap: `NULL < cutoff` is NULL in SQL, so a live profile never matches the age
comparison anyway. The probe proved it empirically rather than by argument — with
`isNotNull` removed the live profile still survived.

### Sweep closed

Every destructive, key-material and customer-facing read/write path across
`profiles`, `sessions` and MFA recovery codes is now proven against real SQL. What
remains in `profiles-repo` is the low-consequence tail: `countByAccount`,
`listTrashed`, `findByAccountAndName`, `touch`, the list cursor anchor, and
`migrateWrappedDekEnvelopes` — which is cross-account by design and already covered
by its own isolated-database test.

## 6m — the OAuth prune, and a probe that manufactured false POSITIVES

Continued the class rather than the file: the retention purge in 6l was one of a
roster. Narrowing "global operation" to its dangerous shape — a DELETE bounded
only by time, with no id and no account scope — gives five methods across the db
layer. Two already have real-SQL coverage (`deleteStaleAuthTokens`,
`pruneOlderThan`), `purgeTrashedBefore` was closed in 6l, and `pruneFinished` is
safe by construction (its `isNotNull` + `lt` pairs mean it can only ever match
terminal rows). That leaves `oauth-store.pruneExpired`.

It deletes from THREE tables in one transaction, each guarded by exactly one time
predicate and nothing else — authorizations and codes on `createdAt < now − TTL`,
access tokens on `expiresAt <= now`. Lose any one and that table is emptied. The
token row is the one that hurts: every OAuth-authenticated customer's credential
disappears and every integration built on it breaks until they re-authorise.

Coverage before this: three unit tests, all against the in-memory store that
re-implements the comparison by hand. Isolated via `ensureIsolatedDatabase`, per
the same policy that governed 6l.

### ⛔ The instrument produced FALSE POSITIVES — the reverse of every previous one

The first ledger reported all three predicates COVERED. They were not. My probe
substituted `` sql`true` `` and **`oauth-store.ts` never imports `sql`**, so every
run failed with `ReferenceError: sql is not defined` — a red that had nothing to do
with the guard. Three green-looking "COVERED" verdicts, all worthless.

Every previous instrument defect this week made a covered thing look uncovered.
This one made an uncovered thing look covered, which is strictly more dangerous:
a false negative costs a wasted investigation, a false positive closes a gap that
is still open.

⭐ It surfaced only because I could not explain ONE of the three reds. The codes
predicate reddened despite my fixtures containing no code rows, and a red I cannot
account for deserves the same scrutiny as an unexplained green.

Re-run with a tautology built from an import the module actually has
(`eq(col, col)`): authorizations RED, access tokens RED, **codes GREEN** — genuinely
uncovered, exactly as the unexplained result had hinted. Added a code fixture; the
re-run is 3 of 3 with a valid probe.

### The guard

Fixtures straddle each boundary rather than sitting far from it — a token one
second past expiry and one a day short, an authorization and a code an hour stale
against ones created at `now`. A sweep that deletes everything and a sweep that
deletes nothing both pass a test whose fixtures all sit on one side.

It also asserts the backing `api_keys` row OUTLIVES its deleted token, since the
source deliberately keeps it as an expired actor identity for session and audit FK
integrity — leaving that untested would leave the transaction's blast radius
unmeasured.

⚠️ Four fixture rejections found by running it: a `^[0-9a-f]{64}$` check on both
hash columns, the `api_key_scope` enum being `read:sessions` rather than
`sessions:read`, a globally-unique `key_prefix` that collides on the second run
because the isolated database persists, and the same for the hash primary keys.
Every one is invisible to a test that never reaches Postgres.

⚠️ And the tests-typecheck guard caught this file too, for a reason worth
recording: `client` is a module-level `let`, so the `if (!client) return` narrowing
does NOT propagate into arrow-function helpers that close over it — four
`TS2349: This expression is not callable`. The sibling tenant-scope files avoided
it only because they call the client inline in the test body rather than through
helpers. Fixed by binding a non-null local after the guard. Second time this week
that a vitest-green file failed `tsconfig.test.json`; the suite's own type-check
test is the authority, not a hand-run `tsc -p tsconfig.json` on the source project.

## 6n — auditing my own ledgers after the false-positive probe, and closing the class

### The audit came first

Last entry's defect was a probe inserting `` sql`true` `` into a module that never
imports `sql`. The obvious next question is which of MY OWN ledgers used that
substitution against a module lacking the import — because those verdicts would be
worthless in the same way.

Checked all four ledgered modules. `profiles-repo`, `mfa-repo` and
`scheduled-jobs-repo` import `sql`; **`sessions-repo` does not**. So the mutation
proof published with the sessions tenant-scope guard (`56801c354`) — "all three
predicates red it" — was invalid: each red was a `ReferenceError`, not the guard
being caught.

Re-measured with a tautology built from an import that module has
(`eq(sessions.id, sessions.id)`): `findSession`, `claimSessionOperation` and
`touchSessionLastStateAt` each red the guard. **The guard is sound and the
conclusion stands — the evidence I published for it did not.** Blast radius is
exactly one commit; the other three ledgers were valid.

⭐ Worth stating plainly: a correct conclusion reached through an invalid proof is
still a reporting failure. The measurement is the product, not the verdict.

### `pruneFinished` — argued, then measured

The last member of the global-DELETE class. I had recorded it as "safe by
construction": its `IS NOT NULL` pairs mean a PENDING row can never match, so
losing an age bound only widens the delete within already-terminal rows. That is an
argument, and arguments about SQL null semantics are what half of this week's
instrument failures were made of.

What it protects is not history. `scheduled_jobs` is the self-arming chain table —
deleting a PENDING row kills the chain, which never runs again and never re-arms,
the exact dead-chain state the liveness gauge exists to detect. Retention purges,
reminder sweeps and reconciliation jobs all live there.

Ledger, isolated database, one row per branch:

| mutation                     | result                                               |
| ---------------------------- | ---------------------------------------------------- |
| `lt(completedAt, olderThan)` | **RED** — load-bearing                               |
| `lt(failedAt, olderThan)`    | **RED** — load-bearing                               |
| `isNotNull(completedAt)`     | GREEN — **provably redundant**, as the argument said |

The `isNotNull` green is the argument confirmed rather than a gap: `NULL < cutoff`
is NULL, so a pending row cannot match the age comparison either way.

⚠️ The fresh-FAILED fixture was added after noticing its absence would leave the
second disjunct's age bound unmeasurable — a ledger would have reported it covered
when the fixture simply could not tell. Same completeness lesson as the OAuth codes
row one entry earlier, and the second time in two fires that a per-branch fixture
was the difference between a real verdict and a flattering one.

### Class closed

All five global time-bounded deletes now have real-SQL coverage or a proven reason
they need none: `purgeTrashedBefore`, `pruneExpired` (3 tables), `pruneFinished`,
plus `deleteStaleAuthTokens` and `pruneOlderThan` which already had it.

## 6o — the Stripe replay guard was asserted against a hand-written double

New axis this fire: money-path idempotency at the SQL level. The earlier
money-surface pass predates the `DATABASE_URL` unlock, so nothing there had been
measured against Postgres.

### What the analysis found first — a design that holds

`StripeWebhooksService.handle` dedupes in two steps: a `hasEvent` short-circuit,
and for the race where two deliveries both pass it, an `INSERT … ON CONFLICT DO
NOTHING` whose `inserted` flag decides which delivery owns the event.

⚠️ Worth being precise about what that race protection does and does not do:
`dispatch(event)` runs BEFORE the insert, so under a true race BOTH deliveries
execute the side effects and only the reported outcome is deduped. That is safe
here, and it is safe for a specific reason rather than by luck — every handler is
an upsert or a set (`upsertSubscription`, `setAccountTier`,
`activateCryptoEntitlement` under a row lock with documented lock ordering), and
there is **no additive write anywhere in the Stripe or crypto path**. Checked
explicitly, because "runs twice" is only harmless while that stays true. An
additive credit added to this path later would turn a documented race into a
double-credit.

### The gap

The idempotency is exercised — duplicate path and race — but only through
`buildTestApp`, which wires an **InMemory** repo that re-implements
`onConflictDoNothing` by hand. The shipped statement had never executed under
test, against a real primary key.

The failure that leaves is loud in the wrong place: change the conflict clause or
its target and a duplicate delivery RAISES a unique violation instead of returning
`inserted: false`. Stripe sees a 500, retries on its own schedule, and the event is
never marked processed — a retry loop on an event that can never complete.

### The guard

Real repo, real Postgres. First delivery inserts; the replay carries a DIFFERENT
payload hash and result on purpose, since the conflict target is the event id alone
and a duplicate must be rejected on identity rather than on the row happening to
match. Then it asserts the stored row still holds the FIRST delivery's outcome, and
that exactly one row survives.

Ledger: dropping the conflict clause reds with
`duplicate key value violates unique constraint "processed_stripe_events_pkey"` —
the production failure exactly. Switching `DO NOTHING` to `DO UPDATE` also reds:
the returning shape changes so the `inserted` flag flips, and the stored-row
assertions independently catch the overwrite, which is what would catch an upsert
variant that left the flag alone.

Not isolated, deliberately — a two-row insert keyed by a random event id is not a
whole-table sweep, so it does not fall under the global-operation rule that governs
the purge tests.

⚠️ The tests-typecheck guard caught this file too — **third time this week**, and
this one was an inconsistency inside a single file: `const [{ count }] = …`
destructures an index access, which `noUncheckedIndexedAccess` types as
possibly-undefined, while the same file already used the safe `const [row] = …;
row?.field` form three lines earlier. The rule is now explicit rather than
habitual: in a test that queries Postgres, never destructure an array index —
index it and use optional chaining. vitest runs the unsafe form happily, so only
`tsconfig.test.json` says otherwise.

## 6p — enforcing the condition the Stripe race safety rests on

6o established that the accepted race in `StripeWebhooksService.handle` is safe for
a reason rather than by luck: `dispatch(event)` runs BEFORE the idempotency insert,
so a concurrent delivery executes every handler twice, and that is harmless only
while each handler is an upsert or a set. Measured then: eleven write statements
across the two files, seven `.set(` calls, **zero additive writes**.

The property is conditional and nothing enforced the condition. Add one
`balance = balance + delta` to a handler and the documented, accepted race becomes
a double-credit — **with the SQL idempotency test from 6o still green**, because
that test asserts the `inserted` flag, not the arithmetic.

### The guard

Three arms, and the middle one is the point:

1. **The detector detects.** A regex that matched nothing would pass forever. Both
   directions asserted: it catches `sql`${col} + …``and`+=`, and ignores an
ordinary `.set({ tier })` and plain string concatenation.
2. **The scan reaches real files with real writes**, so "clean" means checked
   rather than not looked — floors below the measured counts.
3. **No additive write on the path.**

Ledger: introducing `sql`${accounts.balanceMinutes} + ${args.termDays}`` into the
repo reds arm 3. Neutering the regex reds arm 1 — ⭐ and leaves arm 3 GREEN, which
is exactly why arm 1 exists. A property guard whose detector has rotted reports
the property as holding.

The pattern matches the SHAPE of accumulation rather than any particular column, so
a new balance-like field is covered the day it appears rather than the day someone
remembers to add it here.

Scope is the Stripe dispatch path only — `services/stripe-webhooks.ts` and
`db/stripe-webhooks-repo.ts`. The NowPayments/crypto IPN path has its own
idempotency and its own race analysis; asserting over it here would make this guard
claim a property it has not established.

⚠️ The commit hook rejected the first attempt: `[+\-]` inside a character class is
an unnecessary escape (`no-useless-escape`), and lint-staged reverted cleanly so
nothing partial landed. Behaviour-identical fix to `[+-]`, then the detector arm
re-run — which is the arm that would have caught it if the change had NOT been
behaviour-neutral. Worth noting that the pre-commit hook and the tests-typecheck
guard have now each caught something in the last three commits; between them they
are doing more real work than a second pair of eyes would.

## 6q — verifying my own scoping claim, and racing the crypto lock for real

6p scoped the additive-write guard to Stripe with the line "the NowPayments/crypto
IPN path has its own idempotency and its own race analysis". That was an assertion
I had not checked. Checking it was this fire's first slice.

**The claim holds.** The crypto path's idempotency is a different mechanism, and it
has to be: an IPN carries no unique event identity, so there is nothing to key an
ON CONFLICT on. Instead `applyIpnStatus` runs inside
`withOrderLock(orderId, …)` — `select … .for('update')` in a transaction — and
decides the transition against the LOCKED committed row. The source names the
defect it fixed: _"Previously the read-modify-write was unlocked: two same-order
IPNs both read pre-paid, both upserted, both fired the webhook + receipt email."_

### The gap

The only test that races two `applyIpnStatus` calls is a UNIT test against the
in-memory repo. That cannot establish this property at all — JavaScript is
single-threaded, so an in-memory "lock" is trivially exclusive and the test passes
identically with `.for('update')` deleted. Two integration files name
`withOrderLock`; neither runs anything concurrently.

### The guard, and the trap it had to avoid

⚠️ A `postgres()` client with `max: 1` serialises the two calls **in the connection
pool**, so the assertions would hold with no row lock at all — a green proving the
pool works. This test therefore uses two independent clients, and its first arm
asserts they are distinct backends (`pg_backend_pid()` differ) BEFORE the race arm
runs. Without that arm the whole file could quietly degrade into a pool test.

Each side reports the status it observed under its own lock: the winner sees
`pending` and commits `paid`; the loser must then observe `paid`.

Ledger — and this is the clearest mutation result of the session, because it
reproduces the historical bug verbatim rather than merely failing:

```
.for('update') removed →
  expected [ 'pending', 'pending' ] to deeply equal [ 'paid', 'pending' ]
```

Both sides read the pre-paid row. That is the source comment's sentence, executed.

### Money-path idempotency now stands on measured ground

| path            | mechanism                                         | proven against               |
| --------------- | ------------------------------------------------- | ---------------------------- |
| Stripe          | `INSERT … ON CONFLICT DO NOTHING` on the event id | real SQL (`9f3745a2a`)       |
| Stripe handlers | no additive write — the race's precondition       | enforced guard (`db3d747d8`) |
| Crypto IPN      | `SELECT … FOR UPDATE` on the order row            | real concurrency, here       |

## 6r — a concurrency test serialised by its own connection pool, and a claim I could not prove

The crypto lock finding suggested a class: row locks whose exclusivity is only ever
exercised single-threaded. Enumerating the db layer gives ~25 `.for('update')` /
`SKIP LOCKED` sites across 12 repos.

⭐ First result was a correction to my own expectation: this class is **far better
covered than I assumed** — 19 integration files already run genuine two-client
concurrency (agent sessions, api-key revocation, auth flows, incidents, MFA
issuance, session destroy, session-operation claim, webhooks, team invites,
status subscribers). The crypto-order lock closed last fire was a real hole in an
otherwise well-guarded area, not the first of many.

### The verified finding

`db-profiles-repo-keyset-drizzle` fires **8 concurrent `insertWithLimit` calls
against a cap of 1**, with distinct names so the unique index is not the limiter,
and its comment states the property exactly: "Without the FOR UPDATE lock all N
read count=0 and all insert (the TOCTOU)."

Its client is `postgres(DB_URL, { max: 1 })`. With one pooled connection postgres-js
**queues** those 8 calls — they execute sequentially, so the pool provides whatever
serialisation is observed. Widened to `max: 8`, which makes the concurrency real
rather than nominal.

### ⛔ What I could NOT prove, stated as such

Widening does not make the test detect the lock. Measured three ways — deleting
`.for('update')` from `insertWithLimit` leaves the file green at `max: 1`, green at
`max: 8`, and a two-backend probe outside vitest also still accepted exactly one.

That is **not** evidence the lock is unnecessary. The TOCTOU window between the
count and the insert is narrow, and a race that fails to hit it proves nothing
about the race that does. The lock is load-bearing by construction: nothing else
stops two transactions that both read `count < limit` from both inserting.

⭐ The general point is worth more than this instance. **A passing concurrency test
is only evidence if the interleaving it needs actually occurred**, and nothing in a
green tells you whether it did. Every one of the 19 files above is worth the same
question — the ones that assert a _loser_ exists (a rejected duplicate, a
`not_found`, a second observer seeing committed state) are self-evidencing; the
ones that only assert a final count are not.

Demonstrating this particular lock needs forced interleaving — an advisory-lock
choreography or a driver-level barrier between the count and the insert — not a
faster race. Left named rather than claimed.

## 6s — proving the cap lock, after three attempts that could not

6r left this named rather than claimed: demonstrating the profile cap's
`FOR UPDATE` needs forced interleaving, not a faster race. Done here, and the
route to it is more useful than the result.

### Three attempts that proved nothing

| attempt                                        | outcome with `.for('update')` deleted |
| ---------------------------------------------- | ------------------------------------- |
| existing 8-way race, `max: 1` pool             | green — the pool serialised it        |
| same race, `max: 8` pool                       | green — window too narrow to hit      |
| two-backend probe outside vitest               | green — same reason                   |
| **forced ordering, holder takes `FOR UPDATE`** | **green — and this one was subtler**  |

The fourth is the instructive one. Holding `FOR UPDATE` on the account row and
asserting that `insertWithLimit` blocks LOOKS like a direct test of the lock. It is
not: an INSERT into `profiles` takes a **`FOR KEY SHARE`** lock on the referenced
`accounts` row for its foreign key, and KEY SHARE conflicts with FOR UPDATE. So the
call blocked either way — the test was observing the FK's lock, not the repo's, and
would have shipped as a guard that guards nothing.

### What actually isolates it

The lock MODE is the entire experiment. Hold **`FOR KEY SHARE`** instead:

- it conflicts with the repo's `FOR UPDATE`, so the guarded path blocks;
- it is compatible with the FK's own KEY SHARE, so an unguarded path sails through.

Result: lock present → blocks, holder commits, insert completes, one row. Lock
deleted → _"insertWithLimit must be waiting on the account row lock, not proceeding
past it: expected true to be false"_.

⭐ **The profile cap's `FOR UPDATE` is load-bearing, and that is now measured rather
than argued.** Everything I wrote about it in 6r was reasoning from construction;
this is the first evidence.

### The transferable part

A blocking assertion is only about the lock you think it is if no OTHER lock in the
statement conflicts with the holder's mode. An FK insert quietly takes KEY SHARE on
its parent, so any "does it block on the parent row" test in this repo has the same
trap. The fix is not more waiting — it is choosing a holder mode that conflicts
with the guard under test and with nothing else.

That also sharpens 6r's rule. A green concurrency test needs the interleaving to
have occurred AND the observed effect to be attributable to the mechanism under
test. The first is about timing; the second is about lock modes, and it is the one
that fooled me here.

⚠️ Two hook rejections on the way in, both from the same root and worth separating.
`pending` was assigned inside the `begin` callback, and TypeScript does not narrow
across that boundary: first the tests typecheck rejected a cast from a
null-inclusive type, then — after I "fixed" it with a null check — eslint rejected
`await pending` as awaiting a non-Promise, because the check had narrowed the
handle to `never`. Both are the same mistake wearing different clothes: a mutable
handle assigned in a callback is not a value the type system can reason about.

Restructured with an explicit one-shot latch, so the lock acquisition, the probe,
and the release are three ordered steps with no cross-callback assignment at all.
That reads better than what I started with, and the mutation was re-proved
afterwards rather than assumed to survive the rewrite — the arm still reds with
`.for('update')` deleted.

## 6t — auditing the claim I made about other people's tests, and a second lock proved

6s ended with a claim about the rest of the suite: "every 'does it block on the
parent row' test in this repo has the same trap." That was an assertion about code
I had not read, so checking it came first.

### The claim was too broad, and the real problem is elsewhere

The FK/KEY-SHARE trap needs a specific shape — a holder locking a PARENT row while
the operation under test INSERTS a child. Of the 15 integration files that take an
explicit lock, none of the existing ones has it. They race and assert an outcome
instead, which is the better shape.

⭐ But auditing them surfaced something more useful.
`db-agent-sessions-concurrency` races two `debitTokens` and asserts
`100-30-40 = 30` — a value unreachable if a debit were lost, so it is
self-evidencing by my own taxonomy, and its pool is `max: 5`, so the calls really
can overlap. **It still does not detect its lock's removal**: deleting
`.for('update')` from `debitTokens` leaves it at 10 passed.

Read the method before concluding: `debitTokens` IS a read-modify-write in
application code — SELECT, compute `remaining - tokens` in JS, write back — so the
lock is genuinely load-bearing and the test simply never hits the window. On
localhost a whole transaction completes in well under a millisecond, so the second
SELECT lands after the first COMMIT.

That makes it a PATTERN rather than a quirk of the profile cap: **a race-based test
in this repo cannot be relied on to demonstrate a lock, because the round-trip is
faster than the interleaving the defect needs.** Two independent instances now,
both money-adjacent — a tier cap and a token budget.

### The second proof

Forced ordering with the isolating mode, applied to `debitTokens`. The holder takes
`FOR KEY SHARE` on the `agent_sessions` row:

- it conflicts with the repo's `FOR UPDATE`, so the guarded path blocks;
- an unguarded path does a plain SELECT and then an UPDATE, which takes
  `FOR NO KEY UPDATE` — compatible with KEY SHARE — so it sails through.

Lock present: blocks, then debits 100 → 70 once the holder commits. Lock deleted:
_"debitTokens must be waiting on the session row lock, not reading a balance past
it."_

Under-billing is the failure this protects: a lost debit is budget served and not
charged for. It is now measured on the same footing as the tier cap.

### Where this leaves the concurrency question

Three shapes, and only the third proves a lock:

1. **race + assert a final count** — proves nothing if the pool serialises it (6r);
2. **race + assert a serialisation-only value** — better, but still silent when the
   window is missed (this entry, twice);
3. **forced ordering + a holder mode that conflicts with the guard and nothing
   else** — deterministic in both directions.

The remaining `.for('update')` sites are candidates for (3), and the isolating mode
has to be chosen per site: it depends on what other locks the unguarded path would
take.

## 6u — the rule that decides which locks need a forced-ordering test

Two slices: an audit that closed a question, and the third lock proved.

### API key revocation — checked, needs nothing, and explains the rule

`revokeApiKeyAtomic` looked like the highest-consequence remaining site: a
revocation that loses a race leaves a compromised key usable. It has no lock at
all. It is a **conditional UPDATE** —
`.where(and(scope, isNull(apiKeys.revokedAt))).returning()` — so exactly one of N
concurrent revokes matches and the losers fall through to a read that returns the
persisted timestamp. There is even a paranoid invariant for the impossible case:
"revokeApiKeyAtomic lost its update without a persisted revocation".

Its 5-way race test DOES detect the mutation: removing `isNull(revokedAt)` reds it.

⭐ **That contrast is the useful part, and it decides where the remaining work
goes:**

| mechanism              | why a race can or cannot see it                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| **conditional UPDATE** | removing the predicate makes EVERY caller win, **regardless of timing** — a race detects it deterministically   |
| **row lock**           | the failure needs one specific interleaving; on localhost the transaction finishes first, so the race is silent |

Three data points agree: the profile cap (lock, race blind), the token debit (lock,
race blind), api-key revocation (predicate, race detects). So a race-based test is
not weak in general — it is weak for LOCKS specifically, and that is now a rule for
choosing which sites need a forced-ordering test rather than a preference.

### `setAccountTier` — the third lock, proved

Read-modify-write under `FOR UPDATE`, and the source states the failure: without
it "both deliveries could read the same old tier and each emit a duplicate
tier-changed email/audit; the lock serializes them, so the loser reads
previousTier === args.tier and the lifecycle no-op guard suppresses the dup." Two
Stripe deliveries for one subscription change is ordinary. The visible failure is a
customer receiving the same tier-change email twice.

**No integration test named `setAccountTier`.** Now one does: holder takes
`FOR KEY SHARE` on the accounts row, the call must block, and after release it
reports `previousTier === 'free'` with the row at `api_builder`. Mutation: deleting
`.for('update')` reds it with "setAccountTier must be waiting on the account row,
not reading a tier past it".

### Locks proved by forced ordering so far

| lock                            | failure it prevents                                |
| ------------------------------- | -------------------------------------------------- |
| crypto order (`withOrderLock`)  | double webhook + double receipt email on one IPN   |
| profile cap (`insertWithLimit`) | customer over their tier cap                       |
| token debit (`debitTokens`)     | lost debit — budget served, not billed             |
| account tier (`setAccountTier`) | duplicate tier-change email + double-counted audit |

Remaining lock-based candidates, by the rule above: `mfa-repo` enrollment (2 sites),
the `oauth-store` group (6), and `sessions-repo.claimSessionOperation` — the last of
which already has a dedicated concurrency file worth auditing the same way before
adding anything.

## 6v — correcting the rule I published twice, and a fifth lock proved

### ⛔ The rule was too categorical, and the correction is the main result

6u stated it as a property of MECHANISM: conditional UPDATEs are race-detectable,
locks are not. Auditing `claimSessionOperation` refutes the second half.

`db-session-operation-claim-drizzle` **does** detect its lock's removal — deleting
`.for('update')` reds "elects exactly one of nine independent claims". That file is
built differently from the ones that failed: **nine separate clients**, each its own
`postgres()` at `max: 1`, so nine genuinely independent backends fire at once.

So it is not mechanism, it is PROBABILITY of hitting the window, and it scales:

| shape                                    | detects a lock?                                        |
| ---------------------------------------- | ------------------------------------------------------ |
| N callers sharing one pooled connection  | **no** — the pool serialises them (the profile cap)    |
| 2 callers, 2 connections, fast path      | **no** — window missed (cap probe, token debit)        |
| **9 callers, 9 independent connections** | **yes** — some pair overlaps (session-operation claim) |
| conditional UPDATE, any N                | **yes** — no timing needed at all                      |
| forced ordering                          | **yes** — deterministic in both directions             |

A race is a sampling experiment. Two samples on a sub-millisecond path is a bad
one; nine independent samples is a decent one. I published the categorical version
twice, in `9c2616d18` and `c3246e53b`, and it was wrong in the direction that
matters — it would have justified rewriting a test that already works.

### `mfa-repo` — and why its existing test is RIGHT to miss the lock

`db-mfa-credential-issuance-concurrency` does not detect the FOR UPDATE at
`mfa-repo:214` — 3 passed either way — and that is correct rather than deficient.
`completeEnrollmentIfPending` takes TWO locks:

1. `pg_advisory_xact_lock(hashtext('mfa-credentials:<accountId>'))` — serialises MFA
   activation against another MFA activation;
2. `SELECT accounts … FOR UPDATE` — the account AUTHORITY row, which web-session
   minting also locks.

The existing test races MFA against MFA, which the ADVISORY lock already
serialises, so the row lock is invisible to it. **No MFA-vs-MFA test can exercise a
lock whose purpose is MFA-vs-login.** Reading the method mattered here: on the
"race did not detect it" signal alone the obvious move is to strengthen the
existing file, and that would have been the wrong file.

### The fifth lock

What the authority lock actually protects, per the source: "a mint that wins first
is retired by the epoch advance below; a mint that loses observes the new epoch and
refuses its stale snapshot." Lose it and an in-flight login mint interleaves with
activation and survives on a pre-MFA snapshot — **a session that should have been
retired the moment MFA came on**.

Forced ordering with a login-shaped holder on the same row. Blocks with the lock,
proceeds without it: "completeEnrollmentIfPending must be waiting on the account
authority row."

### Locks proved by forced ordering

crypto order · profile cap · token debit · account tier · **MFA authority row**.
The `oauth-store` group (6 sites) is what remains, and each wants the same two
questions first: what does this lock protect that a sibling lock does not, and does
an existing N-way race already reach it.

## 6w — the OAuth code-replay lock, and a coverage ledger that lies about it

The `oauth-store` group was the last named concurrency item: six `FOR UPDATE` sites
across four methods. Following 6u's rule, each got the two questions before any
test was written — what does this lock protect that a sibling does not, and does an
existing race already reach it. The answers split the six cleanly, and only two of
them turned out to be worth a test.

**`consumeCodeForToken` :226 — the authorization code's single-use guard.** The
shape:

```
SELECT … FROM oauth_authorization_codes … FOR UPDATE     ← the lock
if (code.consumedAt !== null) return 'code_unavailable'  ← the check, in JS
… INSERT api_keys, INSERT oauth_access_tokens …
UPDATE oauth_authorization_codes SET consumed_at = …     ← the mark
```

The marking UPDATE has no `AND consumed_at IS NULL` predicate, so there is no
conditional-UPDATE atomicity underneath the lock the way there is in api-key
revocation. A unique constraint does not stand in either: each exchange mints its
own token value, so two replays of one code produce two different `key_hash`es and
both inserts succeed. The lock is the entire guard. Without it, two concurrent
exchanges of a stolen code both observe `consumedAt === null`, both pass, and both
mint an `api_keys` authority row — one code yielding two live API keys, where
revoking the one the customer can see leaves the other working.

**The ledger lies about this one.** `unit/oauth.test.ts` races `consumeCodeForToken`
through `Promise.all`, so any coverage pass that greps for the method name plus a
concurrency primitive reports it as raced. It has zero `postgres(` calls. It runs
against the in-memory store, where single-use is enforced by JavaScript being
single-threaded — a property that holds regardless of what Postgres does. A race
against a fake store is not evidence about a row lock, and it is worth naming
because the ledger entry looks identical to a real one.

`db-oauth-code-single-use-lock-drizzle` proves it by forced ordering. Control
green; deleting `.for('update')` at :226 reds with _"consumeCodeForToken must be
waiting on the authorization-code row, not reading a consumed_at past it"_.

**`:70` and `:242` are a pair, and neither means much alone.** `revokeClient`
locks the client row, marks it revoked, then SELECTs that client's tokens and
revokes each. `consumeCodeForToken` locks the same row before inserting a new
token. Together they make revocation _complete_. Drop `:242` and an exchange
inserts its key after the cascade has already taken its list, so the new key is
never in that list and never revoked — the customer revokes a compromised
integration, watches it disappear from the dashboard, and one live API key remains
behind it. The `revokedAt` check the exchange performs is not a substitute: without
the lock it reads a snapshot that predates the revocation's commit.

**`:150`/`:164` in `consumeAuthorizationForCode`** are the same two shapes one step
earlier — an authorization row consumed by DELETE (unconditional, so the lock is
what makes it single-use) and a client-authority read. Same classes, same
arguments; recorded rather than re-proven.

**`:299` in `revokeToken` is defense-in-depth, not load-bearing.** Both of its
UPDATEs carry `AND revoked_at IS NULL` and run in one transaction, so two
concurrent revokes converge on the same state whether or not the lock is there.
No test is written for it, and that is a finding rather than a gap — manufacturing
a forced-ordering test here would prove the lock is _acquired_ while implying a
consequence that does not exist.

That is the useful shape of this sweep: six sites, two genuine proofs, three
recorded as the same class as something already proven, and one honestly demoted.

## 6x — the second half of the revocation pair, and a scan that had to be read twice

`db-oauth-client-authority-lock-drizzle` proves `:242`, the client-row lock inside
`consumeCodeForToken`. Control green; deleting it reds with _"consumeCodeForToken
must be waiting on the client row, not minting against a stale revokedAt"_.

The property is the one 6w set out: revocation completeness. `revokeClient` marks
the client revoked and then revokes the tokens it SELECTs; an exchange that does
not take the same lock inserts its key after that SELECT, so the key is never in
the cascade's list. The customer revokes a compromised integration, watches it
disappear from the dashboard, and one live API key remains behind it.

A specificity check was run because this is the SECOND lock in a method whose
first lock already has a test: with `:226` removed and `:242` intact, this file
still passes; with `:242` removed it reds. So the two files probe their own locks
rather than overlapping — which matters, because a test that reds for either
mutation would let one of the two locks be deleted silently as long as the other
survived.

**A scan that would have produced two false findings.** Looking for read-modify-
write transactions with no row lock — genuine defects rather than unproven guards —
turned up three:

    incidents-repo.ts:272      addUpdate
    mfa-repo.ts:144            startEnrollmentIfNotEnrolled
    platform-secrets-repo.ts:126  upsert

Two are already serialised, just not by the mechanism the scan looked for:
`startEnrollmentIfNotEnrolled` takes `pg_advisory_xact_lock(hashtext('mfa-
credentials:<accountId>'))` and `upsert` takes
`pg_advisory_xact_lock(hashtextextended('platform-secret-upsert:<name>', 0))`.
The scan grepped for `.for('update')` and reported their absence accurately; the
word "unlocked" was mine, and it was wrong.

This is the same failure the ledger produced in 6w, in the opposite direction: there
a fake-store race made an untested lock look covered, here a row-lock grep made an
advisory-locked path look unguarded. Both come from letting one mechanism stand for
the property. The check that fixes it is cheap and is now part of the routine —
before calling any site unguarded, grep the body for the OTHER serialisation
mechanisms, and before calling any site covered, confirm the test that covers it
actually reaches the layer the guard lives in.

`incidents-repo.ts:272` is the one survivor, and reading it closes the scan at zero
real defects. `addUpdate` does read `incidents.resolvedAt` without a lock, but only
to preserve an already-set resolution time, and it writes `status` and
`resolved_at` in a SINGLE UPDATE. The invariant its comment exists to protect —
`status === 'resolved'` iff `resolved_at != null` — is therefore carried by one
atomic statement and cannot be broken by interleaving. The worst a race does is
decide which of two concurrent admins' `now` lands in `resolved_at`, on a
status-page timeline, off by the milliseconds between two manual posts.

So the honest result of the scan is that there is nothing to fix: every
read-modify-write on a money or authority path is serialised, by a row lock or an
advisory one, and the only unserialised read left is one whose consequence does not
survive being stated precisely. That is worth recording as a finding in its own
right — it is the difference between "no defects found" and "the surface is
clean".

## 6y — the site where forced ordering does not work, and what replaced it

6w recorded `consumeAuthorizationForCode`'s `:150` as "same class as :226,
recorded rather than re-proven". That was too quick. Its consequence is the same
severity — the DELETE that retires the authorization never checks its row count,
so two callers that both read before either commits both insert a code, and one
user consent becomes several codes, each separately exchangeable for an API key.
Something that severe earns a test rather than a note.

**The technique that worked five times does not transfer here.** Forced ordering
depends on a holder lock mode that conflicts with the repo's `FOR UPDATE` but with
nothing an unguarded path takes — `FOR KEY SHARE` has been that mode throughout.
It cannot be that here, because an unguarded path still DELETEs the row, and a
DELETE takes a lock of `FOR UPDATE` strength. A KEY SHARE holder blocks both
variants, so the test would pass identically with the lock deleted.

That was verified rather than recalled, with two psql sessions:

    ERROR:  canceling statement due to lock timeout
    CONTEXT:  while deleting tuple (0,1) in relation "oauth_authorizations"

The DELETE blocks on a KEY SHARE holder. So the design decision rests on a measured
fact, and the trap it avoids is the same one that fooled the first profile-cap
test — a holder that blocks the unguarded path too, producing a green that means
nothing.

**What replaced it is the corrected rule from 6v.** Detectability by racing is
about sample count and connection independence, not mechanism: two connections on a
sub-millisecond path miss the window, nine independent clients hit it. So this file
opens nine separate `postgres()` clients and has each consume the SAME authorization
with a DIFFERENT code — distinct, so the defect shows as two codes rather than
being masked as a primary-key error.

Measured, and the result is not marginal:

    with the lock:     verdicts = inserted + 8 × unavailable, 1 code row
    without the lock:  verdicts = inserted × 9,              9 code rows

All nine win. The window is wide because the transaction does a client lookup, a
delete and an insert between the read and the commit, which is exactly why the
race that fails on a narrow count-then-insert succeeds here. Control run three
times for stability: 3/3 green.

**The rule, consolidated, since it has now been wrong twice and refined twice.**
Whether a race can demonstrate a lock depends on three things, and the first
version of this rule got it wrong by naming none of them:

1. connection independence — callers sharing a pooled connection are serialised
   inside the process and never reach Postgres concurrently at all;
2. sample count — two callers miss a narrow window; nine hit it;
3. WINDOW WIDTH — how much work sits between the read and the commit.

The profile cap fails on (3) despite satisfying (1) and (2): its count-then-insert
window is sub-millisecond, and it stayed green at eight connections and under a
two-backend probe outside vitest. This authorization consume satisfies all three —
a client lookup, a delete and an insert sit inside its window — and all nine
callers win. Neither result is evidence about locks in general; each is evidence
about the shape of one call site.

So the sweep now stands at seven locks proven, by whichever of the two techniques
the site actually admits — and the choice between them is a property of the
unguarded path's own locking and its window, not a preference.

## 6z — a guard written, measured, and deleted

An audit of advisory-lock usage found all 12 sites transaction-scoped, so none can
leak a lock past its transaction the way a session-scoped `pg_advisory_lock` would.
Reading the keys turned up what looked like a gap: `profile-session` is built by a
shared helper used from two files, while `mfa-credentials:` is a hand-written
literal repeated at four sites in `mfa-repo.ts`. Advisory locks have no namespace
beyond the number handed to them, so two sites serialise if and only if their key
text matches — a one-character drift at one site silently stops it serialising
against the other three while still taking a perfectly valid lock of its own.

A drift guard was written for that, and it worked: mutating site 2 of 4 to
`mfa-credential:` reds it. Then the claim in its own header — "nothing else catches
it" — was checked instead of asserted, by running all 38 MFA test files with the
mutation still applied. One redded:

    tests/unit/db-mfa-repo-v353b-cross-source-invariant.test.ts:77
      expect(p.match(/pg_advisory_xact_lock/g)).toHaveLength(4);
      expect(p.match(/mfa-credentials:/g)).toHaveLength(4);

That is the same property, pinned from both directions — the site count and the key
count — and it catches every drift the new guard caught. The new file was deleted.

**Two separate errors, worth separating.** The first is prior art: the standing rule
is to grep for it before building, and it was followed for `src/` and not for
`tests/`. Nothing named "advisory" would have surfaced that file either;
`v353b-cross-source-invariant` describes its provenance rather than its subject.
The general form is that the way to find whether a textual property is already
pinned is to grep for the LITERAL being pinned — `mfa-credentials:` — across the
whole repo, not for the concept's name in one directory.

The second is internal: the guard's header stated it "deliberately does not pin
WHICH string they agree on", while its assertion was
`toEqual(['mfa-credentials'])`, which pins exactly that. The prose described a
better test than the code implemented. That one had nothing to do with prior art
and would have shipped a guard whose stated contract and real contract differed.

The useful outcome is not the guard. It is that the property was already covered,
and that the check which established it — run the existing suite against the
mutation before claiming novelty — costs one command and is now the routine step
between "I have a mutation that reds" and "this guard is worth committing".

## 7a — a gap closed, and the row that described it wrongly

5s listed `services/webhooks.ts:751` as _"delivery replay, endpoint vanished — open
— same shape as `:532`"_. The site is open, and the mutation confirms it: removing
the check leaves **115 webhook test files and 1257 tests fully green**. But the
description of WHEN it fires was wrong, and being wrong made it look like a
defensive nicety.

The line is `if (!updated)` after `resetDeliveryToPending`. That repo method fences
on `status != 'in_flight'` — pinned by `webhooks-repo-reset-to-pending-in-flight-
guard`, whose own header says it exists so a replay cannot "stomp a delivery a
worker currently has claimed". So a falsy return is not primarily a row that
vanished. It is **the ordinary outcome of a customer pressing replay on a delivery
the worker picked up a moment earlier** — a routine race on any busy account.

Two failures follow from removing it, and the second is the one that matters:

1. the method returns null where its signature promises a row, so the caller
   serialises a malformed body instead of answering 404;
2. execution falls through to the audit block and writes
   `webhook_delivery.replayed` **for a replay that was refused** — the customer's
   own audit log then asserts something the delivery's real state contradicts.

`webhooks-customer-replay-fenced-delivery` closes it with two arms, and the second
is not decoration. Measured separately:

    check deleted entirely   → arm 1 reds ("promise resolved null instead of rejecting")
    check MOVED below audit  → arm 1 PASSES, arm 2 reds ("called 1 times")

The second mutation is the interesting one: the endpoint still answers 404, the
status code is correct, and the log is a lie. A test asserting only the throw would
sign that off. Ordering, not just presence, is the property — which is why the
audit assertion had to be measured against a mutation that preserves the throw.

⭐ The general point, since 5s produced the row and 5s also produced four correct
ones: **a triage note records what a site LOOKED like from the outside.** This one
read as a TOCTOU check because the two throws above it are TOCTOU checks with the
same message. Reading what the repo method actually does — one grep for its name —
moved it from "rare defensive branch" to "routine race with an audit-integrity
consequence". Re-read the mechanism before scheduling the work, not just the note.

## 7b — the sibling that had the test, and a comment that argued for its own deletion

`resetDeliveryToPending` has three callers, not the two the earlier sweep implied:
`replayDeliveryAsCustomer` (7a), `replayDelivery` (admin), and `requeueFromDlq`.
All three guard a falsy return, and — correcting what this section first said —
**all three are followed by an audit write**, not just the customer one. The
customer's is inline in the service; the two admin ones come from the route's
`withAudit`, which does `const updated = await perform()` and only then
`audit.record(...)`. A guard that returned null instead of throwing would resolve
`perform()` normally, so `withAudit` would write `webhook_delivery.replayed` for an
operation that did not happen — the same false-log outcome as 7a, reached through
the route rather than the service.

That makes these three checks audit-integrity guards on every path, which is a
larger claim than the one this section opened with. Worth stating plainly: the
first version was written after reading the two admin service methods, seeing no
`record` call in either, and concluding there was no audit. The audit was one
layer up.

`requeueFromDlq` was uncovered on the same shape, and the asymmetry is the tell:
its sibling `discardFromDlq` HAS the arm — _"surfaces NotFound (not a silent
delete) when the row leaves DLQ between check and delete"_ — written with a
stale-snapshot fake that flips the live row while returning the copy the service
already read. Requeue has the same read-then-act window and had no equivalent.
The new arm reuses that idiom with a concurrent `discardFromDlq` hard-deleting the
row; mutating the guard reds it with _"promise resolved null instead of rejecting"_
while the file's other 13 tests stay green.

⛔ **The comment above that guard was arguing for its own removal.** It read:

    // updated is guaranteed non-null because we just found the row above —
    // but the type narrows here, so guard explicitly for the noUncheckedIndexedAccess
    // family of strict checks.

Both halves are wrong in the same direction. Finding the row does not make the
reset succeed: the reset is status-fenced on `!= 'in_flight'`, and `discardFromDlq`
can hard-delete a DLQ row in exactly that window. So the check is not a formality
demanded by strict-mode narrowing — it is a live race guard, and the comment
invited a future reader to delete it as dead code with a clean conscience. It has
been corrected to state the two ways `updated` really can be null, and to name the
arm that now proves it.

⭐ This is the same class as 6z's finding from the other side. There, prose in a
test claimed a weaker contract than the code enforced; here, prose in the source
claimed a stronger invariant than the code has. Both are cheap to catch and neither
shows up in any run: **a comment asserting an invariant is a claim, and the test
that would fail if it were false is the only thing that makes it one.** Where the
invariant is real, say why; where it is a guard, say what it guards.

⭐ **Why requeue was the uncovered one, precisely.** The admin `replayDelivery`
guard IS covered, by the plainest possible arm — _"throws NotFound on unknown id"_.
It calls `resetDeliveryToPending` directly, so an unknown id returns null and the
guard fires. `requeueFromDlq` has TWO checks: `findDeliveryById` first, then the
post-reset one. Its own _"throws NotFound on unknown id"_ arm is absorbed by the
FIRST check, which throws the same `NotFoundError`, so the second never runs and
the arm passes either way.

That is cause 3 of the four reasons a site shows no red — layered behind a sibling
that raises the same thing — and it is the cause that most resembles coverage. Two
methods, the same guard, the same test name, and one of them proves nothing. The
distinguishing move is the one used here: reach the SECOND check by satisfying the
first, which meant a fake whose row exists at read time and is gone by write time.

## 7c — item 20 is closed, and this document was the stale source

Item 20 lists six parameterised routes that "may return an undocumented 404 —
unverified", and its recommendation says a roster guard is "deliberately NOT added
yet: with six routes undecided it would either fail the suite or encode 'unknown'
as 'fine'". Both statements are out of date. The work was done:

`apps/server/tests/unit/parameterised-routes-document-404.test.ts` exists, carries
an exemption entry with a written reason for **five of the six**, and has a second
arm asserting the exemption list is not stale. The sixth documents its 404 in the
spec. The suite has been green on it all along.

I verified the six independently before finding that file, which makes the result
worth keeping as corroboration — the reasons I derived match the committed
exemptions one for one:

| route                                             | independent finding                         | committed exemption |
| ------------------------------------------------- | ------------------------------------------- | ------------------- |
| `POST …/validation-schedules/{archetype}/trigger` | accepts any archetype, never looks one up   | same                |
| `POST …/oauth/clients/{id}/rotate-secret`         | `invalid_client` → `UnauthorizedError` 401  | same                |
| `PUT …/owner/secrets/{name}`                      | upsert, zero `NotFoundError` in the handler | same                |
| `PATCH …/owner/pricing/{tier}`                    | enum-validated param → 400                  | same                |
| `DELETE …/oauth/clients/{id}`                     | **I first got this wrong** — see below      | idempotent delete   |

⛔ **The one I got wrong is the instructive part.** I read a 55-line window from the
first registration and attributed a `NotFoundError` to the DELETE. It belongs to the
**GET** at the same path — two registrations, one window. I had avoided that exact
trap for `/v1/sessions/{id}/proxy` minutes earlier, where the 404 likewise belongs
to the sibling GET. What caught it was the spec's own comment saying "deliberately
no 404 … the 404 documented here until now was unreachable" — a contradiction I
checked instead of overriding. Had I trusted my reading, I would have added a 404 to
the spec and told every generated SDK to model a branch the server cannot produce,
which is the precise harm that comment was written to prevent.

⭐ **Bound a route-handler window at the next `app.<method>(`, never by line count.**
A path that appears twice is normal — GET and DELETE, live and feature-disabled stub
— and a fixed-size window silently merges them.

⭐⭐ **The larger lesson is about this document.** I picked this task by grepping THIS
file for open items, and its "open" was a snapshot of when the line was written, not
a fact about HEAD. The same rule already applied to readiness docs and ADRs applies
to the assessment itself: **an item is a hypothesis about the codebase until the
codebase is asked.** One `ls` of the test directory for the guard's own name would
have closed it in seconds — which is exactly the check that turned out to matter.

Item 20 and its recommendation are hereby marked closed. Nothing to ship.

## 7d — picking targets by measurement instead of by intuition

The last three fires chose targets by reading code that looked risky, or by
grepping this document for open items. Both misfired: every intuition-picked area
turned out already sound, and the doc-picked one (item 20) had been closed for days.
So this fire regenerated the measurement first.

A full coverage pass was taken **with `DATABASE_URL` set** — without it ~80
integration files never execute and every "never executed" verdict they would have
produced is false, which is the exact trap recorded earlier and passed on to A3.
2751 files, 27,803 tests, all passing, `coverage-final.json` written.

Counting statements whose line begins with `throw`: **960 seen, 225 never
executed.** That is not comparable with item 5f's 188 — 5f counts throw _sites_ by a
different rule — and the two numbers should not be differenced. What the list is
good for is ranking, and it ranks by consequence once the messages are read rather
than the counts.

### The one worth a test

`db/api-keys-repo.ts:91` — _"revokeApiKeyAtomic lost its update without a persisted
revocation"_. The method revokes with a conditional UPDATE (`… AND revoked_at IS
NULL RETURNING *`) and, when that matches nothing, re-reads under the same scope.
Two answers are legitimate: the row is gone (`not_found`), or a concurrent revoke
won and the loser returns the winner's timestamp (`already_revoked`). The third is
a contradiction — the row is present with `revoked_at` still NULL after an update
predicated on exactly that matched nothing — and nothing in the codebase ever clears
`revoked_at`, so it should not arise.

It earns a test anyway because **removing it does not crash; it lies.** Execution
falls through to `return { kind: 'already_revoked', key }` carrying the row just
read, whose `revokedAt` is null. The service reports the key as already revoked, the
customer is told the key is dead, and the key keeps authenticating. Revocation is
the control a customer reaches for when a key has leaked, so of the two directions
this lie could take, it takes the worse one.

Measured, not assumed:

    guard removed → the new arm reds ("promise resolved { kind: 'already_revoked' } instead of rejecting")
    same mutation → 37 of 38 api-key test files still pass, 447 tests green

so the guard was genuinely unheld, and the other three arms (revoked /
already_revoked / not_found) pass under the mutation too — which is what stops a
stub that refuses everything from satisfying the suite.

Reaching the branch needs a state Postgres will not produce, so the database is
stubbed rather than driven. That is the honest cost of testing an
impossible-state assertion, and it is worth paying only because the fall-through is
a wrong answer rather than an exception.

### A deferred product decision that dissolves on inspection

5q defers `services/billing.ts:251` — `getBillingState` throwing `Account not
found.` — as a product question: _"whether that should be a 404 or `subscription:
null` for an account that exists in auth but has never touched billing"_.

There is no such account. `billing-repo.getAccount` selects **`.from(accounts)`** —
the same table auth resolves against — not a billing-specific row. An account that
has never touched billing still has an `accounts` row, and already receives
`subscription: null` from `findCurrentSubscription` below. The throw fires only if
the `accounts` row itself is absent, i.e. the account was deleted between
authentication and this read.

So the question is moot and the guard is a correct residual for a narrow TOCTOU. No
product decision is owed. Recorded because the deferral was reasonable given its
premise — the premise was just wrong, and one line of the repo settles it.

### Probed and sound (recorded so the next sweep does not re-derive)

- **Global error handler** — unknown errors wrap to `InternalError('An unexpected
error occurred.', err)`; the one echo (`StripeApiError` < 500) is deliberate and
  reasoned under V-780. Already covered by
  `error-handler-internal-error-no-leak`.
- **Rate limiter under backend failure** — store error degrades to a bounded
  in-process fallback with a metric; fallback error **fails CLOSED**. Its
  `rejectEffectiveOwner` throws rather than replies, so the call at the invocation
  guard that lacks a `return` is correct, and it strips policy headers first so the
  actor cannot infer the owner's capacity.
- **Worker identity** — `pid-<pid>@<hostname>-<uuid8>`; the container pid-1
  collision hazard is closed, with the reason in the source.
- **Outbound HTTP** — five `fetch` sites, all with a timeout, and every one that
  reads a body keeps the abort timer armed THROUGH the read. `oauth-client-exchange`
  keeps a local copy of the bounded-body reader; it enforces the cap during
  streaming exactly as the shared helper does, and its streaming path is covered
  behaviourally, not by a text pin.

### One recorded decision, not a change

Fastify is constructed with `loggerInstance`, `trustProxy` and `genReqId` only — so
`bodyLimit` (1 MiB), `requestTimeout` (**0, disabled**), `connectionTimeout` and
`keepAliveTimeout` all take defaults. The upload route sets its own limits and is
thoroughly bounded (64 MiB per file, a 96 MiB route body limit, a 512 MB
per-account concurrent in-flight byte cap, and a concurrent-count cap), so the
global 1 MiB default is what everything else runs under, which is right.

`requestTimeout: 0` means a slow client can hold a connection indefinitely at the
Fastify layer. Deployed, Cloudflare and nginx both impose their own timeouts, so the
exposure is bounded by the topology rather than by the app. **Not changed here**: a
64 MiB upload over a slow link is a legitimately long request, and picking a number
without knowing the longest legitimate one would trade a bounded hazard for an
outage. Recorded with the numbers so it is a decision someone can make.

### The criterion that sorts 225 sites into one

Most of the never-executed throws are not worth testing, and the rule that
separates them is what the code does when the guard is DELETED:

- **Falls through to a crash** → residual. `agent-sessions-repo.ts:569`
  (_"disappeared mid-transaction"_) is the type case: the row is held `FOR UPDATE`
  inside the same transaction, so the UPDATE cannot fail to match; remove the guard
  and `rowToRecord(undefined, key)` throws a `TypeError` one line later. The guard
  improves a message. A test would pin the message, not a behaviour.
- **Falls through to a WRONG ANSWER** → test it. `api-keys-repo.ts:91` returns
  `already_revoked` for a live key. Nothing crashes, nothing logs, and the caller
  is told the opposite of the truth.

Both look identical in a coverage report — one uncovered `throw` each — and the
difference is invisible until the fall-through is traced. That trace is one read of
the following three lines, and it is the whole triage. Applied here it took a list
of 225 down to a single test worth writing, with the eleven
`agent-sessions-repo` sites and the seven `account-me` feature-flag branches
declining for stated reasons rather than by omission.

### An observation the sweep turned up sideways

Tracing who could reach `agent-sessions-repo.ts:556` showed that **nothing in
production source calls `appendTranscript` at all.** The two guarded variants do the
work — `appendTranscriptIfActive` (scopes the update with
`eq(status, 'active')` and returns null instead of throwing) and
`appendTranscriptIfAuthorityRevision`. The unguarded original remains, implemented
twice (Drizzle + in-memory), reachable only from tests: 14 call sites across 8 files.

Not filed as dead code to delete. Those 14 sites exercise the transcript
encrypt/decrypt round-trip through a real repo, which is genuine coverage, and
rewriting them onto a variant with different return semantics (null vs throw) is a
change to test meaning, not a cleanup. The thing worth recording is the footgun: a
future caller reaching for "append to the transcript" finds an unguarded method
first, and it will happily append to a session that is no longer active. If it is
ever removed, the guarded variants are the replacements and the null-vs-throw
difference is the migration cost.

## 7e — the same instrument pointed at RETURNS, where the silent failures live

7d's criterion was: delete the guard and ask whether the fall-through crashes
(residual) or produces a wrong answer (worth pinning). Applied to `throw` sites that
took 225 candidates down to one, because most throws fall through to a crash a line
or two later.

An early-`return` guard is the same shape with the opposite property: **its
fall-through never crashes.** `if (<bad state>) return refusal;` removed means
execution simply continues into the work the guard existed to prevent. By 7d's own
criterion that is exactly where wrong answers concentrate, so the instrument was
re-pointed at the same coverage data.

    never-executed `return` statements in apps/server/src   373
    …whose surrounding condition names a state or authority   31
      (revoked|expired|disabled|suspended|consumed|deleted|owner|locked|…)

373 is not a work list; 31 is.

### `oauth-store.ts:167` — the account binding on a private OAuth client

`oauth_clients.account_id` is nullable, and the nullability is the whole policy:
NULL is a public client any account may authorize, non-NULL is a client PRIVATE to
that account. At consume time one line enforces it:

    if (client.accountId !== null && client.accountId !== args.account_id) {
      return 'account_mismatch';
    }

Remove it and nothing throws. Execution falls through to the DELETE of the
authorization and the INSERT of the code, and the method answers `inserted`. A
client private to account A is then usable by account B — and because A controls
that client's `redirect_uri` and secret, the code minted for B's account is
delivered to A. Measured: with the check gone the new test reds with
_"expected 'inserted' to be 'account_mismatch'"_, and a code row exists for the
wrong account.

⚠️ **This one was not entirely unheld, and the distinction matters.** The novelty
run turned up a second red: `oauth-production-wiring-content-parity`, whose
assertion is a regex over the SOURCE TEXT —

    AssertionError: expected '// PostgreSQL-backed third-party OAut…' to match
                    /client\.accountId !== null && clie…/

That is a deletion tripwire, and a useful one: nobody can silently drop the line.
It is not evidence the guard WORKS. A text pin passes whether the branch is
reachable, whether the comparison is the right way round, and whether the writes it
guards actually follow it — and coverage says this branch had never once executed.
So the honest claim is not "nothing held it" but "the line was protected, the
behaviour was not". The new test is the behavioural half, and the arms assert the
absence of the two writes rather than just the verdict, because the dangerous
fall-through is the writes.

⭐ Worth generalising, since a parity pin will keep showing up in these novelty
runs: **a red from a content-parity file is not a coverage signal.** It fires for
any edit to the text it pins, including a comment. When one appears in a novelty
check, read its assertion before concluding the site was covered — otherwise the
instrument that is supposed to prevent redundant work starts causing skipped work
instead, which is the more expensive direction.

### `api-keys-repo.ts:111` — rotation as a way to un-expire a key

`rotateApiKeyAtomic` locks the old row and screens it three ways before minting a
successor: `not_found`, `revoked`, then

    if (locked.expiresAt !== null && locked.expiresAt <= input.now) return { kind: 'expired' };

The first two have been exercised for a long time. The third had a statement count
of zero. Delete it and nothing throws — execution proceeds to the successor INSERT
and answers `rotated`, handing back fresh plaintext with a NEW expiry. A key whose
lifetime already ended becomes live again, with nobody re-authorising it. Expiry is
what makes a time-boxed key time-boxed, and rotation is the one path that could
quietly undo it.

Measured: with the screen gone the new arm reds (_"expected 'rotated' to be
'expired'"_) while **38 of 39 api-key test files stay green, 449 tests**. Unlike the
OAuth binding above, no content-parity pin covered this line either — so this one
was unheld in every sense, text included.

⚠️ **A test-harness trap worth recording, because it cost two runs.** Seeding
`expires_at` by interpolating a `Date` into a raw `postgres.js` template threw
_"The 'string' argument must be … Received an instance of Date"_ — but only once a
`drizzle(client)` handle had been constructed over that same client before the seed
ran. With the handle built lazily after seeding, the identical statement worked. The
mechanism was not isolated, so this is recorded as observed behaviour rather than a
proven cause; the fix that makes it moot is to pass
`${value.toISOString()}::timestamptz` instead of the `Date`, which works either way.

### Two more of the 31, examined and declined with reasons

- **`rate-limit.ts:215`** (no actor receipt → fail closed) — removing it does NOT
  fall through silently: the next line dereferences `actorReceipt.accountId` and
  throws. By 7d's criterion that is the crash category; the guard converts a 500
  into a 429. Recorded, not tested.
- **`rate-limit.ts:234`** (owner not among the actor's live memberships → fail
  closed) — this one does fall through silently, so it is the right category, but
  its own comment records that exact member/admin role "remains route-specific and
  must be checked before this decorator is called". It is defense in depth whose
  exposure requires a route-layer bug first. Worth a test eventually; ranked below
  the two shipped here, which need no precondition.

### Two dead functions, found sideways

Cross-referencing never-called functions against references anywhere in production
source turned up two genuine leftovers — every other candidate was an istanbul
disambiguation artefact (`constructor_2`, `list_2`) rather than a real name:

- `db/fleet-nodes-repo.ts:465 listActiveByRegion()` — referenced nowhere but its own
  definition. A genuine leftover on a production repo.

⛔ **And one I wrote up wrongly before checking the enclosing class.**
`services/oauth.ts:187 resetForTest()` went into this list as "a state-mutating
method on a production service". It is not: it belongs to **`InMemoryOAuthStore`**,
the test double, and all it does is clear four in-memory maps — which is precisely
what such a helper is for. Being uncalled just means tests construct fresh instances
instead of resetting shared ones.

Worse for my version, the protection I imagined was missing already exists and I had
read it a screen earlier: `oauth-production-wiring-content-parity` asserts the e2e
helper contains neither `InMemoryOAuthStore` nor `oauthStore.resetForTest`. The
guard against the exact footgun I was describing is committed and green.

The lesson is narrow and repeatable: **a coverage row gives a file and a line, never
a scope.** `services/oauth.ts` sounds like a production service and contains one;
line 187 is inside a different class in the same file. One `awk` for the enclosing
`class` was the whole check, and it should run before any claim about what a symbol
is attached to. Only `listActiveByRegion` survives as a real finding, and it is
recorded rather than deleted.

## 7f — a drift guard that named the thing it did not check

Finishing the enumeration of 7e's 31 candidates (the set, not a sample) put
`services/auth.ts:787` at the top of the remainder: the V-174 legacy alias grant,
`admin` satisfies `account_owner`.

`requireScope` exists twice — inline in `services/auth.ts`, and in
`lib/errors-helpers.ts` as a wrapper over the canonical `scopesSatisfy`. The
duplication is deliberate and documented ("route-side imports want zero
indirection"), and comparing the two rule sets line by line shows they agree for
every value `ApiKeyScope` permits. The canonical one is stricter in shape — it uses
`parseGranularScope` and a `const _exhaustive: never` switch, so adding a verb to the
enum fails to compile there while the inline copy silently falls through to a denial.
Fail-closed, so no live bug.

`scope-check.test.ts` already exists for precisely this risk. Its header:

    requireScope() is mirrored at two call sites (lib/errors-helpers and
    services/auth). Both should evaluate the same predicate. Unit tests pin the
    matrix so future migrations don't accidentally drift the two implementations apart.

and its loop is honest — every matrix row generates a `helpers:` case AND an
`auth.ts:` case. What the matrix did not contain was a row for the rule in question.
Twelve rows covered `admin → admin:webhooks`, `admin → driftstack_internal_admin`
(deny), `account_owner → read/write/admin`, granular-vs-broad both ways — and not
`admin → account_owner`. **It pinned V-174's denying half and not its granting half.**

The coverage data says the same thing from the other side, and this is the part
worth keeping:

    lib/errors-helpers.ts:62  (alias → return true)   count = 18
    services/auth.ts:787      (alias → return)        count =  0

One rule, two implementations, an 18-to-0 split. The canonical one is reached
constantly through real request paths; the inline clone is reached ONLY by this
matrix, so a matrix row that does not exist means a rule that never runs.

Measured before the fix: deleting the alias grant from `services/auth.ts` left
`scope-check.test.ts` **green at 53/53** — the file whose stated purpose is to catch
that exact drift.

⚠️ **It was not unprotected, and I checked rather than assuming.** Two text pins do
cover it, and their regexes span the code, not merely the comment above it:

    /\/\/ V-174 legacy customer alias\. Never satisfies the staff-only scope\.\s*\n?\s*
     if \(required === 'account_owner' && scopes\.includes\('admin'\)\) \{\s*\n?\s*return;/

So deletion was already a tripwire. What no text pin can say is that the rule still
FIRES: it passes just as happily if a refactor leaves the branch unreachable, and it
fails on a reformat that changes nothing. Behavioural coverage is the missing half,
not the whole guard.

The fix is one matrix row, in the file that already existed, covering both
implementations at once. Proven in both directions:

    alias grant deleted from services/auth.ts   → "auth.ts: key=[admin] required=account_owner" reds
    alias grant deleted from errors-helpers.ts  → "helpers: …" reds

⭐ The general shape, which is what makes this worth writing down: **a guard's stated
scope and its actual matrix are different things, and only the second one runs.**
This file names both implementations in its header, imports both, loops over both —
and still missed a rule, because the omission was a missing row rather than a missing
mechanism. Reading the header would have satisfied any reviewer. The coverage counter
on the line was what disagreed.

### 7f (cont.) — replacing the missing row with a generated product

Adding the missing row fixes the instance. It does not fix the mechanism: the next
rule someone adds to one implementation and not the other is another absent row, and
absent rows are invisible by construction — nobody reviews a test for the cases it
does not contain.

So the matrix now sits alongside a generated one. The two do different jobs and both
are worth having:

- the hand-written matrix is a **correctness** pin — it says what the predicate
  SHOULD answer for cases someone reasoned about;
- the generated block is a **drift** pin — it asserts nothing about the right answer,
  only that `requireScope` (auth.ts), `requireScope` (errors-helpers) and `hasScope`
  return the same one, for every pair the enum permits.

Scopes come from `ApiKeyScopeSchema.options`, not a local list, so a new scope
extends the comparison automatically rather than silently going uncompared — which
is the exact failure a hardcoded list would reintroduce. Granted sets are every
subset of size 0, 1 and 2 (191 sets × 19 required = 3,629 comparisons, all pure
calls). Size 2 earns its place: several rules read one scope while another is
present, and a singleton-only sweep cannot catch an implementation consulting the
wrong element.

Proven against a divergence the matrix structurally cannot see — an extra allowance
for `gui_control → read:audit`, a pair no row covers, injected into the canonical
only:

    16 disagreements, each naming its pair, e.g.
      granted=[gui_control] required=read:audit → auth=deny helpers=allow hasScope=allow
    every matrix row still green

⭐ The failure output is the design point. A boolean "predicates disagree" would send
the next person back to bisecting; collecting the disagreements and asserting the
LIST is empty means the failure message already contains the granted set, the
required scope, and which of the three dissented.

## 7g — TOTP replay: the covered half and the uncovered half

`services/mfa.ts:317` came off the same list of 31. It looked, at first read, like the
TOTP replay defence — and that reading would have produced a badly wrong write-up,
because `verifyCode` has TWO replay defences and only one of them was uncovered:

    const matchedCounter = verifyTotpCodeWithCounter(secretBytes, trimmed, args.nowSeconds);
    if (matchedCounter === null) return null;
    const lastUsed = row.lastUsedTotpCounter;
    if (lastUsed !== null && matchedCounter <= lastUsed) return null;   // ① sequential
    const accepted = await this.repo.consumeTotpCounter({ … });
    if (!accepted) return null;                                        // ② concurrent

① is well covered. `mfa-service.test.ts` has _"the SAME code cannot be used twice
within its window"_, which verifies a code, then replays it, and asserts `null`. That
test passes with ② deleted, because a sequential replay never reaches ② — it is
rejected one line earlier, before the repo is touched at all.

② is reachable ONLY under concurrency: two verifies that both read
`lastUsedTotpCounter` before either writes will both clear ①, and the atomic
strict-monotonic write in `consumeTotpCounter` then lets exactly one win. ② is what
makes the loser fail. Delete it and the loser falls through to `touchLastUsed` and
`return 'totp'`, so **both parallel verifications of one intercepted code succeed** —
against either the login challenge or the step-up gate, both of which flow through
`verifyCode`. The source comment states the intent exactly ("so two concurrent
verifies of the same code can't both win"); ② is the half that delivers it.

Measured before writing anything: deleting ② left **all 38 MFA test files green (490
tests)**, and a wider sweep — 156 files, 1,870 tests — green as well. No
content-parity pin covered it either.

The new arm forces the interleaving rather than racing for it: both callers are held
at `consumeTotpCounter` until the second arrives, so both have provably passed ①, and
the underlying fake is the existing faithful one that models the atomic write. With ②
present, one wins and one is rejected; with ② deleted, `expected 2 to be 1`.

⭐ **The lesson is about naming, and it nearly cost a false report.** A guard and the
line above it can implement the same policy against different threat models. Coverage
showed ② cold and the obvious conclusion — "TOTP replay is unheld" — was false and
alarming. What distinguished them was reading the three lines ABOVE the cold one:
the covered branch handles the sequential case, the cold one handles the concurrent
case, and only the second was missing. **Before describing what an uncovered guard
protects, check whether its neighbour already protects the case you have in mind.**

### 7g (cont.) — the money-path candidate that was not one

`stripe-webhooks.ts:370` — the `checkout.session.completed` dispatch case — was next
on the list, and the coverage looked alarming: not just the routing but
`handleCheckoutCompleted` itself shows **called 0 times**. Stripe Checkout is the
primary revenue-activation path, so "the handler that provisions a paid subscription
has never run in a test" is exactly the sentence one wants to write.

It would have been wrong. The handler provisions nothing:

    // ... all checkouts are now subscriptions. Subscription mode is informational
    // here — customer.subscription.created does the actual mirror write — and any
    // other mode is a no-op ack.

It logs and returns `'handled'`. Deleting the case changes a log line and an outcome
label, not a customer's entitlement, which is written by a different event whose
handler IS covered. Declined, with the reason recorded rather than left as a silent
skip.

⭐ Second time in this section, and the same shape both times: the coverage row was
right about WHERE and I supplied the WHAT. For ② it under-stated the guard (a
neighbour already covered the case I imagined); here it over-stated one (the name
implied work the body does not do). **A zero next to a money-path symbol is a
question, not a finding** — the body and its neighbours answer it, and reading them
costs a minute against a false report that would have cost more.

## 7h — the guard that ran but had never refused

`account-proxies.ts` came off the 31-list, and the coverage shape was one I had not
hit before. Both VPN SSRF re-guards in `resolveVpnForDispatch` show the `if` at **1
execution** and the `return null` beneath it at **0**:

    :186  count=1   if (classifyUnsafeVpnTargets({ configBlob: parsed.config_blob }) !== null)
    :186  count=0     return null
    :197  count=1   if (classifyUnsafeVpnTargets({ endpoint: str('endpoint'), dns: str('dns') }) …
    :198  count=0     return null

The guards RUN on every dispatch and had never once REFUSED, because no test has ever
presented a stored row with an unsafe embedded target. A file-level or
function-level coverage view calls this covered; only the statement beneath the
condition disagrees.

**Why the route-level work does not cover it.** `account-me-proxies` already pins
the create-route guard, thoroughly and with its own mutation table — that was assessment
item 5i. But a route guard governs rows created THROUGH that route, AFTER it shipped.
These guard the rows themselves, and `resolveForDispatch` states the reasoning
verbatim: _"so a row inserted by any other path can't smuggle a private/loopback/
metadata host into egress"_, and of the route-only alternative, _"a check on one call
site, which is the shape of the bug being fixed"_. Rows predating the gate are the
concrete case.

Delete either guard and nothing throws: `candidate` is built, the flat wire validates,
and the config is handed back for dispatch. With `169.254.169.254` that is the cloud
metadata endpoint reached from inside the fleet.

Measured, per scheme, since the two are independent:

    WireGuard guard deleted → both WG arms red ("expected { type: 'wireguard', … } to be null")
    OpenVPN guard deleted   → the OpenVPN arm red; WG arms and both positives stay green
    novelty: 35 other proxy/egress files (317 tests) stay green under the WG mutation

⛔ **The trap this file walked into, and it would have shipped a test that proved
nothing.** The first version's WireGuard rows omitted `peer_public_key`,
`allowed_ips` and `address`. The negative arms passed — but for the wrong reason: the
flat `InlineVpnProxyWireSchema.safeParse` at the end of the method rejected the
candidate on missing fields, returning null before the SSRF guard's absence could
matter. **A null-returning refusal test must make every OTHER path to null
impossible**, or a mutation of the guard under test cannot change the result. The tell
was a positive arm failing ("a safe row must still dispatch"): if a SAFE row is also
refused, the refusals are not measuring the guard. Fixing the positive arm is what
made the negatives real.

⭐ Same discipline as the route-level arms, and worth repeating: every row keeps a
SAFE display host, so a refusal cannot be the display-host check doing the work. Only
the embedded target is unsafe.

⚠️ `tsc -p tsconfig.test.json` caught a duplicate object key (TS1117) that vitest ran
straight past — the helper spread `...over` after an explicit `id` and then repeated
`id`. Re-ran the mutation after the fix to confirm the refactor had not weakened the
arms; 2 red, as before.

### 7h (cont.) — `oauth-client-service.ts:153`, declined on evidence

Same shape as 7g's MFA finding: a fast-fail pre-check above, then

    // …this CAS is the authoritative serialization point… Two concurrent
    // confirm-merges carrying the same token → exactly one claims → exactly one
    // link created; the loser gets a clean null (→ 400 "already used") instead of
    // a duplicate-key 500.
    if (!(await this.deps.pending.markConsumedAt(pending.id, nowDate))) return null;

reachable only when two confirm-merges race. The obvious worry is that removing it
lets BOTH insert, leaving one OAuth identity linked twice — a real integrity defect
if nothing else stops it.

Something else stops it. `pg_constraint` on `account_oauth_links` shows only a PK on
`id`, which is what suggested the worry, but the enforcement is a unique INDEX rather
than a constraint and does not appear there:

    account_oauth_links_provider_sub_idx  UNIQUE btree (provider, provider_sub)

So the comment is accurate as written: the loser hits a duplicate-key violation. The
fall-through is an exception, not a silent wrong answer, and by 7d's criterion that
is the residual category — the guard turns a 500 into a clean 400. Worth having,
recorded, not tested ahead of items whose fall-through is silent.

⭐ Two checks, one conclusion: **`pg_constraint` is not the whole answer for
uniqueness.** A `CREATE UNIQUE INDEX` enforces it without being a constraint, so a
constraint-only query reports "no uniqueness" on a table that has it. Query
`pg_indexes` too before concluding a duplicate is possible — the wrong answer here
would have promoted a 500-vs-400 nicety into a fabricated integrity finding.

## 7i — a third category: cold because it cannot be reached

`agent-runtime.ts:677` was next on the 31-list, and it is neither of the two
categories 7d established. It is not a residual whose fall-through crashes, and not a
missing test whose fall-through lies. It cannot execute at all.

`runTurn` reads the session ONCE and screens it:

    :602  if (session.status !== 'active')  → return { kind: 'session-closed', … }

then, after admission bookkeeping that never re-reads the row, hands that same object
to `runExclusiveTurn`, which screens it again:

    :673  if (session.status !== 'active')  → return { kind: 'session-closed', … }

The counters settle it:

    :602  evaluated 146   :603  fired 2
    :673  evaluated 140   :677  fired 0

Every call that reaches `:673` has already passed `:602` on the same immutable value,
and `runExclusiveTurn` is private with a single call site. The inner branch is
therefore unreachable by construction, and the 146-vs-140 gap is simply the six calls
that returned earlier for other reasons.

**No test is written for it, and that is the finding rather than a gap.** Reaching
that branch would mean calling a private method directly with a state the public path
cannot produce — a test that pins nothing about production behaviour while looking
like coverage. Nor is the branch removed: it is a cheap safety net that becomes load-
bearing the moment someone adds a re-read after admission or a second call site, which
is exactly when a stale-status turn would otherwise slip through.

⭐ **The catalogue is now three, and the distinguishing question differs for each:**

| cold guard  | fall-through                              | action                        |
| ----------- | ----------------------------------------- | ----------------------------- |
| residual    | crashes a line later                      | leave; a test pins a message  |
| real gap    | returns a WRONG ANSWER silently           | pin it                        |
| unreachable | cannot execute — a caller already decided | record; do not fake the state |

The third is the one most likely to waste an afternoon, because it is invisible from
the coverage row and from the guard's own body. What separates it is reading the
CALLER: if the value under test was already decided upstream and nothing re-reads it,
no test can honestly reach the branch.

## 7j — the cold-site sweep has saturated, and here is the evidence

Five guards were shipped from this sweep across the last fires (OAuth code single-use,
OAuth client binding, api-key revocation, api-key expiry-on-rotation, TOTP concurrent
replay, VPN dispatch SSRF). This fire worked the tail and shipped none, which is the
result rather than a shortfall: **every remaining candidate examined is category 3 —
cold because it cannot be reached, not because it is untested.**

The evidence, one line each:

| site                                   | why it cannot fire                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-runtime.ts:677`                 | `runTurn` already screened the same object; no re-read, single private call site. Counters: outer 146 evaluated / 2 fired, inner 140 / **0**                                         |
| `middleware/auth.ts:242`               | `if (request.account)` after `await requireAuth(...)` — `requireAuth` throws on failure, so the false side is unreachable. It exists because TS narrowing does not survive the await |
| `lib/api-keys.ts:83`                   | `base32Encode`'s tail-padding branch. 8·N bits leave a remainder only when N ∤ 5; every caller passes a length that divides evenly, and the helper is private                        |
| six `MAX_*_MIGRATION_BATCH` validators | one caller each, in `bootstrap.ts`, passing a hardcoded `500`                                                                                                                        |

None of these is a defect and none should be deleted — each is a cheap net that
becomes load-bearing the moment a caller changes. What none of them can be is
_tested_, because reaching them means constructing a state the callers make
impossible.

⚠️ **A filter that produced 99 findings and 0 real ones**, worth recording as an
instrument failure. Searching the never-executed returns for quota/limit refusals with
`limit|cap|max|…` matched `.limit(1)` on ordinary repo reads — every SELECT in the
codebase. The fix was to require the keyword inside an actual `if`/`&&` CONDITION and
to exclude `.limit(`, which cut 99 to 33 and made the list readable. Same class as the
earlier lesson about a keyword regex matching a category name rather than a leaf: **a
word that appears in the language of the query is not a signal.**

⭐ **The stopping rule, so the next fire does not re-grind this.** A cold site is worth
work only when the CALLER can still produce the state. The check is mechanical and
takes a minute: find the call sites, ask whether the value under test is fixed by the
caller (a constant, an earlier screen on the same object, a type that cannot hold the
value), and stop if it is. Applied to the tail of this list it returns "stop" every
time — which is why the sweep is done, and why the next measured axis should be a
different one (branch polarity, error-path coverage, or a fresh coverage pass after
the next batch of features lands) rather than more of this list.

## 7k — a new axis opened, measured, and closed: swallowed errors

7j said the next measured axis should be a different one. This is it: `catch` blocks
that discard the error. They are silent-failure sites by construction — no throw, no
log, no return value change — so coverage cannot rank them and only the contents of
the `try` say whether the silence matters.

⛔ **The first scan was wrong, and reading one hit is what caught it.** It reported 220
swallows. The classifier walked forward from the `catch` line counting braces, and for
the extremely common shape

    } catch {

the delta is **net zero** — the try block's closing brace cancels the catch's opening
one — so the walk terminated after a single line and judged every such body empty.
`agent-session-control-key.ts:97` appeared on the list and does the opposite of
swallowing: it throws `UnauthorizedError`. Counting braces only from the catch's own
`{` gives the real figure: **149**, and the file that exposed the bug is correctly
excluded.

That is a 32% over-count in the direction that manufactures work. Worth stating
plainly: **a brace-counting scanner must anchor on the token it cares about, not on
the line containing it** — the line is shared with the construct that just closed.

Filtering the corrected 149 to those whose `try` is not metrics/logging/audit/cleanup
leaves **68**. The security-relevant ones were read, and each is sound:

| site                              | why the silence is safe                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook-target-guard.ts:133`     | entered only when `isIP(host) === 6`, which `new URL('http://[host]/')` parses; and if it did fire, the `::ffff:`, `::`-embedded-IPv4 and BlockList checks still run                                                   |
| `account-me.ts:291/805/840`       | `invalidateAccount` already degrades internally ("any Redis error … logged and treated as a no-op") and the worst case is the documented 30s TTL — the version counter makes a stale entry a miss, not stale authority |
| `agent-sessions.ts:3635`          | a failed control-key decrypt leaves `plaintext` null, which routes into the authenticated recovery path that mints and commits a fresh key                                                                             |
| `agent-session-control-key.ts:97` | not a swallow at all — the scanner bug above                                                                                                                                                                           |

⭐ The axis is closed with nothing to ship, and the reason is worth keeping: **the
swallows in this codebase are deliberate and bounded, and each one says so in a
comment that names the recovery.** That is the difference between a swallow and a bug
— not whether the error is discarded, but whether the code that follows has a defined
behaviour for the failure. Every one examined here does.

_Next axis, for whoever picks this up: none of statement, branch, return, throw or
swallow coverage now yields a ranked list with real defects in it. The instruments
have converged. The next genuinely new signal will come from a fresh coverage pass
AFTER the next batch of features lands, or from a different question entirely —
concurrency (which produced five of the six shipped guards) applied to paths that have
no second caller yet._

### 7k (cont.) — the guard I almost wrote was a lint rule

The claim above — "each swallow names its recovery in a comment" — was a
generalisation from four files, so it was measured across all of them:

    swallows WITH an explanatory comment: 149
    swallows with NO comment at all:        0

149 of 149. An invariant that already holds perfectly is exactly the kind worth
pinning, and the guard was half-written: scan `apps/server/src` for a `catch` whose
body has neither code nor a comment, assert the list is empty, mutation-prove by
introducing one.

**It would have duplicated a lint rule.** `eslint.config.js` extends
`js.configs.recommended`, which includes `no-empty`, and that rule ignores blocks
containing a comment while flagging genuinely empty ones. That is precisely the
observed distribution — not discipline that happened to hold, but a rule that cannot
be violated.

Verified rather than inferred, because the reasoning would have been just as
comfortable if it were wrong. Stripping the comment from one existing swallow and
linting the file:

    291:17  error  Empty block statement  no-empty

⭐ The lint rule is also STRONGER than the test would have been: it runs in
`lint-staged` at commit time, so a bare `catch {}` cannot reach a branch at all,
whereas a test only fails after it is written. **Before pinning an invariant that
holds perfectly, ask what is already making it hold** — a distribution with zero
exceptions across 149 sites is more often an enforced rule than a maintained habit.

_(A stdin probe was tried first and could not answer: the type-checked ESLint config
rejects a pseudo-filename that is not in the tsconfig project. Mutating a real file
and restoring it was the only way to ask the question.)_

## 7l — a real defect: concurrent transfers duplicate a profile across accounts

7k concluded the coverage instruments had converged and that the next signal would
come from concurrency applied to paths with no second caller yet. Scanning the
SERVICE layer for read-then-write outside a transaction gave 26 candidates;
`profiles.ts::transferProfile` is the first of them to be a genuine defect rather
than a covered guard.

**What it does.** `transferProfile` reads the source with a plain `findById` (no
lock, no claim), asserts no active session, pre-checks the recipient's cap, inserts a
fresh profile into the RECIPIENT under `insertWithLimit` — which takes the
**recipient's** account-row lock — and finally soft-deletes the source.

**Why the lock does not help.** Two transfers of the same source to DIFFERENT
recipients take DIFFERENT account-row locks, so they never exclude each other. And
nothing at any layer serialises on the SOURCE: the route adds no advisory lock or
idempotency key, and the opening read takes none.

**Reproduced, not argued.** A first probe ran the two transfers concurrently and came
back `fulfilled, rejected` with the loser getting `NotFoundError` — the benign
ordering, and one sample of a race proves nothing. Forcing the interleaving (both
callers held at `insertWithLimit` until each had provably passed its own `findById`)
gives the real answer:

    outcomes = fulfilled, fulfilled
    copies_in_recipients = 2
    source_remaining = 1   (soft-deleted)

**One profile becomes two, owned by two different accounts, and both callers are told
they succeeded.** DEK handling is sound — each recipient gets a freshly minted key, so
no key material crosses tenants — but the profile identity and its archetype/config
are duplicated across accounts that were never meant to share it.

⭐ **The signal was already there and is discarded.** `profiles-repo.delete` is a soft
delete whose WHERE carries `notDeleted`, and it returns `result.length > 0` —
precisely "did I actually retire this row". `transferProfile` calls it as a bare
`await` and throws the boolean away. The loser therefore learns nothing from the one
statement that knows the truth.

**Not fixed here, deliberately, because the obvious fixes each trade one failure for
another:**

- _Check the boolean and throw._ Converts a silent duplication into a 409 — but the
  loser's copy has ALREADY been inserted, so it needs compensation to remove it.
- _Soft-delete the source first, insert second._ Gives exactly-once semantics, but
  breaks a property the current ordering was written for and states in a comment:
  "Both the cap refusal and the name-race 409 throw BEFORE the source delete below, so
  a refused transfer leaves the source profile intact." Delete-first means a cap
  refusal loses the profile entirely.
- _One transaction around the recipient insert and the source delete._ The correct
  answer — the loser's conditional delete matches zero rows and the whole transfer
  rolls back, no copy and no loss — but it composes two repo methods into a shared
  transaction, which is a change to how this service talks to the repo.

That is a design decision on an ownership path with a documented trade-off, so it is
reported with its reproduction rather than resolved by a drive-by edit. The
reproduction is a scratchpad probe, deliberately not committed: a test that asserts
today's behaviour would pin the bug.

### 7l (cont.) — why transfer and not the other four

V-714 already hardened the profile-creation paths against a count-then-insert TOCTOU:
`restore`'s comment names them — "was a count-then-insert TOCTOU — the 5th
profile-creation path, missed by the original create/clone/import/transfer fix". So
create, clone, import, transfer and restore all now insert under
`insertWithLimit`'s account-row lock, and the count above each is explicitly a
fast-fail.

That fix is about the **cap**, and it is complete. The transfer defect is orthogonal
and survives it, because transfer is the only one of the five that **moves** rather
than creates:

    create / clone / import / restore : insert into ONE account, under that account's lock
    transfer                          : insert into the RECIPIENT + retire the SOURCE

The lock it takes belongs to the recipient, so it says nothing about the source, and
two transfers of one profile to two different recipients never contend. Checked
rather than assumed: `profile-snapshots.ts::restore` and the other creation paths are
sound for exactly this reason — they have no second row to retire.

⭐ The general shape worth carrying: **a fix that hardened a family can leave one
member exposed if that member does something the others do not.** V-714 is correct,
thorough, and documented, and it makes transfer look covered — the audit that finds
the gap has to ask what is DIFFERENT about each member, not whether the family was
fixed.

Two other candidates from the same 26 were examined and are sound:
`stripe-webhooks.ts::handleSubscriptionUpsert` writes through
`setAccountTierToBestActive`, which recomputes the tier from current DB state instead
of writing a value derived from the stale read; `auth-flows.ts::consumeMagicLink`'s
flagged write is `markEmailVerified`, an idempotent timestamp behind a null check.
Twenty-three remain for the next pass.

## 7m — scoping the transfer defect, and a guard that measurement killed

7l reported one real defect. Two questions follow: does the class recur elsewhere,
and can it be caught mechanically. Both were answered by measurement.

**Does the class recur? No — it is a singleton.** The defect needs a method that
INSERTS one row and RETIRES another (a move), because that is what makes the
recipient's lock irrelevant to the source. Scanning every method in
`routes/`, `services/` and `db/` for that pairing:

    move-shaped (insert + retire in one unit): 1
    apps/server/src/services/profiles.ts::transferProfile

Every other write path creates or updates within one owner, so there is no second
row whose retirement can be lost. The eventual fix is therefore complete at one
site — worth knowing before anyone designs it.

**Can it be caught mechanically? No, and the measurement is why.** The tempting rule
is "a repo method returning `Promise<boolean>` must not be called as a bare `await`" —
it describes `transferProfile` exactly, since `delete` returns "did I retire this row"
and the service discards it. Measured against the codebase: 18 such methods, and
**10 discarded call sites**, of which 9 are correct. Most are idempotent deletes where
the caller genuinely does not care — `DELETE /v1/profiles/{id}` is documented as a 204
whether or not a row existed, and its 404-free status is already pinned.

So the rule would have flagged 10 sites to fix 1, and the 9 false positives are not
sloppiness but the intended contract. What actually distinguishes the defect is
semantic and not visible to a scanner: the discarded boolean means _another actor
already did this_, AND the call has already performed an irreversible side effect (the
recipient insert) that the loser cannot take back. No syntactic rule sees that.

⭐ Recorded as a negative result so it is not rebuilt: **a rule that flags 10 to catch
1 is not a guard, it is a backlog.**

**The diagnostic that does work is a reading rule.** Every other read-modify-write
examined follows the same shape — and they were checked, not assumed:

| site                                  | shape                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `confirmPasswordReset`                | claims the unconsumed token FAMILY in one conditional UPDATE, `if (!consumed) throw`          |
| `handleSessionFailedFirst`            | atomic mark BEFORE the send; loser skips, with the accepted worst case written down           |
| `handleSubscriptionUpsert`            | writes via `setAccountTierToBestActive`, recomputing from DB state rather than the stale read |
| `consumeMagicLink`                    | idempotent timestamp behind a null check                                                      |
| `profile-snapshots.ts::restore`       | V-714 lock, and no second row to retire                                                       |
| `webhook-rotation-reminder::tickOnce` | send-then-mark, but the whole tick runs under a scheduled-jobs worker lease                   |
| **`transferProfile`**                 | **claims LAST, and discards the claim's result**                                              |

Every sound one claims first and checks the claim. The defect claims last and does not
look. That is the sentence to carry into the next audit of this kind — it is faster
than any scanner and it is what found this one.

Two more were checked after that table was written, and both follow the rule:
`profiles.ts::update` lets the `profiles_account_name_unique` index be the authority
and translates its 23505 into the same 409 the pre-check throws — the DATABASE claims,
not the read; `status-subscribers.ts::confirm` assigns `markConfirmed`'s result and
throws "invalid or has been used" when it comes back null.

_Nine of the 26 service-layer candidates are now dispositioned — one defect, eight
sound, and every sound one claims first and checks the claim. Seventeen remain._

⭐ **A tenth check makes the omission sharper rather than softer.**
`auth-flows.ts::signup` handles the identical scenario and names it:

    // Concurrent same-email signup race (e.g. a double-clicked submit):
    // … both insert; the accounts_email_unique index lets one win and raises
    // 23505 on the loser. Translate to the same email_already_registered (409)
    // the pre-check throws — not an uncaught 500.

A double-clicked submit is precisely what produces two concurrent `transferProfile`
calls. The hazard was anticipated on the signup path, solved there by letting a unique
index be the authority and translating the loser's violation, and the same reasoning
simply was not carried to the one path that moves a row between owners. That is not a
gap in anyone's understanding of concurrency — the codebase demonstrates it repeatedly
and in writing. It is a single path where the claim ended up last.

_Ten of the 26 dispositioned: one defect, nine sound. Sixteen remain._

## 7n — both concurrency axes closed, and they converge on one method

### Axis 1 complete: 26 of 26 service-layer read-then-writes dispositioned

The remaining sixteen were triaged with the reading rule from 7m applied
mechanically — is the write's result assigned and checked — which sorted them
without reading sixteen methods:

    CLAIMED (result assigned + checked): 10
    BARE    (result discarded):           4

The four bare ones were then read, and all four are sound for reasons the rule does
not capture on its own:

| site                                          | why a bare write is correct here                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth-flows.ts::completeMfaChallenge`         | the CHALLENGE is claimed and checked above (`if (consumed === null) throw`); the bare write marks the session this same call just created, so no other actor can race it |
| `crypto-entitlement-expiry-sweeper::tickOnce` | marks only rows whose account recomputed cleanly, and the recompute is idempotent — "crash-idempotency: the whole batch replays next tick, not silently skipped"         |
| `byok-anthropic-rotation-reminder::tickOnce`  | send-then-mark, but the tick runs under a scheduled-jobs worker lease                                                                                                    |
| `validation-harness::runTick`                 | same, plus its own `ticking` re-entrancy flag against overlapping setInterval fires                                                                                      |

**Final tally: 26 candidates, 1 defect, 25 sound.** The set was enumerated rather
than sampled — a scripted diff of "found by the scan" against "examined" returns
zero remaining.

### Axis 2: crash atomicity, and it finds the same method

The RMW axis asks what two concurrent callers do. A different question is what one
caller leaves behind if it dies midway: methods performing 2+ writes with no
transaction, where a failure between them is half-applied state. Across every
service:

    multi-write methods with NO transaction: 2
      profiles.ts::transferProfile     writes at 1075, 1112
      scheduled-jobs.ts::runOne        writes at 221, 234, 253, 278

`runOne` is sound and is not really a sequence: its four writes are mutually
exclusive OUTCOME branches — no-handler-failed, complete, attempts-exhausted-failed,
retry — exactly one of which runs per call. Each is additionally wrapped in
`if (!(await …))` with `reportLostLock` when the claim comes back false, which is the
`locked_by = workerId` fencing.

That leaves `transferProfile` as the only multi-write method in the service layer
without a transaction — and its two writes are a genuine sequence, not branches.

⭐ **Two independent enumerations, asked from different directions, return the same
single method.** Concurrency asks "what do two callers do"; atomicity asks "what does
one dying caller leave". A method that fails both is not an edge case in an otherwise
uneven codebase — it is the one place where a pattern applied everywhere else was not.
That convergence is the strongest argument for fixing it with a transaction, which is
precisely what the second axis says is missing.

### 7n (cont.) — sizing the fix, so the decision is concrete

7l left the transfer defect open because each candidate fix trades one failure for
another, and named "one transaction around the insert and the delete" as the correct
one. 7n's second axis independently says the same thing — a transaction is exactly
what is missing. So the remaining question is what that costs, and it is worth
answering before anyone weighs it.

**The service cannot wrap it.** `ProfilesService` holds a `ProfilesRepo`, not a
database handle, and `insertWithLimit` opens its OWN transaction
(`return this.database.db.transaction(async (tx) => …)`). There is no seam for the
service to join those two calls into one unit of work — by design, since the service
is deliberately opaque to Drizzle.

**So the change belongs in the repo**, as one method that does both writes inside a
single `db.transaction`: take the recipient's account row `FOR UPDATE` (as
`insertWithLimit` already does), re-check the cap, insert the recipient row, then
conditionally soft-delete the source with the same `notDeleted` predicate, and return
a discriminated result — transferred / limitExceeded / nameConflict / sourceAlreadyGone.

That shape fixes both axes at once. The loser's conditional delete matches zero rows
inside its own transaction, so it rolls back its insert too: no duplicate, and no lost
profile. It also preserves the property the current ordering was written for, because
a cap refusal or name race aborts the transaction before anything commits.

**Change surface, counted rather than estimated:**

- `db/profiles-repo.ts` — one new method (the two existing bodies, composed).
- `services/profiles.ts` — `transferProfile` calls it instead of orchestrating; the
  `ProfilesRepo` interface declared there gains one entry.
- `tests/integration/_helpers/in-memory-profiles-repo.ts` — the test double must
  implement it too, and there is exactly one such double.

Three files, one new method, no behavioural change to any other path — because
`transferProfile` is the only caller that moves a row, which 7m established by
scanning every method in `routes/`, `services/` and `db/`.

_Still not implemented here: it changes a repo API on an ownership path, and the
decision is the founder's or A3's. But it is now a sized change rather than an open
question, and the reproduction in 7l is ready to become its regression test the moment
the behaviour is meant to differ._

## 7o — a third axis: a transaction is atomicity, not isolation

The two closed axes both asked about code with NO transaction. There is a subtler
class inside the ones that HAVE one, and it is worth asking separately because a
transaction looks like the answer: Postgres defaults to READ COMMITTED, so a
`SELECT` → compute → `UPDATE` inside a transaction is atomic but **not** serialised.
Two such transactions can both read the same row and both write. The transaction
guarantees all-or-nothing; it does not guarantee alone-or-nothing.

Scanning every repo transaction for a SELECT plus a write with no `FOR UPDATE` and no
advisory lock:

    repo transactions with SELECT + WRITE and NO row lock: 3
      incidents-repo.ts::createWithInitialUpdate
      incidents-repo.ts::addUpdate
      team-members-repo.ts::removeMemberWithInvites

All three are sound, and the reasons are worth recording because each uses a
different mechanism:

- **`removeMemberWithInvites`** claims with the DELETE itself —
  `.delete(teamMembers) … .returning({ memberAccountId })` — and checks it
  (`if (memberAccountId === null) return null`) before doing anything else. It then
  revokes every key the member minted **in the same transaction**, with the hazard
  written down: "a key authenticates as its `account_id` (the owner) and never
  re-checks the minter's membership". That is precisely the
  membership-outlived-by-credentials problem, already closed.
- **`createWithInitialUpdate`** claims with `onConflictDoNothing({ target: incidents.id })`
  and writes the dependent `incidentUpdates` row only `if (insertedRow)`.
- **`addUpdate`** was dispositioned in the earlier sweep: it writes `status` and
  `resolved_at` in ONE statement, so the invariant its comment protects cannot be
  broken by interleaving.

**Three axes are now closed, and the persistence layer holds a single pattern:**

| axis                  | question                                 | candidates | defects  |
| --------------------- | ---------------------------------------- | ---------- | -------- |
| service RMW           | what do two callers do?                  | 26         | 1        |
| multi-write           | what does one dying caller leave?        | 2          | 1 (same) |
| txn without isolation | does the transaction actually serialise? | 3          | 0        |

⭐ The pattern every sound site shares, across all three axes and regardless of
mechanism: **the first write is a claim, and its result is checked before anything
depends on it.** Row lock, conditional predicate, unique index, `RETURNING` on a
delete, `onConflictDoNothing` — the mechanism varies and the shape does not. The one
defect is the one place the claim comes last.

## 7p — the claim lens applied to claims themselves, and two duplicate-email guards closed

Three axes closed on persistence. The obvious next surface is the code that already
calls itself a claim: `claimBillingEmail`, `claimDue`, `claimSessionOperation`,
`webhooks-repo.claim`. Two of those were already proven in earlier fires; the other
two were read, and both are textbook — `claimBillingEmail` is
`INSERT … ON CONFLICT DO NOTHING … RETURNING` ("the row is returned only when THIS
insert won"), and the webhook claim is `SELECT … FOR UPDATE SKIP LOCKED → UPDATE
status = in_flight` with stale reclaim by `updated_at` age.

More importantly — the transfer lesson — **every caller reads the answer**: three
`if (!won) return;` in `account-lifecycle`, and the worker only delivers
`claimed.map(...)`. So the claim surface has no `transferProfile`-shaped hole.

**But the coverage counters split those five guards in half.** Each
`if (!won) return;` records the condition and its consequent separately:

    :247  evaluated 22 → loser fired 1   ✓
    :275  evaluated 14 → loser fired 0   ✗
    :401  evaluated  7 → loser fired 1   ✓
    :446  evaluated  2 → loser fired 0   ✗
    :494  evaluated  4 → loser fired 0   ✗

Three duplicate-suppression guards had never once refused — the same "runs but never
refuses" shape as the VPN dispatch re-guard in 7h. What they suppress is
customer-visible: a second onboarding email, a second receipt, a second
"payment failed" warning. **Stripe re-delivers events as a matter of course**, so the
loser branch is not an exotic path; it is what stands between a retried webhook and a
duplicate email.

Two of the three are closed here, and the model already existed: the C6 block proves
the same property for `subscription.renewal_reminder` by emitting the same event twice
and asserting one send. The new arms do that for `billing.payment_succeeded` and
`billing.payment_failed`.

⭐ Both arms also assert `repo.billingClaimCount === 2`, copying C6's discipline for a
reason worth restating: it proves the SECOND delivery actually **reached** the claim
and was refused BY it. Without that, a test could pass because something earlier
filtered the duplicate, leaving the guard as unexercised as before while looking
covered.

Measured per guard, since they are independent:

    payment_succeeded guard removed → its arm reds ("called 1 times, but got 2 times"), other 13 green
    payment_failed guard removed    → its arm reds, other 13 green
    novelty: 69 other lifecycle/billing files (772 tests) stay green under the mutation

**The third, `:275` in `handleSessionSuccessFirst`, is deliberately left open and the
reason is structural.** Its two calls cannot both reach the claim sequentially: the
first sets `firstSuccessEmailSentAt`, so the second returns at the _pre-check_ above
and never touches the claim at all. Reaching that loser needs forced interleaving —
both callers held past the read before either marks — which is the MFA-concurrency
technique from 7g rather than a second copy of the C6 pattern. Recorded as the next
slice rather than bundled in, because it is a different test, not a third arm.

## 7q — the third duplicate-email guard, reached by forcing the interleave

7p closed two of the three never-refused duplicate-suppressors and deliberately left
`:275` (`handleSessionSuccessFirst`) open, with the reason stated: a sequential retry
cannot reach it. The first call sets `firstSuccessEmailSentAt`, so the second returns
at the fast-fail PRE-CHECK and never attempts the claim at all. That is why its two
existing tests — "sends on first call" and "skips when the flag is already set" —
leave the branch beneath them at zero.

Only two callers that BOTH read the flag as null before either marks get there, which
is an ordinary double delivery of one lifecycle event. So the arm forces it: both are
held at `markFirstSuccessEmailSent` until the second arrives, which proves both
cleared the pre-check AND the preference check, over the existing faithful fake (it
refuses a second claim exactly as the conditional UPDATE does).

    guard present → one email, one claim winner
    guard removed → "called 1 times, but got 2 times" — the loser sends a SECOND
                    onboarding email for one session

⚠️ **The novelty run also redded a content-parity file**, and the distinction is the
one drawn in 7e: its assertion is
`expect(body).toMatch(/const won = await this\.repo\.markFir…/)` — a regex over the
source text. That is a deletion tripwire, and a good one; it is not evidence the
branch works, since it passes whether the guard is reachable or the loser is actually
refused. The line was text-protected; the behaviour was not.

⚠️ **`tsc` caught what vitest ran past, again.** Adding `sendSessionSuccessFirst` to
the email fake satisfied the runtime but not the `TestDeps` interface that declares
the fake's shape, so `npx tsc -p tsconfig.test.json` failed with TS2339 on a green
suite. Fixed, and then the mutation was RE-RUN afterwards to confirm the type change
had not weakened the arm — the same discipline as 7h, because an edit between "proved"
and "committed" can quietly do that.

**All three duplicate-email guards now refuse under test.** The set that started as
five, of which three had never fired, is closed:

    :247 first-failure  ✓ (pre-existing)      :275 first-success   ✓ (this fire, forced interleave)
    :401 renewal        ✓ (pre-existing)      :446 payment_succeeded ✓ (7p)
                                              :494 payment_failed    ✓ (7p)

## 7r — the decision list had stopped being one

The coverage instruments are saturated: a fresh cut this fire ranked every hot guard
whose refusal has never fired (condition ≥50 executions, consequent 0) and returned
49, of which the three security-relevant ones each decline on specific evidence —

- `oauth.ts:741` `if (a.length !== b.length) return false` — both callers pass
  sha256 HEX, so the lengths are equal by construction. Category 3.
- `stripe-signing.ts:98` `if (!Number.isFinite(n)) return null` — a malformed `t`
  would survive as `NaN` and skip the tolerance window, which looks alarming until
  the HMAC input is read: it signs `${parsed.t}.${rawBody}`, so `t` is BOUND. The
  request is still rejected, as `invalid_signature` rather than `malformed_header`.
  Same security outcome, different label.
- `profile-key-hierarchy.ts:71` UUID check — callers pass DB-sourced UUIDs, and a
  non-UUID would derive a different key and fail decryption anyway.

So the fire went somewhere else, and found something worth more than another guard.

**The "Open — needs a decision" section had stopped functioning as one.** Its header
claimed "Ten items … ordered by what it costs to keep waiting". It holds **36
numbered entries**, in arbitrary order, closed ones inline, and most entries above 20
are work RECORDS appended here rather than decisions anybody is waiting on. This
section is the interface between the engineering and the person who has to choose;
handing them a chronological log is a real defect in it.

Fixed by correcting the header to describe what the section actually is and adding
the index it used to imply — seven genuinely pending decisions, with the cost of
waiting for each. **Not** reordered: renumbering 36 entries would break every
cross-reference in this document, and the index gets a reader to the same place.

⛔ **Item 1's evidence had decayed 42%, in the direction that makes it look less
urgent.** The item says of itself: "the count is re-checked each time this item is
touched, because the evidence below decays with every commit that lands after it."
It had not been re-checked:

    doc claimed:  1,068 commits ahead, upstream tip "nineteen days" old
    measured now: 1,515 commits ahead, upstream tip 34 days old

Both refreshed. ⭐ **A self-describing decay warning is not a mechanism.** The item
knew its own number would rot and said so, and it still rotted, because nothing
re-ran the command. The number is one `git rev-list --count @{u}..HEAD` — the fix is
to run it when touching the section, which is now recorded in the item itself.

Finally, the transferProfile defect is added as **item 37**, with its reproduction,
its cost of waiting, and the sized recommendation from 7n. It had been sitting in the
chronological log at 7l where a decision-maker would never find it.

## 7s — auditing the index I had just written

7r built an index of pending decisions and refreshed item 1's decayed count. An index
is only worth having if its rows are true, so each was checked against the tree rather
than against the prose that produced it. Five held; one did not, and it was mine.

- **Item 2 — current.** `AuditArchiveService` and `WebhookSecretForceRotationService`
  have **zero** mentions in `bootstrap.ts`; the sibling `WebhookGraceExpiringNoticeService`
  has two. That is exactly the asymmetry the item describes — the half that warns
  about expiring grace windows runs while the half that opens them does not — and
  `tick-services-are-wired-invariant.test.ts` still pins it.
- **Item 6 — current.** `CreateProfileRequestSchema` is a plain `z.object` (not
  `.strict()`), so unknown keys are stripped, and `archetype` is `.optional()` with a
  documented default. A mistyped field therefore yields 201 with the default
  substituted, as claimed.
- **Item 3 — NOT a pending decision, and I had listed it as one.** Its first bullet is
  CLOSED: the retention line was reworded, and the correction reaches **both** published
  copies (`docs/legal/privacy-policy.md` and `apps/marketing-site/.../privacy.md`).
  Better, the parity test now pins the corrected sentence positively AND carries
  `expect(body).not.toMatch(/revoked records retained 90 days for audit then deleted/)`
  — so the false promise cannot return the way it originally froze. Its second bullet
  resolves once item 2's archiver runs. Row removed.

⛔ **The removal failed the first time, and my check confirmed the failure as success.**
Prettier had realigned the table on commit (`| 3 | …` → `| 3    | …`), so the
exact-string replacement matched nothing — and the `grep -c` I used to verify reused
the _same_ unpadded pattern, returned 0, and read as "row is gone". It was still
there.

⭐ **A verification that reuses the pattern that just failed proves nothing.** Check
with a different shape than the one that did the work: here a regex on the row's
CONTENT (`^\|\s*3\s*\|\s*Two retention-table`), plus an assertion that exactly one line
disappeared, plus printing the surviving row numbers. Three independent signals, none
of which shares the assumption that broke.

Pending decisions now read 1, 2, 6, 7/8, 9, 37 — six, each verified.

## 7t — finishing the freshness audit, and a grep that pointed the wrong way

7s verified items 2, 3 and 6. Items 7/8 complete the checkable set — item 9 is about
the founder's machine and the release path, not a measurement this repo can refresh.

**Items 7 and 8 — current, and the verification nearly went wrong.** The item claims
both policies are "pinned by their own tests so they stay visible". The API-key half
is obvious (`tier-features`, `agent-sessions-tier-gate`). For the OAuth half I grepped
`routes/auth-oauth-client.ts` and `services/oauth.ts` for any mention of tier, found
**none**, and was one step from recording that the consent path has no tier gate — that
a free-tier account may consent and nothing pins it.

Reading the test instead of trusting the grep:

    const freeAttempt = await app.inject({ … '/v1/oauth/authorize/complete' … });
    expect(freeAttempt.statusCode).toBe(403);
    expect(freeAttempt.json<{ detail: string }>().detail).toContain('apiAccess');

The gate exists and is pinned. It simply is not in the OAuth files, because it is
enforced centrally: `middleware/auth.ts:144` calls
`requireTierFeature(ctx.account.tier, 'apiAccess')` inside `requireAuth`, so every
authenticated route inherits it and none of them mentions a tier.

⭐ **Grepping a feature's own files for its gate finds nothing when the gate is
central.** The absence of a keyword in the handler is evidence about where the check
lives, not about whether it exists — and the two readings point in opposite
directions. The cheap disambiguation is to look for the OBSERVED behaviour (a test
asserting 403) before concluding from the absence of a keyword.

**Freshness audit complete.** Of the six pending decisions, five carry checkable
evidence and all five now read true against the tree — item 1 after being refreshed
from a 42% decay, items 2, 6 and 7/8 as written, and item 3 removed because it was
not pending at all. Item 9 stands on its own terms.

⚠️ Recorded because the pattern is now three-for-three this session: **every time I
have inferred a gap from what a grep did NOT find, the gap was somewhere else.** The
V-174 alias (found via coverage counters, not names), the `resetForTest` scope (found
by reading the enclosing class), and this tier gate (found by reading a test). A
negative grep result is a hypothesis about location, and it is a weak one.

## 7u — the revocation backstop that had never fired

The hot-guard cut in 7r used a ≥50 threshold on the condition. The 5–49 band was
never looked at; mining it for security/money consequents returns 10, and the first
is the strongest find since the VPN dispatch re-guard.

`auth-cache.ts` `RedisAuthCache.get()` checks two generations in order:

    :364  if (currentAccountVersion !== entry.accountVersion) return null;   evaluated 7 → fired 1 ✓
    :368  if (currentKeyVersion !== entry.keyVersion) return null;           evaluated 7 → fired 0 ✗

The second is V-247's key-generation gate, and it is the **revocation backstop**.
`invalidateKey` normally deletes the entry outright through the reverse index, and
that path is covered. This gate is what still catches a revoked key when the delete
did not happen — which the cache's own contract makes reachable: _"any Redis error
during get/set/invalidate is logged and treated as a no-op."_ A failed delete
alongside a successful INCR leaves exactly this state, and without the gate the
revoked key keeps authenticating from cache until the 30s TTL expires.

**Why it had never fired is the interesting part.** One existing arm does reach this
area — "tags a late write with its captured account and key generations" — but it
bumps BOTH generations, so the account gate one line above returns null first and
execution never arrives at the key gate. Two gates, one test, and the test can only
ever exercise the first.

So the new arm moves **only** the key generation, and asserts the account generation
is still absent:

    expect(redis.values.get('auth:account:acc-security:v')).toBeUndefined();
    expect(redis.values.get(entryKey())).toBeDefined();     // the entry is still cached

That makes the account gate incapable of producing the null and the entry's absence
incapable of it either, so the refusal can only be the key gate. A precondition
assertion checks it was a HIT before the revocation — without that, the miss
afterwards would prove nothing.

    guard present → miss after the key INCR
    guard removed → "expected { account: { … } } to be null" — the revoked key's
                    cached context is served

⚠️ The novelty run also redded `services-auth-cache-content-parity`, whose assertion
is `expect(body).toMatch(/const currentKeyVersion = keyVersionR…/)` — a regex over
source text. Same verdict as every previous instance: a deletion tripwire, not
evidence the gate works. The line was text-protected; the behaviour was not.

⭐ **Two gates in sequence need two tests, and the second one has to disable the
first.** This is the third instance of the shape this session — the V-174 alias pair,
the MFA sequential-vs-concurrent replay pair, and now the account-vs-key generation
pair. In every case the covered sibling sits EARLIER in the function and short-
circuits, so the later gate is unreachable by the obvious test. The tell is always the
same: a condition and its consequent with different counts.

## 7v — consent freshness, and a demonstration that a text pin cannot see a disabled guard

Second find from the 5–49 band. `oauth-store.ts` `consumeAuthorizationForCode`
compares the stored `created_at` against the caller's `not_before` and, when the grant
is older, DELETES it and answers `'expired'` — so a stale consent can neither mint a
code nor be retried. Coverage:

    :152  if (authorization.createdAt.getTime() < args.not_before) {   evaluated 1
    :156      return 'expired';                                        fired    0

No test had ever presented an authorization older than the window, on the production
store. Delete the check and a stale grant mints a live authorization code, which is
what a freshness window on consent exists to prevent.

The new arm seeds the grant an hour in the past and sets `not_before` after it, with
the client bound to the SAME account that consumes it — so age is the only reason to
refuse, and the binding check from 7e cannot be what answers. It asserts the verdict,
that no code was minted, AND that the authorization is gone (the source deletes on the
expired path, so a stale grant cannot be retried).

    gate present → 'expired', 0 codes, 0 authorizations left
    gate removed → "expected 'inserted' to be 'expired'" — the stale grant minted a code

⭐ **The novelty run demonstrated the parity-pin blind spot outright, rather than by
argument.** Every previous mutation this session tripped a content-parity file, and I
have each time recorded that such a red is a deletion tripwire rather than evidence.
This mutation was `if (false && authorization.createdAt.getTime() < args.not_before)`
— semantically dead, textually intact. **No parity file redded.** 50 oauth test files
and 522 tests stayed green while the freshness gate was disabled.

That is the clearest possible statement of the limit: a regex over source text sees
deletions and cannot see disablement. The guard's own text survived, and only a
behavioural arm noticed the behaviour was gone. Where a security property matters, the
text pin is the tripwire and the behavioural arm is the proof — and this fire produced
a case where the tripwire was silent by construction.

## 7w — correcting 7v, and the top rung of the invalid_grant ladder

### The correction first, because I published the over-claim

7v concluded, from one mutation, that "a regex over source text sees deletions and
cannot see disablement". That is **too strong, and the same technique disproved it one
fire later.**

Mutating `exchangeCode`'s top rung the same way —
`if (false && code === null) throw new OAuthError(…)` — **did** red a content-parity
file (`services-oauth-content-parity`), because inserting `false && ` changes the text
the pin matches. A pin over the exact line catches that fine.

The reason 7v saw silence is narrower and duller: **no parity file pins that line.**
Checked directly — `grep -rn "not_before"` across every content-parity and
cross-source-invariant test returns nothing. The freshness gate in `oauth-store.ts` is
simply unpinned.

So the accurate statement is:

- a text pin catches **any change to the text it pins**, including a `false &&`
  insertion;
- it cannot catch a semantic change that leaves the pinned text **intact** — the
  guard becoming unreachable because an earlier branch short-circuits, a caller
  ceasing to call it, or a flag elsewhere flipping;
- and it says nothing at all about a line no pin covers.

7v's demonstration showed the third case and I wrote it up as the second. The
practical advice survives — prefer a text-preserving mutation when measuring
behavioural coverage — but the reason is that it isolates _which_ signal fired, not
that pins are structurally blind.

### The find: the only uncovered rung in a fully-covered ladder

`OAuthService.exchangeCode` rejects with `invalid_grant` for five distinct causes.
Per-rung coverage:

    code === null            evaluated 36 → fired 0   ✗
    already exchanged        evaluated 36 → fired 1   ✓
    different client         evaluated 35 → fired 1   ✓
    redirect_uri mismatch    evaluated 34 → fired 1   ✓
    PKCE failed              evaluated 33 → fired 1   ✓

The ladder was tested systematically and the first step was missed. All five causes
ARE pinned by `oauth-v667-service-cross-source-invariant` — but that pin asserts the
`throw` statements exist in the source, which cannot tell whether any is reachable.

Delete the check and `code` is null at the next line, so `code.consumed_at` throws a
TypeError: the token endpoint answers **500 where RFC 6749 requires `invalid_grant`**,
and an unknown code becomes distinguishable from every other rejection by status
alone. Measured exactly that:

    guard present → invalid_grant
    guard removed → "expected TypeError: Cannot read properties of null… to match
                     object { code: 'invalid_grant' }"

## 7x — the mutation operator was a no-op, and a rate limit that had never refused

### The instrument first, because it nearly cost a retraction

Guards are disabled here with the text-preserving edit `if (COND)` → `if (false && COND)`, chosen so
the surrounding source text (and therefore every content-parity pin over it) stays intact.

**That edit is wrong whenever `COND` contains `||`.** `&&` binds tighter than `||`, so

```
if (false && !isRecord(webSession) || typeof webSession.id !== 'string')
```

parses as `(false && A) || B`. Clause `B` is still live, the guard still refuses, the arm still passes,
and the run reports a confident **"0 arms red"** — which is indistinguishable from a real finding.

It produced two false zeros in one fire. The conclusion already drafted from them — that two
validation rungs were structurally redundant defence in depth — was wrong. Wrapping the condition
(`if (false && (COND))`) made one of the two red its arm immediately. The arm had been correct all
along; the instrument was broken.

This is a **fourth cause of a zero-red**, and it belongs ahead of the other three (uncovered /
structurally unreachable / layered behind a sibling): it is the only one that is a defect in the
measurement rather than a fact about the code. Rule it out first. The general defence is a positive
control — confirm the mutated build changes _some_ observable behaviour before believing it changed
nothing.

### `isCurrentCachedEntry` — five rungs that had never refused

Eight structural rungs validate a cached auth envelope before any version read; only three had ever
rejected anything. Five arms were added, each asserting the read resolves null **and** that no version
`mget` was issued, so each proves the schema gate refused rather than a later check reaching the same
result.

Four of the five isolate their rung under mutation. The fifth does not, and the reason is a property
of the ladder rather than of the test: every input that fails _"account is not a record"_ also fails
the next rung, _"account id is not a string"_, because a non-record yields an `undefined` id. No
JSON-representable envelope can fail the first without failing the second. That line is
unreachable-by-refusal defence in depth; its arm is retained for the behaviour it does assert, and is
recorded as **not** evidence for that line.

The webSession arm carries an explicit `mfaSatisfiedAt: null` for the same reason — without it the
following rung rejects the `undefined`, and the arm would pass with its own rung disabled.

### The internal atlas-priority per-token rate limit had never refused

`/v1/internal/atlas-priority/*` applies a per-token rate limit as defence in depth: even behind a
valid bearer gate, a leaked token could otherwise drive unbounded calls. **No test referenced it at
all** — not the bucket key, not the capacity constant, not the 429. The refusal branch ran on every
internal request and had never once fired, so a regression that stopped enforcing (wrong capacity,
cost 0, result discarded) would have been invisible.

Capacity is 1000, so exhausting the bucket by volume is impractical; the arms inject the store, which
also makes two further properties observable. Six arms, each mutation-proved against the property it
names:

| mutation                       | arms red |
| ------------------------------ | -------- |
| refusal branch disabled        | 3        |
| bucket key = plaintext token   | 1        |
| Retry-After rounds down        | 1        |
| Retry-After floor of 1 removed | 1        |
| auth moved after the limit     | 1        |

The refusal arms assert the repo is never touched, which separates "the limit refused" from "something
later refused anyway"; a positive control asserts an allowed request does reach the handler, without
which every refusal arm would still pass if the route refused unconditionally. One arm pins a claim
the source comment makes but nothing enforced: the bucket key is a SHA-256 prefix and never the
plaintext token — a bucket key is logged and Prometheus-labelled freely, so a plaintext leak there
spreads the credential everywhere the key travels.

### Examined and deliberately not covered

- **The empty-token early `return` in the same preHandler is unreachable.** Any header satisfying
  `validate()` carries a token whose length equals the configured token's, and the constructor maps an
  empty configured token to `null`, which disables auth outright. Worth recording that this `return`
  _skips the rate limit_ rather than rejecting — were it reachable it would be a bypass. It is not.
- **`admin-owner.ts:201`** (`if (!ctx) throw`) is crash-category: delete the guard and the next `ctx.`
  access throws anyway. It improves a message; it does not change an outcome.
- **The IP rate limiter's degradation path** (primary → bounded in-process fallback → fail closed) is
  already covered by three dedicated files. Grepped before investigating; no re-derivation.

## 7y — the best-effort lens, mapped and mostly exhausted

### The shape

A best-effort side effect is an awaited call inside a `try` whose `catch` swallows rather than
rethrows. The durable write has already committed; the follow-up — a cache invalidation, a webhook
enqueue, an audit record, a lifecycle emit — is deliberately swallowed so an outage in a _secondary_
dependency cannot fail an operation that already succeeded.

Nothing about that is wrong. What kept being missing is a test proving the swallow, because on the
happy path both behaviours are identical and every existing fixture supplies a dependency that
resolves. Five such gaps closed across four fires: the api-key and web-session cache writes, logout
and rotation cache invalidation, the audit emit, and session destroy.

### The map

Enumerated repo-wide: **181 sites**. Ranking them by whether any test anywhere makes that dependency
method fail leaves a **19-site work-list**; the other 162 sit around methods some test does fail
somewhere, which is not proof for a given site but is enough to deprioritise it.

The ranking is a **proxy, not a verdict**, in both directions:

- False negatives are the reason it exists — a method failed in one test may never be failed at the
  site in question. All three session-destroy swallows sat behind methods that other tests do fail,
  and all three redded nothing.
- False positives are common — the entitlement sweeper's `downgradeAccountTierToBestRemaining` looked
  unfailed, but its isolation arm induces the failure through a repo override rather than a
  rejection near the call site.

Only mutation settles a site. The ranking exists to choose which sites to spend a mutation on.

### What this pass found

`sessions.ts` destroy fans out three best-effort side effects. Rethrowing the webhook catch redded 0
arms across 134 session files and 1605 tests; the lifecycle catch likewise. A rethrow there would fail
`DELETE /v1/sessions/:id` for a session that is already gone — the one outcome a caller cannot correct
by retrying. Closed with a single arm that fails all three sinks at once and asserts each was reached.

### Sampled and already covered — recorded so they are not re-investigated

| site                                         | what covers it                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `destroyAllForAccount` per-session isolation | "is best-effort per session — one driver failure does not block the rest"         |
| `autoDestroyExpired` reaper emissions        | the deliberate `session.completed` omission is pinned in two named files          |
| agent-session BYOK hydration degrade         | a dedicated file: "still returns 201 (degrades, no 500) when getPlaintext throws" |
| crypto entitlement expiry sweeper            | "one account failing is isolated — the failed rows stay unprocessed"              |

Four consecutive candidates already covered is the signal that this lens is near exhaustion in the
well-tended services. The remaining 19-site work-list is the place to spend the next mutations, not
another sweep of the same shape.

## 7z — three lenses swept, three clean negatives, and the instrument that earned the zeros

A sweep returning nothing is only worth as much as the instrument behind it. All three of these were
validated against a known positive before their zeros were believed, and every run printed its
denominator.

### Lens 1 — security predicates that DIVERGE between copies

Motivated by the expiry finding: one rule in four copies, two of which nothing held consistent.
Generalised to "wherever a security predicate is written more than once, do the copies agree?"

The instrument took three iterations, and the first two failures are the useful part:

- **v1** bucketed by identifier names, so the four `X.expiresAt.getTime() <= now` copies — different
  subjects — landed in four buckets and were never compared.
- **v2** normalised identifiers but kept operators inside the grouping key, so two copies differing
  ONLY in operator got different keys. That is precisely the case the lens exists to find.
- **v3** normalises identifiers AND operators into the key, preserves the FIELD name so unrelated
  subjects do not collide, then reports groups whose original operators are not uniform.

Self-test: inject a copy of a real expiry predicate with a flipped operator; the scan must flag it.
It does. **Result: 225 predicates, 114 distinct shapes, 35 written more than once, 3 groups with
operator differences — all three benign** (an inverse branch, a shared helper applied to different
subjects, and a mint-time versus authenticate-time device-key rule that are complementary rather than
divergent).

The architectural reason for the zero is worth recording: security rules here are factored into named
helpers (`callerCanAccessAgentSession`, `isCryptoTierUpgrade`, `requireTierFeature`) rather than
duplicated inline, so there is little surface for drift. The expiry comparison was the exception.

### Lens 2 — defaults that fail OPEN

Patterns where an absent or unknown value resolves to allow: `?? true`, `|| true`, `!== false`,
`? true :`, `default: return true`. **One hit in the whole server**, and it is written defensively:

    origin: deps.permissiveCors === true ? true : corsOriginMatchers(deps)

An explicit `=== true`, so anything other than exactly `true` falls to the allow-list. Bootstrap then
calls `assertCorsPosture`, which THROWS when permissive CORS is combined with production. Mutation:
disabling the throw reds 1, inverting the environment test reds 4, and removing the call from
bootstrap entirely reds 1. Covered in its logic and in its wiring.

### Lens 3 — guards whose CALL SITE is unpinned

A distinct failure mode from either of the above: the guard is correct and tested in isolation, but
nothing notices if its call disappears. 77 statement-position guard calls across 29 functions; the six
highest-consequence call sites were tested by deleting the call:

| call site                                                             | arms red |
| --------------------------------------------------------------------- | -------- |
| `assertNotDeviceKey` at API-key mint                                  | 1        |
| `assertNotDeviceKey` at API-key rotate                                | 1        |
| `requireScope('driftstack_internal_admin')` ×2 in admin force-actions | 2 each   |
| `requireProgrammaticApiAccess` in the auth middleware                 | 2        |
| `assertCorsPosture` in bootstrap                                      | 1        |

All pinned. The remaining 71 call sites are unmeasured and are the obvious continuation.

### Process note

A mutation loop that is killed mid-measurement leaves the tree dirty — a timeout during this sweep
left `auth.ts` mutated, caught by the tree check rather than by the loop. Restores now run from an
`EXIT`/`INT`/`TERM` trap so the restore survives the kill, and the tree is checked against HEAD after
every sweep regardless.

## 8a — the call-site sweep continued: twelve sites, no gaps, and two false alarms of my own

Continuing 7z's third lens. A harness now drives it (snapshot, delete the call line, run a scoped
suite, restore from an `EXIT`/`INT`/`TERM` trap, verify the tree against HEAD).

### Results

| call site                                                   | arms red                      |
| ----------------------------------------------------------- | ----------------------------- |
| `requireTierFeature` vpnEgress, account-me route ×2         | 1 each                        |
| `requireTierFeature` apiAccess, oauth route                 | 3                             |
| `requireTierFeature` aiAgent, agent-sessions route          | 4                             |
| `requireTierFeature` vpnEgress, account-proxies **service** | 3 (see below)                 |
| `requireBundledLlmTier`, bundled-llm route                  | 1                             |
| `verifyBootEncryptionKey`, agent-sessions repo              | 1                             |
| `requireCtx`, session-proxy route                           | 0 — no observable consequence |
| `assertAgentMessageAdmissionCurrent` at the first of three  | 0 — layered                   |

Added to 7z's six, that is **fourteen call sites measured, zero unenforced**.

### Two zeros of mine that were not gaps, and what each teaches

**The scope was wrong, not the coverage.** `account-proxies.ts:102` is the dispatch-time VPN
entitlement backstop — its own comment says an unentitled account cannot egress "even if the
create-time check is ever bypassed or removed". Removing the call redded **0 of 96** under a
`proxies` filter and **3 of 742** under a wider one. A non-vacuous run can still be the wrong
population: the denominator proves tests ran, never that the right ones did. Every zero is now
re-measured at full-suite scope before it is called anything.

**No observable consequence.** `requireCtx(req)` in the session-proxy route discards its result inside
a handler typed `never` — the deployment does not expose that backend, so the handler throws
regardless. Confirmed at 22,403 tests. Nothing can make its presence observable, and an arm claiming
to cover it would be theatre.

**Layered, deliberately.** `assertAgentMessageAdmissionCurrent` is called three times in sequence;
removing the first leaves the second to refuse the same input before any credential, spend or provider
dependency is touched. The behaviour is covered, the individual line is not attributable, and the
sequence is what the source comment describes.

### Instrument note

The sweep's first run reported three VACUOUS results because zsh does not word-split an unquoted
expansion, so a multi-word vitest filter arrived as one literal string matching no files. The
denominator check turned what would have been three false gaps into three obvious instrument failures.
`${=filter}` fixes it.

## 8b — the size/bound guards, and one that cannot fire

Sixteen call sites of the size and bound guards (`assertTotpSecretLength`, `assertBoundedUtf8`,
`assertSecretBytes`, `assertStringWithinLimit`) had never been measured. These are DoS and allocation
bounds, several of them over model-supplied content, so they are the guards whose absence matters
most. Removing an assert only stops it rejecting — nothing allocates — so mutation is safe here, unlike
removing a cap that then allocates.

### Results

| call site                                           | outcome                           |
| --------------------------------------------------- | --------------------------------- |
| `assertTotpSecretLength` (mfa-totp)                 | 1 red — pinned                    |
| `assertStringWithinLimit` (decomposer refuseReason) | 1 red — pinned                    |
| `assertBoundedUtf8` (livekit nodeId)                | 2 red at full scope — pinned      |
| `assertSecretBytes` on ENCRYPT                      | 1 red — pinned                    |
| `assertSecretBytes` on DECRYPT                      | 0 red at 22,405 tests — see below |

### The decrypt-side check cannot fire, and the reason is arithmetic

The obvious reading of that zero is the asymmetry pattern: one rule, two copies, only one pinned. It
is not. GCM ciphertext length equals plaintext length exactly, so a stored blob is always
`IV(12) + TAG(16) + plaintextLen` bytes, and `decryptPayload` already bounds the blob on both sides:

    blob.length < 12 + 16 + 1                     rejects plaintextLen < 1
    blob.length > 12 + 16 + MAX_API_SECRET_BYTES  rejects plaintextLen > MAX

Those two prechecks ARE the plaintext bounds. `assertSecretBytes(plaintext)` on the decrypt path can
never fire, and an arm aimed at it passes for another reason — both candidate inputs were caught by the
blob prechecks, with the wrong error message, which is how this was discovered rather than argued.

The call is not useless: the equivalence holds only while the framing keeps ciphertext length equal to
plaintext length. Padding, a different mode, or a compressed payload would break it and leave that
check as the only bound. It is defence against a future change, and it is recorded here rather than
covered, because no input can distinguish its presence today.

### Scope lesson, again

Two of these read zero under a plausible keyword filter and were pinned at full scope. Narrow filters
keep producing false gaps in this codebase because the covering test is often in a file whose name does
not contain the module's keywords. Every zero now gets a full-scope re-measure before it is called
anything — that rule has now corrected four would-be findings.

## 8c — the bare-throw lens: large population, low yield here

Last pass produced a rule worth testing at scale: an arm aimed at a decrypt-side length check failed
with the WRONG error message, because upstream prechecks refused both candidate inputs first. A bare
`.toThrow()` would have passed and shipped a test that proves an upstream check while naming this one.

Census: **270 bare `.toThrow()` and 57 bare `rejects.toThrow()`** in the suite. Most are legitimate —
a function with one failure mode needs no message. The risky subset is a bare throw under a title that
names a specific reason: **55** of those in security-relevant files.

Four were probed by disabling the guard each one names:

| arm                                  | probe                        | result                                                                            |
| ------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------- |
| recipes: "rejects record relocation" | drop `recipeId` from the AAD | 1 red — genuinely tests the id binding                                            |
| MFA migration: wrong-key rejection   | —                            | sound; the real claim is carried by exact neighbours (`scanned: 0, converted: 0`) |
| proxy secret: canonical-shape guard  | disable it                   | 1 red                                                                             |
| proxy secret: canonical-base64 guard | disable it                   | 2 red                                                                             |

**All four sound.** The pattern that makes a bare throw safe is visible in the MFA case: the throw is
one assertion among several, and the substantive claim — that a failed migration wrote nothing — is
carried by exact counts rather than by the throw.

### Disposition

Not worth a sweeping change. Converting 270 assertions would be churn with a low hit rate, and the
looped bare throw over four malformations in the proxy-secret file — the shape most likely to hide
layering — was individually attributable when measured. The rule is recorded for review time instead:
if a title names a reason, pin the reason; if several malformations share one bare throw, disable each
guard in turn and check that each reds something.

### 33. A customer-breaking rotation rule was pinned only by a text pin

`DrizzleWebhooksRepo.rotateSecret` carries the V-359.G.2 exception: a customer rotation
that lands INSIDE a live force-rotation window must keep the customer's own live secret in
the dual-sign grace slot. `secret` at that moment holds the SERVER's force-rotated value,
which the customer only ever received as a 12-character prefix and never deployed, while
`secret_prev` holds what they actually have running. Move the current value across in the
normal way and the worker dual-signs `{new, force}` — and **both fail the customer's
verifier**, which is still on the original. Every delivery to that endpoint fails signature
verification until someone notices.

The rule is a `CASE` inside raw SQL, so no fake-repo test can reach it. Removing it redded
exactly **one** test — and that test was the module's **content-parity pin**, which fires on
the source text changing rather than on the behaviour. A red from a text pin is not
coverage: the rule was behaviourally unpinned, and any rewrite that changed the text while
changing the meaning would have been signed off by a green suite.

Now pinned against real Postgres, both branches: inside a force window the grace slot keeps
the customer's deployed secret and never the force value; outside one, the ordinary rule
still advances `secret` into `secret_prev`. Proved two ways — removing the exception, and
making it unconditional — each reds a different arm.

⚠️ Writing it surfaced a second thing worth recording. The control arm initially left a live
CUSTOMER grace window open, and V-359.G refuses a second customer rotation in that state, so
the control was refused by a DIFFERENT guard and proved nothing about the `CASE`. The tell
was the control failing while the arm under test passed. `rotateSecret` returns the
**unchanged row** rather than null on that miss, so a `not.toBeNull()` assertion passes
through a refused rotation — the value has to be read back and compared.

### 34. "Log out my other devices" had its account boundary held by text pins only

`DrizzleAuthFlowsRepo.revokeAllWebSessionsExcept` is what the bulk web-session
revoke runs. Three predicates carry the whole security of that action:
`eq(accountId)` is the cross-account boundary, `ne(id, exceptId)` keeps the
caller's own session alive, and `isNull(revokedAt)` limits the sweep to live rows
so the returned count is honest.

**Every reference to it in the test corpus was a regex over source text** — the
repo content-parity pin, the v079 cross-source invariant, the route pin and the
service pin — plus an in-memory fake. Dropping each predicate in turn redded only
those pins and the two typecheck guards (the dropped parameter goes unused).
Nothing anywhere drove the method against a database holding two accounts.

The consequence of the first predicate regressing is not subtle: one customer
pressing "log out my other devices" would revoke **every web session on the
platform**. And because the guards that noticed were text pins, a rewrite that
updated the text while dropping `eq(accountId)` — exactly what a refactor does —
would have shipped behind a green suite.

Now covered against real Postgres with a bystander account: the victim's other
two sessions are revoked, the caller's own survives, the bystander's two are
untouched, and a second call returns 0. Proved by mutating each predicate, with
the identifiers kept REFERENCED so the typecheck guards could not answer in the
behaviour's place — the first attempt did exactly that and had to be redone.

_How it was found:_ classifying every public repo method by where it is named in
the test corpus. 285 methods → 19 whose only references are fakes and text pins,
4 named by no test at all. Same lens that found item 2's force-rotation query.
