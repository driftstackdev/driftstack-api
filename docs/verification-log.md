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

## V-1500 — six list endpoints picked a page size and did not publish it

Thirteen list routes apply `.default(50)` to `limit`, so omitting the parameter returns fifty rows. Six
published `{ type: integer, minimum: 1, maximum: 100 }` and nothing else. A caller reading that cannot
tell what they get, and a generated client leaving the parameter unset is choosing 50 rather than
"everything" — which is the reading the published schema invites.

**The split was mechanical, not arbitrary.** Every endpoint that publishes its default reaches the
document through the api-types schema itself — `/v1/profiles` uses `PaginationQuerySchema` directly, and
the default comes with it. Every endpoint that lost it goes through a hand-written mirror in
`openapi.ts`. That is V-1479's finding one keyword over: the mirrors drop what the schema carries, and
they drop it silently because there is nothing on the other side to compare against.

Fixed: `/v1/account/audit-log`, `/v1/admin/accounts`, `/v1/admin/api-keys`,
`/v1/admin/rate-limit-overrides`, `/v1/admin/sessions`, `/v1/recipes`.

**Three censuses, and only the third was worth acting on.** The first keyed zod defaults by FIELD NAME
across the whole tree and reported 22 — the collision trap this session has hit repeatedly, since one
schema declaring `limit: ….default(50)` makes every `limit` anywhere look defaulted. Scoping to each
route's own file gave 4. Extending to schemas declared in `api-types` rather than in the route file — the
under-report the second scan introduced — gave 6, which per-route verification confirmed one at a time.

22 → 4 → 6 is the useful shape: the first number was wrong by over-matching, the second by
under-matching, and neither error announced itself. Only enumerating the twenty published `limit`
parameters and tracing each to its declaration settled it.

**Seven endpoints correctly publish no default**, and each is exempted with the declaration that shows
it: `atlas-priority/queue` and `admin/status-subscribers` declare `.optional()` with no default in their
route files, `ListIncidentsQuerySchema` has none (covering both the admin and public incident feeds),
and the three crypto rails declare `.optional()` alone. Traced rather than inferred from absence — the
mistake V-1476 recorded, where "no zod default visible" was read as "no default applied".

**Two negatives measured on the way, so the family is not re-swept.** Extending V-1498's insight to the
other zod constructs that fail to reach JSON Schema found nothing: no `superRefine`, no `preprocess`,
one `transform` on an internal route, and all three `.catch()` hits were Promise catches rather than
zod's — a fire-and-forget touch and an SSE cleanup. All sixteen `z.coerce` sites are query parameters,
where coercion is correct because query values arrive as strings. Separately, the five hand-validated
request bodies from V-1478 all publish their constraints correctly: `byok` publishes `minLength: 1`
matching its hand check, and `profiles/{id}/transfer` publishes the account-id pattern.

Two mutations. Stripping the new default from `/v1/admin/sessions` reds the arm naming it; adding one to
an exempt endpoint reds the staleness half, so an exemption cannot outlive the condition that earned it.
`prettier --check` run on source and pins before committing, per V-1498.

## V-1501 — the response guard was reading the minority idiom, and green on a defect of its own class

`POST /v1/admin/status-subscribers/{id}/force-unsubscribe` published `{ ok: true }`, required. The
handler has never sent it:

```
published   { ok: boolean(true) }        required: [ok]
sends       { message: 'Subscriber force-unsubscribed.', email: string | null }
```

A caller typed from the document reads `.ok`, gets `undefined`, and cannot reach either real field —
they are outside the generated type entirely. This is the third instance of V-1072's exact defect, and
two guards already pin the handler's real shape, so as with the original two the server was never in
doubt; only the published contract was.

**The interesting part is why V-1072 did not catch it.** Its scan reads the handler's returned object
literal — matching `return {`. That is the MINORITY idiom in this codebase. 145 of roughly 250
registrations answer with `reply.send({ … })` or `reply.code(200).send({ … })`, and every one was
dropped before any comparison.

They were dropped by a `continue` that never incremented the skip counter. So the arm whose stated job
is to keep the blind spot honest — _"the skip count is asserted rather than hidden … pretending
otherwise is how a scan reports confidence it has not earned"_ — reported 32 skips against a real blind
spot of 177. The instrument was truthful about the skips it knew about and silent about the larger set
it never reached.

**Measured, not argued.** Restoring the defect and running the guard exactly as HEAD has it: all four
arms pass. The guard was green on the defect it exists to catch. With the extractor extended, the
finding arm reds naming the route. That is the proof the extension is load-bearing, and it is the
reason to state coverage as a judged population rather than as a passing suite.

Judged population 61 → 83. Skip count 32 → 147, which is not a regression: it is the first honest
number this guard has reported.

**One route left the judged set, and that is the fix working.**
`GET /v1/agent-sessions/{id}/downloads/content` answers with a binary `Buffer` on success and JSON only
on its error paths, so the old scan was comparing a file download against its own error shapes. A send
whose argument is not a literal now disqualifies the handler rather than contributing a partial keyset —
a partial keyset does not produce silence, it produces invented findings.

**Two instrument risks found by looking rather than by trusting the count.** A bare `.send(` also
matches `socket.send(data)` in the fleet-events stream, and would match any mailer or queue client that
borrows the verb; the extractor is anchored to a `reply` receiver, and an arm pins that
`socket.send({ id, kind })` yields nothing. The chain form had to be handled explicitly —
`reply.header(…).code(201).send({ … })` — since matching only `reply.send(` would have missed most of
the population it was added for.

**The consumer, checked rather than assumed.** `apps/admin-panel` calls this endpoint, so a fictional
contract could have been a live bug. It is not: the page reads `response.ok` — the HTTP status — and its
comment says the body is deliberately unused so a malformed body cannot make an operator repeat a
completed force-unsubscribe. No behaviour changes here.

Its test double did answer `json({ ok: true })`, though, copied from the published schema. Corrected to
the shape the server sends. The page ignores the body either way, so this fixes nothing at runtime — but
a double written from the document is precisely how the document's fiction survives a test suite, and
that artifact was the last thing in the repo asserting `ok`.

## V-1501b — an empty published body, and the Python SDK that had none of this session's constraints

Two findings, one chain: `openapi.ts` → `openapi.json` → `models.py`. The first is the last link of
V-1501's family; the second is the link after it, which nothing was checking at value level.

### The response the document declined to describe

`POST /v1/agent-sessions/{id}/input-event` published `{ type: object, properties: {} }`. Not a wrong
field — no fields. A generated client gets a type with no members, so every field the server sends is
unreachable, which is worse than naming the wrong one because there is nothing to be wrong about.

The shape was never unknown. `SendInputEventResponseSchema` has declared the real discriminated union
in api-types since Slice 5, both hand-written SDKs carry it, cross-surface parity guards pin the Go
struct and the TypeScript signature, and the route's own OpenAPI **description** spells it out in
prose: _"Discriminated by 'kind'. 'pair-mode-takeover-fired' … carries pair_mode_state. 'forwarded' …
carries duration_ms."_ Every reader was served except the machine one — the V-1498 pattern, now on the
response side. The registration now uses the api-types schema and publishes both `oneOf` branches,
matching the handler's two `reply.code(200).send({…})` bodies exactly.

A fifth arm catches the class. Its exemptions are derived, not listed: a route absent from the spec is
someone else's decision (`a-route-in-neither-the-spec-nor-the-docs-is-a-decision` classifies those), a
204 declares no body, and a union carries its shape under `oneOf`/`anyOf`/`allOf` where `properties`
never appears. `judge()` also reads 202 now — four routes publish their body only there, and reading
200/201 alone left every one unjudged.

### The link after the document

Regenerating `_generated/models.py` produced **68 inserted lines**, and all of them are this session's
work: V-1489's profile-id pattern, the name and icon bounds, tag and folder array limits, the 24-value
audit-action enum. The committed models said `action: str`. Customers install that file.

**Three guards named `sdk-python-*` were green on it — measured, not assumed.** Restoring the stale
models and running all three: 13 of 13 arms pass. They compare schema names to class names and property
names to field names, and a constraint is neither. Everything this session published — patterns, bounds,
enums, defaults — changes values inside properties that already existed, so the whole session was
invisible to the name-level chain by construction.

V-953's header is worth quoting because it is the trap: it says the two guards "close the chain … at
content level rather than at name level", and notes it verified the models were byte-identical to a
fresh run _at the time of writing_. Both were true when written. The claim is about the property layer
and reads as though it covers the constraint layer, and the freshness check was a one-time observation
rather than a standing one — so nothing noticed when it stopped being true five days later.

Two arms added there, at value level. Every enum value the spec declares must appear as a literal
(247 of them, walked at any depth — `items`, `oneOf` branches and nested objects carry constraints, and
reading only top-level properties would census a set it never enumerated). Every pattern must appear
verbatim, **except where the property also declares a `format`**: datamodel-codegen maps a formatted
string onto its own type, so `format: uri` becomes `AnyUrl` and the pattern is discarded. That exemption
is derived from the property rather than listed by name, so a field that loses its format stops being
exempt on its own. The split is exactly the generator's behaviour: 14 of 14 format-less patterns
present, 2 of 2 formatted ones absent.

The two absent ones are V-1498's and V-1499's https rules. Worth stating plainly: those constraints are
correctly published in the spec, and a Python caller's typed model still will not enforce them, because
the generator drops a pattern it considers superseded by a format. The document is right; the generated
client is weaker than the document. That is a generator limitation rather than a contract defect, and it
is now recorded rather than discovered again.

Mutation used the real historical artifact rather than a synthetic edit — the pre-regeneration
`models.py` — and both new arms red on it, naming 44 missing enum values and the missing pattern.
Restored byte-identical. `ruff`, `mypy` and the SDK's own 365 tests pass against the regenerated models.

## V-1502 — a plaintext one-time token published as an ordinary optional field, on two of four siblings

`POST /v1/auth/magic-link/request` and `POST /v1/auth/password-reset/request` published `debug_token`
as `{ "type": "string" }` and nothing else. The two sibling endpoints in the same family —
`/v1/auth/signup` and `/v1/auth/resend-verification` — publish the identical field carrying
_"Stub email mode only — the plaintext verification token"_.

So a customer reading the reference for **password reset** saw an unexplained optional string on the
response, with no way to know it is a stub-mode development affordance that production never sends. The
field holds a plaintext one-time authentication token. The correct copy already existed two declarations
up in the same file.

**The mechanism is the refine seam again, one construct over.** Both undescribed declarations carry the
explanation in a `//` comment above them, and a zod comment does not survive into JSON Schema — the same
reason V-1498's `.refine` never reached the document. `.describe()` is the only construct that carries
prose across that boundary, and two of the four used a comment instead.

**The exposure itself is correctly gated, which I verified before writing any of this.**
`AUTH_EXPOSE_DEBUG_TOKEN` defaults false, and `lib/config.ts` _refuses to boot_ in production if it is
set: _"Refusing to boot: AUTH_EXPOSE_DEBUG_TOKEN=true is development/test-only and would expose
plaintext one-time authentication tokens in production responses."_ Fail-closed at startup. This is a
documentation defect, not a leak, and it is worth saying plainly rather than inflating: the token never
reaches a production response.

**The repo already knew the describe mattered.** `anti-enumeration-response-cross-source-invariant`
enumerates the three anti-enumeration schemas and pins the describe for exactly one of them, with the
reason in its own title: _"The describe makes it clear this is test-only."_ The two it does not name are
the two that shipped without it — a per-occurrence pin standing in for a rule, which is the shape that
lets siblings drift apart. That arm now runs over the trio it already enumerates.

**The mutation caught a fault in my own guard, which is the reason per-occurrence negatives are the
rule.** The first version matched `${schema} = z.object({[\s\S]+?debug_token: … .describe(…)`. Reverting
the magic-link describe left it GREEN: the lazy run crosses the declaration boundary and matched the
_next_ sibling's describe further down the file. Only the pre-existing content-parity pin caught that
revert — the wrong way round, since the general arm is the one meant to hold the rule. Each schema is
now sliced at its own closing `});` before being searched, and both reverts red naming their own
occurrence.

Two pins re-quoted for the multi-line chain prettier produces, with `prettier --check` run on source and
pins before committing.

**Measured negatives from the same batch, so these surfaces are not re-swept.**

- **Webhook event roster and payloads.** All 9 declared event types have a real `enqueueEvent` call site
  — including the two thinnest, `session.challenge_detected` and `session.profile_save_failed`, whose
  occurrences are otherwise mostly type declarations and a migration. Payload keys match the documented
  examples in `webhooks/events.md` for every event; the docs are unusually careful here, documenting
  that `auto_destroyed` is absent rather than false, that `session_id`/`duration_ms` are omitted when
  unresolvable, and the closed four-class error set.
- **Free-form webhook fields are scrubbed on both relays.** I expected an asymmetry — the
  profile-save-failed relay pipes its `detail` through `customerSafeNodeDiagnostic` with a comment about
  the node's real egress IP, and the challenge relay passes a harness-supplied object. It scrubs it too,
  on `challenge.detail`, through the same helper. The hypothesis was wrong and the check was cheap.
- **Single-key responses are safe to judge.** V-1072's `keys.size < 2` skip drops 41 routes. Judging
  them raises the compared population from 83 to 124 and yields zero findings, and only 2 of the 41
  carry an opaque return that could make a keyset partial — both `return await accountsAdmin.getAccount(…)`
  _inside_ a `withAudit(async () => {…})` callback rather than the route's own answer. Recorded here as
  a verified-safe extension rather than taken, since it changes a threshold without a defect behind it.

## V-1503 — the sentence that explains the field, and the hand-copy that dropped four of them

V-1502 found a field whose caveat lived in a `//` comment instead of a `.describe()`, so it never reached
the document. That is a class, not an incident. Censusing api-types for properties whose preceding
comment carries an availability or behaviour caveat — _only_, _never_, _absent_, _omitted_, _deprecated_ —
and which declare no `.describe()`, returns 27 candidates.

Most are self-explanatory or admin-internal and describing them would be noise. The ones that matter share
a quality worth naming: **a customer will actively misread the value without the sentence.** Five qualify,
and each already had the sentence written, in the construct that does not publish:

- `submitted` — false is not a failure; it is what you get when the request said `submit: false`.
- `results_visible` — present only when `wait_for_results_selector` was supplied, and false means the
  selector never appeared, which is a result rather than an error.
- `prev_secret_prefix` — null means no rotation is in flight, **not** that no prior secret ever existed.
- `rotation_grace_expires_at` — when dual-signing stops.
- `retryable` — false means do not auto-replay, because the prior action may have succeeded without
  saying so.

A customer integrating webhook rotation or a retry loop reads a bare nullable string and a bare boolean
and guesses. Three of the five point the opposite way to the natural guess.

### The hand-copy, which is the more serious half

Checking coverage after the fix showed `prev_secret_prefix` described on 6 of 7 published occurrences.
The holdout is `POST /v1/webhooks/{id}/rotate-secret` — and that one had **never** needed this fix,
because `RotateWebhookSecretResponseSchema` in api-types has carried three `.describe()` calls all along,
including the full dual-signing explanation.

The document was not reading that schema. `openapi.ts` declared a hand-written
`RotateSecretResponseOpenApi` beside it, and the copy lost four things at once:

```
id                 WebhookEndpointIdSchema  →  z.string()   — dropped the ^whk_<uuid>$ pattern
grace_expires_at   Iso8601Schema            →  z.string()   — dropped format: date-time
secret             .describe(…)             →  z.string()   — dropped the "returned ONCE" warning
prev_secret_prefix .describe(…)             →  z.string()   — dropped the grace-window explanation
```

This is V-1479 and V-1500's finding a third time — a mirror silently dropping what the schema carries —
and the worst instance of it, because the rotate-secret response is the single place a customer learns
how the 24-hour grace window works. The registration now uses the api-types schema directly and the
document publishes all four.

**A guard was freezing prose that never shipped.** `api-types-webhooks-content-parity` pins those three
describes, quoting the dual-signing sentence in full. It passed every run. It was pinning the source
declaration while the document served a hand copy with none of it — a pin proves text exists, never that
it reaches an artifact anyone reads.

### The mutation caught my own pin going slack, again

Reverting `results_visible` left the re-quoted content-parity pin GREEN. The separators I used —
`z\s*\n?\s*\.boolean\(\)\s*\n?\s*\.optional\(\)` — match the single-line form too, since `\s*` matches
nothing. So the pin was re-quoted into something that no longer distinguished the change it exists to
freeze. Same shape as V-1502's lazy-match fault one batch earlier: **a pin edited to accommodate a change
tends to accommodate its absence too.** Both separators now require the `.describe(` that follows, and
both reverts red.

`retryable` had no contiguous pin at all — the existing arm matches its prose anywhere in the file, so a
jsdoc block satisfies it, which is precisely how the field kept its explanation out of the document while
looking guarded. It has one now, in the file that already governs its semantics.

All five occurrences reverted individually; each reds its own pin. Sources restored byte-identical from
scratchpad snapshots.

**Left deliberately, and measured rather than assumed.** `submitted` publishes on 8 operations and is
described on 2: the login union's two variants and the search-truncated variant declare it as
`z.literal(true)` / `z.literal(false)`, which are separate declarations from the one fixed here. Same for
`retryable` at 3 of 11 — the remainder come from `AgentSession.error_event`, another declaration. Those
are the same class and a larger edit; recorded as the shape of the remaining work rather than half-done.

**One pin needed updating rather than re-quoting, and its first negative was a false green.**
`openapi-session-search-response-truth` deep-equals the published `submitted` and `results_visible`
against `{ type: 'boolean' }`, so it froze exactly the state where the sentence was missing. It now
quotes both published descriptions.

Proving it took two attempts. Reverting the source describe left the arm green, because
`generateOpenApiSpec()` imports `@driftstack/api-types` from **dist** — editing `src` alone changes
nothing the guard can see, and the frozen snapshot was equally untouched. The honest negative reverts the
source, rebuilds api-types, re-dumps the spec, and only then runs: it reds. A guard that reads a built
artifact has to be mutated through the build, or the mutation proves the opposite of what it looks like.

## V-1504 — the remainder V-1503 named, and the sentence that was hiding in the Go SDK

V-1503 closed with two counts it deliberately left: `submitted` described on 2 of 8 published
occurrences and `retryable` on 3 of 11. Both remainders are here, and tracing the second one first was
the right order, because it was not the same defect.

### `retryable` twice, meaning two different things

`AgentSession.error_event.retryable` is not the field V-1503 described. `FailureDiagnosis.retryable` is
computed by `intentResultToCustomer` and is about replaying an INTENT; `error_event.retryable` arrives
verbatim from a harness frame through `session-error-event-relay` and is about a launch or runtime
failure. Same word, same type, different subject — so copying V-1503's sentence across would have been
pattern-matching a fix onto a different thing.

**The real sentence was already written, in the least publishable place in the repo.** `sdk-go/agent_sessions.go`
carries it as a doc comment: _"CustomerActionable says whether a human can do anything about it;
Retryable says whether the same call is worth repeating. Detail is nil when the server has nothing to add
beyond Summary."_ Precise, customer-voiced, and reachable by exactly the population that reads Go source.

Everything else had nothing. The zod schema declared three bare fields, the TypeScript SDK type declared
three bare fields, the published document declared three bare fields, and `error_event` does not appear
anywhere under `apps/docs` — the whole failure-report group is undocumented on the customer surface. So a
caller receiving `{ customer_actionable: false, retryable: true }` on a failed agent session had two
booleans and no statement of which way either points.

The four descriptions are lifted from the Go comment rather than invented, which matters: I did not know
what these fields meant before reading it, and writing a plausible sentence would have published a guess.

### The `submitted` remainder, and the field beside it that was worse

Three declarations left: the search-truncated branch and both login branches. Describing them surfaced
`logged_in`, which is the most misreadable field in the pair and was not on V-1503's list:

> _Post-submit assessment. Callers must still handle a submitted login that honestly reaches a captcha,
> 2FA step, or login-required page._

A caller who reads `logged_in: false` after `submitted: true` as an error retries a login that already
went through. The comment says so; the document said `{ "type": "boolean" }`.

The two truncated branches now state the security-relevant half explicitly — nothing was sent to the
page — rather than leaving `submitted: false` to be read as a failed attempt.

### Two instrument faults, both mine, both from the recorded list

**A no-tests run reported as a failure and I nearly read it as one.** The negative loop passed its suite
paths through a shell variable, and zsh does not word-split, so all three paths arrived as a single
argument, vitest matched nothing, and every run — including the baseline — exited 1. Four "successful"
negatives in a row were an empty test selection. The tell was the baseline failing too: a mutation that
reds and a baseline that reds are the same reading, and only the second is impossible to ignore. Paths
are passed literally now.

Before that, the same loop mis-read its own exit code: `printf ... "$?" "$(grep …)"` expands the command
substitution during argument expansion, so `$?` was the grep's status rather than vitest's. Both faults
produced confident output. Neither produced a correct one.

Per rule, each of the seven describes was reverted alone and reds its own pin — through
`build api-types → dump-spec → run`, since the spec-level arms read a built artifact (V-1503's lesson,
applied rather than relearned).

### One new arm, asserting the document rather than the source

The four `error_event` describes had no pin at all — no test reads that api-types file's text. The new
arm reads the SPEC and quotes all four published strings. That is deliberately stronger than a source
pin: V-1503 found a guard freezing three describes that never reached the document because a hand mirror
sat in between. A source pin proves prose exists; only a spec pin proves it ships.

## V-1505 — the two customer-facing properties the docs never named, found by enumerating all 81 schemas

V-1504 fixed the spec's silence about `error_event` and noted in passing that the field appears nowhere
under `apps/docs`. That is an assertion about one field, and the useful version is the census: for every
component schema in the published spec, which properties are never named anywhere in the docs tree?

**Seven schemas of 81 have any undocumented property, and four are not customer surfaces** —
`AdminAuditLogEntry`, `AdminSubscriptionStatsResponse`, `OwnerPricingEdit{Request,Response}` and
`RegisterMacNodeResponse` are admin, owner and fleet-internal. The docs are in better shape than the
previous two batches would suggest, and saying so is part of the finding.

The remaining two are customer-facing and both live on the agent-sessions page:

- **`AgentSession.error_event`** — the whole failure-report group: `code`, `severity`, `summary`,
  `detail`, `customer_actionable`, `retryable`. In the spec, in both SDKs, absent from the docs.
- **`AgentMessageUsage`** — `decomposer_kind`, `anthropic_input_tokens`, `anthropic_output_tokens`. The
  page discusses `usage.cost_usd_cents` in careful detail across a full paragraph and never states the
  object's shape, so the two token counts a customer would reconcile against their own accounting are
  undocumented while the cost field beside them is over-documented.

Both are now on the page: `error_event` in the resource shape with the branching keys spelled out, and a
`usage` block above the existing cost paragraph.

**Three claims in that copy are behavioural, so each was checked rather than inferred.**

1. _"An `error_event` does not by itself close the session."_ Both `recordErrorEvent` implementations —
   the in-memory store and `agent-sessions-repo` — write `lastErrorEvent` and `updatedAt` and touch
   nothing else. The interface comment adds a detail I would not have guessed: closed sessions accept an
   error event, because "errorEvent follows terminal sessionStatus on the producer."
2. _"Only `decomposer_kind` is always present."_ The published schema's `required` list is exactly
   `['decomposer_kind']`.
3. _"A `deterministic` turn carries neither [token counts nor model]."_ Optionality alone does not
   establish this — a field can be optional in the schema and always sent in practice. The deterministic
   decomposer exports `DETERMINISTIC_USAGE = { decomposerKind: 'deterministic' as const }`, so the claim
   holds at the source rather than by inference from the schema.

That third check is the one worth keeping: two of these sentences could have been written from the
schema alone and would have been right by luck. The third could not.

One arm added to the page's drift guard, pinning both additions and the verified status sentence.
Removing either addition individually reds it; the docs file restored byte-identical from a scratchpad
snapshot.

**I got the rebuild question wrong, and the gate caught it.** I asked whether any suite reads
`apps/docs/dist` at runtime, found none — the three files naming that path pin a deploy workflow, a
prettierignore inventory, and the freshness guard's own fixture string — and concluded no rebuild was
needed. `dist-reading-suites-have-fresh-artifacts` failed the full run:
_"docs: built 14:54:31 but source changed 18:56:37 — REBUILD, do not repin assertions onto stale
markup."_

The guard does not ask what I asked. It registers `docs` as an app and compares built-artifact mtime
against source mtime, so a source edit makes it stale whether or not anything currently reads the
output. Answering an adjacent question and treating the answer as dispositive is the same error as
acquitting a category on a keyword match. `npm run build --workspace @driftstack/docs` and the guard is
green; `apps/docs/dist` is gitignored, so nothing enters the commit.

## V-1506 — five hand-written SDK shapes the name key missed, and a reach that was explained but never stated

`sdk-go-structs-cover-openapi-fields` compares a shape whose NAME equals a spec schema's. Measured
through the file's own parser: the TypeScript side compares **11 of 70** schemas, the Go side 39, and 30
are compared by neither.

**The low TypeScript number is not an oversight, and reading the file properly was what stopped me
writing that it was.** A docstring on `tsInterfaces()` already explains it: most SDK shapes are imported
from `@driftstack/api-types`, which is what the OpenAPI document is generated from, so they cannot
drift. "What is left is the hand-written remainder, which can." That reasoning is sound and the number
is low for a good reason.

What the file never states is the number itself, and the arm that touches it asserts
`matched.length >= 9` — true at 11, equally true at 1. So a rename that drops a type out of comparison
is invisible to the only arm that looks.

**The real gap is narrower than "16% coverage" and it is inside the guard's own intended scope.** Five
of the shapes the name key skips are declared in the SDK itself — the hand-written remainder the
docstring points at — and they escaped only because the SDK names types for the people calling it
rather than after the wire schema:

```
AccountMeResponse           → AccountSelfProfile
AccountAuditEntry           → AuditLogEntry
ExportAccountAuditResponse  → AuditLogExportResponse
AgentMessageUsage           → AgentUsage
ByokAnthropicMetadata       → ByokAnthropicKeyMetadata
```

Each was verified field-by-field before being listed and **none was missing anything**, so this is reach
rather than repair, and the entry says so rather than dressing a coverage extension up as a bug fix.
Listed by hand deliberately: I built a field-overlap matcher first, and a heuristic that pairs any two
shapes which happen to agree reports confident nonsense on the first near-miss. The reach arm asserts
every alias still resolves, so an alias that rots stops the run instead of quietly comparing nothing.

**Three mutations, each isolating one claim.** Dropping a field from `AuditLogEntry` reds the
missing-fields arm — the alias comparison is load-bearing, not decorative. Renaming `AccountSelfProfile`
reds the alias-resolution assertion at 4 of 5. Renaming the name-matched `Recipe` reds the reach floor at
10 against 11, which is the silent shrink the old `>= 9` could not see.

### Two instrument faults, and the second nearly became a published finding

My first census said the TypeScript SDK had no `Session` type and matched 13 of 81 schemas. Both numbers
were wrong, from an ad-hoc comment stripper: `//` inside a URL ate the rest of its line, which is exactly
the failure `code-only.ts` exists to prevent and which V-1256 recorded after it blanked 61 imports from
a route file. It reported `AccountSelfProfile` as absent while I was looking at the declaration.

The correction was not to fix my parser but to stop using it: the numbers here come from the guard's own
`tsInterfaces()` and `specSchemas()`, lifted into a scratchpad probe. **When the artifact under
investigation already contains a parser for the thing being counted, a second parser is a second thing
that can be wrong** — and it was, twice, in the direction that would have made the finding sound worse
than it is.

Before that, an inline-nested-object scan reported `AgentSession.pair_mode_state` missing `kind` and
`liveness` missing `state`/`fresh`. All three are present, declared on a single line; my extractor
anchored field names to line starts. That check was aimed at the blind spot this file's header names —
inline object literals — and after fixing the extractor the answer was zero gaps across the four inline
objects that have a nested spec counterpart. Recorded as a measured negative: the documented blind spot
is real but currently hides nothing.

**One process deviation, stated rather than buried.** The third mutation renamed `Recipe` in
`recipes.ts`, which I had not snapshotted, and I restored it with `git checkout --` instead of a
scratchpad copy. That is the thing the batch rule forbids, and the reason is that checkout restores to
HEAD rather than to what was there. It was safe here — the file had no uncommitted changes and
`git diff` against HEAD is empty — but "safe because I checked afterwards" is the argument the rule
exists to make unnecessary.

## V-1506b — the Go side of the same name key, closed by a rule rather than a list; and two surfaces measured clean

V-1506 added five hand-listed aliases to the TypeScript side. The Go side has 31 schemas the name key
misses, and the largest group is not renaming at all — it is a spelling convention. golint requires
`APIKey`, not `ApiKey`, so `CreateApiKeyRequest`, `CreateApiKeyResponse`, `RotateApiKeyRequest`,
`RotateApiKeyResponse` and `ApiKey` were each skipped over a casing difference the Go compiler enforces.

Resolved with a **rule** rather than a list: `Api → API`, `Url → URL`, `Id → ID`. That is strictly better
than what V-1506 could do for TypeScript, and the difference is worth naming — a hand entry covers the
schemas that exist when someone remembers to add it, while a mechanical rule covers the next `…ApiKey…`
schema the day it lands. The rule is deliberately narrow: it resolves only a name it actually transforms
and which exists as a struct, so a schema the Go SDK genuinely does not model stays uncompared rather
than being paired with whatever sits nearby.

Five schemas move from uncompared to compared, none was missing a field, and dropping `plaintext` from
`CreateAPIKeyResponse` reds the arm naming two of them — so the rule carries weight rather than
decorating the file.

**The near-misses were checked and are all mis-pairings, not defects.** A 70%-coverage scan flagged
`CreateApiKeyResponse ~ APIKey` and `RotateApiKeyResponse ~ CreateAPIKeyResponse`. Both are the scan
scoring a schema against a struct that is one embedding level below its real counterpart; the correct
pairs cover fully. This is the reason the rule refuses to guess: the same scan that finds a real pair
finds three plausible wrong ones.

### Two surfaces measured, both clean

**No list endpoint silently truncates.** V-1500 bounded `limit` on paginated routes; the adjacent
question is the bare-`{ data }` collections that publish no cursor at all — if one capped server-side,
rows past the cap would be unreachable and the response would not say so. Across the repos and services
there is no hardcoded list cap: every `.limit(n)` with n > 1 is a migration batch size or the page
maximum of an already-paginated route, and the rest are `.limit(1)` single-row lookups. Verified
concretely on the two most likely to grow — `listEndpoints` and `listApiKeys` both select every row for
the account with no limit clause. Unbounded rather than silently capped, and boundedness is a separate
guard's business.

**36 published customer-facing operations have no TypeScript SDK method, and that is a scope decision
rather than a defect.** Most are obviously not SDK material: `/health`, the whole `/v1/status/*` page
surface, `/v1/oauth/authorize` (a browser redirect), `/v1/fleet/events` (SSE), the PDF and text receipt
routes. Six are plausible gaps a customer might expect — `agent-sessions/{id}/transcript`,
`/page-state`, `/cookies`, `/downloads`, `/v1/account/cost`, `/v1/account/me/notifications` — and the
absence is real, verified rather than inferred from my path regex: the resource builds every path as a
template literal the scan reads correctly, and there is no method for any of them.

Recorded and not acted on. Which endpoints an SDK exposes is a product decision spanning three languages
plus their docs and cross-SDK parity guards, and adding six methods to satisfy a census would be
answering a question nobody asked with a change nobody scoped.

## V-1507 — two endpoints honour Idempotency-Key and the document never said so

Four routes read the customer-supplied `Idempotency-Key` header. The published spec declared it on two.

```
POST /v1/agent-sessions              reads it, dedups, replays the 201   — UNDECLARED
POST /v1/billing/checkout-session    reads it, forwards it to Stripe     — UNDECLARED
POST /v1/agent-sessions/{id}/message declared
POST /v1/billing/crypto-checkout     declared
```

This is worse than an undocumented field. A header that is not a declared parameter has no slot in a
generated client — a Python caller could not send one at all, so the safe-retry guarantee the reference
page promises was unreachable from the SDK that is generated rather than hand-written. And the retry it
protects is the expensive one: `POST /v1/agent-sessions` after a timeout, where the alternative to
deduplication is a second agent session the caller never asked for.

**Both human surfaces were right again, which is now the recognisable shape of this class.** The
reference page names all four under "Which endpoints honour it" and even states the converse — _"Every
other endpoint … ignores the header. Sending it is harmless but has no dedupe effect"_ — and
`lib/idempotency-key.ts` opens with its own four-route catalog. V-1498, V-1502, V-1503 and V-1504 were
each a version of this: the prose is maintained, the machine-readable contract is the surface nobody
re-reads.

Verified against source rather than taken from the docs, which is the rule this batch exists under.
`POST /v1/agent-sessions` calls `readIdempotencyKey`, looks the key up with `findByIdempotencyKey`,
replays the prior 201 on a hit, and handles the unique-violation race by re-reading the winner.
`POST /v1/billing/checkout-session` parses the header, 400s an invalid one, and passes the key into
`createCheckoutSession`, which forwards it to Stripe's own idempotency mechanism. Neither dedup is
theoretical.

### The count that was wrong, and why it mattered

My first pass reported **three** reader sites and I nearly wrote the finding around that number — which
would have made the docs look wrong about `checkout-session` rather than the spec look wrong about it.
The three came from a `grep … | head -12`: the twelfth line landed mid-file and `billing.ts` was below
the cut. A truncated grep reports a number that looks like a census and is a display limit.

Re-enumerated without the pipe: exactly four call sites, matching the docs and the lib comment. The
difference between "3 readers, docs overclaim" and "4 readers, spec underdeclares" is the entire
direction of the finding, and only one of them is true.

### The guard derives its list instead of restating it

The new arm parses the four routes out of `lib/idempotency-key.ts`'s **own** comment — the same text the
arm above it already pins — and requires the spec to declare the header on exactly that set. Nothing is
hand-listed, so the catalog and the check cannot be edited apart, and a fifth consumer forces the
declaration on the day it is added rather than whenever someone remembers.

It asserts both directions. The forward one is this finding. The reverse — a declaration on a route that
does not read the header — is the more dangerous failure: it promises deduplication the server will not
perform, so a client retries a charge believing it is protected. Proven by declaring the header on
`POST /v1/sessions`, which reds naming it.

Three negatives, each isolating one occurrence: reverting the create declaration alone names
`POST /v1/agent-sessions`, reverting the checkout one alone names `POST /v1/billing/checkout-session`,
and the reverse mutation names `POST /v1/sessions`. The parse is asserted non-empty first, since an arm
that reports an absence passes perfectly when it has parsed nothing.

## V-1508 — the request-header surface, enumerated; one real gap, three correct silences

V-1507 fixed one undeclared request header. The generalisation is cheap and worth doing once: enumerate
every header the server reads and compare against every header the spec declares as a parameter.

Read by the server: `user-agent`, `x-nowpayments-sig`, `x-byok-anthropic-api-key`, `stripe-signature`,
`x-request-id`, `x-driftstack-gui-control-key`, `set-cookie`, `last-event-id`, `idempotency-key`, and
four `cf-*` headers. Declared in the spec: `accept`, `idempotency-key` (four operations, after V-1507),
`x-byok-anthropic-api-key`, `x-driftstack-mac-node-id`.

**One is a real gap.** `GET /v1/agent-sessions/{id}/transcript` reads `Last-Event-ID` and resumes the SSE
stream from that entry index. Its own 200 description says so — _"Supports Last-Event-ID resume: send the
last entry index seen and the server replays subsequent entries"_ — and the docs page documents it twice.
The header was not a declared parameter.

A description is not a parameter. The distinction matters more here than in the field cases: a browser
`EventSource` sends `Last-Event-ID` on reconnect without being asked, so the capability works for free in
the surface where it is least needed. Every non-browser client has to set it deliberately, and that is
exactly the caller who can only learn about it from the document, and whose generated client has no slot
for a header nobody declared.

Behaviour checked rather than paraphrased from the description: the route parses the header with
`parseInt` and falls back to `-1` when the result is not finite, which replays from the beginning. The
published description says that, rather than implying a malformed value is rejected.

**Three are correct silences, and saying why is the point of enumerating.**

- `x-driftstack-gui-control-key` — appears in `sentry.ts` and `logger.ts` redaction lists and a comment;
  the route it authenticates is not published at all. That is the same deliberate decision
  `a-route-in-neither-the-spec-nor-the-docs-is-a-decision` already classified, not an omission.
- `stripe-signature`, `x-nowpayments-sig` — inbound from a third party to a webhook receiver. The sender
  is Stripe and NOWPayments, not a customer; declaring them as parameters would invite someone to send
  one.
- `user-agent`, `set-cookie`, `cf-ipcountry` / `cf-region` / `cf-timezone` / `cf-ipcity` — infrastructure
  and edge-injected. Nothing a caller sets to change behaviour it can rely on.

**One is a judgement call recorded rather than acted on.** `x-request-id` is honoured inbound — every
operation's `X-Request-Id` response header says so: _"echoed from the inbound `x-request-id` when
supplied."_ So the capability is documented on roughly every operation and declared as a request
parameter on none. Declaring it would mean adding the same parameter to ~150 operations to describe a
global convention, which trades one kind of poor discoverability for a large amount of noise. The
honest fix is a shared parameter component referenced where it matters, and that is a spec-wide
convention change rather than a field edit — the same reasoning that left `.openapi({...})` metadata
alone in V-1499.

The new arm asserts the SPEC and anchors itself to the reader: it checks the declaration exists **and**
that the route still contains `req.headers['last-event-id']`, so a declaration cannot outlive the code
that honours it. Reverting the declaration reds it.

## V-1509 — a scope that reads more than the reference page says it reads

`read:webhooks` gates four methods in `services/webhooks.ts`: `list`, `listWithCounts`, `get` — and
`listDeliveries`. The canonical reference page described it as **"Read webhook endpoints only."**

Deliveries are a different resource from endpoints, and the rows are not thin:
`last_response_status`, `last_response_excerpt`, `last_error` — the status codes, body excerpts and
error text the customer's OWN endpoint returned, plus event types and attempt history. A customer minting
a least-privilege key so a script can list their webhook endpoints was also handing that key their
delivery log.

**This fails in the opposite direction to the defect the sibling guard was built for.**
`dead-scopes-are-labelled-on-customer-surfaces` exists because scopes described as capabilities were
enforced nowhere — the key granted LESS than advertised, which fails closed and merely wastes the
customer's afternoon. This one grants MORE than advertised, to someone whose entire reason for reading
that table is to decide how much access to hand out.

**Two other customer surfaces have been right the whole time.** `marketing-site/docs/api-keys.astro` and
`docs/oauth-apps.astro` both say _"List webhook endpoints + delivery history."_ The page that was wrong
is the one its own "Source of truth" section points at. That is V-1502's shape again — siblings drifting
apart with the correct wording sitting one file away — except here the odd one out is the canonical
surface rather than a peripheral one, which is why the census that finds it has to compare against code
rather than against the other pages.

The word doing the damage is `only`. Without it the row would be incomplete; with it, it is a statement
that the scope stops where it does not.

### The census that found it, and the one that nearly hid it

Reading enforcement out of `requireScope(...)` call sites in `routes/` reported **zero** sites for
`read:audit`, `read:api-keys` and `read:webhooks`, which would have made all three look dead. They are
not: this codebase gates in two places, and those three are enforced in the SERVICE layer through
`throwIfMissingScope(ctx, …)`. The dead-scopes guard's header names both mechanisms; my grep used one.
Had I stopped there the finding would have been "three documented scopes are enforced nowhere" — loud,
alarming and wrong in the direction that wastes everyone's time.

`read:billing` was checked the same way and is accurate: eight enforcement sites — `/v1/billing`,
`/v1/billing/crypto-checkout/quote`, `/v1/account/cost`, and the five crypto-order reads — every one
covered by the page's enumeration. `admin:billing` covers crypto checkout and order cancellation, which
the row's "change subscription" phrasing carries and whose route comments cite this same page for the
reasoning. Neither is a finding, and both were checked before this one was written up.

### The guard derives the claim from the gate

The new arm does not pin the sentence. It locates `async listDeliveries(` in the service, asserts the
`read:webhooks` gate lives INSIDE that method rather than merely somewhere in the file, and only then
requires the page to mention delivery history and `last_response_excerpt`. So if delivery listing is ever
moved off this scope, the arm retires the claim instead of freezing a description that has stopped being
true — which is the failure V-1503 found in a guard pinning three describes that never shipped.

Both directions proven: restoring "endpoints only" reds the page assertion, and removing the gate from
`listDeliveries` reds the anchor.

## V-1510 — the rest of the scope table, checked row by row: one symmetry fix and eight negatives

V-1509 corrected `read:webhooks`. The obvious question is whether it was the only row that understated
its grant, and the only way to answer it is to check the others rather than assume the answer either way.

**The fix.** `read:profiles` said _"Read profiles endpoints only."_ while the three snapshot READ routes
gate on it, and the three snapshot MUTATIONS gate on `write:profiles` — whose row already carried
`(and their snapshots)`. So the convention existed and one row was missing it.

Stated at its real size rather than dressed up as another security finding: a snapshot read returns
`label`, `parent_profile_id`, `parent_archetype`, `parent_name`, `captured_at`, `created_at`. It does not
return the stored browser state. That is why this row gets a symmetry fix and V-1509's got a warning —
`read:webhooks` exposed response bodies and error text from the customer's own endpoint, which is a
different kind of data, not just more of the same kind.

### Eight rows checked and correct

- **`read:billing`** — the row enumerates the endpoints, which is the most falsifiable claim on the page.
  Eight enforcement sites: `/v1/billing`, `/v1/billing/crypto-checkout/quote`, `/v1/account/cost`, and
  the five crypto-order reads. Every one covered.
- **`admin:billing`** — six sites including crypto checkout and order cancellation, which the row's
  "change subscription" carries. Both route files cite this page and explain the classification in a
  comment, so the mapping was a decision rather than an accident.
- **`read:api-keys`**, **`read:audit`** — one service method each, `list()`, exactly as the rows say.
- **`gui_control`** — the row names `tap_at` and `type_focused`; the schema declares those two literals
  and no others.
- **`write:profiles`** — its `(and their snapshots)` is accurate: create, restore and delete all gate on it.
- **`admin`** — the row promises it satisfies `account_owner` and customer `admin:*` but _never_ the
  staff-only `driftstack_internal_admin`. True at the predicate: that scope carries no colon, so
  `parseGranularScope` returns null and only an exact match can grant it.
- **broad-satisfies-granular** — `read`/`write`/`account_owner` satisfy their own verb's granular scopes
  and granular never satisfies broad, exactly as documented.

### The census that would have produced a loud wrong answer

Reading enforcement from `requireScope(...)` in `routes/` reported **zero** sites for `read:audit`,
`read:api-keys` and `read:webhooks` — which reads as "three documented scopes are enforced nowhere", a
far more alarming finding than the true one. This codebase gates in two places, and those three are
enforced in the SERVICE layer via `throwIfMissingScope(ctx, …)`. `dead-scopes-are-labelled` names both
mechanisms in its header; my grep used one. Checking the second mechanism before writing anything is the
only reason the entry above says what it says.

### The equivalence check I was about to build already exists, and is better

`requireScope` is implemented twice — inlined in `services/auth.ts`, and via `scopesSatisfy` in
`lib/errors-helpers.ts` — with a comment claiming they are kept in sync by hand. That is exactly the
shape worth a guard, so I went looking for one to write.

`scope-check.test.ts` already does it, and more thoroughly than I intended: every granted set of size 0,
1 and 2 drawn from `ApiKeyScopeSchema.options`, against every required scope, comparing all THREE entry
points. Its own comment explains why size 2 matters — "several rules read one scope while a second is
present, and a singleton-only sweep cannot see an implementation that consults the wrong element". The
scope set comes from the enum rather than a local list, so a new scope extends the matrix automatically.

Recorded because the useful output of a search for prior art is sometimes "it is already covered, better
than you were going to" — and because the next person to notice two copies of an authorization predicate
should find this note before rebuilding the same guard.

## V-1511 — retracting V-1500's exemptions: seven "no default" endpoints all had one, a layer down

`reference/pagination.md` claimed **"Default: `50` on every list endpoint"**. Twenty published `limit`
parameters, seven of them with no `default` in the document — so either the page was wrong or the spec
was. Checking which is the whole finding, and the answer is: the page was right about there being a
default, wrong about the number, and the spec was silent on all seven.

| endpoint                             | effective default | applied in                                     |
| ------------------------------------ | ----------------- | ---------------------------------------------- |
| `GET /v1/billing/crypto-orders`      | 50                | `services/crypto-orders.ts` `listAll`          |
| `GET /v1/admin/crypto-orders`        | 50                | `listForAdminPage`                             |
| `GET /v1/admin/status-subscribers`   | 50                | `services/status-subscribers.ts`               |
| `GET /v1/admin/incidents`            | 100               | `db/incidents-repo.ts` `INCIDENT_PAGE_DEFAULT` |
| `GET /v1/status/incidents`           | 100               | the same repo                                  |
| `GET /v1/admin/atlas-priority/queue` | 100               | `atlas-priority-events-repo`                   |
| `GET /v1/admin/crypto-orders.csv`    | 1000              | a plain `let limit = 1000` in the route        |

All seven now publish it, and every one of the twenty carries a default.

### This retracts my own exemption map, and the reasoning is the lesson

V-1500 exempted exactly these seven, each with a note like _"declares `.optional()` with no default"_.
Every one of those notes is **true about the file it names** and wrong about the endpoint. The route
declares no default; the service or repo applies one. The exemptions described where the default was NOT,
and I read that as evidence none existed.

The sharpest evidence was sitting in the declaration I cited. `GET /v1/billing/crypto-orders` carries

```ts
.optional()
.describe('Page size (1-100). Defaults to server-side 50.')
```

I quoted the `.optional()` half as proof there was no default while the next line said what the default
is. A census that greps for a keyword finds the keyword; it does not read the sentence beside it.

`LIMIT_WITHOUT_DEFAULT` is now an empty object rather than deleted, so the staleness half keeps running —
V-1500 got that part right, and it is what failed the moment the seven were published, which is how a
guard is supposed to react to its own author being wrong.

### The page had a second wrong number

_"Maximum: `100` on most endpoints; a few admin list endpoints (e.g. status subscribers) allow `200`"_ —
the real maxima are 100, 200 **and 1000**, the last on the atlas-priority queue and the crypto-orders CSV
export. The page named the second tier and stopped one tier short.

Both bullets now match the document, and the page tells readers to take each endpoint's default from the
spec rather than assuming one number — which is the honest instruction once there are three.

### The guard derives the numbers instead of quoting them

The new arm reads every published `limit` parameter, collects the distinct defaults and maxima, and
requires each to appear on the page. No number is hardcoded in the test, so a new rail with its own page
size fails until the section mentions it. Non-emptiness is asserted first, since an arm reporting an
absence passes perfectly when it has parsed nothing.

Two negatives: restoring the old text reds the pagination arm, and un-publishing the CSV default reds the
V-1500 bound arm — which, with the exemption map emptied, now catches directly what it used to excuse.

### Measured clean on the way, so these are not re-swept

`published-rate-limit-table-matches-the-code` already derives the whole 8-tier × 4-bucket table from the
limiter and compares capacity and refill per cell, with arms proving the page parsed and every tier and
bucket has columns. I went to check the 64 numbers by hand and found the check already stronger than the
one I was writing. The pagination page's endpoint list says "and others", so it makes no enumerable claim
to falsify.

### V-794 caught my new pin, which is the second time this batch a guard corrected its own author

The first version of the arm above was titled _"…the defaults in use are 50, 100 and 1000, and **two
endpoints** cap at 1000."_ `a-parity-pin-cannot-freeze-a-claim-that-expires` failed the run: 91 pin files
freeze a hand-maintained count against a ceiling of 90, and the new offender was mine.

It is right. The arm's body derives both sets from the spec precisely so that no number has to be
restated, and I restated one anyway — in the title, where it is least visible and cements a tally that a
third such endpoint would falsify. The clause is gone; the body is unchanged, because the body was never
the problem.

Worth recording together with the retraction above: within one batch, V-1500's staleness arm caught my
wrong exemptions and V-794 caught my wrong title. Both guards were written earlier in this sweep to
catch someone else.

## V-1512 — one parameter finished, and five surfaces that turned out to be already guarded

V-1511's lesson was that a census stopping at the route layer misses what a service applies. Two things
follow from that: finish the parameter it did not cover, and check whether the same reasoning error is
hiding elsewhere. The first took one line; the second took most of the batch and found nothing, which is
the more useful half to write down.

**The fix.** `GET /v1/admin/status-subscribers` is the only offset-paged endpoint in the API — every
other list rail is cursor-based — and its service applies `opts.offset ?? 0` while the document published
`{ minimum: 0 }` and no default. Exactly V-1511's shape, one parameter over. It publishes `default: 0`
now, and the new arm derives the population from the spec rather than naming the endpoint, so a second
offset-paged rail is judged the day it lands.

Small, and worth saying so plainly: an omitted `offset` defaulting to zero is what any caller would
assume. This closes the parameter rather than repairing a misunderstanding.

### Five surfaces measured clean

**No published maximum exceeds its effective clamp.** The mirror of V-1511 — a customer asking for 100
and silently getting 50 — does not occur. Two services clamp at 200 (`durable-webhook-delivery` for
deliveries and the DLQ) above a published maximum of 100, but `ListDeliveriesQuerySchema` caps at 100
with `.parse()` at the route, so the headroom is unreachable rather than contradictory. Every other clamp
reads the same constant the route publishes.

**Rate-limit response headers follow the repo's own placement convention.** Seven are emitted on every
consume — the four `x-ratelimit-*` plus three un-prefixed IETF-draft names — and all seven are declared
on 429 across 213 operations and on no 2xx. That looked like a gap until I checked the comparable case:
`X-Request-Id` is sent on every response and is declared on 400/401/403/404/409/429/503 and never on a
success. So cross-cutting headers are attached where the shared error blocks are, uniformly. Declaring
them on success responses is a spec-wide convention change, not a correction — the same call V-1508 made
about `x-request-id` as a request parameter.

**The per-tier rate-limit table is derived, not pinned.** `published-rate-limit-table-matches-the-code`
parses the page's columns from its header row, walks every published row, and compares capacity and
refill per cell against the limiter, with separate arms proving the parse found real rows and that every
tier and bucket has columns. I went to check 64 numbers by hand and found a stronger check already there.

**The email catalogue is closed the same way.**
`every-email-a-customer-can-receive-is-in-the-catalogue` exists, which is the emails-page analogue of the
webhook-event catalogue guard.

**Cursor parameters are uniform.** All sixteen publish `minLength: 1, maxLength: 512`; two carry an extra
description. Nothing to reconcile.

### What five negatives in a row means

This surface has been swept hard across V-1475–V-1511 and the guards that came out of it now cover the
obvious shapes. The remaining defects in this area are unlikely to be found by another parity census —
the ones that landed this session came from comparing two independently derived artifacts, and the pairs
worth comparing are largely exhausted.

Recorded so the next sweep starts from here rather than re-deriving the same negatives: published bound
vs clamp, response-header placement, the tier table, the email catalogue, and cursor bounds are all
verified as of this entry.

## V-1513 — the only credential an EventSource can carry, declared nowhere

V-1512 closed by saying the pairs worth comparing were largely exhausted. The pairs I had been comparing
were: this batch used a new one — **consumer code against the contract**. The customer dashboard and the
admin panel call the API directly, and what they send is a derivation of the real contract that nothing
had compared against the published one.

**The finding.** `GET /v1/account/me/notifications` and `GET /v1/agent-sessions/{id}/transcript` both
authenticate through `requireAuthEventSource`, which takes the bearer token from `?ds_token=` because the
browser `EventSource` API cannot set an `Authorization` header. Neither declared the parameter.

That is worse than the usual undeclared-parameter case. For SSE consumed in a browser — the surface these
streams exist for — `?ds_token=` is not a convenience, it is the ONLY way to authenticate. A generated
client had no parameter for it, so the spec described two streams that could not be opened from the
place they are meant to be opened.

Both docs pages carry it, with a code sample:
`https://api.driftstack.dev/v1/account/me/notifications?ds_token=${KEY}`. The human surfaces were right
again; this is the fifth time this session that the machine-readable contract was the one out of step.

The published description says what the parameter is, steers to the header where a client can set one,
and states the redaction posture — verified rather than assumed: the token is stripped from logs
(`lib/logger.ts`), from Sentry events, and from the URL echoed in a 404 body
(`middleware/error-handler.ts`). It also says plainly that a URL-borne credential is still a URL-borne
credential, because that is true and a reader deciding between the two paths should have it.

The new arm derives the route set from the `requireAuthEventSource` preHandler rather than naming the two
streams, so a third adopting this auth is judged the day it lands, and asserts the derivation is
non-empty first.

### Three instrument faults in one batch, each caught before it became a finding

The probe compared consumer `(METHOD, path)` pairs against registered routes and reported 8 mismatches.
All 8 were mine:

1. **Query strings left on the path.** `/v1/account/audit-log?limit=20` matched no route because I never
   split on `?`. Seven of the eight.
2. **A query string read as a path segment.** `'/v1/auth/oauth-client/callback' + qs` became
   `/v1/auth/oauth-client/callback/{}` because my heuristic treated any `+ expr` as another segment. The
   route is registered; the eighth mismatch was the extractor.
3. **The wrong method looked up.** With paths fixed, the probe then reported `keep` undeclared on
   `/v1/account/web-sessions`. It is declared — `query: z.object({ keep: z.literal('current') })` — and
   my lookup had hardcoded `GET` while the call is a `DELETE`. That one nearly became the headline,
   because the repo's own guard header references a historical "`?keep=current` bug" and I was primed to
   believe it had come back.

Three wrong answers, three different causes, one surviving finding. The rule that saved it each time is
the same one that has held all session: the census generates candidates, and source decides.

A fourth, smaller: the arm's import edit was a silent no-op — the file imports
`{ readFileSync, existsSync }` and I replaced `{ readFileSync }`, which matched nothing. `.replace()`
returning the string unchanged is indistinguishable from success, and only the run caught it.

### Measured clean

**Every consumer call site's method and path is served.** Seventy fetch sites across the dashboard and
admin panel, all matching a registered `(method, path)` once the extractor was correct. The existing
`dashboard-fetch-paths-have-routes` checks paths only, so the method dimension was genuinely unverified —
it is now measured, and clean.

**Consumer query parameters are declared**, apart from the `ds_token` pair fixed here.

## V-1514 — a pin describing a rendering that has never rendered

Continuing the consumer-side comparison V-1513 opened: what the admin pages READ, against what their
endpoints send. Six candidate field reads across three pages; four dissolved on inspection
(`r.n`/`r.label` are locally-built chart rows, `body.reason` is a request being constructed, and one path
did not exist). Two survived, and they are the same field on two lines:

```js
escapeHtml(entry.admin_email || entry.admin_account_id);
escapeHtml(entry.target_email || entry.target_account_id);
```

`publicEntry` in `routes/admin-audit-log.ts` projects a fixed set of fields and none is an email. Nothing
under `apps/server/src` produces `admin_email` or `target_email` at all. So both first operands have been
`undefined` on every entry the route has ever sent, and the `||` has always fallen through to the id.

**This is not accidental dead code, and finding that out changed the fix.** The guard pinning these lines
titles them _"admin identity (email primary, admin_account_id UUID fallback) … when the server enriches
the entry"_. The author knew the enrichment did not exist and wrote the fallback for it deliberately.
Deleting the operand would be pattern-matching a fix onto a documented decision.

The pattern is also real one page over: `AdminAccount` carries `email` and `accounts.astro` renders it
name-or-email. It was copied to a surface whose endpoint does not enrich.

**So the code stays and the description changes.** The title asserted a rendering — "renders email-primary
with the UUID secondary" — for a branch that cannot execute. It now says the email half is a placeholder,
names `publicEntry` as the reason, and keeps the operand explicitly rather than by omission.

The arm gained the anchor that makes the claim checkable: it reads `publicEntry` and asserts the
projection carries no email of any kind. That inverts the failure direction usefully — the day the route
starts enriching, the arm fails and demands the description become a rendering again, instead of the
placeholder quietly turning true and the title being right by accident. Proven by adding `admin_email` to
the projection: it reds with the message telling the next reader what to do.

**Size, stated plainly.** Zero customer impact: this is the internal admin panel, the fallback renders
the account id correctly, and nothing is broken for anyone. What was wrong was a test title describing
behaviour that does not happen — the same species as V-1486's arm titles freezing hand-maintained counts,
and the reason `a-parity-pin-cannot-freeze-a-claim-that-expires` exists at all. A pin that describes an
aspiration as a fact is a pin that will confirm the aspiration to whoever reads it next.

### Measured clean

**Every mock fixture in the dashboard and admin-panel page tests uses field names the API publishes.** A
fixture is that page's belief about the wire shape — V-1501 found one asserting `{ ok: true }` against a
handler sending `{ message, email }` — so the census was worth running: 515 distinct published property
names, and no fixture key outside them.

**Field-name drift on the other admin pages.** `admin-panel-pages-cost-field-name-parity` exists because
slices 79, 80 and 81 each fixed a real instance of a page reading a field the API nests differently, and
it guards one page. Extending the same comparison to every admin page found the two lines above and
nothing else.

### V-794 caught the same mistake I made last batch

The first version of the corrected title said `publicEntry` _"projects **ten fields** and none is an
email"_. `a-parity-pin-cannot-freeze-a-claim-that-expires` failed the run, exactly as it did in V-1511
when a title of mine said "two endpoints".

Twice now, in consecutive batches, while writing an entry about a pin describing something inaccurately,
I froze a count in the pin describing it. The count was incidental both times — the assertion below it
reads the projection and asks whether an email field is present, which is the whole claim. "Ten" was
decoration that would be wrong on the next field added.

Worth stating rather than quietly fixing: the guard is doing more work than I am on this particular
habit, and the habit is specifically writing a number into prose when the code beside it already derives
the number.

## V-1515 — the redaction guard had never seen `authorization` or `cookie`

This batch used the repo's own candour as the instrument. Eighty-two guards state a limitation in their
header, and V-1501 came from exactly such a sentence. `every-credential-header-is-redacted-in-logs`
declares one on a security surface, so it was worth testing rather than reading.

Its stated gap: the scan finds headers read by LITERAL name, so a header reached through a constant is
invisible — `x-driftstack-account`, read as `EFFECTIVE_ACCOUNT_HEADER`, was named as the known case.

**Testing it turned up a second gap the header did not declare, and that one mattered more.** The scan
matched `headers['x-name']` and not `headers.name`. Four headers are read only in the dot form, and two
of them are `authorization` and `cookie`.

So the arm asserting that _"every header the server reads is classified"_ had never once seen the two
most obvious credentials in the system. Nothing leaked — both sit in `CREDENTIAL_HEADERS` because someone
put them there by hand, and both are in the pino redact paths. But the guard's central claim rested on a
hand-written list agreeing with a scan that could not reach the same headers, which is not corroboration.
It is the shape this repo already has a name for: a clean census is not evidence.

**Six headers were invisible; four had never been classified at all.**

```
authorization             dot form      already a credential, by hand
cookie                    dot form      already a credential, by hand
accept                    dot form      UNCLASSIFIED
origin                    dot form      UNCLASSIFIED
x-driftstack-account      constant      UNCLASSIFIED  (the declared gap)
x-driftstack-mac-node-id  constant      UNCLASSIFIED
```

The four are genuinely harmless and each is now listed with a claim someone can check: `accept` is
content negotiation on the agent-message route; `origin` is the browser's own origin echoed through
`sseCorsHeaders`, attacker-supplied and trusted for nothing; `x-driftstack-account` is an `acc_<uuid>`
naming who a staff caller acts AS, with a separate guard establishing that the authority comes from the
bearer token beside it; `x-driftstack-mac-node-id` is a fleet node id whose actual credential is the
short-lived JWT in `authorization`.

**The old note's argument was right and its conclusion was avoidable.** It said matching identifiers
would mean resolving them, and "a scan that guesses at constants is worse than one whose limit is written
down". True of guessing — but an identifier can be followed to a `const NAME = 'literal'` in the same
tree without guessing at all, and an identifier that resolves to nothing can be REPORTED rather than
assumed harmless. That report is now its own assertion, so the unresolvable case fails loudly instead of
silently rejoining the blind spot.

The first arm's floor is the measured total across all three spellings, so a scan that stops reading one
of them fails there rather than returning a clean smaller set — the failure mode that let this sit.

Two mutations, one per newly-visible spelling: a credential header planted behind a constant, and one
planted in the dot form. Each reds naming the planted header. Source restored byte-identical.

**What remains outside, stated because a reach is an assumption until it is written down:** a header name
built at runtime rather than declared as a constant. Nothing does that today.

## V-1516 — four security exemptions checked against source; all four hold

V-1515 found a real gap by testing a guard's declared blind spot, so this batch worked the same vein
deliberately: **hand-maintained exemption lists**, which V-1511 proved can be wrong in the worst way —
my own seven entries there were each justified by a true sentence supporting a false conclusion.

Forty-one guards carry an exemption, allowlist or skip constant. This entry records the four highest-stakes
ones, checked against source rather than read. No defect. Recording it because the next sweep should not
re-derive these, and because an exemption that has been verified is worth more than one that has merely
not been questioned.

**`admin-routes-authorization-invariant` — nothing to check.** `STUB_EXEMPTIONS` is an empty array, and
the scan is a TypeScript AST walk rather than a regex. The strongest state an exemption list can be in.

**`every-minted-secret-prefix-is-in-the-redactor` — three prefixes declared public, all correct.**
`ord_` is a crypto order id that ships in receipts and customer-facing order URLs. `oac_` is an OAuth
client*id, public by the spec, and its entry already records that it named the authorization CODE until
V-1453 moved that to `oag*`.

`oaa_` was the one worth the time, because its reason is a security judgement rather than an
observation: _"a one-time authorization_id for the consent flow; a handle the consent UI carries, not a
bearer credential."_ It holds, and decisively. `POST /v1/oauth/authorize/complete` requires
`app.requireAuth`, then refuses any API key — `ctx.webSession === null` throws _"OAuth authorization
requires an interactive dashboard session"_, with the reasoning written beside it: accepting a key there
would let a stolen limited credential launder its authority into an OAuth token that survives key
revocation. It gates on `apiAccess`, and binds the issued code to the AUTHENTICATED caller's account
rather than any body-supplied `account_id`. Someone holding an `oaa_` handle scraped from a log has
nothing: they still need an interactive dashboard session for the victim's account, which is strictly
more than the handle would give them.

**`byok-plaintext-call-sites-are-pinned` — two decrypt sites, both doing what their reason claims.**
The AgentRuntime path sends the key to Anthropic for the turn. The test endpoint needs the real key to
ask Anthropic whether it works. And the adjacent surface is clean in the direction that would matter
most: `GET /v1/account/me/byok-anthropic-key` is commented _"metadata only; NEVER returns plaintext"_ and
returns exactly `has_key`, `set_at`, `last_used_at`.

**`an-exempt-surface-that-can-drop-a-field-is-listed` — already the analysis I would have run.** It
measures which exempt schemas can drop a field at all (a schema with no optional field answers 400 on a
mistyped key), reports the split across the body-parsing schemas on those surfaces, and says outright
that `status-subscribe`'s exemption reaches the right conclusion from a premise V-951 had already
measured as unsound. Nothing to add.

### What this batch says about the vein

V-1515 tested one declared blind spot and found a real gap on the first try. Four exemption lists later,
the pattern is different: these are careful, and two of them anticipate exactly the failure I was hunting
for. The vein is not exhausted — thirty-seven exemption lists remain unchecked — but the yield here is
lower than the blind-spot sentences were, and the difference is instructive. A blind spot is what an
author knew they had not covered; an exemption is what they decided after looking. The first is a gap by
construction, the second only fails when the reasoning was wrong.

Worth carrying forward: check the exemptions whose reason is a JUDGEMENT ("not a bearer credential", "not
a customer's resource") before the ones whose reason is an OBSERVATION ("this file declares no default").
The judgement is where a wrong conclusion can hide behind a true sentence — which is precisely how
V-1511's seven entries survived.

## V-1517 — the one admin audit wrapper that can skip a row, and the union that keeps it honest

V-1516 closed by saying blind-spot sentences yield better than exemption lists, so this batch went back to
them and picked the highest-stakes one available: `admin-audit-route-coverage-invariant`, whose header
carries a ⚠️ paragraph stating that it _"asserts an audit CALL exists in the handler, not that it is
correct or that it fires on every path. A handler that records the wrong action, or skips the call on an
early return, passes here."_

That is a compliance surface — the sentence a SOC2 auditor or a DPO cites — with a written admission that
one class of failure is invisible to it. Worth testing rather than reading.

**`withAudit` is defined separately in each admin route file.** Not imported from one place: a private
copy per file, hand-maintained, with no equivalence check between them — the shape `requireScope` has and
covers with an exhaustive matrix, and these do not.

Five copies are structurally identical: `try { perform(); record success } catch { record error; throw }`.
One is not. `admin-incidents.ts` takes an extra parameter, `shouldRecordSuccess`, that lets a caller skip
the SUCCESS row, and exactly one call site passes it — the idempotent PUT, with
`() => result?.outcome === 'created'`.

**It is correct, and establishing that took reading the service rather than the route.**
`createWithId` answers `'created' | 'replayed'`; a replay writes nothing, so auditing it would file a
second `incident.created` row for one logical creation. Suppressing it is right. Failures are unaffected —
the catch records regardless of the flag — and a `'mismatch'` throws into that catch.

**What was wrong is that nothing said so, and nothing checked it.** The parameter had no comment, the
call site had no comment, and the existing content pin froze the suppression's EXISTENCE
(`shouldRecordSuccess: () => boolean = () => true`, `if (shouldRecordSuccess()) {`) without a word about
why skipping an audit is safe there. A pin that freezes a suppression and not its justification is a pin
that will preserve the suppression after the justification stops being true.

The decision is now written at both places, and the arm reads the outcome union out of the service. Add a
third outcome — one that mutates — and the same line becomes a staff mutation with no trace; the arm reds
first, naming what to do. Proven by adding `'updated'` to the union.

The second negative is the comment itself: removing the call-site reason reds the pin, so the explanation
cannot quietly drop out and leave the bare conditional behind.

### Why this was worth a batch when the answer was "correct"

Nothing here was broken, and the entry says so plainly. What was there was an undocumented divergence in
a hand-copied helper, on the one path a compliance guard states it cannot see, guarded by a pin that
froze the mechanism and not the reason. Each of those is individually defensible and together they are
how a correct suppression outlives its premise — which is precisely the failure V-1511 recorded when my
own seven exemptions each cited a true sentence in support of a false conclusion.

**Also measured, and clean.** Every admin route file's success and error audit branches are 1:1, so no
handler records a success without a matching failure path. The mutations in `admin-force-actions` sit
INSIDE their `withAudit` callback rather than before it, so the audit is structural and cannot be
bypassed by an early return. And `admin-owner`'s hand-written audits — the secrets surface — audit before
the response leaves on both success and failure, with the benign not-found exclusion documented against
D-025 in the sibling handler.

## V-1518 — the D-\* decision items, recovered from the repo and checked

The sweep instructions have asked for "the D-\* decision items" every batch, and the plan file naming them
has not existed on disk for this entire session. V-1517 turned up `D-025` cited in a route comment, which
made the obvious question askable: is the decision register in the repo?

It is. `docs/decisions.md` holds **D-001 through D-036**, each with a Decision, Reasoning, an
authority Tier, and a V-log reference. So the D-\* items are recoverable without the missing plan.

**Thirty-four are settled and landed. Exactly two are open, and neither is mine to close:**

- **D-033 — audit-log retention (90d hot Postgres / R2 archive / 7y total).** Marked
  _"PROPOSED — pending founder review"_, Tier 2 architectural, ADR-006.
- **D-034 — Sentry-first observability destination.** Same status, Tier 2, ADR-005.

Both are vendor/retention-SLA decisions whose own text says they need human review, and the repo's
authority levels put Tier 2 above what an agent settles on its own. Recording them as open is the correct
outcome, not a deferral.

### What could be checked was checked

**D-033's unimplemented state is honestly recorded, and I confirmed the record rather than trusting it.**
`AuditArchiveService` is built and tested and nothing constructs it; the guard
`audit-archive-is-not-scheduled-and-that-is-recorded` says so in its first line and explains why leaving
it unscheduled is deliberate — `archiveTable` DELETES production rows after an R2 upload, so arming it
needs R2 configuration and a staged rollout.

**The conflict that looks obvious is not there, and finding that out required reading which TABLE.** The
marketing audit-log page promises entries are _"retained indefinitely, on every tier — there is no
tier-based retention window"_. An archive service that deletes after 90 days sounds like it contradicts
that outright. It does not: the five tables it bounds are `admin_audit_log`, `processed_stripe_events`,
`legal_acceptances`, `webhook_deliveries` and `session_events`. **`account_audit_log` — the customer-facing
one the page is about — is not among them**, and nothing else purges it. The one comment that mentions
purging beside it concerns the 90-day status-subscriber email purge and notes that the customer table
needs an `accountId` it cannot supply.

So scheduling D-033 as proposed would not falsify the customer promise. That is worth writing down
precisely because the surface reading says it would, and the distinction is a table name.

**D-034 matches what is implemented.** Sentry is initialised in bootstrap, and no second observability
vendor is integrated. The only competing name in the source is a comment in `lib/otel.ts` listing
possible OTLP upstreams — env-configured, not a vendor, and so not the DPA-amendment cost the decision is
reasoning about.

### The half of the claim that was prose

The marketing page's guard already names the reason its promise is true — its arm title says the only
audit-shaped sweep "explicitly excludes this table — see apps/server/src/services/audit-archive.ts
AUDIT_TABLES". Only the PAGE was asserted. The code side sat in the title, which is the shape V-1517
committed a fix for one batch earlier: a pin that freezes a claim and not the fact that makes it true.

The arm now reads the roster and holds it to that claim. Adding `account_audit_log` to `AUDIT_TABLES`
reds it with the sentence a future reader needs — correct the promise or exclude the table. So if D-033
is approved, the customer promise is checked at the moment the archive grows rather than whenever someone
next reads two files together.

### For the human, not the agent

D-033 and D-034 are the two items the sweep has been asking about that only a person can close. Both have
an ADR and a V-log entry; neither is blocked on engineering. If either is approved, the work that follows
is concrete: D-033 means wiring `AuditArchiveService` into the recurring-job registry behind R2
configuration and a staging rehearsal, and it should be re-checked against the customer retention promise
at that point — not because it conflicts today, but because the promise and the archive live in different
files with nothing comparing them.

## V-1519 — an open product decision that lived only in a test constant

V-1518 recovered `docs/decisions.md` as the canonical register and established that it carries OPEN items,
not just settled ones — D-033 and D-034 both sit there marked pending review. That makes a checkable
question available: **is every open decision in the register?**

`an-anonymous-exemption-is-earned-per-route` records one that is not. Its `DROPS_SILENTLY` constant is
introduced as _"the two anonymous routes where the drop is REAL, recorded as an open decision"_, with the
reasoning that wiring the reporter _"changes what an unauthenticated caller sees, which is a product
decision rather than a defect fix"_. The register has no entry for it, and no `D-*` covers the
unknown-field mechanism at all.

So the decision was real, deliberate, well-reasoned — and discoverable only by reading a test file's
constant. Someone reading the register to learn what is undecided would not find it.

**The behaviour, verified rather than taken from the guard.** A mistyped optional field is dropped by
zod's strip, so `POST /v1/auth/signup` with `nam` instead of `name` answers 201 with the account created
unnamed. Wiring `reportUnknownRequestFields` is additive by construction: `lib/unknown-request-fields.ts`
sets the `x-driftstack-unknown-fields` response header and logs, and its own header states the response
body is unchanged, so no existing integration can break on it. That is what makes this a decision about
what an unauthenticated caller is told rather than a defect to fix quietly.

It is recorded as `D-2026-08-24-01`, in the register's current dated ID style, marked OPEN and explicitly
not decided. The tier is left unplaced with the reasons for both readings written down — additive header
argues Tier 2, any change to an unauthenticated surface argues Tier 3 — because guessing a tier in an
authority register is worse than admitting the question.

### I nearly recorded the wrong set, and the guard's own arm caught it

The entry was written naming TWO routes, which is what `DROPS_SILENTLY` holds. The arm directly below it
says they are two of THREE: `POST /v1/oauth/revoke` is the third, invisible to the schema-driven arms
because its body is declared in the route file rather than api-types, with `token_type_hint` optional per
RFC 7009 and no reporter call. A caller who misspells it is answered 200 with the hint discarded.

Recording two of three in a canonical register would have been worse than recording nothing: an
authoritative-looking entry that undercounts, which the next reader has no reason to re-derive. The set is
enumerated in the entry now, and the arm asserts the register names every route it knows about — including
the route-local one, by name, since that is precisely the member a schema-driven list cannot supply.

Both negatives exercise that: dropping the third route from the entry reds it, and deleting the entry reds
it. The register restored byte-identical.

**Why the tie matters more than the entry.** A register entry is prose, and prose about a checked
behaviour drifts from it silently — the failure V-1517 fixed in an audit suppression and V-1518 fixed in a
retention promise, both in the last two batches. The guard that pins the behaviour now also asserts the
record of it, so the two move together or the run fails.

## V-1520 — a second open decision outside the register, this one about money

V-1519 asked whether every open decision is in the canonical register and found one that was not. Asking
it as a sweep rather than an incident: eighteen files under `apps/server` describe something as open,
undecided, or a product call. The highest-stakes of them is not in the register either.

`an-unbounded-paid-session-is-a-visible-choice` states it plainly: _"WHAT IS ACTUALLY UNDECIDED is the
number: how long a paid session must run before it counts as abandoned. That is a product call with real
customer consequences … so this file does not invent one."_

**Verified in source before recording it.** `MAX_SESSION_MINUTES_PER_TIER` sets `free: 20` and `null` for
all seven paid tiers, and `durationCutoffsFor` skips a null cap outright — `continue`, with the comment
"unlimited — never auto-destroyed". So no paid session is ever auto-destroyed on duration. Session minutes
are a billed dimension, and `db/usage-repo.ts` records that lifecycle rows are the durable authority for
them because "production never had a complete session-minute writer".

**What I did not verify, I did not assert.** The guard's analysis of how an indefinitely-open session
accrues is cited rather than restated: I traced the billed dimension to the lifecycle-derived
`session_minute` ledger but did not locate the accrual expression itself, and writing a billing mechanic
into an authority register on a partial trace is exactly the move that produced V-1511's seven wrong
exemptions. The register entry says where the analysis lives instead.

The decision is recorded as `D-2026-08-24-02`, marked OPEN, with the tier left unplaced. The engineering
is genuinely trivial — `durationCutoffsFor` iterates the whole tier enum, so capping a paid tier is one
value in one table — and saying so matters, because "hard to change" is the usual reason an open item
stays open and it does not apply here. What is hard is the number.

### The tie is what stops the record rotting

The entry names each uncapped tier, and the guard asserts it names every tier the source shows as
uncapped. A tier added to the enum without a cap therefore cannot join the abandoned-session exposure
silently — it fails until the register lists it. Both negatives exercise that: dropping `enterprise` from
the entry reds naming that tier, and deleting the entry reds.

That is the third batch running where the defect was not in behaviour but in a record — an audit
suppression whose justification was unpinned (V-1517), a retention promise whose code side was prose
(V-1518), an open decision living in a test constant (V-1519), and now a billing posture recorded
nowhere a reviewer would look. None of them was broken. Each was one edit away from becoming wrong with
nothing to catch it.

### Sweep status

Two of the eighteen are now registered. The rest read as prose that happens to use the word rather than
decisions awaiting an answer, on the sampling done here — `services/legal.ts`, `crypto-orders.ts` and the
remaining guards were not individually opened, and that is stated so the next sweep knows the difference
between checked and unexamined.

## V-1521 — the numbered actions have a plausible source in the repo, and the standing list is stale against it

V-1519 said the numbered actions were unrecoverable because nothing in the repo cites `apply-plan.md` or
`sweep-report.md`. That was true and the conclusion was too strong: the FILENAMES are absent, the
numbering is not.

Following the `D-2` reference in `the-public-bucket-holds-what-config-says-it-holds` — which does not
resolve to the register's `D-002` (workspace layout) and belongs to a separate single-digit series —
leads to `docs/internal/2026-06-02-resilience-arc-and-founder-decision-queue.md` §2,
**FOUNDER-DECISION QUEUE (gated — Agent-2 cannot safely self-do these)**, a numbered list of items each
gated on a product/policy call.

**The overlap with the standing task list is close enough to be worth acting on, and I am stating it as
evidence rather than proof.** The list I am given as REMAINING is 5, 7, 8, 12, 13, 15, 16, 19, 20, 22–33,
35–37, 38a. Against that queue:

| item  | queue status                                              | in my remaining list |
| ----- | --------------------------------------------------------- | -------------------- |
| 5     | CORS/trustProxy — LOCKED                                  | yes                  |
| 6     | later RESOLVED on prod, smoke-tested                      | **no**               |
| 7     | agent_sessions strict-FK — needs the FK behaviour decided | yes                  |
| 8     | iphone17 cutover — needs Agent-1 readiness                | yes                  |
| 11–12 | deploy approval-gate / CI-gating — founder cadence        | 12 yes               |
| 13    | CF-skip — founder cadence                                 | yes                  |
| 15    | MFA recovery-code regen step-up — SHIPPED                 | yes                  |

Item 6 being resolved AND absent from the remaining list is the strongest signal: that is what a list
maintained against this queue looks like. Items 7, 8, 12 and 13 are present in both and all four are
explicitly "genuinely need founder input / a spec (NOT auto-doable)".

**Item 15 is the exception, and it is a real staleness finding.** The queue records it shipped, and it is:
`POST /v1/account/mfa/recovery-codes/regenerate` carries `app.requireMfaFresh()` and
`requireInteractiveWebSession` in its preHandler chain, with the source comment explaining that an
existing recovery code satisfies step-up before regenerating — closing the
mint-codes → satisfy-step-up → disable bypass the queue describes. Verified in the route, not taken from
the queue's own claim.

So at least one item the sweep has been asking me to work every batch is already done in the repo.

### What this does and does not establish

It does not give me the numbered actions. The queue's items do not run to 38, the mapping is inferred
from six overlaps rather than read from a manifest, and acting on a guessed correspondence is how a
census produces confident nonsense — the failure this session has recorded repeatedly. I am not treating
"action 7" and "queue item 7" as the same thing on this evidence.

What it does establish is where to look, and that the standing list has drifted from the repo in at least
one place. Both are worth more to the next batch than another self-directed hunt.

**The four gated items in both lists are, per the queue's own words, not auto-doable:** the agent_sessions
FK needs a cascade/restrict/set-null decision plus a plan for existing orphan rows (a breaking migration),
the iphone17 cutover needs Agent-1 to confirm canvas/atlas readiness, and 12/13 are deploy-gating and
CF-skip on founder cadence. None is blocked on engineering effort; each is blocked on an answer.

## V-1522 — checking the gated queue against the code: one more resolved, one genuinely open, one inert divergence

V-1521 found a numbered queue in `docs/internal/` whose items overlap the standing task list, and offered
the correspondence as evidence rather than proof. This batch tested it further by checking items against
source instead of reading their status lines.

**Item 11 — production deploys have no human approval gate — is RESOLVED, and it is absent from the
standing list.** `deploy.yml` declares `environment: name: production` on the prod job, with the comment
that the environment is configured in repo settings to require approval before the job runs. Staging has
its own environment and deploys unattended, which matches the header's stated two-environment flow.

That is the second independently verified resolved-and-absent item, after item 6 (`PERMISSIVE_CORS`,
smoke-tested on prod). Two resolved items missing from the list, five open items present in it, and one
anomaly — the correspondence is now well enough evidenced to say the queue is very probably the source,
while still not being a manifest.

**Item 12 — prod deploy is not gated on CI passing — is genuinely open.** Verified rather than assumed:
`deploy.yml` triggers on `push: [main]` plus `workflow_dispatch`, carries no `workflow_run` trigger, and
contains no test invocation at all; `ci.yml` triggers independently on the same push. So the two run in
parallel and tests do not gate the deploy, exactly as the item describes. It is not mine to change — the
item says so itself, and a wrong `workflow_run` restructure can halt every deploy or create races.

**Item 15's fix is not only shipped but pinned.** V-1521 verified `requireMfaFresh()` on the
recovery-code regen route; the follow-up question is whether anything stops it being removed.
`routes-account-mfa-content-parity` quotes the entire preHandler chain — `requireAuth`,
`requireScope('account_owner')`, `requireInteractiveWebSession`, `requireMfaFresh()`, `rateLimit` — with
an arm title naming the bypass it closes. A security fix that survives only until someone tidies a
preHandler array is not really shipped; this one is guarded.

### Item 9's three copies: a divergence that cannot fire

The queue flags `BACKOFF_MS_BY_ATTEMPT` defined three times, marked LOW. That is the duplication class
V-1517 found diverging in the admin audit wrappers, so it was worth checking rather than trusting the
severity label.

The tables are identical — `1: 60s, 2: 5m, 3: 15m, 4: 30m, 5: 60m` in both
`durable-webhook-delivery.ts` and `webhook-worker.ts`. The **fallbacks differ**, and by a factor of sixty:
the durable rail reads `?? 60 * 60_000`, the worker `?? 60_000`. On its face that is a failing endpoint
retried every minute on one rail and every hour on the other.

It cannot happen. Both lookups are dominated by a DLQ guard — `attemptNumber >= DEFAULT_MAX_ATTEMPTS` (6)
in the durable rail, `nextAttemptIndex >= MAX_ATTEMPTS` (6) in the worker — and both tables carry keys 1
through 5, so every reachable lookup hits. The two fallbacks are defensive defaults that no input reaches.

Recorded because the divergence is real and the consequence is nil, and those are different things. The
next person to notice two unequal fallbacks should find the reachability argument here rather than
re-deriving it, or worse, "fixing" one to match the other and believing something changed.

### Batch shape, stated plainly

No code changed. Four claims were checked against source and three of them confirmed what the queue
already said; the fourth found a divergence and proved it inert. The value is that the standing list can
now be trimmed with evidence — items 6, 11 and 15 are done, item 12 is real and blocked on a decision
that is not an engineering one.

## V-1523 — a latent bug that my own registration would activate

The gated queue's item 19(a) records a latent finding: the duration sweeper's `minCapFor` resolves the
`max_session_minutes` recorded on a destroy event by taking the SMALLEST cap across the matched cutoff
tiers, which is _"correct today (only `free` is capped → always 20), wrong once a 2nd tier gains a cap"_.

That is not idle. V-1520 registered `D-2026-08-24-02` — whether the seven paid tiers should have a
duration cap — as an open decision. **Approving it is what turns this latent finding into a live defect**,
and nothing connected the two.

**Verified against source rather than taken from the queue.** `tickOnce` builds `cutoffTiers` as a Set
from `durationCutoffsFor`, and the per-candidate line reads `minCapFor(cutoffTiers)` under a comment
saying the tier is not carried on the `SessionRecord` so the minimum applicable cap is used. The helper's
own docstring says it is "kept general so a future second capped tier degrades safely" — degrades, not
stays correct. With two capped tiers, a paid session destroyed at its own longer cap reports the free
tier's twenty minutes in its destroy event.

**Fix versus guard, and why this is a guard.** The correct repair is to carry the candidate's tier on the
row `listExpiredForAutoDestroy` returns, which changes a repo interface, its in-memory double, and their
pins — larger than a latent, explicitly-deferred item warrants, and not something to land on the way past.
What is cheap and right is to make the precondition fail the moment it stops holding, so the repair
happens when it is actually needed and by someone who has decided to cap a tier.

The arm is titled as a precondition rather than a demonstration, deliberately. Demonstrating the wrong
value needs two capped tiers, and the cap table is a `const` — so an arm claiming to show the bug would be
claiming more than it does. It asserts exactly one tier is capped, and fails with the repair spelled out:
carry the tier on the row before capping another tier.

**The second assertion is what keeps the first honest.** A precondition guard is worthless if the strategy
it protects quietly disappears — the arm would go on passing while guarding a rule nothing applies. So it
also asserts the sweeper still calls `minCapFor(cutoffTiers)`. Replacing that call with a literal reds it,
which is the same failure V-1517 and V-1518 fixed elsewhere: a check that outlives the thing it checks.

Both negatives exercised through the real build: capping `solo_manual` at 600 and rebuilding api-types
reds the precondition arm naming the repair (and one other arm, correctly — a second capped tier changes
sweep behaviour), and replacing the `minCapFor` call reds the anchor. Sources restored byte-identical.

### What this batch did not do

Item 19 carries two more latent findings — (b) self-re-arm fan-out under poller retry, whose robust fix
touches the prior-incident dedup logic, and (c) audit-archive R2 month partitioning. Both are left alone
and neither is now guarded. They are named here so the next sweep knows they were read and skipped rather
than missed: (b) needs the dedup review the item asks for, and (c) belongs with D-033, which is one of the
decisions already waiting.

## V-1524 — item 19 closed out: one guarded, one fixed six weeks after it was written, one unreachable

V-1523 guarded item 19(a) and named (b) and (c) as read-and-skipped. This batch finished them, and the
result is that a whole listed item can be struck with evidence rather than left as an open unknown.

### (b) was true when written and is not true now

The item says the self-re-arming jobs "re-arm `dedup:false` inside the handler" before `markComplete`, so
a `markComplete` throw retries a handler that has already armed a successor and the chains fan out.

The mechanism is real — `handler(job)` and `markComplete` sit in one `try`, so a throw from the latter
retries the former. The premise is not. Every one of the thirteen self-re-arming jobs passes
`dedupOnAccountAndType: true` with `dedupAfterRunAt: currentRunAt`, and the repo's predicate dedups
against any successor that is unfinished (`completedAt IS NULL AND failedAt IS NULL`) with a later
`runAt`. The retry's re-arm therefore collapses into the successor the first pass created.

Dated rather than asserted: the item is documented 2026-06-03, and `dedupAfterRunAt` was introduced
2026-07-14 in `9c09b1518` — "fix(scheduler): deduplicate recurring successors". The item was correct for
six weeks and has been wrong since.

**It is also already guarded, better than I would have guarded it.**
`recurring-scheduler-successor-dedup` asserts exactly this invariant and DISCOVERS its consumers from the
`register*Job` export convention rather than trusting a roster — its own header records that discovery
found three jobs the hand list had never checked. Nothing for me to add, which is the correct outcome to
report rather than a reason to add something.

### (c) is still latent and cannot fire

`windowStart` is `extractTimestamp(archivable[0])` — the oldest archivable row — and the R2 object key is
`YYYY/MM` from it, so a multi-month window does land in one mislabelled file exactly as the item says.

It cannot happen today for the reason V-1518 established: nothing constructs `AuditArchiveService`. The
defect sits behind an unscheduled service, which in turn sits behind D-033, one of the decisions already
waiting. Correctly parked, and now recorded as parked-because-unreachable rather than merely deferred.

### Item 19, complete

| sub-item                             | state                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------- |
| (a) `minCapFor` smallest-cap payload | latent; precondition now fails before a second capped tier lands (V-1523) |
| (b) self-re-arm fan-out              | FIXED 2026-07-14, and guarded by a discovery-based invariant              |
| (c) archive month partitioning       | latent, unreachable while the archive is unscheduled; belongs with D-033  |

No code changed this batch. What it produces is a listed action that can be closed with dates and commits
behind it, and a second stale entry in the queue after item 15 — which matters for how much the standing
list should be trusted, not just for this item.

## V-1525 — the no-decision backlog, surveyed: mostly already done

Three of the last four batches produced no code change, and the honest reason is worth stating rather
than working around: the items still on the standing list are gated on decisions, already shipped, or
need a migration. This batch tested that claim against the one section where auto-doable work would
live — §4 of the queue, headed **"NO decision required now — surfaced for visibility"**, twenty items.

**§4.3 — rate-limit coverage drift-guard — SHIPPED**, and the item says so in its own text:
`route-mutation-ratelimit-coverage-invariant` statically classifies every mutating route into
limiter / admin-scope / gated-stub / explicit-exempt.

**§4.19 — the coordinated-disclosure policy's 404'ing honour-roll link — RESOLVED.** The item describes a
researcher following a live legal policy to a dead page. `vulnerability-disclosure.md` now reads
"Add you to a public researcher roll of honour — a page we will…" as plain prose with no markdown link,
and two separate guards assert the link form cannot come back
(`not.toMatch(/\]\(\/legal\/security-research-honour-roll\)/)`). The content question the item reserved
for a human is moot: the dead link is gone, and the remaining sentence is an honest forward statement.

**§4.13 — `session.failed` forwarding the raw driver `error_message` — FIXED and guarded.** This one
mattered most: the payload goes to customer endpoints, so a verbatim driver string is an info-leak.
`projectSessionFailedData` maps every failure onto a closed four-class set with fixed copy, and
`session-event-metadata.test.ts` proves it — "classifies only the closed runtime classes and emits fixed
copy", "projects arbitrary session.failed input without retaining extensions or raw copy", and, best of
the three, "fails closed for hostile getters without retaining or rethrowing their diagnostics".

**§4.7 — agent-sessions idempotency body-mismatch observability — accurately described, and not
auto-doable.** Crypto checkout is body-hash aware and counts mismatches; the agent-session create path is
key-only, because the schema has `idempotency_key` and no request-hash column. Closing the observability
gap means adding that column, which is a migration.

Its secondary claim was worth checking on its own: that the key-only behaviour matches the documented
contract. It does, and the reference page is better than the item implies — it answers "what happens if I
send the same key with a different body?" per surface: agent message turns reject with `409` and
`idempotency_status: "mismatch"`, crypto checkout replays the original order verbatim with
`Idempotent-Replayed: 1`, and the agent-session create path replays the existing session. Three surfaces,
three different behaviours, all stated.

### The pattern is now the finding

Verified done, against a list that still asks for them: item 6 (`PERMISSIVE_CORS`), item 11 (deploy
approval gate), item 15 (MFA regen step-up), item 19(b) (self-re-arm fan-out, fixed six weeks after it was
written), §4.3, §4.13 and §4.19. Seven items, each checked in source with a commit, a guard, or both
behind it.

That is a large enough fraction to change how the list should be read. Two batches ago the conclusion was
"the standing list has drifted in at least one place"; on this evidence the drift is systematic, and the
useful next step is trimming it rather than re-deriving each item.

What genuinely remains, with nothing blocking it but an answer: items 7 (agent_sessions FK behaviour), 8
(iphone17 cutover, cross-agent), 12 (deploy gated on CI), 13 (CF-skip), §4.7 (needs a migration), plus the
four registered decisions — D-033, D-034, D-2026-08-24-01 and D-2026-08-24-02.

## V-1526 — three more backlog items checked, all done, and one I nearly reported as broken

V-1525 concluded the backlog was "mostly already done" from four samples of twenty. That was a thin basis
for a claim about a whole section, so this batch sampled three more — chosen for being security-relevant
rather than convenient — and the conclusion holds.

**§4.8 — health-probe auto-incident info-leak — FIXED, and fixed well.** The item describes
`evaluateThresholds` interpolating a raw probe `errorMessage` into a `public: true` incident, where a
network failure's text (`connect ECONNREFUSED 10.x.x.x:port`) reaches the unauthenticated status page.
The call now reads `sanitizePublicProbeError(lastErr)`, and that function is an ALLOWLIST: only
`^HTTP \d{3}$` survives verbatim, everything else becomes "a connectivity error". Allowlist rather than a
strip-the-bad-parts regex, which is the difference between a sanitiser that fails closed and one that
fails on the format nobody anticipated.

It is guarded on both sides: a content-parity pin quotes the whole `incidents.create` call including the
sanitiser, and `health-probe-service.test.ts` carries a describe block named for the leak, asserting
`connect ECONNREFUSED 10.0.0.5:8443` does not survive.

**§4.12 — unauthenticated token-consume and session routes lacking an IP gate — FIXED.** `routes/auth.ts`
declares eight named `ipRateLimit` gates, including `magicLinkConsumeGate` and
`passwordResetConfirmGate` — the token-consume pair the item names.

### §4.15 is the one worth writing down, because I nearly filed it as live

The item says the public `/v1/status/stream` has "no app-level limiter at all". I grepped the route
registration for a `preHandler` and found none, while its sibling `/v1/status/sla` on the same router
carries `statusSlaGate`. An unauthenticated SSE stream with no limiter beside one that has a gate is a
sharp-looking finding, and it is wrong.

The cap is in the handler body, not the preHandler chain: `MAX_TOTAL_CONNECTIONS = 500`,
`MAX_CONNECTIONS_PER_IP = 10`, checked before the hijack so a rejected connection never allocates, with
the counters released idempotently on close and error. Its comment names the same audit the queue item
came from. So the protection is stronger than a rate limiter — a concurrent-connection bound rather than
an open-rate bound — and my grep missed it by looking for the shape I expected instead of the behaviour.

That is the same fault as the `requireScope`-only scope census in V-1509 and the literal-only header scan
in V-1515: searching for one spelling of a mechanism and reading its absence as the absence of the
mechanism. It has now produced a near-miss three times, and the correction each time was to ask what the
code DOES rather than where I assumed it would be written.

### Sample and conclusion

Checked across both sections now: §2 items 6, 11, 12, 15, 19; §4 items 3, 7, 8, 12, 13, 15, 19. Ten are
done, one (§4.7) is accurately described and needs a migration, and item 12 is genuinely open and
explicitly not an autopilot edit.

The claim V-1525 made on four samples survives eleven, and the useful form of it is unchanged: the
standing list should be trimmed against the repo before more effort goes into it, because the majority of
what it still asks for has already landed.

## V-1527 — a customer key reachable by a spelling its guard did not scan

My last three batches each nearly filed a false finding by grepping for one spelling of a mechanism and
reading its absence as the absence of the mechanism — the scope census that saw only `requireScope`, the
header scan that saw only bracket-literals, the SSE limiter I looked for in a preHandler while it sat in
the handler body. That is a repeatable fault, so this batch used it deliberately as an instrument: find a
guard that scans for ONE spelling of a thing the codebase reaches by several.

`byok-plaintext-call-sites-are-pinned` is the highest-stakes candidate — a customer's Anthropic key —
and its own header states the premise the scan rests on: _"The only way the plaintext exists in process
at all is `BYOKAnthropicService.getPlaintext`."_

**That sentence is true about how the plaintext ENTERS the process and false about how a file can obtain
it.** `InMemoryByokKeyCache` retains the plaintext for the life of an agent session, and
`get(agentSessionId)` returns it with no decrypt involved. The scan matched `\.getPlaintext\(` only, so a
new file reading the cache would hold the same customer secret and the guard whose stated job is "a new
file decrypting the key fails here" would pass it.

**Nothing is currently wrong, and the reason is a coincidence.** The single cache read is
`routes/agent-sessions.ts:4616`, which was already pinned for its decrypt call, so the allowed set is
unchanged and widening the scan reports nothing new. The neighbouring consumer is better than that:
`routes/account-byok-anthropic.ts` takes the cache as `{ deleteByAccount(accountId: string): number }` —
a narrowed structural type that cannot read a key at all, which is a stronger guarantee than any scan.

A set that is correct by coincidence is exactly the state to fix before the coincidence ends, and the
proof is not an argument. A throwaway file whose only content is
`return byokKeyCache.get(id)` — no decrypt anywhere in it — **passes the old scan and is named by the
new one**, measured both ways rather than reasoned about.

The header now says which route is which: `getPlaintext` is how the key enters, the cache is how it is
held, and both are scanned. The service file and the cache module are excluded from the population, since
declaring the accessor is not the same as reaching for it.

### Why this instrument keeps working

Three near-misses and one real gap, all the same shape: a mechanism has more than one spelling, a scan
knows one, and the gap is invisible precisely because the scan is green. V-1515 found `authorization`
and `cookie` unseen by a redaction census. This found a customer secret reachable past a decrypt census.
Both guards were careful, well-reasoned files whose authors wrote the limiting sentence down — which is
what made them findable.

The generalisation worth keeping: **when a guard's header states what the only way to do something is,
that sentence is the hypothesis to test, not the reason to skip testing.**

## V-1528 — the plaintext-once invariant knew three secrets; the surface publishes six

V-1527's instrument, applied again: a guard whose scope is a hand-named list is a hypothesis about the
population, and the population is checkable.

`plaintext-once-secrets-cross-source-invariant` pins three api-types schemas — the API-key mint response,
the web-session token, and the two webhook secret responses — and states its fear plainly: a _"server
leaking plaintext on read endpoints"_.

**The published surface returns a once-only secret from six places, not three.** Derived from the
document rather than from the file's list:

```
POST /v1/api-keys                                 plaintext      pinned here
POST /v1/webhooks                                 secret         pinned here
POST /v1/webhooks/{id}/rotate-secret              secret         pinned here
POST /v1/auth/cli-authorize/exchange              api_key        pinned elsewhere
POST /v1/admin/oauth/clients                      client_secret  pinned elsewhere
POST /v1/admin/oauth/clients/{id}/rotate-secret   client_secret  pinned elsewhere
```

**Nothing is leaking, and I checked before saying so.** No GET response on the surface carries any of
these fields. The CLI-authorize plaintext is covered by its own parity file, which pins the complementary
claim — the bind response _"NEVER"_ carries the key, only `/exchange` does — and the OAuth pair is pinned
in the docs parity file. So all six contracts hold and all six are guarded; what was incomplete is the
invariant that exists for the class.

**The fix asserts the property the header cares about instead of extending the list.** Adding three more
schema pins would duplicate work already done elsewhere and would still be a list. The new arm reads every
successful GET response in the document and requires that none publishes a once-only secret field — so a
future read endpoint that returns one fails here even if its schema was never named. Proven by adding
`secret` to the `GET /v1/webhooks` row schema: it reds with `GET /v1/webhooks 200 -> secret`.

`token` and `value` are deliberately excluded from the field set, and the arm says why: both are
overloaded on this surface — a LiveKit token, a cookie value, an extracted page value — so including them
would make the arm noisy rather than strict. A guard that cries wolf gets switched off, which is this
repo's own recorded reasoning.

The parse is asserted non-empty first, since an arm reporting an absence passes perfectly against a spec
it failed to read.

### The instrument, three for three

V-1515 found `authorization` and `cookie` unseen by a redaction census. V-1527 found a customer key
reachable past a decrypt census. This found a secret class whose invariant covered half of it. Each time
the guard was careful, the author wrote the limiting sentence down, and the sentence was the thing to
test — and each time the answer was "nothing is broken, and the check was narrower than its own stated
purpose".

That distinction is worth keeping separate from a defect count: none of the three was a bug. All three
were checks that would not have caught the bug they exist for.

## V-1529 — a guard that already documents its own bypass, and still had it

Fourth application of the V-1527 instrument, and the strongest result: this one is a live reach-around,
not a narrow-but-currently-correct scan.

`mfa-encryption-key-shared-cross-source-invariant` protects the property that four secret-encryption
classes — BYOK Anthropic, gui*control_key, LiveKit, MFA TOTP — all draw AES-256-GCM key material from a
single `MFA_ENCRYPTION_KEY`. The guarantee it exists to keep is operator-facing: \_one rotation rotates all
four ciphertexts*. Its header names the exact refactor it fears — "a refactor that introduces a separate
`LIVEKIT_ENCRYPTION_KEY`" — and one of its arms states the absolute: **`config.ts` is the only place an
`*_ENCRYPTION_KEY` env may be read at all.**

**That is a claim about the whole tree, and it was checked against one file.** The scan ran
`process.env.([A-Z_]*ENCRYPTION_KEY)` over `bootstrap.ts` only.

The arm's own title is what makes this sharp. It records a previous mutation — giving LiveKit
`process.env.LIVEKIT_ENCRYPTION_KEY ?? config.mfaEncryptionKey` **in bootstrap** — and says catching it is
why the arm exists. The identical refactor written in a service file is invisible. Measured, not argued: a
throwaway `services/rogue-encryption-probe.ts` whose body is
`Buffer.from(process.env.LIVEKIT_ENCRYPTION_KEY ?? '', 'base64')` feeding `createDecipheriv` left the file
**9/9 GREEN**. A second key source, a class that no longer rotates with the others, and the invariant that
exists for precisely that says nothing.

Nothing is currently wrong: the tree has exactly one `*_ENCRYPTION_KEY` env read, `config.ts:842`, and
zero `process.env` reads anywhere under `apps/server/src`. The property holds; the check for it did not.

**The scan now walks `apps/server/src`**, reusing the walker idiom the file already had for
`aadPurposes()`, excluding `config.ts` as the sanctioned reader — whose one-key-exactly assertion is
unchanged. Both spellings are matched, `process.env.X` and `process.env['X']`, since the second was
equally unreachable by the old regex. Proven both ways; each reds naming file and variable:

```
rogue-encryption-probe.ts:LIVEKIT_ENCRYPTION_KEY
```

Arm count unchanged at 9 — this widens an existing assertion rather than adding one, because the
assertion was already the right assertion.

### What the instrument has now found, four for four

|        | guard                       | stated absolute                                | what it could not see                 |
| ------ | --------------------------- | ---------------------------------------------- | ------------------------------------- |
| V-1515 | credential-header redaction | every credential header                        | `authorization`, `cookie` in dot form |
| V-1527 | BYOK plaintext call sites   | "the only way the plaintext exists in process" | the session key cache                 |
| V-1528 | plaintext-once secrets      | "leaking plaintext on read endpoints"          | three of six once-only secrets        |
| V-1529 | shared encryption key       | "the only place an env may be read"            | every file except bootstrap.ts        |

The first three were narrow scans over correct code. This one had a documented bypass — the arm describes
the mutation it catches, and the same mutation one directory over walks past it. That is worth separating
from the others when judging how much the green matters: a guard can be simultaneously well-reasoned,
well-commented, mutation-tested, and checking a fraction of what its sentence claims.

The rule holds and is now worth stating as procedure rather than observation: **when a guard's header
states the only way to do something, the scope of the scan must equal the scope of the sentence** — and
the way to find out is to write the violation and watch the guard stay green.

## V-1530 — the same instrument, applied to the anonymous-exemption area: no gap, proven

Four consecutive batches found a guard whose scan was narrower than its sentence, so the honest next step
was to check whether the instrument is finding real gaps or just finding whatever it is pointed at. This
batch pointed it at the strongest remaining candidate and the answer was **no gap**.

Rather than pick by hand again, the candidate set was derived: 43 guards state an absolute ("the only
way/place/caller/path/source"), and 32 of those read a fixed file list with no tree walk. Most are false
positives on inspection — "the only way to observe the thing that was broken" describes test technique,
not a population. The ones making a claim about the CODEBASE are a much smaller set, and the sharpest is
`an-anonymous-exemption-is-earned-per-route`, because a silent field drop on an unauthenticated route is
the kind of thing that stays wrong quietly.

It looks like a textbook instance. Its header commits to hand-maintained arithmetic — _"Measured across
the fifteen … ELEVEN are importable from api-types and drop-proof … TWO more are defined inside
`auth-oauth-client.ts` … That leaves TWO where the drop is real. 11 + 2 + 2 = 15."_ — the thirteen schemas
arrive through a hand-written import list, and one arm openly records the list failing once already:
_"POST /v1/oauth/revoke is the third silent-drop route, **and it was in neither list**."_ A hand-list that
has already missed a member is exactly the shape of the last four findings.

**It is backed by a derived ratchet in a sibling file, and I checked before concluding.**
`unknown-request-fields-coverage-invariant` walks `src/routes`, extracts every parse site by regex, and
holds unreported sites in a `KNOWN_UNREPORTED` set that is checked in BOTH directions — a new unreported
site fails, and an entry that no longer corresponds to a live site is reported stale. Its author also
declined to classify anonymity mechanically and said so, which is why the anonymous reasoning lives in the
other file as prose: the two files split derivation from judgement on purpose.

A clean census is not evidence, so the member was mutated rather than counted: a new route file with an
optional field, a `safeParse(req.body)`, and no reporter call — the exact shape the hand-list would miss.
It reds, naming `probe-anon-signup.ts:11`. The route the hand-list could not see is caught by the walk.

No code change. The finding is the boundary: **a hand-list is not a defect when a derived guard covers the
same population**, and the way to tell the two apart is to add the member and watch, not to read the list.

### The instrument, scored honestly

Five applications: four gaps (V-1515 header spellings, V-1527 the BYOK cache route, V-1528 three of six
once-only secrets, V-1529 a documented bypass one directory over) and one confirmed-closed. It is worth
keeping, and it is not a guarantee — which is the useful thing to know about it before pointing it at the
remaining candidates.

## V-1531 — a third spec axis, and my own instrument had the fault I keep finding in others'

The spec is code here: `packages/sdk-python` is generated from it, so a status code the server can return
and the document omits reaches customers as a branch their client cannot model — an untyped success for a
2xx, a missing error class for a 4xx.

Two neighbouring guards stop just short of that. `openapi-route-coverage` compares METHOD + PATH, so an
operation can be fully covered and still declare the wrong codes. `openapi-responses-conform-to-the-spec`
validates response BODIES against the schema, which by construction cannot see a code no arm exercises.
Nothing checked the codes themselves.

**The measurement, and how badly the first one lied.** A regex draft matching `app.<method>(` reported
EIGHTEEN operations returning an undeclared code, including GETs apparently returning 201. Every one was
false, for two separate reasons found by reading the source rather than the output:

1. `app.post<{ Params: { id: string }; Body: { name?: string } }>(` puts a TypeScript generic between the
   method name and the paren. The pattern required `(` immediately, so every typed registration was
   invisible — and because block boundaries were derived from matched registrations, each invisible
   handler's codes were attributed to whichever plain registration preceded it. 18 → 1.
2. The survivor, `POST /v1/account/mfa/verify` "returning" 204, was a `reply.code(204)` inside
   `disableHandler` — a `const` declared between two registrations and lexically inside neither. 1 → 0.

**The true answer is zero.** 264 registrations resolve to published operations and not one returns an
undeclared literal code.

That is the finding worth recording, but it is not the useful part. **The instrument I have spent four
batches pointing at other people's guards had exactly the fault it was built to find** — one spelling of a
mechanism taken for the whole mechanism — and it produced eighteen confident, specific, false findings
before the first source read. The repo already had the answer: `openapi-route-coverage` parses
registrations with the TypeScript compiler, which is precisely why it has neither bug. Reaching for the
canonical tool instead of a hand-rolled scan would have skipped both.

**The new guard therefore reads the AST**, resolves an identifier handler to its `const` declaration in
the same file, and — because the two bugs above were both silent under-reads — COUNTS the registrations it
cannot resolve and asserts a ceiling on them, so the blind spot is a number rather than a silence. A
non-vacuity arm pins >200 resolved registrations and >150 mapping to published operations, since a scan
that resolved nothing would satisfy an emptiness assertion perfectly.

Mutation-proved on all three registration forms, because two of them were the bugs:

```
plain        POST /v1/account/mfa/verify returns 410, declares 200/400/401/403/409/429
generic      POST /v1/api-keys/{id}/rotate returns 410, declares 201/400/401/403/404/429
const-handler DELETE /v1/account/mfa   returns 418, declares 204/400/401/403/429
```

One of those mutations was itself invalid on the first attempt — I picked 409 for a route that already
declares 409, and the arm correctly stayed green. Worth keeping in the record: a mutation that fails to
red is a claim about the mutation until the mutation is checked.

`EXPECTED_TEST_FILES` 3014→3015 and `EXPECTED_TEST_FILES_ALL` 3176→3177, one file, mine.

## V-1532 — sixty-six request bodies the document said were optional

A different key from the one this file already guards. Its existing arms compare a FIELD's shape between
schema and document; `requestBody.required` sits beside `content`, not inside the schema, so an operation
whose schema lists ten required properties can still publish the body itself as omissible. Nothing
compared that key.

**It was wrong on 66 of the 92 operations that take a JSON body**, including
`POST /v1/auth/login`. The handler is `LoginRequestSchema.safeParse(req.body)` — an absent body is not an
object, so the parse fails and the server answers 400. The document said the body could be left out.
Others in the set: `POST /v1/api-keys` (needs `name`, `scopes`), `POST /v1/auth/password-reset/confirm`
(`token`, `new_password`), `POST /v1/admin/incidents` (`title`, `description`, `severity`).

**The impact is narrower than it first looks, and the check matters more than the framing.** I started to
write that this ships a broken SDK, then read the generator: `packages/sdk-python/scripts/generate.sh`
runs `datamodel-codegen`, which emits Pydantic MODELS only. The method signatures in
`src/driftstack/resources/*.py` are hand-written, and `auth.py` already takes `body` as a required
positional. So our own SDK is unaffected; what consumes this key is third-party client generation and
spec tooling, where an optional body on a 400-ing endpoint is a documented lie. Real, and not the
catastrophe the first draft of this paragraph claimed.

The criterion is the schema's own `required` array, which holds regardless of whether a handler writes
`request.body ?? {}` — 42 sites do, and `{}` still fails a schema with required fields. After the fix, 76
operations are marked required, 0 are understated, and 0 are marked required whose schema requires
nothing.

**Nothing in 3186 test files noticed 66 operations changing.** That is the more useful half of the
finding, so the invariant is now pinned here rather than left to the next person to rediscover: derived
from the document, not listed, with a non-vacuity floor of >80 bodies because an emptiness assertion is
satisfied perfectly by a document that parsed to nothing. Mutation ran through SOURCE and regeneration —
drop the flag in `openapi.ts`, re-dump, and the arm reds naming `POST /v1/auth/login` — rather than
hand-editing the JSON, which would have proved only that the arm can read a file I just edited.

### Three tool bugs in one batch, all mine, all the same shape

Worth recording together because the frequency is the point. Writing the fix, my own editing script:

1. iterated matches from the ORIGINAL string while mutating that string, so every insertion shifted the
   offsets after it — 22 of 66 applied, silently. Fixed by applying in reverse.
2. required a newline before `body:`, so three MFA descriptors written inline as
   `request: { body: { content: ... } }` were skipped — and the count said 63 of 66, which is the only
   reason I looked.
3. (V-1531, same session) matched `app.<method>(` and missed every generic-parameterized registration.

Each was caught by a count that did not match what I expected, never by reading the code back. The
transferable rule: **make the tool report the size of what it changed against the size of what it
intended, and treat any gap as a bug in the tool rather than a quirk of the input.**

## V-1533 — a hold whose stated reason was already false when it was written

Continuing the V-1532 vein: keys that sit beside the schema and no schema-comparison sees. The census came
back clean on four of them — all 106 path parameters correctly required, no duplicate `operationId`, every
operation carrying a summary or description, every response described. One number stood out: 187 of 232
operations carry no `operationId` at all.

That is not a defect. `operationId` is being rolled out per resource group, and the split is almost
perfectly clean — whole groups are named or unnamed, with **one** exception: `sessions`, 12 named and 2
not.

The two are `POST` and `GET /v1/sessions/{id}/proxy`. A sibling guard describes that route as
"undocumented because it does not work", so the obvious reading is that the hold is deliberate. It was —
`a7f3dfd30` (2026-05-31) says so in its own message:

> Deliberately held: the two /v1/sessions/{id}/proxy egress routes (no SDK method; ...)

**The reason is false, and it was false on the day it was written.** `packages/sdk-typescript` has an
`EgressResource` with `attachToSession()` → `POST /v1/sessions/{id}/proxy` and `getSessionProxy()` →
`GET /v1/sessions/{id}/proxy`. It landed in `041ef7a91` on **2026-05-16** — fifteen days BEFORE the commit
that held the operations back for want of an SDK method. So the two published operations a customer's
generated client reaches through a typed SDK method are the only two in a completed resource that a
generator must name from the path, while all twelve neighbours get stable names.

Named `attachSessionProxy` and `getSessionProxy`, following the transform every other group uses —
`createProfile`, `listTrashedProfiles`, `getSessionState` — rather than copying the SDK method name
verbatim, since `attachToSession` says nothing about what is attached once it is a global identifier.
Both are unique.

**The route being unfinished does not change this**, and I checked rather than assumed, because the
standing brief names "a route 503s pre-launch" as a claim this report has got wrong before. The POST does
throw `FeatureUnavailableError` (503) — but only after `ValidationError`/`BadRequestError`, so "every path
through it 503s" is not exact, and the active registrar's GET answers 404, not 503. The file's own V-823
header records all of this. Naming an operation changes no behaviour; it changes what a generated client
calls it.

**The guard is the point.** The invariant is not "name everything" — the rollout is deliberately partial,
with auth, billing, crypto, account and admin still to come. It is: **a resource group that carries any
operationId carries one on all of its published operations.** That excludes the unstarted groups by
construction rather than by a list, so a group joins the check the day it gets its first id, and no
exemption roster can go stale. Added beside the uniqueness arm that already owns this key.

Proved twice, both through source and a re-dump rather than a hand-edited document: removing
`getSessionProxy` reds naming `GET /v1/sessions/{id}/proxy` — the exact state this batch repaired — and
removing `exportProfile` reds naming `GET /v1/profiles/{id}/export`, confirming the arm fires for any
rolled-out group rather than only the one I was looking at. The first attempt at the second mutation
edited too much at once and I could not tell which assertion had fired; a red whose reason is unread is
not a proof.

### The shape worth carrying forward

The reason for an exception lived in a commit message. Commit messages are written once and never re-read
when the world changes underneath them — and here the world had already changed before the message was
written. Two of the last four findings have this shape: a deliberate, well-argued exclusion that nothing
re-checks. **An exception needs a home that gets re-evaluated, and a test is such a home.**

**Gate note.** The full run for this batch was 30929 passed / 1 failed, and the red is not this work:
`|gui-jsdom| tests/unit/use-admin-csv-export.test.tsx > bounds a stalled export with actionable recovery`,
which expects `kind: 'failed'` after `advanceTimersByTimeAsync(15_000)` and observed `kind: 'downloading'`.
It passes 3/3 in isolation, `apps/gui-client` carries no uncommitted change, and nothing this batch touched
(the spec, a server-side spec guard, this log) is reachable from a CSV-export hook. Order-dependent fake
timers in another project's suite. Left for its owner rather than absorbed here, and recorded rather than
rounded to green.

## V-1534 — a 402 the customer can hit and the document never mentioned

The exemption-roster instrument came back clean this batch: `UNENFORCED_BY_DESIGN` is empty (every boolean
tier feature is enforced), the two `PUBLIC_EXEMPTIONS` I traced hold — the IDP callback really does only
302 to `config.dashboardOrigin` with no token exchange, and `/v1/archetypes` really does filter to
`{launch, available}` — and three of six `NO_404_BY_DESIGN` reasons check out in source, including the
delegated one (`triggerNow` hands to a bootstrap stub that resolves without a lookup). These rosters are
well kept.

What it did surface is a blind spot in **my own guard from this session**. V-1531 scans literal
`reply.code(n)` inside a resolved handler. Errors that are THROWN never appear that way.

**`POST /v1/agent-sessions/{id}/message` can answer 402 and the document declared no 402 anywhere at
all.** Traced through the AST rather than by proximity: the route handler calls `handleAgentMessage`
(L5001), which calls `executeAgentMessage` (L4437), which throws `BundledLlmBudgetExhaustedError` when the
account's monthly bundled-LLM spend reaches its cap and `BundledLlmConsentRequiredError` when the
deployment offers bundled-LLM the account never opted into. `normaliseError` returns an `ApiError`
unchanged and the handler emits `apiError.status`, so the 402 reaches the customer.

The omission defeated a stated design intent — the budget error's own comment reads:

> Status 402 Payment Required so SDK consumers can branch on the status code AND the typed problem-type URI

Both causes are recoverable by the caller (raise the cap, grant consent, or supply a BYOK key, which
always wins), and the budget variant carries `spent_cents`/`cap_cents` so a dashboard can render the exact
numbers. All of that was unreachable from the document. Now declared, with the two causes distinguished
by problem-type URI.

### The guard I wrote, measured, and threw away

The obvious generalisation is "every status an ApiError subclass throws in a route file is declared by
some operation in that file". I wrote it. It reported six more violations. **One I checked was false, and
its falseness condemns the whole design**: `status-stream.ts` throws 503 from `GET /v1/status/stream`,
which is _not published at all_, and the arm judged it against the declared set of `/v1/status/sla`, a
published sibling in the same file. File granularity manufactures failures wherever a file mixes published
and unpublished operations, and shipping it with six exemptions would have enshrined that noise as
signal.

Attributing a throw to an operation needs a call graph — the 402 itself sits two frames below its
handler — so the honest arm is the narrow one: pin that this operation declares 402, pin that both error
classes still carry 402, and pin that both are still thrown. If either is retyped the arm fails rather
than continuing to assert a code nothing raises. Proved both ways: removing the 402 from source and
re-dumping reds, and retyping the budget error 402→409 with the spec untouched reds on a different
assertion.

**The five unverified measurements are recorded, not fixed and not exempted**: `agent-sessions.ts` throws
422 and 502, `internal-atlas-priority.ts` and `mac-nodes-register.ts` throw 503, `mac-nodes-register.ts`
throws 409. Each needs the same AST trace the 402 got before anyone says whether it is real — the
status-stream case is exactly why.

**Process deviation, disclosed.** For the second mutation I edited `apps/server/src/lib/errors.ts` without
snapshotting it first and restored it through git rather than from the scratchpad. Verified clean
afterwards — `git diff` on that file is empty and `status: 402` is intact. Separately, the snapshot I did
take of `openapi.ts` predated the fix, so restoring it silently reverted the 402; caught by re-reading the
regenerated document rather than by any test, and re-applied.

## V-1535 — the five recorded measurements, traced: three real, twelve not

V-1534 left five measurements explicitly unverified rather than fixing or exempting them. Leaving them
would have been the exact failure this arc keeps finding in other people's work — a recorded exception
nobody re-reads — so this batch built the tool that was missing and finished them.

**The tool.** A call-graph tracer over the route AST: resolve every `ApiError` subclass to its status, find
each `throw` and attribute it to the innermost NAMED enclosing function, record which named functions call
which, then propagate to a fixpoint and read off the codes reachable from each route registration. Its own
correctness was checked first against a known answer — it reproduces both 402s V-1534 traced by hand,
which sit two frames below their handler. A tracer that missed those would have been worthless and would
have looked clean.

It reported 15 operations throwing an undeclared code. **Three are real. Twelve are not, and the reasons
are worth more than the fixes.**

**Seven false — a shared error mapper.** `auth.ts` routes catch service failures and call
`mapAuthFlowError`, which switches an `AuthFlowError` code onto one of five typed errors, one of them
`EmailAlreadyRegisteredError` (409). Propagation therefore hands all five codes to all seven callers, and
accuses `POST /v1/auth/login` of a 409. Every `email_already_registered` in the service is raised inside
`async signup()` — and signup already declares 409. Proximity and propagation are both wrong here; only
reading where the code originates settles it.

**Five unreachable — a dep that is always wired.** The five proxy routes each throw
`FeatureUnavailableError` inline under `if (!accountProxiesRepo)`. `bootstrap.ts` constructs
`new DrizzleAccountProxiesRepo(dbHandle)` unconditionally, so in a real deployment that branch cannot
fire. Declaring 503 there would document a response no customer can receive — the same defect as omitting
one, pointing the other way. Same shape as the V-823 `SocksProxyBackend` note, found independently.

**Three real, now declared:**

```
POST /v1/sessions                      404  unknown or cross-account profile_id
POST /v1/agent-sessions                422  egress proxy undecryptable or failed its pre-launch probe
POST /v1/agent-sessions/{id}/message   502  no usable Anthropic credential for the turn
```

The 404 carries its own corroboration: `POST /v1/profiles/{id}/launch` reaches the same profile resolver
and **already declared 404**, so two published shapes disagreed about one code path. All three are
caller-actionable, which is what makes the omission cost something.

Pinned three ways each — the class still carries the status, the route file still throws it, the operation
still declares it — so retyping the error and deleting the declaration both fail. Proved in all four
directions: removing each of 404/422/502 from source and re-dumping reds naming that operation, and
retyping `ByokAnthropicRequiredError` 502→409 reds on a different assertion.

### A tool bug, caught by its own output

The first insertion pass anchored on `"      429: {"` inside each operation. Two of the three targets
declare their 4xx through an `...errors4xx` spread and have no literal `429:` block, so `index()` ran on
and inserted into whichever LATER operation did. The 404 landed on `POST /v1/auth/oauth-client/start` and
the 422 on `POST /v1/agent-sessions/{id}/livekit-token`.

Caught immediately because the re-measurement said 14 remaining instead of 12 — the fix count did not
match the fix intent. Restored byte-identical, redone by locating each `registerRoute` block by its own
`method`/`path` and inserting after that block's `responses: {`, with the diff then asserted to be exactly
three operations changed and none losing a code.

That is the fourth tooling bug in three batches (V-1531 generics, V-1532 shifting offsets and inline
descriptors, and this), and all four were caught the same way: **a count that did not match the intent.**
Not one was caught by reading the code back. The practice is now explicit — after any bulk edit, diff the
set of things actually changed against the set intended, and treat a mismatch as a bug in the tool.

**Two pins moved, and both were worth the trip.**

`sdk-python-generated-openapi-content-parity` asserts the published document contains no "pre-launch" or
"subject to change" language, and it caught MY copy: the 422 description said the proxy "failed the
pre-launch probe". Reworded to "the reachability probe run before dispatch". A customer-facing copy rule
enforced against the person adding customer-facing copy, which is the only time such a rule is worth
anything.

`parameterised-routes-document-404` failed on `POST /v1/agent-sessions/{id}/message` — a route whose 404
is plainly in the document. The cause was in the guard: it read a fixed **1400-character window** after
`responses:`, and declaring one more response pushed the 404 past the cut. Every code beyond that offset
was invisible, so the guard would report a false missing-404 on any operation whose responses block grew
large enough — silently, and in the direction of accusing correct code. The block is already delimited by
the split on `registerRoute(r, {`, so it now reads to the block's end and no magic length is involved.
Proved still sharp by deleting that route's real 404: it reds naming the operation.

A magic-number window is the same fault as a hand-list — a bound chosen for the data that existed when it
was written. This one had no reason to be 1400 and no comment saying why.

## V-1536 — the same magic number again, one response away from accusing eight routes

V-1535 fixed a fixed-size window in `parameterised-routes-document-404`. A magic bound chosen for the data
that existed when it was written is a class, not an incident, so this batch swept for the class. The
suite has ~40 bounded scans. Most are POSITIVE assertions — `toMatch(/A[\s\S]{0,300}B/)` — where
truncation makes the test fail, which someone notices. The dangerous ones are scans that feed a
completeness or absence answer, and the sharpest was in the same file, in the sibling helper.

`spreadCodes` matched each spread constant's body with `[\s\S]{0,1200}?`. **A bounded regex does not
truncate — it stops matching altogether.** A constant longer than the bound is not partially read; it is
skipped in silence, its codes never enter the map, and every route spreading it is reported as missing
them.

Measured rather than reasoned about:

```
rateLimitHeaders               5267 chars   ALREADY skipped, silently
directSessionOperationErrors    982 chars   82% of the bound — spread by EIGHT routes, carries the 404
directSessionOperationTimeout   169 chars
```

`directSessionOperationErrors` is the one the guard's own comment singles out as carrying 404/409/410/502/503
for the session routes. At 982 of 1200, **one more declared response would have blinded all eight at
once** — and the failure would have arrived as eight correct routes being accused of undocumented 404s,
which is the shape that gets a guard switched off rather than fixed. `rateLimitHeaders` had already
crossed the line; it costs nothing today only because the 404 arm does not need the codes it carries.

The body is now read by matching braces. No length participates in the answer.

**Proved by A/B on identical source**, which is the only way to show a fix for a threshold: pad
`directSessionOperationErrors` to 1628 characters, then run both guards against it. The old bounded
version fails two arms and names `GET /v1/sessions/{id}/state`, `POST /v1/sessions/{id}/capture`,
`/extract`, `/interact` and more as missing a 404 they document perfectly well — including its own
"spreads are resolved" canary, the arm written to catch exactly this. The brace-matched version passes.

The first attempt at that A/B was invalid and worth recording: I wrote the old guard to the repo root,
where `resolve(HERE, '..', '..', '..', '..')` lands somewhere else entirely, so it never really ran and
reported nothing. A control that silently does not execute reads exactly like a control that passes.

### The other half of the class, measured and cleared

Negative assertions with a bounded gap are the theoretically worse shape — `not.toMatch(/A[\s\S]{0,120}B/)`
goes green if someone simply writes more words between A and B. Three exist. All three were checked
against the file each guard actually reads:

- `CryptoQuoteResponseSchema … pay_min_amount` — left anchor present, forbidden token absent.
- `cost estimate … customer bill|invoice total` — left anchor present, forbidden token absent.
- `30 days … purged|deleted` — both halves absent.

None is a live defect: a regression guard whose forbidden phrase is absent is in its resting state, which
is what such a guard is for. The bound still weakens each of them against a wordier reintroduction, but
that is a latent property, not a present fault, and saying so precisely is better than filing three
findings to make the batch look productive.

## V-1537 — the guard that would have found the last two findings by itself

Two sweeps and a ratchet.

**Sweep one, clean: no guard passes because its target vanished.** V-1536 ended on "a control that
silently does not execute reads exactly like a control that passes", which is a searchable class. Across
2371 test files, 16 referenced paths do not exist on disk. Every single one is deliberate: 23 assertions
of the form `expect(existsSync(PAGE)).toBe(false)` — redirect tombstones for deleted marketing mirrors,
the retired dashboard mocks module, `vitest.workspace.ts` after the projects migration, and three apps
asserted to have no `robots.txt` so only the docs site carries one. Nothing vacuous, nothing to fix.

**Sweep two, also clean, and it re-frames the last two batches.** All four problem types behind the codes
V-1534 and V-1535 declared — `BundledLlmBudgetExhausted`, `BundledLlmConsentRequired`,
`ByokAnthropicRequired`, `ProxyValidationFailed` — are modelled in **all three SDKs**. The SDKs were ahead
of the document the whole time. That settles what those findings were: not product gaps, but a contract
that failed to admit errors its own clients already branch on.

**The ratchet.** Attributing a thrown code to an OPERATION needs a call graph, which is why V-1534's
general guard had to be discarded. But at DOCUMENT scope no call graph is needed, and the weaker statement
is still strong: **every problem type reachable from an `ApiError` has its status declared somewhere in
the published contract.**

Measured across the registry: 32 problem types, all 32 bound to a raising `ApiError` with a status, and
exactly one whose status appears nowhere — `Internal` → 500, the catch-all no operation on this surface
documents. Excluded by name, because an exception stated is worth more than an exception that quietly
narrows the check.

It is not a guard written for a fault that already got fixed — it is a guard that reproduces both prior
findings from scratch. Proved by rebuilding each pre-fix world from source and re-dumping:

```
402 removed from the document  ->  BundledLlmBudgetExhausted raises 402
                                   BundledLlmConsentRequired raises 402
422 removed from the document  ->  ProxyValidationFailed raises 422
```

Both would have failed on the day the code was written, naming the exact problem types, with no tracer and
no call graph. Three batches of hand-tracing produced one arm that does the class automatically — which is
the right end state for an arc like this, and the honest measure of whether the hand-tracing was worth it.

## V-1538 — a customer-visible split whose only home was a bus message

Two sweeps closed clean before the finding, and both are worth one line each rather than a batch.

**Per-SDK problem-type coverage: complete, and already guarded better than I would have.** All 32 registry
types are modelled in TypeScript, Python and Go. `cross-sdk-problem-type-coverage-parity` already asserts
it, reads the roster from `PROBLEM_TYPES` rather than restating it — so a new type is covered the moment
it is added, which is the only timing that helps — and proves it through a 34-case matrix across all three
mappers. My measurement reproduced its result and added nothing.

**But its header records a live split, and the split has no durable home.** From that file:

> UNKNOWN type, 500 TS retries it; Python and Go do not

and, a few lines later, that closing it is "raised on the bus rather than taken here". V-1533 found an
exception whose reason lived only in a commit message and was false the day it was written. A bus message
is the same class of home: written once, never re-read.

**Re-verified in each SDK's source rather than taken from the guard.** TypeScript falls through to
`new DriftstackError(toOpts(p.status >= 500 ? 'internal' : 'bad_request', p))` and kind `internal` is
retryable — its own comment calls this "intentionally unchanged". Python resolves
`PROBLEM_TYPE_TO_ERROR.get(problem_type, DriftstackError)`, and `is_retryable` is
`isinstance(err, (TransportError, InternalError, RateLimitError))`, which the base class is not. The same
5xx is transient to one customer and fatal to another, decided by their language.

**The trigger is not hypothetical and it is one I keep pulling.** The gap opens exactly when the server
grows a problem type an installed SDK predates. `PROBLEM_TYPES` holds 32 and has grown four times in
recent work — the two bundled-LLM types and the BYOK one are in the set whose codes V-1534 and V-1535
declared. A customer on an older Python or Go SDK silently stops retrying transient server errors.

Registered as **D-2026-08-24-03**, unplaced by tier rather than guessed, because both resolutions change
published retry behaviour and `sdk-versioning.md` treats that as compatibility-relevant. The entry
deliberately does NOT pin the split: a pin would freeze the disagreement the entry asks a reviewer to
settle. The coverage half stays pinned by the existing guard, so the way in cannot reopen.

No code changed. What changed is that a customer-visible cross-language difference now sits in the
register with the other open decisions instead of in a comment inside a test file.

## V-1539 — ten deferred decisions with no home, and the one that leaks money

V-1538 moved a cross-SDK split out of a test-file comment into the register, on the grounds that a
decision whose only home is a comment is one nobody re-reads. That is a class, so this batch swept it.

**Thirteen guard headers defer a decision** — "a product call", "the SDK owner's call", "raised on the
bus", "NOT taken here". Cross-checked against `docs/decisions.md`: **three have a durable home** — the
paid-session cap, the anonymous-exemption reporting question, and the retry split registered last batch,
all three of which were moved there by this arc. **Ten do not.** Among them: whether a legal-acceptance
reason should silently block key minting, whether admin list-reads write audit rows, whether the SDK error
classes should converge (a MAJOR-bump rename), and the one below.

**The one with money attached: `profiles` is capped only where profiles are acquired.**

Verified in source rather than taken from the guard that found it. `profileLimitFor` has exactly four call
sites and all four are acquisition paths — `create`, restore ("Tier cap is shared with create — same
enforcement path"), clone, and transfer against the RECIPIENT's tier. Its own definition comment says the
cap is "enforced at the /v1/profiles creation gate". Neither `routes/profiles.ts` nor `routes/sessions.ts`
consults it, so listing, loading, binding to a session and saving a retained profile are ungated. Of the
ten sweepers in `services/`, none re-checks profile count on a tier change; the crypto entitlement-expiry
sweeper — the one that exists precisely to walk back an entitlement — does not touch profiles.

So an account that creates 500 profiles on `api_scale` and drops to `free`, cap 1, keeps all 500 and uses
them exactly as before. Only the 501st is refused. Subscribe, create, downgrade, keep.

**The neighbouring caps are the control that makes this a finding rather than an opinion.**
`maxSessionMinutes` has a create gate AND the session-duration sweeper, so a tier change reaches a session
already running. `concurrentSessions` is create-only but self-draining — sessions end, and a downgraded
account cannot start more. `profiles` neither drains nor is swept. One of three numeric caps has no second
half, and it is the one holding durable customer assets.

Registered as **D-2026-08-24-04**, unplaced by tier. The remedy is genuinely a product call: deleting
profiles on downgrade destroys data a customer may be paying to recover, while freezing, refusing to bind,
or a grace window each carry a different refund and support story. Recording that the call is open, and
which cap it applies to, is not a product call.

No code changed. Nine deferrals remain without a home; this was the one with a commercial consequence
rather than a documentation one, and the sweep that found them is now written down so the rest can be
worked through rather than rediscovered.

## V-1540 — the tracer's own blind spot, named and paid for

V-1539 left nine deferrals without a durable home. Working the highest-impact one produced something
better than another register entry: a live undeclared status code, found because the guard's header sent
me to read code the last three batches never scanned.

`a-new-legal-reason-silently-blocks-key-minting` defers a genuine product call — whether a byte-only edit
to a legal document (`content_hash_changed`, a typo fix with no version bump) should block API-key
minting for every account. That is a legal-posture question and stays open. But reading the mechanism it
describes turned up a separable, non-optional fact.

**`POST /v1/api-keys` can answer 409 and did not declare it.** `ApiKeysService.create` calls
`legalGate.required(accountId)` and throws `LegalAcceptanceRequiredError` when anything is pending. That
gate is live rather than a dormant dep: the constructor slot defaults to `null`, and I checked before
believing it — `bootstrap.ts:1054` passes `legalService` into that fourth positional argument, so every
deployment has it.

**And the second path had it too.** The throw has exactly one site, but two routes reach it:
`routes/admin.ts:111` (POST /v1/api-keys) and `routes/auth-cli.ts:102`, which sits inside the registration
for **POST /v1/auth/cli-authorize/bind-device-code**. Neither declared 409. `rotate()` does not consult
the gate, so it is correctly untouched — checked rather than assumed, since rotation also mints a key.

Both now declare it, with a description that carries the recovery: the problem body's
`pending_acceptances` extension names each `document_key` and its `current_version`, which is what makes
the refusal actionable rather than a wall.

### Why the last three batches missed it

Every arm in `a-returned-status-code-is-a-declared-one`, and the call-graph tracer built in V-1535, reads
`apps/server/src/routes`. This throw lives in `apps/server/src/services`. **A route-scoped tracer cannot
see a service-layer refusal**, and it reported clean on both these operations while both were wrong.

That is the same fault this arc has found in five other people's guards and four times in my own tooling —
a scan narrower than the claim it is used to support — so the new arm names its own boundary in its title
rather than leaving the next reader to infer it. The arm pins the chain rather than the conclusion: the
gate is still consulted, the refusal is still raised, the class still carries 409, and both operations
still declare it. Proved in three directions — removing the declaration from each operation reds naming
that operation, and replacing the service's throw reds on a different assertion, so a refusal that moves
away cannot leave two pins quietly asserting a code nothing raises.

The general form — service-layer throws attributed to operations — needs a cross-file call graph and is
not attempted here. What is recorded is that the blind spot exists, has a name, and cost two operations.

## V-1541 — the general form, built: 24 candidates, two fixed, twelve already disproved

V-1540 named the blind spot and said the general form "needs a cross-file call graph and is not attempted
here". Leaving that is the failure this arc keeps finding in other people's work, so this batch built it.

**The tool.** A TypeScript `Program` over `apps/server/src` with the real type checker: every call site
resolved through `checker.getResolvedSignature()` to its actual declaration, so `service.create(...)`
lands on the one method it really calls rather than on every class that happens to declare `create`. Throws
attributed to the innermost enclosing function, propagated to a fixpoint, then read off each route
registration. 251 registrations resolved; 24 operations reach a status the document does not declare.

**Twelve were already disproved in V-1535 and the tool reproduces them, which is the point.** Seven auth
routes reach 409 through `mapAuthFlowError` — the call graph is right and the reachability is wrong, since
only `signup()` can raise `email_already_registered` and signup declares it. Five proxy routes reach 503
under `if (!accountProxiesRepo)`, a dep bootstrap always wires. A type-directed call graph does not make a
path-sensitivity problem go away, and a tool that had quietly stopped reporting them would have been the
more worrying result.

**Two verified and fixed, both customer-facing writes:**

```
POST  /v1/webhooks        409  at MAX_ENDPOINTS_PER_ACCOUNT active endpoints, or `events` supplied empty
PATCH /v1/webhooks/{id}   409  endpoint is disabled (mint a fresh one), or `events` supplied empty
```

Traced to `WebhooksService.create` (lines 400, 421) and `update` (513, 516), reached from
`routes/webhooks.ts:139` and `:241`. No route file contains either throw, so every route-scoped scan this
session reported both operations clean. A customer at the endpoint cap, or patching a disabled endpoint,
gets a refusal their generated client has no model for.

Pinned as a chain rather than a conclusion — the service must still refuse, and the operations must still
declare — proved three ways: removing either declaration reds naming that operation, and downgrading the
disabled-endpoint refusal to a different class reds on a different assertion.

**The remaining ten are recorded, not fixed and not exempted**: `DELETE /v1/profiles/{id}/purge` 409;
`POST /v1/profiles/{id}/launch` and `POST /v1/sessions` 409 and 410; `POST /v1/profiles/{id}/transfer` 409;
`POST /v1/agent-sessions` 409; `GET /v1/profile-snapshots` 404; `GET /v1/billing`,
`GET /v1/account/me/billing-portal`, `POST /v1/billing/checkout-session`,
`POST /v1/billing/portal-session` 404. Each needs its own reachability check — the twelve above are why
that sentence is not a formality.

### A fifth tool bug, same shape, caught the same way

The new arm's helper took the first `{` after `async create(` as the method body. That is the parameter
type object, so the assertion ran against a destructured signature and failed on a method nobody had
touched. Fixed by matching the parameter list's parentheses first. Caught because a fresh assertion failed
against known-good source — which is the cheap version of the count-versus-intent check the last four bugs
needed.

## V-1542 — six of the ten resolved: two real 410s, four 404s that must NOT be declared

V-1541 left ten measured-but-unverified candidates. Verifying them is the whole point of having recorded
them, so this batch took two clusters and reached opposite conclusions — which is the useful part.

**The four billing 404s are defensive checks, not contract branches, and declaring them would be a
mistake.** All four trace to one line repeated three times in `services/billing.ts`:
`const account = await this.repo.getAccount(accountId); if (account === null) throw new NotFoundError`.
The routes pass `ctx.account.id` (portal) and `effective.accountId` (billing state) — ids `requireAuth`
and the team-scope validation have already resolved. Reaching that throw means the caller's own account
vanished between authentication and the next query. That is an internal inconsistency, in the same
category as the 500 this suite excludes by convention, and publishing it would tell customers a read of
their own billing can answer "account not found" — a branch no client can act on. **Not declared, on
purpose**, and the reason is now in the guard so the next tracer run does not re-raise it as a finding.

**The two session-create 410s are real.** `SessionsService.create` throws `SessionDestroyedError` at
line 615 when the reservation is terminalized DURING dispatch. Its own log event is
`post_dispatch_activation_lost_cleanup_failed` — "session reservation was terminalized during dispatch" —
so a terminal driver failure mid-dispatch reaches it with no customer action at all. That is the
distinction from the billing case: one needs the caller to delete their own account mid-request, the other
happens on its own.

Both `POST /v1/sessions` (calls at lines 288/297) and `POST /v1/profiles/{id}/launch` (380/388) reach that
one method, and neither declared 410. A customer whose create is terminalized got a status their generated
client has no model for, on the most-used write on the surface. Now declared on both, saying plainly that
nothing was left running and no session id is returned.

Pinned as a chain — `create` must still raise it, the class must still carry 410, both operations must
still declare it — and proved three ways, including replacing the throw so a refusal that moves cannot
leave two pins asserting a code nothing raises.

**Recorded honestly:** the second removal's console grep matched the arm's own title rather than the
assertion payload, so the claim that it named `launch` rests on the arm's construction — it filters
exactly the two listed operations and reports those lacking 410 — not on output I read. Stating which
evidence actually carried a conclusion matters more here than the conclusion.

**Four candidates remain unverified**: `DELETE /v1/profiles/{id}/purge` 409,
`POST /v1/profiles/{id}/transfer` 409, `POST /v1/agent-sessions` 409, `GET /v1/profile-snapshots` 404, plus
the 409 on the two session-create paths whose source I did not locate within this batch. Left as measured,
not as exempt.

## V-1543 — the candidate list closed: two more real, one false, and a guard that could not see its own fail-open

The last four of V-1541's ten, traced to their enclosing methods rather than guessed.

**Two real, both customer-addressable, both now declared:**

```
DELETE /v1/profiles/{id}/purge      409  a live agent session still holds the profile
POST   /v1/profiles/{id}/transfer   409  recipient name collision, concurrent transfer-or-delete,
                                         or a live session still holds it
```

Both run through `assertNoActiveSession`, and its reachability turns on a dependency — the method
early-returns when `agentSessions` is null. It is wired: bootstrap passes `agentSessionsRepo` into that
slot, and the comment beside it records why in terms that settle the question, that a null there leaves the
guard "wired but INERT (fail-open)" and would let a bound profile be hard-deleted. So the 409 is live, and
a customer purging a profile with a session running got a refusal their generated client had no model for.

**One false, and instructively so.** `GET /v1/profile-snapshots` was flagged for 404. Only the per-profile
route passes `parentProfileId` into `snapshots.list`, and only that argument reaches the
`findById` → `NotFoundError` branch; the flat list never supplies it. `GET /v1/profiles/{id}/snapshots`
already declares 404. Method-level propagation cannot see which argument a caller supplies — the same
path-insensitivity as `mapAuthFlowError`, now confirmed twice.

### The arm could not detect the thing it was written to detect

The bootstrap wiring is load-bearing, so the arm pins it. Proving that pin took three attempts and both
failures are the point:

1. Matching the raw source. The mutation is `// agentSessionsRepo,` — commenting the argument out — and
   the commented line still contains the identifier, so the match stayed satisfied and the arm stayed
   **green against the exact fail-open it exists to catch**.
2. Stripping comments with a regex. `/\*[\s\S]*?\*/` mis-paired on something in `bootstrap.ts` and deleted
   the region containing `new ProfilesService(` outright — the constructor call vanished, and the arm
   failed against perfectly correct source. Measured rather than inferred: occurrences of
   `new ProfilesService(` went from 1 to 0.
3. Dropping whole comment lines. Passes on correct source, reds when the argument is commented out.

Both failures are the same fault in opposite directions — a text scan that cannot distinguish code from a
comment, first too permissive and then too destructive. This is the sixth tooling bug in this arc, and the
first where the broken version would have shipped looking green; the only reason it did not is that the
mutation was run before the commit rather than after.

**V-1541's list is now closed**: two fixed here, two fixed in V-1542, four disproved as billing defensive
checks, one disproved as path-insensitivity, and twelve that were already disproved in V-1535 and
faithfully reproduced. The remaining `POST /v1/agent-sessions` 409 traces to no throw in its own service
and is left measured rather than guessed at.

## V-1544 — one omission across the three most-used writes, and the same guard bug twice in two batches

The last candidate, `POST /v1/agent-sessions` 409, traced to no throw in its own service — so this batch
walked the call graph to it instead of guessing.

**The chain, resolved through the type checker and shortest-path from the route:**

```
ROUTE POST /v1/agent-sessions
  profiles.ts:assertWithinStorageQuotaForLaunch
    -> StorageQuotaExceededError @profiles.ts:537
```

**And it was never one route.** The gate has two call sites: directly on the agent-session path, and inside
`resolveProfileBinding` in `routes/sessions.ts`, which both `POST /v1/sessions` (line 276) and
`POST /v1/profiles/{id}/launch` (line 371) call — the source itself notes "the storage gate inside
resolveProfileBinding always runs". So one undeclared refusal spanned the three most-used writes on the
surface. It is unconditional: no optional dependency short-circuits it, unlike the proxy 503 and the legal
gate, both checked and both different.

A customer over their tier's stored-profile cap gets 409 with `used_bytes`, `cap_bytes` and `tier` — enough
to act on — and no generated client had a branch for it. Now declared on all three, with the recovery
stated.

### The same fault, one batch after documenting it

V-1543 ended by recording that a text scan cannot distinguish code from a comment, having hit it twice.
This batch's arm hit it a third time: the mutation that proves the pin is "comment the throw out", and
against raw source `.toContain('throw new StorageQuotaExceededError')` still matched the commented line.
**The arm passed while the gate refused nothing.**

Two further mistakes on the way to fixing it, both worth the record:

- My first patch asserted against text prettier had since reformatted across three lines. The `assert`
  fired, the edit did not apply, and the re-run reported the mutation still green — which reads exactly
  like a fix that did not work rather than a patch that never landed. Only the traceback in the output
  distinguished them.
- The correction cuts from `//` to end of line rather than dropping whole comment lines, because here the
  mutation puts live code and the commented-out throw on the SAME line. V-1543's line-dropping approach
  would not have caught it.

That is the seventh tooling bug in this arc and the second of exactly this kind. The pattern is now
unambiguous: **every one was found by running the mutation, and none by reading the assertion back.** A
guard is not proven by looking correct.

**V-1541's list is now fully closed** — every one of its 24 candidates is either fixed with a negative or
disproved with a reason.

## V-1545 — the class swept (clean elsewhere), and a false-green of my own closed at HEAD

The seventh tooling bug was a guard blind to a commented-out line. That is a class, so it got measured
before it got fixed.

**The suite is clean.** 1088 raw-source `toContain` assertions checked against the files their guards
actually read, asking which are satisfied ONLY by a comment. Thirty-three are — and on inspection every one
is deliberate: content-parity guards whose stated job is freezing comment prose, including a literal that
begins `//` and a `PRODUCTION CALLERS MUST INJECT AN SSRF-GUARDED FETCH` warning worth pinning. Filtering
to CODE-shaped literals — a throw, a call, an arrow — leaves two, and both are usage examples inside doc
comments. **Zero live false-greens of this class in anyone else's guard.**

**Mine was the exception, and it was still there.** `a-returned-status-code-is-a-declared-one` had grown
three different answers to one question across ten arms: two arms dropped whole comment lines, one cut at
`//`, and nine reads took raw source. The raw ones include the V-1540 arm that asserts
`throw new BundledLlmConsentRequiredError` is still present — the exact shape that fails.

Proved by A/B rather than argued, running both versions against identical mutated source in the directory
where their relative paths resolve (a lesson from V-1536, where a probe at the repo root silently never
ran):

```
comment out `throw new BundledLlmConsentRequiredError();`
  guard at HEAD (raw source)   10 passed      <- false green, committed
  guard after this change      1 failed       <- names BundledLlmConsentRequiredError
```

So this is not a tidy-up. A pin committed three batches ago did not hold, and nothing would have said so.

**One helper now, `codeOf`, cutting from `//` to end of line.** That handles all three failure modes seen:
raw source misses a commented-out line; a block-comment regex mis-pairs and deletes real code (V-1543,
which removed a whole constructor call and failed against correct source); dropping whole comment lines
misses a mutation that leaves live code and the commented original on ONE line (V-1544). Fourteen call
sites use it. Three raw reads remain and each is right to be raw — the JSON spec, the AST parser's input,
and the helper itself.

Its limitation is stated in the helper rather than left to be discovered: cutting at `//` also truncates a
`https://` inside a string literal. Nothing here asserts on a URL, and the next person to add an arm that
does now finds that written down.

### What the arc says about proof

Seven tooling bugs, and the tally is the argument: **every one surfaced by running a mutation, none by
re-reading an assertion.** Two were in the mutation rather than the guard, one made a control silently not
execute, and one — this one — had already shipped looking green. The practice that caught all of them is
cheap and unreasonably effective: write the violation, watch what happens, and disbelieve any green that
was not earned in front of you.

## V-1546 — finishing the sweep V-1545 said it had finished

V-1545 concluded "zero live false-greens of this class in anyone else's guard". That sentence was broader
than the measurement behind it. The sweep read `.toContain('literal')` assertions only. The suite's dominant
assertion style is `.toMatch(/regex/)`, and a regex is blind to a commented-out line in exactly the same
way. **The claim covered the class; the scan covered one spelling of it** — which is the fault this arc has
now found five times in other people's guards, four times in my own tooling, and here in my own conclusion.

**Measured properly this time, by evaluating the regexes rather than approximating them.** Every
`.toMatch(/…/)` in the suite compiled and run against both the raw source its guard reads and a
comment-stripped copy; a pattern matching the first but not the second is satisfied only by a comment.
20,898 patterns, narrowed to 2,501 that pin something behavioural (a throw, an await, a const, an
equality) rather than prose.

**44 survived, and every one is deliberate.** Documentation sentences that happen to contain `return` or
`===`; code examples inside `@example` blocks, such as the webhook-signature guide's
`app.post('/driftstack-webhook', …)`; and patterns that deliberately spell `//` because they pin a line
together with its trailing comment. Nothing to fix — the same verdict as V-1545, now actually earned for
the whole class.

### The sweep tool had the bug the last batch documented

The first run reported 58. Fourteen of those were mine: my comment stripper cut at the first `//`, which
truncates `'http://localhost:3000'` inside a string literal, so guards pinning a default base URL looked
comment-satisfied. **That is verbatim the limitation written into `codeOf` one batch earlier** — recorded
there as harmless because nothing in that file asserts on a URL, then reused in a sweep where it was not
harmless at all.

Replaced with a stripper that tracks quote state, checked against four cases before being trusted:

```
"const D = 'http://x';"        -> unchanged
"const a = 1; // note"         -> "const a = 1; "
"// whole"                     -> ""
"const u = `https://y`; // t"  -> "const u = `https://y`; "
```

58 → 44, and the fourteen that vanished were the URL ones.

**No code changed in the repo.** What changed is that a conclusion in the log is now supported by the
measurement it claims, and the eighth tooling bug is on the record: a documented limitation is not a
handled one, and the place it bites is the next tool that copies the technique without the context that
made it safe.

## V-1547 — three admin mutations that leave no trace, hidden by a roster keyed on filename

The audit-coverage guard defers a genuine product call — whether admin READS should be audited, a row per
list call against a real control. Reading the mechanism behind that deferral turned up something that is
not a decision at all.

**`every-admin-mutation-writes-an-audit-row` scanned only route files NAMED `admin*`.** Membership of the
admin surface is decided by PATH — the file even has `isAdmin = r.path.startsWith('/v1/admin/')` — but the
file list was keyed on filename. Seven `/v1/admin/` routes live elsewhere: five in `oauth.ts`, two in
`internal-atlas-priority.ts`.

**Three of them are mutations that write no audit row:**

```
POST   /v1/admin/oauth/clients                     register a third-party OAuth client
DELETE /v1/admin/oauth/clients/{id}                revoke one — and every access token it issued
POST   /v1/admin/oauth/clients/{id}/rotate-secret
```

Verified rather than inferred from my own regex, which I did not trust: `oauth.ts` contains no audit call
at all (its single `audit` match is a comment about `revoked_at`), the service it delegates to writes no
admin audit row, and — decisively — `admin_audit_log.action` is a closed enum whose fifteen values include
no `oauth_client.*` at all. These three could not have been audited even by accident.

`docs/decisions.md` stated the opposite: "Every admin endpoint that MUTATES writes the audit row inside the
same handler that performs the action. Failure to audit fails the request." A compliance reader takes that
as covering the surface. It covers 30 of 33.

**The counts there were scoped, not stale.** The register's "30 mutating, 31 GET" matches the guard's view
exactly — both were faithful to a scan that could not see seven routes. The real figures are 33 and 35.
Corrected with the reason, so the next reader learns why two honest numbers disagreed.

### What changed, and what deliberately did not

The scan now reads every route file; `isAdmin` already decided membership correctly. Wiring the three to
an audit row is NOT done here — the enum has no vocabulary for them and the same decision entry records
that adding one is migration-bearing. Quietly reusing an existing action that means something else would
be worse than the gap.

So they are recorded in a set checked in BOTH directions: a new unaudited admin mutation anywhere fails,
and an entry that starts auditing, or is renamed, or is deleted, also fails and must be struck. A backlog
nobody is forced to revisit becomes a permanent exemption — which is precisely how a filename-keyed roster
hid three admin mutations for as long as it did.

Proved both ways: a throwaway `POST /v1/admin/probe-unaudited` added to `webhooks.ts` — a file the old
roster never opened — reds naming the path; adding an audit call to a recorded entry reds with "now writes
an audit row".

## V-1548 — correcting V-1547: the finding was already found, by a file I did not look for

V-1547 presented three unaudited admin OAuth-client mutations as a discovery. **They were already found,
already measured and already recorded** by `admin-audit-route-coverage-invariant` (V-1007), which scans the
whole admin surface, states "33 mutations, of which THREE audit nothing: the admin OAuth-client routes",
carries the identical set as `UNAUDITED_MUTATIONS`, and gives the same reason — the closed
`admin_audit_action` enum makes auditing them a migration, therefore a decision. Its header even names the
worst read: `GET /v1/admin/crypto-orders.csv`, a bulk export of up to 1000 rows of account_id, payment_id
and customer notes.

**This was a process failure with a rule already written for it.** The standing instruction is to grep the
topic and read every plausible hit BEFORE auditing a surface, never dismissing one by filename. There are
fifteen files matching `admin.*audit` in that directory. I opened one, fixed its scope, and wrote up its
contents as new. The three near-identical names —
`every-admin-mutation-writes-an-audit-row`, `every-mutating-admin-route-writes-an-audit-row`,
`admin-audit-route-coverage-invariant` — are exactly the shape the rule exists for.

### What survives from V-1547, stated precisely

- **The scope widening is real.** `every-admin-mutation-writes-an-audit-row` decided membership by path
  while listing files by name, so it could not see seven `/v1/admin/` routes. That is fixed and it is an
  improvement independent of who found the gap.
- **The register correction is right, and was not new either.** 33 mutating and 35 GET are exactly V-1007's
  figures. The correction stands; the framing that it took a fresh measurement does not.
- **The framing was wrong**, and the log now says so where the claim was made.

### The duplication V-1547 created, and what closes it

Recording the same three routes in a second file was itself the fault this arc keeps finding: two copies of
one list drift, and here the drift has a date attached — whichever file is edited when the migration lands
leaves the other asserting a gap that has closed, in a compliance-relevant claim.

So the two sets are now pinned EQUAL, by parsing the sibling's declaration rather than trusting them to be
edited together. Proved both ways: striking `rotate-secret` from the sibling reds with "the two
recorded-unaudited lists have diverged", and renaming its constant reds on the parse with the rename named.
The second matters as much as the first — a mirror that silently stops finding its source is a mirror that
passes forever.

**A sibling with a near-identical name is not prior art you can skip; it is the most likely place the
answer already is.** Three files here differ by word order alone.

## V-1549 — the duplicated-roster class, swept: 51 pairs, one worth checking, sound

V-1548 cost a batch to a list duplicated across two files. That is a checkable class, so it got measured
rather than left as a lesson.

**219 literal rosters** of three or more string entries across the suite; **51 cross-file pairs** share at
least three entries with 60%+ overlap. Almost all are coincidence rather than duplication: `HTTP_METHODS`
in three files is the same five verbs because there are only five; `APP_ROOTS` names the same three app
directories for unrelated scans; `PUBLIC_ROUTES` and `PUBLICLY_CACHEABLE` overlap because a public route
tends to be cacheable, but they encode different properties and must be free to diverge. Overlap is not
duplication — only two rosters encoding ONE claim have to move together.

By that test the sharpest pair is the largest, and it is the one with security consequences: 30-odd
unauthenticated routes recorded once in `every-v1-route-is-gated-or-listed-public` as `PUBLIC_ROUTES` and
once in `openapi-spec-validity-invariant` as `OPERATIONS_WITHOUT_OPENAPI_SECURITY`. **They are not equal —
34 against 30 — which is what made them worth reading rather than pinning.**

Every difference is explained, and each was checked in source:

- `GET /v1/status/incidents/:id` against `/v1/status/incidents/{id}` — the same route in Fastify and
  OpenAPI notation.
- `GET /health`, `GET /version` — outside `/v1/`, so outside the first guard's stated scope.
- `/v1/status/stream`, `/v1/webhooks/nowpayments`, `/v1/webhooks/stripe`, `/v1/auth/oauth-client/callback`
  — not published in the document at all, so they cannot appear in a list of published operations without
  security.
- `GET /v1/fleet/events` is the one that looked wrong: published declaring TWO security schemes while sitting
  in a list of routes with no auth gate. It authenticates — a `preHandler` calling
  `authenticateFleetUpgrade`, so a bad token throws `UnauthorizedError` before the socket opens. The
  guard's entry already says exactly that, and says why it is listed rather than detected: the options
  slice stops at the first async arrow, which for this route IS the preHandler.

So the two rosters differ for four sound reasons and agree everywhere it matters. **No code change**, and
pinning them equal would be wrong — it would force a route outside `/v1/` and an unpublished route into
lists that have no business holding them.

The useful residue is the discriminator, since the sweep's raw output was 51 pairs and its real content was
one: **two rosters need pinning only when they encode the same claim, not when their contents happen to
intersect.** The admin-audit pair failed that test and is pinned; this pair passes it and is not.

## V-1550 — the spec's examples are clean, and the validator that would prove it does not check formats

Pivoting off the guard-meta veins to something customers touch: the `example` values in the published
document are what people copy. All **39** validate against the schemas they sit on. No defect there.

**Getting to that answer took three wrong turns, and each was caught by a control rather than by reading.**

**1. A swallowed failure.** Re-running with formats enabled meant `addFormats(ajv)` inside a
`try {} catch {}`. `ajv-formats` is installed but targets Ajv 8 and throws against Ajv 6 — so formats were
never enabled and the second "0 failures" measured nothing. Same shape as V-1536's probe that silently
never ran. Caught by asking the instrument to reject a value it must reject.

**2. A correction that was backwards, written and reverted before commit.** Bare Ajv 6.15 rejects
`not-a-uuid`, `nope` and `yesterday`, and `validateFormats` is an Ajv **8** option Ajv 6 ignores — so the
shared helper's comment ("`validateFormats: false` because format assertions are advisory") looked like a
documented-but-false claim, and I edited it to say the opposite. Then the new guard failed: through
`createSpecAjv()` those three bad values are ACCEPTED. The helper's stated intent is satisfied; only its
stated mechanism is inert. The comment was restored byte-identical. **Running the test before committing
is the only reason a false correction did not ship.**

**3. A cause I could not demonstrate, so it is not claimed.** The obvious explanation is the interop cast
the helper exists to perform. Resolving `.default` off the module before constructing did NOT switch
formats on, so that guess is unproven and the guard's header says so instead of asserting it. Direct
construction with identical options enforces formats; through this helper it does not. That difference is
measured; its mechanism is not.

### What shipped

A guard pinning the CURRENT behaviour — formats not enforced — with a non-vacuity arm proving the
validator is alive (`type: 'string'` still rejects `42`, and well-formed values of all three formats are
accepted). It is deliberately not a claim that formats should stay off. It is a claim that turning them on
is a decision, because whatever holds them off is not named anywhere: a tidy-up of this helper would make
three response-conformance suites stricter at once, in a diff whose subject is module interop.

Mutation: making the validator inert reds the non-vacuity arm naming the `42` case. The complementary
mutation — forcing the real constructor — did not flip the behaviour, which is precisely the observation
that turned an assertion into an open question.

`EXPECTED_TEST_FILES` 3015→3016 and `_ALL` 3177→3178, one file, mine.

## V-1551 — resolving what V-1550 left open, and correcting what it got wrong

V-1550 ended on an honest gap: through `createSpecAjv()` formats are not enforced, constructed directly
they are, and I declined to name the cause. Leaving that is the failure this arc keeps finding in other
people's work, so this batch closed it. **The answer also invalidates a claim V-1550 made.**

**Two Ajv versions are installed.**

```
node_modules/ajv                6.15.0   hoisted from another dependency
apps/server/node_modules/ajv    8.20.0   what apps/server/package.json declares (^8.17.1)
```

A `require('ajv')` from the repo root — which is what my V-1550 control did — gets 6.15.0, where
`validateFormats` is unknown and formats are enforced. The helper, resolving from `apps/server`, gets
8.20.0, where `validateFormats: false` is a real option that really disables them.

Confirmed from the live instance rather than from a lockfile: its `opts` carry `strictSchema`,
`strictTypes`, `loopEnum` and `code` — all Ajv 8 keys — and `opts.format` is `undefined` where Ajv 6 holds
`'fast'`.

**So the helper does exactly what its comment says, and V-1550's header was wrong** where it stated "this
repo runs Ajv 6.15" and treated the behaviour as unexplained. Corrected in place. The value of the guard
is unchanged but its subject is sharper: it no longer pins a mystery, it pins a **version coupling**.

**Proved at the mechanism.** Moving `apps/server/node_modules/ajv` aside makes the server resolve the
hoisted 6.15.0, and the guard reds with "the shared Ajv started enforcing formats". That is the real
scenario — a dependency bump, a hoist change, or a lockfile refresh — reproduced exactly, not an
approximation of it. Restored and re-verified afterwards.

### A fourth inert control, caught the same way

While checking whether the helper's interop cast is still needed under Ajv 8, a probe importing Ajv
directly typechecked clean. It had not been typechecked at all: `apps/server/tsconfig.json` sets
`exclude: ["tests"]`. A deliberate `const x: number = 'string'` in the same probe also produced no
diagnostic, which is how the emptiness was distinguished from a pass.

So the cast question stays **open and is marked open in the guard**, rather than answered by an instrument
that never looked. That is the fourth silently-inert control this session — after the repo-root probe
(V-1536), the swallowed `addFormats` throw (V-1550), and the patch that never applied (V-1544). Each was
caught by demanding a failure first, and none by reading the code.

**The generalisation worth keeping:** when two runs of the "same" check disagree, suspect that they are not
the same check. Here one `require` and one `import` of the same package name reached different major
versions, and every downstream conclusion inherited that.

## V-1552 — the dependency-split class, and an SSRF invariant confirmed end to end

Two sweeps, both clean, and the second is worth having confirmed rather than assumed.

**Dependency majors: 80 splits, none of ours.** V-1551 found `ajv` resolving to different majors from
different directories, which is a real integrity risk wherever it reaches our own code. Measured across
every nested copy: 80 packages differ in major version between the root hoist and some nested location.
Almost all are transitive deps of third-party tooling — `eslint`, `astro`, `listr2`, `log-update` — where
hoisting is doing its job. Only three reach a workspace we own, and all three are declared:

```
ajv           root 6.15.0  ·  apps/server 8.20.0     apps/server declares ^8.17.1
undici        root 7.28.0  ·  apps/server 8.10.0     apps/server declares ^8.7.0
tailwindcss   root 3.4.19  ·  apps/docs, apps/status-site 4.3.2   each app declares its own
```

`undici` has exactly one importer in our code, `lib/ssrf-guarded-fetch.ts`, which sits in `apps/server` and
therefore gets the 8.x it asked for. Tailwind's 3-versus-4 split is five apps each declaring a version, a
migration in progress rather than a resolution accident. **The ajv surprise in V-1551 was never a
dependency defect either** — `apps/server` declares 8 and gets 8; what was wrong was my control importing
from the repo root.

**The SSRF invariant, confirmed rather than assumed.** `packages/webhook-delivery` carries a warning worth
taking seriously: its `fetch` seam defaults to plain `globalThis.fetch`, and "PRODUCTION CALLERS MUST
INJECT AN SSRF-GUARDED FETCH", because a hostname that resolves publicly at registration can resolve to
loopback or a metadata address by the time a retry fires an hour later.

Bootstrap constructs `WebhookDeliveryWorker` with `repo`, `batchSize`, `logger` and `metrics` — **no
`fetch`** — which reads like the violation the warning describes. It is not. `webhook-worker.ts:326` is
`const fetchImpl = this.config.fetch ?? ssrfGuardedFetch`: the guarded implementation is the DEFAULT, and
the injection point exists as a test seam. The unguarded default lives in the dependency-free package,
which is not constructed in production at all — it appears in `durable-webhook-delivery.ts` only as a
comment naming its predecessor.

So the warning applies to a component production does not use, and the component production does use fails
closed. Checked in that order because the alternative — reading the bootstrap call, seeing no `fetch`, and
filing it — was one step away.

Prior art was checked FIRST this time, which is the V-1548 correction applied: five guards already cover
this surface, including `ssrf-guarded-fetch`, `webhook-target-guard` and
`account-proxies-dispatch-ssrf-reguard`. No new guard was added, because the invariant is enforced by a
default rather than by a wiring decision, and a default cannot be forgotten at a call site.

**No code change in either sweep.** Three consecutive batches have now ended that way, which is itself the
finding: the contract and guard surface reachable by deriving work from the repo is in good order, and the
remaining known work is the part that needs a human — the numbered actions, which are still unrecoverable.

## V-1553 — the billed-dimension rename: consistent today, and the alarming reading was wrong

The `session_minute` → `browser_hour` rename is one of the eight deferrals with no home in the decision
register, and the one with billing exposure: a billed dimension whose stored name and customer-facing
meter were described as different things.

**Three readings, each narrower than the last, and only the third survives contact with the source.**

The comment in `services/usage.ts` says the customer-facing meter is browser-hours via
`floor(session_minute_total / 60)`. Grepped: that division exists **only in that comment**. No conversion
ships. First reading — "the API reports minutes while billing charges hours" — would be a serious units
mismatch.

Then the marketing site turned out to say "browser-hours" on the pricing page, which looked like
confirmation. It is the opposite: those lines are a CRITIQUE of the browser-hour model —
"Browser-hours metering breaks for manual users — an account manager running 3 persistent profiles 8 hours
a day generates 720 browser-hours/month". The pages argue against metering that way rather than claiming
Driftstack does. Reading the two matches instead of counting them is what separated those.

Finally the customer documentation, which is where a customer would actually look:
`apps/docs/src/pages/api/usage.md` publishes the response with `totals.session_minute` and states
`totals.session_minute` is "wall-clock minutes a session was ...". The unit is named, in minutes, on the
page that documents the endpoint returning it.

**So nothing is inconsistent.** Storage, API and documentation all speak minutes; no conversion exists
because none is claimed to; and the rename is genuine future work tied to Stripe Meter integration rather
than a discrepancy shipping today. Not registered as a decision, because there is no open question — only
scheduled work with no customer-visible consequence in the meantime.

### The batch this closes

Four consecutive batches have now ended without a code change, across dependency splits, an SSRF
invariant, and this. That is not a failure of the sweeps — each measured a real class and each came back
clean — but it is the signal worth stating plainly: **the surface reachable by deriving work from the
repository has been worked out.** What remains needs inputs only a human has, and has been listed
unchanged for many batches: the numbered actions from the two missing files, six open decisions, and the
OAuth-client audit gap that needs an enum migration.

## V-1554 — the docs-examples axis: real, unexplored, and NOT reported, because the instrument failed three times

The published spec's own 39 examples were validated in V-1550. The docs SITE carries its own hand-written
ones — **163 JSON blocks across 24 API pages** — and those are what a customer copies. No guard parses
them. That is a genuine gap in coverage and the axis is worth doing.

**What is established.** All 163 blocks were parsed. Eleven do not parse, and all eleven are deliberate
documentation notation rather than defects: `...` elisions inside arrays, `<profile>` placeholders,
`"password" | "mfa_totp"` type unions, `/* same shape as the list entry */`, and `//`-prefixed labels
naming a variant. A customer reads those correctly even though `JSON.parse` does not.

**What is NOT established, and is therefore not reported as findings.** Validating the parseable request
examples against their endpoint's published schema went wrong three times in a row:

1. Matching the method and path from markdown HEADINGS returned **0 of 163**. The pages put
   `` `POST /v1/profiles` `` on its own line as inline code, not in a heading. A run reporting zero
   findings because it examined nothing looks exactly like a clean result.
2. Fixed, it reported **41 failures** — and the first two checked were RESPONSE examples. `api-keys.md`
   labels the block "Response (201):" three lines above. The selector took every block after a method
   line.
3. Response-aware, it reported **12**, whose errors read `(root) should NOT be shorter than 12
characters` against `POST /v1/auth/login`. That is the PASSWORD constraint applied to the whole body,
   so the schema being compiled is a field's, not the request's — the `$ref` resolution is still wrong.

Three readings, three different numbers, and the only ones I confirmed by opening the file were false. So
the twelve are not findings; they are an unfinished measurement. Reporting them would be exactly the
88-96% self-confirmation the standing brief warns about — a tool agreeing with itself.

**The tool is deleted rather than left in the tree**, because a half-right analyser is worse than none: the
next reader would trust its output. What is worth carrying forward is the shape of the target — request
examples on 24 pages, matched by the inline-code method line, stopping at the first Response marker — and
the knowledge that `$ref` resolution against this document needs to be verified against a known-good case
before any result from it is believed.

**This is the fifth silently-inert control this session** (after V-1536's repo-root probe, V-1544's patch
that never applied, V-1550's swallowed throw, and V-1551's excluded tsconfig). Every one produced a
plausible number. The only reason none of them shipped is that each was asked to prove itself on a case
whose answer was already known.

## V-1555 — finishing the docs-examples measurement, and correcting why V-1554 abandoned it

V-1554 stopped with 12 unverified results and concluded the analyser's `$ref` resolution was wrong. **That
conclusion was itself wrong, and the cause ties back to V-1551.**

**Built with controls first this time.** Before extracting anything, five schema lookups with known answers
were run against schemas read straight from the document: a valid login body passes, one missing
`password` fails, one with a short password fails, a valid api-key mint passes, one missing `scopes` fails.
5/5. The resolver was never broken.

**What was broken was the error reporting.** V-1554 read `e.instancePath`, which is the **Ajv 8** property.
This analysis ran from the repo root, where V-1551 established `node_modules/ajv` is **6.15.0** — and Ajv 6
reports `e.dataPath`. Every error therefore printed `(root)`, which read as "the schema is being applied at
the wrong level" when it was simply an undefined field name. The same two-Ajv split that made
`createSpecAjv` skip formats also made a working analyser look broken, one batch later, in a different
tool. **A root cause found once will resurface wherever the same assumption is made.**

**The completed measurement.** 61 request-position blocks extracted from 24 API pages, 56 matched to a
published request schema by exact path with ambiguous shapes refused rather than guessed, and 12 fail their
endpoint's schema. Every one is a documentation placeholder, checked individually:

```
"password": "<password>"                      shorter than the 12-char minimum
"token": "<from the login response>"          shorter than the 32-char minimum, wrong charset
"data_base64" / "content_hash" / "profile_id" placeholder text where a pattern is required
"mode" / "model"                              placeholder where an enum is required
"envelope": { "version": 1, "...": "..." }    explicit elision; the prose says "paste the file"
```

**No defect, and no guard added.** A guard here would have to encode "a placeholder is acceptable", and
every one of these 12 is a placeholder — so the check would be a list of allowances rather than an
invariant, which is the shape this arc keeps finding fails silently. The measurement is the deliverable:
the docs examples are correct where they claim to be literal, and abbreviated where they say they are.

### The instrument tally, closed honestly

V-1554 called this axis unfinished and deleted its analyser rather than report unverified numbers. That was
the right call on the evidence available, and it also means the recorded reason for stopping was wrong.
Both are now on the record: the twelve were real outputs of a working tool, they are all placeholders, and
the misdiagnosis was an Ajv-version assumption inherited from the same split V-1551 documented.

## V-1556 — two packages the server imports and never declared, one of them at runtime

The two-Ajv split has now caused two separate misdiagnoses (V-1550, V-1554), and the underlying hazard is
general: code that depends on where a package happens to be installed rather than on a manifest. That is
checkable across every workspace.

**Measured with the AST, after a regex attempt produced nonsense.** The first scan matched the word `from`
anywhere and reported "packages" like `, label:` and multi-line code fragments — prose and template
literals inside strings. Replaced with a TypeScript AST walk over import, export, `require()` and dynamic
`import()`. **618 source files, and exactly two undeclared imports, both in `apps/server`:**

```
@driftstack/webhook-delivery   services/durable-webhook-delivery.ts   VALUE import, runtime
openapi3-ts                    lib/openapi.ts                          type-only
```

Both resolved anyway, and for different accidental reasons: the workspace root links its own packages into
`node_modules/@driftstack`, and `openapi3-ts` is hoisted there by another dependency. `apps/server` declares
`@driftstack/api-types` and simply never gained the sibling entry.

**The first is the one that matters.** It imports runtime symbols on the durable webhook-delivery path, so
a hoist change, a standalone build of the server, or a layout shift breaks it **at runtime**, not at install
time. The type-only one breaks `tsc` instead — real, but louder and earlier.

Both are now declared, mirroring the existing `@driftstack/api-types: "*"` style and pinning
`openapi3-ts: ^4.5.0` to the 4.5.0 that is installed. `pnpm-lock.yaml` is untracked in this repo, so there
is no committed lockfile to desync. Typecheck stays clean and the full suite is green.

**The guard carries no allowance list, deliberately.** Both offenders were fixed rather than recorded, so
the invariant is exactly "no workspace imports a package it does not declare". An exemption roster here
would become the thing nobody re-reads — the failure mode this arc has found in a filename-keyed roster
(V-1547), a duplicated list (V-1548) and a commit message (V-1533). If a workspace genuinely needs an
undeclared import, that belongs in a diff.

Its scope is stated in the header rather than implied: TypeScript under each workspace's `src/`. `.astro`,
`.svelte` and `.vue` are not parsed, because the compiler cannot read them, so an undeclared import inside
a template is invisible. Naming that is the difference between a guard and a guard that reads as total.

Proved both ways: removing the `@driftstack/webhook-delivery` entry reds naming it, and adding a `fastify`
import to `packages/api-types` reds naming that workspace — so the check works on a package other than the
one it was written for.

`EXPECTED_TEST_FILES` 3016→3017 and `_ALL` 3178→3179, one file, mine.

## V-1557 — closing the blind spot V-1556 wrote into its own header

V-1556 shipped a guard that named what it could not see: `.astro`, `.svelte` and `.vue`, because the
TypeScript compiler cannot read them. Leaving that is the failure this arc keeps finding in other people's
work, and it had a two-batch shelf life at most.

**An Astro frontmatter fence is TypeScript.** So is a `<script>` block. Both are extracted and handed to
the SAME parser the guard already uses, rather than to a second scanner that could disagree with the first.

**Measured before extending, and the number is why the extension is honest rather than theatrical:** 136
template files carry 269 frontmatter import lines, of which **five** are bare specifiers — Astro pages
import relative layouts and data almost exclusively — and none of the five is undeclared. Cross-checked
with an independent crude count so a low number was not mistaken for a broken extractor, which is the
reading that would have ended this batch early.

The non-vacuity arm now asserts the template half separately (>100 files, >200 specifiers), because a
template extractor that silently matched nothing would look exactly like a clean surface.

Proved twice, and the second time mattered: an undeclared `zod` in `pricing.astro`'s frontmatter reds with
"marketing-site imports zod", and breaking the frontmatter regex reds the non-vacuity arm.

### Two process faults, both caught, both worth the record

**The helpers landed before the arms read them.** After adding `templateFiles` and `templateCode` the suite
passed — because nothing called them. That is "adding a field without a reader": a green run that proves
only that new code compiles. Caught by asking what the arms actually scanned.

**The snapshot predated the fix, again.** Restoring the guard after the mutation wiped the whole batch's
edits, exactly as in V-1534. Caught by grepping the restored file for `templateFiles` and getting 0, then
re-applying and re-proving the mutation against the restored version — because a proof run against a file
later overwritten is not a proof of what shipped.

### The mutation broke a guard I had to satisfy properly

Editing `pricing.astro` and restoring it byte-identical still moved its mtime, and
`dist-reading-suites-have-fresh-artifacts` compares mtimes, not content — so the full gate went red with
"marketing-site: built ... but source changed ... — REBUILD, do not repin assertions onto stale markup".
`cmp` reporting byte-identical is not the same as leaving no trace.

Rebuilt the app as the guard instructs rather than back-dating the file, which would have made the guard
green by editing the evidence it reads. 68 pages, and the gate is clean.

## V-1558 — three packages the repo's own tooling uses and no manifest names

V-1556 and V-1557 covered workspace `src/` and template frontmatter. The same hazard lives one directory
up: config files and `scripts/` import packages too, and an undeclared one there breaks CI or a developer
tool rather than a request.

**Measured across 45 config and script files carrying 32 bare-specifier imports. Ten looked undeclared, and
they split cleanly into one false positive and one real finding.**

**Not a defect:** `apps/server/vitest.config.ts` and `apps/gui-client/vitest.config.ts` import `vitest`,
which neither workspace declares. The ROOT declares it (`^4.1.10`) and the root runner executes those
configs — that is resolution working as designed. Judging a workspace config by the workspace manifest is
the wrong rule, and the arm below says so rather than carrying `vitest` in an allowance list.

**A defect:** eight scripts import `playwright`, `postgres` and `sharp`, and **no manifest in the
repository names any of the three** — not the root, not a workspace. They resolve only because something
else hoists them to `node_modules/`. Verified rather than assumed: all three resolve today, at 1.60.0,
3.4.9 and 0.35.3.

None of the eight is referenced by a `package.json` script or a workflow, which is what makes this quiet.
The day a transitive dependency stops carrying `sharp`, the failure reads "the icon generator is broken",
not "a dependency vanished", and nobody connects it to a lockfile change weeks earlier.

Declared in the root `devDependencies` at the versions already installed. **This adds no install weight** —
the packages are being fetched today regardless; the change names what is already there. `apps/server`
already declares its own `postgres` for the driver, so only the tooling copy was unnamed.

The new arm judges `scripts/*` against the ROOT manifest, which is the manifest they actually run under,
and pins the distinction from workspace configs in its title rather than in a list. Proved by removing
`sharp` again: it reds with `sharp (scripts/gen-apple-touch-icon.mjs)`.

**A wrong floor, caught by the count.** The arm's non-vacuity bound was written as `>10` bare-specifier
imports from a figure that covered configs AND scripts; `scripts/` alone has 8, so it failed against
correct code on its first run. Corrected to a bound that is a non-vacuity check rather than a pin — adding
or removing a script must not fail it, but a parser that stopped reading them must — and the reasoning is
in the code beside the number, since a bare `>4` is exactly the kind of unexplained constant V-1536 found
truncating a scan.

## V-1559 — nine phantom imports in test code, and the rule that keeps `vitest` out of the report

The dependency-integrity arc covered workspace `src/` (V-1556), template frontmatter (V-1557) and
configs/scripts (V-1558). Test directories were the last uncovered surface, and they are the largest:
**3266 files carrying 4277 bare-specifier imports.**

**Nine satisfied neither their own manifest nor the root's**, all resolving purely because something else
hoists them:

```
jsdom                    admin-panel, customer-dashboard, docs, marketing-site, status-site   25.0.1
github-slugger           docs                                                                  2.0.0
@driftstack/api-types    docs, marketing-site, status-site                                    workspace
```

The last one is the sharpest: three apps' tests import our OWN workspace package without declaring it, and
it works only because the root links `@driftstack/*` into `node_modules`. All nine are now declared at the
versions already installed, so nothing new is fetched — the change names what is there.

This is the loud direction of the failure: a test breaking stops CI rather than a customer. It still fails
on a day nothing about the test changed, which is what makes it worth naming.

### The rule matters more than the nine

Tests run under the ROOT vitest, so `vitest` is correctly undeclared in every workspace. A naive
"a workspace declares what it imports" check would report it in dozens of files and be switched off within
a week. The arm therefore uses own-manifest OR root — the same distinction V-1558 drew for config
files, applied to the directory tests live in — and that rule is load-bearing rather than decorative:
narrowing it to own-manifest-only immediately reports `:: vitest`, which is the second mutation run here.
Proving the exemption is doing work is as important as proving the check catches a real miss.

Floors are stated as floors: >2000 files and >2000 specifiers against measured 3266 and 4277, with the
reasoning beside them, so adding or deleting tests cannot fail the arm but a walk that stopped finding
them must.

### A snapshot fault, third occurrence, now with a fix

Restoring the guard after the mutation wiped the batch's new arm — the snapshot predated it, as in V-1534
and V-1557. Caught in seconds this time by grepping the restored file for `V-1559` and getting 0.

The pattern is stable enough to name: **a snapshot taken to enable a mutation is not a snapshot of the work
in progress.** The two need separate names, and the cheap check after any restore is to grep for the
identifier of the thing being built, not to trust that a restore only undid the mutation.

## V-1560 — the complement direction: no unused dependencies, and a check that could never have said so

Three batches added fourteen dependency declarations. The complement is the obvious next question and it
doubles as a check on that work: does any workspace declare a package nothing imports?

**The first run reported nothing, and that was the instrument, not the answer.** The scan had a text pass
for packages named in config strings rather than imported — eslint plugins, Astro integrations — and it
walked every file in the workspace, `package.json` included. Every declared dependency appears in
`package.json` by definition, so every one was marked used. **The check could not have reported a finding
under any circumstances.**

Caught by a control rather than by reading: adding `left-pad-does-not-exist-here` to
`packages/api-types` produced no output. With `package.json` excluded from the text pass, the same control
names it immediately. That is the **seventh** silently-inert instrument this session, and the third whose
emptiness was indistinguishable from a pass.

**The real answer, once the tool worked: nothing is unused.** Thirteen workspaces report entries, and every
one is a package that is correctly declared and correctly never imported:

```
typescript, @astrojs/check, @tauri-apps/cli, pagefind    invoked as binaries
autoprefixer, postcss, tailwindcss, @tailwindcss/typography   loaded by config, not by import
@types/node, @types/react, @types/react-dom, @types/ws   ambient types, never imported by name
```

The only one worth opening was `apps/server :: @types/ws`, since a types package for an unused runtime
package would be pure weight. `apps/server` declares `ws` too, and
`tests/integration/fleet-events-websocket.test.ts:25` imports it. Correctly declared.

**No guard added, deliberately.** A guard here needs an allowance list of roughly fifteen entries spanning
three different reasons for never being imported, and that list would rot exactly like the filename-keyed
roster in V-1547 and the duplicated set in V-1548. The check is worth running; it is not worth freezing.

**It also verified the last three batches.** None of the fourteen declarations added in V-1556, V-1558 and
V-1559 appears as unused, so each names something genuinely imported rather than padding a manifest to
satisfy a check I wrote.

## V-1561 — the isolation guard that passed when it scanned nothing

Seven silently-inert instruments of my own this session made the shape worth looking for in the suite's
guards: **a check that reports an absence, with nothing proving it looked at anything.**

**Measured, and narrowed twice, because the first two cuts were wrong.** 389 guards derive a list and assert
it empty — far too broad, since most are behavioural tests where emptiness is the expected result of a
fixture. Restricting to guards that WALK the filesystem gives 197, of which 13 have no `toBeGreaterThan`
floor. That was still wrong: `route-auth-coverage-invariant` appeared on it while carrying
`expect(routes).toHaveLength(288)` — an exact count, which is a STRONGER control than a floor — plus
synthetic-fixture tests proving its detector fires. Counting exact-count pins, `.not.toHaveLength(0)`, and
fixture-driven detector tests as the controls they are leaves **six**.

**One is a real, high-stakes gap.** `unscoped-lookup-containment-invariant` guards the cross-account
isolation boundary: `findSessionUnscoped` and `findApiKeyUnscoped` skip the account predicate, and the arm
asserts no route handler calls either. Its first arm is protected — it walks `SRC` and asserts the
discovered set EQUALS a non-empty expected list, so a broken walk reds there. **The isolation arm walks
`ROUTES_DIR` separately and had no such protection.**

Demonstrated rather than argued, and the first attempt disproved itself: pointing `ROUTES_DIR` at a
MISSING directory fails loudly, because the walker throws. The dangerous case is a directory that exists
and yields nothing — retargeted at `src/db/migrations`, which holds `.sql` and no `.ts`, **all three arms
passed while the isolation check scanned zero files.**

Fixed by asserting the walk found route files before trusting its emptiness, with the measured scenario
written beside it so the number is not a bare constant. Proved both ways: the blind walk that used to pass
now reds naming the count, and a planted `findSessionUnscoped` call in a route still reds naming the
method — so the fix did not buy safety by weakening the thing being guarded.

**Five candidates remain unexamined**, and they are listed rather than implied:
`a-customer-doc-may-not-cite-a-file-that-does-not-exist`, `a-published-route-that-can-never-succeed-is-listed`,
`boolean-env-flags-share-one-truthiness-rule`, `services-webhook-secret-force-rotation-content-parity`,
`the-team-owner-pair-cannot-be-split`. Each needs the same treatment this one got — a demonstration that a
blind walk is silent — before anything is claimed about it.

**Process deviation, disclosed.** The offender-planting mutation edited `routes/legal.ts`, and I restored it
with git rather than from a scratchpad snapshot. Verified clean afterwards: `git diff` on that file is
empty and its first lines are unchanged.

## V-1562 — the five candidates finished: three protected, two blind

V-1561 listed five guards as unexamined rather than implying anything about them. Finishing them is the
whole point of having listed them, and the split is 3 / 2.

**Three were already protected, by a control my detector could not see.** Retargeting each walk at a real
directory holding none of its file type made all three FAIL:
`a-published-route-that-can-never-succeed-is-listed` (2 arms red),
`the-team-owner-pair-cannot-be-split` (3 red), and
`a-customer-doc-may-not-cite-a-file-that-does-not-exist` (1 red). None carries a `toBeGreaterThan` floor;
each has sibling arms asserting POSITIVE content, which fail first when the walk goes blind — the same
shape as `route-auth-coverage-invariant`'s exact `toHaveLength(288)`. **Non-vacuity has at least four
forms, and a heuristic looking for one of them mostly finds false positives** — this sweep produced 389,
then 197, then 13, then 6, and the true answer is 2.

**Two were genuinely blind, and both scan the entire server source for an absence:**

- `boolean-env-flags-share-one-truthiness-rule` — asserts no file compares an env var to a truthy literal
  directly, bypassing the shared parser. Walk retargeted at `src/db/migrations`: **4 passed**, nothing read.
- `services-webhook-secret-force-rotation-content-parity` — asserts nothing constructs the force-rotation
  service outside its sanctioned site. Same retarget: **13 passed**, nothing read.

Both now count the files they actually read and refuse an empty answer, against a measured 340 `.ts` files
under `apps/server/src`. The first throws with the directory and count in the message, because its scan
sits in a helper shared by four arms and a thrown error names the cause once rather than four times.

Proved in three directions. Each blind walk now reds — the first naming "the walk is blind, so an empty
result means nothing", the second naming the scanned count. And a planted
`process.env.SOME_FLAG === 'true'` still reds, so the fix did not buy safety by loosening the detector.

**The offender probe was wrong first, and the guard was right.** Planting that comparison in
`lib/config.ts` did NOT red — because config.ts is where the rule is DEFINED and is exempt by design, as
its own constant says. Re-planted in `lib/errors.ts` it reds naming the flag. A mutation that fails to red
is a claim about the mutation until the mutation is checked, which is the V-1531 lesson arriving again from
a different direction.

## V-1563 — why the vacuity sweep found real bugs in walks and none in single-file scans

V-1562 fixed two whole-source walks that passed while reading nothing. The same fault has a second
possible shape — a population extracted from ONE file by regex, where a pattern that stops matching yields
an empty list and an empty list passes. That is the V-1536 `spreadCodes` bug exactly, so it was worth
sweeping.

**Four candidates survived filtering, and all four are safe.** Each was opened rather than reported:

- `webhook-backoff-schedule-agrees-everywhere` pins `expect(worker.size, '…').toBe(5)` for all four
  sources. Its own helper comment says "the caller floors the entry count", and it does.
- `v2-12-error-kind-catalog-parity` guards its fragile half with
  `expect(m, 'TYPE_TO_CTOR map must exist').not.toBeNull()`, and its other half iterates an IMPORTED
  `PROBLEM_TYPES` rather than a scan.
- `legal-refunds-doc-parity` and the two remaining doc-parity files derive offenders from a file that was
  successfully read.

**The distinction is the finding, and it explains both results.** A tree walk that yields nothing means
_we did not look_ — the directory can exist and be empty, silently. A single-file read that yields no
matches means _this file contains none_, because `readFileSync` throws when the path is wrong. The first is
a vacuity bug; the second is a true answer. That is why V-1562 found two real blind spots and this sweep
found zero, and it is worth writing down so the next person does not re-run this and mistake four safe
files for four unexamined ones.

### My detector was wrong four times, and the last two were the same mistake

It flagged `route-auth-coverage-invariant` (V-1561) while that file carried `toHaveLength(288)`. It flagged
`webhook-backoff` and `v2-12` here. The cause in both of this batch's cases: the repo writes
`expect(value, 'message').toBe(5)`, and my pattern required `.size)` immediately followed by `.toBe(`.
**A detector that does not know the codebase's dominant idiom reports the codebase as deficient** — which is
the same fault as a scan that knows one spelling of a mechanism, arriving in the tool that hunts it.

Corrected mid-batch, which took 6 candidates to 4, and the remaining four then fell to reading. **No code
changed and no finding filed**, because four verified-safe files are not a finding.

## V-1564 — the one declared branch with no behavioural test, and the ordering that decides which fix a customer is told to make

Thirteen status codes were declared across this arc. Checking which are actually exercised turned up one
that is not.

**`POST /v1/agent-sessions/{id}/message` → 502 has no behavioural test.** `ByokAnthropicRequiredError`
appears in four unit files and every one is a catalogue: the SDK export list, the RFC 7807 shape pin, the
Python `__all__` parity, and the arm V-1534 added. No test drives the route and observes the status. The
502s that DO exist in the integration suite are `/v1/sessions` driver errors — a different class, which is
why a keyword count said "covered" and reading said otherwise.

**I did not write that test, and the reason is the session's own lesson.** Reaching the branch needs
`resolvedByokKey === undefined && agentDecomposerKind === 'claude'`, a tier that IS eligible and consent
that is NOT missing — a fixture whose decomposer configuration I cannot verify from the outside. A test
that passes because it was refused three lines earlier looks identical to one that reached the branch, and
this arc has now produced eight instruments that failed exactly that way. The precise conditions are
recorded here so it can be written correctly rather than plausibly.

**What is pinned instead is the part a fixture would not have protected anyway: the ORDER.** Three
refusals sit in one branch and each names a different fix — 403 upgrade your plan, 402 flip the consent
toggle, 502 supply a key. The source says the ordering is deliberate twice over: the tier branch is
commented "Deliberately NOT the consent error: consent is on", and the consent branch exists because the
generic 502 "doesn't hint at the simpler dashboard fix".

Reordering them compiles, leaves every status declared, and keeps every existing guard green — while
telling a paying customer to buy an upgrade they already have, or to go and find an API key when a toggle
would do. Proved by swapping the consent and credential branches: it reds with "the keyless-turn refusals
are out of order".

That is the shape worth noticing. A status-code guard checks WHICH codes exist; this checks which one a
customer gets, and those are different properties of the same three lines.

## V-1565 — a query filter that turned a malformed id into a 500, in the file that fixed the same bug six lines above

V-1564 found that WHICH refusal a customer gets is a different property from which codes exist. Looking
for other places where that choice is recorded as deliberate turned up four comments in the whole server
source, and one of them names a live defect rather than a settled decision.

`routes/admin-audit-log.ts` validates `admin_id` and `target_id` through `maybeUuidFromInput`, whose
raw-UUID branch used a hex-or-dash character class of length 36. That is not a UUID shape: it admits 36 hex
digits with no dashes, and it admits a string of 36 dashes. Both were returned as a "UUID" and land in
`eq(adminAuditLog.adminAccountId, ...)` against a Postgres **uuid** column — so
`GET /v1/admin/audit-log?admin_id=------------------------------------` reached PG as an invalid uuid cast
and answered **500 where the boundary owes 400**.

**The same file already fixed this, six lines above.** `CURSOR_UUID_RE` is the strict dashed shape, added
with a comment saying a tampered cursor "would hit PG as an invalid uuid cast (500). Validate at the
boundary so a bad cursor is a clean 400." The cursor got it; the filters did not. `routes/sessions.ts`,
`routes/profile-snapshots.ts` and `routes/account-web-sessions.ts` each carry their own comment recording
the same fix in their own copy — four independent fixes of one class, and the fifth site missed.

Fixed by reusing `CURSOR_UUID_RE` rather than adding a fifth spelling.

**Guarded as a shape, not a filename.** The new arm scans every route file for the hex-or-dash class, so
the next copy fails here rather than in a stack trace. Proved twice: restoring the loose branch reds naming
`admin-audit-log.ts`, and planting the pattern in `routes/legal.ts` reds naming that file — the check works
on a route it was not written for.

### Three faults of my own, all caught before the commit

**My explanation triggered my own guard.** The first fix put the old pattern in a `/** */` block; `codeOf`
strips `//` lines but not block comments, so the guard flagged the file I had just repaired. The literal is
now described rather than quoted, and the comment says why — the alternative was loosening a guard to
accommodate a comment.

**Two content-parity pins froze the defect.** `routes-admin-audit-log-content-parity` and the V-484/V-521
cross-source invariant both pinned the loose branch verbatim, so correcting the bug turned the suite red.
Updated in the same commit with the reasoning in each pin: retraction PARAPHRASED in the headers, the new
branch QUOTED in the assertions.

**One pin froze a sentence I had moved.** A separate assertion pins the one-line
`/** Accept either a raw UUID or a prefixed id; return the UUID. */`. Rather than rewrite that pin, the
sentence was restored and my note moved above it as `//` lines — the pinned contract is the doc comment,
and it should not churn because an explanation needed somewhere to live.

## V-1566 — the class V-1565 belonged to has exactly two members, and both were the bug

V-1565 fixed a validator that admitted 36 dashes as a UUID and handed them to a Postgres uuid column. The
class is broader than uuids: **customer input reaching a typed column without a boundary check** is a 500
where a 400 is owed, whatever the type.

**Numeric and date input: clean, and the scanner was proved before the zero was believed.** No route
converts a query, param or body field with `Number`/`parseInt`/`new Date` without a validity check nearby.
A planted `Number(req.query.limit)` in `routes/legal.ts` is reported immediately, so the zero is a result
rather than an empty run — the eighth time this session that distinction mattered.

**Enum input: clean, and it is where my scanner's own blind spot showed.** `admin-audit-log` passes
`query.action` straight into `eq(adminAuditLog.action, ...)` against a closed 15-value Postgres enum, which
looks exactly like the uuid bug. It is not: `ListAuditLogQuerySchema` types it `AdminAuditActionSchema`, and
types `from`/`to` as `Iso8601Schema`. Worth noting that my numeric scan did NOT see `new Date(query.from)`
two lines away, because it matched `req.query.X` and the code uses the parsed variable — one spelling of a
mechanism, again, in the tool hunting for exactly that.

**The generalisation, and it closes the class.** A field typed as a bare `z.string()` is a DELEGATION
POINT: the schema declines to check its shape, so something downstream must. Across every request, query,
body and params schema in api-types there are **exactly two** — `admin_id` and `target_id` on the audit-log
query — and they are bare deliberately, because each accepts either a raw UUID or a prefixed id, which one
zod type cannot express.

Those two are precisely where V-1565 found the defect. Every other request field carries a length, a
regex, an enum or a format, so Postgres rejects nothing the schema let through. **The one place validation
was delegated away from the schema is the one place it was wrong**, and there is no third.

Pinned as an exact set rather than a floor, so both directions fail: a third bare field reds naming it (a
new delegation whose delegate nobody has written), and an existing one gaining its own constraint reds too,
because then the recorded list has stopped being true. Proved both ways.

## V-1567 — re-running the scan whose blind spot I had already published

V-1566 concluded "numeric and date input: clean" and, in the same entry, recorded that the scanner behind
it matched `req.query.X` and missed the parsed `query.X` form. **A conclusion published alongside its own
disqualifying limitation is not a conclusion**, so this batch re-ran it properly.

The corrected scan covers both spellings plus `parsed.data.X`. Across 60 route files it reports **six**
conversions of request-derived values, where the first scan reported zero:

```
admin-audit-log.ts:91,92     new Date(query.from) / (query.to)
admin-incidents.ts:231,277   new Date(parsed.data.started_at)
admin-incidents.ts:309       new Date(parsed.data.since)
admin.ts:116                 new Date(body.expires_at)
```

**All six are safe, and each was traced to its schema rather than assumed.** `from`/`to` and `since` are
`Iso8601Schema`; `started_at` is `Iso8601Schema` in both the create and update shapes; `expires_at` is
`Iso8601Schema.optional()` on `CreateApiKeyRequestSchema`. My "guarded" window simply did not reach the
`safeParse` a few lines above, which is why they surfaced at all.

**One definition was carrying the whole conclusion, so it got checked too.** Every one of those fields
resolves to `Iso8601Schema`, used **75 times** across ten api-types modules. If that were a renamed
`z.string()`, every date field on the surface would be unconstrained and this entry would be wrong. It is
`z.string().datetime({ offset: true })` with a 1970 floor — and it is already pinned, by
`api-types-common-content-parity`, which asserts the offset flag, the floor and the describe text.

**No code changed and no guard added.** Prior art was checked before writing anything, which is the V-1548
correction applied as routine rather than as a lesson. The result V-1566 claimed is now supported by a scan
that can see the code it was claiming about — which is the entire content of this batch, and worth a
number: the blind version found 0 of 6.

## V-1568 — the delegation-point inventory was api-types only while claiming the whole surface

V-1566 pinned the fields whose shape a request schema declines to check, and said "there are exactly two on
the whole surface". Its scan read `packages/api-types` alone. V-1530 had already established that route
files declare schemas inline — the two `auth-oauth-client` bodies and the `oauth.ts` revoke body are named
there — so the claim was broader than the evidence, the same fault V-1567 corrected one batch earlier in a
different scan.

**Six, not two.** The four the api-types walk could not see:

```
BulkRevokeQuerySchema.keep                  account-web-sessions.ts
ListOAuthLinksQuerySchema.active_only       account-oauth-links.ts
NavigateHistoryBodySchema.tabId             agent-sessions.ts
probeSignatureBodySchema.last_fill_text     internal-atlas-priority.ts
```

**All four are safe, each checked rather than counted.** `keep` is lowercased and compared as a
confirmation token — its own comment explains that `z.string()` rather than `z.literal('current')` is
deliberate, so the refusal message naming the exact parameter keeps being what a caller sees, and that it
"narrows the TYPE only" after a repeated query key once produced a 500. `active_only` is compared to a
string with the same array-arity reasoning recorded above it. `tabId` ships gated-inert per V-1479, and
`last_fill_text` is free text on an internal route. None reaches a typed column, which is what separates
them from the audit-log pair V-1565 fixed.

The arm now walks both api-types and the route files and pins the exact set of six, so a new inline
delegation fails as loudly as a new named one. Proved both ways against a ROUTE-LOCAL schema specifically —
adding a bare field to `BulkRevokeQuerySchema` reds naming it, and giving `keep` a `.max(32)` reds too,
because the recorded set has stopped being true.

### The failure rule 5 exists for, hit exactly as described

The first attempt wrote `arm's own scope` into a title that is SINGLE-quoted. Vitest reported
**"Tests no tests"** — not a failure — and the `it(` count still read 13, matching HEAD, so the count check
passed while the file did not parse. The esbuild line was the only signal: `Expected ")" but found "s"`.

Two things worth keeping from that. The `it(` count is necessary and not sufficient: it cannot distinguish
a file that lost an arm from a file that lost the ability to be read. And an earlier attempt in the same
batch asserted against text prettier had reformatted, failed its own assertion, and wrote nothing — which
is the safe way to fail, and the reason there was no half-edited file to untangle.

## V-1569 — what actually catches a test file that stops parsing, and what only the `it(` count catches

V-1568 ended on a worry worth resolving rather than leaving: my edit broke a test file, vitest said
**"Tests no tests"** instead of failing, and the `it(` count still matched HEAD. If that is how a silent
parse failure presents, a guard could vanish from the suite while the run stayed green.

**It cannot.** Measured by breaking a file for real — an unterminated string in
`a-shared-ajv-enforces-the-formats-it-documents` — and running the whole suite:

```
vitest exit=1
Test Files  2 failed | 3071 passed | 115 skipped (3188)
```

**Two independent defences fire.** Vitest reports the transform failure as a failed FILE rather than
skipping it, so the run exits non-zero on its own. And `the-server-source-type-checks` fails separately,
by design — its arm says vitest "transpiles them without checking, so a test file can reference a renamed
export ... and stay green while `npm run typecheck` — a CI gate — fails", recording that this had main red
for four days.

The "Tests no tests" reading came from running that ONE file in isolation. In isolation vitest has nothing
to compare against; in the suite it has 3188 files and a type-checker.

### What each check is actually for

Worth separating, because they are not redundant:

- **A file that stops parsing** — caught twice, loudly, without the `it(` count.
- **A file that parses but LOSES AN ARM** — a stray `);` closing the describe early, an arm commented out —
  caught by NOTHING above. The file still transforms, still type-checks, and the suite still passes with
  fewer assertions. Only comparing `it(` against HEAD sees it, which is why the standing rule exists and
  why V-1568's count check was right to run even though it did not catch that batch's fault.

So the count is not a weaker version of the other two; it covers the case they cannot see. V-1568 said it
is "necessary and not sufficient" — the accurate statement is that the three cover different failures, and
the count is the only one that covers silent arm loss.

**No code changed.** The file was restored byte-identical and the suite verified green afterwards.

## V-1570 — measuring the gap V-1569 named, and deciding not to build a ratchet for it

V-1569 said a file that parses but loses an arm is "caught by NOTHING" and left that as an open gap. Before
adding a second ratchet to `verify-suite.mjs` to close it, the gap got measured. **It is narrower than the
sentence implied, and the mechanism V-1569 named does not produce it at all.**

**Case 1 — a stray `);` closing the describe early.** This is the case the standing rule is written for.
Closing the describe before the second arm of a real guard produces:

```
Transform failed with 1 error
Tests  no tests
```

The file does not PARSE — the original closing `});` is now unbalanced — so it is not a silent arm loss at
all. V-1569 established that in a full run this exits 1 and additionally reds
`the-server-source-type-checks`. Caught twice.

**Case 2 — an arm commented out.** The file parses, `Tests 1 passed` where it was 2, and `it(` drops 2→1.
This is the genuinely silent one: the file count is unchanged, nothing fails, and the suite is one
assertion lighter.

**And a ratchet is still the wrong fix.** `judge()` reads only the "Test Files" line, so a test-count pin
would be new machinery. It would need bumping on every arm added anywhere in a 30,949-test suite — churn
on every contribution — to catch a case that is already caught twice over: by the `it(`-versus-HEAD
comparison the standing rules require, and by the fact that commenting out an arm is a visible, deliberate
diff. A pin nobody can add a test without bumping becomes a pin bumped without reading, which is the exact
failure this arc has documented in a filename roster, a duplicated list and a magic window.

So the correction to V-1569 is precise rather than cosmetic: the count check does not cover a case the
other two miss because the stray-paren path breaks parsing. It covers **deliberate arm removal**, where its
value is telling the author their edit dropped an assertion — a review aid, not a safety net against a
silent regression.

**No code changed.** Both mutations restored byte-identical, and the file verified back at 2 passing arms.

## V-1571 — running the gate I had been claiming to run

Every batch in this session reported "full gate green" from `npx vitest run`. **That is not the gate.**
`scripts/verify-suite.mjs` is, and it applies judgement the bare command does not: a collected-file floor,
an unhandled-error check, and a refusal to trust a run whose workspace packages failed to build. It had
never been executed here, so the claim rested on a weaker instrument than the one the repo provides.

**Both modes pass, and the numbers reconcile.**

```
node scripts/verify-suite.mjs         exit 0   3017 files / 30155 tests   "full file count"
node scripts/verify-suite.mjs --all   exit 0   3188 files / 30949 tests   "full file count"
```

The `--all` figures are identical to what `npx vitest run` reported all session, so the claims were
accurate — made with a blunter tool, but not wrong. The node-project pin is exact: **3017 collected against
a 3017 pin**, so the three files added this session were bumped correctly.

**The `_ALL` pin has drifted nine files below reality**, 3179 against 3188 collected. Floor semantics mean
the gate still says "full file count" while nine files could stop being collected unnoticed. That drift is
not mine: three files were added here and the pin was raised by exactly three. Recording the number rather
than absorbing it, per the standing rule that a pin is raised only for files its author added — quietly
closing someone else's nine-file gap would hide whatever caused it.

**And the gate is one CI job of five.** It says so itself, which is the good kind of guard:

```
e2e            222 Playwright tests — the only ones hitting real Postgres + Redis
python-sdk     365 pytest tests + ruff/mypy
go-sdk         go vet, go test, examples build
bench          perf regression (advisory)
```

So "gate green" in every entry of this log means **build-test green**, with 115 further files collected but
never executed because they gate on `DATABASE_URL`. None of the SDK or end-to-end work this session touched
was covered by the runs backing those statements — the Python and Go SDK checks in particular, which
several batches reasoned about.

That bound belongs in the record next to the claims it qualifies, and it is stated here rather than left
for a reader to discover that "full gate" meant one job of five.

## V-1572 — running the two CI jobs the gate names but does not run

V-1571 bounded "gate green" to one CI job of five and noted that the Python and Go SDK checks — which
several batches this session reasoned about — were never among the runs backing those claims. Leaving that
recorded is the failure this arc keeps finding, so both were run.

**Both pass, and the SDK reasoning holds.**

```
go vet ./...                      exit 0
go test ./...                     exit 0
pytest -q                         365 passed, 9 skipped
ruff check .                      All checks passed
mypy src                          Success: no issues found in 31 source files
```

That matters beyond a green tick: V-1532 read `datamodel-codegen` to establish the Python SDK generates
models rather than method signatures, V-1538 traced `is_retryable` through `PROBLEM_TYPE_TO_ERROR`, and
V-1550 hit `ajv-formats`. Each of those conclusions was drawn from source that no executed check covered.
They are now covered.

**Two figures in the gate's own notes had drifted**, and both are corrected in the same commit:

- **Python skips: 4 → 9.** The recorded REASON was exactly right — "want a live base URL and key" — and
  every one of the nine is `tests/test_live_contract.py` skipping on absent `DS_LIVE_BASE_URL` and
  `DS_LIVE_API_KEY`. The file grew; the number did not follow. A correct reason attached to a stale count
  reads as verified, which is what made this worth measuring rather than assuming.
- **Go tests: 236 → 209, or 242.** 209 top-level test functions, 242 counting subtests. **236 matches
  neither**, and nothing in the old note says which it was counting, so both are now stated with the method
  rather than picking one and calling it re-measured.

That block already carried two prior corrections in its own text — the Python figure "read 362 until the
re-run", the Playwright count "read 199 for a day". This is the third and fourth, which says the figures
drift faster than they are re-measured. Recording the METHOD beside them is the part that might change
that.

`EXPECTED_TEST_FILES` and `_ALL` are untouched: this batch corrected prose, not pins, and the nine-file
`_ALL` drift V-1571 recorded is still someone else's to close. The gate re-run after the edit is green.

## V-1573 — running the 115 suites the gate collects and never executes

V-1571 bounded "gate green" to one CI job of five; V-1572 covered the Python and Go SDK jobs. What remained
was the largest hole: **115 test files the gate collects and never runs**, because they gate on
`DATABASE_URL`. Every route change this session — thirteen status codes, a UUID validator, two webhook
refusals — had been verified statically and never against a database.

**All of it passes.** Against a local Postgres 16.14 and Redis:

```
apps/server/tests/integration    393 files passed / 3796 tests passed    exit 0
```

**The first run failed 94 files, and the cause was mine, not the code's.** Every failure was
`relation "public.accounts" does not exist` and siblings. The `ensureIsolatedDatabase` helper creates and
migrates a database PER TEST FILE, but files that use the base `DATABASE_URL` directly need that database
migrated, and I had pointed at a freshly created empty one. `npm run db:migrate` applied 114 migrations, 52
tables, and the same command that reported 94 failures reported none. **A red run is a claim about the
environment until the environment is checked** — reporting those 94 as findings would have been the
session's worst false positive.

**One concrete gap surfaced, on my own work.** `apps/server/tests/integration` holds 15 webhook files, 23
session, 14 agent-session, 6 profile and 5 api-key files — and **zero for admin-audit-log**. The
500-instead-of-400 defect V-1565 fixed there is covered only by the unit-level shape guard added alongside
it. Nothing drives `GET /v1/admin/audit-log?admin_id=<garbage>` and observes a 400. That is a real coverage
gap, named rather than filed as a finding, because writing that test needs an admin fixture and this batch
has already established what happens when a test is written without verifying it reaches the branch.

**Cleanup, stated because it touched a shared machine.** One database was created (`ds_verify_…`) and
dropped. The `driftstack_iso_*` databases were left alone: the helper creates them only when absent and
reuses them, so they are its lifecycle and possibly a peer's, not mine to remove. Redis index 14 was
flushed after the run — it held 38 `zz-test-rl:` rate-limit keys the suite left behind, which is the index
the e2e runner documents as unused.

**Still unrun: the Playwright e2e job** — 222 specs, the other half of the "real Postgres + Redis" claim.
`scripts/e2e-local.mjs` exists to run it without Docker, and its own header records why that matters:
three `rate-limit.spec.ts` specs "were able to rot unnoticed until someone ran them."

## V-1574 — the last uncovered CI job, and the whole surface verified once

V-1571 established that "gate green" in every entry of this log meant one CI job of five. V-1572 ran the
Python and Go SDK jobs; V-1573 ran the 115 database-gated suites. **The Playwright e2e job was the last,
and it passes:**

```
node scripts/e2e-local.mjs      222 passed (45.6s)      exit 0
```

That completes the surface. Every CI job this repository defines has now been run against this working
tree, which no single command here does:

```
build-test      verify-suite            3017 files / 30155 tests   exit 0
build-test      verify-suite --all      3188 files / 30949 tests   exit 0
integration     DATABASE_URL enabled     393 files /  3796 tests   exit 0
python-sdk      pytest + ruff + mypy     365 passed, 31 files clean
go-sdk          go vet + go test         clean
e2e             Playwright                222 passed
bench           advisory, not run — it does not gate a merge
```

**The Playwright figure was exact.** The gate's note says "222 Playwright tests over 36 spec files" and the
run reports 222. That is worth stating beside V-1572's corrections: of three recorded counts checked, one
was right, one had drifted (Python skips 4 → 9) and one matched nothing measurable (Go 236 → 209 or 242).
The difference is not diligence — it is that the Playwright number gets re-measured whenever specs are
added, and its own comment records doing exactly that twice. **A figure with a re-measurement habit
attached stays true; one without it does not**, which is the argument for writing the method beside the
number rather than the number alone.

**What this means for the log.** Every batch here reasoned from source and mutation-proved its guards, and
those methods stand on their own. What was missing was the confirmation that the thirteen declared status
codes, the UUID validator, the two webhook refusals and the dependency declarations survive contact with a
real database, a real Redis and a real browser. They do.

**Cleanup.** Two databases created across V-1573 and this batch, both dropped; Redis indices 14 and 13
flushed of the keys those runs left. The `driftstack_iso_*` databases were deliberately left — the helper
creates them only when absent and reuses them, so they belong to its lifecycle rather than to me.

## V-1575 — covering the V-1565 defect, and correcting the claim that it was uncovered

V-1573 reported "zero integration files for admin-audit-log" and left the coverage gap unwritten because a
test could not be verified to reach its branch. Both halves needed revisiting.

**The "zero" was a filename count reported as a coverage claim.** Three integration files drive
`/v1/admin/audit-log` — `admin-reads`, `admin-scope-refusal-coverage` and `openapi` — and one of them
already sends a malformed `admin_id`. Counting files named `admin-audit-log*` and calling the result
coverage is the filename-keyed-roster fault from V-1547, committed one batch after writing about it. The
standing rule to enumerate with BOTH patterns exists for exactly this; I used one.

**The gap is real but narrower, and the existing test misses it by construction.**
`admin-reads.test.ts:257` sends `admin_id=not-an-id` — nine characters, which fails the old length check
AND the strict shape that replaced it. It answered 400 before V-1565 and after, so it never touched the
defect. The defect needed a THIRTY-SIX character hex-or-dash string, which is precisely what the old branch
accepted.

Two cases added beside it: thirty-six dashes, and thirty-six hex digits with no dashes.

**Proved by reverting the fix, which is the check V-1573 said it could not run.** With the old validator
restored, exactly the two new cases fail and the other seventeen pass. With the fix, nineteen pass.

**And the failure is 200, not 500 — which changes what the test may claim.** This fixture uses the
in-memory admin-audit repo, so a garbage filter matches nothing and returns an empty page; there is no
Postgres uuid cast to fail. The 500 V-1565 fixed is a production symptom this fixture cannot reproduce. The
assertion message said "a client error, not a server one", which described a mechanism the test never
exercises, and now says the boundary must REFUSE the value rather than silently match nothing. **A test
that fails for a different reason than its message states is a test that will be misread the day it
fails.**

Full runs after the change: 393 integration files / 3798 tests, and the gate green at 3017 files. Database
created and dropped, Redis index 12 flushed.

## V-1576 — the seam where V-1565's bug lived is covered by one file

V-1575 found that the fixture behind `/v1/admin/audit-log` uses an in-memory repo, so the 500 V-1565 fixed
could not be reproduced there. That is not a property of one test — it is the shape of the whole
integration suite, and it bounds two claims made in this log.

**Measured across 376 integration files:**

```
199   buildTestApp only          routes exercised against in-memory repos
172   real Postgres only         134 db-*, 38 *-repo-contract — repository layer
  5   both
```

`build-test-app.ts` wires **47 in-memory repositories** and contains no `postgres(` call and no
`DATABASE_URL`. So route behaviour is tested without a database, and database behaviour is tested without
routes.

**The seam between them is one file.** Exactly one integration file uses a real database AND injects an
HTTP request: `atlas-priority-events-end-to-end.test.ts`, on an internal route. Nothing drives a
customer-facing route against real Postgres.

**That is why V-1565 survived.** Its defect was precisely a route handing an unvalidated value to a
`uuid` column. The route half of that sentence is tested in-memory, where a garbage filter matches nothing
and returns 200; the column half is tested by repo contracts that are handed already-valid values. The
failure lives in the join, and the join has one test on a route no customer calls.

**Two of my own claims need narrowing, and this is where.** V-1573 said the route changes had been verified
"against a real database", and V-1574 said they "survive contact with a real database, a real Redis and a
real browser". The database sentence is too strong. What those runs established is that 393 integration
files pass, that the repository layer is exercised against Postgres, and that Playwright drives the app
end to end — which is real coverage, and is not the same as the routes I changed having met a uuid column.

**Not proposed as a fix here.** Giving `buildTestApp` a Postgres mode is an architectural change to a
helper 199 files depend on, and it is the kind of change whose value is a judgement about test strategy
rather than a defect to close. What is defensible is naming the seam, the single file that covers it, and
the specific bug class it lets through — so the next person deciding whether that helper needs a database
is deciding with the number in front of them.

## V-1577 — what actually crosses the thin seam, and why it is mostly safe

V-1576 measured the route/database seam at one covering file and declined to widen it, because that is an
architectural judgement. What can be settled without that judgement is the exposure: **what does a route
hand to a typed column, and is it converted first?**

**The answer turns on the column type, and the schema is deliberate about it.** 38 tables carry a
`uuid('id')` column; two carry `text('id').primaryKey()`. `agent_sessions` is one of the two, and the
consequence is visible in one line: `sessions.get(req.params.id)` passes the raw `agt_…` param straight
into `eq(agentSessions.id, id)` with no conversion — and that is SAFE, because Postgres compares text,
matches nothing, and the route answers 404. The same table's `accountId` is `uuid('account_id')`, which is
exactly the column family the audit-log filters reach and where V-1565's 500 lived.

So the rule is not "validate every param" — it is **prefixed public identifiers are stored as text and
pass raw; internal keys are uuid and must be converted.** The routes follow it through four helpers:

```
uuidFromPrefixedId       64 call sites
uuidFromProfileId        11
uuidFromPublicSessionId   2
uuidFromMemberId          2
```

**Stated precisely, because a crude scan said otherwise twice.** A first pass reported 122 "unvalidated"
param uses; the first line of its own output was `uuidFromPublicSessionId(request.params.id)`, a helper the
detector did not know. A second reported zero tables with a uuid primary key, because the pattern demanded
`.primaryKey()` immediately after `uuid('id')`. Both numbers were artefacts of the tool, and neither is
carried into this entry.

**What is verified: the agent-session path, end to end, and the helper inventory.** What is NOT verified is
every one of the 103 uuid columns against every route that can reach it — that needs the cross-file trace
V-1541 built for status codes, and this batch did not run it. The claim here is bounded to what was
opened: the seam is thin, the column types make most of it harmless by construction, and the one family
that is not harmless — uuid columns fed from customer input — is the family V-1565 fixed and V-1566/V-1568
enumerated at exactly two delegation points.

## V-1578 — a second route in V-1565's class, recorded as by-design without the argument that makes it safe

V-1577 named what it had not done: run the cross-file trace against every uuid column. Running it found a
second live instance of the defect V-1565 fixed.

**The chain, resolved through the type checker and confirmed against a real database:**

```
GET /v1/admin/usage/accounts/:id
  params.id            z.string().min(1).max(100)   — length bounds, no shape
  getAccount(ctx, id)  no conversion
  repo.findById(id)    eq(accounts.id, id)
  accounts.id          uuid('id')
```

Postgres was asked directly, rather than reasoned about: `acc_does_not_exist`, `not-a-uuid` and
thirty-six dashes each return **22P02 invalid input syntax for type uuid**. So this route answers **500**
in production for a malformed id — and for its own documented `acc_<uuid>` format, which never reaches the
column unstripped anywhere on this path.

**Its own test asserts 404 for exactly that input.** `admin-usage.test.ts` sends
`/v1/admin/usage/accounts/acc_does_not_exist` and expects 404, and passes — through `buildTestApp`'s
in-memory repo, where a garbage id is simply a miss. This is the V-1576 seam producing a concrete false
negative: the test is green, the production behaviour is a 500.

**Its sibling gets it right.** `admin-accounts.ts` converts with
`uuidFromPrefixedId(request.params.id, 'acc')` and answers 400. Two admin routes on the same resource
disagree about a malformed id: 400 in one, 500 in the other, 404 in the second one's test.

### The roster entry is the interesting part

`a-published-bound-matches-the-route` records this under `UNCONSTRAINED_BY_DESIGN`, and reading the
neighbours shows what is wrong with it:

```
GET /v1/agent-sessions/{id}          'sessions.get(id) is a plain equality query —
                                      a malformed id is a miss, answered 404'      <- an ARGUMENT
GET /v1/admin/usage/accounts/{id}    'passed straight to getAccount'               <- a DESCRIPTION
GET /v1/admin/cost/accounts/{id}     'bareAccountId only strips an acc_ prefix
                                      when present; it validates nothing'          <- a DESCRIPTION
```

The agent-session entries are safe and say why, and V-1577 verified the reason: those ids are a
`text('id')` column, so a malformed value really is a miss. **The two accounts entries state what the code
does and never claim it is harmless** — and their column is `uuid`, where a malformed value is a cast
error. One roster, one heading, two situations that differ by column type.

**Not fixed here, and the reason is the roster, not the difficulty.** The change itself is one helper call.
But this is a recorded by-design entry across four pin files, and overturning it means deciding whether a
malformed admin id is 400 (matching the sibling) or 404 (matching this route's test) — a contract choice on
a live admin surface, made properly rather than at the end of a batch. `GET /v1/admin/cost/accounts/{id}`
needs the same decision and the same fix.

What is settled and recorded: the chain, the empirical 22P02, the disagreeing sibling, the false-negative
test, and the distinction the roster is missing.

## V-1579 — scoping the fix V-1578 deferred: it is at the call site, not the normalizer

V-1578 recorded two admin routes returning 500 for a malformed account id and deferred the fix on a
contract question. Re-read, that question is narrower than it looked, and the obvious implementation is
wrong. Both are worth settling before anyone edits code.

**The contract question is nearly closed.** Both readings agree the 500 must go, and
`admin-accounts.ts` already answers **400** for exactly this shape on the same resource via
`uuidFromPrefixedId`. Matching it is consistency, not a new contract. What changes is one assertion:
`admin-usage.test.ts` currently expects 404 for `acc_does_not_exist` — a number produced by an in-memory
repo where a garbage id is a miss, not by a decision.

**The obvious fix is the wrong one, and two tests say so.** `admin-cost` exports `bareAccountId`, and it is
tempting to make it reject what it cannot normalise. It must not: `admin-cost-bare-account-id.test.ts`
pins it as a pure stripper and asserts pass-through for values that are NOT uuids —

```
bareAccountId('acc_acc_<uuid>')  ->  'acc_<uuid>'      still not a uuid
bareAccountId('ses_<uuid>')      ->  'ses_<uuid>'      still not a uuid
```

Those arms are correct: stripping and validating are different jobs, and the tests pin the one this
function does. **The missing check belongs at the call site**, after normalisation — `admin-cost.ts:66`
passes `bareAccountId(params.id)` straight into the service, and that result is what must be a uuid.

**So the change is two call sites, not a shared helper and not the normalizer:**

```
admin-cost.ts:66     accountId: bareAccountId(params.id)     -> validate the RESULT is a uuid
admin-usage.ts:41    getAccount(req.account!, params.id)     -> accept acc_<uuid> or a bare uuid
```

**And the pins are lighter than V-1578 feared.** Of the four files touching admin-usage, two pin a COMMENT
about scope enforcement rather than any validation, and the third pins `account_id` on LIST queries, not
this route's `Params.id`. What genuinely moves is the 404 assertion and the two
`UNCONSTRAINED_BY_DESIGN` roster entries, which stop being true once the ids are constrained.

**Not applied here, deliberately.** The analysis is the part that needed care and it is done; what remains
is mechanical and touches a live admin surface, and this session has repeatedly documented what a rushed
edit at the end of a batch costs. Recorded so the next pass is an edit rather than an investigation.

## V-1580 — two admin id params that answered 500 where they meant 400, and the pins that hid the second

V-1579 scoped this as "two call sites, mechanical". It was three, and the third was found by the rule
about enumerating with both grep patterns rather than by reading the route.

**The defect.** `GET /v1/admin/usage/accounts/:id` and `GET /v1/admin/cost/accounts/:id` handed their
`:id` param to services that filter a `uuid` column. Postgres rejects a non-uuid literal outright, so a
malformed id was never a lookup that missed — it was a cast error, surfaced to the operator as a 500 for
what is plainly a bad request. Proven against a real column rather than argued:

```
SELECT * FROM t WHERE account_id = 'not-a-uuid';
ERROR:  invalid input syntax for type uuid: "not-a-uuid"
```

**The assertion that concealed it.** `admin-usage.test.ts` sent `acc_does_not_exist` and expected 404.
That number came from `buildTestApp`'s in-memory repo, where a garbage id is simply a key that is not
present. The same literal run against the real column is the error above. So the test was not pinning the
contract; it was pinning a property of the fixture, and it read as coverage of exactly the case that was
broken. Both halves are now asserted separately — 400 for a malformed id, 404 for a well-formed id that
names no account — so the 404 path keeps its own arm instead of standing in for two behaviours.

**The third call site.** `/v1/admin/cost/overview` maps a CSV of `account_ids` through the same
strip-only helper into the same column. Nothing in the route file's name or path led there; the file that
named it was a content-parity pin quoting the handler tail, reached only by grepping the helper's
basename. Its negative uses a mixed list — one good id, one malformed — so it proves every element is
checked rather than just the first.

**`bareAccountId` is deliberately unchanged.** It strips an `acc_` prefix and its own tests pin that it
returns `ses_<uuid>` untouched. Stripping and validating are different jobs; the validation was added at
the call sites, so the normalizer's pinned contract survives and the new guard is not entangled with it.

**Five pins, four of them found only by the wider patterns.** Two froze the admin-cost handler text, two
froze the admin-usage call, one roster carried reasons that were true when written and are not now. The
roster entries still passed after the fix — they assert the spec publishes no pattern, which is still
true — so their stale _reasons_ would have survived a green suite indefinitely. Corrected on the same
pass, since a correct assertion with an obsolete reason is how the next reader is misled.

**Two instruments earned their place.** A mutation run against `admin-cost.test.ts` reported nothing at
all: no such file exists, and vitest answers a missing filter with "No test files found" and exit 1 — an
exit-code check would have scored that as a mutation proof. Counting the "No test files found" line
instead is what caught it, and it caught a second one immediately after, where zsh's lack of word
splitting passed three test paths as a single filter. Both are the session's recurring shape: an empty
result that is indistinguishable from a check which never ran.

Each of the three call sites was reverted independently and reds its own arm; restored, the file is
byte-identical. Full suite 3073 files / 30953 tests; integration 393 files / 3798 tests against a
disposable migrated Postgres, dropped afterwards.

## V-1581 — the seam that let V-1580 exist, and a sweep that stands in it

V-1580 fixed three call sites. The question this entry answers is why nothing caught them, because that
is the part that generalises.

**Both halves of the suite were green over the defect.** Route tests wire `buildTestApp` and its 47
in-memory repos, where an id is a JS Map key and a malformed one is simply absent — so 404 is the natural
assertion and it passes. Database tests exercise repos directly and never enter a route, so no path
parameter is involved. Measured rather than assumed: **not one database-gated integration file injects
HTTP.** The bug lived exactly between the two, which is why a route that returned 500 in production
carried a test asserting 404 for the same input.

**A static scan was the wrong instrument and said so three times.** Looking for route params that reach a
uuid column without validation, the scan was wrong on its first three runs — it missed converters written
as `uuidFromPrefixedId(request.params.id, …)` because the regex demanded `(` immediately before `params`;
it counted `parsedParams.success` as a param for want of a left word boundary; and it read
`const params = Schema.safeParse(request.params)` as unvalidated when that is the correct pattern. Each
correction _reduced_ the finding count. That is the session's recurring fault in its purest form — one
spelling of a mechanism mistaken for the mechanism — and the tell was that the tool kept discovering the
codebase was fine.

The static answer, once the controls passed, was that the remaining unconverted params reach `text`
columns (`crypto_orders.order_id`, `oauth_clients.client_id`, `recipes.id`, `agent_sessions.id`), which
matches the repository's own rule: prefixed public ids are `text` and a raw pass is safe; internal keys
are `uuid` and must be converted. So V-1580's three sites were the whole set.

**The behavioural instrument settles it and keeps settling it.** The new e2e spec enumerates its targets
from `openapi.json` — generated from the routes rather than maintained beside them — takes every
single-parameter GET, and asks for each one with `not-a-uuid`. 32 routes; a malformed id may answer 400,
404, 401/403 or 422, and may not answer 5xx. It would have caught V-1580 on the day it landed, and it
covers the routes nobody has thought about yet.

**Nine of the 32 are gated and the spec says so.** They answer 503 `feature-unavailable` — AI chat,
recipes and customer egress are off unless an operator activates them — which is a deliberate typed
refusal before any parameter is read. The exemption is keyed on the declared problem type, not on the
status, so a route that genuinely breaks cannot inherit it by returning a bare 503. Those nine are
therefore NOT swept, the count is printed on every run, and an assertion fails if the gated share ever
grows past half the roster. A guard covering two thirds of its roster silently is worse than one that
names the third it misses.

Proven the only way that counts: with V-1580's usage fix reverted, the sweep reds with
`500 /v1/admin/usage/accounts/{id}` and the internal-error body; with the cost fix reverted instead, the
same for `/v1/admin/cost/accounts/{id}`. Both restored byte-identical to HEAD.

**The count edit found a fourth copy.** Adding a spec moved Playwright 222/36 → 223/37, and the
blind-spot suite immediately failed twice: the figure lives in two files by design, and my first pass
corrected the prose while leaving the string an operator actually reads. That is the V-1094 fault the
guard was written for, reproduced by the person editing it. Both files now agree, and the lead figure is
the current one with the history kept underneath rather than the reverse.

Full suite 3073 files / 30953 tests; e2e 223 passed against a disposable migrated Postgres, dropped
afterwards; `verify-suite` OK.

## V-1582 — an admin endpoint that persisted a self-repeating schedule for an archetype that does not exist

Found by extending V-1581's sweep to the methods it deliberately left out. The GET surface is 32 of 106
id-taking operations; the other 74 are POST, PUT, PATCH and DELETE. None of them returned a genuine 5xx —
the fifteen 5xx responses were all the same typed `feature-unavailable` gate — but two operations answered
**success** for an id that cannot exist, and one of those is a real defect.

**`POST /v1/admin/validation-schedules/not-a-uuid/trigger` returned 200 with a run_id.** Following it into
`ValidationHarnessService.triggerNow` shows no existence check at all, while `remove()` immediately above
it looks the archetype up and throws `NotFoundError` when it is absent. Two operations on the same
resource in the same class, one validating and one not, is an oversight rather than a decision.

**The worse half is the write path, and it is proven, not argued.** `PUT /v1/admin/validation-schedules`
takes `archetype_id: z.string().min(1)` and persists whatever it receives. Against a real database:

```
PUT  {archetype_id: 'totally-not-an-archetype', cadence_seconds: 60}   -> 200
DB   [{archetype_id: 'totally-not-an-archetype', enabled: true, next_run_at: +60s}]
AUDIT[{action: 'validation_schedule.upserted', target_resource_id: 'totally-not-an-archetype'}]
```

`findDue` selects exactly `enabled = true AND next_run_at <= now`. So a typo was not a failed request —
it became a row the tick loop re-dispatched every cadence, forever, for something that does not exist,
with the ledger recording each fire as a validation run.

**What limits the severity today, stated because it would be easy to overstate.** The dispatch target is
currently a stub: `bootstrap.ts` wires `triggerRecapture: () => Promise.resolve({ id: run_<uuid> })`, and
the service header says the real RecaptureService lands "behind the same triggerRecapture interface" when
Agent 1's vendor probes do. So no expensive work runs right now. The persisted row, the endless
re-dispatch and the audit entries are real today; the cost becomes real the day the interface is
implemented, which is precisely when nobody will be looking at this code.

**The fix validates against the whole registry, and that choice matters.** `ARCHETYPE_REGISTRY` is the
single source the GUI catalogue and `GET /v1/archetypes` already derive from, and the server imports it
already. The narrower `SELECTABLE_ARCHETYPE_IDS` — `launch` + `available` — is the CUSTOMER-facing set;
gating on it would refuse `reference` archetypes, which is the exact thing a validation harness exists to
exercise before they become selectable. So the guard asks only whether the platform has heard of the
archetype.

**`remove` is deliberately left unguarded**, and there is an arm pinning that. Validating the way out as
well as the way in is how a row written before this guard — or one whose archetype is later retired —
becomes permanently undeletable. 404 "no such schedule" is the honest answer there.

**The fixtures were the other half of the work.** Eight invented ids (`arch1`, `arch_audit_ok`, …) stopped
being acceptable once the archetype must be real. They are derived positionally from the registry rather
than written out, because naming eight live slugs would pin the file to today's catalogue and break it
the day one is retired — a fixture rotting against live data instead of testing anything. The only
requirement left is "the registry holds at least eight entries", asserted so a shrunken registry fails
loudly rather than silently reusing one id across tests needing distinct schedules. The URL-embedded ids
were missed by the first pass: grepping for the quoted literal does not find `/validation-schedules/arch1`,
which is the same enumeration fault this log keeps recording.

Both guard call sites were removed independently; each reds its own two arms (service and route), and the
`it(` counts moved by exactly the four and three added. The tests-typecheck guard caught a widened
`string[]` that vitest had transpiled happily — the fault it was written for.

Full suite 3073 files / 30960 tests; integration 393 files / 3801 tests against a disposable migrated
Postgres; `verify-suite` OK. One integration failure appeared on a single run whose Redis index carried
residual state from this batch's own probe runs; it did not reproduce across three subsequent runs
including one on a pristine database and a clean index, and the failing test's identity was not captured,
so it is recorded here as unexplained rather than as resolved.

## V-1583 — a guard that reported "0 unaudited" because it could not see the three that are

Followed from V-1582's non-GET sweep. Two operations answered success for an impossible id; the second was
`DELETE /v1/admin/oauth/clients/not-a-uuid` → 204. That one is not a defect — `revokeClient` returns
silently for a missing client and an idempotent delete is a legitimate idiom, even though the sibling GET
on the same path answers 404. Reading it did surface something else.

**Three mutating admin routes reach no audit call at all**, and a guard exists whose entire job is to make
that impossible:

```
POST   /v1/admin/oauth/clients
DELETE /v1/admin/oauth/clients/:id
POST   /v1/admin/oauth/clients/:id/rotate-secret
```

Creating an OAuth client, revoking one, and rotating its secret — staff actions on third-party
credentials, none attributable afterwards.

**The gap itself is known and correctly handled; the guard is what was wrong.** This is worth stating
plainly because the first read looked like a live finding. `admin-audit-route-coverage-invariant` (V-1007)
owns it, and `every-admin-mutation-writes-an-audit-row` carries the same three with the same reasoning and
pins the two lists equal by reading each other's source. Both scan by PATH. The reason none of them can be
wired is real and recorded in `docs/decisions.md`: `admin_audit_log.action` is a closed Postgres enum with
no `oauth_client.*` value, and choosing that vocabulary is the migration-bearing part.

**`every-mutating-admin-route-writes-an-audit-row` was the straggler.** It selected files with
`f.startsWith('admin-')` — a roster keyed by filename rather than by what a route IS — while its own
opening sentence claims every mutating admin route. `oauth.ts` registers five `/v1/admin/` routes and
`internal-atlas-priority.ts` two, so its `toEqual([])` was true only because the three violations were
outside the scan. Its header recorded "30 mutating admin routes, 0 without an audit call"; by path the
population is 33 with 3 unaudited, and the widened scan is a strict superset — nothing was lost, exactly
three gained.

Measured rather than argued, by injecting one unaudited mutating admin route into `oauth.ts` and running
both versions against it:

```
widened scan   1 failed — "oauth.ts POST /v1/admin/oauth/probe-unaudited"
filename scan  2 passed
```

Same violation, same file, one guard blind. That is the V-1529 shape again and now the sixth instance:
when a guard's header states an absolute, the scope of the scan must equal the scope of the sentence.

**Four arms, each mutation-proven.** The population arm now asserts that at least one admin mutation
outside an `admin-`named module is in scope, which is the specific thing the previous version passed
without. The main arm subtracts the roster. A third checks the reverse — a rostered route that starts
auditing, or one that no longer exists, must be struck — because an exemption outlives its reason
silently, and when the enum migration lands nothing else here would notice these entries had become false.
The fourth pins the set equal to V-1007's by reading its source, following the convention the two siblings
already established: three literal copies with textual equality pins, so a rename fails loudly rather than
two lists quietly disagreeing. Striking an entry, wiring an audit call, and perturbing the sibling each
red their own arm; all restores byte-identical.

No source behaviour changed — the three routes are still unaudited and still blocked on the same
migration. What changed is that the gap is now inside the guard's stated scope and bounded in both
directions instead of invisible to it.

Full suite 3073 files / 30962 tests; `verify-suite` OK.

## V-1584 — the sweep that found the last two bugs now covers the surface it was written for

V-1581 built a malformed-id sweep and scoped it to GET, which was honest at the time and covered 32 of
106 id-taking operations. V-1582 then found a real defect in the other 74 — but with a throwaway probe
that was deleted afterwards, so the instrument that found the bug did not exist in the repository. This
closes that: every method is swept, and the assertion that actually caught V-1582 is now part of the
guard rather than something I happened to notice in probe output.

**Two assertions, and the second is the one that earns its place.** A malformed id may be refused as a
400, a 404, a 401/403 before it is read, or a 422; it may not be a 5xx. That was V-1581. Added here: it
may not be a **2xx** either. An operation answering success for an id that cannot exist has not looked the
id up, which is exactly what `POST /v1/admin/validation-schedules/{archetype}/trigger` did — 200 with a
run id for any string at all, persisting nothing but dispatching work for an archetype that does not
exist. A 5xx-only sweep reads that as perfectly healthy, and did.

Both proven against the real defects rather than against synthetic ones. With V-1582's guard reverted the
sweep reds on `POST /v1/admin/validation-schedules/{archetype}/trigger -> 200`; with V-1580's reverted it
reds on `GET /v1/admin/usage/accounts/{id} -> 500`. Both sources restored byte-identical.

**One exemption, argued rather than excluded.** `DELETE /v1/admin/oauth/clients/{id}` answers 204 for a
client that does not exist, because `revokeClient` returns silently when it is absent — revoking twice is
the same as revoking once. That is a considered idiom, though it does make the pair inconsistent: the
sibling GET on the same path answers 404. It sits in a named roster so a second one has to be argued for
here instead of quietly passing.

**Coverage, measured: 106 operations, 82 refused, 24 behind a deployment flag.** The gated share grew from
9 to 24 with the mutating half in scope, which is why the blind-spot bound is asserted rather than
described — if activation flags ever hide the majority of the roster that is a fact about this guard's
reach and it fails instead of ticking green over untested routes.

**A weakness worth stating, because it bounds the claim.** POST, PUT and PATCH are swept with an empty
object as the body. Several handlers parse the body before the id, so some of those 400s are
body-validation refusals and the id was never judged. That does not weaken either assertion — a rejected
body yields 400, which is neither a 5xx nor a 2xx — but it does mean the non-GET half is covered less
deeply than the GET half. DELETE, which takes no body, is swept at full strength, and that is where two of
the three V-1580/V-1582 sites lived.

Full suite 3073 files / 30962 tests; e2e 223 passed against a disposable migrated Postgres, dropped
afterwards; `verify-suite` OK. No new test file, so no ratchet movement.

## V-1585 — four admin actions that answered 500 for an account that simply does not exist

V-1584 closed with a stated weakness: POST/PUT/PATCH were swept with an empty body, so a handler parsing
its body before the id would answer 400 and the id would never be judged. Chasing that produced a
correction to my own reasoning and then four real defects.

**The stated weakness was mostly wrong, and the real gap was worse.** Probing with a well-formed absent id
and an empty body, 32 of 59 body-bearing operations answered 400 — which I first read as body validation
shadowing the id check. Reading the response body rather than the status shows the opposite: the detail
says `Invalid id format. Expected "acc_<uuid>"`. That is the ID check firing, correctly, first. My
"well-formed" uuid was malformed for those routes because they publish prefixed ids.

Which exposes the actual hole. **The sweep only ever sent `not-a-uuid`, and every route that checks the
shape of its id refuses that immediately — correctly — so the lookup behind it was never reached.** The
guard was green over everything past the shape check. Asking again in the shape the refusal names, the
picture changes completely: 28 answered 404, and **four answered 500**.

```
POST /v1/admin/accounts/{id}/delete       500
POST /v1/admin/accounts/{id}/suspend      500
POST /v1/admin/accounts/{id}/tier         500
POST /v1/admin/accounts/{id}/unsuspend    500
```

**The cause is the audit write on the failure path.** `admin_audit_log.target_account_id` is a foreign key
to `accounts`. The service is correct — `if (!updated) throw new NotFoundError(...)` — and `withAudit`
catches that, records `result: 'error: notfound'` with the same `targetAccountId`, and the insert violates
the constraint. The constraint error then replaces the 404. Proven directly rather than reasoned:

```
ERROR: insert or update on table "admin_audit_log" violates foreign key constraint
       "admin_audit_log_target_account_id_accounts_id_fk"
DETAIL: Key (target_account_id)=(1111…) is not present in table "accounts".
```

**The file already contained the answer.** `POST /v1/admin/accounts/{id}/audit-note` carries an explicit
`// Confirm target exists.` lookup before `withAudit`, which is why it answers 404 while its four siblings
do not. The fix here is the more general one: on the error path, when the thrown error is a NotFound, the
id moves to `target_resource_id` — plain text, no key — and `target_account_id` goes null. Attribution
survives, no extra query is added to the happy path, and it also covers the race the pre-check cannot,
where the row disappears between the check and the action.

**Fixing the sweep mattered more than fixing the routes.** A second pass now asks with a well-formed
absent id and, when the refusal names a shape, asks again in that shape — 49 of 106 operations are
re-asked. That number is asserted, because without the re-ask the pass silently degenerates into the
malformed one and re-hides everything.

**And the body-shadowing was real after all, for one route.** With an empty body the second pass caught
three of the four: `/tier` was still refused by `ChangeTierRequestSchema` before the lookup. Minimal
bodies are now generated from the operation's own schema — required scalars only, enums taking their first
value — and the fourth appears. Required object and array fields are not guessed, so eight operations stay
body-shadowed; that set is printed and bounded rather than described.

Sending bodies the handlers accept also reached a second deployment gate that had never been visible:
`driver-not-integrated`, distinct from `feature-unavailable`. Both are declared typed refusals and are now
named as a set, still keyed on the type rather than the 503, so a route that genuinely fails cannot
inherit the exemption.

Reverting the fix reds the sweep on all four routes; restored, both passes are green. Full suite 3073
files / 30962 tests; e2e 224 passed against a disposable migrated Postgres, dropped afterwards;
`verify-suite` OK. The Playwright figure moves 223 -> 224 in all four places the blind-spot suite pins it.

## V-1586 — a fifth 500 of the same family, hidden behind a required query parameter

V-1585 fixed one of three audit helpers in `admin-accounts.ts`. Enumerating the rest of the class rather
than stopping at the instance found two more error paths writing the account foreign key —
`withAuditOverride` and `withAuditOverrideClear` — and one live route reaching them.

**`DELETE /v1/admin/accounts/{id}/quota-override` answered 500 for an account that does not exist.** Same
mechanism as V-1585: `clear()` throws a not-found when nothing was removed, the catch records
`error: notfound` carrying `target_account_id`, and the foreign key rejects it. Zero audit rows landed
during the probe, which is the confirmation that the insert itself was what failed.

**The sweep could not see it, for a third reason.** V-1584 was shadowed by bodies the handlers reject and
V-1585 by id shapes refused before the lookup; this one is shadowed by a required QUERY parameter. Without
`bucket_key` the route answers 400 on the query schema before it looks at the account at all. Required
query parameters are now filled from their own schemas, exactly as bodies are. Optional ones are
deliberately left off — supplying them would change the question from "is the id judged" to "does some
filter combination work".

**The asymmetry was in the file already.** `POST .../quota-override` carries an explicit
`// Confirm target exists before recording.` and its sibling DELETE did not, which is precisely the
difference between 404 and 500. That is the second time in two batches that the correct handling of a
route sat ten lines above the broken one.

**Two changes, and the mutation results separate them in a way worth recording.** Removing the pre-check
alone leaves the sweep GREEN: the helper guard fixes the status by itself. Only removing both reproduces
the 500. So the pre-check is not load-bearing for the status code, and committing it on the strength of
"the sweep passes" would have been a fix with no test behind it. What it does change is the message —
without it the refusal comes from `clear()` and reads "no active override for account X", which quietly
asserts that the account exists. That claim now has its own arm, and removing the pre-check reds it.

The two helpers null the key rather than moving it, because `target_resource_id` is already carrying the
bucket key here. That is a real difference from V-1585 and the comment says so: a row about an account
that does not exist has no account to attribute to, and the admin who acted is still recorded.

Full suite 3073 files / 30962 tests; e2e 225 passed against a disposable migrated Postgres, dropped
afterwards; `verify-suite` OK. The Playwright figure moves 224 -> 225 in all four pinned places; the
spec-file count is unchanged at 37 because the new arm joined an existing file.

## V-1587 — a fifth of the sweep's roster was never reached, and it scored as covered

Closing out the id-handling class produced one clean negative result and one defect in my own instrument.

**The negative result first, because it bounds the class.** Every route file with an error-path audit
write was checked, not just the one the bug appeared in. Six omit `targetAccountId` or set it null;
`admin-force-actions.ts` uses a deferred value that starts null and is assigned only AFTER the not-found
throw, so its thunk resolves to null on exactly the path that would violate the key — correct by design,
not by luck. Only `admin-accounts.ts` carried the defect, in three helpers, all fixed in V-1585 and
V-1586. The class is closed.

**Then the instrument.** Chasing the eight body-shadowed operations, two crypto-orders routes answered
`404 "No route for PATCH /v1/admin/crypto-orders/…"` — Fastify's own not-found handler. Both are declared
in `openapi.json` and both are registered in source. `buildApp` registers several route modules only when
an optional dependency is supplied (`if (deps.incidentsService !== undefined)` and siblings), and the e2e
harness supplies a subset.

**Twenty of the 106 operations are in that state, and this sweep counted every one as a healthy refusal.**
A 404 meaning "looked it up, not there" and a 404 meaning "there is no such route" are the same status,
and the sweep only read the body on a 5xx. So a fifth of the roster was scored as covered while nothing
behind those paths was ever reached — the same silently-inert shape this suite keeps finding in guards,
this time in mine.

**The record needs correcting rather than leaving flattering.** V-1584 reported "82 refused", V-1585 "80
answered". With unrouted operations counted separately the real figures are **62 refused and 60
answered**, overstated by exactly the twenty. Nothing previously reported as a defect changes — the five
500s and the 200 were all found on routes that do answer — but the coverage claims were wrong and are
restated here.

One earlier inference also loses its support. When checking `admin-force-actions.ts` I cited the probe
showing `POST /v1/admin/sessions/{id}/destroy` and `POST /v1/admin/api-keys/{id}/revoke` answering 404.
Both are in the unrouted twenty, so that evidence was worthless. The conclusion survives on the source
reading — the deferred value is null until the session is found — but it rested for a while on an
experiment that could not have distinguished the two outcomes.

Unrouted operations are now detected by their body, counted separately, listed on every run, and bounded
at twenty in both passes. Tightening the bound to nineteen reds both, so the bound is load-bearing rather
than decorative. None of the twenty is a production defect: every one is registered by the real
application.

Full suite and gates green. The file and test totals moved by one file and four tests during this batch;
`git status` attributes both to a peer's in-flight gui-client work, so the ratchets are theirs to move and
were left alone.

## V-1588 — reaching eight of the twenty operations the sweep could not see

V-1587 established that twenty declared operations answered "No route for" under the e2e harness and were
being scored as refusals. Bounding that was the honest minimum; reaching them is the actual fix, and eight
of the twenty needed nothing that did not already exist in the harness.

**Five came from the incidents service.** `buildApp` registers the admin-incidents routes only when
`incidentsService` is supplied. Constructing it costs one line — `new IncidentsService(new
DrizzleIncidentsRepo(database))` — because the lifecycle hooks are declared `= {}` by the service itself.
That matters: no no-op double was written here. Hand-stubbing those callbacks would have produced exactly
the kind of faithful-looking test double this log keeps warning about, and the service's own default is
neither faithful nor a lie — it is the documented behaviour when no notifier is wired. `incidents` and
`incident_updates` joined the harness TRUNCATE so the new writes cannot leak between specs.

**Three came from a dependency triple that was two-thirds satisfied.** The admin force-action routes
register only when `sessionRepo`, `apiKeysRepo` and `driver` are all present. The harness passed the
first and already had the other two — the same `MockDriver` and repo the rest of the file uses — so the
fix is two lines and invents nothing.

**That recovers the evidence V-1587 had to withdraw.** The claim that `admin-force-actions.ts` handles a
missing target correctly rested on a probe showing 404s that turned out to be unrouted 404s. Both routes
now genuinely answer: 400 for a malformed id, 404 for one that is well-formed and absent. The source
reading was right — the deferred account id is null until the session is found — and it now has an
experiment behind it that could have contradicted it.

**Twelve remain, and they stop here deliberately.** Nine are crypto-orders, whose service needs a tier
activator; the rest need a LiveKit config and an atlas-priority wiring. Supplying those means constructing
billing and streaming behaviour that does not otherwise exist in this harness, which is the point at which
widening coverage starts manufacturing the doubles that make coverage meaningless. The bound moves 20 → 12
so it tracks reality rather than leaving eight recovered operations of slack; tightening it to 11 reds
both passes, so it is load-bearing.

**One phantom, caught by verifying instead of reporting.** `grep "ForceActions" app.ts` found nothing and
for a moment looked like two admin endpoints declared in the spec and never registered. The symbol is
`registerAdminForceActionRoutes` — singular — and the call sits at `app.ts:1747`. That is the same
one-spelling fault this session keeps recording, and the only reason it did not become a filed finding is
that the claim was checked before it was written down.

Coverage moves from 62 refused / 60 answered to **70 refused / 68 answered**, with 24 and 26 respectively
behind deployment flags. Full e2e 225 passed against a disposable migrated Postgres — unchanged, because
this batch adds coverage rather than tests. Full suite and `verify-suite` green.

## V-1589 — the last shadowed bodies, and a bound that was absorbing them

The sweep carried a set it called "still body-shadowed", bounded with
`expect(shadowed.length).toBeLessThan(10)` while eight operations sat inside it. A bound with slack is a
number quietly absorbing the thing it is supposed to report, so this batch was about emptying the set
rather than describing it.

**Checked before building anything.** The five session operations in that set — wait, interact, extract,
navigate, capture — were probed by hand with bodies matching their schemas. All four that take a
discriminated union answer **404 for a well-formed absent session id**, correctly. There is no defect
hiding behind the shadowing; what there was is untested surface, which is a different problem and worth
separating.

**The generator learned three shapes, and each was already in the document.** A `oneOf`/`anyOf` takes its
FIRST variant — the aim is a body the handler accepts so the id is reached, not exercising the union. An
array takes exactly one item, since nothing on this surface asks for more. A nested object fills its own
required properties recursively, depth-capped at six, because a self-referential schema would otherwise
hang and a sweep that hangs is worse than one that skips.

That took the shadowed set from eight to two. The last two were `type: ['string', 'null']` — JSON Schema
permitting a LIST of types, which this surface uses for nullable fields. Reading the whole array as one
unknown type is what left them unbuildable; taking the first non-null member is the whole fix, and the
set reaches zero.

**The bound is now none, and it is load-bearing.** Removing the union handling puts three operations back
and reds the suite. An operation whose required body cannot be built is one this sweep cannot reach, and
that deserves a failure asking the generator to learn the shape rather than a threshold absorbing it.

**A number that did not move, and a fact that did.** Refused stayed 70 and answered stayed 68 across this
change, because those five session routes were already counted as refusals — they were answering 400 on
the body. They now answer 404 on the id. The count is identical and the coverage is not, which is the
clearest illustration this log has of why a green total is not evidence about what was actually exercised.

Twelve operations remain unrouted under the harness, unchanged from V-1588 and for the same stated reason.
Full e2e 225 passed against a disposable migrated Postgres; full suite and `verify-suite` green. The 3074
files / 30966 tests still include a peer's in-flight gui-client work, whose ratchets were left alone.

## V-1590 — the same defect one door over, in the query string

Eleven batches on path parameters had reached the point of diminishing returns, so this one moved the
proven instrument to the other place ids arrive. The move paid immediately.

**`GET /v1/admin/webhook-dlq?endpoint_id=` answered 500 for anything that was not a uuid.** The route
removed the public `webhook_endpoint_` prefix and handed the remainder to a repo filtering
`webhook_deliveries.webhook_id`, a `uuid` column. Confirmed against Postgres rather than inferred:
`invalid input syntax for type uuid: "not-a-uuid"`. The schema declared
`endpoint_id: z.string().min(1).max(200)` — a length, not a shape.

That is the third time this session the finding has been the same sentence: **stripping a prefix is not
validating what is left.** `bareAccountId` in admin-cost, the account-id params in admin-usage, and now
this. The fix follows the established idiom — accept `webhook_endpoint_<uuid>` or a bare uuid, refuse
anything else — and the file's own `PUBLIC_ID_RE` could not be reused because it only matches
three-letter prefixes.

**One of the hostile values needs a disclaimer.** `?endpoint_id=' OR 1=1--` also returned 500, and that
is NOT injection. The queries are parameterised and the string never reaches the planner; it fails for
exactly the same reason `not-a-uuid` does. It stays in the value set because it is a plausible paste from
a support ticket, but reading that 500 as an injection finding would have been wrong, and the probe output
invites precisely that misreading.

**The measurement was clean, which is itself the result.** 309 hostile requests across 35 operations
produced three server errors, all the same parameter. `limit` at -1, 0 and a billion, `cursor` as garbage,
dates as nonsense, enums as unknown values — all correctly refused. The query surface was in good shape
apart from one filter, and that is worth recording as plainly as the defect.

**The instrument is now permanent.** A new spec sweeps every declared query parameter with values derived
from its own type, so a parameter added tomorrow is covered without anyone remembering. It carries the
lessons the sibling spec learned expensively: unrouted operations are detected by body and bounded from
the start rather than after twenty of them were scored as passes, and deployment gates are keyed on the
declared problem type rather than the status. Reverting the fix reds it on the exact parameter.

Both instruments were proven against the defect: the integration arms red on four cases when the strip is
restored, and the new sweep reds with `?endpoint_id=not-a-uuid -> 500`.

**Working-tree note, recorded because it affects what the numbers mean.** Partway through this batch the
source fix and the new spec were committed by a concurrent writer — correctly scoped, correct author,
correct pathspecs, but not by this session. Separately, a peer's in-flight audit-archive work is dirty in
the tree and accounts for seven failures across `audit-archive`, `bootstrap` and the scheduler guards.
Attributed via `git status` before investigating; none of the seven names a file this batch touched, and
the four files it does touch pass. The full suite is therefore NOT green as of this entry, and the reason
is not this work.

Playwright moves 225 → 226 over 38 spec files, updated in all four places the blind-spot suite pins them.

## V-1593 — the pin that judged the `--all` run was maintained by hand, and had drifted

`EXPECTED_TEST_FILES` has been checked against disk all along: a census in
`scripts/tests/verify-suite.test.ts` walks the include globs and fails until the pin matches. Its
sibling `EXPECTED_TEST_FILES_ALL` had no such census. It was a hand-maintained number, and it had
drifted **12 files below reality** — 3179 against 3191 collected.

The gate compares `collected < expectedFiles`, so the pin is a floor. A floor twelve low means
twelve files could stop being collected and the run would still report "full file count".

**I absorbed the gap, which departs from the standing rule** recorded two entries above — that a pin
is raised only for the files its author added, because quietly closing someone else's gap hides
whatever caused it. Stating the departure rather than making it silently:

- The cause is identified and now removed. The gap did not come from a change nobody understood; it
  came from the pin having no census while its sibling had one, so it fell behind every time anyone
  added a file without remembering this second number. `countAllTestFiles()` closes that.
- Nothing is being hidden, because nothing is missing. All 3191 files are collected and running —
  independently counted (`.test.ts` 3018 + `.test.tsx` 173) and matching what `npx vitest run`
  reports. This was a lagging counter, not absent coverage.
- With the census in place a future gap cannot form silently, so there is no cause left for absorbing
  this one to conceal.

Mutation-proved: restoring 3179 turns the new arm red.

⚠️ **A second finding, about how this suite has been run.** `npx vitest run --root apps/gui-client`
reports a confident green over 173 files — and `apps/gui-client/tests/unit` holds 247. The missing 74
are not excluded; they are `.test.ts`, and the root config registers TWO projects: `gui-jsdom`
(`include: ['tests/**/*.test.tsx']`, jsdom) and the node project
(`include: ['apps/**/tests/**/*.test.ts', …]`). The `.tsx` extension is the discriminator. A partial
run is indistinguishable from a complete one — same format, no warning. The whole GUI surface needs a
path, not `--root`: `npx vitest run apps/gui-client/tests` → 247 files / 2,304 tests.

## V-1592 — an admin filter that was broken for the form its own header documents

The twelve unrouted operations V-1588 left behind were declined on the grounds that reaching them meant
inventing doubles. That reasoning was wrong for nine of them, and checking it produced the sharpest finding
of the session.

**The parts were all real and already present.** `buildApp` registers the crypto-order operations only when
`cryptoOrdersService` is supplied. Building it needs `DrizzleCryptoOrdersRepo`, `CryptoTierActivationService`
over `DrizzleStripeWebhooksRepo`, and the lifecycle service and auth cache the e2e harness already
constructs — every one the production class against the real database, which is the condition under which
widening coverage is worth doing. Unrouted fell 12 → 2 for the id sweep and 28 → 9 for the bearer sweep,
and the query sweep went red immediately.

**`GET /v1/admin/crypto-orders?account_id=` answered 500, and not only for hostile input.** The route
passes the filter to a repo querying `crypto_orders.account_id`, a `uuid` column. The header of that same
file documents the parameter as `acc_X`, and:

```
SELECT 1 FROM crypto_orders WHERE account_id = 'acc_11111111-2222-3333-4444-555555555555';
ERROR:  invalid input syntax for type uuid
```

So the drill-down was broken for the shape the route publishes. Only the undocumented bare-uuid form
worked. Both call sites — the JSON list and the `.csv` export — had it.

**Why every test agreed it was fine.** The integration test named `filters by account_id when supplied`
seeded `account_id: 'acc_other'` and filtered by it, passing green. In-memory repos key orders by a plain
string, where any invented id is a perfectly good key; the real column is a uuid, where the same value is
a cast error. That is the route/database seam V-1581 described, and this is the clearest instance of it
yet: not a test that missed a case, but a test whose fixture could only exist in the fake world.

The fixture now uses ids valid in both worlds and asserts BOTH published shapes work, which is what the
old test was silently failing to establish.

**A run-configuration fault of my own, worth recording.** Invoking `npx playwright test <spec> <spec>` from
the repository root picks up no config: the real one lives at `apps/server/playwright.config.ts` and sets
`workers: 1, fullyParallel: false` precisely because `startTestServer` drops and recreates the schema.
Two workers therefore destroyed each other's database, which surfaced as
`duplicate key value violates unique constraint "pg_namespace_nspname_index"` and looked briefly like a
product defect. Single-spec runs and `scripts/e2e-local.mjs` were always correct, so no earlier conclusion
rests on it — but multi-spec runs go through the runner from here.

**Bounds tightened to what was measured**, since a bound with slack absorbs the thing it reports: the id
sweep's unrouted bound moves 12 → 2 and the bearer sweep's 28 → 9. Reverting the fix reds five arms across
both call sites.

Full suite 3076 files / 30996 tests, green; e2e 227 passed against a disposable migrated Postgres,
dropped afterwards.

## V-1595 — the third door, and two mutations that proved nothing

Path parameters produced six findings and query parameters one, so the remaining place an id arrives is
the request body. Sixteen body properties across the surface are named like ids.

**Nothing was wrong, and the checking is the interesting part.** Every reachable one refuses a malformed
value with an explicit message — `must be "prof_<uuid>" or a bare uuid` on `POST /v1/sessions`,
`Expected "acc_<uuid>"` on the profile transfer, an `invalid_request` on the OAuth client create. Eight of
the sixteen sit behind activation flags and prove nothing either way, which the sweep now states and
bounds rather than folding into a green.

**The first mutation was inert and looked like a pass.** `POST /v1/sessions` answers 400 for a bad
`profile_id`, so removing the throw from `parseProfileId` should have reded the sweep. It did not, and the
reason is that the refusal comes from a zod schema in `@driftstack/api-types` — a second, earlier guard.
`parseProfileId` is the backstop, not the gate.

**The second mutation was inert for a different reason, and only the message gave it away.** Relaxing that
zod regex ALSO changed nothing: the server consumes api-types as built `dist`, so editing the package
source without rebuilding has no effect on a running server. The tell was that the 400 came back with the
identical text — a real change would have altered it. Two mutations in a row that a green would have
credited to the guard.

**The proof that counts used a guard in server source.** Removing V-1582's archetype check makes
`PUT /v1/admin/validation-schedules {archetype_id}` answer 200 for a nonsense archetype, and the sweep's
no-2xx assertion fires on it. That is the assertion doing real work, on a mutation that actually reached
the running code.

Worth keeping separate from the result: this batch found no defect, and the only reason that statement is
worth anything is that two of the three attempts to test the instrument were themselves broken. A sweep
declared effective on the strength of either of the first two would have been a guard nobody had
established could fail.

The input surface is now covered in all three places an id arrives — path, query, body — each with a
sweep, each mutation-proven against a defect the repository actually had.

Full suite 3076 files / 30996 tests, green; e2e 228 passed against a disposable migrated Postgres,
dropped afterwards; `verify-suite` OK. Playwright moves 227 → 228 over 39 spec files.

## V-1594 — re-measuring the claim a scope decision rests on

V-1595 lost two mutations to a package consumed as `dist`. `dist-reading-suites-have-fresh-artifacts`
already knows that hazard — V-951 was bitten by it and V-954 recorded the decision to leave
`packages/*/dist` out of scope. The decision is sound and its load-bearing invariant is pinned: `pretest`
runs `npm run build --workspaces` before `vitest run`, verified still present. What had rotted is the
evidence quoted beside it.

**"Byte-identical across all 24 emitted files" is not true today, and the correction matters more than it
sounds.** Building `api-types` into a scratch `--outDir` and comparing:

```
emitted .js      0 differences
emitted .d.ts    24 files, 14 differing in bytes, 0 differing in meaning
.map             differ — sourcemaps embed the output path
.tsbuildinfo     present only on disk — incremental state
```

Every `.d.ts` difference is ordering: properties in a different sequence, and union members likewise —
`admin.d.ts` moves `webhook_delivery.replayed` to the front of a 32-member union whose membership is
unchanged. That was verified as a per-file token multiset rather than by reading diffs, because a
reordered union and an edited one look identical at a glance, and my first attempt using sorted LINES
reported nine files as genuinely different when none were.

So the decision stands on **semantic** identity, not byte equality. The distinction is worth the words:
anyone repeating the check, seeing fourteen differing files, would read drift that is not there and
either re-derive the whole argument or act on a false alarm.

**A second imprecision, in the original note and then in my correction of it.** Both said "the committed
`dist`". `dist/` is gitignored and carries zero tracked files. What the server loads is whatever the last
local build left, which is exactly why comparing it against a fresh build is worth doing at all — and
calling it committed hides that.

**The mutation hazard is now recorded where it will be found.** The two hazards already listed are about
assertions reading a stale artefact. The one that cost me two inert mutations is different in kind: it
bites the person checking. Editing `packages/api-types/src` and re-running proves nothing, because the
running server and every e2e spec load the built package — and both inert mutations looked exactly like a
guard correctly holding. The only tell was an error message coming back with identical text.

No defect, no behaviour changed. A dated measurement re-taken, two imprecise words replaced with what is
measurable, and a hazard written down at the cost of two wasted proofs rather than left for the next
person to pay again.

Full suite green; `verify-suite` OK.

### Numbering

This batch also corrected a collision: a peer's `493855898` took V-1593 first, and my later entry reused
it. Mine is renumbered to V-1595 along with its three citations, leaving the peer's citation in
`scripts/tests/verify-suite.test.ts` resolving to the entry it was written against. The log is
append-only, so the later entry is the one that moves.

## V-1596 — the error contract holds, and two of my own measurements said otherwise first

The input surface is covered in all three places an id arrives, so this batch turned to what comes back
out. Two false starts are worth recording before the result, because both were my measurement rather than
the code.

**First false start: "all 1114 error responses have no schema."** They all have one. The scan looked up
`content['application/json']` and RFC 7807 responses are `application/problem+json`, so every lookup
missed and reported an absence. The document declares `Problem` — `type`, `title`, `status`, `detail`,
`instance` — and refs it 1113 times.

**Second: "the server emits no problem type URLs."** `grep -rhoE "errors\.driftstack\.dev/[a-z-]+"` over
the source returned zero, while the same URLs had been visible in responses all session. They are
constructed rather than written literally. Third time this session that one spelling of a thing has been
mistaken for the thing, and the first two were in the same half-hour.

**The result, once measured properly.** Errors from five different layers — a route shape check, a repo
lookup that misses, the auth preHandler, a zod schema, and Fastify's own not-found handler — all answer
`application/problem+json` carrying exactly the five declared members. The contract holds on the wire, not
just in the generated document.

**One undeclared extension, and it is legal.** Validation failures add `issues` with the field-level
detail. RFC 7807 permits extension members and `Problem` sets `additionalProperties: {}`, so nothing is
broken — but no schema names it, while `AgentMessageConflictProblem` shows this document declares its
extensions when it means to. Declaring it properly means regenerating the published spec and moving the
SDK and docs parity pins with it, which is not a change to make at the end of a long session with a
concurrent writer in the tree. It is allowlisted in the new spec instead, so it stays visible and a SECOND
undeclared member has to be added deliberately rather than arriving unnoticed.

**Why this is worth a guard rather than a note.** `docs/decisions.md` records the TypeScript SDK carrying
"17 typed error classes mirroring the server's RFC 7807 problem-types", and those classes dispatch on
`type`. An error that loses that member is not a typed error to any of them, and nothing in the suite
would have said so.

Three arms, each mutation-proven against the real serializer in `middleware/error-handler.ts`: switching
the content type to `application/json` reds the first, dropping `instance` reds the second with the arm
that names the SDKs, and adding a `debug_hint` member reds the third. Restored byte-identical. The cases
are deliberately drawn from five layers rather than swept from one, because a sweep of one kind would
prove only that one layer is consistent with itself.

Full suite 3076 files / 30996 tests, green; e2e 229 over 40 spec files; `verify-suite` OK.

## V-1597 — thirteen 429s that never mentioned the one header the response exists to give

`docs/decisions.md` records the TypeScript SDK carrying a retry policy that honours `Retry-After`, which
makes that header a contract with a named consumer rather than a nicety. The document declares 226 error
responses with status 429. Thirteen of them did not declare the header.

**The server sends it; the document did not say so.** Proven by exhausting the smallest public bucket on
the surface — `/v1/egress/echo` at 12 per IP — rather than by reading the limiter:

```
request 12 -> 429
  retry-after: 5
  content-type: application/problem+json; charset=utf-8
  body: {"retry_after_seconds":5,"type":".../rate-limited", ...}
```

All thirteen sit behind `ipRateLimit` or `app.rateLimit`, both of which set the header. So a generated
client reading the spec could not see the one signal those responses exist to give, and would fall back to
a hard-coded backoff on exactly the endpoints most likely to be called in bursts.

**This gap was found and closed before, for the other 213.** The `rateLimitHeaders` comment in
`openapi.ts` says it outright: "The server has always sent these; the spec never declared them, so a
generated client could not see the one signal the response exists to give." The shared error-response
object carries them; these thirteen declare their 429 inline and never picked it up. Three different
inline spellings among them, which is why the edit was driven off the measured route list rather than a
text pattern — a first pass keyed on a three-line window found twelve of the thirteen, and the one it
missed was the only one whose path used `{id}` rather than `:id`.

All 226 now declare it. The regenerated spec is **763 insertions and zero deletions** — additive, which is
why none of the 92 test files that read `openapi.json` moved.

**And the guard written one batch ago had the same shape of hole.** V-1596 allowlisted `issues` as the one
undeclared extension member. `retry_after_seconds` is a second, and that spec passed anyway because none
of its eight cases produced a 429 — a roster tested against one of the two paths that populate it. A
rate-limit case is now included, reached by exhausting the bucket rather than assumed, and narrowing the
allowlist reds it on that member. The lesson is the one this log keeps recording in a new costume: an
allowlist is only as good as the population it was measured against.

Two of my own leftovers caught by other people's guards rather than by me: a probe spec left in
`tests/e2e` moved the file count and the blind-spot suite named it, and a mutation restore from a snapshot
that predated this batch stripped both changes — caught by asserting the identifier was absent before
re-applying, which is the check this session added after the same trap three times.

Full suite 3076 files / 30996 tests, green; e2e 229 over 40 spec files; `verify-suite` OK.

## V-1598 — a branch that reads as reachable, and the invariant that now says so

V-1597 fixed thirteen 429 responses that omitted `Retry-After`. The obvious next question was the other
status in the same sentence: `middleware/error-handler.ts` branches on `429 || 503`, its comment cites
RFC 7231 for both, and the document declares 46 responses with status 503 and `Retry-After` on none of
them. That looked like the same finding one status over.

**It is not, and the tracing is the work.** The handler only sets the header when the error carries a
`retry_after_seconds` extension. Exactly one class does — `RateLimitedError`, status 429. The two
503-producing classes, `FeatureUnavailableError` and `DriverNotIntegratedError`, do not. The agent-message
passthrough has the same `429 || 503` shape and reads its value from `terminal.body`, which is
`apiError.toProblem()` — so it inherits the same limitation rather than escaping it. Both 503 halves are
currently unreachable, and the document is right to omit the header.

Recorded rather than removed. The comment states the intent — RFC conformance for a 503 that has an honest
retry time — so this is a documented decision with no caller yet, not dead code to delete.

**What the batch produces instead is the invariant that makes the next version of this cheap.** Two sides,
both derived: the statuses whose error class sets `retry_after_seconds`, read out of `lib/errors.ts`, and
the statuses whose published responses declare a `Retry-After` header. The assertion is one-directional on
purpose — a response MAY declare the header without every instance carrying one, which is exactly the
concurrency-limit 429 the header's own description already calls out. What must not happen is the reverse,
and that reverse is precisely what V-1597 found thirteen times.

Measured when it landed: emits {429}, declares {429}. Give `FeatureUnavailableError` a retry hint and the
subset assertion fails naming 503, which is the moment the spec needs updating — proven, not asserted.
Renaming every declared `Retry-After` in the document reds it too, on the vacuity arm rather than the
subset one, because an empty right-hand side would otherwise make the check trivially false in a way that
looks like a real finding.

**A hypothesis that survived three checks and still died on the fourth** is worth the space: the branch
reads as reachable, the comment says it should be, a second file repeats the shape, and only following the
extension to its single producer settles it. Three of those four readings pointed the same wrong way.

Both pins raised by one for the file this batch adds, and only for that file. Full suite 3077 files /
30998 tests, green; `verify-suite` OK.

### Also noted, not acted on

`/v1/status/stream` has zero mentions in `openapi.ts` and is absent from the published document, while its
connection-cap gate sets `retry-after: 30` on refusal. An undocumented public SSE endpoint is a separate
question from this one and is left recorded rather than folded in.

## V-1599 — the gate that makes a scope-skipping credential safe, now checked

Two open items from the previous batch were closed by reading rather than editing, and the reading led
somewhere better than either.

**`/v1/status/stream` is not undocumented.** It is absent from `openapi.json`, which is what I measured,
but `a-route-in-neither-the-spec-nor-the-docs-is-a-decision` deliberately accepts spec OR docs, and the
endpoint is written up in `apps/docs/src/pages/api/status.md`. Prose-only is a defensible convention for
SSE, which OpenAPI describes poorly. Not a finding.

**The two routes that guard DOES flag are not mine to fix.** `POST /v1/sessions/{id}/gui-input` and
`GET /v1/agent-sessions/{id}/gui-control-key` appear in neither the spec nor the docs while being
reachable with an ordinary customer key. The guard says why it stops short, and it is right: "Publishing
an endpoint is a product commitment — it is what the SDKs generate against and what the deprecation policy
then covers... Deciding whether that is a public API is not a drift guard's call. Recording that the
decision has not been made is."

**What that header led to is worth the detour.** It describes `gui-control-key` as minting a credential
that reaches five other routes "with no scope check of its own (audit wxzlp9yiz, a P1 auth bypass)". Read
in isolation that sounds live. It is not: the mint now demands `write` AND `read:sessions`, and the source
comment explains why both — with only `write`, a bare-write key could mint its way into the live cookie
jar, page state and downloaded bytes; with only `read`, a read-only key could escalate to
mode/input/takeover/handback and DELETE. The original rationale reasoned about read→write and missed
write→read.

**But the mechanism the P1 exploited is still the design.** Every `controlKeyOrAccountAuth` route returns
on a valid control key BEFORE `requireScope` runs, so the key reaches those routes having proven nothing
there. The mint is the only gate. That makes one thing a standing invariant rather than a one-time fix:
the set of scopes a control key can REACH must stay inside the set the mint already REQUIRED.

Measured: reached `{read:sessions, write}` across fourteen registrations — five reads (GET /:id,
page-state, cookies, downloads, downloads/content) and nine writes — against a mint requiring
`{read:sessions, write}`. Equal today. Both sides derived from source; the assertion is subset, because
demanding more at the mint than the key can reach is a tightening rather than a hole.

Proven in both directions. Pointing one registration at `admin:profiles` flags it as reachable by a key
that never proved it. Dropping `read:sessions` from the mint — literally the pre-audit state wxzlp9yiz
found — flags `read:sessions`, which is the P1 reproduced and caught. Restores byte-identical.

### Concurrency

Six failures appeared mid-batch and none were this work: five are a peer's in-flight proxies-grid suite
(`ProxiesView.tsx` dirty, plus a new gui-client spec), and the sixth reports `github-slugger in apps/docs`
— an install-hoisting condition in a workspace this batch does not touch. Attributed via `git status`
before investigating.

The `_ALL` pin briefly read one behind disk because that peer added a spec file while this one did. I
raised it by one, for one file, and left theirs alone; their commit `161cd3011` then raised it again for
their own and swept my node-project bump along with it. Both pins are now correct for both files, which is
the right outcome reached by each side counting only what it added.

## V-1600 — the other half of "that session only"

V-1599 pinned which SCOPES a control key can reach. This pins which SESSION, because the two failures are
independent and the scope guard cannot see the second one.

**The binding itself is sound and that was verified first.** `validateGuiControlKey` fetches the session
named in the PATH, decrypts that session's `guiControlKeyCiphertext`, and `timingSafeEqual`s the presented
header against it behind a length pre-check. A key minted for session A cannot validate against session B.

**The step after is what had nothing enforcing it.** When the key validates, the request is marked
`guiControlKeyAuthorized` and fourteen handlers then skip the account-ownership check — the factory's own
comment says "for THAT session only". Nothing checked the "that session" half. A handler that skipped
ownership and then looked a session up by an id from a body field, header or query would be acting on a
session the caller proved nothing about, at the same scope, which is precisely the blind spot of the guard
written one batch earlier.

Traced by hand: all 21 `sessions.get` calls resolve to `req.params.id`. Seventeen say so literally. Three
go through helpers — `commitPairModeTransition`, `resolveAgentMessageAdmission` and the control-key
validator — and every call site of each passes `req.params.id`. The twenty-first is `created.id` on
`POST /v1/agent-sessions`, which takes `requireAuth` + `requireScope('write')` and is not control-key
reachable at all. There IS a body-supplied `driftstack_session_id` on that create route, and it is on the
one route the key cannot reach — which is the sort of coincidence worth pinning before it stops being one.

The roster carries those four indirect arguments WITH the reason each resolves to the path session, rather
than loosening the pattern to `\w+` — which would accept a body-derived local and leave the file asserting
nothing about the property it is named for.

Proven in both directions: repointing one lookup at `parsed.data.driftstack_session_id` flags it as
unrostered, and rewriting a rostered helper's lookup so its entry goes unused reds the stale-roster arm.
Restores byte-identical.

Nothing changed in the source. What changed is that the tracing above no longer has to be redone to know
it still holds.

### Concurrency

Two failures are outstanding and neither is this work: `gui-client-views-ProxiesView-content-parity` and
`the-gui-does-not-blame-a-shipped-server-for-a-failed-probe` both freeze `ProxiesView.tsx` source, which
commit `4056443ab` rewrote as a sortable grid without moving the pins. Attributed via `git status` — this
batch's only files are a new server unit test and the two pins it required — and left alone, because
updating a content-parity pin for a rewrite I did not make is exactly the absorption rule 9 exists to
prevent. `verify-suite` will report failure until that is resolved, for that reason and not this one.

## V-1601 — the scope fault I have found six times, in my own two guards

V-1599 and V-1600 both open by claiming a property about "a gui_control_key". Both read
`agent-sessions.ts` and nothing else. Two sibling routes —
`agent-sessions-livekit-token.ts` and `agent-sessions-transport-report.ts` — carry their own copy of the
control-key auth shape rather than importing the factory, validate the key inline, and set the same
`guiControlKeyAuthorized` flag. Neither guard could see them.

Nothing was wrong in either sibling, which is what this fault almost always produces: livekit-token falls
through to `requireScope('write')` and transport-report to `requireScope('read:sessions')`, both inside
the minted set, and both derive `sessionId` from `req.params.id` before looking a session up. Verified
before widening rather than after.

**Both populations are now derived from the flag rather than from a filename**: any routes file that
assigns `req.guiControlKeyAuthorized = true` is a file where a control key skips a scope check, so it
belongs in both scans. The scope side also learned the second spelling — the siblings name their scope in
the `app.requireScope(...)` they fall through to, not in a `controlKeyOrAccountAuth(...)` argument.

**And the widening was inert on its first attempt, which is the part worth recording.** The session guard
matched `sessions.get` and a guessed `sessionRepo.get`; the siblings call `agentSessionsRepo.get`. Both
new files contributed nothing while the file reported itself widened, and the scope mutation passed while
the session mutation did not — the asymmetry is what exposed it. Fixing a
narrow-scan-behind-a-broad-claim by writing another list of names reproduces the fault exactly.

Two changes came out of that. The receiver is matched as a family, and — because the family pattern then
swept in `sessionUploadLifetimeBytes.get(rec.id)`, an in-memory upload counter that is not a session
lookup at all — the discriminator is `await`. A repository call is awaited and a Map read is not, which
separates the two structurally instead of by another name list. Rostering those counters would have
papered over a population that was simply wrong.

The real defence is neither regex: each control-key file must contribute at least one lookup, so a file
the scan cannot read fails loudly rather than passing quietly. That arm is what would have caught the
inert widening on its own, and it is proven — renaming the sibling's lookup so the scan finds none reds
it with "contributed no session lookups".

Three mutations, all against sibling files rather than the original: an unminted scope in livekit-token is
flagged, a header-keyed lookup there is flagged, and a file yielding no lookups is flagged. Restores
byte-identical.

No source changed. Both guards now cover the surface their first sentence claims.

### Concurrency

The two outstanding failures are unchanged from the previous batch and still not this work:
`gui-client-views-ProxiesView-content-parity` and `the-gui-does-not-blame-a-shipped-server-for-a-failed-probe`
freeze `ProxiesView.tsx`, rewritten by `4056443ab` without its pins moving. This batch touched two test
files and no source, so `verify-suite` remains red for that reason alone.

## V-1602 — six more mint sites for a credential that no redactor can catch

V-1601 was the seventh instance of a guard whose scan is narrower than its claim, so rather than wait for
an eighth this batch swept for the shape: unit guards making a universal claim in their header while
reading exactly one source file. Fifteen candidates, most of them legitimately single-file — `cors-posture`
is about `bootstrap.ts` by nature, `every-account-scoped-table-declares-its-foreign-key` reads `schema.ts`
because that IS every table.

**`an-unredactable-auth-token-is-never-logged` was the sharp one, and it deserves credit before the
finding.** Its author wrote the limitation down: "SCOPE: this checks the mint sites' own file. A token
copied into another module and logged there is out of reach of a textual scan, and is called out here
rather than left implied." That is the honest practice this log keeps asking for, and it is why the gap
was findable in a minute rather than a morning.

**The gap is not the one the note anticipated.** It guards against a token COPIED elsewhere. What is
actually elsewhere is six more MINT SITES: `status-subscribers.ts` mints five (confirm and unsubscribe
tokens) and `team-members.ts` one (the invite token), all through the same unprefixed
`generateAuthToken`. The header said "5 mint sites in auth-flows", which was true of that file and read as
true of the credential class.

These are the tokens `redact-url.ts` states outright it cannot scrub — bare base64url, nothing to pattern
on — so the whole protection is that the plaintext never reaches a logger. One in a log line is account
takeover for anyone who can read logs.

**Nothing is wrong there, and the reason is the fragile kind.** Neither file makes a single logger call,
so there is nothing for a token to ride out on. That is a fact about today, not a property either file
asserts. One `logger.info({ plaintext })` on the subscriber confirm path and the credential is in the log
stream. The file set is now derived from the mint call rather than named, so a fourth minting service is
covered the day it is written — and the count of minting files that log nothing is asserted at two, so the
day one of them gains a logger is the day this guard starts doing work there rather than a day the shape
of the coverage changes unnoticed.

Proven on both halves: adding `this.logger.info({ plaintext })` to `status-subscribers` flags
`status-subscribers.ts:102` — a file the guard could not see an hour ago — and reds the zero-logger count
too, which is that assertion working rather than a side effect. The same edit in `auth-flows` still flags
`auth-flows.ts:739`, so widening did not cost the original coverage. Restores byte-identical.

### Concurrency

The two outstanding failures are unchanged and still not this work: `ProxiesView.tsx` was rewritten by
`4056443ab` without its content-parity pins moving. This batch touched one test file and no source.

## V-1603 — the endpoint detail page reported no deliveries while the list showed them

Continuing the V-1602 sweep. Two more single-file guards checked and cleared first:
`every-lifecycle-email-is-send-once` scopes itself to the lifecycle service and the four other tick-driven
senders each carry their own claim — `markReminderSent` after the send, deliberately marked even on
failure — so its scope is right. `unimplemented-response-fields-are-disclosed` is genuinely about one
field despite a generic title.

**But that title names a class, and the class had another member.** Sweeping for response fields a handler
assigns a constant while the schema publishes them: `GET /v1/webhooks/{id}` and `PATCH /v1/webhooks/{id}`
both call `publicEndpoint(row)` with no counts argument, so `delivery_counts` fell to the function's
`{ delivered: 0, failed: 0, dlq: 0 }` default. `GET /v1/webhooks` passes real counts. All three publish
the same field from the same schema, so a customer reading the list saw an endpoint's delivery history and
the same endpoint opened on its own reported nothing delivered, nothing failed and nothing in the DLQ.

Unlike the field that guard documents, this one is computable — `deliveryCountsByEndpoint` already exists
and the list route already calls it — so making the contract honest by describing the limitation would
have been the wrong remedy. `getWithCounts` mirrors `listWithCounts` exactly, including the scope gate and
the effective-account redirection, so a team member reading an owner's endpoint gets the owner's counts
rather than an empty map.

**The first version of the test proved nothing, and the mutation is what said so.** It created an endpoint
and compared the list against the detail view — both zero, because a fresh endpoint has no deliveries. With
the fix reverted it still passed. Seeding a delivered row first is what makes the comparison able to fail:
list reads `delivered: 1`, the zero default reads `0`, and reverting either route now reds it.

**Two process faults, both caught by the checks that exist for them.** A Python edit opened the file for
write twice and the second read hit the truncated copy — the `it(` count went 40 → 0 and vitest reported
"no tests" rather than a failure, which is exactly the shape rule 5 names. And the scan that found this
missed its own known case first: it required the field name to END in `count`/`total`, and
`refused_count_this_month` ends in `month`. Demanding the control pass before reading the output is what
turned a silent zero-result sweep into a 27-row one.

Full suite green apart from the two `ProxiesView` content-parity failures, unchanged from three batches
ago and still `4056443ab`'s rewrite outrunning its pins.

## V-1604 — the shape of the V-1603 defect, pinned

The V-1603 sweep is exhausted and the result is worth stating: 27 response fields assigned a constant, one
defect, 26 correct. `override_expires_at: null` is null exactly when `source: 'tier_default'` — a
discriminated shape, not a placeholder — and the agent-session `cookies: null` family always arrives with
`status: 'unavailable'` and a `reason` beside it, which is the disclosure pattern done right.

**The defect had a shape, and the shape has exactly one member.** A response builder with a DEFAULTED
parameter that fills a published field, called without it. Scanning every route file for
`function name(... = {literal})` returns `publicEndpoint` and nothing else, so this guard says it is a
one-member class rather than implying a general rule it does not enforce.

**Why a static guard on top of V-1603's behavioural one.** That integration test asserts the list, the
detail view and the update agree — the right assertion, and it needed a seeded delivery to have any force.
Its first version compared a fresh endpoint's zeros against the default's zeros and passed with the fix
reverted. A call site added tomorrow without counts is caught here whether or not the next person
remembers that a fixture has to be non-zero to mean anything.

The create site keeps the default and is rostered with the reason: an endpoint created microseconds ago
cannot have a delivery, so zero is the measurement rather than a stand-in for one. A second such claim has
to be argued for in that roster.

Both arms proven: dropping the counts argument on `GET /v1/webhooks/{id}` — the V-1603 defect exactly —
is flagged, and making the rostered create site pass counts reds the stale-roster arm. Restored
byte-identical.

Both pins raised by one, for the one file this batch adds.

### Concurrency

Six failures are outstanding and none is this work. A peer has a large change in flight —
`profiles.ts`, `harness-control-protocol.ts`, `fleet-control-registry.ts`, `sdk-typescript` and
`gui-client` all dirty — and the failures track it exactly:
`cross-sdk-profiles-lifecycle-parity`, `schemas-harness-control-protocol-content-parity`,
`sdk-typescript-index-content-parity`, `unknown-request-fields-coverage-invariant`, plus the two
`ProxiesView` pins outstanding since `4056443ab`. Attributed via `git status`; this batch added one test
file and touched no source, and both files it did touch pass.

## V-1605 — the rate-limit budget is sent on every response and declared on none of them

The response-header surface, checked end to end against what the server actually sends. Three claims, two
clean and one gap that is a decision rather than a defect.

**`x-request-id` — declared on 879 responses and honest.** An `onSend` hook sets it, the plugin is
registered at `app.ts:926` (checked, because an imported-but-uncalled registrar is a phantom this session
has already nearly filed once), and a live probe found it on a 200, a 404 and a 401.

**`Retry-After` — refusal-only, correctly.** Absent from every success response, which is what its own
description in `openapi.ts` says.

**The seven policy headers are the gap.** `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset` and
the four `x-ratelimit-*` are emitted on ORDINARY SUCCESS responses — verified against `/v1/webhooks`,
`/v1/admin/accounts` and the public `/v1/egress/echo`, all seven present on each. They are declared on
**429 responses alone**, 226 of them, and on no 2xx anywhere in the document.

So a client is handed its remaining budget on every call and cannot learn from the specification that the
field is there. That is the shape V-1597 fixed for `Retry-After`, pointing the other way: proactive pacing
rather than reactive backoff, and useful on exactly the calls that are succeeding.

**Not declared here, and the distinction from V-1597 is the reason.** That batch aligned thirteen
responses with two hundred and thirteen siblings already declaring the header — an inconsistency inside
the document, with the answer already written next to it. This would add seven headers to all 232 success
responses with no sibling precedent, changing the response typing of every generated SDK. Publishing is a
product commitment; `a-route-in-neither-the-spec-nor-the-docs-is-a-decision` declines the same kind of
call in its own header, and for the same reason. Recording that the decision has not been made is the part
that is mine.

**Emission is not at risk while it waits.** All seven headers are asserted by between eighteen and
twenty-eight test files each, so the behaviour is pinned even though the contract is silent.
⚠️ **That sentence is wrong and V-1617 replaces it** — the count was of files MENTIONING the header
names, most of them content-parity guards matching source text. Three read a header off a response. The
conclusion survives; the evidence did not. That is why
this batch adds a note at the source rather than a new guard: the property is covered, the DOCUMENT is
what is incomplete, and the next reader should not have to re-measure to find that out. The published
`openapi.json` is byte-unchanged — verified by regenerating and diffing, since a comment in the builder
must not move the artefact.

### Concurrency

Seven failures outstanding, none this work: a peer's in-flight profiles and harness-control change
(`cross-sdk-profiles-lifecycle-parity`, `schemas-harness-control-protocol-content-parity`,
`sdk-typescript-index-content-parity`, `unknown-request-fields-coverage-invariant`), the two `ProxiesView`
pins from `4056443ab`, and `a-workspace-declares-what-its-source-imports` reporting hoisted `jsdom`,
`github-slugger` and `@driftstack/api-types` — an install-state condition in workspaces this batch does
not touch. The three openapi pins nearest this change pass.

## V-1606 — three idempotency scopes checked, two sound by construction, one dead and worth keeping dead

Cursors first, and briefly: sixteen operations take one, several pass it to the repo with only a length
bound. V-1590 already pushed hostile values through every query parameter and found no 5xx there, and a
keyset cursor stays account-scoped by the query's own predicate rather than by the cursor, so there is
nothing here. Recorded so the next sweep does not re-open it.

**Idempotency looked worse than it is, and the reason is worth writing down.** `crypto_orders` carries
`uniqueIndex('crypto_orders_idempotency_key_unique').on(idempotencyKey)` — one column, no account — while
its two siblings are explicitly `(accountId, key)`: `agent_sessions_idempotency_key_unique` and
`session_operations_account_idempotency_key`, the latter commented "Account-scoped and partial". An index
on a bare client-chosen key reads as a cross-account collision.

It is not one. The VALUE in that column is already scoped: `createIdempotent` builds
`` `${args.account_id ?? '_anon'}:${args.idempotency_key}` `` and the repo persists exactly that. So the
global index is correct, and the schema comment calling it "the scoped idempotency key" is accurate about
the value even though the index names one column.

**What survives the check is the fallback.** Every caller with a null `account_id` lands in ONE scope
called `_anon`, so two of them choosing the same key collide — and the second is answered with the first's
order as a replay. That is a cross-caller READ, not a duplicate write. Idempotency keys are client-chosen;
a client picking `checkout-1` is not exotic.

**It is unreachable today**, and that was verified rather than assumed: the only `createIdempotent` call
site is `routes/billing-crypto.ts`, behind `requireAuth` + `requireScope('admin:billing')`, passing
`account_id: ctx.account.id`. Every other crypto-order route authenticates too.

So the guard is forward-looking by design. `schema.ts` says the anonymous flow is intended — "Nullable for
pre-signup checkouts (V-666 supports anonymous flow → claim on signup)" — and that is precisely the change
that brings `_anon` to life. This file fails on that change rather than after it, and says in its header
what the next person has to decide.

**A mutation of mine was invalid before it was informative.** The first attempt at proving the caller arm
replaced the FIRST `account_id: ctx.account.id` in the file — line 233 — while the call site is line 259.
The guard did not fire and for a moment read as inert. Targeting the right line flags it. A mutation that
does not touch the code under test proves nothing in either direction, and the tell was that the vacuity
arm still passed.

Both pins raised by one, for the one file this batch adds.

## V-1608 — the guard counted twelve tiers on an eight-tier page, and would have counted anything

`published-tier-caps-match-the-code` reads six docs pages and compares every published cap against
`TIER_CONCURRENT_SESSION_LIMITS` and `PROFILES_PER_TIER`. Four of those pages key their rows by slug, two
by display name, and the two branches were not the same check. A display-name row had to name a known
tier — `if (surface.key === 'name' && !DISPLAY_NAMES.has(label)) continue;`. A slug row had to match
`/^\|\s*`([a-z_]+)`\s*\|(.+)\|\s*$/` and nothing else.

The scan walks the whole file, not the tier table. So the slug branch's real claim was _any row on the
page whose first cell is a backticked lowercase word is a tier_, which is true of the tier table and of
nothing else only by accident. It held for as long as these pages happened to publish one table each.

It stopped holding the moment one of them published two. Documenting the profile-trim `scope` values
(V-1609) added three rows — `` `cookies` ``, `` `history` ``, `` `all` `` — and `api/profiles.md` began
reporting "12 of 8 tiers", with three non-tiers carried into the cap comparison. The completeness check
caught it, which is the check earning its place: an eight-tier page reading as twelve is loud, whereas the
same fault in the other direction is silent, because the comparison walks only the rows it found.

The fix is the symmetry the file already had on one side. `TIER_SLUGS` is derived from the keys of the two
cap constants — the same source the comparison reads — so a row may only enter the tier set if there is a
cap on the other side to read it against, and the slug branch now filters on it. Deriving rather than
listing is this file's own convention: it says so about the display-name mapping, that "a hand-kept
mapping goes stale while every test stays green".

Both directions mutation-proved on the real page. Changing `free`'s published profile cap from 1 to 8
fails with "published cap(s) the server does not enforce"; renaming one tier slug fails twice, with
"api/profiles.md: 7 of 8 tiers" and "free (profiles)" absent. The membership filter narrows what counts as
a tier; it does not narrow what is checked about one.

**The first attempt at that first mutation proved nothing and said it had.** It rewrote `| 1 ` to `| 8 `
on a line reading ``| `free`          |            1 |`` — a substring that is not there — and reported
"mutated: free 1 -> 8" from the values it had computed rather than from the file, which was unchanged. The
guard passed, and a passing guard under a mutation that never landed is indistinguishable from a guard
that does not work. Every mutation here now asserts the file differs before the result is read. This is
the same fault the log keeps recording in the code under test, and it is worth noting that it is just as
easy to build into the instrument doing the testing.

## V-1609 — the trim route has parsed a body for as long as it has had one to parse, and the spec never said so

`POST /v1/profiles/{id}/trim` takes an optional `scope`. `routes/profiles.ts:37` declares
`TrimScopeBodySchema` as a `.strict()` object over `z.enum(['cache','cookies','history','all'])`, line 575
runs it through `safeParse`, and line 577 throws `BadRequestError` on a failure. The body is read, is
validated, and decides which of four quite different things the route does — one of which signs the
profile out everywhere.

The OpenAPI registration declared no `request.body` at all.

The three consumers of that document disagree with the route accordingly. The Python and Go SDKs are
generated from `openapi.json`, so neither has any way to send a scope: every caller of those SDKs gets the
cache-only default and cannot ask for anything else. `api/profiles.md` stated it as a fact — "keeping the
identity state ... No request body" — which was written when it was true and has been wrong since the
field landed. Only the hand-written TypeScript SDK, which does not read the spec, could reach the other
three scopes.

Fixed at the source: the registration now declares the body as `required: false` — the no-body call is
still the documented cache-only clear — over a `.strict()` schema of the same enum, imported as
`TRIM_PROFILE_SCOPES` from the protocol module rather than restated, so the spec cannot drift from the
values the codec accepts. Regenerated and read back rather than assumed: `requestBody present: true,
required: false`, `scope enum: ["cache","cookies","history","all"]`, `additionalProperties: false`.

The docs page carried a second, smaller wrongness on the way past. Its stated refusal reason ended
"before clearing the cache" while `routes/profiles.ts:605` says "before clearing its data" — accurate when
cache was the only thing a trim cleared, and quietly misleading once it was not. The page now describes
the scopes in a table with an example body, and quotes the reason the route actually emits.

Adding that table is what tripped V-1608.

## V-1610 — the document says 201 operations need a token; this asks whether they do

`openapi.json` is generated from the route definitions, which makes it a good second artefact for most
questions and a useless one for this one. The security block is generated from what a route DECLARES, not
from what it enforces: a handler whose auth `preHandler` went missing publishes the same
`security: [{ BearerAuth: [] }]` it always did, and every static check in this repo would keep agreeing
with it. The only artefact that can disagree is the running server, asked without a token.

**Nothing was wrong, and the measurement is the result.** Of 201 bearer-declared operations, 146 refuse an
anonymous caller outright and 27 answer a typed deployment gate before authentication is reached. Not one
served data. The remaining 28 are unrouted under this harness for the reasons V-1587 established.

**The gate-before-auth ordering is recorded rather than filed.** Those 27 answer 503 `feature-unavailable`
to a request carrying no credentials, so an anonymous caller can learn which optional features a
deployment has switched on. That is information the public status page carries anyway and the bodies are
product copy, not secrets — but a later reader finding 27 unauthenticated 503s should not have to
rediscover why, so the spec says it out loud.

**A bound copied instead of measured, and it failed immediately.** The first version bounded the unrouted
set at twelve, taken from the sibling id-sweep. That sweep walks the 106 single-parameter operations; this
one walks all 201 that declare a bearer requirement, so more dependency-gated modules fall inside it. The
real figure is 28. A number restated from a neighbouring file rather than measured for the population at
hand is the exact fault this log keeps recording, and it is a small mercy that it failed on the first run
rather than passing with slack.

**The mutation proof, stated for what it actually shows.** Removing the `requireScope` preHandler from
`admin-usage` reds the guard — but the route then answers 500 rather than serving data, because the
handler reaches for an account context that is no longer there. So this proves the guard notices when a
bearer-declared operation stops refusing anonymous; it does not prove it catches a route that would
happily serve. That is a weaker claim than "catches an auth bypass" and is the one worth writing down.

**Two working-tree facts, both about concurrency rather than code.** The restore step after that mutation
silently did nothing: `$S` was set in an earlier shell and each command runs in a fresh one, so `cp`
received an empty path and the route stayed unauthenticated until the next check caught it. Restores use
absolute paths from here. Separately, a peer's retention commit swept up this batch's spec and figure
edits into `de8155994` via a broad add — correctly, as it happens, but not by this session.

**One red is outstanding and it is not this work.** `EXPECTED_TEST_FILES` reads 3017 where the node
project now collects 3018. That commit added two test files and deleted one, a net of exactly one, so the
pin is theirs to raise; absorbing it here would hide which change moved the number.

Playwright moves 226 → 227 over 39 spec files, in all four pinned places.

## V-1612 — the four trim scopes were written twice, and the published contract read the copy

`TRIM_PROFILE_SCOPES` sat below `TrimProfileRequestSchema` carrying the docstring "the scopes
{@link TrimProfileRequestSchema} accepts", four lines under a `scope: z.enum(['cache', 'cookies',
'history', 'all'])` that was a separate literal. The docstring asserted an equality; nothing enforced it.
`grep -rn TRIM_PROFILE_SCOPES` over the tests returns nothing, and the content-parity guard pinned each
list on its own — which freezes a drift rather than preventing one.

Three things read that constant, and V-1609 made the third of them customer-facing: the route's
`TrimScopeBodySchema` validates the caller's body against it, `lib/openapi.ts` now builds the published
request body from it, and the frame schema used the other list. **So the drift was not symmetric, and
neither direction is a test failure.** A fifth value added to the enum alone is accepted on the wire and
refused at the route as a 400 the document calls valid. Added to the constant alone, it is accepted by the
route, published to the Python and Go SDKs as a supported scope, and then refused by the frame schema on
the way to the node — an error surfacing one layer below the one that promised it.

The enum derives now. `TRIM_PROFILE_SCOPES` moves above the frame, `scope: z.enum(TRIM_PROFILE_SCOPES)`,
and the second list is gone; TypeScript enforces the ordering, so there is no rule to remember. Deriving
removes the question rather than pinning an answer to it, which is the difference between this and what
the parity guard was doing.

**The guard was pinning the copy, and would have passed the regression.** Its regex named the four values
inline, so re-inlining them in the schema — the exact revert this change guards against — still matched.
It pins `z.enum(TRIM_PROFILE_SCOPES)` now, plus the single declaration. Both mutation-proved: re-inlining
the literal fails the first, changing `all` to `everything` fails the second, and the file restores
byte-identical from a snapshot.

Contract-neutral, and checked rather than reasoned: api-types rebuilt, spec re-dumped, prettier run, and
`packages/sdk-python/openapi.json` compares byte-identical to what V-1609 published — `required: false`,
`enum ['cache','cookies','history','all']`, `additionalProperties: false`.

No pin bumped: this adds no test file.

## V-1613 — three strings on the trim route still described the endpoint it used to be

All three are prose the compiler cannot check, all three shipped with the `scope` field, and each one is
wrong in a way a customer or a maintainer reads directly.

**A caller's own value handed back to them as a valid one.** `TrimScopeBodySchema` is `.strict()`, so it
refuses an unknown KEY as well as a bad value — and both failures threw the same sentence, `Invalid scope.
Expected one of: cache, cookies, history, all.` Send `{"scopes":"cookies"}` and the answer named `cookies`
among the values you could have used, while refusing the request and never mentioning the key that was
actually wrong. The two failures now get different sentences: an unrecognised key is answered by naming
the key, a bad value by listing the values. That is the only case where the list is the useful answer.

**A cookie wipe reported as a cache trim.** The per-account single-flight refusal read "another profile
**cache** trim is already in progress" on every scope, so a customer clearing cookies — or clearing
everything — was told a cache trim was underway. Accurate when cache was the only thing a trim did, and
the same class of rot as the refusal reason V-1609 corrected on the docs page two commits earlier. One
word out.

**Two comments claiming a status the code does not return.** `routes/profiles.ts:33` and `:573` both said
a malformed body is "a 422". `BadRequestError` sets `status: 400` (`lib/errors.ts:76`), the route's own
tests assert 400, and the published spec declares `400` and no `422` — so the comments were the only thing
in the repo saying otherwise, and a maintainer reading the schema's docstring would have written the wrong
client.

**The arms that covered this read the status and stopped.** Both malformed-body arms asserted `400` and
`sentTrim.length === 0` and never looked at the message, which is exactly how a sentence describing the
wrong failure survives in a covered branch: the line executes, the assertion passes, and nothing reads
what it said. Both now assert the message, and the mutation restoring the old unconditional string fails
the unknown-key arm with the defect printed verbatim — `expected 'Invalid scope. Expected one of: cache…'
to contain 'scopes'`. The concurrency and bad-value mutations fail their own arms. File restored
byte-identical from a snapshot.

No pin bumped: three arms extended, none added.

## V-1614 — the published trim body and the body the route parses were never compared

`the-document-is-neither-looser-nor-stricter` is the file for this, and it did not cover this operation.
Its three older arms are hand-written for two routes; its fourth is a sweep, and the sweep reads exactly
one thing — whether a body whose schema has required fields is itself marked required. That cannot see a
FIELD present on one side and absent on the other, which is the whole of what V-1609 fixed.

The new arm compares the two directly, in both directions, and derives each side rather than restating it:
the field set of `TrimScopeBodySchema` against the published `properties`, the enum against
`TRIM_PROFILE_SCOPES`, `requestBody.required` against the route accepting a body-less call, and
`additionalProperties: false` against the route refusing an unknown key. Vacuity is asserted first for this
file's own stated reason — two empty key lists compare equal, so an unread schema and an unparsed document
would agree having compared nothing.

Three mutations, each with the file proven changed before the result was read. Deleting `scope` from the
document fails with the published body declaring nothing; adding a `dryRun` field to the route alone fails
naming it; flipping `additionalProperties` to `true` fails on the unknown-key arm. The first two are the
two directions of the same defect — a value the SDKs cannot send, and a value they send that the route
refuses.

**The first draft's diagnostic named the wrong fault.** The vacuity check asserted the route's field list
equalled `['scope']`, so the route-side mutation tripped THAT rather than the comparison, and reported "the
route schema was read and has fields" about a schema that had been read perfectly well. Vacuity now checks
non-emptiness and the comparison carries the message. A guard that fails for the right reason with the
wrong sentence sends the next reader to the wrong file.

**A retraction, and a caution against the fix.** The trim-scope audit reported that the marketing site
contradicts the destructive scopes by promising a profile retains its stored logins and browsing state.
Read in full, both sentences — one on the homepage, one in the glossary — qualify that promise as holding
across runs, which is a claim about persistence between sessions and is unaffected by a customer
explicitly asking the API to erase something. Neither is wrong, and no guard freezes either: the phrase
appears in no `.ts` file in the repo, so the reported five parity guards are not there either. Recorded
because the next reader to notice the same two pages should not "fix" copy that is accurate.

**And an interaction between two of this repo's own instruments, which will recur.** Restoring a mutated
file byte-identically from a snapshot still moves its mtime. `dist-reading-suites-have-fresh-artifacts`
keys on mtime rather than content, so mutation-proving anything under `apps/docs/src` leaves the docs
artifact reading as stale even though the file is character-for-character what it was. It cost a red in the
full run here. Rebuild the app after mutation-proving one of its sources; the check is right and the
restore is right.

No pin bumped: one arm added to an existing file.

## V-1615 — the same defect as V-1612, found by looking for it rather than by tripping over it

V-1612 was found by accident: a docs table tripped a guard, and the constant underneath turned out to be
written twice. That is a bad way to find a class of defect, so the class was swept for directly — every
`export const X = [...] as const` in `apps/server/src`, `packages/api-types/src` and the server tests,
against every inline `z.enum([...])` literal, reporting where a literal's value set equals an exported
constant's. Twelve constants, 185 inline enums, six matches across two constants.

The first is `AVATAR_ALLOWED_CONTENT_TYPES`, and it is V-1609's defect with the sides swapped. The REQUEST
half is exemplary — `AvatarContentTypeSchema = z.enum(AVATAR_ALLOWED_CONTENT_TYPES)`, and
`UploadAvatarRequestSchema.content_type` is that schema. The RESPONSE half, in `lib/openapi.ts`, restated
the three values inline.

**The drift is one-sided and the response half is the half nobody checks.** `routes/account-me.ts:921`
returns `parsed.data.content_type` — the response echoes back exactly what the request schema accepted. So
a fourth allowed type is accepted on upload, written to R2, and returned in a reply the published document
declares cannot contain it. The Python and Go SDKs are generated from that document, so the failure is not
a validation warning; it is every generated client failing to deserialise a legitimate response, at once,
on a change that looked like it only touched the request side.

**And there was already a guard for this, whose scan was narrower than its own first paragraph.**
`avatar-policy-cross-source-invariant` opens by naming what the policy "stays in lockstep across", and
lists two surfaces: the api-types canonical and the dashboard's file-picker `accept` attribute. The
published document is a third, one import away from the constant, and no arm read it. That is the fault
this guard series exists to catch, in the guard series itself — the second time today a check's stated
claim was wider than the files it opened.

`content_type` derives now, the header names three surfaces and the failure mode the third one carries,
and an arm pins it. Contract-neutral, checked rather than reasoned: api-types rebuilt, spec re-dumped, and
`openapi.json` compares byte-identical.

**The arm's negative was written too wide and narrowed before landing.** `not.toMatch(/content_type:
z.enum\(\[/)` over the whole of `openapi.ts` would fail the day an unrelated operation legitimately declares
its own content-type enum — a check broader than its claim, one line below a comment about exactly that.
It is scoped to the avatar block now, and the block's presence is asserted before the negative runs, since
a negative against a block that failed to match is satisfied by nothing.

**A restore direction worth stating, because it silently undid this fix.** The mutation snapshot was taken
BEFORE the fix rather than after, so restoring it reverted the change rather than the mutation, and the
suite went green on the unfixed file. The proof itself was sound — the arm did fail on the inline copy —
but the artifact under test was gone by the time it passed again. A mutation baseline is the fixed file,
not the file you started from; `git diff --quiet` on the mutated path afterwards catches it in one line.
This is the third instrument fault today, after the null mutation and the tier-row parser.

No pin bumped: one arm added to an existing file.

## V-1616 — a sweep with a low yield, and the measurement that made the yield trustworthy

V-1615 was found by sweeping for one shape. Broadening it: every `z.enum([...])` literal and every
inline TypeScript string-literal union across `apps/server/src`, `packages/api-types/src` and
`packages/sdk-typescript/src`, grouped by value set. **Thirty-four value sets are written out in three or
more places, several spanning three packages** — `['manual','ai','pair']` twelve times,
`['active','suspended','deleted']` ten, `['member','admin']` nine.

That number invites a conclusion it does not support, so it was measured rather than acted on: for each
set, is there any test file naming every one of its values? **Thirty-three of thirty-four.** The
duplication is broad and the coverage is real, which is the opposite of what the raw count suggests, and
worth writing down so the next reader does not open thirty-four investigations. The single uncovered set,
`['json','binary']`, is the download `format` parameter, published `optional` and defaulted `'json'` at
the route with the behaviour stated in the operation's own summary. No defect.

**Then the same question asked of the guards, because naming the values is not reading the sites.** V-1615
was a guard that named all three content types and never opened the third file carrying them. Re-run
asking whether each covering guard mentions every file the set appears in: thirty-eight sets have at least
one carrier no covering guard names.

**That list is candidates, not findings, and the first one checked proved it.** A guard can cover a file
by importing its schema and comparing values — no path string anywhere — which is what my own V-1614 arm
does. `['info','warn','error','fatal']` looked worst: five carriers, one covering guard, every carrier
unnamed. The guard turned out to be `config-lib-cross-source-invariant`, about config log levels, matching
on four values it shares by coincidence. But `agent-session-response-schema-parity` DOES pin the
vocabulary — by importing `AgentSessionSchema` and rejecting `severity: 'critical'`. Both of my heuristics
were wrong about this set in opposite directions.

**What survives verification is narrower and real.** `error_event.severity` is closed in exactly one
place, api-types, and written out separately in four more: the harness wire frame
(`harness-control-protocol.ts:1180`), the service schema (`services/agent-sessions.ts:36`), the route's
`PublicAgentSession` interface (`routes/agent-sessions.ts:387`) and the hand-written SDK type
(`sdk-typescript/.../agent-sessions.ts:163`). Nothing compares them. The field travels harness → wire
schema → service → response, so a fifth value added at the front and not the back is accepted off the
wire, stored, and then refused by the schema that serialises it to the customer. The field-for-field arm
beside it compares TOP-LEVEL names only, so it cannot see inside `error_event`.

One arm now compares all five, deriving the reference from api-types rather than restating it: values for
the importable schema, text for the two type declarations and the non-exported wire schema, every
declaration checked rather than the first found, and assignments excluded by requiring a literal
right-hand side. Mutation-proved three ways — a fifth value on the wire, a shortened SDK union, a
reordered service enum.

**Three instrument faults in one batch, all the same family as this morning's.** The first draft of the
arm read `.unwrap()` once on a schema wrapped in `.nullable().optional()`; it now peels until the shape
appears. The second draft was spliced in by cutting between two computed offsets, which **deleted four
existing arms** — caught only because the `it(` count is compared against HEAD after every edit, and a
file with four fewer tests still reports green. And the mutation snapshots were keyed by BASENAME, so
`services/agent-sessions.ts` and `sdk-typescript/.../agent-sessions.ts` shared one file: the restore wrote
the server's schema into the SDK. Snapshot by path, splice by anchor, and count the tests.

No pin bumped: one arm added to an existing file.

**Two further instruments, both retired by verification rather than by acting.** Comparing every published
enum against every source value set turns up overlapping-but-unequal pairs, which is the drift signature —
and also what two unrelated fields look like when they share a vocabulary, so the specificity is poor.
Narrowing to pairs that share a FIELD NAME is better and still coarse, because `status`, `action`, `kind`,
`scope` and `severity` each name several different concepts here.

One candidate survived both filters with a matching name and a matching domain: the published `source` on
crypto-order events is four values on the customer endpoint and five on the admin one, the extra being the
internal sweep variant. It is not a defect. api-types states the split as a decision, records that the
internal value is translated before customer serialization, and the admin schema says in its own comment
that it carries the internal variant. **The translation is real** — `routes/billing-crypto-orders.ts:86`
performs it — and it is guarded: the parity file pins the framing, a cross-source invariant names the
route, and an integration test exercises it.

**So the class is substantially closed, and that is the result.** Both real findings this session —
V-1612 and V-1615 — were the narrower fault: a guard that existed and pinned a COPY of the value list
rather than its source, or read two of the three files carrying it. Neither was absent coverage. A future
sweep for bare duplication will produce the same thirty-four sets and the same low yield; the question
worth asking of a duplicated vocabulary in this repo is not whether a guard exists but whether it opens
every file, and whether what it pins is the source or a restatement of it.

## V-1617 — two claims of my own, one about a mechanism and one about a count, both wrong

V-1605 left the seven rate-limit policy headers declared on 429 responses alone while the server sends
them on ordinary successes, and deliberately did not close that: declaring seven headers across 232
success responses changes the response typing of every generated SDK, which is a decision about what the
API publishes rather than a drift correction. **That deferral stands.** This entry corrects the two
supporting claims it rested on, because both were mine and both were measurements rather than code.

**"An `onSend` path emits all seven."** There is no `onSend` hook in either rate-limit middleware. Two
preHandlers emit these headers and the difference in reach is the whole point:
`app.decorate('rateLimit', …)` (`middleware/rate-limit.ts:313`) is a per-route factory reaching only
routes that name it, while `ipRateLimit` (`middleware/ip-rate-limit.ts:63`) is installed globally at
`lib/app.ts:961` as `app.addHook('onRequest', globalIpGate)` and emits all seven at `:131-139` **before**
its allow/deny branch. That is why every response carries them. The observed behaviour was right; the
named mechanism was invented, and a reader reasoning from "onSend" would look in the wrong file.

The correction also carries a scope the original lacked: the global gate is nullable, and the high-volume
test harnesses pass `globalIpRateLimit: null` to disable it. So "every response carries them" is a
statement about production configuration, not about every app the suite builds.

**"Asserted by between eighteen and twenty-eight test files each."** That was a count of files MENTIONING
the header names. Twenty-four do; twenty-one of those are content-parity and cross-source-invariant guards
matching the names in SOURCE TEXT, which pins the string and not the behaviour. **Three read a header off
an actual response** — `integration/rate-limit-headers.test.ts`, which asserts all seven on a success and
the `x-` set plus `retry-after` on a 429, `integration/auth.test.ts`, and
`e2e/auth-cache-authority.spec.ts`. The conclusion holds: the wire behaviour is pinned. But it is pinned
by three files, and a reader who believed twenty-eight might delete one as redundant.

I have a standing rule to enumerate a set rather than report its size, and V-1605 reported a size. The
size was of the wrong set, and nothing about the number looked wrong.

**And the guard built to catch this class cannot see it.** `every-response-header-is-declared-or-exempt`
opens "every response header the server sends is either declared in the published document or on an
exemption list with a reason" — and checks `declared` as **anywhere in the document**, not on the
responses that carry the header. Those are different properties. The seven policy headers satisfy it via
their 429 declarations while being undeclared on the 232 successes that also carry them, so the gap sits
exactly in the space between the guard's sentence and its scan. Recorded in that file's header rather than
fixed, because tightening the arm to per-status would not find a defect — **it would force the deferred
decision**, and that is not a guard's job to do by accident.

`openapi.json` byte-identical, verified by regenerating and diffing: a comment correction must not move
the artefact.

## V-1618 — the documented API and the flagship SDK disagree about 28 endpoints, and nothing measures it

Three SDKs ship. ⚠️ **The first version of this entry said "Python and Go are generated from
`openapi.json`, so their coverage follows the document by construction". That is wrong, it was committed
in `245ca3239`, and it is corrected here rather than quietly edited.** Only the MODELS are generated:
`packages/sdk-python/scripts/generate.sh` runs `datamodel-codegen` into `_generated/models.py` and says so
in its own header — "Re-generate Pydantic models from the OpenAPI spec" — while `src/driftstack/resources/`
is hand-written. The Go SDK has **no generator at all**: no script, and files carrying hand-authored
comments like "handles /v1/account/email-preferences (V-204)".

**So all three SDKs hand-write their method surface, and none follows the document by construction.** I
asserted a mechanism from the word "generated" without opening the generator — the same fault as V-1617's
`onSend`, in the same session, and this time it reached a commit. Re-measured with that corrected:

    TypeScript  reaches 100/132 customer paths   missing 32
    Python      reaches  70/132                  missing 62
    Go          reaches  71/132                  missing 61
    reachable from NO SDK                        32

TypeScript is the most complete of the three, not the laggard the original framing implied — and the 32 it
misses are missed by all three, so that set is not an SDK-specific omission but the customer surface no
client library reaches at all. The log shows the history plainly — "Live SDK coverage now: account, api-keys, archetypes,
sessions, profiles, usage" is an incremental build-out, not an invariant.

Measured against the published document: 196 paths, 132 customer-facing once staff (`/v1/admin/*`),
internal (`/v1/internal/*`, `/v1/mac-nodes*`), inbound provider webhooks and ops endpoints are excluded.
**Thirty-two of those 132 are never built by the TypeScript SDK, and twenty-eight of the thirty-two are
documented on the customer docs site.** The set, enumerated rather than counted, because a count is what
V-1617 just had to retract:

    /v1/account/cost                          /v1/agent-sessions/{id}/history
    /v1/account/me/billing-portal             /v1/agent-sessions/{id}/page-state
    /v1/account/me/notifications              /v1/agent-sessions/{id}/transcript
    /v1/account/me/oauth-links                /v1/auth/resend-verification
    /v1/account/me/organization               /v1/billing/crypto-orders/{id}/receipt.pdf
    /v1/account/mfa/disable                   /v1/billing/crypto-orders/{id}/receipt.txt
    /v1/agent-sessions/{id}/cookies           /v1/oauth/authorize · introspect · revoke · token
    /v1/agent-sessions/{id}/cookies/set       /v1/status · /incidents · /incidents/{id} · /sla
    /v1/agent-sessions/{id}/downloads         /v1/status/subscribe · /confirm · /unsubscribe
    /v1/agent-sessions/{id}/downloads/content
    /v1/agent-sessions/{id}/files

**They are not one kind of thing, and calling all 28 a defect would be the same overreach as calling 34
duplicated value sets a catastrophe (D-4).** Three tiers:

- **Probably not SDK surface at all.** `/v1/status/*` is the public unauthenticated status page, and
  `/v1/oauth/{authorize,token,revoke,introspect}` are OAuth 2 protocol endpoints a third-party app drives
  by redirect, not methods an account-holder's client calls. Absent by nature rather than by omission.
- **Plausibly deliberate.** The two receipt endpoints return binary/plain-text bodies rather than JSON,
  which the SDK's typed-response shape does not model.
- **Looks like a real gap.** The agent-session feature endpoints — `transcript`, `page-state`, `history`,
  `files`, `downloads`, `cookies` — and the account-management set. `api/agent-sessions.md:453` documents
  `GET /v1/agent-sessions/{id}/transcript`; the TypeScript SDK mentions "transcript" only in prose and as
  a `transcript_length` field on a response. `api/account-notifications.md` is an entire documentation
  page for an endpoint no SDK method reaches.

**Nothing measures any of this.** `sdk-ts-readme-method-coverage` runs README → SDK, catching a documented
method that no longer exists; the reverse — a published customer operation with no method — has no guard
in either direction. So the divergence has grown silently and would continue to.

**Not fixed here, and deliberately.** Writing twenty-eight SDK methods is product work, and the three
tiers need an owner's intent rather than my guess: the right artefact is the shape of
`a-route-in-neither-the-spec-nor-the-docs-is-a-decision` — every absence carrying its reason, so the
twenty-ninth fails instead of joining a silent pile — and that file's own header says why a list of names
without justification is how a real gap hides among deliberate ones. I cannot supply twenty-eight
justifications I do not have. Recorded in `docs/internal/OPEN-ITEMS.md` as owed, with the enumerated set,
for the agent that owns the SDKs.

## V-1619 — three endpoints the docs teach and the published document does not contain

`a-route-in-neither-the-spec-nor-the-docs-is-a-decision` closes the case of a route nobody wrote down. Its
central arm reads: **every route is in the spec, OR in the docs, OR in this list with a reason.** The
disjunction is the gap. A route that is documented satisfies it and is never asked whether it is
_published_ — so docs-presence excuses spec-absence, permanently and silently.

Three endpoints sit in exactly that space. Each is registered, each is taught to customers, none appears
in `openapi.json`, and none is on the adjudication list:

    /v1/whoami                    lib/app.ts:1834          reference/scopes.md:116
    /v1/status/stream             routes/status-stream.ts:65   api/status.md
    /v1/oauth/authorize/complete  routes/oauth.ts:258      api/oauth.md

**What it costs.** The API reference customers read is generated from that document, and so are the Python
models; the hand-written SDKs follow it by habit. So a customer is told in the scopes reference to call
`GET /v1/whoami`, and then finds it in neither the reference nor any client library. `/v1/status/stream`
is server-sent events, which OpenAPI models poorly and is a plausible deliberate omission — but plausible
is not recorded, and the file built to record exactly this kind of decision never sees it.

Not all three are the same. `/v1/whoami` is an ordinary authenticated GET with no reason not to publish;
the other two have arguable reasons that nobody has written down. Which is the point: **the guard cannot
distinguish them because it never asks the question.**

**Three instrument corrections on the way to a three-item answer, all mine, all the same shape.** The first
pass compared documented paths against the spec and reported **48** — because it normalised `{id}` and not
`:id`, so `/v1/profiles/:id` failed to match `/v1/profiles/{id}`. Fixing the normaliser gave 5. Of those,
`/v1/models` is **Anthropic's** endpoint quoted in `api/byok-anthropic.md` ("Calls Anthropic's
authenticated `GET /v1/models?limit=1`") and `/v1/legal/*` is a wildcard in prose. And `/v1/whoami` had
been invisible to an earlier sweep of mine entirely, because that sweep read `apps/server/src/routes` and
this route is registered in `lib/app.ts`.

Forty-eight, then five, then three. Each cut came from widening a boundary I had not stated, which is the
rule in `OPEN-ITEMS.md` M-6, and the reason the first number never reached anyone.

**Related, and checked because it was cheap: the docs do not lie about SDK samples.** Every
`client.<resource>.<method>()` in a fenced code block calls a method that exists in the SDK **of that
block's language** — 148 distinct samples, zero missing. A first pass reported 40 missing by checking Go
and Python samples against the TypeScript SDK's method names.

Not fixed here: the arm to add is "a route in the docs is also in the spec, or carries a reason", and it
would fail immediately on these three, so it needs their three reasons from an owner rather than my guess.
Recorded in `docs/internal/OPEN-ITEMS.md`.

## V-1620 — the scope prose is honest, checked across ninety-four operations

Ninety-five operation summaries in `lib/openapi.ts` state which scopes a caller needs, in prose —
"(requires `write:profiles`, broad `write`, or `account_owner`)". One hundred and sixty-one routes enforce
a scope with `requireScope(...)`. A mismatch is not cosmetic: a customer reads the summary, mints a key
carrying exactly the scope it names, and is refused.

⚠️ **This entry originally said "Nothing compares them". That is FALSE and it was committed.**
`openapi-scope-disclosure-invariant` (A2, 2026-07-31) compares them, and more thoroughly than the arm I
proposed: one CRITICAL arm asserts every customer-facing scope-enforcing route names that scope in its
operation — deriving the expectation from `app.requireScope(...)` in the route source "so the docs can
never define their own truth" — and a second asserts an operation may not name a DIFFERENT granular scope
than the one enforced. `/v1/admin/*` is excluded, with its reason stated.

**How I missed a file named `openapi-scope-disclosure-invariant`**: I ran the prior-art grep, that filename
was in its output, and I did not open it. I have a standing rule that says never dismiss a prior-art hit by
filename — three duplicate audits came from skipping exactly that step — and this is the fourth.

The measurement below still stands on its own, and one refinement survives.

Ninety-four operations are comparable by method and path. **None is disjoint, and none over-promises.**
The prose is accurate everywhere it appears.

**Getting there took correcting my own instrument twice, and the second correction is the useful record.**
The first parser matched no routes at all — the registration shape is
`app.post<{…}>(\n  '/path',\n  { preHandler: [...] },` and my regex demanded the handler immediately
after. The second reported **seventy** operations promising scopes the route does not enforce: summary
`['account_owner', 'write', 'write:profiles']` against a route calling `requireScope('write:profiles')`.

That is not a defect, it is a **hierarchy my instrument did not model**, and it is worth writing down
because the next reader will otherwise re-derive it from `services/auth.ts`:

- exact match;
- V-174 — `admin` satisfies `account_owner`, and never the staff `driftstack_internal_admin`;
- `account_owner` satisfies the BARE `read` / `write` verbs, added because a device-login key minted with
  `scopes:['account_owner']` alone was 403ing every session launch;
- V-481 — broad satisfies granular: `read` or `account_owner` for any `read:X`, `write`/`account_owner`
  for `write:X`, `admin`/`account_owner` for `admin:X`. **Granular never satisfies broad.**

So a summary naming three acceptable scopes against a route naming the one granular minimum is exactly
correct, and the seventy were my reading `requireScope('X')` as "accepts only X". Seventy findings and
zero defects — the same ratio as this session's other instrument faults, and caught the same way, by
looking at the output instead of reporting the count.

**The one refinement the existing guard does not cover, measured: also zero.** Its contradiction arm
matches only GRANULAR scopes — `/`(read|write|admin):(sessions|profiles|webhooks|api-keys|billing|audit)`/`
— so a summary naming a BROAD scope that does not satisfy the enforced one would pass it. Under the real
satisfaction rules that is possible: `admin` does not satisfy `read:sessions`, only `read` and
`account_owner` do. Checking every named scope against a faithful port of `requireScope`: **0 of 94**. So
the residual is preventive against a case that has never occurred, guarded on its other side by the arm
that requires the enforced scope to be named at all.

**W-9 is withdrawn, not deferred.** There is no gap worth an arm here, and proposing one was my
duplicating an existing guard I had already been shown.

## V-1621 — closing the disjunction that let a documented route go unpublished

V-1619 found the hole and could not close it: `a-route-in-neither-the-spec-nor-the-docs-is-a-decision`
accepts **in the spec OR in the docs OR listed with a reason**, so a documented route satisfies the arm and
is never asked whether it is published. Three sit in that space — `GET /v1/whoami`, `GET /v1/status/stream`,
`POST /v1/oauth/authorize/complete` — and closing it needed three justifications I did not have.

**The arm is written without inventing them.** `DOCUMENTED_BUT_UNPUBLISHED` records the three with the
value `REASON OWED (OPEN-ITEMS W-8)` and what is known about each — SSE models poorly in OpenAPI, the OAuth
step is a browser redirect rather than an API call, and `/v1/whoami` is an ordinary authenticated GET with
no evident reason at all. The map's own docstring says it exists to stop a FOURTH appearing silently rather
than to bless these three, because this file's own header is where the rule lives: a list of names with no
justification is how a real gap hides among deliberate ones. Writing the debt into the value is the
difference between a recorded gap and a hidden one.

Both directions are asserted. An unrecorded route in that state fails; a recorded one that has since been
published fails as **stale**, which is the failure mode the sibling arm above already guards for the
undocumented list — an entry that no longer describes reality makes the list look considered while hiding
nothing.

**Vacuity is asserted on the READERS, not on the result**, and that distinction is load-bearing here: this
arm's result being empty is the state it wants once the debt is paid, so an empty result can never be the
signal that something is wrong. Three empty readers would agree with everything, so the arm floors them at
200 registrations, 200 operations and 100 documented endpoints first.

Three mutations, each with the file proven changed before the result was read, each restored byte-identical
from a path-keyed snapshot. Dropping `/v1/whoami` from the map fails naming it. Renaming an entry fails,
because the real route becomes unrecorded. And **publishing `/v1/whoami` in `openapi.ts` flips its entry to
stale** — which is the one that matters, because it proves the spec reader is live rather than the map
merely agreeing with itself.

W-8 moves from OPEN to the arm being in place with its three reasons still owed. The set can no longer grow
in silence, which was the whole of the defect; what remains is a decision, and decisions are not mine to
invent.

## V-1622 — the reverse of the SDK path guard: an operation the document offers and no client can call

`sdk-typescript-server-path-parity` runs SDK → server, and says so: "every `path: '/v1/...'` literal in the
SDK resources must correspond to a server-side route registration", catching a stale SDK path after a
rename. **The reverse has never been checked**, and it is the direction a customer feels — an endpoint the
published document offers that no client library can reach.

Thirty-four published customer operations are in that state. Measured by extracting quoted `/v1/…` path
LITERALS from each SDK's source: TypeScript reaches 100 of 134 customer operations, Python 54, Go 55, and
**none of the thirty-four is reachable from Python or Go either**. It is the customer surface no client
library reaches, not a TypeScript omission.

**Seventeen carry an evidence-backed reason, seventeen say plainly that they do not.** The public status
page is gated by `statusSnapshotGate` / `statusSlaGate` / `subscribeGate` with no `requireAuth` — checked,
not assumed — so no API key is involved and there is no client-library call to make. The OAuth 2 endpoints
use `authorizeGate` / `tokenGate` / `introspectGate` / `revokeGate` rather than account auth: a third-party
app drives them by redirect with its own credentials. The two receipt endpoints return `application/pdf`
and `text/plain`, which the SDK's typed-response shape does not model. `/health` and `/version` are probes.

Everything else — the agent-session feature set (`transcript`, `page-state`, `history`, `files`,
`downloads`, `cookies`), the account-management set, `resend-verification`, `egress/echo`, `fleet/events` —
carries `REASON OWED (W-7)`. Those are decisions and I am not going to invent seventeen of them; the map's
docstring says it exists so a THIRTY-FIFTH cannot appear in silence, not to bless the thirty-four.

Vacuity is asserted on the readers rather than the result, for the same reason as V-1621: this arm's empty
result is the state it wants once the debt is paid, so emptiness can never be the alarm.

Three mutations, restored byte-identical from path-keyed snapshots. Dropping an entry fails naming it;
recording an operation the SDK already reaches fails; and **adding a real `path:` literal to
`sdk-typescript/src/resources/account.ts` flips `/v1/account/cost` to stale**, which is the one that
matters because it proves the SDK reader is live rather than the map agreeing with itself.

**A number was corrected before it landed rather than after.** The comment first said Python 70 and Go 71,
from an earlier measurement that matched paths as substrings anywhere in each SDK — counting paths that
appear only in comments and docstrings. Literal extraction gives 54 and 55. The conclusion did not change;
the figures in a guard someone will trust did.

## V-1623 — hunting vacuous guards, and finding that this repo does not have them

`the-document-is-neither-looser-nor-stricter` says it out loud: "an emptiness assertion is satisfied by a
document that parsed to nothing". Nearly every guard here ends in `expect(offenders).toEqual([])`, and each
one is only worth its assertion if something proved the population was read. So: which files assert
emptiness, read from disk, and never establish that they found anything?

**None. Eight candidates survived to be read, and all eight floor their populations.** The sweep is worth
recording only because the answer is a real property of the codebase rather than a null result: the
"a clean census is not evidence" doctrine is applied here, not merely written down, and twice with the
incident that taught it attached —

- `boolean-env-flags-share-one-truthiness-rule` counts files inside its own walk and refuses a low count,
  because "retargeting the walk at `src/db/migrations` (real directory, no `.ts`) left all four arms GREEN
  while nothing was read. Measured at 340 files."
- `every-sdk-path-id-is-url-escaped` floors each language separately, because its Go extractor matched
  `fmt.Sprintf` while Go concatenates, "found ZERO sites… a perfect score from a scanner that had looked at
  nothing".
- `a-status-that-can-carry-retry-after-declares-it` opens with an arm whose title is the reason: an empty
  left-hand side makes the subset assertion below trivially true.

**The instrument failed five times, each time by being narrower than its own question, and the last one is
the joke that writes itself.** The question was "does this file assert its population is non-empty" and I
kept answering it with one spelling at a time:

    37 candidates  — floor recognised only as `.toBeGreaterThan(`
    10 candidates  — after also counting `.toBe(n)`, `.toHaveLength(n)`, `.toContain(`
     8 candidates  — after allowing `.toBeGreaterThanOrEqual(floor)` with a VARIABLE argument
     0 defects     — after reading all eight: `.not.toEqual([])`, a floor asserted inside the helper
                     rather than in an `it()`, a hardcoded population that would throw if absent, and
                     `toMatch(...)` on the read body, which cannot pass against an empty string

The fifth spelling is the one worth keeping. `every-sdk-path-id-is-url-escaped` was flagged by a detector
looking for guards that fail to floor their populations — and it is the single best example in the
repository of a guard that floors its populations, with the incident narrated in its header. **I hunted
incomplete instruments with an incomplete instrument, and the file my instrument accused was the one that
had already learned the lesson.**

Recorded so the sweep is not re-run: the class is closed, and the shape of the answer is that a floor here
is written in whatever form the file needed — inside a helper, as a `toMatch`, as a `.not.toEqual([])` —
which is precisely why a regex asking one way about it will keep being wrong.

## V-1624 — a guard that stated a false reason for a correct decision, and a roster stale at two

Four rate-limit buckets are enforced; routes name `global` (198 sites), `sessions:create` (2),
`agent_sessions:message` (1) and `agent_sessions:input_event` (1). The admin override schemas accept only
three. That looked like a defect — the override service takes `bucketKey: string` unconstrained and
enforcement reads `Record<string, RateLimitOverride>`, so **only the request schema blocks it** — until the
guard that pins the three-value roster turned out to say why.

**It is a recorded decision and I did not touch it.** `rate-limit-bucket-cross-source-invariant` pins the
three-key admin roster deliberately: `agent_sessions:input_event` has no admin-override path.

**But the reason it gave was false, in both clauses.** The arm said the admin surface accepts "the 3
customer-visible keys" and that `input_event` "stays internal-only". The file it pins says the opposite in
its own comment — `RateLimitBucketSchema` publishes ALL FOUR on `GET /v1/account/rate-limits` "so the
customer view never hides a limit that's actually applied" — and the generated spec carries all four to
customers. The decision is right; the justification describes a system that does not exist. **A reader
trusting it would delete `input_event` from the CUSTOMER surface to restore a consistency that never
existed**, hiding an enforced limit from the people it is enforced against. The correct sentence is the one
the subject file already uses: three OVERRIDE-ABLE keys.

The false wording has propagated once already — `docs/internal/2026-05-31-autopilot-run-handoff.md:663`
repeats "correctly EXCLUDES the internal-only `agent_sessions:input_event` (W869)". That file is a dated
handoff and is left as the historical record it is.

**And the header was stale at two.** It opened "RateLimitBucket 2-key cross-source invariant… pins the
V-219 token-bucket key 2-roster" and listed two, while `BUCKET_KEYS` below it and every arm already pinned
four. That is the third instance of this exact drift: `api-types/common.ts` records that the count "was
stale at two for the whole life of the two agent buckets, and the per-tier table in the customer docs was
missing `agent_sessions:input_event` for the same span (V-1091)". It went stale a third time in the guard
written to stop it.

So the header now names all four, and **an arm pins it against the roster** — the header must name every
member of `BUCKET_KEYS` and state the size. Adding a fifth bucket fails it; claiming the wrong size fails
it.

**Two of my own faults, both caught by running rather than by reading.** The first correction embedded
double quotes inside a double-quoted `it(` title and the file stopped parsing — and the `it(` count was 13
before and after, so **the count check passed on a file that would not load**. That check is necessary and
not sufficient; only running it caught this.

The second is better. The new arm's per-bucket check scanned the whole header, and the header's own V-1624
note mentions `agent_sessions:input_event` while describing the V-1091 incident — so dropping the bucket
from the numbered roster still passed. **The mutation found it; reasoning had not.** It is scoped to the
numbered roster lines now, and the third mutation — growing `BUCKET_KEYS` to five — proves the arm tracks
the roster rather than a literal.

**Bounded afterwards: no other guard needs this arm.** Sweeping every guard with a numbered roster in its
header against the `as const` roster it enforces returned six mismatches and **all six were my counter, not
the guards.** `webhook-event-type` says "9-value roster" and lists nine across seven numbered lines because
one line reads "6–7. crypto.order.paid / crypto.order.failed"; `api-key-scope` says "19-value (6 broad + 13
granular)" and has a separate `GRANULAR_SCOPES`; `prefixed-id-roster` has eight entries and I counted the
twenty-four quoted strings inside them; two more have prose headers with no roster claim at all. These
headers are carefully maintained, use range notation, and split their rosters across several constants —
none of which a line-counter reads. **W869's header was a one-off, not an instance of a class**, so the arm
is pinned where it belongs and nowhere else.

## V-1625 — the status-comment class is closed, proven by making the detector find a known defect first

V-1613 found two comments claiming a malformed trim body is "a 422" while `BadRequestError` returns 400,
with the route's own tests and the published spec both saying 400. That is a class, not an instance: a
comment naming a status the adjacent code does not return sends the next maintainer to write the wrong
client.

Swept `apps/server/src` for it. **The first pass reported 44 and every one I read was the heuristic, not a
defect** — a comment may legitimately name a status it is contrasting AGAINST, and "nearest throw within
twelve lines" cannot tell that apart: "no valid key — reject, don't 500" beside an `UnauthorizedError`,
"reporting it as 429 would hand the caller a…" beside a `ForbiddenError`, and several narrating a
historical 500 that a fix removed. Sixth proximity heuristic today to produce a list of its own making.

Tightened to ASSERTIVE phrasing only — `is a NNN`, `answers NNN`, `returns NNN`, `surfaces as NNN` — with
the throw within four lines. **Zero.**

**A zero from an unvalidated detector is worth nothing, so the detector was made to find a known positive
first.** Run against `profiles.ts` as it stood at `b7b8cfec2~1`, before V-1613 landed, it reports exactly
one hit: line 573, "A malformed body is a 422 rather than a silent fallback", against a `BadRequestError`
that returns 400. That is the defect V-1613 fixed, recovered by the instrument from history. The zero on
the current tree is therefore a measurement rather than a silence.

**Boundary, stated because it is narrower than "the class is closed" sounds.** The detector sees an
assertive status claim with a `throw new …Error` within four lines, in `apps/server/src`. It does not see
the OTHER half of V-1613 — the docstring at `profiles.ts:33` said "a typo'd key is a 422" with no throw
near it, and would not be caught by this. It does not see statuses set by `reply.code(...)`, nor claims in
docs pages or tests. So: no comment in the server source assertively contradicts an adjacent throw, and
that is all this says.

## V-1626 — thirty-nine named components the document declares and no operation points at

`openapi-spec-validity-invariant` guards the published spec against a **dangling** `$ref` — a reference to
a component that was removed. Measured: zero, so that direction holds. **The reverse was never checked**,
and it is occupied: **39 of the 81 declared component schemas are referenced by no `$ref` at all**,
including `Account`, `AgentSession`, `ApiKey` and `CreateSessionRequest`.

**The cause is two patterns in `lib/openapi.ts` that look equivalent and are not.**

    Schema.openapi('Name')   + routes use the TAGGED object   -> 41 registered, 41 referenced
    r.register('Name', Schema) + routes use the BARE schema   -> 40 registered, 39 orphaned

`r.register` creates the component. It does not tag the schema, so a route handing the generator the bare
`AgentSessionSchema` still emits an inline object — and `GET /v1/agent-sessions/{id}` returns exactly that:
an inline nineteen-property shape, no `$ref`. The split is almost perfectly clean, which is what makes it a
mechanism rather than an accident.

**A guard already claimed the benefit that does not follow.** `agent-session-response-schema-parity` has an
arm titled "OpenAPI registers AgentSession as a named component (Pydantic/Go/TS codegen gets a named type,
not an inline anonymous shape)" — and it asserts only that `r.register('AgentSession', AgentSessionSchema)`
appears in the source. Registration is real; the parenthesis is false, and it is false in the direction
that stops anyone looking. A customer generating a client from this document gets an anonymous model for
all thirty-nine.

The title now states what the assertion actually establishes and names the measurement. **The fix is not
mine to take**: making those thirty-nine referenced changes the published contract — every affected
response becomes a `$ref` where it is currently an inline object, which is better for codegen and is still
a change to the artifact customers generate from. Recorded as `OPEN-ITEMS` W-10.

**Boundary.** This counts `$ref` occurrences in `packages/sdk-python/openapi.json` against the components it
declares. It does not measure whether any particular generator inlines or names an unreferenced component —
`datamodel-codegen` emits a model per component regardless, which is why the hand-written Python resources
are unaffected. The claim is about the document and about a client generated from it, not about our own
three SDKs.

**Sharpened afterwards: none of the thirty-nine is dead, so the fix is uniform.** Asking which orphans
have a matching `*Schema` handed to a route split them 32 inlined / 7 apparently unused — and **all seven
were my naming assumption, not the code.** Six are used nested (`data: z.array(ApiKeySchema)`,
`intents: z.array(AgentIntentSchema)`), which my `schema: XSchema` pattern could not see; the seventh,
`AdminAccount`, is registered as `AdminAccountResponseSchema` — itself an alias of `AccountSchema` — and
appears in two route responses. So the component-to-schema name mapping is not `X` → `XSchema`, and every
one of the thirty-nine corresponds to a schema the routes actually use.

That matters for W-10 because it removes a whole branch: there is nothing to DELETE, only shapes to tag.
The fix is one pattern applied thirty-nine times — `Schema.openapi('Name')` with the route handed the
tagged object — and its blast radius is exactly the operations that currently inline those shapes.

## V-1627 — sixteen commits verified, and the "hang" is one file, named by killing its worker

**Full `npx vitest run` on a quiescent tree: 3085 files passed, 115 skipped (3201), 31,060 tests passed,
815 skipped, zero failures.** That is every commit from V-1617 through V-1626 verified together, including
the four guard arms added this session and the two `openapi.ts` edits.

Getting a trustworthy number took three attempts, and the failures are worth more than the green.

**Attempt one was binned rather than reported.** A2 rebuilt `marketing-site/dist/` and wrote five source
files 20–28 seconds after my run started. Forty-eight test files execute pages out of that dist, so the
result would have described a tree that never existed in one state. **A caveated green is the shape that
gets quoted later without the caveat**, so it went in the bin. Their generalisation is the durable one: a
launch guard that checks for other _processes_ does not protect the tree from a _writer_, and a build takes
exclusive use of the tree just as completely as a second suite does.

**Attempt two reproduced the stall with nothing else running**, which is what made it diagnosable: one
worker at 99.4% CPU with RSS flat to the byte, for 26 minutes 52 seconds, while the log sat unchanged.

**Then killing ONLY that worker — leaving the parent alive — printed the summary within twelve seconds,
and the arithmetic named the shape of the problem.** 3085 passed + 115 skipped + 1 errored = 3201. **The
entire suite had finished except a single file.** So it is not a pool worker idling with nothing to
schedule, and not a teardown artifact: the parent was waiting on one real unit of work that never
returned. And it is intermittent — the same invocation completed in 176 seconds earlier the same hour, so
whichever file it is does not hang every time.

⚠️ **Boundary, because the count is not the name.** The error line reads `Worker exited unexpectedly` with
no filename, and the default reporter never prints a passing file — so this establishes that exactly one
file was outstanding, not which. The cheap next step is `--reporter=verbose`, where the straggler is the
one that never appears, diffed against `vitest list`. That is one run rather than another hypothesis, and
it belongs to whoever next needs a gate anyway.

**A correction to my own framing.** I used "flat RSS + long elapsed = stall" to tell A2 their run was
broken. The symptom reading was right and the scope was not: in both of our cases the suite had
essentially finished, and a stalled worker is not a stalled suite — which is the title M-7 already carries.

⚠️ **A boundary on that green, added after publishing it, because the number was already quoted.** The run
skipped **115 of 3201 files and 815 of 31,881 tests**, and those are not arbitrary: the dominant gate in
this repo is `skipIf(!process.env.CI && !process.env.DATABASE_URL)` — 131 files carry it, 4 more carry the
Redis equivalent, and **all 135 live under `apps/server/tests/integration`**. Neither `CI` nor
`DATABASE_URL` is set in this shell, so those suites did not execute. **The green covers the 3085 files
that ran; it says nothing about the Postgres- and Redis-backed integration surface.**

That is immaterial to what these sixteen commits touched — guards under `tests/unit`, `lib/openapi.ts`
comments and two schema derivations, none of which reach a repo or a query — but "3085 passed" reads as
"everything passed" and it should not.

**The 135 and the 115 do not reconcile and I am not going to invent the difference.** Twenty gated files
are not in the skipped count, which most likely means those files also contain ungated describes that ran,
but the reporter names neither the skipped nor the passing files, so that is a hypothesis rather than a
measurement. What is measured: 115 files skipped, 135 files carrying a DB or Redis gate, all of the latter
under `tests/integration`.

## V-1628 — the integration surface does run, in CI, and the team-RBAC path is sound

**Completing V-1627's boundary before it is misread.** That entry recorded that my local green skipped 115
files because `skipIf(!process.env.CI && !process.env.DATABASE_URL)` gates 135 integration suites and
neither variable is set in this shell. Read alone, that invites the conclusion those suites never run.
**They do.** `.github/workflows/ci.yml` `build-test` sets both `DATABASE_URL` and `REDIS_URL` (lines 47-48)
against real Postgres and Redis services, runs `npm run db:migrate -w apps/server` first, and then executes
`node scripts/verify-suite.mjs --all`. The gate skips only when NEITHER variable is present, so in CI they
execute rather than skip. The local hole is a local hole.

**And the two populations are documented, including what neither covers.** `EXPECTED_TEST_FILES` (3027) is
the node project alone; `EXPECTED_TEST_FILES_ALL` is the root config across both vitest projects, which is
what a bare `npx vitest run` collects and what my green measured. `verify-suite.mjs` also names what it
does NOT run — "`--all` is ONE CI JOB, not CI" — including 32 Rust tests under
`apps/gui-client/src-tauri` that no vitest project collects, with the local command to run them. That is
the same class as V-1627's boundary, already written down by someone else, and worth not re-deriving.

**A route audited end to end rather than swept, and it holds.** Team RBAC: writes gate on
`account_owner` and reads on `read`; `DELETE /v1/team/members/:id` passes `ownerAccountId` from the
authenticated context; the repo's predicate is
`and(eq(teamMembers.id, membershipId), eq(teamMembers.ownerAccountId, ownerAccountId))`, so a team owner
cannot reach another team's membership by id. The interface also carries an atomic
`removeMemberWithInvites`, added as a TOCTOU fix so an accept-in-flight cannot slip between the membership
delete and the invite delete — **and the service's `removeMember` calls that variant**, so the fix is on
the path the route takes rather than beside it. The shape worth checking was "the fix exists but the route
bypasses it"; it does not.

**Boundary.** This is the removal path only — gate, ownership predicate, and which repo method the service
selects. It is not an audit of invite acceptance, role changes, or the auth-cache invalidation that follows
a removal.

## V-1629 — the chain survives a throwing tick; nothing checked that it starts

`every-job-chain-rearms-on-a-throwing-tick` proves a recurring sweep re-arms on the path where its work
threw. It cannot see a chain that never ran. A job type whose handler is registered but whose first run is
never enqueued has **no pending row**, so the poller never calls it, nothing throws, and the sweep simply
does not happen.

That is the failure `tick-services-are-wired-invariant` exists for — its own header records the case: "the
fourteenth is complete, has DB columns, has an email template, has its own tests, and is wired nowhere, so
it has never run in production and nothing said so". But that file scans for `tickOnce(...)` services, and
these chains use `scheduledJobs.register(...)` with a separate seed `enqueue`. **Different shape, same
failure, no coverage** — `oauth-retention-production-wiring` hand-asserts one job's wiring, and nothing
derives the set.

Measured before writing anything: **13 job types registered, 13 seeded, and the diff is empty on both
sides** — checked as sets rather than counts, with every `enqueueNext…` helper resolved to the `jobType` it
actually enqueues rather than trusting its name. So there is nothing to fix today; the arm exists so the
fourteenth cannot arrive unseeded.

Both directions assert. A registered type nothing seeds fails; a seeded type nothing registers fails too —
that second one is a row the poller picks up and drops. Vacuity floors sit on both readers, because an
empty difference is this arm's healthy state and can never itself be the alarm.

Two mutations, both against the **real subject** rather than the guard's own list, each restored
byte-identical: deleting bootstrap's `await enqueueNextCryptoOrderExpirySweep(...)` fails naming the
orphaned type, and registering a new `MUTATION_PROBE_JOB_TYPE` in a service with no seed fails naming it.

**Boundary.** This derives registrations from `services/*.ts` and seeds from the `enqueueNext…` helpers
`bootstrap.ts` awaits. A registration made anywhere else, or a seed enqueued inline without a helper, is
outside what it reads.

## V-1630 — W-11: 20,733 latent suite-killers, and the proof that removing them changed nothing

A2 named the file that had been eating a worker for 27 minutes:
`gui-client-components-SettingsAccountCard-content-parity`. The mechanism is `\s*\n?\s*` — and since
`\n` is itself `\s`, that is **exactly `\s*`**, written in a form that lets any whitespace run be split
across three parts in many ways. A match that SUCCEEDS finds a path immediately; a match that FAILS must
try every decomposition, and the cost is exponential in the number of chained groups.

**Reproduced independently, and my first attempt failed to reproduce it** — my literals did not match, so
the engine rejected at the first token and never entered the ambiguous region. With literals that match
deeply and failure at the end:

    groups      \s*\n?\s*        \s*
      4            0.4ms         0.0ms
      6           33.3ms         0.0ms
      8         2630.4ms         0.1ms
     10       221154.4ms         0.3ms      <- 3.7 minutes

**~80× per two groups.** Real assertions chain fifteen and more. That is 100% CPU with RSS flat to the
byte, because a backtracking regex allocates nothing — which is why every memory-based signal either of us
tried was blind to it.

**And the guard was pinning the bug.** It asserted the nested `{ account: { … } }` shape that never existed
on the wire and that took the Settings tab down. It passed for exactly as long as the defect was present;
when the source was corrected the pattern stopped matching, and instead of reporting the drift **it hung**.
Silent while wrong, fatal when right.

**The class: 799 files, 20,733 occurrences**, overwhelmingly content-parity guards. Every one is a latent
suite-killer that triggers the moment its pinned content legitimately changes — precisely when it is most
needed. Swept in one commit.

**Verification, in five layers, because a rewritten guard that matches nothing goes GREEN.**

1. **Identity, analytically.** `/^\s*\n?\s*$/` and `/^\s*$/` differ on no input constructible. An
   identity substitution cannot broaden a guard, which is the risk that mattered.
2. **Clerical, exhaustively.** `HEAD + substitution == working tree` byte-for-byte for all 799 — every
   file reconstructed from `git show`, not sampled.
3. **Post-format, semantically.** Prettier reflows, so re-verified: normalising whitespace AND trailing
   commas, all 799 match again. The commas are real and benign — a shorter regex fits on one line, so the
   trailing comma a multi-line argument needed is dropped.
4. **Behaviourally, on real content.** 500 unique rewritten literals × 154 source files = **77,000
   (pattern, text) comparisons, zero disagreements** between old and new. This is what closes the
   `.not.toMatch` case: 1,359 such assertions live in 424 of the rewritten files, and a broken pattern
   passes them vacuously — but `A.test(x) === B.test(x)` covers both polarities at once.
5. **The suite.** Zero failures attributable to the sweep, reproduced on a verified-quiescent tree.

⚠️ **Three of my own verification passes were wrong before one was right.** A `git diff -U0` pairing
reported 6,906 lines "differing in some other way" — it zipped deletions against additions across
misaligned hunks. A regex-literal extractor flagged 67 files — it was matching the text BETWEEN two
literals as though it were one. And the equivalence harness first reported nothing at all, because I
redirected stdout into the same file `json.dump` was writing. Each would have read as a finding.

**The suite is also 8× faster: 1965s → 250s.** One file was eating twenty-seven minutes of every run.

## V-1631 — the W-11 sweep missed three sites, and my verification could not have seen it

`a2db88985` replaced 20,733 occurrences. **Three survived**, all in
`recipe-library-mock-content-parity` — a file the sweep did touch, taking it from 45 occurrences to 3.

**The cause is overlap.** The original contained `\s*\n?\s*\n?\s*`. A string replace scans
left-to-right for NON-overlapping matches: the first `\s*\n?\s*` is consumed and rewritten to `\s*`,
which then abuts the leftover `\n?\s*` and **reassembles into a fresh occurrence the same pass has
already moved past.** One further pass reaches a fixed point; the sweep now runs to one.

⛔ **The part worth keeping is that my five-layer verification was structurally incapable of catching
this.** Layer 2 asserted `HEAD + substitution == working tree` — applying _the same single-pass
substitution_ to the original and comparing. A transformation compared against itself agrees with itself
whether or not it is complete. Every other layer inherited the same blind spot: the behavioural check
tested the literals that HAD been rewritten, the suite passed because the residual patterns still matched,
and tsc has no opinion. **Five independent-looking layers, one shared assumption.**

**The check that would have caught it is a POST-CONDITION, not a comparison: "no occurrences remain."**
One line, no reference to how the change was made, and it is now what the sweep asserts — currently zero
repo-wide.

That generalises past this sweep. A verification built from the same procedure as the edit can only
confirm the procedure ran, never that it finished. **Ask what must be TRUE afterwards, not whether the
output matches what the transformation produced.**

Fixed, prettier-formatted, tsc clean, and the affected guard passes 9/9 — which also confirms its
rewritten patterns still match the source they pin, since a `toMatch` against a pattern that matched
nothing would fail rather than pass.

## V-1632 — my typecheck layer was vacuous, and only 2 of 14 workspaces typecheck their tests at all

⚠️ **Correcting V-1630 before it is relied on.** Its layer 3 was "`tsc --noEmit` clean". I ran
`tsc -p apps/server/tsconfig.json`, and that config is `include: ['src/**/*']`, `exclude: [… 'tests']`.
**It typechecked none of the 799 files I rewrote.** The layer was not weak, it was empty, and I reported
it as evidence. A2 caught it and was careful to say they were not assuming the bad case; it was the bad
case.

**Re-run against the config that does cover them — `apps/server/tsconfig.test.json`, whose include reaches
`tests/**/\*` — it passes clean, and it covers 742 of the 799.\*\* The conclusion of V-1630 stands; that
particular evidence for it did not. The remaining 57 live in other workspaces, and they are covered by the
layers that were real: byte-exact substitution, behavioural equivalence over 77,000 comparisons, and a
green suite — which also proves they PARSE, since vitest's transform fails a mangled file outright rather
than skipping it.

**And the gap generalises well past my sweep.** Every `apps/*` and `packages/*` tsconfig, read for whether
any `include` reaches tests:

    apps/server              YES  (tsconfig.test.json)
    packages/sdk-typescript  YES
    the other twelve         no

**Twelve of fourteen workspaces have no tsconfig that typechecks their own test files.** A2 found this the
expensive way: a hand-written `ProxyTestResult` fixture omitted `can_route`, and since
`isProxyUsable = reachable && auth_ok && can_route`, their "healthy proxy" fixture was silently exercising
the UNHEALTHY path. Two arms failed and that is the only reason it surfaced — the compiler was never
looking. That is the recorded trap _a fabricated input shape tests the parser, not the path_, in the one
place where the tool that would normally prevent it is absent.

⚠️ **Boundary, because "unchecked" is stronger than what I measured.** `tsconfig.eslint.json` DOES include
`apps/**/tests/**/*.ts(x)` and `packages/**/tests/**/*.ts`, so tests are visible to type-aware linting.
What no configuration does in twelve workspaces is run `tsc --noEmit` over them, which is what reports a
missing required property in an object literal. The repo-level `typecheck` script is
`npm run typecheck --workspaces --if-present`, so it inherits whatever each workspace defines.

Not fixed here: adding a `tsconfig.test.json` per workspace would surface a backlog across roughly 250
previously-unchecked files in gui-client alone, which is its own item with its own gate rather than a
rider on anything. Recorded for whoever takes it.

## V-1633 — the sweep removed 20,733 sites and nothing stopped the 20,734th

V-1630 swept the ambiguous-whitespace construct out of 799 guards; V-1631 fixed the three the first pass
missed. **Neither made the result durable.** Nothing in the repo prevented the construct returning, and the
cost of one returning is a worker pinned at 100% CPU for 27 minutes while every other file finishes.

The guard is a **post-condition**: no test file may contain a redundant ambiguous-whitespace construct.
That framing is the lesson of V-1631 applied deliberately — it references nothing about how any change was
made, so unlike `HEAD + substitution == tree` it cannot agree with an incomplete pass.

**It found a real site on its first run, which the sweep never targeted.**
`docs-api-byok-anthropic-content-parity` carried `\s*\s*` — the same redundancy in a different spelling,
untouched by a sweep keyed to `\s*\n?\s*`. That is A2's D-7 hazard from the other side: I had swept a
_token_ when the defect is a _shape_, and the shape has more than one spelling. The guard now covers three:
the swept form, the doubled form, and `(\s|\n)*`.

**Two design choices worth recording, both forced by the guard flagging itself.**

Its patterns are **assembled from fragments** (`WS + '\n?' + WS`) rather than written out, so the file does
not contain the constructs it forbids. The alternative was a name-keyed self-exemption, which is worse for
the reason this repo keeps rediscovering: an exemption keyed by filename keeps passing on the day someone
adds a real one to that file.

And it strips comments before scanning, because the header quotes the forbidden pattern while explaining
it. A construct written in prose is inert; a scanner that cannot tell prose from code either flags itself
or needs the exemption I had just rejected.

Mutation-proved against the **real subject** rather than the detector's own list: reintroducing either form
into `api-types-common-content-parity` fails the guard, and the victim restores byte-identical.

⚠️ **Getting here took five failed edits, and the pattern in them is worth more than the guard.** Three
python patches asserted against text prettier had already reformatted and aborted without writing — twice
leaving the file referencing a constant the aborted half was supposed to define. I was patching a file I
had stopped reading. **The fix was to read the current bytes and make one edit against what is actually
there**, which is the same discipline as verifying a claim against source rather than against the last
thing I believed about it.

The ratchets move to 3029/3204. That count includes a peer's uncommitted +1 for their own new test file,
which this commit necessarily carries because the two bumps live in one line each; recorded here rather
than left to be discovered in the blame.

## V-1634 — the shape had three more spellings, and my guard hand-rolled what another guard forbids

V-1633 covered three spellings of the ambiguous-whitespace construct. Sweeping for the SHAPE — any two
adjacent quantified atoms ranging over overlapping characters — found **three more, across 13 sites**:
`\s*[\s\S]*?` (10), `\s*\s+` (2), `\s*[\s\S]+?` (1).

**Measured before touching them, because "looks ambiguous" is not "is slow".** Literals matching deeply,
failure at the end, ten chained groups:

    \s* \n? \s*      484,949ms
    \s* [\s\S]*?      81,471ms
    \s*                    0.3ms

So the lazy form is six times cheaper than the known-bad one and still **eighty-one seconds** where the
plain form is a third of a millisecond. Not a theoretical hazard.

**Identity proven before replacing**, 183 cases each against real source: `\s*[\s\S]*?` ≡ `[\s\S]*?`,
`\s*[\s\S]+?` ≡ `[\s\S]+?`, `\s*\s+` ≡ `\s+`. Zero disagreements. Applied to a fixed point with the
post-condition asserted afterwards — zero remain — which is the V-1631 lesson rather than a comparison
against my own transformation.

⭐ **And the guard I wrote to forbid one hand-rolled shape was itself hand-rolling another.** A2 reported
that `no-guard-strips-comments-by-hand` was failing on my new file: I had written my own
`.replace(/\/\*[\s\S]*?\*\//g, '')` comment stripper. `tests/unit/_helpers/code-only.ts` exists for
exactly that job, and its header records that the block-first spelling — **the one I wrote** — silently ate
all 61 imports of a file, leaving three guards scanning an empty string and reporting nothing wrong.

So the correct reading is not that I was careless. It is that **two guards written in one sitting will
reproduce each other's mistake**, and the reason `no-guard-strips-comments-by-hand` earns its keep is that
it caught the author of a sibling guard on the first run — the same way my own guard caught `\s*\s*` on
its first run. Now imports the canonical helper.

Mutation-proved against real subjects, each restored byte-identical: reintroducing any of the six spellings
fails the guard. Two of those proofs initially reported PASS because my shell quoting appended `\\s+`
rather than `\s+`; the guard was right and the harness was wrong, which is why the mutation writes the
bytes directly now and asserts the token is present as written before reading the result.

## V-1635 — I asked my own three placeholders for their reasons; two did not have one

W-8 left a map of three routes the docs teach and the published document omits, each valued
`REASON OWED` — a marker meaning nobody had supplied a justification. This entry supplies them.

**One was a decision, and its reason was already written down** — just not where the guard looked.
`POST /v1/oauth/authorize/complete` is described in `src/lib/openapi.ts` as "dashboard-internal … requires
an interactive web session and rejects API keys", and in `routes/oauth.ts` as "omitted (already
requireAuth-gated)". Its four siblings — `/oauth/authorize`, `/token`, `/introspect`, `/revoke` — are all
published. Publishing this one would advertise an operation no API key can call.

⭐ **The other two placeholders were wrong, in the specific way a plausible guess is wrong.**

`GET /v1/status/stream` carried "server-sent events, which OpenAPI models poorly". That reads like a
reason. **The document refutes it:** it publishes three `text/event-stream` operations already
(`/account/me/notifications`, `/agent-sessions/{id}/transcript`, `POST /agent-sessions/{id}/message`). Nor
is anonymity the discriminator — `/v1/status/sla` and `/v1/status/incidents` live in the same file, share
the same public unauthenticated posture, and are both published. No reason survives; it is a gap.

`GET /v1/whoami` carried "an ordinary authenticated GET, no evident reason". The mechanism turns out to be
mechanical rather than chosen: `app.ts` registers it inline as a "quick smoke test for auth" **with no
`schema:`**, and the published document is generated from declared schemas. Absence of a schema is the
whole cause. Meanwhile `reference/scopes.md` teaches it to customers under "Checking what your key actually
has", with a documented response body — so a reader is told to call an operation absent from the reference
and from all three SDKs.

⛔ **The lesson is about the placeholder, not the routes.** `REASON OWED` was written as bookkeeping, on
the assumption the reasons existed and were merely unrecorded. Two of three did not exist, and the guesses
I would have written instead — SSE is awkward, it's just a smoke-test route — are exactly the plausible
sentences that would have closed the item and hidden the gap. An exemption list is only as honest as its
weakest value, and the way to find out which value is weak is to try to refute it against the artifact.

Both gaps are now labelled GAP rather than blessed, and left open deliberately: publishing either **adds to
the customer contract**, and adding a response schema to a live route changes fastify's serialization. That
is the owner's call and needs a test run behind it, not a drive-by edit. The header comment was rewritten in
the same edit — correcting the entries had left it describing a marker no entry still carried.

Full suite green afterwards: 3090 passed | 115 skipped (3205 files), 31102 tests.

## V-1636 — the 31 fixtures: six causes, no silent mis-test, and one production cast that lies

W-12 left 257 type errors across 76 previously-unchecked gui test files, of which ~31 were "a fixture
missing a required property" — the class that produced the `can_route` find, where a hand-written
`ProxyTestResult` omitted a field `isProxyUsable` reads and the "healthy proxy" case silently exercised the
UNHEALTHY path. A2 flagged those 31 as the highest-value slice on the hypothesis that some fraction were
tests exercising the opposite path while reporting green. This is that scoping.

**First, 31 errors are SIX root causes**, which the raw count hides: `icon`×11, `currentVersion`×8,
`LiveKitInfo`×6, `owner_email`/`owner_name`×3, `adopt`/`adopting`×2, `nextCursor`×1.

⭐ **The hypothesis does not survive. None of the 31 is a `can_route`.** The discriminator is whether the
missing field is READ by the code under test, and it decides all six:

- `adopting` gates a divider behind `restoredHistoryCount > 0`; both mocks set that to `0`, so the
  conjunct is already false and `!chat.adopting` decides nothing.
- `icon` — `ProfilesTable` declares `icon?` and guards `r.icon ?`. Here the TYPE is wrong, not the fixture:
  `ProfileMeta` requires what its only consumer treats as optional.
- `owner_email` / `owner_name` — no read anywhere in `src`.
- `currentVersion` — ⚠️ **a finding I withdrew.** The chain is real: `updater.test.ts:36` makes `check`
  reject, reaches `checkManifestOnly`, calls `deps.currentVersion()` as `undefined`, and the TypeError is
  swallowed by `catch { return null }` into exactly the `null` the assertion wants. I nearly reported the
  manifest fallback as unexercised. **It is covered** — `macos-is-told-about-updates-it-cannot-install`
  supplies `currentVersion`, stubs fetch, and has seven arms. What survives is thinner and worth keeping:
  that test passes under three separate mechanisms and cannot distinguish them.
- `nextCursor` — ⛔ **the naive fix is the wrong fix.** `SAMPLE` is an HTTP _response body_
  (`json: () => Promise.resolve(SAMPLE)`) annotated with the hook's _internal_ type. The wire shape is
  `next_cursor?`, snake-case and optional; the hook converts with `body.next_cursor ?? null`. Adding a
  camelCase `nextCursor` satisfies tsc and makes the fixture lie in a new way. The annotation is the defect.

⛔ **The sixth is a defect in production code, and it is the payoff for W-12.** `SimulatorWindow.tsx:643`
builds the panel's session info as `{ ws_url, token, room_name } as unknown as LiveKitInfo`, above a comment
reading "the only fields the panel/connect read" and "Cast is safe — the panel reads ws_url/token only".

Three things are wrong at once. **`room_name` is a field of nothing** — `LiveKitInfo` is
`{ws_url, room, token, participant_identity, expires_at}`, and `room_name` appears nowhere in the SDK or the
server routes. **The comment justifying the cast is false**: `AgentSessionPanel.tsx:363` reads `info.room`
as the identity key for the session-timing reset, `if (sessionTimingRef.current.identity !== info.room)`.
With `room` undefined that compares `undefined !== undefined` — false forever — so the reset branch is dead
on this path. And **the six fixtures omit the same three fields**, so the tests encode the same false belief
the cast does and could never have contradicted it.

⚠️ **Bounded honestly: latent, not user-visible.** `info` is parsed from the URL once per simulator window
and never changes, so the reset it disables had nothing to reset; the `AgentChatView` mount passes a real
SDK object and works correctly. The defect is the cast and the comment, not a wrong duration in front of a
customer. Reported to A2 rather than fixed here — every one of the six lives under `apps/gui-client/**`.

⭐ **The transferable part is about `as unknown as`.** A cast is a claim about a type, and this one carried
its own justification in a comment — which is the form that gets believed. The comment was checkable and
false the moment someone read line 363. **An `as unknown as` with a reason attached deserves more scrutiny
than one without, not less**, because the reason is what stops the next reader from looking.

## V-1637 — seventeen placeholders, three answers, and the most plausible reason was false again

W-7 left seventeen `SDK_ABSENT` entries reading `REASON OWED` — a marker meaning nobody had supplied a
justification for a published customer endpoint that no SDK reaches. V-1635 did the same exercise for the
three unpublished-route placeholders in the sibling guard. This does the seventeen.

**They are not seventeen answers. They are three.**

⛔ **One was not a gap, and my own exemption listed it wrongly.** `/v1/account/mfa/disable` looked absent
because `mfa.ts` has no method naming that path. It has `disable()`, which posts to the _sibling_:
`account-mfa.ts` registers `POST /v1/account/mfa/disable` as an alias of `DELETE /v1/account/mfa` with the
comment "Same gate, same handler", both sharing `disableHandler` and an identical preHandler chain, and the
SDK covers the DELETE. ⭐ **The first census matched SDK RESOURCE NAMES instead of paths** — a scoped
instrument answering a broader question, the same class as running a test project with a `--root` that
covers half of it.

So the re-census was path-based across all three SDKs, **with a positive control, because a clean census is
not evidence.** The control found five known-present routes at plausible counts in TS, Python and Go; the
sixth zero was my own bad guess (proxies live at `/v1/account/me/proxies`), not a hole in the instrument. An
earlier version of the same sweep had stripped the `/v1/agent-sessions/:id` prefix and matched `/files` as a
bare substring, reporting 24 Python hits that were nothing of the kind — the corrected full-path form
reports zero, which is the number that survives a control.

**Thirteen are first-party console surface.** Consumed directly over raw HTTP by `apps/gui-client`
(cookies 6 call sites, cookies/set 3, downloads 3, downloads/content 1, files 2, history 2, page-state 2,
account/cost 4, account/me/organization 2, egress/echo 1, notifications via `EventSource`) or by
`apps/customer-dashboard` (oauth-links 2, resend-verification 2). ⚠️ **Written into the map as an
explanation and explicitly not a justification:** it says why no method was ever written; it does not excuse
a published, documented endpoint having none. That remains the owner's call, as the earlier entry concluded.

⛔ **Three are the real gaps: `/v1/agent-sessions/:id/transcript`, `/v1/account/me/billing-portal`,
`/v1/fleet/events`.** Published, documented, and consumed by nothing in this repository — not the desktop
client, not the dashboard, not the admin panel. They exist purely as customer surface and no SDK reaches
them.

⭐ **The transferable finding is about the placeholder, and it is now the second time it has paid.** The most
PLAUSIBLE available sentence was false. Two of the seventeen stream, so "the SDK's typed-response shape
models JSON only" would have retired them both — and it is refuted by the SDK itself, which has
`requestEventStream` in `http.ts` and already uses it for `POST /v1/agent-sessions/{id}/message`. The
sibling guard reached for the same excuse an hour earlier about `/v1/status/stream` and was refuted the same
way, by the document publishing three `text/event-stream` operations. **Twenty placeholders across two
guards, and the single most reasonable-sounding explanation was wrong in both.**

A list of names without justification is how a real gap hides among deliberate ones. A list of names with
INVENTED justification is worse: it also stops anyone from looking again.

⚠️ Two instrument faults of my own, recorded because both nearly shipped. The substitution first emitted
Python `repr()` output into TypeScript, which switches to double quotes for any string containing an
apostrophe and produced four unterminated literals — caught by `tsc -p tsconfig.test.json`, restored
byte-identical from a snapshot, and redone with a real TS-literal encoder. And `echo "rc=$?"` after piping
`tsc` into `head` reports `head`'s status, not the compiler's; the errors were read from the output rather
than the exit code, which is the only reason it did not read as clean.

## V-1638 — the last sixteen skips, and the first gate this repo has run with nothing excluded

With `DATABASE_URL` and `REDIS_URL` both set: **3206 files passed (3206), 31,903 tests, 0 failures,
206s.** That is the first full gate either agent has run with no file-level exclusions — the 135
database-gated integration files and the four Redis ones all execute. A2 reported one failure on the same
tree; it does not reproduce here and their broken import (a missing `.js`, since fixed in `4f1ad88a8`) is
the likely cause, so it is resolved rather than outstanding.

**Sixteen tests still skip, and after today the right move was to read them rather than assume.** They are
three families, and all sixteen are intentional:

- **Nine are self-retiring doc guards whose conditions have flipped.** Five assert the marketing and trust
  pages do not claim customer-controlled egress _while no implementation exists_; four assert the docs frame
  `crypto.order.*` as not-yet-subscribable _while the enum stays gated_. Both features shipped, so the
  guards retired themselves — which is the design, not a failure.
- ⭐ **And every one of the nine announces its own retirement with a live passing test.** `trust-index`:
  "CRITICAL the egress gate was computed and has RETIRED. This file had the correct gate but still branched
  on it inside the test body, so once egress shipped the arm below asserted nothing while reporting as a
  pass." `marketing-egress-claim-sweep`: "both facts stated out loud because neither is visible otherwise
  … a silent no-op is indistinguishable in the summary from a real check." **This is the exact remedy for
  the thing that cost two agents nine hours today** — a skip is a zero that never looks wrong, and these
  files make their own zero say so.
- **Six are the flag-gated `profiles-lifecycle-actions` blocks** — `CLONE_ENABLED` ("clone is currently
  useless") and `IMPORT_EXPORT_ENABLED` ("profile-cheat abuse vector"). `gui-flag-gated-suites-track-their-flag`
  binds the skip to the flag rather than checking that the two agree, so flipping a flag runs the tests on
  the next pass with nobody in the loop.

⚠️ The literal `it.skip(` census is a reminder in miniature: five hits repo-wide, **all five are fixtures
inside the guards that forbid them**. Counting the token would have reported five permanent skips where
there are none — the same class of error as reading `115 skipped` as terrain.

So the suite has no unexplained skips, and no unexplained red.

## V-1639 — the 137 are one mock and a short list, and the body test found a quarter of them

W-12's backlog was characterised as ~137 errors sharing one root cause — untyped `vi.fn()` making
`.mock.calls` a `[][]`. Measured, that is right in substance and wrong in shape twice over.

**TS2493 (87) and TS2352 (50) are ONE cause, not two.** The untyped mock makes `calls[0][0]` an index
error, and casting the resulting `undefined` is the second error on the next line. 87 + 50 = 137. Counting
error codes presents one problem as two.

**Attributed by which mock each error lands on: 13 identifiers, and the distribution is lopsided** —
`fetchMock` 79, multi-line sites 22, `saveOrganization` 12, `sendInputEvent` 8, and sixteen more spread
across nine names. **So 79 of 137 share a single signature**, and the remainder is a bounded list of about
eleven mocks each needing the signature of what it stands in for. A sweep followed by a short drain.

⭐ **The class cannot surface behavioural failures, and the reason is worth stating precisely.** These
mocks are not merely untyped — their implementations declare ZERO parameters while the subject calls them
with two, and the tests then assert on both:

    const fetchMock = vi.fn(() => Promise.resolve(new Response(...)));  // declared: no args
    expect(String(fetchMock.mock.calls[0]?.[0]))…                       // asserted: arg 0
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;           // asserted: arg 1

**The file asserts on two arguments the type system believes do not exist**, and tsc never saw it because
nothing typechecked this workspace's tests. Adding the parameters changes nothing about what is asserted;
it makes the existing assertions expressible. Verified end to end on `account-organization.test.ts`: eight
sites rewritten, 6 errors to 0, 12/12 tests still passing, then restored byte-identical since
`apps/gui-client/**` is not mine to commit.

⛔ **And the instrument fault, which is the day's recurring one in a new costume.** My first scoping asked
what the mock's BODY contained — "does it construct a `new Response`" — and reported 14 fetch mocks across
4 files. Keying on **use** instead, the identifier each error actually lands on, reports 79 across many
more. `account-proxies` and `use-crypto-checkout` build their responses through helpers, so the body test
could not see them. **I was one step from reporting the fetch pattern as a minor contributor when it is
58% of the backlog.** The body is what a thing is made of; the use is what it is. When those disagree, the
question was almost always about use.

⚠️ Left for the owner of that workspace, with one decision attached: the already-typed fetch mocks
disagree with each other — ten use `(url: string, init?: RequestInit)`, others `(_input: RequestInfo | URL,
_init?: RequestInit)`. Matching whatever is adjacent would bake the inconsistency in at 88 sites.

## V-1640 — re-checking the reasons that were NOT owed, and one of them holds

V-1635 and V-1637 asked twenty `REASON OWED` placeholders for their justifications and found that the most
plausible sentence available — "server-sent events, which the SDK/document models poorly" — was false in
both maps. ⛔ **That is a reason to re-check the entries that already HAD reasons**, since they were written
by the same hand under the same assumptions and nothing had tested them either.

Two of them make structurally the same claim the SSE excuse did:
`/v1/billing/crypto-orders/{id}/receipt.pdf` and `.txt` are exempted because "the SDK's typed-response
shape models JSON only."

**It is true, and now proven rather than asserted.** `packages/sdk-typescript/src/http.ts` never calls
`res.json()` at all — every response path reads the body as text and does `JSON.parse(text) as T`
(three sites), and there is no `blob()`, `arrayBuffer()` or `responseType` branch anywhere in its 454
lines. A PDF byte stream throws; so does plain text that is not JSON.

⭐ **The contrast is the point, and it is not about plausibility.** Both reasons sound equally reasonable.
"The SDK models JSON only" is TRUE because the machinery genuinely does not exist; "OpenAPI models SSE
poorly" was FALSE because it did — `requestEventStream` sits in the same file, already used by
`POST /v1/agent-sessions/{id}/message`. **The two sentences are indistinguishable by reading; they are
separated only by whether anyone opened the file.** That is the whole argument for checking the reasons
that already look answered, and it is why the entries now cite the mechanism instead of asserting the
conclusion.

⚠️ The remaining pre-existing exemptions were spot-checked and hold: `/health` and `/version` are infra
probes; the four `/v1/oauth/*` entries are protocol endpoints a third-party client drives with its own
credentials, consistent with what V-1635 verified about `/authorize/complete`; the seven `/v1/status/*`
entries take no `requireAuth` at all, so no API key is involved — consistent with the same file's public
posture that V-1635 established while refuting the SSE claim about its sibling.

An exemption list is only as honest as its weakest value. This one now has no value that was written
without opening the thing it describes.

## V-1641 — a finding can be correct, written down, guarded, and still never reach anyone

Sweeping the exemption maps for reasons that make a **capability claim** — the shape that failed twice in
V-1635 and V-1637 — returned four hits. Three were entries I had just written or just proved. The fourth
was a different kind of claim, and following it found a commercial gap that has been documented all along.

`a-numeric-tier-cap-that-only-guards-creation` records that the `profiles` cap is enforced only on create.
Verified here independently rather than taken on trust: all five call sites of `profileLimitFor` are
creation paths (profile create, restore, transfer, and snapshot create), and the tier-change handler
mentions profiles **only in a comment** — it audits and emails and never looks at them.

So an account that creates 500 profiles on `api_scale` and downgrades to `free`, cap 1, **keeps all 500,
fully usable**: it can bind them to sessions, load them and save them. Only the next create is refused.
The guard's own comparison is what makes it legible:

    maxSessionMinutes    create gate + duration sweeper   a downgrade DOES reach it
    concurrentSessions   create gate only                 drains on its own; sessions end
    profiles             create gate only                 nothing drains — a profile is stored

⛔ **Subscribe for a month, create the profiles, downgrade, keep them.** That is the paid tiers'
differentiator not being real: a revenue question rather than a security one.

⭐ **The lesson is not the gap — the guard found that. It is that the guard was the END of the finding's
journey.** It is correct, it is measured, it explicitly says "THIS FILE DOES NOT PICK THE FIX", and it has
been passing quietly ever since. A test that encodes a product decision nobody has made will go on passing
forever, because passing is what it is for. **The ledger and the test suite are where findings are
recorded, and neither is where decisions get made** — so a finding that needs a human ends its life as a
green check unless somebody carries it out.

It is now the fourth item in the decision memo, alongside the three published-contract questions, where a
person can actually say yes or no to it. Recommendation there is deliberately not "delete on downgrade":
destroying a customer's stored work because their plan lapsed is the single option that converts a billing
event into a support incident, and it does not reverse.

⚠️ Separately, and worth the protocol note: a peer's new migration `0114` stranded this agent's database
mid-gate, surfacing as six failures across `db-team-invite-single-use` and
`db-schema-matches-the-migrations` — red that reads exactly like defects in work landed an hour earlier.
The migration-count guard named it instead, for the second time today and the first time about someone
else's code. **After a peer lands a migration, run `db:migrate` before trusting any `db-*` red.** The
hazard did not exist until both agents had real databases attached this afternoon.

## V-1642 — four instruments in one day, each narrower than the question it was asked

Recorded together because separately each looked like a small mistake, and together they are one failure
mode with a cheap check. **Every one of these returned a confident number. None of them errored.**

| Asked                                  | Measured                                    | Reported                         | Truth                                   |
| -------------------------------------- | ------------------------------------------- | -------------------------------- | --------------------------------------- |
| Do the SDKs cover this route?          | Do the SDK **resource names** mention it?   | `/v1/account/mfa/disable` absent | Present, as a sibling path              |
| Which tests are fetch mocks?           | Does the mock **body** build a `Response`?  | 14 across 4 files                | 79 — two files use helpers              |
| Which guards can detect a stale entry? | Does the file match **my** staleness idiom? | 1 unprotected                    | 0 — the last uses a count pin           |
| Is anything stranded in the stash?     | Is `a-simulator-…` in HEAD?                 | 244 lines lost                   | Nothing lost — I invented that filename |
| Does the test suite typecheck?         | `tsconfig.json`, which **excludes** tests   | Clean                            | 257 errors across 76 files              |

⛔ **The shape is always the same: the instrument answers a NARROWER question than the one asked, and the
narrower question has an answer, so nothing looks wrong.** A resource name is not a path. A mock's body is
not its use. My idiom is not the property. A truncated path is not a path. A tsconfig that excludes tests
does not typecheck tests.

⭐ **The cheap check that catches all five is the same one: make the instrument find something you already
know is there.** The SDK re-census got a positive control and it paid immediately — five known-present
routes found, and the one zero was my own bad guess rather than a hole. The cast sweep got one and found
the known `room_name` defect in the pre-fix commit, which is the only reason its clean result on
`apps/server/src` means anything. The stash inventory needed nothing cleverer than listing all nine files
instead of testing one guessed name.

⚠️ **And the failure mode is worse when the narrow answer is the REASSURING one.** Four of the five above
reported "fine" — clean census, small blast radius, one unprotected guard, typecheck clean. A wrong number
that says _there is a problem_ gets investigated. A wrong number that says _there is no problem_ gets
believed and closed. `115 skipped` was the same thing at the largest scale we hit today: an instrument
reporting its own boundary honestly, read as terrain.

**The rule, stated so it survives the person who learned it: before trusting a zero, make the instrument
produce a one.**

## V-1643 — seven arms that could not fail, and the chain that was actually holding

⭐ **The same `[\s\S]+?` shape as this morning's suite-killer, minus the backtracking.** Where that one was
a lazy scan that could not finish, this is a lazy scan that finishes in the wrong place.

`v485-tier-features-parity` asserted fourteen per-tier values against the TEXT of
`packages/api-types/src/common.ts`, each of the form:

    new RegExp(`${tier}: \{[\s\S]+?apiKeyEnvironment: 'live',`)

⛔ **Every one of the eight tier names occurs TWICE in that file** — once in the per-tier rate-limit table
(~330-382) and once in `TIER_FEATURES` (~444-507) — and the rate-limit occurrence always comes FIRST. So an
unanchored lazy scan could **begin in the rate-limit table and terminate at a different tier's field**, a
hundred lines away. Each arm degraded from _"THIS tier has this value"_ to _"SOME tier has this value"_.

**Mutation-proved before the repair**, restoring byte-identical from a path-keyed snapshot each time:

    free.concurrentSessions        1 -> 99     16 passed   (silent)
    solo_manual.concurrentSessions 1 -> 77     16 passed   (silent)
    solo_manual.profiles          10 -> 88      1 failed   (caught — by luck)

The `profiles` mutation was caught only because no other tier's `profiles` is `10`. `free` and
`solo_manual` both have `concurrentSessions: 1`, and that is what makes the ambiguity exploitable. **A
guard whose pass depends on the values not colliding is not a guard.**

⚠️ **The property was never unguarded, and finding that out took a third probe rather than an assumption.**
Two other guards hold it, as a CHAIN rather than as two independent checks:

- `tier-features` imports the records and compares them properly — but it imports `@driftstack/api-types`,
  which resolves to `dist/index.js`. **It is blind to a source edit until a rebuild**, which is why it also
  stayed green under the mutations above.
- `the-built-api-types-agrees-with-its-source` closes exactly that gap. Mutation-proved: an unrebuilt
  source edit fails it, 1 of 4.

So edit source alone → the built-vs-source guard fires. Edit source and rebuild → `tier-features` fires.
Either way it is caught. ⭐ **But three layers that read as independent were a chain plus a no-op**, and the
danger of the no-op is precisely that: someone trimming the other two would find this one green.

**Repaired** with a `tierRow()` reader that slices to `TIER_FEATURES` before matching and anchors per row
(`\n  ${tier}: \{([^}]*)\}` — three independent reasons it cannot wander), plus a POSITIVE CONTROL arm
that asserts each row carries its own values, cannot reach a neighbour's, never lands in the rate-limit
table, and throws on an unknown tier. After: the same mutations fail it 2, 1 and 1 respectively, and a
third (`api_scale.apiKeyEnvironment 'live' -> 'test'`) also fails.

⚠️ **Boundary, stated because it bounds the claim:** eight other guards build an interpolated `RegExp`
containing a lazy any-char run. Their prefixes are DECLARATIONS (`${name} = z.object({`, `${group}=(`),
which are structurally unique in a file, where v485's prefix was a repeated KEY. **I have not
mutation-proved those eight**, and the distinction is a reading, not a measurement.

## V-1644 — twice now, the fix that satisfies the compiler would have made the code less true

Closing the last of W-12's argument/assignment class turned 81-measured-and-8-inferred into 89 of 89 read.
Nothing behavioural in any of them. But two of the last three are the `icon` requirement, and I had a
recommendation half-drafted: _make `ProfileMeta.icon` optional and thirteen errors vanish with no
behavioural change._

⛔ **That would have been wrong, and the field's own doc comment says so:**

    /** Optional chosen icon (a short emoji); empty string = use the monogram. */
    icon: string;

The sentinel for "no icon" is `''`, not `undefined`. `profiles-meta.ts` normalises to `''` on the way in at
two sites, and every consumer guards with `r.icon ?`, which treats `''` as absent correctly. **Making it
`icon?: string` would introduce a SECOND spelling of absent** — `undefined` and `''` would both mean it,
and every guard would have to handle both. The correct fix is the opposite direction: add `icon: ''` to the
fixtures so they match a contract that is already coherent.

⚠️ I also had _"`icon` is inconsistent across the codebase"_ — because `addFolder(rawName, scope, icon?)`
takes it optionally. **That is not an inconsistency.** Omitting an argument and storing an empty value are
different things; a required stored field with an empty-string sentinel is compatible with an optional
parameter. I read drift into a coherent design.

⭐ **This is the second time in one backlog.** The first was `nextCursor`: a fixture annotated with the
hook's internal type when it is a wire body, where adding the camelCase property would have satisfied `tsc`
and made the fixture lie. **Both times the type looked wrong and the design note said otherwise. Both times
the compiler-satisfying edit was the destructive one.**

**The rule, and it is cheap: read the field's doc comment before loosening it.** A type error says these two
declarations disagree. It does not say which one is wrong, and the compiler has no opinion about which of
them encodes a decision. ⛔ **A type is not evidence about itself** — the same shape as this morning's
lesson that a verification expressed in terms of the change can only confirm the change happened.

Boundary: 89 of 89 sites in this class read individually; the ~137 mock class proven mechanically on one
file and inferred by shape elsewhere. Full gate after the v485 repair: 3208 passed (3208), 31,919 tests,
0 failures, nothing excluded.

## V-1645 — W-13: 105 customer mutations, 9 uncovered, and none of the nine leaves no trace

`every-mutating-admin-route-writes-an-audit-row` scopes itself BY PATH to `/v1/admin/` and had no customer
sibling, so every mutation a CUSTOMER makes was outside any audit-coverage guard.

⛔ **The first measurement of this was 119 of 125 unaudited, and it was correctly thrown away rather than
published.** The mechanism is sharper than "audit calls live in services": **three spellings reach the
recorder** — `accountAudit.record`, `this.accountAudit.record` (services), and `accountAudit?.record` (the
optional dep in agent-sessions) — and between them two thirds of the call sites are invisible to the obvious
pattern. ⚠️ Note the direction: that wrong number said _there IS a problem_, which is the kind that gets
believed. Four of the five instrument errors in V-1642 said "fine"; this one did not, and it was still
wrong.

**Measured: 105 customer mutating routes (deduped; admin, fleet-internal, OAuth-protocol, inbound provider
webhooks and 503 stubs excluded), 9 with no central audit call reachable.**

⭐ **And none of the nine is a change that leaves no trace** — each checked rather than inferred.
`crypto-checkout/quote` is not a mutation at all (pure computation, POST only because it takes a body).
`POST /v1/legal/accept` writes `legal_acceptances`, **whose schema comment calls it the audit log of
customer acceptance** — listing it as unaudited would have been the `owner_email` error again: right
measurement, wrong story. Five leave a domain record; two build Stripe sessions where Stripe owns the
durable record. **So W-13 is a coverage question — the central log does not cover the billing surface —
rather than a defect count.**

⚠️ **The number is a FLOOR, and the error direction was measured rather than assumed.** The detector tests
the whole route file plus one hop of imports. Run against the three `/v1/admin/oauth/clients` routes the
sibling guard already declares unaudited, it reports **all three as covered**, because another function in
an imported module audits. A one-sided arm on a proven-direction floor beats a point estimate nobody can
bound.

**Four instrument faults on the way, every one caught by reading rather than by a failure:**

1. The first registration regex missed `app.post<{Body:X}>(` and found **4** admin mutations where the
   sibling guard measured **33**. ⭐ Reproducing that 33 is what made the population trustworthy — a
   borrowed known-good number is the cheapest positive control available.
2. The stub filter matched `, stub)` but not `handler: stub`.
3. `/v1/internal/*` was counted as customer surface; it is fleet bearer auth. So were `/v1/oauth/*`
   (third-party client credentials) and `/v1/webhooks/*` (the payment provider is the caller).
4. ⛔ **Block-scoped detection reported three `byok-anthropic-key` routes as bare** because the file's audit
   call sits in a helper at line 103, ABOVE the first registration at 139. **An audit call does not have to
   be inside the block that needs it.**

Mutation-proved in both directions, restoring byte-identical each time: adding an audit call to a LISTED
route fails the staleness arm (`POST /v1/legal/accept`), and the coverage arm caught twelve routes before
the population was corrected. ⚠️ A third mutation — neutering the single audit call in
`account-web-sessions.ts` — did NOT fire, and that is the documented over-approximation rather than a
defect: the file has one call and **two imported modules that also audit**. Recorded because a mutation
that fails to fire is evidence about the instrument, not proof of a hole.

## V-1646 — closing V-1643's boundary: the other eight lazy scans, measured rather than read

V-1643 repaired seven vacuous arms and ended with an honest hedge: eight other guards build an interpolated
`RegExp` containing a lazy any-char run, their prefixes "are DECLARATIONS rather than repeated KEYS, and
**that is a reading, not a measurement**". This measures it, because a stated boundary that is never closed
is just a hedge.

**The predicate is exact: a lazy unanchored scan is only exploitable if its interpolated prefix occurs more
than once in the file being searched.** One occurrence and the match cannot start anywhere but the right
block.

| guard                           | prefix                   | occurrences                             | verdict                     |
| ------------------------------- | ------------------------ | --------------------------------------- | --------------------------- |
| `v485-tier-features-parity`     | `${tier}: {` — a KEY     | **2 per tier**                          | vacuous; repaired in V-1643 |
| `email-template-registry`       | `'${t}': {` — a KEY      | 1 per key (20 keys, 0 duplicated)       | safe                        |
| `account-tier-enum`             | `AccountTierSchema`      | **4**                                   | safe — see below            |
| `anti-enumeration-response`     | `${schema} = z.object({` | 1 per schema (22, 0 duplicated)         | safe                        |
| `lib-transient-error`           | `${name} = [`            | 1 per name (4, 0 duplicated)            | safe                        |
| `commit-msg-hook-actually-runs` | `${group}=(`             | 1 per group (2, 0 duplicated)           | safe                        |
| `webhook-event-type`            | `'${ev}'`                | no lazy run in the interpolated pattern | n/a                         |

⭐ **`account-tier-enum` is the interesting one, and it is safe for a reason worth naming rather than for
the reason I expected.** Its prefix genuinely repeats — `AccountTierSchema` appears four times in
`common.ts` — but the assertion is **`.not.toMatch(...)`**. An over-broad regex makes a match MORE likely,
which makes a NEGATIVE assertion more likely to FAIL. **It fails safe: it can raise a false alarm, it cannot
produce a false green.** Direction of an assertion decides whether over-breadth is a hazard or a nuisance,
and I would have mis-filed this one on prefix-count alone.

⚠️ **`email-template-registry` is safe by DATA, not by construction.** It uses the same key-shaped prefix
that made v485 vacuous, and is fine only because no key is duplicated in `email.ts` today. A second object
literal reusing those keys would silently make it vacuous, with nothing to announce it.

**So `v485` was the only guard where a repeated prefix met a positive assertion** — the boundary is closed,
and the answer happens to be the reassuring one. That is worth recording precisely because V-1642's lesson
is that reassuring answers are the ones nobody re-checks: this one was checked.

## V-1647 — I fixed the vacuity and left the title lying

V-1643 repaired seven arms in `v485-tier-features-parity` whose regex could match the wrong tier. An hour
later, hunting a different defect class, I looked at one of my own repaired arms:

    it('CRITICAL cross-record consistency — TIER_FEATURES.concurrentSessions[tier] ===
        TIER_CONCURRENT_SESSION_LIMITS[tier] …', () => {
      …
      const expected: Array<[string, number]> = [['free', 1], ['solo_manual', 1], …];

⛔ **The body never reads `TIER_CONCURRENT_SESSION_LIMITS`.** It compares `TIER_FEATURES` against literals
typed into the test file. It is a value pin wearing the title of a cross-record check — and repairing the
regex had made it a CORRECT value pin, which is why nothing about it looked wrong.

⭐ **The lesson is about where I was looking.** I spent an hour on those arms — measured the ambiguity,
mutation-proved it, wrote the repair, proved the repair — and never read the sentence above the assertion.
**A guard has two claims: what it asserts, and what it says it asserts.** I checked one of them very
carefully. This is the mirror of V-1635's "correcting the entries left the header lying", and it happened
to me in the opposite direction within the same file family.

**Both arms now read both records.** Mutation-proved in the way that distinguishes them: changing ONLY
`TIER_CONCURRENT_SESSION_LIMITS.free` from 1 to 99, leaving `TIER_FEATURES` untouched, now fails the arm —
`expected '…concurrentSessions: 1,…' to match /concurrentSessions: 99,/`. **The literal-comparing version
could not have noticed, because the record it names was never opened.** Restored byte-identical.

⚠️ It also picks up `enterprise`, which the hardcoded list omitted: seven tiers of eight, a coverage gap
sitting inside an arm titled "for every tier".

**The generalisation is a defect class I had not named:** a test whose title asserts a relationship between
two artefacts while its body reads only one. It is invisible to every check we run — it passes, it is not
vacuous, its assertion is true — and the only thing wrong is that it does not test what the suite's own
index says it tests.

## V-1648 — hunting the class V-1647 named, and a measurement I am not publishing

V-1647 named a defect class: **a test whose title asserts a relationship between two artefacts while its
body reads only one.** It passes, it is not vacuous, its assertion is true, and the only thing wrong is
that it does not test what the suite's index says it tests. This went looking for more.

**The detector, and why its number is not in this entry.** For every `it(...)`, extract the UPPER_SNAKE
identifiers named in the TITLE and check whether each appears in the arm's BODY.

    all arms naming an identifier absent from their body        231
    narrowed to titles asserting a comparison (===/matches/…)    33
    credible                                                     no

⛔ **231 was uninterpretable and 33 is still mostly false.** Two failure modes, both mine:

1. **A title may name an identifier as CONTEXT, not as a claim.** "the two webhook write routes declare the
   409 `WebhooksService` raises" mentions `MAX_ENDPOINTS_PER_ACCOUNT` to explain where the 409 comes from.
   Nothing is being compared. Narrowing to comparison verbs cut 231 to 33 and did not fix this.
2. ⭐ **The body scope is the ARM, so an identifier reached through a HELPER reads as absent.** Two of the
   33 hits are `v485`'s own arms — the ones I had just repaired in V-1647 to read both records — flagged
   because they reach `TIER_FEATURES` via the `tierRow()` helper rather than naming it inline. **This is the
   identical block-scoping error I had made an hour earlier in W-13**, where route-block detection reported
   three `byok` routes as bare because their audit call sat in a helper above the registrations. I made the
   same mistake twice in one afternoon, in two different instruments, having already written up the first.

**So the number is recorded as a FAILED MEASUREMENT rather than a finding**, which is the same call A2 made
on 119-of-125 and the right one. ⚠️ A detector whose false-positive set includes the code I fixed to satisfy
it is not measuring the property.

⭐ **But the class is real, and one instance is confirmed and fixed.**
`resend-verification-parity` had:

    it('AUTH_IP_LIMITS.resendVerification matches password-reset cap (3/min)', …)
      expect(limits).toMatch(/resendVerification:\s*\{\s*capacity:\s*3, …/)

The title claims a relationship between two entries. The body reads one of them and compares it to a
hardcoded `3`. **Moving `passwordResetRequest` to 5/min would have left it green with its stated invariant
broken.** It now reads both capacities out of `ip-rate-limit.ts` and asserts they are equal, keeping the
pinned value as well so a matched pair drifting TOGETHER still fails.

Mutation-proved on the side the old arm could not see: `passwordResetRequest` 3 → 5, `resendVerification`
untouched, now fails with `expected 3 to be 5`. Restored byte-identical.

**A comparison claim has to open both sides.** That is the whole rule, and it is worth more than the
enumeration I could not make credible.

## V-1649 — a row lock protects against concurrency, not against authorship

Sweeps had stopped yielding, so this audited a route end to end instead: the crypto-order cancel and IPN
path, chosen because it moves money and because W-13 had just found it absent from the central audit log.

**Most of it is the best code I have read today, and saying so is a result.** `withOrderLock` is a real
lock — `db.transaction` plus `.for('update')`, re-reading the COMMITTED row inside the transaction.
`cancelOrder` re-checks ownership AND status against the locked row rather than a pre-lock read. The IPN
callback is careful everywhere it could be careless: `order.payment_id ?? args.payment_id` so the STORED id
wins and an inbound IPN can only backfill a null; a forward-only state machine on the locked status;
`firePaid: order.status !== 'paid' && …` so a re-delivered IPN cannot re-fire the webhook and the receipt;
amount reconciliation in CRYPTO units with an explicit refusal to compare against the fiat price.

⛔ **One thing was wrong, and it was invisible at every call site.** The helper's UPDATE wrote
`accountId: updated.account_id` — from the CALLBACK'S object, alongside ten other fields. All eight
callbacks spread `...order`, so every one wrote the locked value back and nothing was ever wrong. **That is
a convention, not a constraint**, and the lock does not police it: a lock serialises writers, it says
nothing about what a writer is allowed to change.

⚠️ **And nothing else would have caught it.** `account_id` is `uuid('account_id')` — **nullable, and with no
foreign key.** A callback built from an IPN payload rather than from the locked row would have moved the
order to an arbitrary account and Postgres would have accepted it in silence.

**Fixed structurally rather than by guard: the column is no longer in the SET.** Behaviour is unchanged
today — every caller already passed the locked value back, so writing it wrote what was already there — and
the invariant is now a property of the statement instead of an agreement among eight callbacks.

**Proved on a real Postgres, both directions.** A new arm in `db-crypto-order-lock-exclusivity` runs a
callback that does NOT spread the locked row and asserts the order does not move while the legitimate half
of the write still lands. With the fix: 3 passed. With `accountId` restored to the SET:
`expected '44728d85-…' to be null` — **the hijack succeeded.** So this was exploitable, not theoretical.

⭐ **Prior art was checked first, and it is why the arm is not a duplicate.** The same file covers
CONCURRENCY (two IPNs serialise), and `cross-account-crypto-order-isolation` covers ACCESS (account B gets
a 404 and nothing is written). Neither covers the lock helper carrying an ownership change — a third
property, and the one with no natural place to be noticed.

**Then swept the shape rather than the token.** Of 16 `.set({…})` blocks fed from a callback-style object
across `apps/server/src/db`, two appeared to write an ownership column — and ⚠️ **both are false
positives**: the `accountId:` keys in `webhooks-repo` are the encryption-context argument nested inside
`encryptForStorage(...)`, not columns. Caught by reading. After the fix, no repo writes an ownership column
from caller input.

⚠️ One unexplained obstacle, recorded rather than dressed up: the new arm's INSERT — **byte-identical to the
working one above it** — failed inside postgres.js parameter binding (`Received an instance of Array`) with
`cachedError` in the stack, which is consistent with prepared-statement caching keyed on query text. **I did
not establish the mechanism.** The arm uses an explicit `'[]'::jsonb` literal instead, which avoids
parameter binding for that column entirely.

## V-1650 — W-10 measured as a blast radius instead of a schema count

W-10 has sat open as "39 declared component schemas that no operation `$ref`s — the fix changes the
published contract, so it needs the owner's call". That is true and unactionable: it says nothing about how
much of the contract moves. This measures it, so the decision has a size.

**Accounting over all 39, and it closes:**

    39   orphaned components
    33   distinct property-set groups (two groups carry two names each)
    31   orphans matched to a shape a document operation emits INLINE
     8   unmatched, itemised below
    33   DISTINCT OPERATIONS affected, of 232 in the document
         (31 responses + 11 request bodies; some operations are both)

The affected set is not obscure: `GET /v1/account/me` (16 properties), `POST /v1/agent-sessions` and
`GET /v1/agent-sessions/{id}` (19), `POST /v1/api-keys`, `POST /v1/webhooks`, `POST /v1/sessions`,
`GET /v1/usage`. **A customer generating a client today gets anonymous inline models for the operations they
use first.**

⭐ **And the measurement surfaced a decision inside the decision, which the schema count hides entirely.**
Two pairs of orphaned components have **IDENTICAL property sets**:

    Account            ==  AdminAccount
    CreateSessionResponse  ==  Session

An inline shape can only `$ref` ONE name. So fixing W-10 is not purely mechanical: for these two shapes
somebody has to decide which name the document keeps, and that choice is what customers will see in every
generated client. ⚠️ **I found this only because my first pass undercounted by two** — it took
`group[0]` as the name and I noticed the arithmetic did not close (29 + 8 ≠ 39). The discrepancy was the
finding.

**The 8 unmatched, itemised so the number is not a residue:**

- **4 have no property set** — `AgentIntent`, `IntentResult`, `SearchResponse`, `SessionLoginResponse`.
  Enums or aliases; nothing to reference.
- **2 appear only NESTED** — `ApiKey` (2×) and `AdminAuditLogEntry` (1×), inside list envelopes rather than
  as a whole response. Consistent with the earlier note that six are reached via `z.array(...)`.
- **2 are query-object schemas** — `ListDeliveriesQuery`, `PaginationQuery`. OpenAPI flattens a query object
  into individual parameters, so these can never be `$ref`'d from an operation at all. ⛔ **They are not a
  gap to fix; they are components that should probably not be declared.**

⚠️ Boundary, in the same sentence as the result: shapes were matched by **exact property-name set**, not by
full schema equality. Two schemas with the same property names and different types would match here and
should not. Every matched pair above is a response the routes demonstrably build from the named schema, but
the instrument is a fingerprint, not a proof of identity.

## V-1651 — making a test double MORE faithful broke a test, and the class was 88 of 89 not 89

⛔ **Correcting V-1639 and V-1645.** Both recorded that W-12's ~89 argument/assignment errors are
"type-only", and V-1639 recommended the fix: have `makeResponse` return a real
`new Response(JSON.stringify(body), {status})` instead of a hand-built `{ok, status, json}`, which "removes
the double-cast entirely rather than papering it".

**The recommendation was wrong, and A2 found it by predicting the delta.** Applied, the error count landed
where predicted and the gui suite went RED.

**A real `Response` body is SINGLE-USE.** The stub's `json: () => Promise.resolve(body)` was a closure and
could be read forever. The test queued **one shared instance twice**:

    .mockResolvedValueOnce(bound)      // consumed
    …
    .mockResolvedValueOnce(bound)      // "Body is unusable"

The sign-in flow never reached its success state and `waitFor` timed out.

⭐ **The transferable finding is the inverse of the usual one.** The standing lesson is that a faithful
double hides the real artefact. This is the opposite: **making a double more faithful broke a test that was
relying on a way the double was UNFAITHFUL** — and nobody could have written that dependency down, because
with a plain object re-readability is not a property, it is just how objects behave. **A test can depend on
an affordance the double has only by accident of being a different kind of thing.**

⚠️ So the class is **88 of 89 type-only, not 89**. The exception is not a different kind of error; it is the
same error whose _fix_ has a behavioural consequence. That distinction was not in my framing and should
have been: "type-only" described the defect and I let it describe the remedy too.

**Fixed by A2 as a factory rather than by `.clone()`**, which is the better call for a reason beyond
passing: a real `fetch` never hands the same `Response` instance to two requests, so calling the factory
twice is the more faithful double as well as the working one. `.clone()` would have preserved the
shared-instance shape and left the same trap for the next author.

⭐ **And the catch mechanism deserves its own line, because it caught a second thing nobody was looking
for.** A predicted delta of −26 came back −24: a deleted interface had two surviving references, so a commit
whose subject is removing errors had silently ADDED two. **Read as "148 → 124, good progress", that ships.**
A fix that improves the number while creating new instances of the very thing it removes is invisible to
every check except a predicted delta.

**The pair, which cover opposite failures and belong together:**

- **Before trusting a zero, make the instrument produce a one.** (Catches an instrument that cannot see.)
- **After applying a fix, check the number moved by what you predicted.** (Catches a fix that did not do
  what you thought — and it is the only fault today that caught itself with no human reading any code.)

## V-1652 — five paths audited end to end: one defect, four sound, and what made them sound

Recorded together so the coverage is on file and nobody spends an afternoon re-reading these. ⚠️ **Boundary
in the same sentence as the result: this was READING, path by path, not exhaustive proof.** Each claim below
names the specific line or property that carries it, so a later reader can check the claim rather than trust
the verdict.

**1. Crypto order cancel / IPN — ONE DEFECT, fixed in V-1649.** `accountId` was writable through the lock's
UPDATE from a callback-supplied object. Proven exploitable on real Postgres.

**2. Webhook secret rotation — sound.** AES-256-GCM with the account+endpoint tuple as **AAD**, so a context
mismatch fails the auth tag and throws rather than yielding a wrong secret. Already proven:
`webhook-secret-encryption.test.ts` asserts cross-context, cross-key and tampered reads all throw. ⚠️ The
asymmetry I flagged on the way in — `input.accountId` at one rotation site, `contextRow.accountId` at the
other — is a robustness nit and not a hole, precisely because a mismatch fails closed and loudly.

**3. Pair-mode takeover — sound.** `SET key clientId NX EX ttl` to acquire; the canonical Lua
`if redis.call("get", KEYS[1]) == ARGV[1] then del` to release, **so release checks identity** — the exact
failure this repo's notes warn about ("a lease acquired with identity, released without checking"). Both
call sites pass the acquiring `client_id`, release sits in a `finally`, and a comment records a
previously-fixed leak that held the lock for the full 30s TTL. Authorization happens before the lock and the
state transition is a CAS on the persisted state.

**4. API key authentication — sound, and it is the most carefully written path I read.** Revoked and expiry
are checked **after** scrypt verification, so revocation cannot be probed without a valid key. The key
authority is **re-read after capturing cache generations** and re-checked on BOTH `id` and `keyHash`, which
closes a revoke racing the read. The account is resolved from the key's own row, never from input. Deleted
accounts return `InvalidKeyError` rather than a distinguishable error, so existence does not leak.
`key_prefix` is uniquely indexed in the schema AND in migration 0000 — checked in both places, because a
schema declaration is not the deployed constraint.

**5. LLM usage metering — sound, and the interesting part is the billing idempotency.** All three
`recordUsageRowWithRetry` call sites attribute to `session.accountId`, derived from the session record
rather than from request input. ⭐ **And the retry contract is ENFORCED, not merely documented**: one
`recordId` is minted per row and reused across every attempt, the recorder uses it as the row `id`, and the
insert carries `.onConflictDoNothing()` — with `id` being the primary key, a retry after a committed write
is a no-op rather than a second charge. **The no-id path deliberately does NOT add a conflict target**, and
says so: "the write keeps its previous behaviour rather than silently pretending to be retry-safe."

⭐ **The pattern worth carrying: four of the five sound paths are sound because identity is DERIVED rather
than accepted.** The account comes from the key's row, the session's row, the locked row. The one defect was
the one place a caller-supplied object could carry an identity field into a write. **"Where does this
identity come from?" found a real bug in one path and confirmed four others in an afternoon**, which is a
better yield than any token sweep I ran today.

## V-1653 — a dead branch that would prefer the less-derived identity

Sixth end-to-end audit, following the thread that found V-1649: **where does this identity come from?**
Target was inbound Stripe webhooks, because that is the remaining surface where an identity arrives in an
external payload rather than from an authenticated caller.

**Clean, and the chain is worth stating because it is what makes it clean.** `ensureCustomerId` creates the
Stripe customer and **awaits `setStripeCustomerId` BEFORE returning**, so `accounts.stripe_customer_id` is
persisted before the Checkout Session exists. Every webhook that arrives later therefore resolves the
account through a column we wrote. All five call sites of `findAccountIdFromCustomerOrRef` pass
`stripeCustomerId` and an explicit `clientReferenceId: null`. `handleCheckoutCompleted` is informational and
writes nothing; the tier grant happens on `customer.subscription.created`.

⚠️ **The observation, which is latent rather than live.** `findAccountIdFromCustomerOrRef` has TWO branches,
and it tries them in this order:

1. `clientReferenceId` → `where(accounts.id = clientReferenceId)` — an id that has **round-tripped through
   Stripe**, validated here only by the row existing.
2. `stripeCustomerId` → `where(accounts.stripeCustomerId = …)` — a column we wrote ourselves.

**Branch 1 is unreachable today**: no caller passes a non-null `clientReferenceId`, traced across all five.
We do SEND `client_reference_id` (`stripe-billing-provider.ts` sets it to the account id, and it is genuinely
useful in the Stripe dashboard for a human) — **we simply never read it back**, because by the time any
event arrives the derived route always works.

⛔ **So it is redundancy, not a gap. But the branch ORDER is a trap for whoever wires it up.** If a future
caller ever supplies a `clientReferenceId`, it takes precedence over the derived `stripeCustomerId`, and the
two are never cross-checked against each other. ⭐ **The sibling payment path already knows better**: the
crypto IPN handler refuses and raises a mismatch alarm when the IPN's `payment_id` disagrees with the stored
one, and its comment says exactly why — the admin apply-ipn path takes an operator-supplied id, so the guard
exists to stop "a fat-fingered or malicious operator from attaching the wrong payment".

**Left in place rather than removed.** The branch is documented, harmless while unreachable, and deleting a
capability nobody asked me to delete is outside what this audit was for. Recorded so that whoever reaches
for it knows the derived source should win, or the two should be cross-checked the way the crypto path
cross-checks its own.

⚠️ Boundary: reachability established by tracing all five call sites in `stripe-webhooks.ts` and grepping
every `clientReferenceId` reference in `apps/server/src` — not by instrumenting a running system.

## V-1655 — `npx vitest run` skips the build, and five of six packages have nothing to notice

⚠️ **A caveat on our own evidence, including mine, recorded with both halves — the alarm and the climb-down.**

`npm test` has a **`pretest`** that runs `npm run build --workspaces --if-present`. `npx vitest run` — which
both agents have used for every gate today — **skips it.** Workspace packages resolve to `dist/index.js`
(checked in each `package.json`), and there is no vitest alias mapping `@driftstack/*` back to `src`. So a
direct vitest run tests **whatever build happens to be on disk**.

Of the six workspace packages consumed via `dist/` and imported by server tests — `api-types` (278 test
files), `webhook-delivery` (9), `behavioural-simulation` (6), `recapture-automation` (4), `webrtc-streaming`
(3), `recipe-library` (2) — **exactly one has a built-vs-source guard**:
`the-built-api-types-agrees-with-its-source`. That guard exists precisely because of this, and it works: it
went red on cue when V-1643's probe mutated `common.ts` without rebuilding.

⛔ **My first measurement said FIVE packages were stale, and it was wrong in the way I had already been
burned by four hours earlier.** It compared **mtime**, and mtime is not content: `api-types/src/common.ts`
read "1409 minutes newer than dist" purely because my own snapshot restores had touched it, while the
content agreed exactly — three fields across all eight tiers, verified at the time. **A file's timestamp is
evidence about the filesystem, not about the build.**

**And the honest conclusion is narrower than the alarm.** `dist/` is gitignored and **zero dist files are
tracked**, so it is a local artefact: CI builds from a clean checkout and cannot be stale. My gate results
today are not retroactively qualified either — the only package source I touched was `api-types`, during
mutation probes, which is the one package that is guarded.

⭐ **What remains true is a habit rather than a defect: five of six dist-consumed packages can go stale
locally with nothing to announce it.** It is the `115 skipped` shape again — the suite is green about a
stale artefact rather than about the change you just made, and nothing in the output says so. The cheap fix
is not a guard: **run `npm test` after touching a package, `npx vitest run` when you have not.**

## V-1654 — one `await` carried an integration's derived identity, and my guard for it was wrong three times

V-1653 found that every inbound Stripe webhook resolves the account through `accounts.stripe_customer_id`
— a column we wrote — rather than through anything in the payload. **That property rests on a single
ordering**, and A2 was right that it deserved a guard:

    const customerId = await this.provider.ensureCustomer(...);
    await this.repo.setStripeCustomerId({ accountId, customerId });   // <- awaited BEFORE the return
    return customerId;

Make it `void`, move it after the return, or race the checkout with `Promise.all`, and the account row can
still be missing its customer id when `customer.subscription.created` arrives. The resolver returns null,
the handler logs "unknown customer; ignoring", and **a paying customer silently does not get their tier**.
⛔ Nothing would fail at the time of the refactor: the unit tests stub the repo and the ordering is
invisible to types.

**Guarded in four arms** — a positive control that the body reader isolates one method, the
persist-before-return ordering, the await-not-`void` form, and that all five webhook resolver call sites
still pass `clientReferenceId: null` (which turns V-1653's dead branch from an unexamined risk into a
pinned fact). Mutation-proved against the real subject: `await`→`void`, racing the ensure, and letting one
call site trust the round-tripped id each fail exactly one arm; sources restored byte-identical.

⛔ **The extractor was wrong THREE TIMES, each one construct further right, and every version was exposed
by the BASELINE rather than by a mutation.**

    v1  end the body at the first `\n  }`   → matched the multi-line PARAMETER OBJECT's close
    v2  paren-walk past the parameters     → landed on the RETURN TYPE's braces,
                                             `Promise<{ url: string; … }>`; body = 34 chars of type
    v3  + track angle depth                → 2318 chars, containing what it must

⭐ **M1 and M3 added a failure under every single broken version.** Reading only the mutations I would have
shipped an arm that could never pass, three times over. **A mutation proves an arm CAN fail; only the
unmutated run proves it can PASS.** That is the third rule, and of the three it is the cheapest:

- Before trusting a zero, make the instrument produce a one.
- After applying a fix, check the number moved by what you predicted.
- **Run the guard unmutated before you trust the mutations.**

⚠️ **A separate finding, verified by reading and deliberately left unquantified.** The repo's vacuity guard
`a-test-arm-may-not-hide-all-its-assertions` detects arms whose every assertion sits behind a CONDITIONAL —
its `ifBlocks` matches `/\bif\s*\(/g` and nothing else. **A `for (const m of x.matchAll(...))` hides
assertions identically when the iterable is empty, and is outside its scope.**

⛔ **My detector for that blind spot brace-counted RAW SOURCE, so `{4,}` in a regex and `${…}` in templates
counted as braces — the exact bug that guard's own header records ("the first version of this guard did …
which mis-delimited 8 arms"), which I had read minutes earlier.** Three variants produced **517, then 1,
then 406**. None is published. What survives is the read: `ifBlocks` is `if`-only.

⭐ And extending it to loops is probably wrong anyway: wrapping every assertion in an `if` is nearly always
suspicious, which is why that arm found eleven real cases, whereas looping over a literal or an
independently-counted collection is ordinary correct code. **The blind spot is real; the fix is not a wider
regex.**

## V-1656 — the 32 Rust tests are not orphaned, and two other blind spots that were not there

Three checks aimed at "what does the green number NOT cover", after seven end-to-end audits kept landing in
existing prior art. ⭐ **All three came back negative, and the negatives are the useful part** — each was a
gap I believed in, and two of them came from my own working notes.

**1. Test files collected by nothing.** 3210 `.test.ts`/`.test.tsx` files on disk (excluding
`node_modules` and `dist`) against 3209 collected by the last full gate. **The difference is exactly one:
the guard committed after that gate ran.** No orphaned test file.

⛔ **2. "32 Rust tests under `src-tauri` are collected by no vitest project" — true, and misleading, and it
was my own note.** They are indeed invisible to vitest. **They are also run**:
`.github/workflows/gui-build-check.yml` runs `cargo test --all-targets` unconditionally within its job.
⚠️ With the boundary stated: that workflow is **path-filtered** to `apps/gui-client/**`,
`packages/sdk-typescript/**` and the workflow file, so the Rust tests run on changes that touch the desktop
client — which is when they can break — and not on a server-only change. **That is a reasonable design, not
a gap, and my note read as "unrun" because it described the mechanism I had checked rather than the question
I cared about.**

**3. `accountAudit?.record(...)` being an OPTIONAL dep.** An unwired optional dependency is a feature that
exists only in tests — the audit call becomes a silent no-op and nothing fails. Already covered, and
thoroughly: `bootstrap-unwired-optional-deps-are-declared` carries an `AUDIT_WIRED` table naming every
service that accepts a fail-open audit recorder, plus a detector positive control, a scan-reached arm, a
staleness arm, and an over-reporting arm. It is a better guard than the one I would have written.

⭐ **The pattern across today's second half is worth stating plainly: seven end-to-end audits produced one
defect, and every follow-on thread landed in prior art that already covered it.** That is evidence about the
codebase rather than about the search — the areas reachable from `apps/server` are densely guarded, and the
guards are built the way the ledger keeps asking for: positive controls, staleness arms, and stated
boundaries.

⚠️ And a note on method, since it cost time: I ranked services by "test mentions per kLOC" to choose the
next audit target, and it put `crypto-tier-activation` at the bottom — 386 lines, one mention. **It has a
dedicated `crypto-tier-activation.test.ts` and three more.** The proxy matched filename stems, and
`crypto-order-paid-tier-activation.test.ts` does not contain the stem `crypto-tier-activation`. **Third
proxy metric to mislead me today; I have stopped using them to choose targets.**

## V-1657 — why one payment path has a reconciler and the other must not

Eighth end-to-end audit, chasing a shape rather than a spelling: **which state transitions dual-write
across two transactions with no repair path?** The crypto payment path has one —
`crypto-entitlement-reconcile-sweeper` (V-779) recovers "paid crypto orders whose entitlement never
landed". The obvious question is whether its sibling, the Stripe path, has the same hole and no sweeper.

**It does not, and the reason is worth writing down because the asymmetry looks like an omission and is
not.** Recorded so nobody closes it in either direction — adding a Stripe reconciler that repairs nothing,
or deleting the crypto one as redundant.

**Crypto cannot self-heal, by construction.** `firePaid` is computed from the LOCKED pre-update status, so a
re-delivered IPN finds `status='paid'`, computes `firePaid = false`, and skips activation, the webhook and
the receipt. The handler says so itself. **Hence the reconciler.**

**Stripe self-heals, and three separate decisions carry it:**

1. ⭐ **`setWhere: subscriptions.updatedAt <= excluded.updated_at` — `<=`, not `<`.** A redelivery of the
   same event carries the same `event.created`, so equal timestamps still apply, `applied` comes back true,
   and the caller re-drives the tier grant. **One character.** The comment gives a second reason for it
   (second-granularity timestamps mean two genuinely-distinct ordered events can share a second), which is
   why it survives.
2. ⭐ **`dispatch()` runs BEFORE `recordEvent()`.** A transient failure re-throws, **no ledger row is
   written**, the route returns non-2xx, and Stripe re-delivers within ~3 days. Claiming the event first —
   which looks like sensible concurrency hygiene — would leave a ledger row on a mid-flight death and
   suppress the redelivery permanently.
3. **Permanent errors are swallowed and DO write the ledger row**, returning 200, because retrying a
   deterministic bug earns a multi-day retry storm and risks Stripe disabling the endpoint.

⭐ **And the cost of decision 2 is itself guarded, which is the part I did not expect.** Dispatching before
the ledger insert means a concurrent delivery can execute dispatch twice — so every write on that path must
be idempotent. `stripe-dispatch-has-no-additive-write` pins exactly that, with a detector positive control
and a scan-reaches arm. **The trade-off is named, and the price is paid explicitly.**

⚠️ Boundary: established by reading `handle()`, `dispatch()`, `upsertSubscription` and the three guards
around them — not by killing a process mid-window and observing recovery.

**Eight end-to-end audits now, one defect (V-1649), and every follow-on thread already guarded.** That
remains evidence about the codebase rather than about the search.

## V-1658 — at-most-once email is a choice, and one header sentence does not know it

Ninth audit, continuing the dual-write shape onto side effects: **which effects fire outside the
transaction that decided them, with no way back?** Webhooks are durable (delivery table plus worker). Email
is the interesting case.

**`services/email.ts` states the posture in its header, and it is deliberate:** _"All sends are
fire-and-forget: errors are logged at warn-level but never thrown to the caller, because email is never on a
request critical path."_ Correct — failing a Stripe webhook because Postmark blipped would cost far more
than a missing message.

**Chasing the sharpest instance — the billing receipt, a one-shot email tied to
`invoice.payment_succeeded` — the ordering turns out to be explicit:**

    // C6 — claim before the send (after opt-out + account checks).
    const won = await this.repo.claimBillingEmail({ … });
    if (!won) return;

⭐ **Claim-then-send is AT-MOST-ONCE by construction, and it is the right way round for a receipt.** Two
receipts read as a double charge; zero receipts read as a support ticket. The claim also resolves the
concurrency case where two deliveries would each send one. **A deliberate trade, named at the site.**

⚠️ **The nit, and it is only a sentence.** The header continues: _"affected users get the email on the next
attempt or out-of-band."_ For the C6-claimed lifecycle emails there IS no next attempt — the claim row
survives the failed send, so only "out-of-band" applies. The sentence is true of the resendable ones
(signup verification, password reset — the user can ask again) and not of the claimed ones. Left as is
rather than edited: it is a general statement in a general header, and rewriting it risks the
correcting-a-comment-leaves-the-acting-line-lying trap in reverse. Recorded so the next reader does not
infer a retry that does not exist.

⚠️ Boundary: established by reading `handlePaymentSucceeded`, `claimBillingEmail`'s call site and the email
header — not by failing a real Postmark call and watching what recovers.

**Nine end-to-end audits, one defect.** The dual-write shape has now been walked across payments, entitlement
grants, webhooks and email; every window it found was either self-healing, reconciled, or a documented
at-most-once choice.

## V-1659 — I nearly accused a guard of a blind spot with a regex narrower than its identifier

Twenty-six entries were appended to this file today, and twelve tests read it — including
`a-verification-log-number-resolves-to-one-finding` and `no-formatted-markdown-outgrows-the-format-hook`.
**Checking that my own commits had not broken a guard I did not know read my file** is how this started, and
it is a check worth naming: a docs-only commit is not automatically safe in a repo with content-parity
gates.

All four pass — 17 tests, no breakage. ⛔ **But my own static check reported FOUR duplicate V-numbers** —
`V-1274`, `V-1488`, `V-1501`, `V-1506` — while the guard whose entire purpose is "a number resolves to ONE
finding" sat green. **That is a guard accusing itself of a blind spot, and I was one message from reporting
it.**

**The guard was right.** They are `V-1274`, `V-1274b`, `V-1274c` — suffixed continuations. My regex was
`^## (V-\d+)`, which captures the digits and **silently drops the letter**, so three distinct headings
collapsed into one identifier. With `^## (V-\d+[a-z]*)`: **416 headings, 416 distinct, zero duplicates.**

⭐ **Fourth instrument fault of this exact class today, and the cheapest to have avoided.** A resource name
is not a path; a mock's body is not its use; a method's parameter brace is not its body brace; **and
`V-\d+` is not the identifier format.** Every one was a boundary drawn narrower than the thing it was drawn
around.

⭐ **What caught it was the disagreement, not a failing test.** The guard passing while my count said it
should fail is the same signal as A2's "the number did not move" — **two instruments disagreeing is
information, and the right first assumption is that mine is the broken one.** It was, four times out of
four.

## V-1660 — what reaps a session stuck in `busy`, and why not releasing it is the safe choice

Tenth audit, and the first on the CORE PRODUCT path rather than the money and auth paths: the session
operation lifecycle. **The question: `claimSessionOperation` CASes `ready -> busy`; what happens if the
process dies before either outcome?**

**The two live paths are correct.** `try { fn(session) }` on failure runs `failSessionOperation` (→
`errored`, driver session destroyed) and rethrows; on success `settleSessionOperation` CASes back to
`ready`. That settle is tight — id AND accountId AND **driverSessionId** AND `status='busy'` AND
`destroyedAt IS NULL` — so a settle from a stale driver session cannot win.

**A process death between claim and either outcome leaves the row `busy`, and nothing automatically returns
it to `ready`.** ⭐ **That is the safe choice, not an omission.** The control plane does not know whether the
operation completed on the worker; auto-releasing to `ready` would let a second operation race a possibly
still-running first one. **Stuck-`busy` fails closed: it refuses new operations rather than risking
concurrent driver commands.** `updateSessionStatus` enforces it — a `busy` row is excluded entirely, and
only settle, fail, or a serialized destroy may move it.

**Recovery is destroy, and destroy handles it:** `destroySessionSerialized` locks the row and short-circuits
only on `destroyed`/`errored`, so `busy` is destroyable. The cost until then is one concurrency slot, since
`countActiveSessions` counts by `destroyedAt IS NULL`.

⭐ **And the "who reaps a genuinely orphaned session" question has FOUR layers, each covering a case the
previous one misses** — which is the most complete failure-mode coverage I have read in this repo:

1. `agent-session-terminal-close` — worker reports a session ENDED → CP closes the row.
2. `cp-daemon-reconcile` — worker reports ACTIVE what the CP holds TERMINAL → CP re-issues `sessionEnd`, because CP→daemon frames are best-effort and a `sessionEnd` sent while the link is down is simply gone.
3. `node-boot-reconcile` — a per-process `bootId` on the heartbeat distinguishes a daemon RESTART from a reconnect. ⛔ **This leg exists because the first two miss a real case**: a daemon that crashes and respawns fast reconnects INSIDE the disconnect grace, cancelling `worker-disconnect-reaper`, so its prior in-memory sessions linger CP-active — billed, holding a slot, phantom in the GUI.
4. A 12h `orphan_reap` as the final backstop.

⚠️ Boundary: established by reading the claim/settle/fail flow, `destroySessionSerialized`, and the four
reconcile headers — **not by killing a control-plane process mid-operation and observing what recovers.**

**Ten audits, one defect.**

## V-1661 — looking for a guard on the MECHANISM can miss a guard on the OUTCOME

V-1657 established that Stripe self-heals partly because `dispatch()` runs BEFORE `recordEvent()`: a
transient failure re-throws, no ledger row is written, and the redelivery re-drives the grant. Claiming the
event first — which reads as sensible concurrency hygiene — would suppress the redelivery permanently.

**So I went looking for what pins that ordering, and concluded it was unpinned. That conclusion was
wrong, and the way it was wrong is the finding.**

Three guards were checked and each genuinely does not pin it:

- `stripe-dispatch-has-no-additive-write` **states the ordering in its title** — "dispatch() runs BEFORE the
  idempotency insert, so a concurrent delivery executes every handler twice" — and its body scans the
  dispatch-path files for additive writes. **The ordering is its PREMISE, never its assertion.** ⭐ Which is
  correct design, not a defect: it guards the COST of the ordering, which is the part that rots.
- `services-stripe-webhooks-content-parity` pins the `hasEvent` short-circuit, the `if (!inserted)` block,
  and the race comment verbatim. ⚠️ **The comment gives no incidental protection**: "a concurrent delivery
  could insert the same row between our hasEvent check above and this insert" stays true if the order flips.
- `stripe-webhooks-v089-adr003-cross-source-invariant` pins the two-responsibility framing, not the sequence.

⛔ **And then the guard turned up somewhere I was not looking.**
`integration/stripe-webhooks-mutations.test.ts`:

    it('a transient error during handling → 500 + NO ledger row, and a Stripe re-delivery then heals')

**That is the property, tested end to end against a real Postgres, and it never mentions the ordering at
all.** It asserts the consequence the ordering exists to produce. Claiming the event before dispatch would
leave a ledger row on the throwing path and fail it.

⭐ **The lesson is the inverse of V-1647.** There, an arm's TITLE claimed a relationship its body did not
test. Here, a guard tests a property its title never names — and I missed it because I searched for the
mechanism (`recordEvent`, `dispatch`, "before") rather than for the outcome ("no ledger row", "re-delivery
heals"). **A grep shaped like the implementation cannot find a test written in terms of behaviour**, and
behaviour is how the better tests are written. Fifth time today that opening prior art changed a conclusion.

⚠️ Applied to my own work in the same pass: `a-derived-identity-must-be-persisted-before-it-is-used`
(V-1654) is a MECHANISM guard — it pins the await and the order. Checked whether a behavioural guard already
covered that outcome; **it does not**, so the guard is not redundant. But recorded as a known limit: an
integration arm asserting the customer id is persisted before the checkout URL is returned would be
stronger than pinning two statements' order.

⚠️ Boundary: the three negatives and the positive were established by READING the four files. A mutation
probe moving `recordEvent` above `dispatch` is queued to confirm the integration arm actually fires;
this entry records what reading established, not what the probe returned.

## V-1662 — the probe V-1661 queued, and the first attempt that could not have answered

V-1661 recorded, from reading, that the `dispatch()`-before-`recordEvent()` ordering is guarded by
`integration/stripe-webhooks-mutations.test.ts` — _"a transient error during handling → 500 + NO ledger row,
and a Stripe re-delivery then heals"_ — a guard written in terms of the OUTCOME, which is why a search
shaped like the implementation missed it. This is the confirmation, and the first attempt at it is worth
recording too.

⛔ **Attempt one was CONFOUNDED and I nearly read it as a pass.** Moving `dispatch()` below `recordEvent()`
left `recordEvent({ …, result: outcome })` referencing `outcome` before its declaration. **The mutated
source did not compile** — 8 files and 60 tests failed, including `the-server-source-type-checks`. Four of
them were the files I expected, so the shape of the result looked like confirmation. **It was not: a
temporal-dead-zone crash fails those tests for a reason that has nothing to do with the ordering
property.** A mutation that breaks compilation tests the harness, not the hypothesis.

**Attempt two is the refactor a person would actually write** — claim the ledger row first with a
placeholder result, dispatch after — and it compiles cleanly:

    Test Files  1 failed | 3210 passed (3211)
    FAIL  |node| apps/server/tests/integration/stripe-webhooks-mutations.test.ts

⭐ **Exactly one file, and exactly the predicted one.** The peer's three in-flight gui failures had cleared
between the two runs, so the baseline was clean and the attribution is unambiguous. Source restored
byte-identical.

**So the ordering is guarded, by the outcome rather than the mechanism, and the guard fires.** V-1661's
reading stands.

⭐ **Two method notes, both earned here.** A mutation must be checked for compilation before its result is
read — otherwise "many things failed" reads as confirmation when it is noise. And **a prediction naming the
specific file is what made the second run interpretable**: "one failure, in `stripe-webhooks-mutations`" is
a claim that could have been wrong, where "several things failed" could not.

## V-1663 — sixteen frame types, three identity mechanisms, and no case using none

Eleventh audit, applying the question that found V-1649 to the surface it had not reached: **the fleet/node
WSS boundary.** A daemon reports session state over a socket; the identity question is whether node A can
report for node B.

**What made this worth doing: the consumer code reads `frame.macNodeId` — the node id from the PAYLOAD.**
`bootstrap.ts` calls `recordHeartbeat(frame.macNodeId, …)`, reconciles orphans with
`macNodeId: frame.macNodeId`, and sends `sessionEnd` via `registry.get(frame.macNodeId)`. Read alone, that
is a node asserting its own identity and being believed.

**It is checked, once, at the frame router, and the comment names the threat:**

    case 'heartbeat':
      // SECURITY: cross-check the frame's self-reported macNodeId against this
      // connection's JWT-authenticated nodeId — a mismatch (bug or spoof) must
      // NOT touch another node's liveness/telemetry, so drop it.
      if (frame.macNodeId === this.nodeId) { this.onHeartbeat?.(frame); }

So by the time any consumer sees the field it IS the authenticated identity.

⭐ **The completeness check is the part worth keeping. Sixteen frame cases, three mechanisms, and every case
uses exactly one:**

- **1 validates** the self-reported id against the connection (`heartbeat`).
- **7 pass `this.nodeId`** to the consumer instead of letting it read the frame — `sessionStatus`,
  `profileSaved`, `challengeDetected`, `pageState`, `profileSaveFailed`, `capabilityReport`, `errorEvent`.
  `errorEvent`'s comment goes further: the consumer "atomically verifies this authenticated node is still
  the persisted session owner".
- **8 are request/reply correlator results** — `cookiesResult`, `setCookiesResult`, `intentResult`,
  `navigateHistoryResult`, `uploadResult`, `downloadsList`, `downloadData`, `trimResult`. Verified rather
  than taken from the comment: the correlator's `pending` map is **per-instance, so per-connection**, and
  each pending entry stores the `sessionId` it was issued for "so onResultFrame can drop a result frame
  whose sessionId disagrees (cross-session spoof guard)". **Two layers, not one.**

**No case does none of the three**, which is the property I actually wanted and could only get by
enumerating the switch.

⚠️ One observation of the V-1649 class, offered as a preference rather than a defect: `heartbeat`
**validates then trusts the frame field**, while seven siblings **pass the authenticated id**. Both are
correct today. The second is structurally safer — a consumer handed `this.nodeId` cannot accidentally read
the payload's, whereas the heartbeat consumers' safety depends on a check in a different file. Left alone;
the check is explicit, commented, and adjacent to the threat it names.

⚠️ Boundary: established by reading the router switch, one correlator implementation, and the bootstrap
wiring — **not by connecting a second node and attempting to spoof the first.**

**Eleven audits, one defect.**

## V-1664 — a guard's regex misses four localhost defaults, and it does not matter

Twelfth audit, on a question the identity axis had not asked: **which config values silently default to
something wrong in production?** The classic shape — a developer fallback that is invisible until a
customer's inbox contains a `localhost` link.

**A guard exists** — `deploy-templates-define-every-localhost-defaulted-var` — and its detector is:

    /env\.([A-Z][A-Z0-9_]*)\s*\?\?\s*'([^']*(?:localhost|127\.0\.0\.1)[^']*)'/g

⛔ **That is one spelling, and `config.ts` contains a second.** The regex finds two (`DATABASE_URL`,
`REDIS_URL`). It cannot see **four** more, written as zod schema defaults:

    verifyEmail:   z.string().url().default('http://localhost:5173/verify-email')
    magicLink:     z.string().url().default('http://localhost:5173/auth/magic-link')
    passwordReset: z.string().url().default('http://localhost:5173/reset-password')
    (plus the bare origin)

**All four are customer-facing auth URLs.** And the chain to reach them is real, not theoretical: the
effective resolution is `env.AUTH_VERIFY_EMAIL_URL ?? fromOrigin('/verify-email')`, and `fromOrigin`
returns **`undefined`** when `DASHBOARD_ORIGIN` is unset — **which is exactly what a zod `.default()` fills
in.**

⭐ **And it does not matter, because the protection is somewhere I was not looking.** `config.ts` refuses to
boot in production if any resolved auth URL contains `localhost`, AND refuses to boot if `DASHBOARD_ORIGIN`
is unset — with the comment naming the precise chain I had just traced: _"the zod default would otherwise
land on the localhost fallback and the CLI-authorize browser URL would point there."_

**So the guard's regex is not wrong; it guards a different mechanism.** `env.X ?? 'localhost'` is a value
that ships silently, so it is checked against the deploy templates. A zod default is a value that ships
**loudly** — the boot refuses — so it needs no template entry. **Two mechanisms, each matched to how its
failure would present.**

⚠️ **Sixth time today the protection was not where I searched**, and the pattern is now stable enough to
state as a rule: **searching for one mechanism finds gaps that are not gaps.** V-1661 was the same shape (I
searched for a guard on an ordering; the guard was on the outcome). The correction is cheap — before
reporting a gap, ask what the failure would LOOK like and search for that instead.

⚠️ Boundary: established by reading `config.ts`'s resolution chain and its production block — **not by
booting with the variables unset.**

**Twelve audits, one defect.**

## V-1665 — re-checking a known past defect class: staff bulk ops on customer-gated methods

Thirteenth audit, and the first chosen by APPLYING V-1664's rule rather than recording it: **ask what the
failure would look like, then search for that.** The failure: _a staff action that gates on the ACTOR's
identity instead of the TARGET's_ — an admin operation reusing a customer-facing method whose scoping is
"my account", so the bulk op silently touches the wrong rows or spares the right ones. It is a class this
repo has been bitten by before, and past classes are worth re-checking because they regress.

**It is closed, and closed in three distinct places rather than one:**

⭐ **1. A separate admin method exists precisely because the customer one carries an exclusion.**
`DeleteWebSessionReclaimer.revokeAllWebSessionsForAccount(accountId, now)` documents the trap in its own
doc: _"Bulk-revokes every dashboard web session for the account (**no exclusion — contrast with the customer
'sign out everywhere else' flow, which keeps the calling session alive**)."_ Reusing the customer method
here would have left the deleted account's own session alive through a GDPR erasure.

**2. Authorization and target are separate parameters, and used separately.**
`revokeAllForAccount(ctx, accountId)` gates the CALLER with
`throwIfMissingScope(ctx, 'driftstack_internal_admin')`, then selects the TARGET with
`listApiKeys(accountId)` and `revokeChecked(ctx, key.id, accountId)` — which passes `accountId` down into
`revokeApiKeyAtomic`. **The ctx never selects rows; the accountId never authorizes.** Traced to the atomic
revoke rather than stopping at the signature.

⭐ **3. A completeness catch I would not have thought of.** `revokeAllMintedByAccount(ctx, minterAccountId)`
exists with the note _"V-727 — keys this account minted on OTHER accounts, which the by-account reclaim
above cannot see."_ A by-target sweep cannot find keys this account created elsewhere. Somebody enumerated
the directions rather than the tables.

⚠️ Boundary: established by reading the admin service's interfaces and following one revoke to
`revokeApiKeyAtomic` — **not by running a bulk op against a seeded pair of accounts.**

**Thirteen audits, one defect.** The rule from V-1664 picked the target this time, and it picked a good one:
searching for the _appearance_ of a failure led to a class with real history, where searching for a
mechanism would have led to whichever method name I happened to guess.

## V-1666 — "tree unchanged" is not "run uncontended", and a 173ms test timed out at 10s

A full gate came back **1 failed | 3211 passed**, with my hardened runner reporting _"tree unchanged across
the run — result is trustworthy"_. The dirty tree held only `CLAUDE.md` and `OPEN-ITEMS.md`, so there was no
peer work in flight to attribute it to. **By every check I had, this was a real red in committed code.**

**It was not a defect, and the failure text says so if you read past the test name.**

    FAIL  db-recipes-encryption-drizzle.test.ts > CRITICAL list clamps an oversized limit…
    Error: Test timed out in 10000ms.

⭐ **A TIMEOUT, not an assertion.** Run standalone: **5 tests, 173ms of test time, 590ms wall.** A test that
finishes in 173ms was starved past ten seconds. And the gate's own duration told the same story —
**409s against a ~250s baseline, 64% slower** — which I had not looked at because the tree-fingerprint had
already said "trustworthy".

⛔ **So my harness verified the wrong invariant.** V-1666's predecessor made the gate refuse a
non-quiescent tree and fingerprint files before and after, which closed "a peer WROTE during my run". It
does not close **"a peer RAN during my run"** — and CPU starvation does not change a single byte on disk.
**Two different ways a concurrent peer invalidates a result, and I had built for one and declared victory.**

**Fixed by measuring the thing that actually moves under contention:** the runner now reads the suite
duration out of the log and, past a 350s threshold against the ~250s baseline, prints that the run was
contended and that any timeout in it must be re-run standalone before being believed. ⭐ **Duration is the
right signal because it is affected by exactly what the fingerprint cannot see.**

⚠️ And the peer's rule was the one that resolved it: _when a `db-_` integration file fails in a full gate,
run it standalone before believing it.\* I had recorded that rule and still spent the first minute treating a
trustworthy-labelled red as real — **because my own harness had put the word "trustworthy" on it.** A
verdict from an instrument is worth exactly the invariants that instrument checks, and mine was checking
one of two.

## V-1667 — the last uncovered page clamp, found by batch mutation

A timed-out test's own title carried someone else's finding: _"This clamp had NO coverage of ANY kind:
removing it left the entire suite green — 28,015 passed, not even a source-text pin noticed. Its two
siblings (profiles, profile-snapshots) at least had pins."_ **That is a method, not just a note** — so I ran
it against the siblings.

⭐ **Batch mutation makes it affordable.** Five `Math.min(limit …)` page clamps exist. Rather than one suite
run per clamp, **neutralise several at once in ONE run**: green means every mutated clamp is uncovered, red
means binary-search. Two candidates, one 213s run:

    admin-accounts clamp   →  4 files failed (content-parity, cross-source, drizzle, repo-contract)
    atlas-priority clamp   →  0 failures — the mutation SURVIVED

**So `atlas-priority-events-repo.listRecent`'s clamp had no coverage of any kind.** The route in front
carries `z.coerce.number().int().min(1).max(1000)`, so it is defence-in-depth — but a caller reaching the
repo directly would pull the customer's whole event table.

⚠️ **I predicted before reading and was right in direction, wrong in depth**: I expected admin to fail the
ONE content-parity pin I had found. It failed four. **A prediction wrong in the safe direction is still
information** — that clamp is guarded four ways, which is why nobody has broken it.

⛔ **A substring trap on the way, and it produced a second finding.** Grepping `MAX_PAGE` to check the
profiles sibling returned five files — **all matching `DESTROY_RECONCILE_MAX_PAGE`**, a different constant.
Reading the real pin: `expect(body).toMatch(/export const DEFAULT_PAGE = 50;\s*export const MAX_PAGE = 100;/)`
— **it pins the constants' VALUES, not their USE.** Deleting the `Math.min(...)` while leaving the constants
declared would pass it. Recorded rather than fixed: a weaker pin, not a hole, since the route bounds that
path too.

**Covered behaviourally rather than by a source pin**, following the recipes precedent: seed 1001 rows in
one `generate_series` statement, then assert **both halves** — `limit: 5000` clamps to 1000, and `limit: 0`
raises to 1. ⭐ The second assertion is the one a `Math.min`-only clamp would fail, and mutation confirms it:
removing the ceiling gives `expected 1001 to be 1000`; removing the floor gives `expected +0 to be 1`.

⛔ **And the baseline caught my own fixture THREE times before either mutation was trustworthy.** Run
unmutated first, every time:

1. `status: 'pending'` violated a CHECK constraint — the allowed set is
   `emitted|queued|bs_in_flight|bs_succeeded|bs_failed|atlas_appended|atlas_failed`.
2. 1001 identical rows violated `UNIQUE (op_seq_sha, archetype_id, emitted_at)` — a real dedup triple my
   fixture ignored by being unrealistic.
3. Only then: 12 passed, and the mutations meant something.

**Three consecutive runs where "1 failed" looked identical and meant three different things.** Had I read
only the mutations, all three would have looked like the guard working.

## V-1668 — a guard caught my own new test, and my regex was biased against large numbers

Extending V-1667's batch-mutation method from repo clamps to **request-schema `.max()` bounds**. Three
results; two are about my instrument and one is about a guard finding me.

**1. Request-schema bounds are well covered — the opposite of the clamp result.** Neutralising 92 of them
in one run: **52 files, 89 tests failed.** There is a dedicated
`admin-routes-list-query-defensive-caps-cross-source-invariant`, and a
`published-request-schema-is-not-looser-than-enforced`. I predicted red after finding a single pinning
test, and red it was. **The clamp gap was specific, not symptomatic.**

⛔ **2. My enumeration regex was `\.max\((\d+)\)`, which cannot match `.max(1_000_000)`.** Five bounds
were silently skipped, and they are **exactly the money ones**: a pricing ceiling, an LLM budget cap, a
crypto price cap, and two agent-session limits.

⭐ **That is a SYSTEMATIC bias, not a random miss.** The `1_000_000` convention exists _for_ large numbers,
so a `\d+` regex is biased against precisely the highest-value bounds. Every instrument fault today has
been "narrower than the question"; **this one is narrower in a direction that correlates with importance.**
Mutated separately: 9 files, 10 tests — all five are covered.

⛔ **3. A guard caught MY new test, for the exact vacuity it exists to prevent.** The BASELINE of that run
came back `1 failed`, uncontended at 196s — a real red, and mine:

    an-integration-test-cannot-pass-without-its-database
    "these bail out when the service is missing and never assert it was present, so with the
     describe running and the service down they report PASSED"
    → ["atlas-priority-events-end-to-end.test.ts"]

V-1667's clamp arm opens `if (!client || !repo) return;` while that file's presence arm asserted only
`app`. **So with the database down, a brand-new clamp test would have reported PASSED having asserted
nothing** — the `115 skipped` shape, in a test I wrote an hour after recording that lesson. Fixed by
extending the presence arm to `client` and `repo`; guard 4/4 and the file 12/12 afterwards.

⭐ **What caught it is the part worth keeping: not my mutation and not my review, but a guard someone else
wrote, running as the BASELINE of an unrelated experiment.** I would never have run it deliberately — I did
not know it existed. **That is the argument for baseline-first as a habit rather than a rule about
mutations: the baseline runs everything, including the guard that has an opinion about the file you just
added.**

## V-1669 — the coverage gate cannot see the directory my one real gap was in

Two results. The second explains the first finding of the day.

**1. Error paths are broadly covered.** Rethrowing every swallowing `catch { … return … }` failed **34
files, 44 tests**. So the `catch`-swallows-and-returns class is exercised, unlike the repo clamp class.
⚠️ Two honesty notes: my regex body was `[^{}]{0,120}`, so it matched **33 of the 49** — catches with nested
braces were skipped; and the mutated tree raised **three `TS6133` unused-variable errors** (helpers left
dangling once their only caller stopped swallowing), so the run is partly confounded in the V-1662 sense.
It is `noUnusedLocals` only and vitest transpiles without typechecking, so the behavioural signal stands —
but the batch is not a clean instrument and I am not claiming a number from it beyond "broadly covered".

⭐ **2. And then the coverage config answered the question I had actually been circling all evening.**
`vitest.config.ts` **excludes `apps/server/src/db/` from the coverage gate**, and its own comment says the
justification "has expired": the V-086 audit recorded those repos as "exercised by e2e against real
Postgres, not by vitest", and **135 integration files now import from `src/db/` and run under vitest
whenever `DATABASE_URL` is set.** 54 source files sit outside the gate on a reason that stopped being true.

⛔ **Every one of the five page clamps lives in `src/db/`.** The clamp with no coverage of any kind
(V-1667, `atlas-priority-events-repo`) was in the one directory the coverage gate cannot see. **That is the
causal story for the day's only real gap**: not that nobody cared, but that the instrument which would have
noticed had been pointed away.

⭐ **And it is already measured, by someone else, sitting on a decision.** V-1002 lifted the exclusion under
CI's own conditions and reports lines 92.29 / statements 90.74 / functions 90.94 / branches 81.74 against
thresholds 85/83/84/75 — **every threshold still passes, with 6.7 points of headroom on the tightest.**
Including `src/db` costs at most 1.30 points (branches) and IMPROVES functions by 0.14. The note ends:
_"The blocker was the number, and the number says removing this line is free — but changing what CI enforces
is still a decision somebody makes, not one a measurement makes for them."_

**Added to the decision memo as a ninth item.** It is the cheapest of the nine — the measurement is done,
the headroom is known, and the only missing input is somebody deciding that CI should enforce it.

⚠️ Boundary: the 92.29/90.74/90.94/81.74 figures are quoted from V-1002's note, **not re-measured here** —
re-running coverage with the exclusion lifted would cost a full instrumented suite run and would not change
what the decision needs.

## V-1670 — the compensating guard is coarser than the risk it compensates for

V-1669 found that the coverage gate excludes `apps/server/src/db/`. This closes the chain, and the answer
is structural rather than an oversight by anyone.

**Three facts, each individually defensible, landing in the same place:**

1. `vitest.config.ts` leaves `apps/server/src/db/**` out of coverage, on grounds its own comment records as
   expired.
2. ⛔ **`verify-suite --all` is CI job `build-test`, which does not run the e2e job at all** — so the
   directory the coverage gate declines to measure is also the directory the unit gate never reaches. I had
   only found the first of these.
3. **A compensating guard exists** — `every-drizzle-repo-is-driven-against-a-real-postgres` — and its header
   states the situation exactly: _"measured by neither gate, so this asserts the one thing that still holds
   it: every repo class is constructed by an integration test."_

⭐ **And that is the gap, precisely: the compensating guard asserts CLASS CONSTRUCTION, not line
execution.** `DrizzleAtlasPriorityEventsRepo` **is** constructed by `atlas-priority-events-end-to-end` — so
the guard was satisfied, correctly, by its own terms — while `listRecent`'s limit clamp inside that class
was never executed by anything. **A defensive line inside a constructed class is measured by nothing at
all.** That is the complete causal story for V-1667, and it is not that anyone was careless: it is that the
substitute for coverage operates one granularity coarser than the thing coverage would have caught.

⚠️ **Two corrections to what I told the owner in the memo.**

**"One line of config" was wrong.** Removing the exclusion fails **three guards** that pin the config —
`a-gate-that-does-not-name-its-blind-spot-reads-as-total`, `a-workspace-declares-what-its-source-imports`,
and `workspace-vitest-config-content-parity`. Measured by removing the line and running the suite: 3 failed,
3209 passed. It is a coordinated change, not a one-liner — and the first of those guards exists precisely to
stop a gate quietly widening its blind spot, so its failing is the system working.

**And the per-line enumeration I set out to produce does not exist.** The instrumented run wrote no
`coverage-final.json`; vitest cleans `coverage/` at start and my reporter flags did not produce the
artifact. ⚠️ **A side effect worth stating: that cleaning destroyed the pre-existing coverage directory**
(dated a day earlier). It was untracked and regenerable, so no repo impact — but I removed a workspace
artifact while probing, and would not have noticed if I had not gone looking for the file.

**So the finding stands on reading, not on a coverage measurement**: the chain is established from the
config, the CI job, and the compensating guard's own stated scope.

## V-1671 — the blind region surveyed: one gap, not a pattern

V-1670 established that `apps/server/src/db/` is measured by neither gate and that its compensating guard
works at class granularity. **The obvious inference is that the region is full of holes. It is not, and
saying so matters more than the finding that started it** — an overstated item nine would be a worse
outcome than an unaddressed one.

**Four classes of defensive construct, batch-mutated in the blind region and elsewhere:**

| class                                       | population | result                                        |
| ------------------------------------------- | ---------- | --------------------------------------------- |
| repo page clamps                            | 5          | ⛔ **1 uncovered** (atlas) — closed in V-1667 |
| account-scoping predicates in UPDATE WHEREs | 20         | 18 files / 24 tests react                     |
| swallowing `catch { … return }`             | 33 of 49   | 34 files / 44 tests react                     |
| request-schema `.max()` bounds              | 97         | 52 files / 89 tests react                     |

⭐ **The account-scoping result is the strongest and the one I most expected to find a hole in.** Dropping
the `accountId` predicate from all twenty account-scoped UPDATEs fails a guard literally named
`db-repo-account-ownership-boundary`, plus `db-profiles-repo-tenant-scope-drizzle`,
`db-sessions-repo-tenant-scope-drizzle`, web-session revoke, and four repo-contract tests. **The region's
ownership boundary is verified by dedicated tests that exist precisely because coverage does not reach
there.**

**So the honest shape of the finding: the coverage exclusion is a LATENT risk, not an active hole.** The
compensating mechanisms — integration tests, repo-contract tests, ownership-boundary guards, content-parity
pins — cover the region well. The atlas clamp slipped through for the specific structural reason in V-1670:
it is a defensive LINE inside a class the guard only checks is CONSTRUCTED. **One gap of that shape was
found; three other classes came back covered.**

⚠️ **Recorded because it changes what the owner should expect.** Item nine buys visibility and closes a
class of future gap; it does not uncover a backlog. Anyone lifting the exclusion expecting to find
neglected code will find the opposite, which is worth knowing before rather than after.

⚠️ Boundary, and the same one twice: two of these batches (catches, account predicates) left `TS6133`
unused-variable errors in the mutated tree — helpers and parameters orphaned by the mutation. That is
`noUnusedLocals` only and vitest transpiles without typechecking, so the behavioural signal stands, **but
neither batch is a clean instrument and no number here is claimed beyond the direction it points.**

## V-1672

**The Playwright e2e surface, audited end to end — no defect, and one arm of mine reverted as redundant.**

V-1670 noted in passing that `verify-suite --all` is CI job `build-test`, which does not
run e2e. Read as "a third body of tests nothing gates", that is wrong in every part, and
each part was checked rather than reasoned about:

- **Collected.** 40 `.spec.ts` on disk; `playwright test --list` reports 229 tests in 40
  files. Nothing orphaned. (Boundary: `--list` enumerates, it does not execute.)
- **Run.** `ci.yml` job `e2e` runs `npm run test:e2e` on every push and pull_request to
  main — no path filter, no `if:`, no `continue-on-error`, with Postgres and Redis
  services. Blocking. This is unlike `gui-build-check.yml`, which V-1656 found path-filtered.
- **Cannot pass vacuously.** 0 unconditional-skip idioms and 0 early `return;` across all
  40 specs. The detector was positive-controlled first: against four planted idioms it
  matched 4/4, so its zero on the real specs means absence, not a broken regex. The harness
  defaults `DATABASE_URL` rather than testing for it, so a missing database is a `beforeAll`
  error, not a skip.
- **Protected against future skips — proven, not derived.** `no-permanently-skipped-tests`
  filters on `/\.(test|spec)\.tsx?$/`, which reads as covering e2e. Reading a regex is not
  evidence, so an unconditional skip was planted in a real e2e spec: the guard failed and
  named `apps/server/tests/e2e/webhooks.spec.ts:89`. Restored byte-identical.

**The blind spot was already named.** `a-gate-that-does-not-name-its-blind-spot-reads-as-total`
exists for exactly this and states the figure I independently re-measured today — the same
40 files and 229 tests — so that pin has not rotted.

**Retraction.** I added an arm holding that file's stated spec-file count against an fs
scan, on the belief the figure was prose nothing enforced. It is enforced: an existing arm
derives the count from disk and compares it against both `scripts/verify-suite.mjs` and
that guard file itself. My arm was fully redundant and is reverted byte-identical (12 `it(`,
12 passing, `git status` clean). I found the duplication because a mutation that should have
failed one arm failed two.

**Why I missed it.** I grepped the literal values to ask whether they were enforced. A grep
for `40` cannot find the code that computes `specs.length`, and the file's header sentence
saying its counts "cannot be derived here" is scoped to the three _test_ counts, which need
browsers and a Go toolchain. I extended that sentence to the _file_ count, which the very
next arm derives. Asking "is this number enforced?" is a search for the subject, never for
the value — and a guard file's arms must be enumerated before one is added to it.

## V-1673

**Was V-1649 the only UPDATE that moves a row between accounts? Yes — and the sweep that
established it was wrong twice before it was right.**

V-1649 removed `accountId` from `withOrderLock`'s `.set({…})`. That fixed a named file. The
class question — does any other UPDATE assign an ownership column — was never asked, and
the guards that look adjacent do not answer it: `db-repo-account-ownership-boundary` has
thirteen arms and every one is WHERE-predicate enforcement, which a SET clause is invisible
to, because the account issuing the UPDATE is the legitimate owner.

**Two instrument failures, both caught before the result was believed.**

1. The first scan reported 3 hits, all false. It matched `args.customerId` (a _value_, where
   the key was `stripeCustomerId`) and `accountId` inside a _nested_ object — the AAD handed
   to `encryptForStorage`, not a column. Rewritten to read only keys at payload depth 1.
2. The rewritten scan reported a clean 0 — while checking one ownership column of eleven.
   Its column list was hand-written and guessed: `ownerId`, `teamId`, `createdBy`. The schema
   says `ownerAccountId`, `memberAccountId`, `createdByAccountId`. Six of seven names matched
   nothing. **A guessed population produces a zero indistinguishable from a real one.** The
   list is now derived from `schema.ts` — every uuid column that is a FK to `accounts.id`.

**Positive control.** The detector was run against the pre-fix blob from `c4a27e473^`, real
code that really contained the defect. It found it at line 245. A zero from an unproven
detector is not evidence, and this one is now proven on a true positive rather than a plant.

**Result, with its boundary.** Across all `.ts` under `apps/server/src`: 136 Drizzle updates
take an object literal — none assigns an ownership column. 6 build the payload as a variable
(`bundled-llm`, `auth`, `webhooks`, `atlas-priority-events`, `profiles`×2); all 26 keys they
assign were enumerated and none is an ownership column. No Drizzle updates exist outside
`apps/server/src`. So V-1649 was the sole member and that fix was class-complete.

**Pinned.** `an-update-may-not-move-a-row-between-accounts` scans both shapes and derives its
columns from the schema, so a new ownership column is covered the day it is added rather than
the day someone remembers this file. Mutation-proved by reintroducing the real V-1649 line
into `crypto-orders-repo.ts`: exactly one arm failed — the predicted count, which is also how
I know nothing already covered it — and it named the file and column. Restored byte-identical.

**A defect in the guard itself, found by the same discipline.** It first reported line 247 for
a payload that opens at 264: stripping comments deleted lines and shifted every number by 17.
Comments are now blanked in place, preserving newlines and offsets, and the reported line is
the payload's own. A guard that names the wrong line sends the reader where the defect is not.

## V-1673b

**Correction to V-1673 — the hand-rolled comment stripper was itself the defect it described.**

V-1673 recorded that I found and fixed a line-drift bug in my own `stripComments`. The full
suite then failed `no-guard-strips-comments-by-hand`, naming my file as the sole offender: a
canonical `codeOnly` helper exists at `tests/unit/_helpers/code-only.ts` and a guard requires
it. Reading it, the drift I "found" is V-1254 — already discovered, already fixed there, in
the same words ("named a line that did not contain what it had found").

The helper also handles two failures my version had and I had not thought to look for: a `/*`
inside a LINE comment, which the naive block-comment pass treats as an opener and which
deleted 7962 characters including the imports in one real route file — eighteen files under
`apps/server/src` carry that shape — and a quote inside a regex literal, which opens a string
that never closes, after which every comment survives and the guard silently matches prose
again. My version would have gone quietly wrong on both.

Swapped to `codeOnly`; re-proved by the same mutation, which still names
`crypto-orders-repo.ts:264` and still fails exactly one arm. The lesson is the one from this
morning in a new place: I reached for a local helper without asking whether the repo already
had one, and rediscovering a solved bug is the cheap outcome — shipping the two I did not
rediscover was the expensive one.

## V-1674

**Three suite reds that read as a repo defect are one unapplied local migration.**

A full run showed 33 failed files / 67 failed tests. Attribution first, before any
investigation: 22 files and 47 tests are content-parity guards over `customer-dashboard`
pages that a peer had dirty in the shared tree — confirmed by running only the 195 tests
that reference that app, and later confirmed by the peer directly. Four were left.

Of those, `no-guard-strips-comments-by-hand` was mine and is fixed in V-1673b. The other
three are `db-schema-matches-the-migrations-drizzle`, `db-team-invite-single-use-drizzle`
and `db-team-members-role-change-drizzle`, and their message is
"table teams is declared but not migrated" — which reads as exactly the defect it is not.

Measured: 114 migrations applied, 115 on disk, `to_regclass('public.teams')` NULL. The
local database is one migration behind. `0114_teams_entity.sql` is committed, does create
the table, and landed in `fa4df20a1` alongside the schema declaration. CI migrates a fresh
database, so `build-test` is unaffected. Nothing in the repo is wrong.

**Not applied deliberately** — a peer's gate was running, and moving the schema under an
in-flight suite produces failures far more confusing than the three it would fix. Reported
to the owner instead.

**The instrument failed first, again.** Asking whether a migration existed, I grepped
`apps/server/drizzle/*.sql` — a directory that does not exist — and got a clean zero I was
one keystroke from reporting as "no migration creates teams". They live in
`apps/server/src/db/migrations/`. A zero from a wrong path is byte-identical to a zero from
a right one, and the only thing that separates them is checking that the search space is
real before believing what it returns. Third instance today, after a guessed column list
that checked one column of eleven and a literal-value grep that could not see a derivation.

## V-1675

**The other half of identity provenance: ownership is never ACCEPTED from client input either.
Closed, and deliberately not pinned.**

V-1673 closed the update side — no UPDATE assigns an ownership column. The sibling question
is the more dangerous one: can a caller CREATE a row owned by someone else? Four independent
facts say no, each measured rather than reasoned:

- **No request schema declares an ownership field.** Zero across 24 files and 59
  `*RequestSchema` definitions in `packages/api-types/src`, against the eleven column names
  derived from `schema.ts`. The anchored pattern finds 32 real fields (`name`, `description`,
  `folder`, `tags`) in the same files and matches a planted `accountId:`, so the zero is
  absence and not a broken anchor.
- **No handler reads one from client input.** Zero `body.<ownership>` / `query.<ownership>`
  across `routes/` and `lib/`; the pattern matches a planted `req.body.accountId`.
- **Unknown keys are stripped**, which is zod's default for `z.object`. The six
  `.passthrough()`/`.catchall()` uses are a nested `pair_mode_state`, the problem-details
  schema, the harness control protocol and two openapi document builders — no top-level
  customer request body among them.
- **Nothing spreads a body into a write.** Zero `.insert(…{...body})` / `.set(…{...body})`;
  the pattern matches a planted spread.

The TypeScript SDK never references an ownership field either, so no client sends one today.

**No guard added, on purpose.** V-1673 earned one because its defect was a ONE-LINE drift
inside an existing construct — adding `accountId:` to a `.set({…})` that is already there,
which is exactly how V-1649 happened. Reaching this class needs three coordinated changes in
three files: declare the field, read it, and write it. A guard here would pin a convention
that cannot slip quietly, and the cost of guards that pin already-safe defaults is not zero —
three of the things I reached for today were redundant with something already in the tree,
and each one had to be found and reverted. Recorded so the next sweep can start from the
measurement instead of repeating it.

## V-1676

**The CLI device-authorization flow, audited end to end. Sound — and it is the worked example
of the property V-1649 was missing.**

Device-code flows fail in a small number of well-known ways, and each was checked against the
source rather than assumed:

- **Code entropy.** The device `code` is `randomBytes(32)` as base64url — 256 bits, and it is
  the Redis key, so guessing it is the whole attack and it is not available. The `user_code`
  is 40 bits over a 32-character alphabet with the ambiguous glyphs removed (no I, O, 0, 1),
  which is a UX decision that costs nothing here because the user code is only ever checked
  inside `bind`, which already requires the 256-bit code.
- **The user code is never stored.** Redis holds `sha256(domain || normalized(user_code))`,
  so a Redis read does not yield something a caller can present.
- **Identity is DERIVED, not accepted.** This is the V-1649 question asked of a different
  subject and answered correctly: the bind route runs behind `app.requireAuth` and passes
  `account_id: acc_${ctx.account.id}` from the authenticated context — the request cannot name
  an account. It also throws explicitly if the context is missing after `requireAuth`, so the
  fallback is a crash rather than an unowned bind.
- **The secret is bound to that identity cryptographically.** The minted key is encrypted
  before it enters Redis with AAD over code + state + user_code_hash + account_id, and
  `exchange` decrypts with those values read from the STORED record — never from its input.
  A swapped or replayed field fails the decrypt, which surfaces as `expired`, not a 500.
- **Both races are atomic.** `bind` uses a compare-and-set against the exact bytes it read, so
  two concurrent binds cannot both win, and the route revokes the losing racer's just-minted
  key. `exchange` uses `getDel`, so of two concurrent bound polls exactly one receives the
  key. It then re-checks that the claimed bytes equal the peeked bytes and still describe a
  bound record, failing closed rather than delivering a swapped secret.
- **Comparisons are constant-time**, and pre-v2 blobs are consumed as expired rather than
  dual-read without identity binding.
- **TTLs** are 5 minutes pre-bind and 2 minutes post-bind, and both `initiate` and `exchange`
  are IP rate-limited, which is what makes the 40-bit user code a non-issue.

**Boundary.** This audit covers `services/cli-authorize.ts` and `routes/auth-cli.ts`. The
dashboard consent page that calls bind is a peer's surface and was dirty in the shared tree
throughout; I did not read it, so nothing here is a claim about the browser half of the flow.

No defect. Fourteenth end-to-end audit; thirteen sound, one defect (V-1649).

## V-1677

**Suite checkpoint, and a census of every conditional skip — no test in this repo runs nowhere.**

With `DATABASE_URL` and `REDIS_URL` set: **3214 of 3214 files passed, 31,964 tests, zero
failures, 16 skipped**, 249s uncontended. The file count matches `EXPECTED_TEST_FILES_ALL`
exactly, which is the pin I raised by one for the test added in V-1673.

Without those variables the same tree reports 3099 passed and 115 skipped FILES. Both numbers
are green and they are not the same claim — which is the reason `verify-suite` reports skipped
counts at all, and the reason this entry states the environment before the result.

**The 16 skips, by gating condition**, because a skip reads as a pass and an unexamined one is
where things hide:

| Condition                                   | Tests | Runs when                                                      |
| ------------------------------------------- | ----- | -------------------------------------------------------------- |
| `CI && !DATABASE_URL`                       | 133   | any run with a database — ran here                             |
| `RUN_DB_TESTS`                              | 12    | **not an env var** — `Boolean(CI \|\| DATABASE_URL)`; ran here |
| `hasEgressImpl`                             | 7     | derived from source text                                       |
| `CI && !REDIS_URL`                          | 4     | any run with Redis — ran here                                  |
| `NPMRC_EXISTS`                              | 4     | operator machines only, **by design**                          |
| `CLONE_ENABLED` / `IMPORT_EXPORT_ENABLED`   | 3     | when the product flag flips                                    |
| `isSubscribable` / `incidentIsSubscribable` | 3     | derived from event data                                        |

Two of these looked like blind spots and neither is:

- **`RUN_DB_TESTS` is not an environment variable.** It is a local const derived from `CI` or
  `DATABASE_URL`. I took it for a third flag nobody sets and was one step from reporting 12
  tests as unrunnable; reading the declaration was the whole correction.
- **The `.npmrc` guards are operator-side on purpose.** `.npmrc` is gitignored because it
  carries publish credentials, CI has none, and the file says so in a comment dated 2026-05-20
  — "skip the populated-file assertions when the file is absent so CI stays green while the
  local operator-side drift guard still fires." The boundary was documented before I looked.

- **The feature-flag skips are the pattern done right.** `CLONE_ENABLED` and
  `IMPORT_EXPORT_ENABLED` are read from the product source, and a sibling arm pins the literal
  `= false`. When the flag flips, that pin fails — so the dormant behavioural tests cannot flip
  on unnoticed. A conditional skip with nothing watching the condition is the failure mode; this
  is not that.

No finding. Recorded because this is the third audit today where the source already documented
the boundary I was about to report, and the census is worth not re-deriving.

## V-1678

**"The Go SDK has no generator, so it will have drifted." It has not. Go and TypeScript cover
exactly the same 100 spec paths — identical sets, zero divergence either way.**

The premise was reasonable: the TypeScript SDK is hand-written, the Python models are
generated, and Go has no generator at all, so Go is the one place drift has nothing to stop
it. W-7 had already found the TypeScript SDK diverging on 28 documented endpoints, so the
class was live.

Measured against `openapi.json` (196 paths, 232 operations), with both SDKs extracted by the
same method and path parameters normalised:

|                     | paths reached |
| ------------------- | ------------- |
| Go SDK              | 100           |
| TypeScript SDK      | 100           |
| **Go-only**         | **none**      |
| **TypeScript-only** | **none**      |

The sets are identical, not merely the counts — asserted as set equality, with a control that
removes one element and confirms the comparison returns False. Equal sizes are not equal sets
and the check has to be able to say so.

Of the 96 spec paths neither SDK reaches, **61 are `/v1/admin/*`** and 2 are non-`/v1` infra
endpoints, which a customer SDK correctly omits. That leaves **33 customer-facing paths absent
from both** — which is the class already open on the decisions memo as "published endpoints no
client library reaches", not a new finding.

**The instrument was wrong first, for the third time today.** The first extractor read only
`path:` assignments. `profile_snapshots.go` passes its list path as a function argument
instead — `r.listInternal(ctx, "/v1/profile-snapshots", query)` — so the extractor missed it
and reported a Go-only shortfall of 34 paths including a **fabricated divergence**: it claimed
Go lacked `/v1/profile-snapshots` while `ProfileSnapshotsResource` sits in the file. Caught by
checking the one divergence before reporting it. The corrected extractor collects every `/v1/`
literal wherever it appears and follows concatenation chains, and the gap went 34 → 33 with
the divergence disappearing entirely.

The lesson is the day's, in a third costume: **an extractor that models one idiom measures the
code that happens to use it.** `path:` was the idiom I read first, so it became the idiom I
believed in.

## V-1679

**Every production at-rest encryption binds the record it belongs to — and the guard I wrote to
prove it was wrong first, in a way that let a real mutation through.**

`encryptPlatformSecret(plaintext, key, authenticatedContext?)` takes its AAD as an OPTIONAL
third argument and only calls `setAAD` when one is supplied. Omitting one token yields
ciphertext bound to nothing, which decrypts under any record for any account — V-1649 one layer
down, where the row named an owner and the bytes did not agree. The sibling API in this repo,
`encryptPlatformSecretValue(plaintext, key, name)`, takes its binding as REQUIRED. The
difference between a signature that can be misused and one that cannot is a `?`.

**The invariant holds.** Ten call sites under `apps/server/src`; three are context-free and all
three are legitimate:

- `agent-transcript-encryption.ts` **encrypt** — v1 envelopes are context-free by definition and
  this writer has **zero production callers**; the repo writes v2 (which binds) and keeps v1 only
  so tests can manufacture v1 blobs for the migration path.
- `agent-transcript-encryption.ts` **decrypt** — the v1 read path. Stated plainly rather than
  waved through: a v1 row swapped between accounts would decrypt where a v2 row fails its tag.
  The mitigation is finishing the migration, which `convertLegacyAgentSessionTranscript` does on
  access, not weakening v2 to match.
- `webhook-secret-encryption.ts` **decrypt** — the bootstrap-only v1→v2 bridge, which
  re-encrypts bound to the exact record tuple. `readWebhookSecret` throws on anything that is not
  a v2 envelope, so this is a migration step and not a dual-read.

**The guard's first version passed a mutation it should have failed.** Its argument counter
counted commas at depth 0 and added one — so `f(a, b,)` counted as three, and **prettier writes a
trailing comma on every multi-line call**, which is how four of the five real sites are
formatted. Stripping a genuine AAD from `agent-session-transcript-encryption.ts` left the guard
green. Rewritten to count non-empty top-level segments, the same mutation fails naming file,
line and count, and the control arm now pins the trailing-comma shape explicitly.

**And the fix immediately found a site both instruments had missed.** My python sweep carried the
identical bug, so its "exactly two context-free sites" was wrong: the corrected counter surfaced
`agent-transcript-encryption.ts:67` as a third. It is legitimate, but I would have shipped a
guard whose own census was short by one — and the exemption list would have looked complete.

Mutation-proved in both directions: stripping a real AAD reds the main arm; giving an exempted
site a context reds the staleness arm, so an exemption cannot outlive the code it excuses. Both
restored byte-identical. **This guard should be deleted the day `authenticatedContext` becomes
required** — that change costs 46 call-site edits across the tests and enforces at compile time
what this checks at test time.

⚠️ Unrelated and not mine: `tsc -p apps/server/tsconfig.test.json` currently fails on
`tests/e2e/helpers/server.ts:230`, which `git status` shows modified in the shared tree. Attributed
before investigating and reported to its owner. My file contributes zero diagnostics.

## V-1679b

**Extension of V-1679 — the claim was right, the demonstration covered a third of it, and the
guard covered a fifth.**

V-1679 said "every production at-rest encryption binds the record it belongs to" and proved it
for the call sites of ONE helper. Four other modules build their own ciphers and never touch
that helper, so neither the measurement nor the guard could see them. Swept properly — every
`createCipheriv` and `createDecipheriv` under `apps/server/src`:

**10 encrypt sites, 11 decrypt sites.** The invariant holds, by three distinct mechanisms:

1. **AAD passed at the call site** — the `encryptPlatformSecret` sites of V-1679.
2. **AAD applied unconditionally inside the module** — `livekit-secret-encryption` calls
   `setAAD(buildLivekitSecretAad(context))` with no conditional at all;
   `byok-anthropic-encryption` builds its AAD from an accountId it first validates as a UUID and
   lowercases, so a case-variant cannot address a different envelope.
3. **Binding in the KEY, not the tag** — `profile-key-hierarchy` derives a per-account Tenant
   Master Key, `HKDF-SHA256(master, salt = "tenant" || account_id, info = "TMK-v1")`, throwing on
   an empty accountId. A secret wrapped under account A's TMK cannot be unwrapped with B's. Its
   two AAD-free cipher constructions are `wrapSecret`/`unwrapSecret`, whose only two callers both
   pass `deriveTenantMasterKey(masterKey, accountId)` — nothing wraps under the raw master key.

Mechanism 3 is stronger than an AAD, not an exception to it, and the guard now says so rather
than treating the file as an oversight.

**The guard has a new arm covering all three**, mutation-proved by deleting the unconditional
`setAAD` from livekit — a module the original arm is structurally blind to. Exactly one arm
reds, the new one. Restored byte-identical.

**Two more instrument failures in this stretch, both mine, both caught by reading:**

- The sweep that found these sites printed `if (aad)` for source that reads
  `if (aad !== undefined)`, because it displayed only the captured group. I was one step from
  reporting a truthiness weakness — an empty value silently skipping `setAAD` — that does not
  exist in any of the four.
- That same throwaway sweep deleted comment lines before reporting line numbers, so every
  location it printed was short by the height of the header above it. **That is V-1254, the
  identical bug I fixed in a guard four hours earlier** — reintroduced the moment I wrote a
  script instead of a test. The fix is not to remember it; it is that the shared helper exists
  and a scratch script does not import it.

## V-1680

**`authenticatedContext` is now REQUIRED. Omitting an AAD is a compile error; the guard moved
with the signature instead of dying with it.**

V-1679 pinned by test what the type system permitted: `encryptPlatformSecret(plaintext, key,
authenticatedContext?)` accepted two arguments and silently produced ciphertext bound to
nothing. The sibling `encryptPlatformSecretValue(plaintext, key, name)` already proved the
ergonomics — its binding is required — so the parameter is now `string | undefined` rather than
optional, on both encrypt and decrypt.

**Predicted 42 call sites would fail to compile; 42 did**, every one `TS2554`. The prediction was
made by running the corrected argument counter over `src`, `tests` and `packages` first, and it
required excluding three matches that are string literals rather than calls — two
`expect(REPO).toContain('encryptPlatformSecret(')` assertions in a parity test, and the control
string inside the guard itself. A raw count would have predicted 45 and been wrong by exactly
the three things that are not calls.

Each of the 42 now passes an explicit `undefined`, so **deliberate absence is visible in the
call and accidental absence cannot be written at all.**

**The guard was re-pointed, not deleted.** Its header said to delete it the day the signature
changed, and that was wrong: with the parameter required, every call in the repo has three
arguments, so an argument-counting guard would pass everything — including the calls that pass
nothing. The unbound shape is now a literal `undefined` in the third position, and that is what
it flags, against the same three listed exemptions. Mutation-proved by making a real bound site
pass `undefined`: one arm reds, naming the site. So omission is impossible and deliberate
absence still has to be justified — which is strictly more than either mechanism alone.

**I broke the guard while improving its message and the suite said "no tests".** Rewording the
failure to name the cause rather than the argument count, I put backticks inside a template
literal and terminated it early. Vitest reported `Tests no tests` — not a failure — and a
mutation run against the broken file printed a clean restore line. Caught by the standing check
rather than by noticing: `it(` count against HEAD (5 = 5) and `tsc` (0 errors). **A file that
does not parse reports success in the same shape as a file that passes.**

**Boundary.** This covers `platform-secret-encryption` only. The other four crypto modules bind
by their own means (V-1679b) and their signatures are unchanged; the cipher-construction arm is
what covers them.

## V-1681

**A full-suite red caused by a file that appears in no diff.**

Full run with a database and Redis after the V-1680 signature change: **3214 passed, 1 failed of
3215 files**, 31,969 tests, 215s uncontended — so the twelve-file crypto change is clean and the
pins (3039 / 3215) agree with the run's own count.

The single failure is `dist-reading-suites-have-fresh-artifacts`: marketing-site's artifact was
built `2026-08-25T17:35` while its source changed `2026-08-26T06:21`. Attributed before
investigating — marketing-site is a peer's surface — and the source change is exactly one file,
`src/components/AgentPlanDemo.astro`, which `git status` reports as `??`. **Untracked. Never
added, never committed, no marketing-site commit in four hours.**

**The mechanism is the part worth keeping.** The guard compares newest-source-mtime against
artifact-mtime, and an untracked file counts as source. So work-in-progress living only in a
working tree turns the suite red for every agent sharing that tree, while being invisible to
`git diff`, to `git log`, and to any review of "what changed" — the three places anyone looks
first. The failure text names the app and the remedy but not the file, and the file is the one
thing that cannot be found by the obvious means.

Recorded in `OPEN-ITEMS.md` as W-15 rather than over the socket: the peer session ended
mid-investigation and `ListAgents` no longer lists it, which is precisely the case CLAUDE.md
warns about — the low-latency channel dies with the session and leaves no artifact.

## V-1682

**Four encryption classes deliberately share one key. What separates them is the AAD purpose —
verified distinct, and verified unambiguous, which is a different property.**

BYOK Anthropic, gui_control_key, LiveKit and MFA TOTP all take their AES-256-GCM key material
from `MFA_ENCRYPTION_KEY`. That is intentional and documented: a single trust boundary, so one
rotation rotates all four ciphertexts. It also means the AAD purpose string is the only thing
keeping a ciphertext from one class from being read as another under the same key.

**Already guarded, and better than I would have written it.**
`mfa-encryption-key-shared-cross-source-invariant` has nine arms, three of them on exactly this:
a census that fails if it stops matching, "no two AAD purpose labels in `apps/server/src` are
equal" **keyed by file+constant rather than constant name** (because `AAD_PURPOSE` appears as a
bare name in account-proxy and a name-keyed census would silently dedupe it), and a dedicated arm
for the four modules that share the key. Independently re-derived rather than taken on trust:
**13 purpose labels, 13 distinct, 0 collisions.**

**The property past that guard — and it also holds.** Distinct labels only separate domains if
the AAD encoding is unambiguous. Every builder uses `JSON.stringify([purpose, …ids])`, so a field
containing a delimiter cannot shift the parse; a concatenated `purpose + ':' + accountId` could.
Checked for the subtler version too: **no purpose is a prefix of another** (0 of 13), which is
the failure a concatenating builder would need.

Two conventions coexist for where the version lives — most arrays carry it as a field
(`[PURPOSE, 2, …]`) while gui-control-key and agent-session-transcript embed it in the label
(`…:v2`, `….v2`). Both are unambiguous, so this is a note, not a finding.

**No guard added.** Writing a new AAD builder is not a one-line drift — it takes a new module and
a deliberate choice of encoding, which is the V-1675 criterion rather than the V-1673 one. Fifth
time today a question I judged worth building was already answered in the tree; recorded so the
sixth sweep starts from the measurement.

## V-1683

**Seven questions I judged worth building a guard for, all already answered in the tree. The
pattern is the finding.**

Recorded so the eighth pass starts here rather than re-deriving it. Each was chosen as a
cross-cutting invariant that per-file guards should structurally miss, and each was already
covered — several better than I would have written them:

| Question                                                      | Already covered by                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Are the Playwright e2e specs actually run and collected?      | `a-gate-that-does-not-name-its-blind-spot-reads-as-total`, which derives the spec-file count from disk                                                        |
| Can a test opt out of running unnoticed?                      | `no-permanently-skipped-tests`, whose filter includes `.spec.ts` — mutation-proved                                                                            |
| Can a create path accept ownership from the request?          | no schema declares one; zod strips unknown keys; nothing spreads a body into a write                                                                          |
| Do the four key-sharing modules carry distinct AAD purposes?  | `mfa-encryption-key-shared-cross-source-invariant`, keyed by **file+constant** rather than name — the refinement I would have needed                          |
| Is crypto money decided by float noise?                       | `crypto-amount-tolerance-stays-above-float-noise`, which measured the 14-orders-of-magnitude gap AND verified that tightening the tolerance fails a real test |
| Does webhook delivery follow redirects to an internal target? | `redirect: 'error'` in both implementations, each pinned by its own content-parity guard                                                                      |
| Is the response-body read bounded?                            | 64 KiB in both, and the worker's guard pins the **loop structure**, not just the constant, citing undici decompression bombs                                  |

**The honest reading is about my question-selection, not only about the codebase.** Seven
negatives from questions I chose is evidence that I am converging on well-trodden ground. The
two that did yield — V-1649's ownership-through-lock defect and V-1680's optional AAD parameter
— shared a property none of the seven had: **a weakness the type system or an API signature
permitted silently**, rather than a behaviour a test could describe. That is the shape worth
hunting, and it is scarcer than defect-classes-in-general.

**Where the remaining value is**, stated so it is not re-litigated: not in new defect classes
under `apps/server`, whose guard suite answered seven of seven. It is in the owner decisions
already measured and parked on the memo (ten items, W-10 among them), and in surfaces where
verification is structurally thinner — W-12 records that only 2 of 14 workspaces typecheck their
own tests, which is a measured statement that `packages/` is not held to the same bar.

## V-1684

**W-12 quantified: 51 type errors sit in package test suites that no tool has ever typechecked
— and my instrument was wrong three times before the number meant anything.**

W-12 records that only 2 of 14 workspaces typecheck their own tests. Confirmed mechanically:
every `packages/*/tsconfig.json` sets `"include": ["src/**/*"]` and most also
`"exclude": [… "tests"]`, so package tests are transpiled by vitest and type-checked by nothing.

Measured at each package's OWN strictness bar (none relaxes `tsconfig.base.json`, which sets
`strict`, `strictNullChecks` and `noUncheckedIndexedAccess`):

| package                | errors, all inside test files |
| ---------------------- | ----------------------------- |
| behavioural-simulation | 21 (13 TS2532, 8 TS18048)     |
| webrtc-streaming       | 12 (TS2532)                   |
| recipe-library         | 10 (TS2532)                   |
| recapture-automation   | 6 (TS2532)                    |
| webhook-delivery       | 2 (1 **TS2345**, 1 TS2532)    |
| api-types              | 0                             |

**49 of 51 are "possibly undefined"** — the bar `apps/server` tests already meet, so this is a
real difference in what the two halves of the repo are held to, not a latent crash.

**The one that is not strictness is real fixture drift.** `webhook-delivery/tests/in-memory.test.ts:810`
constructs a queue entry missing `attemptsBaseline`, a field the production type requires and
`nextAttemptNumber` reads as `entry.record.attempts.length - entry.attemptsBaseline + 1`. Absent,
that is **NaN**, and every NaN comparison is false — so an attempt-budget check would take the
opposite branch. **This particular test is unaffected**, because `replay()` assigns the field
before anything reads it; the fixture is wrong and harmless _by accident_, not by design. The
hazard is the next fixture, which nothing would catch.

**Three instrument failures on one measurement, each producing a confident wrong number:**

1. A generic config for all seven packages reported `TS2304: Cannot find name 'SubtleCrypto'` in
   the SDK — my config forced `"types": ["node"]` and dropped the `"lib": ["ES2023", "DOM"]` the
   package sets for itself. Under its own config that package is 0 errors.
2. Extending each package's config instead **inherited its `exclude: ["tests"]`**, so the run
   typechecked only `src` and reported a clean **0 for every package** — a zero from a scan that
   opened no test file, which is the exact shape this log keeps recording.
3. That zero was caught only because run 1 had produced a KNOWN POSITIVE — webhook-delivery's
   TS2345 — and its disappearance was impossible. The final run carries that positive as an
   explicit control.

Reported to W-12's owner rather than fixed here: 51 corrections across five packages is their
item, and the remedy that matters is adding tests to the tsconfigs so the number cannot grow back.

## V-1684b

**The one real drift from V-1684 is fixed; the 49 strictness errors are deliberately left.**

`webhook-delivery/tests/in-memory.test.ts:810` now sets `attemptsBaseline: 0` on the whitebox
queue entry, which is the value the semantics require: the single attempt in that fixture was
spent from the ORIGINAL budget, so `nextAttemptNumber` reads
`attempts.length - attemptsBaseline + 1` = 2. Predicted the package would go 2 type errors → 1,
and it did — the remaining one is `TS2532`, the strictness class that belongs to W-12's remedy
rather than to a one-off correction.

Behaviour is unchanged and that is the point rather than a caveat: `replay()` assigns the field
before anything reads it, so the fixture was wrong and harmless **by accident**. 66 tests still
pass, `it(` count 47 against HEAD's 47. What the edit buys is that the fixture now describes a
shape `enqueue` actually produces, so the next whitebox entry copied from it inherits a correct
one rather than a NaN waiting for a reader.

The 49 remaining errors are not fixed here on purpose: correcting them one by one leaves the
tsconfigs unchanged and the count free to grow back. The remedy that holds is adding `tests` to
the package configs, which is W-12 and its owner's.

## V-1685

**A customer-selectable persona changes typing rhythm and nothing else. Every persona scrolls,
taps, pinches and idles identically — by construction, not by oversight.**

`BehavioralProfile` is a published, customer-facing enum: three personas, threaded
create-request → service → driver → mock and exposed in the Go SDK, all of which
`behavioral-profile-persona-cross-source-invariant` pins. What no guard covers is what selecting
one actually changes.

Enumerated across `packages/behavioural-simulation/src` — all 13 default seed derivations, read
rather than pattern-matched, because several route through a local `defaultSeed(opts)` whose
content depends on the opts shape:

| carries the persona                  | does not                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `keyboard:${profile.id}:${text}`     | `scroll-v:${direction}:${elementClass}`                                           |
| `typing:${profile.id}:${text}`       | `touch:${elementClass}:${bounds}`                                                 |
| mock's `('kb', { text, profileId })` | `idle:${idleClass}:${duration}`                                                   |
|                                      | `pinch:${startSpanPx}->${endSpanPx}`                                              |
|                                      | `two-finger-scroll` / `three-finger-swipe` / `region-touch` / mouse / mock-scroll |

**3 of 13.** And it is structural rather than forgetful: only three options interfaces declare
`profile: BehaviouralProfile` at all, so the gesture and idle entry points never receive a
persona to key on. A `power_user` and a `casual_browser_us` produce byte-identical pinch, scroll,
tap and idle timings for the same geometry.

**Determinism itself is intended and pinned** — `keyboard.test.ts` asserts the literal default
seed `keyboard:casual_browser_us:login` and that two calls match. This entry is not about that.
It is that the persona axis stops at the keyboard while the product sells it as a behavioural
identity.

**Boundary, and it is a large one.** This package has **zero importers and zero declared
dependents** in this repo — the three files naming it do so only in prose comments. It is the
canonical spec that the native fork mirrors, and the fork is outside my scope, so I cannot say
whether the shipped behaviour has the same shape. What is established is what the spec says.

Raised for the fingerprinting owner rather than fixed: widening the persona axis to gestures is a
product decision about what a persona means, not a defect to patch.

## V-1681b

**Second instance of the same mechanism within hours: an untracked file reds the shared suite.**

V-1681 recorded a stale marketing-site artifact caused by an untracked component. That is now a
pattern rather than an incident — measured just now:

```
  disk countTestFiles()    = 3040   pin = 3039
  disk countAllTestFiles() = 3216   pin = 3215
```

The extra file is an untracked `apps/server/tests/unit/*.test.ts`, so `verify-suite`'s census arm
fails on any run, while `dist-reading-suites-have-fresh-artifacts` is still red from V-1681's
untracked component. **Two different guards, two different mechanisms, one cause**: an untracked
file counts as source to the freshness guard and counts into the population for the ratchet,
while appearing in no `git diff`, no `git log`, and no review of "what changed".

Pins not raised — the file is a peer's, and my rule is to raise them only for files I add;
bumping for someone else's in-flight file would hide the real state if its shape changes before
it lands.

**The cheap general fix is a message change, not a mechanism change.** Both failures name the app
and the remedy but never the file, and the file is the one thing that cannot be found by the
obvious means. A census arm that reports "N untracked test/source files present — commit or park
them" would collapse both diagnoses to zero. Offered to the census's owner rather than written
here.

## V-1686

**Hardcoded device dimensions, checked against my own standing rule — and the one inconsistency
found is a documented trade-off, not a defect.**

Swept every literal device dimension across `apps/server/src` and `packages/*/src`. Boundary:
the numeric pair 390/844 and the archetype ladder, comments blanked line-preservingly. Three
sites, all legitimate:

- `drivers/playwright.ts:255` — inside `approximateViewport`, where the dimensions are **derived
  from the archetype**, which is the correct direction.
- `webrtc-streaming/mock-codec-wrapper.ts:64-65` — a mock's defaults.
- `api-types/common.ts` — pricing prose; the digits are coincidental.

**The one thing I did find, and why it is not being filed as a defect.** The two fallbacks in
that driver disagree with each other: `approximateViewport` defaults to iPhone 16 Pro (402×874)
while `approximateUserAgent` defaults to iOS 17.4 — and the 16 Pro shipped on iOS 18, so the
default pair describes a device that cannot exist. They also fall back in opposite directions:
the newest viewport with the older OS.

Both fallbacks are **deliberately pinned by name in two separate guards**, and those same guards
pin the file's own framing: _"What this DRIVER is NOT for: Production customer traffic. The
WebKit fork is the only production-eligible driver"_, and the mapping is described in source as
best-effort and _"good enough for fingerprint-permissive sites"_. A driver that explicitly
declines to be fingerprint-consistent is not made wrong by an inconsistent fingerprint. Changing
either constant would edit two pinned guards to correct a property the file disclaims.

**Tenth consecutive negative**, after V-1683 recorded seven. The one finding in this stretch was
V-1685, and its distinguishing feature holds up: it was a gap between what the product _sells_
(a persona as behavioural identity) and what the code _implements_, rather than a gap between
code and its own stated intent. Guards are extremely good at the second kind here and cannot see
the first — a guard pins what a file says about itself, and V-1685's file says nothing wrong.

## V-1687

**W-12 drained: package test suites now typecheck clean at their own bar, 50 → 0.**

The half of W-12 that had to come first. A2 holds the tsconfig change; draining before the
configs land avoids opening a red window in a tree three sessions are writing to, and the configs
are inert until the count is zero anyway.

Fixed at each package's own strictness (none relaxes base): behavioural-simulation 21,
webrtc-streaming 12, recipe-library 10, recapture-automation 6, webhook-delivery 1 — **50 → 0**,
with `api-types` already at 0. 63 test files and 864 tests still pass.

**The idiom was chosen by measurement, not preference.** `apps/server` tests already meet this
bar, and they meet it with a non-null assertion on the indexed access — **626 uses** against 123
`toBeDefined()`. So `arr[i]!` is what the surrounding code does, and one of the files being fixed
already used it at line 510 while line 481 did not: the inconsistency was internal to a single
file.

**On whether `!` silences rather than proves.** In these tests it is the correct shape: every
index sits inside a loop bounded by the same array's `length`, or reads an element of an array
the test constructed a line earlier. If any array were actually empty, the test would already
throw on the property access — so the suites passing before and after is the evidence that the
assertion is describing what is there rather than hiding what is not.

**Two shapes, and only one was mechanical.** The positional fix — insert `!` after the `]` at the
error position — handled 44. Three more named a _variable_ (`'last' is possibly undefined`), where
the fix belongs at the declaration rather than each use; my first prediction of the remaining
count was wrong because I had forgotten my own script targeted a single file. Predicted 0 for the
final run and got 0.

## V-1688

**The census now names the untracked file instead of leaving it to be found.**

Twice in one session a shared-tree suite went red from a file that existed only in a working
tree — V-1681 (a component, via the artifact-freshness guard) and V-1681b (a test file, via this
census). Both messages named the pin or the app; **neither named the file**, and an untracked
path is invisible to `git diff`, to `git log`, and to any review of "what changed", which are the
three places anyone looks first. The cause was the one thing the obvious means could not find.

Both census failures now append the untracked test files they are counting:

```
raise EXPECTED_TEST_FILES in the same commit that adds or removes a test file
  — 1 UNTRACKED test file(s) are counted by this census and appear in no diff:
    apps/server/tests/unit/zz-untracked-census-probe.test.ts
```

**It adds no failure.** The arms fail exactly when they failed before; only the message changed.
That was the design constraint — an arm that failed on any untracked file would red the suite for
ordinary work-in-progress, which is the opposite of useful in a tree three sessions write to.

Best-effort by construction: no git, no worktree, or a git that errors yields an empty list and
the message reads as it did before. Mutation-proved in both directions — 6/6 with a clean tree,
both arms red and naming the file with one untracked test present, 6/6 again once removed.
`it(` count 6 against HEAD's 6, tsc clean.

Written at the census owner's request after I hit the same mechanism twice; the argument for me
writing it was that I kept hitting it, not that it was mine.

## V-1689

**Tier differentiation is real: 7 of 7 features vary, and no two tiers are functionally identical.**

The V-1685 shape asked of the paid product: is any advertised axis published as a differentiator
while differentiating nothing? `TIER_FEATURES` is rendered directly into the pricing table's
Access column, so a uniform value there is a paid promise with nothing behind it.

Measured over all 8 tiers and all 7 fields of `TierFeatures` — boundary: the exported object in
`packages/api-types/src/common.ts`, comments blanked, field count cross-checked against the
interface declaration because my first count of "19 fields" was a sed range that overran into the
object it was describing:

- **7 of 7 fields vary across tiers.** None is identical everywhere.
- **No tier pair is identical.** The closest are `agency_manual` and `api_builder`, which share
  `concurrentSessions: 8` and split on `llmBilling` (`byok_only` vs `byok_or_bundle`) — so two
  tiers at different prices are not the same product.

The two neighbouring guards cover the other directions and say so: `every-boolean-tier-feature-is-enforced`
catches a `false` flag nothing enforces ("the statement is decoration — and in the direction that
matters commercially"), and `a-numeric-tier-cap-that-only-guards-creation` catches a cap checked
at create and never after. Uniformity was the third direction and it is empty.

**Thirteenth consecutive negative**, against one finding (V-1685) in that span. Recorded because
the measurement is cheap to redo and expensive to re-derive, and because the yield itself is now
the useful signal: the questions I can generate are landing on ground this suite already holds.

## V-1690

**The drain holds under the real gate — and the config set is missing the package with the most
tests, for a reason that is a trap in the opposite direction.**

The W-12 split had me drain and the config owner land the configs. Six `tsconfig.test.json` files
now exist. Verified against **their** configs rather than the scratch one I drained with, because
a zero measured under my own instrument is not a zero under the gate: **0 errors across all six.**

Their template is right about the trap I hit: it extends `tsconfig.base.json` rather than the
sibling build config, and says why in its own header — `extends` inherits `exclude`, an `include`
cannot win it back, and extending the build config would compile nothing while reporting a
confident zero. That is V-1684's instrument failure turned into a permanent comment in the file
that would otherwise have repeated it.

**But the same correct choice creates the opposite trap for exactly one package.** Extending base
also discards package-specific `compilerOptions`, and `sdk-typescript` is the only package that
has any: `lib: ["ES2023", "DOM"]`. Enumerated across all eight packages, so the exception is
measured rather than assumed.

- `sdk-typescript` has **31 test files, more than any other package**, and **no
  `tsconfig.test.json`**.
- Its tests already typecheck **0 errors** — measured with the DOM lib restated.
- Without restating it, the same config template yields a false
  `TS2304: Cannot find name 'SubtleCrypto'` — which is the exact artifact my first cross-package
  sweep produced and misread as a finding.

So the seventh config is free to add and must restate `lib`. Reported rather than written: the
configs are the other half of an agreed split, and crossing it unilaterally is the same mistake
as bumping someone else's ratchet.

⚠️ My own config failed twice more getting here — `TS5069` from setting `declaration: false`
without `declarationMap: false`, and before that the missing DOM lib. Both were mine, both were
caught by reading the error rather than the count.

## V-1685b

**Boundary closed with the newly granted scope: the persona axis is unimplemented everywhere
except the mock — which makes the V-1685 decision cheaper now than it will ever be again.**

V-1685 filed the persona question with an explicit limit: the simulation package has zero
importers, the real behaviour is native, and _"someone who can read the fork has to close it."_
Scope was granted for `driftstack` and `webkit-driftstack`; this is that check.

- **The persona ids appear in neither repo.** `casual_browser_us` / `power_user` return nothing
  across `driftstack` and `webkit-driftstack` source (boundary: `.ts/.js/.py/.swift/.mm/.cpp/.h`,
  excluding `node_modules`, `WebKitBuild`, `dist` and `.git`). The fork has no concept of them.
- **The harness wire protocol does not carry one.** `harness-control-protocol.ts` has
  `behavioral_pause` and `behavioral` booleans, but no persona or profile field.
- **`behavioralProfile` is consumed by `mock.ts` and nothing else** — not by `webkit.ts`, not by
  `playwright.ts`, though `types.ts:67` declares it on the driver create-input as optional.

**And the correction that stopped a false finding.** "The production driver ignores the persona"
was one grep from being reported. `webkit.ts` is an **81-line stub** whose every method throws
`DriverNotIntegratedError` — it exists so the factory can return something. There is no
integrated production driver to ignore anything, so mock-only threading is correct for a
pre-integration state rather than a defect. The check that mattered was asking whether the
accused file does anything at all.

**What this changes about V-1685.** Nothing about the question, and everything about its cost.
The persona axis is not a shipped behaviour that would have to be migrated — it is a spec with no
implementation on either side of the boundary. Deciding now whether a persona means "typing
rhythm" or "behavioural identity" costs a docs edit or three interface parameters; deciding after
the fork integrates costs a behavioural change to live sessions. Memo item 11 and W-17 stand,
with that added.

## V-1690b

**Retraction: `sdk-typescript` is not a missing config. It is the package that already solved
this, differently — and adding the seventh config would have built the trap the floor exists to
catch.**

V-1690 reported the config set as short by one because `sdk-typescript` has 31 test files and no
`tsconfig.test.json`. Wrong, and the error was mine at the point of reading: I had that file open
two commands earlier and printed only its `lib` line, then carried the `src/**/*`-only pattern
over from the other six packages without ever looking at its `include`. **A shape generalised from
six neighbours is not a reading of the seventh.**

What it actually declares — its own `tsconfig.json` compiles `src`, `tests`, `examples`, the
tsup config, and three cross-package paths, and its `package.json` exposes a `typecheck` script
that `npm run typecheck --workspaces --if-present` runs in pre-push.

**Proved at the gate rather than by reading the config**, because "a config exists" and "a gate
enforces it" are different claims and only the second is worth anything. Planting a type error in
`tests/unit/errors.test.ts` takes the package's own typecheck from exit 0 to **exit 2**, naming
`TS2322` and the file; restoring returns it to 0. Verified byte-identical against the snapshot and
clean against HEAD.

**And the fix would have been worse than the gap.** A seventh config would be a second project
compiling the same files with a **hand-synced `lib`**, and `sdk-typescript` is the only package
carrying package-specific `compilerOptions` — the very fact V-1690 established. The duplicate
drifts into false `TS2304`s the moment the real one moves, which is the artifact I hit once and
briefly read as a finding. The correct boundary is **seven packages, six of which needed a
config**, enumerated rather than counted.

⚠️ One more instrument fault inside the proof: my restore check printed
`byte-identical: NO` because the `cmp` ran inside a subshell I had `cd`'d, so the repo-relative
path resolved to nothing. The file was in fact restored exactly. **A path is only relative to
where it is evaluated, and a subshell is not where I wrote it.**

## V-1685c

**The conclusion in V-1685b was right and the evidence under it was truncated — and re-deriving
it properly found the claim a third time, now in the wire protocol's own comment.**

V-1685b asserted that the harness protocol carries no persona field. Re-checked because a comment
at `harness-control-protocol.ts:748` says the assign frame carries _"its egress + persona +
transport + caps"_, which directly contradicted it.

**The conclusion survives.** Zero occurrences of the `BehavioralProfile` enum values anywhere in
that file. `SessionAssignProfileSchema` carries `profile_id` + `dek` + sealed blob — the saved,
encrypted **browser profile**, not the behavioural persona. Two different things share the word
"profile", which is what the comment is loosely calling a persona.

⛔ **But the evidence I published for it was a truncated read.** The original check piped
`grep -i persona` through `head -4`, saw four `behavioral_*` lines, and I wrote _"empty = not in
the harness wire protocol"_. The persona line sat below the cut. **A right answer from a wrong
method is the most expensive kind, because it certifies the method** — I have written that rule
into this log about other people's instruments and then published a conclusion under a `head -4`
in the same session.

**And the re-derivation found something the first pass could not.** The protocol's own comment
says the assign frame assigns a persona. It does not. That is the same claim from V-1685 in its
third location: the product sells a persona as a behavioural identity, the simulation package
varies only typing, the fork has no concept of one, and now the wire protocol's summary of its own
frame names one that never crosses it. **Three independent surfaces describe a feature; none
implements it.** The comment is one word and the cheapest of the three to correct — but which way
it should be corrected is memo item 11's decision, not an edit, because "say profile" and "carry
the persona" are opposite answers to the same question.

Boundary: this covers `apps/server/src/schemas/harness-control-protocol.ts` only, read whole
rather than headed.

## V-1685d

**Retraction: the persona DOES cross the harness wire. I published the opposite twice, from two
different patterns that were both wrong about the same field.**

`SessionAssignSchema` carries `behaviorProfile: z.string().min(1)` — **required**, beside
`archetype`, under an annotation that could not be clearer about why:

> archetype + behaviorProfile stay REQUIRED (A3 W138): no safe default — a wrong-fingerprint or
> inert-behaviour fallback would be a silent detection tell.

**Both of my detectors missed it, for different reasons, and the pair is the lesson.** The name
sweep matched `behaviou?ral` — the field is `behaviorProfile`, "behavior" without the `-al`, so
the pattern was written for a morphology the code does not use. The value sweep looked for
`casual_browser_us` / `power_user`, which **cannot appear in a `z.string()`** — a schema that
accepts a string names no members, so searching for members is structurally incapable of finding
it. Two passes, two methods, one field, zero hits: **agreement between two instruments is not
corroboration when both are blind in the same place.**

**What is actually true, having read it.** The only code that populates `behaviorProfile` is a
`sessionDispatch` block in `bootstrap.ts` that hardcodes the literal `'default'` — and that block
is a documented local fleet-demo config, _"only assembled behind `FLEET_CONTROL_PLANE_ENABLED`
(so inert in prod)"_, with a hardcoded archetype and a localhost SOCKS5 proxy beside it. So the
customer's selected `BehavioralProfile` does **not** feed the wire field today, and nothing in
production does, because the dispatch path is not live: the WebKit driver is a stub and the fleet
control plane is flag-gated.

**Which sharpens V-1685 rather than dissolving it.** The wire has a required field whose own
annotation says an inert value is a detection tell; the only wiring that exists sets a constant;
and the customer-selected enum that ought to feed it stops at the mock driver. That is a concrete
integration requirement — when the harness path goes live, `behaviorProfile` must be fed from the
selection — rather than a live defect. Memo item 11 and W-17 gain a third fact: the field is
already there and already required, so the decision is about what value to put in it, not whether
to add one.

Boundary: `apps/server/src` read whole for `behaviorProfile`, four files, five occurrences in the
schema and one populator.

## V-1691

**P-17 design: what in-flight connections do when egress swaps. One option is ruled out by
physics, and that is what decides it rather than preference.**

The blocking question before any `setEgress` wire shape is frozen: when egress changes on a live
session, do existing connections drain, reset, or stay on the old exit? It is observable to the
site, so it belongs in the frame design. Confirmed undecided: planning file 133 is 467 lines with
29 mentions of egress and 34 of SOCKS5, and nothing in it addresses changing egress after a
session starts — controls run so the zero means absence rather than a bad search.

**The invariant that settles it: at most one egress IP may be observable at any instant.** A
single-interface device has one public address at a time. Every option is then judged by whether
it can put two on the wire together.

| Option                                                                        | What the site sees                                                                                                         | Verdict                                                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drain** — existing connections finish on the old exit, new ones use the new | Subresources for one page arriving from **two IPs concurrently**, overlapping in time                                      | ⛔ **Ruled out.** No real device can produce this. It is the only option that is not merely unusual but impossible                              |
| **Reset** — tear down all connections, everything reconnects on the new exit  | A hard break mid-page, then everything resuming from a new IP                                                              | ⚠️ Possible for a real device (WiFi→cellular handoff) but the signature is unnaturally clean: simultaneous, no retry storm, no partial failures |
| **Stay** — the swap applies at the next navigation boundary                   | Nothing anomalous — the exit changes between page loads, which is what a network change looks like when nobody is mid-load | ⭐ **Coherent by default**                                                                                                                      |

**Recommendation: `stay` as the default, `reset` as an explicit opt-in, `drain` unavailable.**
That makes the safe choice the one a caller gets by not thinking about it, and forces the
detectable option to be named. The cost is that `setEgress` becomes asynchronous in effect — it
returns "will apply at next navigation", which has to be in the API contract rather than
discovered.

**Boundary, and it is the important one.** This is reasoning about what is observable, not a
measurement of what any detector actually keys on. I have not tested a real site against either
signature, and "unnaturally clean handoff" is an argument, not evidence. The physics claim
(two concurrent public IPs) is solid; the ranking of `reset` versus `stay` is a judgement that
someone with detector telemetry should be able to overturn.

## V-1692

**P-17 control-plane half: the `setEgress` frames and correlator, built to the V-1691 decision.**

Three pieces, mirroring the `setCookies` request/reply pattern exactly where it applies and
diverging only where this frame's own hazard demands it.

**Frames** (`harness-control-protocol.ts`) — `setEgress` strict, `setEgressResult` lenient, per
the file's convention. `inlineProxyConfig` carries the whole base64 SocksProxyConfig because the
harness resolves no saved-proxy ids (W137), and `exitIdentity` is **required** and moves
atomically with it: a swap that changed the IP but kept the old timezone would have the session
claiming one geography while exiting from another, visible in a single page load.

**`applyPoint` is an enum of two**, and the omission is the design: `drain` is not expressible,
because old connections finishing on the old exit while new ones use the new puts two exit IPs on
the wire concurrently for one page. A value the frame cannot carry is a value nobody selects by
accident.

⭐ **The result MUST echo the apply point, and I learned that from the sibling rather than
inventing it.** `TrimProfileResult` echoes `scope` for a documented reason (W3122): a synthesized
Codable decoder ignores unknown keys, so a node predating a field accepts the request, drops it,
does its own default, and replies `ok`. Applied here, a node without `applyPoint` would leave the
CP believing it had bought a deferred swap while every in-flight connection was reset — the exact
outcome this design exists to make deliberate. **Tolerance is what makes an additive field safe,
and what makes a behaviour-changing field dangerous without an echo.**

**Correlator** (`set-egress-request-correlator.ts`) — mirrors the sibling's mechanics including
the cross-session spoof guard, and splits the success case three ways on a peer's argument that
**accepted is not applied**: `applied`, `accepted_pending_navigation`, and
`ok_apply_point_unconfirmed`. Collapsing the first two would make an unapplied swap
indistinguishable from a broken one to a caller polling "did it take?".

**12 arms, mutation-proved on the property that matters**: deleting the missing-echo branch reds
exactly one arm. Two arms pin the design itself — that `drain` fails to parse while the same
object with a legal apply point parses, and that a request without `exitIdentity` fails.

⛔ **Stated in both file headers and repeated here: this half cannot be verified end to end.** The
WebKit driver is an 81-line stub and the fleet control plane is flag-gated, so these tests prove
the CP speaks the frame and nothing about what a node does with it. Written down because a later
reader finding full coverage would otherwise reasonably conclude the feature ships.

⚠️ **One contract question left open on purpose.** A session that never navigates again never
applies a `next_navigation` swap — and since that is the default, an idle session is the common
case. Either the pending state is surfaced or it expires; inventing an expiry here would settle a
product decision silently.

## V-1692b

**P-17 wiring complete: the frame is registered, the registry exposes it, and two pins moved with
it in the same commit.**

`serializeSetEgress` in the codec (re-validating so a malformed envelope never leaves the
server), `setEgressCorrelator` on `FleetControlConnection` beside its six siblings — field,
transport, construction, request method, inbound routing case, and `failAll` on close — and
`SetEgressResultSchema` joined to `HarnessOutboundSchema`.

**Registering the frame moved two pins, and both were guards doing exactly their job:**

- The union-membership regex, which enumerates every outbound frame in order. Updated.
- ⭐ **`every harness→server frame carries the unknown-key mode it was given`**, which refused
  the new frame with _"whether it tolerates an unknown key was never decided. Add it with the mode
  you intend."_ Declared `strip`, like every sibling result — and the reason is the frame's own
  design: the `applyPoint` echo is deliberately optional, `strip` is what lets an older node omit
  it, and that omission is precisely why the correlator treats an absent echo as its own outcome
  rather than a success. **A guard that made me write down the tolerance decision is the reason
  the tolerance is safe here.**

`applyPoint` takes no default at the registry layer on purpose: the safe value belongs at the
customer-facing route, and defaulting in both places would put the safe choice somewhere it could
silently disagree with itself.

**38 files / 684 tests pass; `it(` count 75 against HEAD's 75 on the edited pin file; tsc clean.**

⚠️ **Two process faults on the way, both mine and both the same one.** An edit script asserted a
seven-anchor batch, aborted on the last, and a SECOND script in the same command still ran and
added type imports for code that no longer existed — leaving the file importing types nothing
used. That is standing lesson four exactly: _when patching a file across several edits, re-read
between them_, and the sharper version is that a multi-block command is several edits whether or
not it looks like one. Restored byte-identical from the snapshot and redone as a single atomic
block; the second miss after that was an anchor written with 8 spaces where the file has 6, caught
by the same assert before anything was written.

## V-1692c

**A defect in my own new code, found by reading the sibling I had already mirrored once.**

`serializeSetEgress` took `inlineProxyConfig` as a **pre-encoded base64 string and validated
nothing**. Its sibling `serializeSessionAssign` takes the config as an OBJECT, checks it against
the contract its `type` selects, and documents the consequence: _"@throws HarnessWireCodecError if
inlineProxyConfig fails SocksProxyConfig validation."_ So the same field, on the same wire, to the
same node, was guarded on assign and unguarded on swap — **a config the harness would refuse when
a session starts would have sailed through when it moved.**

Fixed by extracting `encodeInlineProxyConfig` and giving BOTH serializers the one encoder, rather
than copying the validation into mine. Two encoders for one wire field is the shape that drifts,
and the drift is silent: any test exercising only one caller passes while the other diverges.

**Pinned three ways** — that an invalid config throws naming `egress swap`, that a valid one is
base64 JSON on the wire, and **structurally that the socks and vpn contracts are each checked in
exactly one place**. Mutation-proved: reintroducing a second socks encoder reds the structural arm
with "the socks contract is checked in more than one place: expected 2 to be 1". Restored
byte-identical; 15 arms pass; 22 files / 527 tests confirm the extraction left `sessionAssign`
behaviour unchanged.

⚠️ **Three instrument faults getting there, and the middle one is the instructive one.** An index
slice anchored its inner search on `SocksProxyConfigWireSchema` — whose FIRST occurrence in the
file is earlier than the branch I meant — so the slice covered the `if` arm only and left
`} else { … }` orphaned, producing a syntax error rather than a wrong result. **An index computed
from a token that appears more than once is a guess with a number attached.** Replaced by
brace-balanced extraction of the enclosing block, which cannot land in the wrong place. The other
two were reconstructed anchor text with the wrong indentation, both caught by asserts before any
write.

## V-1692d

**Was the unvalidated-payload defect a class or an instance? An instance — now closed.**

V-1692c fixed `serializeSetEgress` embedding a proxy config it never validated. The question that
should follow any fix is whether the named file was the only member, so: two sweeps of
`harness-control-codec.ts`, comments blanked line-preservingly.

**Envelope validation is uniform.** All **14** serializers end in a `Schema.parse` of their own
envelope — `serializeIntentDispatch`, `serializeSessionAssign`, … `serializeTrimProfile`. No
serializer trusts its caller with the frame shape.

**Nested encoded payloads are the shape that mattered**, because an envelope typed `z.string()`
can only check that a field is a non-empty string, never what its base64 decodes to. Every
`encodeWireData` call site: **3 real calls, all passing `parsed.data`** — the intent dispatch's
`inputParams` (validated against the per-intent param map) and the two arms of the shared proxy
encoder. So `inlineProxyConfig` on the swap path was the outlier rather than the norm, and the
doctrine it broke was already the house style everywhere else.

⚠️ The sweep reported a fourth site as raw. It is the **function definition** —
`encodeWireData(value: unknown)` — which the call-site regex matched because a declaration and a
call look alike to a pattern that only knows parentheses. Stated because the honest count is 3,
and a reader seeing "4 sites, 3 validated" would look for a defect that is not there.

Class closed: one instance, fixed, with the surrounding convention confirmed rather than assumed.

## V-1693

**Every identity-keyed correlator carries the cross-session spoof guard — and the three that
looked like gaps were my pattern, not their code.**

The V-1692c shape asked one level up: a shared fleet connection carries every session on a node,
so a correlated reply settled by request id ALONE could resolve another account's in-flight
request with this frame's payload. Eight correlators key on an identity; the setCookies guard is
annotated _"audit M1 extended to the correlated reply path"_, and "extended" is the word that
invites the question of where it stopped.

**It stopped nowhere.** All eight guard, each on the identity its operation is keyed by:

| correlator                                                 | keys on                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| cookies, set-cookies, navigate-history, upload, set-egress | `sessionId`                                                                                    |
| download                                                   | `sessionId`, inside a compound condition                                                       |
| harness-dispatch                                           | `sessionId`, checked on the bounded header BEFORE parsing the envelope or decoding any payload |
| trim-profile                                               | **`profileId`** — trim is out-of-session, and the file says so in its header                   |

`session-readiness-correlator` carries no such key and is a different shape.

⛔ **My sweep reported three of these as unguarded, and all three were false negatives.** It
matched the tokens the setCookies implementation happens to use — `pendingSessionId`,
`sessionId !== pending` — so it missed `target.sessionId !== header.data.sessionId` (dispatch),
`pending.sessionId !== sessionId ||` (download), and `profileId !== pending.profileId`
(trim-profile). **Sweep the shape, not the token** — third instance today, and the costly version
of this one would have been reporting a security gap in code that is correct.

The dispatch correlator is the strongest of the eight and worth copying rather than merely
counting: it checks identity on a bounded header **before** parsing the full envelope or decoding
`outputData`, so a spoofed frame consumes no payload work at all. Its comment names the leak it
prevents — DOM, screenshot and extracted text crossing accounts.

The setEgress correlator added in V-1692 conforms, mirrored from setCookies rather than invented.

## V-1693b

**Correction to my own closing remark in V-1693: no correlator does heavy payload work before its
identity check, because none of them decode before it.**

V-1693 ended by calling the dispatch correlator's ordering _"the better one where payloads are
large"_, implying the others pay a cost. Checked, because a hypothesis I raise is one I should
close rather than leave as an aside.

`download-request-correlator` is the only one whose frame carries file bytes, and it parses the
envelope before checking identity — but it **passes `dataB64` through as an opaque string and
decodes nothing**. The pre-check work is zod confirming a string, not materialising bytes. The
dispatch correlator's early-header check earns its complexity for the opposite reason: its
`parseIntentResult` genuinely decodes base64 `outputData` into JSON, and it runs that only after
the identity check.

So the two orderings are not a better and a worse version of one thing — each matches what its
own parse actually costs. **The asymmetry is real in form and absent in cost**, and my closing
line implied otherwise.

⚠️ Getting here, my extraction anchored on the first `onResultFrame` in the file, which is a
mention inside a doc comment rather than the method — the same "index from a token that appears
more than once" fault I recorded two commits earlier, repeated within the hour. The fix that
works is anchoring on the declaration shape (`^  onResultFrame`) rather than the bare name.

## V-1694

**No dead harness surface: every registry request method has exactly one route caller, and the
sole exception is the one I added an hour ago.**

A frame and correlator built but never wired is a maintenance cost and a false signal of
capability — the surface claims an operation nothing can invoke. Measured across the
`FleetControlConnection` public request API, boundary `apps/server/src/{routes,services,lib}`
excluding the registry itself:

| method                                                                                                             | route callers                               |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| requestTrim, requestDownloadList, requestDownloadFetch, requestUpload, requestCookies, setCookies, navigateHistory | **1 each**                                  |
| **setEgress**                                                                                                      | **0** — added in V-1692, awaiting its route |

So the harness control surface is fully wired, and the only unreachable method is mine, which is
the expected mid-handoff state rather than a finding.

⛔ **The first version of this sweep reported FIVE methods as unreachable, and every one was my
own invention.** I derived the names from the frames and correlators — `uploadFile`,
`listDownloads`, `fetchDownload`, `cookies` — instead of reading the class. The registry calls
them `requestUpload`, `requestDownloadList`, `requestDownloadFetch`, `requestCookies`. **A
population guessed from a neighbouring layer's vocabulary is not the population**, which is
V-1673's hand-written column list in a new costume: there, six of seven guessed names did not
exist; here, four of eight.

**No guard added**, by the V-1675 criterion. Leaving a method unwired is not a one-line drift —
it takes a frame, a correlator, a registry method and a missing route across four files. A guard
would also need an exemption for `setEgress` today and a deletion of that exemption the day the
route lands, which is two edits to catch a mistake nobody has made.

## V-1695

**"Is this pinned?" is a question a grep cannot answer. Mutate instead.**

`trim-profile-request-correlator` states a requirement on its caller: _"The route MUST compare
this against what it asked for: an old node accepts an unknown `scope`, ignores it, runs a cache
trim and replies ok, so without this an `ok` is not evidence the requested op happened."_ The
route honours it — `profiles.ts:719` refuses to report success when the applied scope differs and
names both halves in the error.

**I then searched 2391 test files for `appliedScope`, found nothing, and was one commit from
reporting a stated MUST honoured by one caller and pinned by none.** The search space was real —
controls found 1 test mentioning `requestTrim` and 4 mentioning trim scope — so the zero was not a
broken path. It was a broken question.

**The mutation settled it in one run.** Neutralising the comparison to `if (false)` reds
`profiles-trim-route.test.ts` on **two CRITICAL arms**, the first of which is the property
verbatim: _"an `ok` from a node that IGNORED the scope is reported as a FAILURE, not a success."_
Restored byte-identical.

⛔ **The tests never name the field, because they assert the RESPONSE.** A grep shaped like the
implementation cannot find a test written in terms of behaviour — and the better a test is
written, the less it looks like the code it guards. So a name-search systematically under-finds
exactly the strongest guards.

**The rule, and it is cheap:** to ask whether something is pinned, break it and run. A grep for
the identifier answers _"does a test mention this name"_, which is a different question from
_"does a test fail if this breaks"_ — and only the second one is what "pinned" means. Third time
today a grep-based "unpinned" claim has been refuted by a mutation.

⚠️ Separately, my extractor for the correlator outcome unions was wrong three times in a row —
first cutting at the first `;` in the file, then at the first line ending in `;`, which lands
inside a multi-line variant whose doc comment contains one. Each version produced a plausible,
short answer. The union shapes were never the finding, but the count I would have published was
wrong three ways.

## V-1696

**A mutation must be TYPE-CLEAN, or it tests the compiler instead of the property — and mine was
not.**

Applying V-1695's rule (to ask whether something is pinned, break it) to a fail-closed safety
gate: `stripe-key-safety.ts` states _"Caller is responsible for failing the bootstrap when
ok=false"_, and `bootstrap.ts:2064` honours it with a throw. The question is whether anything
would notice if that throw went away.

**First attempt, and the result was uninterpretable.** Rewriting the condition to `if (false)`
red 14 files across a full run — a number that looked like an answer. It was not: `reason` exists
only on the `ok: false` variant of the result union, so removing the `!ok` check destroyed the
narrowing and produced **`TS2339`**. `the-server-source-type-checks` was among the 14, which is
the tell. **A mutation that fails to compile measures the build, not the guard**, and every
downstream failure it causes is noise wearing the shape of evidence.

The type-clean form keeps the narrowing and removes only the effect:

```
  if (!stripeKeySafety.ok) {
    void stripeKeySafety.reason;   // was: throw new Error(...)
  }
```

Verified at **0 tsc errors**, so a run under it measures the property and nothing else.

⚠️ **A second confound I had already walked into:** I ran the mutation before the baseline. A
peer is mid-flight on team routes and the openapi/SDK parity guards that follow from them, so the
tree has reds of its own — and 14-minus-unknown is not a measurement. **The baseline is not
optional when the tree is shared**, which is my own standing rule and I inverted it.

**The safety-gate question is therefore still open**, and stated as open rather than answered:
what is established is that a type-clean mutation exists and that the first result was noise.
The comparison needs a baseline run and a mutated run with no peer suite in flight; both were
deferred because a peer runner is active, and running either against a moving tree would repeat
the fault this entry is about.

## V-1697

**The claim was pinned; the behaviour that makes it true was not. A fail-closed launch gate whose
enforcement nothing guarded.**

`lib/stripe-key-safety.ts` refuses an `sk_live_` key used before the BV KvK cutover. It is
thoroughly covered — eleven behavioural arms on `validateStripeKeyForLaunch`, plus a
content-parity guard pinning its framing, **including the sentence "The check intentionally lives
outside BillingService so it fires during bootstrap regardless of whether billingService is
constructed"**.

**Nothing pinned the half that makes that sentence true.** The module only RETURNS
`{ ok: false, reason }`; refusing to boot is the caller's job, and the file says so: _"Caller is
responsible for failing the bootstrap when ok=false"_. `bootstrap.ts:2064` honours it with a
throw — and removing that throw was invisible.

**Established by mutation, not by reading**, and the selection is why it is trustworthy: I chose
the test set by the MECHANISM any guard would have to use — the five files that invoke
`createProductionDeps` / `buildAppWithFatalTeardown`, since the check lives inside the former —
rather than by grepping for "stripe". Baseline 33 of 33; type-clean mutation (0 tsc errors) **33
of 33 again, identical.** Nothing noticed.

**A prose pin asserting a safety property, over a module that cannot enforce it alone, is the
"statement is decoration" shape** that `every-boolean-tier-feature-is-enforced` names in its own
header — here with a commercial edge: an `sk_live_` key before the cutover boots a server that
can take real money in a pre-launch environment.

Pinned now by `the-stripe-launch-gate-actually-fires-at-bootstrap`: the module still claims the
obligation, bootstrap CALLS the gate, bootstrap THROWS on failure, and the thrown message is the
module's own operator-facing reason rather than a rewritten one. Predicted 2 arms would red under
the mutation and exactly 2 did. Source-reading rather than behavioural because
`createProductionDeps` needs a database, Redis and a full config — the wiring is what drifts, and
the wiring is what this pins.

⚠️ Ratchets raised by one after checking the delta was **exactly** my file — the disk had moved
under a peer's work, and a blind +1 would have papered over whatever else had changed.

## V-1698

**Comment-stated caller obligations, swept by mutation: 4 of 22 checked, 1 was unenforced.**

A module that says _"the caller MUST …"_ has moved a correctness property across a boundary the
type system does not police. V-1697 found one such obligation honoured but unguarded, so the
class is worth working rather than sampling. 22 exist under `apps/server/src` (comment lines
only, `caller|route|consumer` + `MUST|must|is responsible`), and I took the four with the
sharpest consequences.

Each was tested the same way: neutralise the honouring code with a **type-clean** mutation, and
select the test set by the MECHANISM a guard would have to use rather than by name.

| obligation                                                           | honoured?                                               | guarded?                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| trim — _the route MUST compare the applied scope_                    | yes                                                     | **yes** — 2 CRITICAL arms (V-1695)                                                                                 |
| stripe — _caller must fail the bootstrap when ok=false_              | yes                                                     | ⛔ **NO** — 33/33 both sides (V-1697, now pinned)                                                                  |
| email-preferences — _the caller MUST be admin on that team_          | yes                                                     | **yes** — 3 files, including `team-rbac-auth-path`, which exercises the real RBAC path rather than the source text |
| bundled-turn-concurrency — _caller MUST call release() in a finally_ | yes — and the `finally` says "so a slot can never leak" | **yes** — 163 → 162                                                                                                |

**One in four unenforced, and eighteen unchecked.** The remaining obligations are listed in the
sweep output and are ordinary work for a later pass: notification-event-bus's unsubscribe,
auth-flows' _"the caller must reject rather than double-run"_, webhook-grace's _"treat a null
return as…"_, and fifteen more.

⚠️ **Three instrument faults, and the first is the worst kind.** My mutation script printed
`mutation landed` **unconditionally**, after a python block that had already failed its anchor
assert — so a run that changed nothing reported a clean A/B with identical numbers, which reads
exactly like "unguarded". Status lines must be gated on the actual diff, and they now are
(`cmp` then abort). The other two: an anchor reconstructed from a display rather than extracted
(the `throw` starts mid-line, so my indentation was wrong), and a mutation that left
`ForbiddenError` unused — `tsc=1`, which would have mixed a typecheck failure in with the guards
exactly as V-1696 describes.

## V-1699

**Six caller obligations checked, and a triplicated authz helper that only LOOKED divergent.**

Continuing V-1698's sweep with the two sharpest remaining: `api-keys` privilege de-escalation
(_"a caller must not be able to grant an ELEVATED scope it does not itself hold"_) and
`webhooks.rotateSecret` (_"Caller is responsible for the admin-scope gate"_). Batch-mutated both,
selection by mechanism — 480 files that touch either surface. Baseline 4 failed; mutated **10
failed**. Both guarded. **Six obligations checked, one unenforced** (the stripe gate, V-1697).

**The webhooks trace surfaced something better: `effectiveAccountIdForWrite` is copied into three
route files** — profiles, webhooks and profile-snapshots — and **21 write endpoints** depend on it
to refuse a non-admin acting on a team owner.

⚠️ **My first comparison said all three diverge, and that was my method, not their code.** Hashing
the normalised bodies gave three different digests, one copy 36 characters shorter. Reading them:
identical logic, differing only in a local named `eff` instead of `effective` and a per-domain
refusal message. **Comparing raw text of code that legitimately varies in identifiers and string
literals is the token comparison, not the shape one** — the same lesson as the correlator sweep,
now applied to my own diff.

**The triplication is still worth a guard, by the criterion I hold myself to.** A copy that gained
a condition, lost the throw, or returned the account id before checking the role would be a silent
authz hole in one domain — **one line, in one of three files, with nothing else to notice**. So
`the-team-admin-write-gate-is-one-shape-in-three-files` compares the copies with identifiers and
message text normalised away, which is the comparison that is about behaviour rather than prose.

Three arms: all three files still define the gate (or the comparison silently compares fewer than
three), the shapes match, and the shape still contains the refusal — so the equality arm cannot
pass on three copies that lost it together. Mutation-proved by deleting one copy's team-scope
early return: exactly one arm reds, naming the divergent file.

## V-1700

**A guard that asks "does this file import from the home module" cannot see a file that imports
two of three parameters and inlines the third. One instance, benign, deliberately not fixed.**

`aes-gcm-parameters-are-never-redeclared` exists because _"ten encryption modules each declared
`AES_256_KEY_BYTES = 32`, `GCM_IV_BYTES = 12` and `GCM_TAG_BYTES = 16` locally"_. It has two arms:
nothing outside the home module may DECLARE them, and every consumer must IMPORT them.

**Its consumer arm is whole-file.** A "consumer" is any file whose body _contains one of the
parameter names_, and the check is that such a file's body contains the home module's import path.
So a file that imports two parameters and inlines the third **satisfies both arms**: it declares
nothing, and it does import — just not the one it inlined.

**Exactly one module does this.** `lib/mfa-totp.ts` imports `GCM_IV_BYTES` and `GCM_TAG_BYTES` and
writes `if (key.length !== 32)` for the key. Measured over cipher-constructing modules, per
parameter rather than per file.

⛔ **My first detector reproduced the guard's own flaw.** It filtered on `bare && !imports` — the
same whole-file test — so it excluded `mfa-totp` for importing _something_ and returned a clean
zero. The control caught it: I had asserted the known positive must appear, and it did not.
**An instrument built to find a blind spot inherited the blind spot**, which is the most
persuasive kind of wrong answer.

**Not fixed, and the reasoning is the finding.** I made the change — import the constant, use it,
0 tsc errors, runtime message identical since the template renders the same "32" — and reverted
it. It breaks **four source-text pins across three files**, and buys a property that cannot drift:
AES-256's key length is fixed by the algorithm, and the guard's own "the values are the
algorithm's" arm already pins that 32 is correct. Churning deliberate pins to deduplicate a
constant that physics holds still is not a trade worth making.

What would change that: a fourth parameter, or any value that CAN legitimately move. Recorded so
the next reader finds a measurement rather than an oddity, and knows the per-parameter version of
the check is the one that sees it.

## V-1701

**Two more caller obligations checked, both covered — and the principle behind V-1697 turns out to
be house doctrine already, written down in a guard I had not read.**

**client-ip** — _"consumers must not parse `X-Forwarded-For` themselves"_, because nginx appends
the observed peer and the raw leftmost value is caller-supplied. A **negative** obligation, so it
is checkable directly rather than by mutation: swept `apps/server/src` for any read of the
forwarding header outside the shared extractor and found **seven hits, all prose comments**. And
`client-ip-shared-parser` already enforces it with three arms — _"no route reads X-Forwarded-For
outside the shared reader"_, _"no route decides the IP trust boundary for itself"_, and a
discovery arm confirming its own population is not empty.

**metrics-registry** — _"callers MUST keep label values bounded (enum-like)"_, with the file
admitting the registry cannot enforce it. Covered by
`metrics-label-cardinality-cross-source-invariant`.

⭐ **And that guard's header is the finding.** It says, of the very comment it is protecting:

> _That comment is already pinned … Pinning the comment freezes what the file SAYS; it cannot
> notice a caller registering `['account_id']` tomorrow. This file checks the thing the comment is
> about._

That is V-1697's shape — a claim pinned while the behaviour making it true is not — **articulated
in this repository before I arrived at it**, and acted on with a non-vacuity arm and a visible
roster. So the stripe launch gate was not a new class of gap; it was a known class with one
unapplied instance, and `the-stripe-launch-gate-actually-fires-at-bootstrap` is the same pattern
applied a second time.

Worth stating plainly because it changes what the sweep is for: **not discovering a principle, but
finding where an existing one lapsed.** Eight obligations checked, one unenforced — and the one
that was unenforced is the only one whose neighbouring guard pinned prose without a sibling
checking behaviour.

## V-1702

**The SSE CORS obligation is guarded repo-wide and derived — and I nearly reported a gap because I
read a filename instead of its arms.**

`lib/cors-allow.ts` states that every SSE / `reply.raw.writeHead` route must include the CORS
headers, and A2 reports a missing ACAO on a hijacked reply **has shipped twice** — the highest
prior of any obligation in the W-18 list. There are **four** hijack sites across three route
files, and A2's e2e spec reaches only two, the others needing a dispatched session no spec
creates. So a source-level check is the only thing that can cover all four.

**All four sites carry `sseCorsHeaders`**, established by brace-matching each `writeHead` object
rather than reading a fixed window — my first pass used 12 lines and reported two sites as
missing it, when both simply have long comment blocks before the headers.

**And it is guarded, twice over, both derived:**

- `every-hijacked-stream-forwards-the-pipeline-headers` — derives the sites by scanning for
  `reply.raw.writeHead`, and checks the PIPELINE helper, that it is spread FIRST (spread last it
  would override content-type), and that no site re-derives the forwarding by hand.
- `cors-allow.test.ts:117` — _"every hijacked writeHead feeds CORS into it — DERIVED from the
  source, not a named list … a fifth hijack route cannot be added uncovered."_

Mutation-confirmed: removing the spread from `account-notifications.ts` reds the derived CORS arm,
a behavioural integration test, and the per-file pin.

⛔ **My hypothesis was that no derived guard covered the CORS half, and it was wrong for a reason
worth naming.** I had `cors-allow.test.ts` in a list of files mentioning `sseCorsHeaders` and
dismissed it as "the helper's own unit tests" **from its name**. That is the same move that made
`lib-stripe-key-safety-content-parity` worth opening — and there I did open it, and found the real
gap. Filenames are a hypothesis about contents, never a reading of them.

⭐ **Its own comment states a principle I have been re-deriving all session:** _"A guard whose scan
is narrower than its own claim is the recurring shape."_ With V-1701's _"pinning the comment
freezes what the file SAYS"_, that is twice now that the doctrine I thought I was discovering was
already written down here. **Nine obligations checked, one unenforced.**

## V-1703

**A third category in the obligation sweep: an obligation whose caller does not exist.**

`auth-flows-repo.consumeAuthToken` is a compare-and-set — it updates `WHERE id = ? AND consumed_at
IS NULL` and returns whether this call claimed the row, with the obligation stated on the return:
_"0 → already consumed (a concurrent winner), so the caller must reject rather than double-run."_

**There is no production caller.** Repo-wide, non-comment: the method is defined in
`db/auth-flows-repo.ts`, declared on the service interface, implemented by the in-memory test
double, and **called only from integration tests** using it as a fixture to mark a token consumed.
Production consumes tokens through `consumeAuthTokenFamily`, which has two live call sites.

So the obligation is neither honoured nor violated — **it is dormant**, and that is a third
outcome the sweep had not produced before. It also changes how a green mutation reads: had I gone
straight to "neutralise the honouring code and see what reds", there would have been no honouring
code to neutralise, and the green would have looked like "unguarded" rather than "uncalled".

**Not a gap in the dormancy register.** `every-service-is-wired-or-recorded-as-dormant` exists for
exactly this shape — it was written after a service that _"bounded five tables on a 90-day window
and had never run"_ — but it is scoped to service CLASSES (_"every recorded entry still names a
real class"_). A repo method with no production caller is a different granularity, and widening
that register to methods would multiply its population by an order of magnitude for a case whose
consequence here is nil: the method is correct, pinned by two guards, and its absence of callers
is the ordinary result of `consumeAuthTokenFamily` superseding it.

**Ten of 22 obligations checked; one unenforced, one dormant, eight honoured and guarded.**

## V-1704

**`git add <path>` is not a scoped commit. The pathspec has to be on the COMMIT, and a peer's
pre-commit hook is what stopped me learning that the expensive way.**

My standing rule is "explicit pathspecs, never `git add -A`". I have followed it all session —
and it is not sufficient. `git add docs/verification-log.md` adds one path **to an index that may
already contain someone else's**, and `git commit` then commits **the whole index**.

A peer had **37 files staged** for their own in-progress commit. My one-file `git add` followed by
a bare `git commit` would have committed all 38 under my message and my name.

**What stopped it was their lint errors, not my discipline.** lint-staged ran over 38 files rather
than my 1 — the tell I should have read immediately — and failed on three
`@typescript-eslint/require-await` errors in a helper of theirs. The commit aborted with nothing
written. Had their staged code been clean, it would have gone in.

**The correct form is `git commit <pathspec>`**, which scopes the commit AND what the hook sees:
re-running as `git commit docs/verification-log.md` reported _"`_.{ts,tsx,…}`— no files,`_.md` —
1 file"_ and left all 38 of their entries still staged afterwards.

⚠️ **Every commit I have made this session used the insufficient form.** They were all correct only
because that index happened to be empty of anyone else's work at the time. That is luck reported
as process, and the honest way to record it is that the rule was wrong rather than that the
outcome was fine.

The tell is cheap and worth watching for: **lint-staged printing a file count larger than what you
staged means the index is not yours.**

## V-1705

**Three more obligations checked — the OAuth link race and both event-bus unsubscribes. All
honoured, and the unsubscribe pair is guarded by two instruments that are only adequate together.**

**oauth-client** — _"Callers must only create the link when the claim wins, so a double-submit
can't produce a duplicate-key 500."_ `markConsumedAt` is a compare-and-set returning whether THIS
call transitioned the row; `oauth-client-service.ts:152` gates on it directly
(`if (!(await …markConsumedAt(…)))`). Honoured.

**Both event buses** — _"Returns an unsubscribe function the caller MUST call on disconnect."_ A
subscriber never removed is a handler leaked per connection, which is invisible in normal
operation and therefore the kind of property most likely to go unguarded. Three SSE routes
subscribe — account-notifications, agent-sessions transcript, status-stream — and all three bind a
`cleanup()` to `close` and `error`, with every `cleanup` body calling `unsubscribe`. Verified by
brace-matching each cleanup rather than grepping near the subscribe.

**The coverage is a pair, and neither half would do alone:**

- the **route** half is pinned by content-parity on the source text, which catches deletion of the
  call but would miss a refactor that keeps the text and breaks the effect;
- the **bus** half is behavioural — _"subscriberCount reflects add + remove lifecycle"_,
  _"idempotent unsubscribe"_, and on the session bus _"subscriberCount drops to 0 + the per-session
  set is cleaned up when the last unsubscribe fires"_, which is the leak itself.

Mutation-confirmed on the route half: replacing the call with a no-op reds several arms of
`routes-account-notifications-content-parity`. Type-clean, restored byte-identical.

**Twelve of 22 obligations checked: one unenforced, one dormant, ten honoured and guarded.**

## V-1706

**The caller-obligation class, swept: 19 of 22 assessed, one was unenforced.**

| outcome                              | count | which                                                                                                                                                                            |
| ------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| honoured **and guarded** by mutation | 10    | trim scope, email-preferences admin, bundled-turn release, api-keys elevation, webhooks rotate-secret gate, client-ip, metric cardinality, SSE CORS, both event-bus unsubscribes |
| honoured, verified by reading        | 4     | oauth-client claim race, pair-mode `acquired:false` → 409 with the winner's id, webhook-grace `updated === null`, recipes access check                                           |
| satisfied **structurally**           | 3     | session-operations' distinct cases instead of a boolean, profiles' rename-first (a documented error, not a runtime obligation), the harness enum whose "caller" is the SDK       |
| ⛔ **unenforced**                    | 1     | the stripe launch gate — fixed and pinned (V-1697)                                                                                                                               |
| **dormant** — no production caller   | 1     | `consumeAuthToken` (V-1703)                                                                                                                                                      |
| not assessed                         | 2     | `auth-flows` currentTokenHash (a "this device" UI marker) and `agent-sessions:5469` pair-mode return shape                                                                       |
| self-authored                        | 1     | the `applyPoint` echo comment I wrote in V-1692                                                                                                                                  |

**One in nineteen.** The single failure had a distinguishing feature the other eighteen lacked: a
neighbouring guard that pinned the module's PROSE — including the sentence claiming the check
"fires during bootstrap" — with no sibling checking the behaviour that made the sentence true.
Every other obligation either had a behavioural guard, or was enforced adjacent to its own
statement where reading settles it.

**What the sweep is worth repeating for.** Not the hit rate, which is low, but the shape: a
comment saying _"the caller MUST"_ marks a property the type system has been asked to stop
policing, and those are enumerable. 22 exist in `apps/server/src`, found by scanning comment lines
only for `caller|route|consumer` + `MUST|must|is responsible`. The method that answers each is
V-1695's — neutralise the honouring code with a **type-clean** mutation and select the test set by
the mechanism a guard would have to use — and V-1703's caveat: with no honouring code to
neutralise, green means "uncalled", not "unguarded".

## V-1707 — the verification log outgrew the format hook a second time; archives are now discovered, not listed

2026-08-26. `docs/verification-log.md` reached 1,533,157 bytes against the 1,500,000-byte budget in
`no-formatted-markdown-outgrows-the-format-hook`, so the guard V-1216 added as "the warning that did
not exist" fired exactly as designed — before Prettier died, not after. Remediated the way that guard
prescribes: entries V-1201..V-1499 moved to `docs/verification-log-archive-through-v1499.md`, which
is listed in `.prettierignore`. The live file is 648,445 bytes, leaving ~851 KB of headroom. Entry
accounting was checked rather than assumed: 258 archived + 218 live = 476, the original count, and
the byte totals reconcile once the duplicated 1,019-byte header is subtracted.

THE REAL FINDING IS NOT THE SIZE. This is the SECOND split (V-1214/V-1215 was the first), and both
guards that read the log had the previous archive's filename typed into them as a constant. Adding a
second archive to a file that names one archive is where this class of guard goes quietly blind: the
uniqueness invariant in `a-verification-log-number-resolves-to-one-finding` spans the whole history,
so an archive it does not know about is a range of V-numbers that can be silently reused, and the
guard would keep reporting green while covering less. Its own V-1215 note predicted this — "precisely
when a reader is least able to notice". So archives are now DISCOVERED by name
(`verification-log-archive-through-v<n>.md`) in both that guard and the W549.B parity guard, and the
next split needs neither file touched.

Discovery has its own failure mode, and it is silence: a regex matching nothing yields an empty list
and the uniqueness check would then pass by reading the live tail alone. Two arms make that
falsifiable — a count (`>= 2`) and one known-positive anchor per half (`V-001` only in the first
archive, `V-1201` only in the second, `V-1500` only in the live file).

Both instruments were mutation-proved rather than trusted for going green: an oversized probe file
made the budget arm name it and prescribe the split, and hiding one archive made the discovery arm
fail with "expected 1 to be greater than or equal to 2". All three log files were restored
byte-identically afterwards (3,475,765 / 885,739 / 648,445), and `tsc -p tsconfig.test.json` is clean.

BOUNDED: `.prettierignore` gained a literal filename, not a glob, because the budget guard's own
matcher is literal (`rel === p || rel.endsWith(p)`). A glob would satisfy Prettier and not the guard,
which would leave the guard red while the hook was fine — a divergence its second arm exists to
prevent. So a future archive still needs one line added there by hand; only the two test files are
now self-maintaining.

## V-1708 — the arm that keeps archives out of the format hook covered only the first archive

2026-08-26. Swept the shape behind V-1707 rather than the token — "a guard that names one member of
a growing family goes blind when the family grows" — across every test that hardcodes a file literal
carrying a version or date suffix. Three hits; two are genuine 1:1 pairings (a dated audit doc and
its own parity guard). The third was a hole I had just created myself.

`no-formatted-markdown-outgrows-the-format-hook` asserts that the frozen log archive is listed in
`.prettierignore`, and it named `...through-v1200.md` specifically. V-1707 added a second archive, so
that assertion covered one of two. The hole is not academic and it does not fail loudly: an archive
is UNDER the 1.5 MB budget at the moment it is split off (v1499 is 885 KB), so deleting its
`.prettierignore` line fails no arm at all — the budget arm is satisfied, and the ignore arm is
looking at a different file. Prettier then quietly resumes reformatting a frozen 885 KB document,
producing exactly the "large meaningless diff on a file nobody should touch" the ignore list exists
to prevent. Every future archive would have inherited the same hole.

PROVED BOTH WAYS, because the claim is about what a guard FAILS to see and that cannot be shown by a
green: with the v1499 line deleted, the arm as it stood at HEAD reported 3 passed — blind — while the
replacement fails with "docs/verification-log-archive-through-v1499.md is no longer ignored, so the
hook would try to format 0.9 MB". `.prettierignore` was restored byte-identically afterwards and the
guard is green again.

The arm now derives archives from the walk it already performs and asserts every one of them is
ignored, with a count arm because an empty match list satisfies a `for` loop forever — the same
failure mode discovery has in V-1707, guarded the same way. `it(` count unchanged at 3; tsc clean.

## V-1709 — the prescribed fix for the request-schema coverage drop cannot work; measured before attempting it

2026-08-26. `published-request-schema-is-not-looser-than-enforced` lost `name` from its compared set
when the team rename added a second real chain, and its own note prescribed the repair: "keyed
per-OPERATION rather than per-field-name, which is a real change to this file and not a number edit."
Measured that remedy before building it. It is not reachable the obvious way, and the note understated
the work rather than overstating it.

POSITIONAL OPERATION-KEYING IS UNSOUND HERE. Attributing a declaration to the nearest preceding
`app.<method>(` assumes declarations live inside route registrations. They do not: 144 of 153
route-side declarations — 94% — sit at MODULE scope, because schemas are written as
`const XSchema = z.object({…})` and referenced later. Under the heuristic the two agent-sessions
`name` declarations attribute to `/history` and `/downloads`, which is arbitrary. Manufacturing
pairings is precisely what this guard declines to do, so a change that produced them would be a
regression dressed as coverage.

KEYING BY THE ENCLOSING SCHEMA CONST IS SOUND, AND HALF AN ANSWER. It resolves the route side
completely — 16 of 16 ambiguous names, none remaining — and separates `name` into
`DownloadFetchQuerySchema`, `UploadFileBodySchema` and `team.ts:RenameTeamBodySchema`. It does not
PAIR the two sides: `lib/openapi.ts` declares 80 named `z.object` consts and NOT ONE of those names
coincides with a route-side const, so there is no shared key to join on. Checked by intersecting the
two name sets, which is empty.

So restoring `name` needs each schema const linked to the operations referencing it on BOTH sides —
symbol resolution, not a keying change. The floor stays at 22 deliberately and the guard now carries
this measurement, so the next attempt does not spend itself rediscovering that the cheap version
cannot work. A negative result recorded is cheaper than the same dead end walked twice.

Separately, `.prettierignore` now states why its archive entries are literal rather than a glob
(V-1707/V-1708): the budget guard's matcher is literal, so a glob would satisfy Prettier and leave
the guard red on a hook that was fine. That file is exactly where someone reaches for a glob, so the
reason belongs there and not only in the ledger.

## V-1710 — the derivation blind spot is real in mechanism and empty in fact; measured, not assumed

2026-08-26. `published-request-schema-is-not-looser-than-enforced` reads single-line `field: z.…`
declarations, so a field DERIVED from a named schema (`field: SomeSchema,`) is invisible to it. The
file's own V-1611 note treats that as a live hazard — deriving a field "drops it out of comparison
entirely — silently, because the assertion below is a FLOOR" — and names two near-misses. Nobody had
measured how many fields are actually in that state.

Measured. The published document carries 19 derived declarations. Excluding the structural wrappers
the guard already accounts for (`params`, `query`, `schema`), exactly TWO are request fields, and
neither is a coverage gap:

category derives from `ConsequentialActionCategorySchema` — and routes/agent-sessions.ts:292
derives from THE SAME imported constant. There are no longer two hand-written copies to
disagree, so there is nothing for this guard to compare and nothing at risk.
cursor derives at one site but still has a visible request-side chain at openapi.ts:6303, and
that is the declaration actually compared. It is in `pairs` today.

⭐ THE DISTINCTION THAT MATTERS, and it inverts the V-1611 note's worry. A derivation is a blind spot
only when ONE side derives and the other keeps a hand-written copy — then an invisible declaration
faces a live one that can still drift. When BOTH sides reference a single constant the drift is
eliminated at the source, and a falling compared-count means the risk went away rather than went
unseen. The guard now says so where the hazard is described.

⚠️ HOW THIS WAS NEARLY REPORTED AS A DEFECT. A replica scanning only the DERIVED lines classified
`cursor` as "one-sided — the route hand-writes it, nothing compares them", which looked exactly like
a real finding against a guard whose note claims `cursor` entered the compared set. It was wrong: the
replica never took the union with the visible declarations. Settled by POST-CONDITION on the guard's
own `pairs` — instrumented in place, 22 names printed, `cursor` among them, file restored
byte-identically. The replica and the guard were counting different populations, and a mismatched
population is indistinguishable from a contradicted claim until someone states which set was counted.
Preferring the real instrument over the derivation is what kept a false report out of this log.

No production change. The guard gains its third named blind spot with the measurement attached, so
the next reader inherits the fact rather than the fear.

## V-1711 — an audit of the MFA disable surface found sound code and one arm a test file claimed but never had

2026-08-26. Audited the MFA account surface end to end after noticing the document publishes two ways
to disable: `DELETE /v1/account/mfa` and `POST /v1/account/mfa/disable`. Two paths to one
security-critical action is where one quietly skips a check the other enforces.

THE SURFACE IS SOUND, and the checks are mechanisms rather than comments. Both registrations carry an
identical five-step chain — `requireAuth`, `requireScope('account_owner')`,
`requireInteractiveWebSession`, `requireMfaFresh()`, `rateLimit('global')` — and the same
`disableHandler`. The source comment says "Same gate, same handler"; that claim was tested by removing
`requireMfaFresh()` from the POST alias alone, which two independent guards caught: the V-353e
cross-source invariant pinning all THREE step-up-gated routes as a family, and the V-353f content
parity carrying the whole chain. Restored byte-identically; 30 files / 449 tests green.

The step-up family is COMPLETE, checked by enumerating every route whose path touches MFA rather than
by reading the guard's list: exactly three routes call `requireMfaFresh` in the whole app, and they
are the three pinned. `POST /v1/account/mfa/enroll` is deliberately not among them and does not need
to be — `startEnrollment` refuses an enrolled account, so the V-353e chain (mint a credential, redeem
it to satisfy freshness, then disable) cannot be re-opened through enrollment.

THE FINDING IS A TEST CLAIM, NOT A VULNERABILITY. `mfa-service.test.ts` has always documented, in its
own header, `completeEnrollment(): rejects no-pending / already-enrolled / wrong code`. Two of those
three had an arm. Deleting the service's `row.enrolledAt !== null` refusal left every behavioural arm
in all 30 MFA unit files green — only a content-parity regex noticed, and a text pin cannot tell a
deleted guard from an inverted one. The `/already enrolled/` assertion that made the file look covered
belongs to `startEnrollment`, a different method.

⚠️ Production never depended on that check, which is precisely why it could rot unseen.
`mfa-repo.completeEnrollmentIfPending` carries `isNull(accountMfa.enrolledAt)` in the WHERE of its
conditional UPDATE, inside a transaction under an advisory lock, returning false when no row matches.
The service check is the friendlier error; the database is the enforcement. So the missing arm was a
defence-in-depth layer nothing measured, not an exposure.

The arm now exists, reaches the state through the real enrol/complete flow rather than a hand-built
row, and is mutation-sensitive by construction: without the refusal the second call verifies the code,
reaches the repo and fails with "MFA enrollment changed while the code was being verified", which is
not `/already enrolled/`. Proved — mutation applied, arm red with exactly that message, source restored
byte-identically, 29 passed. `it(` 28 to 29, tsc clean, no new file so no census bump.

BOUNDED: the mutation was evaluated against the MFA UNIT files. The MFA integration tests are
DATABASE_URL-gated and did not execute here; they were READ instead, and none asserts the
already-enrolled refusal, which is what makes the gap a gap rather than a local-visibility artefact.

## V-1712 — V-1711's boundary claim was wrong, and the sweep that followed it reported the exact opposite of the truth

2026-08-26. Two corrections, both to my own instruments, in the same hour.

FIRST, V-1711 IS NARROWED. That entry stated the refusal had no behavioural coverage anywhere, on the
strength of having READ the DATABASE_URL-gated integration files rather than executed them. A2 has the
database wired and ran the same mutation: 12 MFA integration files, 81 tests, and deleting the
`row.enrolledAt !== null` refusal turns exactly one red. The catcher is
`tests/integration/account-mfa.test.ts`, whose arm already described the near-miss my new unit arm was
designed around — a caller dropped onto the already-exercised fallback and told the enrollment changed,
advice that can never succeed for someone simply already enrolled. It even records the same coverage
observation about the guard line versus its fallback.

So the accurate shape is: the refusal was uncovered at UNIT level, covered at INTEGRATION level, and
never an exposure — the database's `isNull(accountMfa.enrolledAt)` in the conditional UPDATE was always
the enforcement. The new unit arm is still worth having: it runs without a database, which is the half
of the suite anyone runs locally. But V-1711's sentence about nothing asserting the refusal is
withdrawn. I read three of twelve files looking for a pattern, and the assertion that disproved me sits
300 characters inside an `it(` title. A test's coverage is a RUNTIME property; reading is not a
substitute for executing, and a gated boundary is a reason to ask the agent holding the database rather
than to downgrade the method.

SECOND, AND WORSE, THE SWEEP THAT FOLLOWED REPORTED A UNIFORM FALSEHOOD. Having decided mutation is the
only reliable instrument for this class, I mutation-swept all seven single-throw guards in
`services/mfa.ts` against the behavioural MFA unit files. It reported all seven SURVIVING — no
behavioural test catches any refusal in a security-critical service. That is a dramatic result and it
was entirely an artefact: the harness classified runs by grepping vitest's output for a failure count,
and vitest colourises that line, so the pattern never matched and every run was scored as passing.

⭐ It was caught by contradiction with a known positive, not by suspicion. Minutes earlier I had proved
by mutation that deleting guard [2] turns the new V-1711 arm red; the sweep said guard [2] survived.
One cell of a fresh table disagreeing with a result already established is worth more than the other
six agreeing with each other. Re-run scoring on the process EXIT CODE instead of parsed text, the same
seven guards report:

```
  [0] CAUGHT  MFA is already enrolled. Disable first via DELETE …
  [1] CAUGHT  No pending MFA enrollment. Call POST /v1/account/mfa/enroll …
  [2] CAUGHT  MFA is already enrolled. Disable + re-enroll …
  [3] CAUGHT  Invalid 6-digit code. Try again.
  [4] CAUGHT  MFA is not enrolled for this account.
  [5] CAUGHT  MFA is not enrolled for this account.
  [6] CAUGHT  MFA recovery codes changed during regeneration. …
```

Seven of seven, with guard [2] covered by the arm added in V-1711 — before it, that one survived. The
verdict inverted completely on an instrument fix, with no change to the subject.

⚠️ TWO EARLIER DETECTORS IN THE SAME LINE FAILED THEIR CONTROLS AND WERE DISCARDED, which is why this
one existed. A header-manifest matcher (does each behaviour a test file's own header advertises have an
arm?) flagged 44 fragments across 13 files at roughly five false positives to one true, tripping twice
on synonyms — the manifest says "deletes" where the arm says "drops". An exact-error-message matcher
then failed its controls in BOTH directions for a principled reason: `startEnrollment` and
`completeEnrollment` share the phrase "MFA is already enrolled", so one method's substring assertion
makes the other's message look covered. That ambiguity is precisely why V-1711 hid, and it means no
substring detector can find this class at all. Recorded so the next attempt does not build either.

No production change in this entry. `services/mfa.ts` restored byte-identically after every mutation
and verified clean against HEAD.

## V-1713 — V-1712 named the wrong cause: both sweeps were vacuous for one reason, and an exit code is not a verdict

2026-08-26. V-1712 attributed the broken mutation harness to vitest colourising its summary line. A2
challenged that on the correct ground — vitest disables colour when stdout is not a TTY, and the
harness captured through `$(...)`, which is a pipe — so the explanation could not be right. It is not.
Reproduced instead of argued: with the mutation applied and output captured exactly as the sweep
captured it, there is no colour anywhere and **no summary line at all**. What came back was vitest's
"no test files found" diagnostic — its `filter:`, `include:` and `exclude:` echo — and exit code 1.

THE REAL CAUSE IS A SHELL RULE THIS LOG HAS RECORDED BEFORE. The harness built its file list once and
reused it: `BEH=$(ls … | grep -v …); npx vitest run $BEH`. **zsh does not word-split a parameter
expansion.** All ten paths were handed over as a SINGLE argument, matched nothing, and the run ended
before a test executed. Unquoted command substitution DOES split, which is exactly why every earlier
inline `npx vitest run $(ls …)` in this session worked and why the difference was invisible.

⚠️ ONE FAULT PRODUCED BOTH OPPOSITE VERDICTS, WHICH IS WHY IT SURVIVED SCRUTINY. The text-scoring pass
reported 0 of 7 caught — there was no summary line to parse. The exit-code pass reported 7 of 7 caught
— **vitest exits non-zero when it finds no files**, so "nothing ran" and "a test failed" are the same
status. Two runs, two contradictory tables, neither containing a single executed test. Concluding the
second was right because it agreed with a known positive was luck: it agreed with everything.

⭐ SO AN EXIT CODE IS NOT A VERDICT EITHER. V-1712's remedy — score on the process status rather than
parsed text — is not wrong so much as insufficient, and stating it as the fix is what let a second
vacuous sweep look like a correction of the first. A mutation run must prove WORK HAPPENED before its
result means anything: assert a floor on tests actually EXECUTED, then read pass/fail. Status alone
cannot distinguish a caught mutation from a harness that never started.

Re-run with the list expanded inline and a control asserting execution: baseline 10 files / 145 tests,
then each of the seven single-throw guards in `services/mfa.ts` deleted in turn, every run executing
145-ish tests and failing exactly one:

```
  [0] CAUGHT (1 failed)  MFA is already enrolled. Disable first via DELETE …
  [1] CAUGHT (1 failed)  No pending MFA enrollment. Call POST …/enroll first.
  [2] CAUGHT (1 failed)  MFA is already enrolled. Disable + re-enroll …
  [3] CAUGHT (1 failed)  Invalid 6-digit code. Try again.
  [4] CAUGHT (1 failed)  MFA is not enrolled for this account.
  [5] CAUGHT (1 failed)  MFA is not enrolled for this account.
  [6] CAUGHT (1 failed)  MFA recovery codes changed during regeneration. …
```

Seven of seven, now established rather than asserted. The number is unchanged from V-1712 and that is
the uncomfortable part: a vacuous instrument returned the right answer, and agreement with the truth is
not evidence an instrument works. Only the control is.

Four instruments have now failed in this one line of work — two detectors that failed their controls,
and two sweeps that never ran a test — against one real finding, on a subject that was correct
throughout. `services/mfa.ts` restored byte-identically after every mutation and verified clean against
HEAD. The V-1711 arm's Prettier line-wrap is committed here so the tree stops carrying it.

## V-1714 — the session-invalidation epoch: two writers, one deliberate asymmetry, and a security invariant pinned only by its spelling

2026-08-26. Audited `accounts.authEpoch` — the mechanism that invalidates web sessions after a
security event — end to end. No prior art: nothing in this log audits it, and only two guards carry
its name.

ENUMERATED RATHER THAN ASSUMED. Exactly two sites advance the account epoch:
`auth-flows-repo.setPassword` and `mfa-repo.completeEnrollmentIfPending`. The enrollment path bumps
under optimistic concurrency (`where authEpoch = <observed>`), then rebases ONLY the enrolling session
to the new value and sets its `mfaSatisfiedAt`, throwing if either update returns no row. Every other
session keeps the old epoch and goes stale, which is the property: enrolling MFA logs out everything
else.

THE ASYMMETRY IS CORRECT AND WAS UNDOCUMENTED. `mfa-repo.deleteForAccount` — MFA disable — does not
bump. That is the authority model rather than an oversight: the epoch invalidates sessions whose
authority is now INSUFFICIENT, so it advances when the requirement gets STRICTER. Disabling relaxes
it, every live session already satisfies the weaker rule, and a later re-enrollment bumps again, so no
session carries a stale `mfaSatisfiedAt` across an upgrade. Sound — but the reason existed nowhere, and
an undocumented asymmetry in session invalidation is precisely where a real gap hides among deliberate
ones. Now stated at the disable site.

⚠️ THE FINDING IS THAT THE INVARIANT IS PINNED BY ITS SPELLING, LOCALLY. Mutating the bump so it stops
advancing (`authEpoch + 1` to `authEpoch`, which keeps types and the optimistic WHERE valid, so it is a
semantic weakening rather than a compile break) fails 3 files in the full local suite — and narrowing
with a control (8 unit files naming `authEpoch`, 117 tests executing at baseline) the only unit catcher
is `db-mfa-repo-content-parity.test.ts`, a TEXT pin. It fires because the source string changed, not
because a session survived anything. No test pins the literal bump expression, and EVERY behavioural
file naming `authEpoch` is an integration test: `db-mfa-enrollment-session-authority`,
`web-session-authority-repo-contract`, `db-auth-flows-session-revocation-drizzle`, `auth-flows`,
`db-mfa-credential-issuance-concurrency-drizzle`, `admin-suspend-roundtrip`.

BOUNDED, AND THE BOUNDARY IS BEING CLOSED RATHER THAN STATED. Those integration files are
DATABASE_URL-gated and did not execute here. V-1712 was withdrawn for exactly this — substituting
reading for executing on gated files — so this time the mutation was handed to the agent holding the
database to run, instead of being read around. Whether a behavioural arm catches it is therefore OPEN
in this entry, and only the local half is claimed: locally, a security invariant is defended by a
regex over its own source text.

No behavioural change. `mfa-repo.ts` restored byte-identically after the mutation and verified clean
against HEAD; the only edit committed here is the comment recording the asymmetry.

## V-1715 — V-1714's open half, closed by execution: the epoch invariant is pinned behaviourally, by a SQL round-trip

2026-08-26. V-1714 left one question open rather than reading around it: locally the MFA-enrollment
epoch bump is caught only by a content-parity TEXT pin, and every behavioural test naming `authEpoch`
is DATABASE_URL-gated. The mutation was handed to the agent holding the database instead of being
guessed at. It has been run, with a control first: baseline 6 files / 126 tests EXECUTED, and under the
mutation all six files still ran — 2 failed, 4 passed — so the verdict describes work that happened.

THE ANSWER IS THAT THE V-1711 SHAPE DOES NOT REPEAT HERE. Three arms catch it, and the load-bearing one
is a database round-trip rather than a regex over source:
`db-mfa-enrollment-session-authority.test.ts` selects `auth_epoch` before and after an activation and
asserts `before + 1`, failing under the mutation with "the epoch moved: expected 1 to be 2". Two more
in `db-mfa-credential-issuance-concurrency-drizzle.test.ts`. The text pin V-1714 found is real but is
neither the only catcher nor the important one. So the security invariant is defended by its behaviour;
only the LOCAL half was ever defended by its spelling, and that was a property of what runs without a
database, not of the suite.

⭐ ONE HONEST NARROWING, contributed by the agent that ran it. The arm asserts the MECHANISM — the epoch
advanced — while the CONSEQUENCE, that a session minted before enrollment is rejected afterwards, is not
asserted end to end in one place. It COMPOSES: the same file's "an old-epoch session cannot activate
MFA" arm proves stale epochs are refused, so mechanism-advances plus stale-epoch-refused together give
the property. Two arms, one property, neither stating it whole. Defensible, and recorded because the
composition is invisible from either arm alone.

ON THE DISABLE ASYMMETRY, which V-1714 called correct and which deserved the challenge it got: the
objection is that an attacker holding one fresh MFA proof can disable MFA while every other session
survives. Stating it out loud rather than asserting the rule — the answer is that surviving sessions do
not help the attacker, who already holds an authenticated session with step-up satisfied, and the
property that matters is RECOVERY. It holds by the code read in V-1714: re-enrollment bumps the epoch
and rebases ONLY the enrolling session, and `setPassword` bumps unconditionally, so the moment the
legitimate owner re-secures the account by either route the attacker's session goes stale and is
evicted. Disable relaxes the requirement and evicts nobody; re-securing tightens it and evicts
everyone else. That is the asymmetry, and it is now argued rather than assumed.

⛔ A METHOD NOTE WORTH MORE THAN THE FINDING. The zsh word-splitting fault from V-1713 recurred, in the
other agent's hands, inside the command verifying this entry: a file list built as `FILES=…` and passed
as `$FILES` sent six paths as one argument and ran nothing. It was caught instantly by the remedy this
log added an hour earlier — a floor asserting tests actually EXECUTED — because an empty baseline is
obviously wrong in a way an exit code never is. The same fault, twice, in two sessions, on the same
day, caught the second time by the control written after the first.

## V-1716 — a hand-copied credential scrubber fell eight classes behind the original, and the test named "mirrored credential classes" could not see it

2026-08-26. Audited webhook delivery end to end. `packages/webhook-delivery/src/in-memory.ts` carries
its own transport-error redaction and says why: "This package deliberately has no apps/server
dependency, so keep the central redactText credential classes mirrored here and pinned by tests." Two
hand-maintained copies of one security control, with a comment asserting they agree — the shape that
has produced a finding every time it appeared this session.

THEY DID NOT AGREE, AND THE DIVERGENCE IS DATED. The mirror was written 2026-07-13. The central
`redactText` in `apps/server/src/lib/redact-url.ts` then gained three PREFIX classes that never reached
it, each of which was itself a fix for a real leak:

```
  FREE_TEXT_PREFIXED_SECRET_RE  2026-08-13  "a bare API key in an error message went to the log in full"
                                            ds_live_ / ds_test_ / gck_ / whsec_ / sk_live_ / rk_live_
  FREE_TEXT_ANTHROPIC_KEY_RE    2026-08-17  "the one credential format the log scrub missed"  sk-ant-
  FREE_TEXT_OAUTH_SECRET_RE     2026-08-24  "scrub OAuth client secrets and access tokens"    oas_/oat_/oag_
```

And FIVE query-parameter names had been added to the central positional pattern and not the copy:
`session_token`, `debug_token`, `challenge_token`, `code_verifier`, `state`. That alternation is
anchored on `[?&#]`, so the generic `token` alternative does NOT cover `?session_token=` — checked by
diffing both lists rather than by reading one, 17 names centrally against 12 in the mirror, with
nothing in the mirror absent centrally. Pure one-directional drift.

⚠️ `whsec_` is the webhook signing-secret prefix. The webhook package's own redactor did not know the
prefix of the secret the webhook package issues.

SEVERITY, STATED HONESTLY AND SMALLER THAN IT FIRST LOOKS. Both PRODUCTION delivery paths —
`webhook-worker.ts` and `durable-webhook-delivery.ts` — import and call the central `redactText`
directly, so the hosted product was never affected. This copy is the in-memory implementation, which
its own header scopes to "unit tests, GUI-client integration tests, and small self-hosted
single-process workloads". So the exposure is a self-hosted deployment storing a transport failure with
a bare credential in clear on a delivery record's `errorMessage`. Real, shipped, and not the hosted
plane. I nearly filed it as the hosted plane by reading the package before reading its callers.

THE GUARD IS THE ACTUAL DEFECT. An arm titled "transport diagnostics: mirrored credential classes"
asserted `toMatch(/const TRANSPORT_TOKEN_RE =/)` and that each constant is applied — every assertion
reading the mirror's own text. **Both sides of that comparison came from the same file**, so it pinned
that the copy has the classes it has, and could never observe the original moving on. It stayed green
through all eight divergences while its title claimed the property.

Fixed together: the three prefix classes and the five parameter names are mirrored byte-identically,
applied in the central's own order (positional before prefix, for the doubled-marker reason that file
documents), and a new arm DERIVES the classes from `redact-url.ts` and compares pattern bodies rather
than restating them. It also fails when a SEVENTH class is declared centrally and left uncompared,
because the class list is itself a growing family.

Mutation-proved both directions on the real subjects rather than the guard's list: drifting the
mirror's `sk-ant-` to `sk-anx-` fails with "credential classes whose central definition no longer
matches the mirror: [FREE_TEXT_ANTHROPIC_KEY_RE]", and declaring a probe class centrally fails with
"central credential classes this arm does not compare: [FREE_TEXT_PROBE_RE]". Both files restored
byte-identically; `it(` 19 to 20; tsc clean.

BOUNDED: the fix is verified by byte-identity with a redactor that is behaviourally tested centrally,
not by an independent behavioural test of the mirror's own scrubbing. Identity transfers the property
and is what the arm can enforce; a behavioural test of `safeTransportError` would need the function
exported and does not exist.

## V-1717 — the second hand-maintained redactor: bidirectional divergence, this product's own token missing, and dormant

2026-08-26. Swept the SHAPE behind V-1716 rather than the token: other hand-maintained copies of a
central security control. The first detector was over-broad — matching any file containing `ds_live_`,
`whsec_` or `sk-ant-` returned 15 files, nearly all of which hold those prefixes because they GENERATE
or SIGN with them. Narrowed to the precise signal, code that emits a `[redacted]` marker, giving seven
true sites: the central, three that correctly import it, the mirror fixed in V-1716, one false positive
where `[redacted]` appears only in a doc comment (`agent-decomposer.ts`), and one genuine second
redactor — `packages/recipe-library/src/redact.ts`.

IT IS NOT A MIRROR, AND THE DIVERGENCE RUNS BOTH WAYS. It redacts recipe STEP RESULTS — structured
data, path segments, JWT shapes — and is broader than the central in places, carrying 15 names the
central lacks (`auth`, `authorization`, `jwt`, `otp`, `sid`, `sig`, `reset_token`, …). It also missed
six of the central's. Two lists evolved independently; neither derives from the other; both are right
about things the other is not.

⚠️ ONE OF THE SIX IS `ds_token`, WHICH IS OURS. The file states its own posture — "a
redact-the-known-secrets posture, not a fail-closed allowlist" — so a name absent from it is a
credential printed in clear rather than a near-miss. `ds_token` is published as a query parameter on
the account notification stream, so a recipe navigating a Driftstack URL carried it into a step result
verbatim. A known-secrets list had no business omitting the product's own token.

DORMANT, AND SAYING SO IS THE POINT. `apps/server/src` does not import `recipe-library` anywhere:
`redactStepForResult` has exactly one caller, the package's own `mock.ts`. So this is a gap in a
library awaiting its runner, not a live exposure — green here reads "uncalled", not "unguarded". That
is why the remedy is five names and one arm rather than the cross-source guard V-1716 earned.

Fixed: `ds_token`, `session_token`, `challenge_token`, `debug_token` and `code_verifier` added, each a
central name and unambiguously secret-bearing. ⛔ `state` deliberately NOT added, though the central
scrubs it: in OAuth `state` is CSRF protection rather than a secret, meant to be compared by the client
and routinely logged. A log line is not worth the argument; a step result is a human reading back what
a recipe did, and redacting a non-secret there costs observability for nothing. The lists now diverge
there ON PURPOSE, which is the difference between an absence and an oversight. Post-condition after the
edit: `state` is the only central name still absent.

⭐ THE ARM FAILED FIRST AND THE FIX WAS RIGHT. Written behaviourally rather than as a membership check —
a name added to the Set with the matcher broken would still pass a membership assertion — it failed on
`expected … to contain '[redacted]'`. The subject was correct: the value WAS redacted, and the marker is
written through `URLSearchParams`, which percent-encodes it to `%5Bredacted%5D`. My assertion was
testing the serializer's spelling. Decoding first fixes it. That is four instruments in one session that
were wrong about code that was right.

Mutation-proved on the real subject: removing `ds_token` from the Set fails with "ds_token was left in
clear". Restored byte-identically; `it(` 29 to 30; tsc clean; 34 tests pass.

## V-1718 — the same mirrored function had a second divergence: a raw slice where the server truncates surrogate-safely

2026-08-26. Continued the V-1716 audit by sweeping the SHAPE rather than the token — comments claiming
a copy or parity relationship — across `packages/` and `apps/server`. 185 files carry such a comment,
32 of them inside `packages/`, which cannot import `apps/server`. The detector was proved on a known
positive first: V-1716's own "keep the central redactText credential classes mirrored here" is among
the hits.

Most are benign prose or type mirrors with real parity guards. Two claims in the same file were
VALUE/BEHAVIOUR mirrors with nothing comparing them, and checking both is what this entry records.

THE BACKOFF CURVE AND THE CONSTANTS AGREE. `BACKOFF_MS_BY_ATTEMPT` is 1/5/15/30/60 minutes in both
`packages/webhook-delivery/src/in-memory.ts` and `apps/server/src/services/webhook-worker.ts`, and
`MAX_ATTEMPTS` 6, `DEFAULT_TIMEOUT_MS` 10_000 and `TRANSPORT_ERROR_MAX_CHARS` 500 match. Sound today —
though the arm pinning the backoff claim asserts the mirror's own COMMENT text, so nothing would say
if the numbers parted.

⚠️ THE TRUNCATION DID NOT AGREE. The server bounds its transport diagnostics with
`sliceWithoutSplittingSurrogate` on BOTH slices; the copy used a raw `.slice(0, …)` on both. That
helper exists for a measured reason recorded in `lib/bounded-text.ts`: a bound landing mid-emoji leaves
an unpaired high surrogate, which does not survive `Buffer.from(out, 'utf8')` — it returns carrying
U+FFFD — and which Node's `setHeader` rejects outright with "Invalid character in header content". So a
transport failure whose 500th code unit fell inside an emoji stored a broken `errorMessage`.

SEVERITY, THE SAME BOUNDARY AS V-1716 AND STATED FOR THE SAME REASON. Both production delivery paths
call the server's own copy; this is the in-memory implementation, scoped by its own header to tests and
"small self-hosted single-process workloads". Real and shipped, not the hosted plane.

Fixed by mirroring the helper byte-identically and applying it at both sites. Post-condition rather
than derivation: `grep` for `slice(0, TRANSPORT_ERROR_MAX_CHARS)` in the package returns nothing.

⭐ THE EVIDENCE CHAIN, because byte-identity only transfers a property if the original has one. The
central helper is behaviourally tested — `sliceWithoutSplittingSurrogate('ab😀', 3)` is `'ab'`,
`('ab😀cd', 4)` is `'ab😀'` — so a copy proven identical inherits that. The new cross-source arm
compares the two bodies and fails on drift: mutating the copy's `0xdbff` to `0xdbfe` reports "the copy
has drifted from lib/bounded-text.ts". Restored byte-identically; `it(` 20 to 21; tsc clean.

⛔ AND I BROKE IT MYSELF ON THE WAY, in the way this log has a standing rule about. Rewriting the
function across three separate edits without re-reading between them left a stray closing parenthesis:
three package test files stopped PARSING, which reads as three failing files rather than as a syntax
error. Caught by re-reading the function and running the tests, then fixed by replacing the whole
function in one edit instead of patching it in pieces. The rule is written down; following it costs
less than the four minutes not following it cost.

## V-1719 — the third copy claim in the same file, closed while the values still agree

2026-08-26. `packages/webhook-delivery/src/in-memory.ts` makes three claims to copy the server. V-1716
found the credential classes eight behind; V-1718 found the truncation using a raw slice where the
server truncates surrogate-safely. The third is the retry schedule — "Backoff curve mirrors
apps/server/src/services/webhook-worker.ts" — and it is CORRECT: 1/5/15/30/60 minutes on both sides,
with `MAX_ATTEMPTS` 6, `DEFAULT_TIMEOUT_MS` 10_000 and `TRANSPORT_ERROR_MAX_CHARS` 500 matching.

Recorded anyway, because the reason it was correct is not that anything checked. The arm pinning that
claim asserts the mirror's own COMMENT text — the same one-file comparison that let the credential
classes drift for six weeks under a title that said "mirrored credential classes". A guard that reads
only the copy cannot distinguish a curve that agrees from a curve that has parted; both render as a
matching comment.

So the values are now compared against `webhook-worker.ts` directly, read out of both files and
restated in neither: the backoff table normalized whitespace-free, and the three scalars by name
(`DEFAULT_MAX_ATTEMPTS` against the server's `MAX_ATTEMPTS`, which differ in name and must not differ
in value). Each extraction asserts it parsed, because a regex that matches nothing compares nothing and
passes — the failure mode of every derived arm added this session.

Mutation-proved on the real subject: moving the third retry from 15 to 20 minutes reports "the mirrored
backoff curve has drifted", and raising max attempts to 7 reports `expected '7' to be '6'`. Restored
byte-identically; `it(` 20 to 22 across V-1718 and this entry; tsc clean; 22 tests pass.

⭐ All three copy claims in this file are now enforced against the file they name. That is the point
worth carrying: the fix for a hand-maintained mirror is not to check it once but to make the ORIGINAL
the thing the test reads, so the next divergence fails on the day it is written rather than six weeks
later in an audit.

## V-1720 — the arm I wrote to stop a frozen claim froze one in its own title

2026-08-26. The V-1719 arm's title read that delivery timing is "split across two implementations".
`a-parity-pin-cannot-freeze-a-claim-that-expires` went red on the next full run: 91 pin files freeze a
hand-maintained count against a ceiling of 90 that may only fall. The offending phrase is verbatim one
of that guard's own worked examples of the defect, sitting in the header six lines above the pattern
that caught it.

Not a false positive and worth recording as mine rather than quietly reworded: a count in prose is
wrong on the next change, and "two implementations" becomes false the day a third appears — which, in
a file whose entire subject is a copy of another file, is exactly the change to expect. Reworded to
"implemented in more than one place", which says the same thing and cannot go stale. Post-condition:
no line in the file matches `HAND_MAINTAINED_COUNT`.

⭐ The uncomfortable symmetry is the point. Three arms added tonight exist because a guard asserted a
property its own text could not support, and the fourth did the same thing in its title while making
that argument. The ratchet caught in one run what six weeks of review had not caught in the credential
mirror, because it DERIVES its number from the tree instead of restating it — which is the property
every arm in V-1716 through V-1719 was added to give something else.

⚠️ Separately, `proxy-connectivity-probe` failed one run and passed the next on a timing assertion
("expected 560 to be less than 520") while two suites were live on the machine. Recorded as observed,
attributed to load rather than to a change, and NOT investigated further here — a deadline test that
fails only under a concurrent suite is a flake report, and asserting more than that from two runs would
be the derivation this log keeps warning about.

## V-1721 — P-25 control-plane half: three saturation shapes swept, none found, and what that does NOT cover

2026-08-26. The owner reports the app freezing under sustained real use — many activities, then stuck,
then unusable until a full restart, with no error message. "Works, then degrades, then stops" is a
bounded resource filling, so the control plane was swept for the three shapes that produce it. This
entry is a NEGATIVE result, recorded because eliminating a plane is half the value when the other half
cannot be seen from here.

1. IN-MEMORY STORES WITHOUT EVICTION. 80 long-lived Maps/Sets in `apps/server/src` are written; 17 have
   no `delete`/`clear` in their file. Every one resolves: SIX are `InMemory*` repositories production never
   constructs (`InMemoryAgentSessionsRepo`, `InMemoryAuthCache`, `InMemoryAgentTurnReceiptsRepo`,
   `InMemoryBYOKAnthropicRepo`, `InMemoryCryptoOrdersRepo`, `InMemoryBundledLlmRepo`, `InMemoryFleetNodesRepo`
   — bootstrap wires the Drizzle and Redis ones), FOUR are bounded by static definition counts (scheduled-job
   handlers, metric definitions, the legal catalogue, the tier-by-price map), and one —
   `FleetInboundFrameBudget.states` — is keyed by authenticated fleet-node identity and deliberately
   reconnect-resistant, since a bucket that reset on reconnect would not be a rate limit.

2. LISTENERS ON LONG-LIVED EMITTERS. Eleven files register persistent listeners; ten remove none, and
   all ten attach to per-request or per-socket objects that are collected with them. The one long-lived
   emitter is `IncidentEventBus`, whose `subscribe` returns a closure that deletes the listener, and both
   SSE routes hold it and call it from an idempotent `cleanup` bound to BOTH `close` and `error`.

3. TIMERS. Seven files call `setInterval`. Both SSE heartbeats pair it with `clearInterval` in the same
   idempotent cleanup and additionally `unref()`. The two unpaired calls are single process-lifetime
   intervals started at boot, which is what they are for.

⛔ WHAT THIS DOES NOT COVER, stated because a clean sweep of three shapes is not a clean bill of health.
It is STATIC and it is in-process: it says nothing about Redis key growth, Postgres, socket and stream
write buffers or backpressure, the WebSocket send queue, promise chains that never settle, or file
descriptors. It ran no sustained load, so it cannot see a resource that fills only under the traffic the
report describes — and the report is precisely of something that survives light use. It also covers
neither the GUI nor the device fork, which are the two planes the freeze is most likely to live in and
the two this session cannot open.

So the honest claim is narrow: the control plane's in-process bounded resources are not the leak, on the
three shapes checked, with no load applied. Reproduction under sustained multi-site traffic remains the
only thing that can localise this, and nothing here substitutes for it.

## V-1722 — an unreachable worker answered 500 on the one send path that bypassed the reconciler

2026-08-26. Continued the P-25 hunt into the shape both agents independently ranked highest: a writer
that stops draining. The control plane turns out to guard this deliberately, and the audit found one
site that does not.

THE OUTBOUND PATH IS BOUNDED AND DOCUMENTED. `routes/fleet-events.ts` refuses a frame once
`bufferedAmount + frameBytes` passes `FLEET_WS_MAX_BUFFERED_BYTES` (96 MiB), and says why the refusal is
synchronous: "every registry correlator already converts transport throws to its bounded error outcome
and clears its pending timer. The shared node socket stays open, so a later request can proceed once the
existing queue drains." That is a degrade-and-recover design, not a wedge.

⚠️ THAT SENTENCE IS A CLAIM, AND IT COVERS THE CORRELATOR ONLY. Five call sites send on a node connection
WITHOUT going through a correlator. Enumerated rather than sampled: three in `routes/agent-sessions.ts`
sit inside a try whose catch reconciles — `closeFailedSessionAssign` closes the row, re-sends `sessionEnd`
on the SAME connection, and retains one bounded pending teardown if that fails, with its comment naming
the exact risk ("leaving the row active would consume a slot until the orphan reaper and leave the GUI
waiting for a publisher that never starts"). A fourth, `cp-daemon-reconcile`, wraps its send in a
per-session try/catch INSIDE the loop, so one failure cannot abandon the remaining orphans. Sound, and
sound on purpose.

THE FIFTH WAS NOT. `POST /v1/mac-nodes/:id/control` resolves a connection, answers **409** when there is
none — "has no live control-plane connection — cannot deliver the command" — and then calls
`sendControlCommand` with no guard at all. `registry.get()` proving a connection existed does not prove
the send lands: the socket can close in the window since, and the frame is refused outright once the
outbound buffer is over cap. Both are the node being unreachable, the identical customer-facing
condition the line above answers 409 for, and the throw escaped to Fastify as a **500**. An unreachable
worker is not this server erroring, and the route already knew that one line earlier.

Converted at the boundary rather than narrowed by message: at that point the command demonstrably did
not reach the node whatever the cause, which is what the caller needs. The original error is logged so a
genuine defect stays diagnosable instead of being flattened into a 409. Mutation-proved by reverting the
guard: the new arm reports "expected 500 to be 409". Restored byte-identically; `it(` 6 to 7; tsc clean.

⛔ THIS IS NOT THE FREEZE, and saying so is the point. It is a status-fidelity defect on an admin route.
Nothing here degrades over sustained use, and the outbound cap it exposes recovers by design. P-25
remains undiagnosed.

⚠️ TWO INSTRUMENT ERRORS ON THE WAY, both caught by widening rather than by suspicion. A backpressure
sweep scored `fleet-control-registry.ts` as having five backpressure signals; all five were the word
"drain" in a QUEUE-drain sense, an unrelated meaning. Then a grep for `bufferedAmount` scoped to that
file returned nothing and I concluded the send path was unguarded — the check lives one module away in
the route. Both would have produced a confident, wrong finding; the second would have been a fabricated
security-adjacent claim about a file that is in fact careful.

## V-1723 — the OAuth authorization-code flow audited end to end: sound, and every security check pinned

2026-08-26. Audited `POST /v1/oauth/token` end to end. Prior art covers the OAuth ADMIN-AUDIT gaps
(V-1547 and the enum-migration item) but nothing audits the exchange itself, which is the part where an
OAuth implementation classically fails. It does not fail here. Recorded because a security-critical
surface verified sound is worth as much as a defect found, and because it stops the next agent
re-auditing it.

EVERY CLASSIC DEFECT CLASS IS CLOSED, read rather than assumed:

```
  code single-use        atomic — consumeCodeForToken returns 'code_unavailable'
  client binding         code.client_id vs args.client_id, AND re-checked in the transaction
  redirect binding       code.redirect_uri vs args.redirect_uri, plus an allowlist + length cap
  PKCE                   verifyS256Challenge(verifier, challenge)
  code expiry            enforced in SQL (gt(createdAt, now - TTL)), again in the service, again at commit
  at-rest secrecy        codes, authorization ids and access tokens all stored as sha256Hex, never plaintext
  client authentication  constantTimeStringEqual over hashes
  client revocation      re-checked inside the transaction ('client_authority_changed')
```

⭐ TWO PIECES ARE BETTER THAN THE CHECKLIST REQUIRES. The `consumed_at !== null` test is only a
fail-fast; the REAL single-use guarantee is the atomic `consumeCodeForToken`, which re-verifies
client_id, account_id and the TTL inside the same transaction that consumes the code and inserts the
token — so a double exchange racing itself loses at the database rather than at a read. And
`authenticateClient` defeats client ENUMERATION as well as timing: for an unknown client it sets
`expectedSecretHash = client?.client_secret_hash ?? presentedSecretHash`, comparing the presented hash
against itself so the work is identical, then rejects on the null check, with one
`invalid client credentials` for unknown, revoked and wrong-secret alike.

SOUND IS NOT THE SAME AS PINNED, so each check was mutation-proved by deleting it. Control first: 45
OAuth unit files, 501 tests executing at baseline. Six of six caught:

```
  PKCE verification          2 failed        single-use pre-check       1 failed
  client_id binding          2 failed        ATOMIC race-safe branch    1 failed
  redirect_uri binding       3 failed        client revoked at commit   3 failed
```

The atomic branch being covered is the one worth noting: a race-safe path is the usual place coverage
stops, because provoking the race is harder than asserting the happy path. `services/oauth.ts` restored
byte-identically after every mutation and verified clean against HEAD.

BOUNDED: the mutations were scored against `tests/unit/*oauth*` — 45 files. The OAuth integration tests
are DATABASE_URL-gated and did not execute here, so the counts above are a floor on what catches each
deletion, never a ceiling. That direction is the safe one for this claim: every check is pinned by at
least the unit half, and additional integration coverage can only add to that.

## V-1724 — the Gmail-alias dedup fix reached signup and not OAuth sign-in, where the collision becomes a 500

2026-08-26. Audited the OAuth-client (sign-in-with-Google/GitHub) link flow after V-1723 found the
authorization-code exchange sound. The link flow's own design is good and its riskiest question has a
better answer than the checklist wants: on an existing-email collision it does NOT auto-link, and it
does not trust the IDP's `email_verified` either — it issues a one-time token and emails it, so control
of the mailbox is proved independently of what the provider asserts. The absence of an `email_verified`
check looked like the finding and is in fact the stronger design.

⚠️ THE DEFECT IS ONE LOOKUP. The collision test is
`accounts.findIdByEmail(args.email)` → `findAccountByEmail`, which matches
`eq(accounts.email, email.trim().toLowerCase())` — the LITERAL column. Signup does not: the 2026-07-01
security fix (migration 0096, scope corrected by 0102) added `canonical_email` precisely so a signup
"collides with ANY existing account whose Gmail dot/+tag canonical form matches — regardless of which
literal variant was stored first". `canonicalizeEmailForDedup` strips `+tag` and removes every dot for
gmail.com/googlemail.com. `createAccount` computes and stores it on BOTH creation paths, and
`accounts_canonical_email_unique` is a real unique index on it. The OAuth path never got the matching
lookup.

So for a customer whose stored literal differs from the literal the IDP returns — dots or a `+tag`,
which for Gmail are the SAME human's mailbox:

```
  step 1  no existing link (first OAuth sign-in)                    → continue
  step 2  findIdByEmail(idp email)  literal ≠ stored literal        → MISS, no collision detected
  step 3  createFromIdp → createAccount → canonical form collides   → accounts_canonical_email_unique
          nothing catches 23505                                     → 500
```

The customer cannot sign in with Google and receives a server error, when the Verdict-1 merge flow —
already built, already correct — was designed for exactly this collision and is simply never reached.
Same class as V-1716 and V-1718: an invariant hardened on one path while its sibling kept the old
lookup, with nothing comparing the two.

⛔ NOT A TAKEOVER, and worth saying so plainly. Canonicalisation applies to Gmail only, where every
dot/+tag variant is the same mailbox, so no attacker can hold a variant of someone else's address. The
impact is a denial of sign-in plus a 5xx on a legitimate customer action, not an account-linking bypass.

⚠️ BOUNDED — NOT REPRODUCED. This is read from source and schema, with no database: I have not observed
the 23505, and the trigger requires the IDP to return a literal differing from the one registered. That
is plausible rather than proven, and the reachability is the half a static read cannot settle.

FIX NOT APPLIED, deliberately. The repair is to consult the canonical lookup in step 2 so the collision
routes into the existing merge flow, and — strictly — to address the merge email to the ACCOUNT's stored
address rather than `args.email`, which needs the repo interface widened from returning an id to
returning the row. Both change sign-in semantics on an auth path while a release is being cut, and the
owner held W-10 for less. Recorded with the evidence so the decision is theirs and the work is one
lookup, not an investigation.

## V-1725 — V-1724 reproduced against a live database, dated to the week it drifted, and the class closed without touching the instance

2026-08-26. Three things follow V-1724, in the order they change what is known.

⭐ FIRST, IT IS OBSERVED RATHER THAN READ. V-1724 stated its own boundary — read from source and schema,
no database, the 23505 never seen. The agent holding the database ran the repro: an account created with
the literal `first.last.<n>@gmail.com` stores `canonical_email` `firstlastb<n>@gmail.com`;
`findAccountByEmail` on the undotted spelling MISSES; `createAccount` then THROWS on the insert. Every
link in the chain held, and the two spellings differ literally, so the only unique index that can fire
is the canonical one. The half a static read could not settle is settled.

SECOND, THE DRIFT HAS A DATE. The OAuth-client accounts wiring in `lib/bootstrap.ts` was written
**2026-05-15**. `canonical_email`, `findAccountByCanonicalEmail` and the `findAccountByEmailOrCanonical`
helper all landed **2026-07-01** — six and a half weeks later — and moved FOUR call sites in
`services/auth-flows.ts` onto the safe helper. The OAuth caller was not moved. Its comment describes
what it wires and never claims the literal lookup is deliberate, which is the tell: this is an omission,
not a decision. ⚠️ And the reason it was missed is worth more than the miss — the sweep that adopted the
new helper worked in `auth-flows.ts`, and the one caller that needed it lives in `bootstrap.ts`. **A
hardening that introduces a safe helper must be swept by every FILE calling the unsafe primitive, not by
the file where the helper lives.** Neither file shows the problem on its own.

THIRD, THE CLASS IS NOW CLOSED WHILE THE INSTANCE STAYS OPEN. Fixing the caller changes sign-in
semantics on an auth path and remains the owner's call. Preventing a SECOND one needs no decision, and
nothing was stopping one: five existing guards cover canonicalisation BEHAVIOUR and not one constrains
WHO may consult the literal column. A static arm now enumerates every caller outside the repo method and
the service that pairs it with a canonical lookup, and requires each to be exempted with a stated
reason. The single exemption carries V-1724's, including what the repair costs.

Mutation-proved in three directions, the third being the one that matters:

```
  a SECOND unexempted caller        FAILS, naming lib/client-ip.ts
  an exemption gone stale           FAILS — a roster may not outlive its reasons
  a COMMENT merely mentioning it    PASSES — negative control
```

That last one is why the arm reads `codeOnly(...)` rather than raw text. This repo is full of prose
about the literal lookup — the ledger above included — and a text match would have reported its own
documentation as a violation. The first version did exactly that and would have shipped a guard whose
first false positive was the entry describing it. Files restored byte-identically after every mutation;
`it(` 2 to 3; tsc clean.

## V-1726 — swept "a helper exists to replace a raw call"; both real instances are already closed

2026-08-26. V-1716, V-1718 and V-1724 are one shape: a safe helper exists and some caller still uses the
raw primitive. Swept the marker that shape leaves — a comment telling callers to go through a helper —
across `apps/server/src` and `packages/*/src`. Six files; four are business-process prose ("cancellation
must go through support") or a preference for mockability. Two are the real shape, and both are closed.

`lib/unknown-request-fields.ts` says a structural test "can pin that customer-facing writes go through
here rather than calling `safeParse` directly". That claim is honoured rather than aspirational:
`unknown-request-fields-coverage-invariant` exists, alongside `a-hand-validated-write-body-is-listed`,
`an-anonymous-exemption-is-earned-per-route`, `an-exempt-surface-that-can-drop-a-field-is-listed` and
`the-anonymous-exemption-rests-on-a-published-shape`, whose four arms measured V-951's two stated reasons
and recorded that BOTH have stopped holding — the exclusion is filed as an open decision rather than
left reading like a conclusion. Nine files on one helper. Nothing to add.

`services/webhook-worker.ts` says recovery "must go through `recordRetry` / `recordDlq` rather than a raw
UPDATE: both are fenced on `status='in_flight'`". Checked all TEN `update(webhookDeliveries)` sites: every
one is fenced, each on the status its own operation requires — `in_flight` for claiming, reclaiming,
discarding and outcome recording; `inArray(status, ['delivered','failed'])` for `replay`; `'dlq'` for
`requeue`, whose comment records the unfenced version as a fixed bug. The fences are guarded by 29 test
files including four written for nothing else (`webhooks-repo-reset-to-pending-in-flight-guard`,
`webhooks-customer-replay-fenced-delivery`, `webhook-claim-lease-outlasts-delivery-attempt`,
`db-durable-webhook-reclaim-fence-drizzle`).

⚠️ MY DETECTOR FLAGGED TWO OF THOSE TEN AND BOTH WERE FALSE. It tested for the literal `in_flight`,
because that is the fence the comment names — but the correct fence VARIES by operation, and `replay`
and `requeue` are precisely the two that must NOT match an in-flight row. A detector that fixes one
correct value for a property that legitimately varies reports the two most carefully written sites as
the defective ones. Caught by reading both, which took less time than the sweep did.

BOUNDED: the marker is a COMMENT, so this finds helpers whose authors said so. A helper introduced with
no such sentence, and a raw caller beside it, is invisible to this sweep — which is the same limit that
made V-1724 findable only because someone had written down what `canonical_email` was for.

## V-1727 — the guard written to stop stale exemptions had two ways of keeping one

2026-08-26. The OAuth-client fix landed in `5c9b01115`, so the single exemption V-1725 recorded is
spent. Removing it exposed two defects in my own arm, both of the class it was written to catch.

FIRST, THE ROSTER WAS KEYED ON THE WRONG THING. It exempted a file for "calling
`findAccountByEmail`". After the repair `bootstrap.ts` still calls it — correctly, paired with
`findAccountByCanonicalEmail`, which is exactly what `findAccountByEmailOrCanonical` does — so the file
remained a "caller", kept its exemption, and the recorded reason went on describing a 500 that no longer
happens. An exemption keyed on something BROADER than the defect outlives the defect silently, and the
arm reported green throughout. It now keys on the unpaired shape: a literal lookup with no canonical
lookup beside it.

⭐ SECOND, AND THE ONE WORTH CARRYING: the non-vacuity control asserted the defect still existed.

```ts
expect(callers.length, 'no caller found — the detector would pass on an empty set').toBeGreaterThan(
  0,
);
```

That is a progress bar wearing a control's clothes. It holds only while at least one offender survives,
so it goes RED on the commit that fixes the last one — the guard punishing the repair it exists to
drive. It fired for real: with the fix in the tree the count was zero, which is the GOAL state, and my
arm called it a broken detector. What actually proves a detector can see its subject is that the
primitive is found at all, safely or not. The arm now floors on `anyCaller`, which is unaffected by
whether any caller is unsafe.

Mutation-proved in three directions, the middle one being the point of the change:

```
  an UNPAIRED literal caller        FAILS, naming lib/client-ip.ts
  a PAIRED literal caller           PASSES — the shape the old arm would have demanded an exemption for
  an exemption gone stale           FAILS — delete the entry
```

`EXEMPT` is empty now, and an entry must name a file AND say why it cannot pair the two lookups. Files
restored byte-identically after every mutation; `it(` unchanged at 3; tsc clean.

⚠️ SEQUENCING, recorded because it nearly cost a shared red. The tightened arm was ready while the fix
was still UNCOMMITTED in the peer's working tree. Landing it then would have reported the exemption
stale — correctly — against a tree where HEAD still held the unpaired lookup, reddening the suite over
a race between two agents rather than over a defect. Held until `5c9b01115` was in, verified BOTH HEAD
and the working tree paired the lookups, and only then landed. A static guard reads the worktree, so its
verdict is a function of a peer's uncommitted state; that is a coordination fact, not a bug, and the
remedy is to sequence rather than to weaken the arm.

## V-1728 — swept the vacuity-control shape across every suite; V-1727's bug is a one-off

2026-08-26. V-1727 found a non-vacuity arm that asserted the DEFECT still existed, so it went red on the
commit that fixed the last instance. The peer generalised it better than the finding was written: any
control flooring a found-set is suspect when the set it counts is a DEFECT population rather than a
SEARCHABLE one, and the tell is "does this assertion still hold the day the last instance is fixed?"
Swept for it.

⛔ THE DETECTOR FAILED ITS CONTROL TWICE, and both failures are more useful than the sweep's result.

The first version keyed on offender-sounding variable names and messages. It did not flag the KNOWN
positive — my own arm from one commit earlier — because the variable was named `callers` and the message
said "no caller found". **The signal is not in the naming.** Replaced with a structural rule: the same
set is floored above zero AND required empty by a later assertion.

The second version still missed it, because the floor was written `toBeGreaterThan(0)` and my pattern
required `[1-9]`. **`toBeGreaterThan(0)` and `toBeGreaterThanOrEqual(1)` are the same assertion**, and I
had filtered on the literal digit — the commoner spelling was invisible to a detector built to hunt
exactly that assertion. That is this log's own "a guard that matches literals cannot see a constant",
committed by the person who wrote it down. Only after both fixes did the positive control flag and the
negative control (the same file after repair) stay silent.

THE RESULT IS A CLEAN NEGATIVE. Across `apps/server/tests`, `packages/*/tests` and `scripts/tests`: 39
sets are both floored above zero and required empty. Classified by how each floored set is DERIVED —
24 by enumeration (`readdirSync`, `matchAll`, `Object.keys`, a `…Routes()` / `…Sites()` helper), 15 by
accumulation (`const probes: Probe[] = []` filled in a `beforeAll`), and **0 by filtering for a
problem**. Every one floors a population that exists whether or not the codebase is correct, with the
emptiness applied to a filtered offender subset — the sound shape. A separate pass over the 756
non-server app test files found one such set, also an accumulator.

So V-1727's arm was the only instance, which is the answer worth having: the pattern is understood here
and I wrote the exception.

BOUNDED: the classifier reads each floored variable's DEFINITION. For the 15 accumulators it infers from
the `[]`-then-push shape rather than tracing every push, so a `[]` later filled with only-the-broken-ones
would read as an accumulator and be missed. Given zero problem-filtered hits and the accumulators all
being probe/result collections built before assertions run, that residual risk is small and stated
rather than dissolved.

## V-1729 — the three surfaces V-1628 bounded itself out of, audited: all sound, one for a reason worth pinning in prose

2026-08-26. V-1628 audited team-member REMOVAL and stated its own boundary: "not an audit of invite
acceptance, role changes, or the auth-cache invalidation that follows a removal." Three named gaps in
this log's own words. All three are now closed.

INVITE ACCEPTANCE — sound, and pinned. `POST /v1/team/invites/accept` takes only a token from the body
and derives `acceptingAccountId` from the authenticated context, so the caller cannot name whose
membership is created. The service hashes the presented token, rejects an expired invite, and refuses
when the signed-in account's email does not equal the invitee's. Consumption is an ATOMIC CAS on
(id, token hash, still-unaccepted) in the same transaction that upserts the membership, and the
comment names the attack it closes: binding the HASH stops an invalidated old link winning with its
stale role after a concurrent re-invite, with the repository sourcing authority fields from the row the
CAS returns rather than the earlier snapshot. Role is fixed at invite creation and defaults to
`member`, so an accept cannot choose its own privilege.

Mutation-proved against a 345-test control, three of three caught: deleting the email binding, the
expiry check, or the CAS-failure branch each turns two tests red.

ROLE CHANGES — there is no such surface. No route mutates a role and no service method exists to;
changing a member's role means re-inviting, which re-enters the flow above with its defaults. The gap
V-1628 named is empty rather than unguarded, which is a different and better answer.

AUTH-CACHE INVALIDATION AFTER REMOVAL — sound, and NOT because invalidation works. Team memberships are
"loaded on auth-cache misses and refreshed on every positive cache hit, so membership/role/owner-status
changes remain authoritative EVEN IF DISTRIBUTED INVALIDATION IS LOST". Removal therefore takes effect
on the next request regardless of whether the invalidation reached Redis. The cache is an accelerator,
never a staleness budget — so the surface V-1628 flagged cannot carry the bug it was flagged for.

⭐ ONE THING TO PIN IN PROSE, because the next reader will see it as a bug. The accept-time comparison
is `acceptingEmail.trim().toLowerCase() !== invite.inviteeEmail`, with the invite side normalised the
same way at creation — LITERAL normalisation, not the `canonical_email` form V-1724 is about. So a
Gmail alias that differs from the invited spelling cannot accept, and gets a clear ConflictError. That
is the SAFE direction of the same asymmetry: it fails CLOSED, refusing a membership rather than granting
one. **Making this canonical to match V-1724 would loosen a security check** — the invite is an
authorisation to one address, and dot/+tag folding would let a different literal claim it. V-1724's fix
belongs on the sign-in path, where a miss costs a 500; it does not belong here, where a miss costs
nothing and a hit would grant team access.

BOUNDED: mutations were scored against the 29 team unit files (345 tests). Team integration tests are
DATABASE_URL-gated and did not execute, so the three caught counts are a floor on what fails, not a
ceiling — the safe direction for a claim that each check is pinned.

## V-1730 — the two email lookups differ in DIRECTION, and only one has a collision question

2026-08-26. Checking whether V-1729's conclusion collides with V-1727's guard — the guard requires every
`findAccountByEmail` caller to pair with the canonical lookup, and V-1729 argues the invite flow must
NOT canonicalise. Both hold, and the reason is a distinction sharp enough to be worth pinning where
someone will meet it.

```
  findAccountByEmail(email)     EMAIL → ACCOUNT   a Gmail alias may collide with a different
                                                  literal; canonical decides if they are one account
  findAccountEmail(accountId)   ACCOUNT → EMAIL   no collision question exists — the account is
                                                  already identified by its primary key
```

The team invite flow uses the SECOND to fetch the signed-in account's own address, so the guard
correctly never sees it, and the two conclusions never meet. The names differ by one word.

⭐ The substantive half is that canonical is the SAFE answer in one direction and the UNSAFE one in the
other. On sign-in, a literal-only lookup misses a collision and costs a 500 (V-1724). On invite
acceptance, canonical matching would let a DIFFERENT literal claim an invite addressed to one mailbox —
loosening an authorisation. Same folding rule, opposite consequence, decided by whether a miss refuses
or grants. Recorded in the guard itself rather than only here, because the person at risk of conflating
them is the one adding a caller or editing that arm.

No behavioural change; a comment in `auth-email-canonicalization-security` and this entry. `it(`
unchanged at 3; tsc clean; 3 tests pass.

## V-1731 — the admin routes that omit requireAuth are fine, and the "gap" in what pins that was my test selection

2026-08-26. Audited the admin crypto-order surface, the half V-1649 did not reach (it took cancel and
the IPN). Every route there reads
`preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')]` — **no
`requireAuth`**, where the team and MFA routes all begin with one. On money endpoints that looks like an
unauthenticated admin surface.

It is not. `middleware/auth.ts` decorates `requireScope` so it authenticates first:
`if (!request.account) { await requireAuth(request, reply); }`, and `requireMfaFresh` does the same.
Omitting `requireAuth` from the chain is therefore safe, and the finding would have been fabricated. Read
before reported, which is the only reason it was not filed.

MEASURED, because an implicit behaviour is worth sizing: **61 preHandler chains use `requireScope`
WITHOUT `requireAuth`**, against 104 that name both — spread over 17 route files and concentrated in the
highest-privilege ones (admin-crypto-orders 11, admin-accounts 11, admin-incidents 7, admin-webhooks 5).
So the implicit authentication is load-bearing for 61 routes, most of them admin.

⛔ AND THEN MY INSTRUMENT PRODUCED THE ALARMING ANSWER. Deleting the two-line self-authentication and
running the `*auth*` + `*admin*` UNIT files — 232 files, 2563 tests, a control that executed — turned
exactly ONE test red, and it was `middleware-auth-content-parity`: a regex over the source. Read at face
value that says a security property carrying 61 admin routes is pinned only by its spelling, which is
the V-1711 shape on a much more serious property, and it is wrong.

The same mutation against the FULL suite fails **357 tests**, overwhelmingly behavioural — `admin-accounts`
asserting its 200, 403 and 404, `account-audit`, `account-rate-limits`, and integration specs throughout.
The property is heavily pinned by behaviour. What I had measured was my own file glob: `*auth*` and
`*admin*` match unit filenames, and the tests that exercise these routes end-to-end are named for the
FEATURE rather than for the middleware they depend on.

⚠️ THIRD TIME TONIGHT A NARROW SCOPE NEARLY PRODUCED A FALSE SECURITY CLAIM, and the shape is identical
each time: V-1722's `bufferedAmount` grep scoped to one file said the send path was unguarded when the
check sat one module away; V-1712's sweep scored a run that never executed; this one selected tests by
filename for a property whose tests are named after something else. **A negative from a subset is a
statement about the subset.** The cheap correction in all three was to widen and re-run rather than to
reason about why the result might still hold.

BOUNDED: the 357 figure is one full-suite run taken while a peer's suite was also live, so the count is
approximate; the conclusion rests on its order of magnitude and on which files failed, neither of which a
concurrent run moves. `middleware/auth.ts` restored byte-identically and verified clean against HEAD.

## V-1732 — a tier missing from the price map ranks ABOVE every paid tier, and nothing walked the enum to notice

2026-08-26. Picked the next audit target by measurement rather than guess: counted, for every
`apps/server/src` module over 60 lines, how many test files reference it (control:
`byok-anthropic-encryption` at 11, high as expected). `services/crypto-tier-activation.ts` came back
lowest by size — 385 lines of money-granting logic. That count under-reported (a dedicated test file
exists; the basename simply appears once), but the audit it prompted found a latent defect.

`tierActivationRank` is the whole upgrade decision: `free` returns 0, otherwise
`TIER_MONTHLY_PRICE_CENTS[tier] ?? Number.POSITIVE_INFINITY`. The fallback is deliberate for
`enterprise` — sales-negotiated, no self-serve price, so a crypto purchase must never overwrite it —
and that case is explicitly pinned. ⛔ But the fallback applies to ANY unmapped tier, and it fails OPEN:
a tier added to the enum and forgotten in the price map does not rank low or throw. It ranks above
$1,499/mo `api_scale`, so `isCryptoTierUpgrade` treats buying it as an upgrade from ANY state, and —
the other half — refuses every later move away from it, stranding that customer.

NOTHING COULD HAVE NOTICED. The ordering arm walks "the six self-serve tiers" as a HARDCODED list, so a
seventh is invisible to it. Every other consumer iterates `Object.keys(TIER_MONTHLY_PRICE_CENTS)` —
which walks the MAP, and is therefore structurally blind to an enum member absent from it. Measured: the
enum has 8 members, the map has 6, and the two absent are exactly the two that are special-cased today.
The map's own comment names the eventual seventh out loud — "the future api_pro tier" — so this is a
documented expectation, not a hypothetical.

Not a defect today: all 8 tiers are accounted for. It is a money decision that fails open on an
OMISSION rather than a mistake, which is the harder kind to catch in review.

Closed by walking the ENUM — the one direction that can see the omission — and requiring every tier to
be priced or declared deliberately unpriced WITH the rank it should carry. The declared ranks are then
checked against what the function actually returns, so the roster cannot drift from the behaviour it
describes, and priced tiers must rank by their price rather than by the fallback.

Mutation-proved three ways, two on the real subject rather than the guard's list:

```
  a tier drops out of the price map    FAILS, naming api_starter
  rank stops equalling the price       FAILS — "solo_manual should rank by price: 7901 to be 7900"
  the declared roster drifts           FAILS — "enterprise does not rank as declared"
```

All three files restored byte-identically; `it(` 18 to 19; tsc clean; 30 tests pass.

## V-1733 — I mutated authentication in a shared tree with an untrapped restore, and a peer was mid-commit

2026-08-26. V-1731's measurement required deleting `requireScope`'s implicit `requireAuth` and running
the suite. The peer saw the mutation live in their own `git status` while committing P-27. For roughly a
minute the shared working tree contained admin middleware with authentication removed. Nothing came of
it — their commit named four files by pathspec and could not have carried mine — but the near-miss is
mine and belongs in the log from my side, not only theirs.

⛔ TWO SEPARATE FAILURES, and I had a rule written down for the first.

**One: the restore was sequential, not trapped.** The command ran mutate → `npx vitest run` (a 250s full
suite) → `cp` the snapshot back, with no `trap cleanup EXIT INT TERM`. This log already carries that
exact lesson — a foreground mutate/test/restore leaves the file MUTATED if the command times out, and
its own note says the disarmed gate "sat in a worktree shared with other agents". I used traps earlier
tonight on the format-hook and redaction mutations and then did not use one on the mutation that
deleted authentication. The rule was not missing; it was not applied where it mattered most.

**Two: a trap would not have been sufficient anyway, and that is the new part.** A trap protects against
MY process dying. It does nothing about the window in which the mutation is legitimately live — the 250s
the suite takes — during which a concurrent agent's bare `git commit` would capture it. Those are
different risks needing different mitigations: the trap for my death, and telling the peer BEFORE the
mutation goes in for theirs. I told them after it came out, which was only safe because the restore
happened to complete.

⚠️ WHAT THE PATHSPEC HABIT ACTUALLY BOUGHT, stated precisely because it is easy to over-claim. It did
not prevent the mutation; it prevented the mutation from being COMMITTED by someone who never touched
it. Four times tonight it refused a stale index; this time it refused an unauthenticated admin surface
that would have landed behind a green-looking gate — green because the suite ran either before the
mutation or after the restore, never against what was on disk at the moment of the commit.

⭐ ADOPTED, and narrower than "be careful": a mutation of an AUTH or CREDENTIAL primitive in a shared
tree gets the peer told before it goes in, gets its restore in a trap, and gets its window kept to the
smallest test set that can answer the question rather than the full suite. V-1731 needed the full suite
to refute a narrow result — so the correct order was narrow first, then announce, then widen, which
would have cut the exposure to the seconds the targeted run takes.

No production change; `middleware/auth.ts` verified clean against HEAD with all three self-authenticating
guards present.

## V-1734 — recipe payload encryption audited: sound, with one latent inconsistency I am deliberately NOT guarding

2026-08-26. Continued picking targets by measurement. `services/recipe-payload-encryption.ts` — 322
lines, two test references, LIVE (`db/recipes-repo.ts` imports it), and **no prior art in this log**.
Encryption with thin coverage and no audit history is the strongest remaining shape.

It is sound, and on the axes that actually decide whether AAD binding is real rather than decorative:

```
  AAD content        JSON.stringify([purpose, 2, accountId, recipeId, slot]) — delimiter-safe,
                     bound to the ACCOUNT, the RECIPE and the SLOT, so a ciphertext cannot be
                     moved between rows, accounts, or the two payload fields of one recipe
  AAD inputs         normalizeContext throws unless accountId is a UUID and recipeId matches
                     rec_<uuid>, so nothing malformed reaches the authenticated string
  enforcement        setAAD → setAuthTag → decipher.final() IS called, which is what makes GCM
                     verify. Without final() the tag is never checked and the AAD is decoration
  read path          readRecipeIntentLog REFUSES anything that is not a v2 envelope, by message
                     — "not a v2 envelope" — so a v1 row is unreadable rather than downgraded
  v1                 reachable ONLY through a bootstrap-only converter, which decrypts the
                     unbound legacy ciphertext and RE-ENCRYPTS it with the full v2 AAD
  bounds             key length checked, plaintext size capped, and an exact-UTF-8 round-trip
                     assertion that rejects a lone surrogate rather than returning U+FFFD
```

⚠️ ONE LATENT INCONSISTENCY, recorded because it is real and NOT guarded because it is not a defect.
The version `2` is a bare literal in FIVE places — the two envelope interfaces, the AAD builder, and the
two constructors — with no named constant tying them. A v3 that bumped the envelopes and missed the AAD
would give v2 and v3 ciphertexts of the same record an IDENTICAL authenticated context.

⭐ I am not adding a guard for it, and the reason is the discipline rather than laziness. The AAD's job
is to bind a ciphertext to its CONTEXT — account, recipe, slot — and it does that correctly; the version
byte is belt-and-braces. Exploiting the fork would require substituting one ciphertext for another in
the database, which needs write access that is already game over. Compare V-1732, which I did guard: a
money decision failing OPEN on an omission, reachable with no special access. **Guarding every latent
inconsistency dilutes the signal of the guards that mark real ones**, and this log is more useful if
"there is an arm for this" keeps meaning something. Recorded here so a future v3 has the warning
attached to the thing it would break.

BOUNDED: this audited the crypto core, the AAD construction and the version handling. It did NOT audit
key provisioning, rotation, or where `encryptionKeyBase64` comes from — those sit in bootstrap and
config, and a key that is well-used but badly sourced would not show up in anything read here.

## V-1735 — profile blobs on the session-assign path: sound, and sound at the strongest of the three binding levels

2026-08-26. `services/profile-store.ts` — 370 lines, ONE test file, live on the session-assign path
(imported by `routes/profiles.ts`, `routes/agent-sessions.ts` and bootstrap), and no prior art in this
log. A durable customer asset handed to a remote box over presigned URLs is the strongest remaining
shape, so it was the next target by the same measurement that produced V-1732.

⚠️ THE FUNCTION ACCEPTS WHAT IT MINTS AGAINST. `buildAssignProfileBlock(r2, profileId, dek, opts)`
verifies no ownership: it takes a profile id and a DEK and returns presigned R2 URLs for that profile's
sealed store. Read alone, that is the shape V-1652 found its one defect in — a helper trusting a
caller-supplied identity. Read in context it is fine, and the reason is worth recording because it is
stronger than the usual answer.

THE GATE IS THE DEK, AND THE DEK IS BOUND BY KEY DERIVATION. The dispatch calls
`profilesService.getProfileDek({ profileId, accountId })`, and `buildAssignProfileBlock` is reached only
inside `if (dek !== null)` — so no URL is minted unless the DEK resolved. `getProfileDek` scopes its row
lookup by `accountId` AND then calls `unwrapProfileDek(masterKey, accountId, profileId, wrapped)`, which
derives a TENANT master key from the account id before unwrapping. So a mismatched account does not fail
a WHERE clause — it derives a DIFFERENT KEY and the unwrap fails cryptographically.

⭐ That is the third and strongest of the binding levels this log distinguishes: identity DERIVED rather
than accepted, identity bound as AAD, and identity bound into KEY DERIVATION. Only the last survives a
query bug. It also means the provenance of `accountId` in the dispatch args — which I did not trace to
its caller — is not load-bearing for confidentiality: a wrong one yields a wrong TMK, a failed unwrap, a
null DEK, and no presigned URL at all.

THE TTLs ARE LEAST-PRIVILEGE AND THE REASONING IS WRITTEN DOWN. The save-back PUT is consumed at session
END so it must outlive the session (max duration + teardown margin, clamped to R2's 7-day SigV4
ceiling); the restore GET is consumed at session START, so it gets the shorter 1h restore window and is
never longer than the PUT. A leaked GET — ciphertext of the customer's sealed store — stays valid only
while a restore could plausibly be pending, not for a four-hour session. The GET is minted only when a
prior blob exists.

DEGRADATION IS FAIL-USEFUL RATHER THAN FAIL-OPEN. A corrupt or rotated-but-unrewrapped DEK does not
abort the dispatch — which would strand the session active-but-never-dispatched, holding a concurrency
slot until the 12h reaper while the GUI spins. It degrades to a stateless run: the session works, it
just cannot open or seal the encrypted store. Nothing is disclosed by the degrade.

BOUNDED: this traced the DEK path, the key derivation and the URL minting. It did NOT trace every caller
of the dispatch helper to confirm where `accountId` originates, and did not audit R2 bucket policy or
the presigner's own signature construction — a correctly-scoped URL against a misconfigured bucket is
not visible from anything read here.

## V-1736 — the reaper's safety hinge was asserted against literals retyped in its own test

2026-08-26. Audited `services/profile-blob-orphan-sweeper.ts` — 246 lines, one test file, live in
bootstrap, no prior art. It deletes `profiles/<uuid>.sealed` objects from R2 whose uuid has no profiles
row, as the GDPR-erasure backstop for a purge racing an in-flight save-back PUT. Irreversible deletion of
customer data is the highest-stakes shape left, and V-1735 had just read the other half of the same
asset.

⛔ THE HINGE IS STATED IN ITS OWN HEADER: the grace window "MUST exceed the max presigned save-back PUT
TTL so an in-flight save-back is never reaped mid-flight". Its justification was false in BOTH
directions. It said the grace is 2h — it is `DEFAULT_ORPHAN_GRACE_MS`, SIX hours. It said "the current
max minted TTL is DEFAULT_PROFILE_URL_TTL_SECONDS = 3600s (1h) — both dispatch call sites use the
default and nothing passes a larger urlTtlSeconds" — and `routes/agent-sessions.ts` DOES pass a larger
one, `MANUAL_SESSION_MAX_DURATION_SECONDS + 1800` = 16200s (4.5h), because that PUT is consumed at
session TEARDOWN and must outlive the session. V-1735 had read that exact line the firing before, which
is the only reason the claim looked wrong on sight.

⭐ THE TWO ERRORS CANCELLED, AND THAT IS WHY IT SURVIVED. 6h > 4.5h, so the invariant HOLDS and nothing
was ever at risk. A safety comment can be false in both directions and still read as reassuring; the
real margin is 1.5h rather than the 2h-against-1h the text implied, and the ratio is 1.33x rather than
2x.

⛔ THE DEFECT IS THE GUARD, and it is this log's own recurring shape. The arm that asserts the hinge read:

```ts
const MAX_SAVE_BACK_PUT_TTL_SECONDS = 14400 + 1800; // ← retyped, not read
expect(DEFAULT_ORPHAN_GRACE_MS).toBeGreaterThan(MAX_SAVE_BACK_PUT_TTL_SECONDS * 1000);
```

with its own comment instructing a HUMAN: "if the save-back TTL is ever raised, this bound must rise".
One side of the comparison was typed in, so raising `MANUAL_SESSION_MAX_DURATION_SECONDS` would move the
real TTL while the assertion went on checking the old number — the guard staying green while the hinge
it protects had opened, and the operation it gates is deletion.

PROVED IN BOTH DIRECTIONS, which is what makes it a defect rather than a preference. Raising the cap to
21600 (6h → 6.5h TTL, past the 6h grace) fails the repaired arm — and the SAME mutation against the
guard as it stood at HEAD passes 13 of 13. It was blind to exactly the edit it existed to catch.

Fixed at the source rather than in the test: `PROFILE_SAVE_BACK_PUT_TTL_SECONDS` is now one exported
constant, used at the mint site and imported by the arm, so both sides are read from the same value. The
header's false paragraph is replaced with what is actually true, including that it was wrong both ways.
Files restored byte-identically after every mutation, with the restore in a TRAP and the run narrowed to
one file — V-1733's protocol, applied this time.

BOUNDED: this audited the grace/TTL relation, the reap predicate (soft-delete-inclusive existence check,
so a trashed profile keeps its blob) and the failure handling (a listObjects denial or any throw is
caught, logged and re-armed with no deletes). It did NOT audit R2 bucket lifecycle rules, which could
delete objects on a schedule this code never sees.

## V-1737 — P-25's device plane: every deadlock shape swept in the harness, none reachable

2026-08-26. The owner granted `driftstack` / `webkit-driftstack` and ratified it in `CLAUDE.md`, so the
harness — the plane neither A2 nor I could see — is readable for the first time. P-25 is an
UNRECOVERABLE freeze needing a full restart, which fits a deadlock far better than a leak: a leak
degrades, a lock that never releases STOPS. Swept the shapes that stop a process.

```
  locks                 10 sites (6 NSLock, 4 DispatchSemaphore) — READ ALL TEN
  unbounded .wait()     ZERO in the runtime modules
  DispatchQueue.sync    ZERO in the runtime modules
  continuations         12 sites; 11 carry a timeout/deadline/cancellation backstop
```

⚠️ TWO CANDIDATES LOOKED LIKE THE ANSWER AND NEITHER SURVIVED READING, which is the whole method.

`IntentExecutor.swift:56` locks and unlocks WITHOUT `defer`, while three other sites in the same file
use `defer { lock.unlock() }`. An inconsistent lock release is the classic permanent wedge. Reading it:
the critical section is one assignment, `authorized = false` — it cannot throw, return early or suspend,
so there is no path that skips the unlock. Stylistic, not a defect.

`BrowserProcess.swift:1566` was the only continuation with a single `.resume(` against one creation,
which is the shape where an error path leaks the continuation forever. Reading it: the single resume is
reached by TWO paths — the paint marker and a deadline — behind an idempotent lock-guarded flag, with
the deadline guaranteeing resume even if the marker never arrives. My ratio measured occurrences of the
TEXT `.resume(`, not the number of paths reaching it.

⛔ THE ONE REAL GAP IS IN DEAD CODE. `NewTabServer.start()` awaits `NWListener`'s state and resumes on
`.ready`, `.failed` and `.cancelled` — but `NWListener` also has `.waiting(error)`, which falls to
`default: break` and resumes NOTHING, with no timeout anywhere. A listener can sit in `.waiting`
indefinitely; it does not auto-fail. Under heavy tab churn that is a permanent hang of an actor, which is
the P-25 symptom exactly.

It cannot be P-25. `NewTabServer` has ONE reference outside its own file — a single test — and NO
production caller. The live new-tab path is a fork-side network-loader intercept
(`DriftstackNetworkLoader` W3093), and the start page moved to the marketing site in P-27. Green here
reads "uncalled", not "unguarded" — the same distinction V-1717 turned on. Recorded so that wiring
`NewTabServer` up later carries the warning attached to the thing it would break.

BOUNDED, and the boundary is the whole point: this is STATIC and covers the shapes that HALT a process —
locks, unbounded waits, sync-on-self, leaked continuations. It says nothing about actor reentrancy, an
await on a remote peer that never answers, unbounded task queues, memory growth, or anything that needs
the sustained multi-site traffic the report describes. **Neither A2 nor I have run load, and every
elimination any of us has published is subject to that.** Three planes are now swept statically and P-25
remains undiagnosed on all three, which is itself the finding: the bug is not in the shapes a static
read can reach.

## V-1738 — swept V-1736's shape repo-wide: four hits, four non-defects, and the distinction that separates them

2026-08-26. V-1736 found a safety hinge asserted against a literal retyped in its own test. That shape
is measurable, so it was swept: a local numeric const in a test, used in an assertion, whose value
duplicates a constant declared in source.

⛔ THE DETECTOR NEEDED THREE PASSES AND TWO OF ITS CONTROLS FAILED FIRST, which is the usual story. Pass
one flagged `HOUR_MS = 60 * 60 * 1000` alongside the true positive — a unit conversion is not a
duplicated domain value. Pass two required the literal to match a source constant and STILL flagged
`HOUR_MS`, because `1000` matches something. Pass three requires a DISTINCTIVE component — at least 1000
and not a bare power of ten — after which the positive control (V-1736 pre-fix) flags exactly one
constant and the negative control (post-fix) is silent.

FOUR HITS, ALL FOUR CORRECT AS WRITTEN, and the reading is the point:

```
  recipe-payload-encryption  64 MiB literal builds an OVERSIZED payload to prove refusal. Test DATA,
                             not a comparison — and if the real bound rose past it the test fails
                             loudly rather than passing silently. Safe direction.
  profile-policy /           cross-source parity pins. Freezing the policy value IS their job; deriving
  avatar-policy              it from the file they check would make them assert nothing.
  scroll-velocity            pins MAX_DURATION_MS / MIN_TICK_INTERVAL_MS <= 10_000 with one side typed
                             in — but scroll.ts carries a MODULE-LEVEL self-check that THROWS AT IMPORT
                             if that ratio breaks. The test documents an invariant the source enforces.
```

⭐ SO THE REFINED RULE IS NARROWER THAN V-1736 IMPLIED. A retyped literal is a defect only when NOTHING
ELSE enforces the relation. Where the pin's purpose is to freeze a value, or where the source
self-checks, typing it in is correct — and deriving it would be worse, because a parity pin that reads
its expected value out of the file it is checking asserts nothing at all. V-1736 was a defect precisely
because the grace/TTL relation was enforced NOWHERE but that one arm.

⚠️ WORTH RECORDING AND NOT ACTING ON: `scroll.ts`'s module-level self-check is a STRONGER enforcement
point than any test — it fails at import, whether or not anyone runs the suite. The reaper's grace/TTL
hinge could take the same form. I am not adding it: the reaper is wired into bootstrap, so a throw there
turns a violated invariant into a server that will not start. That is arguably the correct trade for a
path that otherwise deletes customer data silently, but it is a deployment-risk decision rather than a
test-quality one, and V-1736's repair — the arm now derives both sides — already fails the suite on the
same edit.

BOUNDED: the detector matches a local `const NAME = <numeric literal>` used in an assertion. A literal
inlined directly into an `expect(...)`, or one spelled as a string, is invisible to it — so this is a
clean zero over one spelling of the shape, not over the shape.

## V-1739 — the wire protocol has two hand-written implementations in two repos; nothing had ever compared them

2026-08-26. The harness speaks a control protocol defined twice — Zod schemas in
`apps/server/src/schemas/harness-control-protocol.ts`, and a hand-written Swift enum in
`harness/Sources/ControlClient/ControlClient.swift` whose decoder THROWS on an unrecognised type. Two
hand-maintained copies of one contract across two repos is the shape that produced V-1716, V-1718 and
V-1727, and **nothing in either repo's ledger had compared them** — because until today no agent could
read both. Now measured.

⛔ THE FIRST ANSWER WAS WRONG AND THE ERROR IS THE USEFUL PART. Diffing the Swift enum against the CP's
Zod schema reported SIX kinds the control plane did not declare, including `activateTab`,
`activateTabResult` and `tabListUpdate` — tab operations, with P-26 open on tab-switching latency. That
looked like a control plane that had lost the ability to drive tabs.

It is not. Those frames are **GUI → box over the LiveKit data channel**, a different transport, declared
in `packages/api-types/src/agent-tab-ops.ts`. The Swift enum carries messages from BOTH transports; I
compared it against ONE schema and assumed a single union meant a single channel. `apps/server/src`
holds zero occurrences of them because the control plane is deliberately not in that path.

RE-MEASURED AGAINST THE UNION OF BOTH CONTRACTS, four exceptions remain and each is explained:

```
  validateProxyConfig      Swift implements it; ZERO occurrences in the whole API repo — apps AND
  proxyValidationResult    packages. Its own comment calls it "the GUI's VPN-config Test", but the
                           GUI's live Test goes through the SERVER (lib/proxies testProxy → the probe
                           → ProxyValidationFailedError). Device-side handler, superseded, DORMANT —
                           the same shape as NewTabServer in V-1737.
  setEgress                CP declares them, Swift does not handle them. Known and recorded when I
  setEgressResult          built that half (P-17): the CP side was written against a stub driver and
                           its header says the round trip could not be verified end to end.
```

So the two implementations AGREE on every message either side actually uses. That is worth having as a
measurement rather than an assumption, and it is the first time it has been one.

⭐ The transferable half: **a protocol union in one language can span transports that are separate
documents in the other.** A parity check across implementations has to enumerate the CONTRACTS the union
covers before diffing, or it reports the second transport as missing — which is exactly the alarming,
wrong answer this produced first, on the surface where an open performance ticket made it look credible.

BOUNDED: this compares message KIND names, not field shapes. Two implementations can agree on every
`type` string and still disagree on a field's presence, type or encoding — `snake_case` on the Swift
side against camelCase in Zod is exactly where that would hide. Field-level parity is a larger
measurement and is NOT claimed here.

## V-1740 — field-level parity on the busiest frame, and the near-miss was a field name borrowed from the wrong contract

2026-08-26. V-1739 compared message KIND names across the two implementations and stated its boundary
plainly: two sides can agree on every `type` string and still disagree on a field's presence or
encoding, "snake_case on the Swift side against camelCase in Zod is exactly where that would hide".
Took one bounded step into that boundary — `sessionAssign`, the frame every session starts with.

THE CASING IS MIXED ON PURPOSE AND BOTH SIDES IMPLEMENT THE SAME MIX. Top-level fields are camelCase on
the wire (`sessionId`, `archetype`, `behaviorProfile`, `transportMode`, `idleTimeoutSeconds`,
`initialUrl`) and Swift decodes them with default coding, property name as key. Every snake_case field
is one where Swift declares an EXPLICIT `CodingKeys` mapping — `quic_ok`, `probed_at`, `profile_id`,
`sealed_blob`, `sealed_blob_url`, `sealed_blob_put_url`, `ws_url`, `expires_at` — and the CP's Zod
declares those same snake_case names. Checked in both directions; they agree.

⚠️ AND I NEARLY FILED A DEFECT ON IT. `initialUrl` has no `CodingKeys` entry, so Swift decodes it from
the literal key `"initialUrl"`. V-1539 records the field as `initial_url`, which would mean the CP sends
a key the harness never reads — every session silently starting blank, a user-visible failure with no
error. The reasoning was sound and the premise was borrowed from the wrong document: `initial_url` is
the CUSTOMER-facing request field on `POST /v1/agent-sessions`, which the control plane TRANSLATES. The
harness frame declares `initialUrl` at `harness-control-protocol.ts:857` and the codec emits
`initialUrl`. Both sides camelCase, no gap.

⭐ The transferable half, and it is a sibling of V-1739's: **one concept can have two spellings in two
contracts of the same system, and a parity check must take each field name from the contract it is
actually checking.** V-1739's error was importing a TRANSPORT's messages into the wrong comparison;
this one was importing a FIELD's name from the wrong layer. Same class, one level down — and both
produced a confident, alarming, wrong answer that reading refuted in one command.

BOUNDED: one frame of the thirty-one, chosen because it is the one every session begins with. The
remaining thirty are unchecked at field level, and nothing here licenses a claim about them.

## V-1741 — the per-session geolocation override is accepted, validated, documented, transmitted, and never read

2026-08-26. Extending V-1740's field-level parity from one frame to a generated comparison across all
thirty-one found a real one, on a contract carrying my own approval.

`POST /v1/agent-sessions` accepts a `geolocation` override — `{ latitude, longitude, accuracy? }`,
bounds-validated at the route (`routes/agent-sessions.ts:272`), **published in the OpenAPI document**,
re-validated on the wire by the Zod harness schema, and serialized onto the sessionAssign frame by
`harness-control-codec.ts:247-251`. Its documentation is explicit about what it promises: "present ⇒ the
fork's location provider serves exactly these coordinates."

⛔ THE HARNESS NEVER READS IT. `ControlClient.swift` decodes no coordinate field at all — a grep for
`latitude|longitude|geoloc|"lat"` across it returns nothing, and `SessionAssign` declares no such
property. `HarnessCoordinator.swift:6452` sets `var geoLoc: String? = nil` and fills it from
`probeResult` — the EGRESS PROBE — with the comment stating the only behaviour that exists:
"navigator.geolocation follows the proxy exit". `BrowserProcess` then writes `DRIFTSTACK_GEO_LAT/LON`
from that derived value. The customer's coordinates reach the device and are dropped.

⚠️ AND NOTHING FAILS. Swift's `Codable` throws on an unknown message TYPE — the decoder has an explicit
`default:` that does — but ignores unknown FIELDS by construction. So the frame decodes cleanly, the
override evaporates, and no error is raised on either side. A customer who pins coordinates gets the
proxy-exit auto-derive and is told nothing.

⭐ THE CONTRAST THAT MAKES THIS A DEFECT RATHER THAN STAGING. `setEgress`/`setEgressResult` are also
CP-only with no Swift handler — and that is FINE, because when I built that half I wrote in its header
that it was against a stub driver and could not be verified end to end. There is no such note anywhere
for `geolocation`. The difference between an unimplemented half and a documented one is whether anybody
wrote it down; this one was published to customers instead.

It is my own contract — "A3-approved contract 2026-07-01" is in the route comment — which is the
uncomfortable part. I approved the shape, the control-plane half shipped, the device half never did, and
nothing tracked the gap for eight weeks.

NOT A SECURITY DEFECT, and for an anti-detect product that is not the whole story: a customer setting
coordinates to cohere with some other signal they control gets silent incoherence with the proxy exit
instead, which is the opposite of what the feature is for.

BOUNDED, and this is a static trace rather than a run: I followed the field from the route through the
codec to the wire schema, then through `ControlClient` (no decode), `HarnessCoordinator` (geoLoc from
`probeResult` only) and `BrowserProcess` (env from the derived value). I did NOT build or run the
harness, and did NOT read `webkit-driftstack` — the fork consumes the env vars, which are set from the
auto-derive, so a fork-side reader could not change the conclusion without a Swift writer feeding it.

## V-1742 — the worker sends its latest fault on every heartbeat and the control plane was binning it

2026-08-26. Ran the field-level parity comparison across all 31 frames rather than the one V-1740
checked. ⛔ THE TABLE IS NOISE AND I AM NOT REPORTING IT AS A RESULT: the Zod extractor uses a character
window, so it spills into neighbouring schemas — `intentDispatch` shows sessionAssign's LiveKit fields,
`errorEvent` shows capabilityReport's twenty. Nearly every "zod-only" entry is spill, and a trustworthy
version needs brace-matched block parsing. (V-1741 is unaffected: geolocation was confirmed by reading
the route, the codec, the schema and three Swift files, never from this table.)

One row survived scrutiny because it pointed somewhere I could check by hand. The harness heartbeats
`lastErrorSummary` and `lastErrorAtMs` — `ControlClient.swift:438-442`, with the purpose written out:
"so an operator sees a worker's latest fault WITHOUT log-scraping". Both spellings, camelCase and
snake_case, appear **ZERO times across `apps/` and `packages/`**. Five sibling health fields
(`thermalState`, `memoryPressureLevel`, `diskFreePercent`, `busiestCorePercent`, `harnessVersion`) are
declared AND consumed; these two are the only ones that are not.

⚠️ AND NOTHING FAILS, WHICH IS WHY IT LASTED. The heartbeat schema is a plain `z.object({…})` with no
`.strict()`, and Zod's default STRIPS unknown keys. So the beat parses cleanly, the fault evaporates, and
neither side raises anything. I checked the strictness specifically because the alternative was worse: a
strict schema would have REJECTED the whole heartbeat exactly when a worker had faulted, losing contact
at the worst moment. It does not; the loss is silent rather than catastrophic.

⭐ THIS IS THE SIGNAL P-25 IS MISSING. The owner's freeze produces "no error message", and the device has
been reporting its most recent fault on every beat for the whole time — into a receiver that discards it.
Nothing else parses this schema in any test, so a stripped field had no way to be noticed.

Declared, bounded (512 chars, untrusted text from a node, and the logger redacts), and LOGGED at warn
when present — which is rare by construction, since it is populated only after an actual fault. ⛔ NOT
persisted: a column needs a migration, and a production schema change is the owner's call rather than
mine. Logging alone means the next unexplained fault leaves a trace, which is the entire point of the
field.

Proved by mutation on the real subject: with the two declarations removed the new arm fails with
"expected undefined to be 'WebProcess terminated unexpectedly'" — the pre-fix behaviour, demonstrated
rather than asserted. Restored byte-identically under a trap, narrowest test set, per V-1733. `it(` 3 to
4; tsc clean; bootstrap and schema content-parity pins both still green (40 and 75).

BOUNDED: this makes the fault VISIBLE in logs, not queryable. Correlating a freeze to a worker fault
still means reading server logs by hand, and the durable version — a column plus an admin surface — is
the migration I am not taking unilaterally.

## V-1743 — the parity tool rebuilt until its controls passed: one real gap across 29 frames, already filed

2026-08-26. V-1742 reported its own table as noise and said a trustworthy version needed brace-matched
parsing. Rebuilt it: balanced-brace block extraction on both sides, depth-1 keys only so nested objects
cannot leak up, and nested Swift struct bodies stripped before reading properties. Held to FOUR controls
— one positive (the known-open `geolocation` gap must appear) and three negatives (a correctly-mapped
`exitIdentity` must not, the now-fixed `lastErrorSummary` must not, and `intentDispatch` must be free of
`sessionAssign` spill).

⛔ IT FAILED THEM FOUR TIMES, AND THE FAILURES ARE THE ENTRY. Counting parens as depth meant a multi-line
Zod chain pushed depth above 1 and every later field was skipped. Then the positive control still failed:
`ts_fields('sessionAssign')` was returning **intentDispatch's** fields, because `rfind('z.object(')`
walked back past the real schema — `SessionAssignSchema = z\n  .object({` puts `z` and `.object(` on
SEPARATE LINES. ⚠️ That multi-line style has now broken THREE separate extractors tonight: a `z\.`
field regex, a named-schema field regex, and this block anchor. **It is the house idiom, and every
schema-parsing instrument written against this file must assume it.**

WITH ALL FOUR CONTROLS PASSING, 29 frames compare and six differ. Every one resolves:

```
  sessionAssign   cp-only geolocation      REAL — V-1741, filed to A1, awaiting a decision
  pageState       5 harness-only fields    TRANSPORT SPLIT, not a gap
  heartbeat       sequence, webkitForkBuild present in the repo
  intentResult    7 harness-only fields    present in the repo (different declaration shape)
  navigateHistory tabId                    present in the repo
  sessionEnd      reason                   present in the repo
```

⚠️ THE pageState ONE IS THE SAME MISTAKE FOR THE THIRD TIME AND THAT IS THE FINDING ABOUT ME. The harness
sends `progress`, `inputFocused`, `logicalContentWidth/Height` and `tabIncarnation`; the CP schema keeps
`sessionId` and a four-state enum. With `app.ts` calling its consumer the "GUI loading-bar/overlay", a
loading BAR that never receives progress reads exactly like a defect. It is not: `SimulatorWindow.tsx`
takes those fields DIRECTLY from the harness over LiveKit, and `agent-session-control.ts:400` documents
the control-plane path as the minimal one for the live URL. **One Swift struct serves two transports**,
so a diff against either schema alone reports the other's fields as missing — V-1739's error, then
V-1740's one level down, and now this.

So: the two hand-written implementations AGREE across every frame, with the single filed exception. That
is the measurement V-1739 set out to make and could not trust until now.

BOUNDED: kind names and depth-1 field names. It does not compare TYPES — a field declared `z.string()`
against a Swift `Int` agrees here and fails at runtime — nor optionality, nor enum members. Those are a
larger measurement and are not claimed.

## V-1744 — optionality parity: zero dangerous mismatches, and severity turns on which side DECODES

2026-08-26. V-1743 bounded itself at field NAMES and named the gap: "a field declared `z.string()`
against a Swift `Int` agrees here and fails at runtime — nor optionality". Took the optionality half,
because it has a hard failure mode: **Swift's `Codable` THROWS on a missing non-optional field**, and
`ControlInbound`'s decoder already throws on an unknown type, so a CP-optional / Swift-required pair
means the whole frame is REJECTED whenever the control plane omits that field.

FIRST PASS: 12 mismatches, ALL POINTING THE SAME WAY. ⛔ That uniformity is this log's own tell for a
broken instrument, and it was: my Swift type capture ran to end-of-line, so `public let
inlineProxyConfig: Data?   // H3.exec.107…` did not end with `?` and every COMMENTED optional read as
required. I could falsify it immediately — V-1740 records me reading that exact line as `Data?`.
Stripping the trailing comment first took 12 to 4, and a third control now pins that shape.

SECOND PASS: 4 mismatches, and ALL FOUR ARE BENIGN FOR A REASON THE TOOL COULD NOT SEE. ⭐ **An
optionality mismatch's severity depends on which side DECODES.** `capabilityReport`, `challengeDetected`
and `downloadData` sit in `public enum HarnessOutbound` — the harness ENCODES them. A required Swift
field there means the box ALWAYS SENDS one, and the CP's `.optional()` is lenient acceptance: the safe
configuration, not a fault. Only a frame the harness DECODES — `ControlInbound`, which `sessionAssign`
belongs to and these three do not — can be rejected for a missing field. Verified by reading the
enclosing enum rather than trusting my own scan.

So: **zero dangerous optionality mismatches on the decode direction.** The protocol agrees on names
(V-1743) and on optionality where it can hurt.

⚠️ SIX INSTRUMENT CORRECTIONS ACROSS THIS AND V-1743, and the last is the one worth carrying: paren-depth
counting, `z.object(` adjacency against the multi-line house style, a case-sensitive danger counter that
reported "DANGEROUS: 0" while printing a dangerous row, end-of-line type capture, window spill — and
then **direction-blindness**. The first five made the tool wrong; the sixth made it right about the data
and wrong about the meaning, which is harder to notice because every row was factually accurate.

⭐ A synthetic positive was used where no real one existed: making `sessionAssign.sessionId` CP-optional
produced the expected "CP optional -> Swift REQUIRED" row, proving the detector can see the shape before
its zero was trusted. Restored byte-identically under a trap.

BOUNDED: optionality only. TYPES are still uncompared — a `z.string()` against a Swift `Int` agrees on
name and optionality and fails at decode — as are enum MEMBERS, where Swift's decoder throws on an
unknown case. Both are reachable with the same tool and are not claimed here.

## V-1745 — the parity tool STRIPPED nested payloads, so two prior "parity" claims covered top-level fields only

2026-08-26. Extending V-1744 into TYPES surfaced something worse than a type mismatch: my own parser
carries `flat=re.sub(r'public struct \w+[^{]*\{…\}','',blk)`, which deletes NESTED structs before the
comparison runs. I wrote that line to stop the field walk leaking into a sibling type; what it also did
was remove eleven payloads from the scope of BOTH V-1743 (names) and V-1744 (optionality). `LiveKitInfo`
was compared as "is this field optional" and never for its CONTENTS. ⛔ A tool's own preprocessing
narrows every claim built on it, and neither prior entry stated this boundary because I did not know it
was there.

Four of the eleven ride INBOUND, where the harness DECODES and a missing required field throws out the
whole frame. Compared all four by hand:

- `LiveKitInfo` — 4/4. CP `room/token/ws_url/expires_at` all required strings; Swift `String×3 + Date`.
- `ProfileInfo` — 5/5, required/optional aligned exactly (`profile_id`+`dek` required, three blob fields optional).
- `ExitIdentityInfo` — Swift is ALL-optional against a CP that sends every field. Maximally lenient;
  cannot reject. The Swift comment says so deliberately: "always sent by A2, but lenient here".
- `TabDescriptor` — no CP counterpart, and that is correct: `tabListUpdate` rides the LIVEKIT DATA
  CHANNEL, not the CP socket. ⚠️ Fourth time this session that split has misled a comparison. Counterpart
  found at `apps/gui-client/src/lib/livekit.ts:63` — `{id, url, scrollY: number, title}`, exact 4-field
  match, and `scrollY`'s camelCase is the LiveKit convention rather than a snake_case violation.

⛔⛔ A HIGH-CONFIDENCE DEFECT WAS FALSIFIED BY RUNNING IT. `expires_at` is minted at
`routes/agent-sessions.ts:1200` as `new Date(...).toISOString()`, which ALWAYS emits milliseconds, and
Swift decodes it into a `Date` under `.iso8601` (ControlClient.swift:1675). Foundation's
`.iso8601` is documented and widely reported to use `[.withInternetDateTime]`, which EXCLUDES fractional
seconds — so the derivation said every GUI-streaming `sessionAssign` is rejected outright. I compiled the
real struct with the real strategy and fed it the real string:

    OK  JS toISOString (millis): 2026-08-26T12:34:56.789Z
    OK  no fractional seconds  : 2026-08-26T12:34:56Z

BOTH PARSE on this toolchain. The famous gotcha does not hold here, and reporting it would have been a
fabricated production-critical defect resting on a correct-sounding derivation about someone else's
library. ⭐ A post-condition beat a derivation again — and note the near-miss compounding it:
`ExitIdentityInfo.probedAt` is annotated "kept as String — no Date-strategy throw risk", so the fix I was
about to propose would have been pattern-matched onto a decision already taken deliberately.

BOUNDED: the seven OUTBOUND nested payloads (Cookie, UploadedFile, DownloadEntry, SafeguardCheckEntry,
ChallengeInfo, PageStateError, Tab) are NOT compared here. ⚠️ They are not the benign direction they were
for optionality: the CP parses inbound frames with `.strict()`, so a Swift field the CP schema fails to
declare makes the CP reject the whole frame. That is a NAME question in the outbound direction and is the
next measurement, not a claim made now.

## V-1746 — pageState `http_status`: two repos, each correct and documented, mutually incompatible the day the fork lands

2026-08-26. Took the boundary V-1745 left — the seven OUTBOUND nested payloads, where the CP is the
VALIDATOR and an undeclared or mistyped field makes it drop the frame. Six are sound:

- `Cookie` 8/8, and the closed CP enum `sameSite: z.enum(['Strict','Lax','None'])` against Swift's open
  `String?` is guarded at the source: `HarnessCoordinator.normalizeSameSite` returns **nil** for anything
  unrecognized, and the CP field is `.nullable().optional()`. A deliberate fail-safe, not a lucky match.
- `SafeguardCheckEntry` 4/4 — including `timestamp: Date` encoded ISO-8601 into a CP `z.string()`.
- `ChallengeInfo` 3/3; its required-`detail`-vs-CP-optional is the benign encode direction V-1744 classified.
- `ProfileInfo`, `LiveKitInfo`, `ExitIdentityInfo` per V-1745. `TabDescriptor` rides LiveKit.

⛔ THE SEVENTH IS A LATENT SILENT-DROP. `PageStateFrameSchema` declares
`http_status: z.null().optional()` — null or absent, nothing else. `HarnessCoordinator.swift:5075`:

    if let status = event.httpStatus, status >= 400 {
        ... error: .init(kind: "http", httpStatus: status, ...)

an Int, and `BrowserProcess.swift:452` already parses `httpStatus` off the fork's nav-state event. Proved
the consequence against the real schema rather than deriving it:

    ACCEPTED  kind=net,  http_status: null   (documented shape)
    REJECTED  kind=http, http_status: 404    -> error.http_status: Expected null, received number
    REJECTED  kind=http, http_status: 503    -> error.http_status: Expected null, received number

and the rejection is silent — `fleet-control-registry.ts:533` is `if (!parsed.success) return;`, no log, no
metric. The frames that would vanish are precisely the ones reporting a FAILED page load, so the GUI's
error overlay would go dark exactly when it is meant to fire.

⭐ NOT A BUG IN EITHER REPO, WHICH IS WHY IT SURVIVED. The CP's `z.null()` is deliberate, commented
(W1222 — a real status "needs an A1 nav-error channel"), text-pinned at content-parity:560, and defended
by an arm at :619 that ASSERTS a numeric status is rejected. The harness branch is equally deliberate and
annotated "ADDITIVE: the deployed fork does NOT yet emit httpStatus → it stays nil". Each side documents a
consistent story; they disagree only about a future that has not happened yet.

⛔ NOT FIXED UNILATERALLY, deliberately. The CP arm does not pin stale text — it asserts a chosen
BEHAVIOUR, and W1222 marks the whole channel an open design item owned by A1's fork work. Flipping a
peer's intentional behavioural assertion is not the same as correcting a drifted pin, and this is the
exact shape of "pattern-matching a fix onto a documented decision". No live impact today: the branch is
unreachable until the fork emits.

⭐ RECOMMENDED, so whoever decides can act in one step: widen to
`http_status: z.number().int().min(100).max(599).nullable().optional()` — strictly backward compatible
(null and absent still parse) — and in the SAME commit flip content-parity:560's `toContain` fragment and
the :619 arm from `.toBe(false)` to `.toBe(true)`. Ordering matters: the CP must widen BEFORE the fork
starts emitting, or the gap is silent HTTP-error loss for the length of the deploy skew.

BOUNDED: this covers the nested payloads' names and types. Field-level VALUE constraints (`.max()`
lengths, `.min(1)`) are not compared against what the harness can actually produce — a Swift string longer
than a CP `.max()` is the same silent drop, and that measurement has not been run.

## V-1747 — pageState `url`/`title` are emitted untruncated into a bounded schema, and the obvious fix is wrong

2026-08-26. Took V-1746's stated boundary — VALUE constraints, never compared against what the harness
can actually produce. Unlike V-1746 this one is not latent.

The CP bounds `url` at `PAGE_STATE_URL_MAX_LENGTH` (8192) and `title` at `PAGE_STATE_TEXT_MAX_LENGTH`
(4096), and that bounding is DELIBERATE — content-parity:658 feeds over-cap values for
sessionId/url/title/tabId/error and asserts `.toBe(false)` for each. Bounding untrusted input is correct,
so the CP is not the defect.

The harness emit path applies NO length cap. `HarnessCoordinator.swift:5058` is
`event.url.map { IntentExecutor.redactCredentialURL($0) }` — credential-redacted, never truncated — and
`title: event.title` passes verbatim. Proved the consequence against the real schema:

    ACCEPTED  ordinary https URL (60 chars)
    REJECTED  data: URL, 9000 chars  (cap 8192)
    REJECTED  title 5000 chars       (cap 4096)

and the drop is the same silent one as V-1746 — `fleet-control-registry.ts:533`, no log, no metric. The
GUI's page-state store simply stops updating and the address bar freezes on the previous URL.

⭐ REACHABLE TODAY, unlike V-1746. A `data:` URL carrying any inline image clears 8192 trivially, and
enterprise **SAML SSO** redirects routinely carry a >8KB `SAMLResponse` in the URL — so page-state goes
silent during exactly the login step a customer is most likely to be watching. The codebase already knows
what this failure looks like: the schema's own comment records required-url/error/http_status having
"failed safeParse on EVERY real frame → silently dropped → the page-state store stayed empty → no live
URL in the GUI".

⛔⛔ THE OBVIOUS FIX IS WRONG, AND THAT IS THE FINDING'S REAL CONTENT. The harness already has
`HarnessCoordinator.truncate` plus `maxTabFieldChars = 8 * 1024` — exactly the CP's URL cap — and already
applies it to tab snapshots at :2562. Reusing it here looks like a one-line change. But `truncate` is
`s.count <= max ? s : String(s.prefix(max))`, which counts **grapheme clusters**, while Zod's `.max()`
counts **UTF-16 code units**. Measured, not reasoned:

    truncate(<6000 ZWJ family emoji>, 4096) -> Swift Characters 4096 / UTF-16 units 45056 -> STILL REJECTED

Off by 11x, and page titles are exactly where non-BMP content lives. A correct fix needs a surrogate-safe
UTF-16 slice — the same shape as V-1718's surrogate-safe slice on the CP side earlier this session — not
the existing helper.

⛔ NOT IMPLEMENTED THIS TURN, and the reason is not the code. The harness tree was clean and quiescent
when measured (no `.swift` write in 30 min; A1's last bus post 40 min earlier), so the edit was safe to
make — but the correct version needs a new UTF-16-safe helper plus its own unit tests plus a Swift build
in a repo A1 works continuously, and "no concurrent fork source writers" is a standing rule. Filed as
P-30 with the trap recorded so it cannot be closed with the one-liner.

BOUNDED: measured `pageState.url`/`title` only. The other capped free-text fields on harness→CP frames
(`cookie.value` 4096 / `cookie.name` 512, `errorEvent.summary`/`detail`, `challenge.detail` 4096) share
the shape — the harness caps the cookie jar's TOTAL serialized size at 8 MiB but applies NO per-field cap
(`value: c.value` verbatim at :1432) — and their reachability is NOT measured here, because it turns on
WebKit's own per-cookie limit, which I have not tested.

## V-1748 — enum parity closes clean, and a 5-vs-4 state mismatch that looks like a defect is correct BY TRANSPORT

2026-08-26. Closed the last boundary V-1744 named: enum MEMBERS. Swift's `Codable` throws on an unknown
raw value, so a case one side can produce and the other cannot name is the same silent frame loss as
V-1746/V-1747. Both directions measured; both sound.

⭐ ONLY ONE raw-value enum is wire-decoded — `ProfileSaveFailed.Reason` (ControlClient.swift:859).
Boundary stated: grepped `enum … : String … Codable` across ALL of `Sources/`, not just ControlClient,
which finds six such enums; the other five (`ChallengeType`, `StreamingCodec`, `SameSite`, `ProxyKind`,
`IPType`) are internal and never typed onto a wire struct's field. The detector found a known positive
before its zero was trusted.

`Reason` is 6/6 with the CP, in the same order, plus `.catch('upload_failed')` so an unrecognised FUTURE
reason cannot reject the frame. ⭐ Worth noting because the Swift doc comment above it still says `reason`
"MUST be one of the **4** the CP enum accepts … a 5th leg needs A2's enum widened in lockstep FIRST" —
written when there were four. Two were added since (`degenerate_dump` W2977, `superseded` W2991) and BOTH
were widened in lockstep as instructed. The comment is stale; the code is right, which is the good
direction for that pair to disagree in.

⛔ THE INTERESTING PART. `pageState.state` looks like a live defect and is not. The harness emits FIVE
states — `loading`, `loaded`, `errored`, `stalled`, `ended` — and the CP declares FOUR:
`z.enum(['loading','loaded','errored','stalled'])`. `ended` comes from
`terminalPageStateForEndReason`, whose own doc says an UNKNOWN reason is treated as NORMAL `ended`,
"fail-SAFE" — so it is the DEFAULT terminal, not an edge case. A 5-vs-4 mismatch on a
default-path value is exactly the shape of the last two findings.

It is sound, and only tracing the SEND shows why. `pageState` rides BOTH transports:

- `emitNavStall` does `pageStateBuffer.append(ps)` AND `publishPageStateToRoom(ps)` → `stalled` reaches
  the CP, which is why the CP enum lists it.
- `terminalPageStateForEndReason` has exactly ONE caller (:7555) and it is `publishPageStateToRoom` with
  NO buffer append → `ended` reaches the LiveKit room only and never enters `drainPendingPageStates()`,
  the sole CP-bound path (`main.swift:2331`).

So the CP's four members are exactly the four that can reach it. The harness doc even records that the
GUI's `isHarnessState` guard is `loading|loaded|errored|stalled` and therefore ignores `ended` — handled
by deliberate non-handling.

⭐⭐ THE REUSABLE RULE, and the fifth time this split has misled a comparison today: when one type serves
two transports, an enum's valid member set is PER-TRANSPORT. Reading the type tells you what can be
constructed; only the SEND tells you what can arrive. A member-set diff against a shared type is not a
defect report until every producer's send path is traced.

⭐ Incidentally CONFIRMS V-1746/V-1747's premise rather than assuming it: the CP genuinely does receive
`pageState`, via `connection.send(.pageState(ps))` at `main.swift:2331`. Had it been room-only, both
findings' impact claims would have been wrong.

## V-1749 — the capped free-text fields: `challenge` closes sound, and the hypothesis that killed it was mine

2026-08-26. Continued V-1747's boundary — the OTHER capped free-text fields on harness→CP frames, where
an over-cap value is the same silent `safeParse` drop. Took `challengeDetected` first because it has the
worst blast radius: a dropped frame means the customer never receives the `session.challenge_detected`
webhook, and challenge handoff is a headline feature.

It is SOUND, and the reasoning that nearly made it a finding is worth recording. `ChallengeDetector`
builds most details as fixed closed labels ("reCAPTCHA iframe"), but EIGHT sites interpolate a matched
string:

    detail: "Cloudflare interstitial text: \"\(m)\""

which reads exactly like page-controlled text landing in a 4096-capped field — attacker-influenced, and
therefore unbounded. ⛔ It is not. Every one of the eight binds `m` as
`<literalArray>.first(where: { text.contains($0) })` — **`m` is the NEEDLE, not the HAYSTACK**. The
interpolation ships the hardcoded marker that matched, never the page. Longest literal in the file is 49
chars ("needs to review the security of your connection"), so the longest reachable `detail` is under ~100
against a cap of 4096: ~40x headroom. `type` is a `ChallengeType` raw value against a 256 cap.

⭐ Both ChallengeInfo producers converge on that one bounded set, which is not obvious from either.
`parseDetectedChallenge` (HarnessCoordinator:5238) reads `detail` straight out of a JSON blob with no cap
— `(obj["detail"] as? String) ?? ""` — which looks like a second, unguarded source. Traced it: the
`detect_challenge` intent is implemented in the HARNESS (`IntentExecutor.swift:3541`), not the fork, and
its body is `scanForChallenge()` → the same `ChallengeDetector`. So that path round-trips the harness's
own bounded output through JSON rather than admitting anything new. A cap-free read is benign or a
bypass depending ENTIRELY on who wrote the value, and only tracing the producer separates them.

⚠️ NOT CLOSED, stated because it bounds this entry: `cookie.value` (4096) / `cookie.name` (512) —
the harness caps the jar's TOTAL serialized size at 8 MiB and applies NO per-field cap
(`value: c.value` verbatim, HarnessCoordinator:1432), so the CP caps are load-bearing and unenforced
upstream; whether they are REACHABLE turns on WebKit's own per-cookie limit, which I have not tested and
am not claiming either way. And `errorEvent.summary` (4096) is `redactIPsForTelemetry(status.detail)` —
the surrounding code matches closed-vocab reason codes so it is short in every branch I read, but I did
not trace `status.detail` to every producer, so that is measured only as far as this sentence says.

## V-1750 — the size-cap axis closes: `capabilityReport` sound, and the real finding is that "bound before emit" is applied UNEVENLY

2026-08-26. Closed the remaining size-capped fields from V-1747/V-1749's boundary.

⭐ `capabilityReport` is SOUND with ~64x headroom. The CP enforces a 64 KiB SERIALIZED-frame ceiling
(harness-control-protocol.ts:1254), which is a different kind of bound from the per-field `.max()`s and
worth checking separately because the two can disagree: `safeguardChecks` permits `.max(16)` entries each
with `detail: z.string().max(4096)`, and **16 x 4096 = 65,536 = exactly the frame cap**, before keys, JSON
overhead, or the other fifteen fields. So a frame satisfying every per-field cap can still fail the frame
cap. That is NOT a defect — the aggregate ceiling is a correct backstop and binding first is the safe
order — and it is unreachable anyway: `buildCapabilityReport` emits exactly THREE safeguard entries, two
fixed literals (~75 chars) and `perSpawnSafeguard`, which deliberately reports "the VERDICT + duration,
NOT the raw IPs" (W1012). Every other field is a scalar. Real frames land near ~1 KB. ⚠️ Recorded because
the arithmetic becomes live the day safeguardChecks turns dynamic (a per-layer check list); the producer
is what makes it safe today, not the schema.

⛔⛔ THE ACTUAL FINDING IS THE PATTERN, not another instance. Six sites interpolate a RAW Swift error into
a `SessionStatus` detail that the CP caps at 4096 — `"spawn failed: \(error)"`, `"proxy_boot_failed:
\(error)"`, `"webdriver_connect_failed: \(error)"`, `"network_shim_boot_failed: \(error)"`, `"reserve
failed: \(error)"`, `"validate failed: \(error)"` (HarnessCoordinator 6093/6180/6294/6324/6822/6893). A
Swift `Error` interpolation is unbounded in principle — a `DecodingError` carries its full coding path, an
`NSError` its `userInfo`. Both consumers of that string cap at 4096 (`SessionStatusSchema.detail` and
`errorEvent.summary` via `redactIPsForTelemetry`), so an over-cap error description drops the frame
silently — and these are precisely the frames that report a session FAILING TO START.

⚠️ REACHABILITY NOT MEASURED, and I am not claiming it: whether any of those six errors actually
serializes past 4096 needs real failure output, which needs a live failing box. The asymmetry is what is
measured here — an unbounded interpolation feeding a bounded field with a silent-drop consumer.

⭐⭐ Stepping back, this is the THIRD sighting of one shape today and it is a CLASS, not three incidents:
**the harness applies "bound before emit" unevenly, while the CP bounds everything and drops silently.**
BOUNDED at the source: cookie jar TOTAL (8 MiB, with an honest `cookie jar too large` error rather than
a silent truncation), intent output (`result_too_large`), tab id/field (`truncate` + `maxTabIdChars`/
`maxTabFieldChars`), challenge detail (closed literal set, V-1749), capabilityReport (scalars + 3 entries).
NOT BOUNDED: `pageState.url`/`title` (V-1747 — CONFIRMED reachable, P-30), cookie PER-FIELD
`value`/`name` (total-only guard, `value: c.value` verbatim), `sessionStatus.detail` at the six
`\(error)` sites above.
⭐ So P-30 is not an isolated bug but the one confirmed member of a family, and the durable fix is a
bound-before-emit helper applied at every wire boundary — which must count UTF-16 units, not grapheme
clusters, per V-1747's measurement. Filed against P-30 rather than opened as a second row, because the
same helper closes all of them.

## V-1751 — W-10 made decidable: the 39 orphans are 36 duplicates, 2 by-design vestiges, and 1 real question

2026-08-26. W-10 has sat open as "39 declared component schemas with no operation `$ref`s — the fix
changes the published contract so it needs the owner's call". Re-measured it rather than inheriting the
number, then classified it so the call is one question instead of thirty-nine.

CONFIRMED, with the boundary stated: against `packages/sdk-python/openapi.json`, 83 components declared,
**39 unreachable** by transitive closure from `paths` (not merely "unreferenced" — the closure also
proves no orphan is kept alive by another orphan; reachable-from-paths and referenced-anywhere are both
44, so the orphan set is wholly disconnected). Control: three known-referenced components are correctly
absent from the orphan list.

⛔⛔ MY FIRST CLASSIFIER WAS WRONG AND SAID SO ONLY WHEN CHALLENGED. It matched an orphan to an inline
"twin" by comparing property-name SETS, and recorded inline schemas only where `type == 'object'` and
`properties` existed. Union-shaped components — `oneOf` — therefore **could not match by construction**,
and it reported six orphans as having no inline counterpart. Four of those six were artifacts of the
instrument's shape, not facts about the spec. Re-run with whole-schema structural equality (canonical
JSON over any node carrying `properties`/`oneOf`/`anyOf`/`allOf`), holding a positive control that
`AccountMeResponse` MUST match:

    orphans appearing VERBATIM inline under paths: 36 / 39
    genuinely absent from every operation:          3   (IntentResult, PaginationQuery, ListDeliveriesQuery)

So the classification:

- **36 are pure duplication.** The operation inlines the identical schema and the component sits beside it
  unused — e.g. `GET /v1/account/me` inlines a 16-property object matching `AccountMeResponse` exactly.
  `$ref`-ing these changes the contract's STRUCTURE, never its semantics.
- **2 are vestigial BY OPENAPI DESIGN.** `PaginationQuery` (`limit`,`cursor`) and `ListDeliveriesQuery`
  (`+status`) are query-parameter groupings, and query parameters live in `parameters`, not in a body
  schema. Nothing can ever `$ref` them. Deleting them costs nothing.
- **1 is the real question.** `IntentResult` — a `oneOf` of `{kind,intent,summary,captureId}` /
  `{...reason,diagnosis}` / `{...category,matchedText}` — appears in NO operation, while its sibling
  `AgentIntent` IS used, inline at `GET /v1/recipes/{id}`. Checked whether it documents an endpoint that
  exists but is undocumented, which would be worse than dead weight: it does not. The server's
  `IntentResultEnvelopeSchema` is INTERNAL (harness↔CP codec + the node-facing fleet socket), not a
  customer surface. So `IntentResult` is the paired result type for a published intent type, declared and
  never attached.

⭐ THE IMPACT IS NOT UNIFORM ACROSS SDKs, which is what makes this actionable. The **Python** SDK emits a
model class per component — `_generated/models.py` carries `IntentResult`, `PaginationQuery`,
`AccountMeResponse` and the rest — while **TypeScript and Go emit none of them**. So a Python customer can
import `IntentResult`, and no API call in the product can ever produce one.

⭐⭐ THE OWNER'S CALL IS NOW NARROW: do recipes return intent results to customers? If YES, `IntentResult`
is a documentation gap and the fix is to attach it to the operation that returns it. If NO, it is dead and
should be deleted along with the two query groupings — 3 components, zero contract change, the only
consumer impact being a Python class nobody could meaningfully have used. The 36 duplicates are a separate,
lower-stakes question (`$ref` for named SDK types vs leave inline) that does not need answering first.

BOUNDED: measured against the sdk-python spec only. If the TS/Go specs are generated separately rather
than from this file, their orphan sets are not covered by this count and I have not checked.

## V-1752 — W-10's root cause: `register()`'s return value is discarded, so the components it creates can never be referenced

2026-08-26. V-1751 classified W-10's 39 orphans and left the owner a product question. That question was
premature: the orphans are not a contract decision, they are **one mechanical bug repeated at ~39 sites**,
and the code states the intent it is failing to achieve.

`buildRegistry()` in `apps/server/src/lib/openapi.ts` does, under the comment "Reusable schemas — promote
to components.schemas so codegen produces named types (Pydantic, Go structs, etc.) **instead of inline
anonymous shapes**":

    r.register('AccountMeResponse', AccountMeResponseSchema);      // line 271, return DISCARDED

and every route then uses the ORIGINAL object — `content: { 'application/json': { schema:
AccountMeResponseSchema } }` at :1888. In `@asteasolutions/zod-to-openapi`, `register<T>(refId, schema): T`
returns a NEW schema carrying the refId metadata; the input is not mutated. Using the pre-registration
object emits the shape INLINE and leaves the component unreferenced.

⛔ I inferred that twice and got it wrong the first time — reasoning from the library that the operation
and component must be two different Zod objects, when line 271 and line 1888 name the SAME const. So I
ran it instead of arguing about it, on this exact library version:

    path uses the DISCARDED-return original : INLINE ({"type":"object","properties":{"a":...)
    path uses the RETURNED schema           : $ref -> #/components/schemas/Thing

That is the whole of W-10. It explains the shape of V-1751's numbers exactly: 36 of 39 orphans appear
VERBATIM inline because the inline copy and the orphaned component are rendered from the SAME Zod object,
so they cannot disagree — which is also why nothing has ever gone visibly wrong. The other 3 fit too:
`PaginationQuery`/`ListDeliveriesQuery` are query groupings never used as a body schema, and
`IntentResult` is registered but used by no route at all.

⭐ THIS CHANGES WHAT W-10 IS. Not "39 orphans, and the fix changes the published contract so it needs the
owner's call" but "a discarded return value defeats a documented intent". The response SEMANTICS do not
change — identical shapes, rendered from one source — only the spec's STRUCTURE (`$ref` instead of an
inline copy), which is precisely what codegen consumes and precisely what the comment asked for. The
Python SDK already ships the model classes; today no operation points at them.

⚠️ NOT FIXED IN THIS TURN, and the reason is blast radius, not doubt about the cause. Rewriting ~39
registrations rewrites a 2 MB published artifact, and this repo carries ~220 SDK-parity tests plus a large
spec-conformance suite (`openapi-route-coverage`, `response-body-matches-the-published-schema`,
`api-types-shapes-match-the-spec`, `sdk-python-models-cover-every-spec-schema`,
`sdk-go-structs-cover-openapi-fields` …). Several assert against INLINE shapes and would move. That is a
measurement to make before the edit, not during it.

⭐⭐ AND IT UNDERMINES A GUARD, which is the part worth acting on soonest. `api-types-shapes-match-the-spec`
enumerates its reference side from `spec.components.schemas`: measured just now, it compares 39 of the 178
shapes `api-types` exports, and **32 of those 39 are orphans**. So for 32 of its 39 checks the guard is
pinned to a component NO operation publishes. It is correct today only because both renderings come from
one Zod object — a property of the bug, not of the guard. Fixing the registrations makes that guard's
reference side real; leaving them means a guard whose correctness rests on the defect it sits next to.

BOUNDED: measured against `packages/sdk-python/openapi.json` (the only spec file in the repo — checked)
and the registry behaviour of the installed `@asteasolutions/zod-to-openapi`. I did not enumerate which of
the ~220 parity tests would move.

## V-1753 — W-10's fix shape proven and its blast radius measured, without mutating the shared tree

2026-08-26. V-1752 established the cause (a discarded `register()` return). This measures the fix before
making it, which is the order the last several findings earned.

⛔ MY PROPOSED FIX WAS WRONG AND THE CODE SAYS SO. "Capture the return value" cannot work: the schemas are
module-scope `const`s and the `r.register(...)` calls run later inside `buildRegistry()`, so there is
nothing to assign to. Ran the alternatives against the installed library instead of reasoning about them:

    declare -> register() later, use original (TODAY)   path=INLINE                      components=[Thing]
    declare with .openapi('Thing'), no register         path=#/components/schemas/Thing  components=[Thing]
    declare with .openapi('Thing') + register too       path=#/components/schemas/Thing  components=[Thing]

⭐ So the fix is ADDITIVE and one line per schema: `.openapi('Name')` on the DECLARATION, leaving every
existing `r.register(...)` call untouched — the third row proves keeping them is harmless. No restructuring,
no deletions.

BLAST RADIUS, simulated on the JSON rather than by mutating `lib/openapi.ts` in a shared tree — legitimate
here because V-1752 proved the inline copy and the component render from ONE Zod object and are therefore
byte-identical, so replacing each inline occurrence with a `$ref` is exactly what the fix emits:

    inline occurrences replaced:            72
    orphans:                                39 -> 4
    spec size:                   2,177,064 -> 1,874,887 bytes  (13% smaller)
    operations whose rendering changes:     46 of 234

⛔⛔ THE FIRST RUN OF THAT SIMULATION WAS WRONG AND ONLY THE POST-CONDITION SHOWED IT. It substituted
top-down without descending into a node it had just replaced, and never rewrote component BODIES at all, so
a component nested inside another matched component stayed invisible: it reported 57 replacements and SIX
surviving orphans. The residual orphan list is what gave it away — `AgentIntent` was in it, and V-1751 had
already established `AgentIntent` appears inline under `GET /v1/recipes/{id}`. Recursing into component
bodies (skipping self-reference) took it to 72 and 4. ⭐ Choosing "orphans must go to ~0" as the
post-condition is what made a wrong simulation visible; a count of replacements alone would have looked fine.

The 4 survivors: `PaginationQuery` and `ListDeliveriesQuery` are query groupings nothing can ever `$ref`
(V-1751), and `Account` and `Session` are a genuine residue — their exact shape appears NOWHERE in the
document, so a route embeds a near-miss variant. Not blocking, and worth a look separately.

⚠️ TEST BLAST RADIUS, and it is an UPPER BOUND, not a count of breakages: of 97 spec-reading test files, 21
already handle `$ref`/component references and are resilient; **38 read `schema`/`properties` with no ref
handling**. Several of those certainly read only `components.schemas`, which this change does not touch
(`sdk-python-models-cover-every-spec-schema` is in the list and is exactly that case). A precise number
needs the edit made and the suite run, which is the next step and not this turn's.

⛔ The measuring loop itself was wrong first: `for f in $FILES` reported 0 resilient AND 0 naive across 97
files, because **zsh does not word-split an unquoted variable** — one iteration over a single newline-laden
string. A both-branches-zero result on a non-empty input is what exposed it. Same trap as the `vitest run
$BEH` sweep earlier in this session.

NOT LANDED THIS TURN, deliberately: it rewrites a 2 MB published artifact across 46 operations and may
require edits to as many as 38 test files, and the standing rule is source plus every pin in ONE commit.
That belongs at the head of a turn with a green suite, not the tail of a long one.

## V-1754 — CORRECTION to V-1753's residual, and the reason is a duplicate-component pair

2026-08-26. V-1753 reported four orphans surviving the simulated W-10 fix and explained two of them by
saying their shape appeared nowhere in the document and that some route must publish a near-miss variant,
flagging it as a genuine residue worth investigating. ⛔ **That explanation is withdrawn — it is wrong.**
The count was right and the reasoning behind it was not, which is the harder kind to notice.

Chased it as its own question and the first measurement already contradicted the claim: comparing the
component's property set against every inline object under `paths` returned similarity **1.0** — identical
field names — at `/v1/admin/accounts/{id}/suspend`, `/tier`, `/unsuspend` and, for the other, at
`GET /v1/sessions/{id}` and `POST /v1/sessions`. A whole-schema diff then returned `identical? True`. The
shape does not appear "nowhere"; it appears verbatim, repeatedly.

⛔⛔ THE CAUSE WAS A THIRD BUG IN THE SAME SIMULATION, and it is a one-liner:

    bycanon = {canon(v): k for k, v in comps.items()}

A dict comprehension keyed by SHAPE silently collapses any two components that share one, keeping whichever
comes last. So the substitution emitted a `$ref` to the twin and left the other name unreferenced, and I
read that as "its shape appears nowhere" when the truth was "its shape appears under another name". ⭐ Three
successive corrections to one instrument — top-down substitution that never descended into a replaced node,
never rewriting component bodies, and now a shape-keyed map that discards collisions — and each was found by
interrogating a RESIDUAL rather than the headline number, which stayed plausible throughout.

⭐ THE REAL FINDING IS THE DUPLICATION. Of 83 components there are exactly **2 structurally identical
groups**, four names for two shapes:

    ['Account', 'AdminAccount']              7 props, byte-identical
    ['Session', 'CreateSessionResponse']    14 props, byte-identical

SDK codegen emits both members of each pair as separate identical classes.

⚠️ I checked the one that could have been a real defect and it is not. An ADMIN account view byte-identical
to the customer view suggests admin-only fields (suspension detail, internal flags) are published as absent
when the route returns them. Read the serializer: `publicAccount` in `routes/admin-accounts.ts:62` returns
exactly `id, email, name, tier, status, created_at, updated_at` — the seven published fields, nothing more.
The duplication is accurate, not an under-declaration. `Session`/`CreateSessionResponse` is the ordinary
case of a create returning the full object.

CORRECTED NUMBERS for the W-10 fix, superseding V-1753's: **70 replacements** (not 72), orphans **39 -> 4**,
and the four survivors are `AdminAccount`, `CreateSessionResponse`, `PaginationQuery`, `ListDeliveriesQuery`.
⚠️ Which member of each duplicate pair survives is ARBITRARY — it falls out of tie-breaking, not out of the
document — so the fix should name the intended one explicitly rather than let the generator choose. The
spec-size and operation-count figures in V-1753 (13% smaller, 46 of 234) are unaffected by this correction.

BOUNDED: structural duplication measured over `components.schemas` by exact canonical JSON only. Components
differing solely in a description or example would NOT be caught by that and are not counted here.
