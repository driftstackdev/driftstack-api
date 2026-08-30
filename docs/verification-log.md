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
> **Split again 2026-08-26 (V-1707)** for the same reason: entries V-1201..V-1499 moved to
> [`verification-log-archive-through-v1499.md`](./verification-log-archive-through-v1499.md).

> **Split again 2026-08-27 (V-1985).** Entries V-1500..V-1706 moved to
> [`verification-log-archive-through-v1671.md`](./verification-log-archive-through-v1671.md)
> — whose name records the intended boundary, not its contents; it holds through V-1706, and the
> range above was corrected in V-2120 after reading the file rather than its header.
> The live file had reached 1,508,063 bytes, past the 1,500,000-byte budget that
> `no-formatted-markdown-outgrows-the-format-hook` enforces as a nudge to split with room to
> spare. Archives are DISCOVERED by name by the guards that read this log, so none of them
> needed repointing; each is listed literally in `.prettierignore`.

> **Split again 2026-08-28 (V-2120).** Entries V-1707..V-1919 moved to
> [`verification-log-archive-through-v1919.md`](./verification-log-archive-through-v1919.md),
> named for the last entry it actually contains.
>
> ⛔ **Before appending, know the budget.** This file must stay under **1,500,000 bytes**, enforced
> by `no-formatted-markdown-outgrows-the-format-hook`. Past it, Prettier does not fail gracefully —
> the pre-commit hook dies inside a V8 out-of-memory stack trace, so the first symptom is every
> commit touching this file breaking at something that does not look like a rule. The remedy is to
> cut another `docs/verification-log-archive-through-v<last-entry>.md`, add it **literally** to
> `.prettierignore` (a glob there passes Prettier while leaving the guard red), and note the split
> here. Split early: this one was cut at 93% of budget, the previous one at 100.5%.

---

## V-1920 — auditing the fleet-credential route, and the one thing protecting it that nothing pinned (2026-08-27)

Picked by measurement rather than instinct: of 60 route files, ranked by how little the log says
about them, `mac-nodes-register.ts` stood out — 460 lines, 7 body mentions, none an end-to-end
audit. The instrument needed correcting first, though. Ranking by _heading_ mentions listed
`internal-atlas-priority`, which V-1903 records as already audited; ranking by _body_ mentions
puts it at 14 and the control passes.

**The route is sound, and unusually careful.** All four registrations sit behind `requireAuth` +
`requireScope('driftstack_internal_admin')`. The LiveKit `api_secret` is encrypted on arrival; an
encryption failure answers a generic 500 rather than echoing key-shape internals; the admin-audit
payload carries only `ws_url` and the node id; the response echoes neither credential; and
`GET /v1/mac-nodes` emits `has_livekit` as a **boolean**. `api_secret` appears in the file only in
the schema, the encrypt call, and comments.

Its header makes a claim worth testing rather than believing — _the plaintext "does NOT leave this
scope — never written to logs, never echoed in the response"_. Three independent checks, because
the risk lives outside the file:

1. **Zod does not echo it.** `ValidationError(parsed.error.flatten())` on an over-long, wrong-typed
   and empty `api_secret`: the value appears in neither `flatten()` nor the raw issues. The control
   is what makes that worth stating — `z.enum()` **does** echo the rejected value, through
   `flatten()` as well, so the check demonstrably detects a leak when one exists. No sensitive
   field is an enum, so there is no live exposure, but the property is real and worth knowing.
2. **No custom message interpolates a value.** All 23 `message:` templates across
   `apps/server/src` + `packages/api-types/src` interpolate constants or state names.
3. **Nothing logs a request body.** 137 `req.body`/`request.body` references in `apps/server/src`,
   zero passed to a logger — checked with a six-line proximity window, not line-by-line, after the
   single-line version would have missed the multi-line form.

### The gap the audit actually found

That third property is what the route's whole design depends on, and **nothing pinned it.**
`every-credential-header-is-redacted-in-logs` covers headers; `redact-text-scrubs-every-minted-
credential-shape` covers Driftstack's own minted prefixes — a third party's LiveKit secret matches
neither. Pino's `redact.paths` is path-keyed, so a logged body is scrubbed by nothing. The header
guard's own stated reasoning generalises exactly: it scrubs the BYOK and GUI control keys "even
though the route never logs `req.headers` explicitly", against "a future refactor that adds a
request-trace log". The body is the larger surface and had no equivalent.

New guard, `no-request-body-reaches-a-logger.test.ts`. It walks the AST rather than matching text,
because the shape that matters spans lines — `req.log.warn(\n { body: req.body },\n 'msg',\n)` is
what a real request-trace refactor produces and what a single-line grep misses. Proven against the
**real subject**: injecting exactly that multi-line form into `mac-nodes-register.ts` fails 1 of 3
arms and names the file, while both self-test arms stay green; restoring returns 3/3. It runs in
0.93s, using `createSourceFile` rather than a `Program` — the cost that made V-1917 time out.

**Boundary:** the guard recognises a logger as `<x>.log|logger.<level>(…)` and a body as
`req.body`/`request.body`, so a body first assigned to another variable, or a logger reached
through a differently-named handle, passes it; it covers `apps/server/src` only. The audit itself
read the route end to end but exercised nothing at runtime — every claim above is static. Ratchets
3055→3056 and 3231→3232.

## V-1921 — closing my own boundary: the body that reaches a logger under another name (2026-08-27)

V-1920 pinned that no request body reaches a logger and stated its own gap in the same breath: it
matched `req.body`, so _a body first assigned to another variable passes it_. That gap is not
academic. `mac-nodes-register` reads the LiveKit secret out of `body.livekit.api_secret`, where
`body = parsed.data` — so the object actually carrying the credential is the one the guard could
not see. Same defect, different spelling, which is this ledger's third standing lesson turned on
work I had committed an hour earlier.

**Prior art named the exact shape before I measured it.** V-1886 audited the one route whose job
is logging client telemetry and recorded why it is safe: _"Every logged field is enumerated by
hand — seven of them — rather than spread… A spread would inherit whatever the schema happens to
allow."_ Reading only the one-line body mention had suggested a site logs `parsed.data` wholesale;
the full entry says the opposite, and names the danger instead.

**Measured before extending anything.** An AST probe over all 342 files in `apps/server/src` finds
**3** logger calls containing a spread, control-validated against a synthetic `log.warn({...body})`:
two are conditional spreads of known fields, and `retention-scrub-sweeper.ts:83` is a bare
`...result` — where `result` is a locally-declared `RetentionScrubTickResult` of three counts and a
boolean. That is the _safe_ form of the shape: spreading a narrowly-typed local, whose type bounds
what it can ever carry. **Zero instances of a parsed body reaching a log.**

So the extension changes no behaviour today; it stops the shape appearing later. The guard now
seeds from any declaration whose initializer mentions `req.body` — catching
`const parsed = Schema.safeParse(req.body)` as well as a plain alias — then follows
`const body = parsed.data` to a fixpoint, and accuses only **whole-object** uses:

| shape                                       | verdict                                           |
| ------------------------------------------- | ------------------------------------------------- |
| `{ ...body }`, `{ body }`, `log.warn(body)` | accused — hands over everything the schema allows |
| `body.mac_node_id`, `body['id']`            | acquitted — how every route reads its fields      |

Proven on the **real subject**, both directions, each reporting its own reason: injecting
`...body` into `mac-nodes-register.ts` fails 1 of 5 arms with _body-derived 'body' passed whole_,
injecting `req.body` fails with _req.body_, and restoring returns 5/5. Two new self-test arms pin
the accusal of all three whole-object forms and the acquittal of field and element access.

**One flaw of my own, caught by eslint rather than by tsc.** The reason was accumulated into a
`let reason: string | null`, assigned inside a closure — TypeScript does not track those
assignments, so it narrowed the variable to `never` and the template literal reading it back was
invalid. `tsc` reported zero errors; `@typescript-eslint/restrict-template-expressions` caught it.
Worth stating plainly: a clean typecheck is not a clean lint, and the two disagree in both
directions.

**Boundary:** the derivation is syntactic and file-local — it follows declarations, not
assignments or parameters, so a body handed into a helper function and logged there is still
invisible; it recognises loggers as `<x>.log|logger.<level>(…)` and covers `apps/server/src` only.
Arms 3 → 5 in the same file, so no ratchet moves.

## V-1922 — six copies of one helper, three different answers, and all three are right (2026-08-27)

Chasing V-1921's stated boundary — a body handed to a helper and logged there. Measured before
building anything: **75** call sites hand a whole body or parsed body to a non-logger callee, but
the callees are overwhelmingly `Schema.safeParse(...)`, which is the body going _into_ validation.
The one worth reading was `parseOrThrow`, receiving raw bodies at 8 sites. It does not log.

Reading it found something else: **`parseOrThrow` is copy-pasted into six route files, and the six
do not agree on what a failed parse tells the caller.** My first instrument was wrong about it — a
fixed 14-line window captured 5 to 15 lines per copy and reported all of them as differing, which
was an artefact of the window, not a finding. Reading each body to its closing brace gives the
real split, and classifying by the routes' actual `requireScope` gates rather than by filename
gives the reason:

| copies                                             | gate                        | on a failed parse                             |
| -------------------------------------------------- | --------------------------- | --------------------------------------------- |
| `admin-cost`, `admin-crypto-orders`, `admin-usage` | `driftstack_internal_admin` | raw `result.error.message`                    |
| `account-cost`, `billing-crypto-orders`            | `read:billing` (customer)   | a fixed sentence, both stating why            |
| `oauth`                                            | serves PUBLIC endpoints     | raw message **plus** an RFC 6749 `error` code |

**All three postures are correct.** An operator reading a raw Zod message is fine; the two
customer copies say so explicitly — _"Don't leak the raw serialized zod error (full issue/path
JSON) into the customer-facing problem detail"_ — and `oauth` is the documented V-753 decision,
where integrators need the detail and get a stable `error` field to branch on instead of Zod prose.
The gate check corrected my own reading: `oauth.ts` looked staff-scoped from its `requireScope`
lines, and its `parseOrThrow` actually serves the unauthenticated endpoints.

**The defect is that none of it was pinned**, and the difference is not cosmetic. A Zod message can
carry the value it rejected — `z.enum` puts it in `received` and it survives `.flatten()` (V-1920)
— so the gap between these two branches is the gap between echoing a caller's rejected input and
not. A seventh copy, or a customer route pasting the staff form, changes that silently, and
copy-paste is exactly how six copies came to exist.

Frozen by **name and posture**, so both directions red. Proven on real files, and the two
mutations kill _different_ arms — checked by reading which test name failed, since two mutations
each killing "1 of 3" are indistinguishable in a count:

| mutation                                   | arm killed                                         |
| ------------------------------------------ | -------------------------------------------------- |
| flip `account-cost` to the staff posture   | _every copy still answers the way it was recorded_ |
| add a seventh copy to `mac-nodes-register` | _no SEVENTH copy has appeared in routes/_          |

The second arm reads the directory rather than the frozen list, because an arm that opens only the
six files it already knows can never notice a seventh.

**Boundary:** the classifier inspects `throw` statements inside a function literally named
`parseOrThrow` under `apps/server/src/routes`, so a differently-named helper with the same job is
invisible to it, and it judges the posture rather than the wording — a copy that changes its fixed
sentence still passes. Ratchets 3056→3057 and 3232→3233.

## V-1923 — the raw Zod message traced to the customer, and it never arrives (2026-08-27)

No defect. V-1922 pinned six `parseOrThrow` copies and stated its own limit: the classifier keyed
on the NAME, so a helper doing the same job under another name was invisible. Closing that by
sweeping the SHAPE — any function that calls `safeParse`/`parse` and throws.

**The first instrument was useless and said so loudly: 70 matches**, because every
`registerXRoutes` wrapper contains _a_ parse and _a_ throw somewhere in its hundreds of lines,
unrelated to each other. Filtering to functions of ≤25 lines — a real validation helper is small,
a route-registration wrapper is not — gives **20**, and the control holds throughout: all six known
`parseOrThrow` copies are found by shape, so the narrowing did not cost the known positives.

Of the fourteen the name-keyed classifier could not see, thirteen use a fixed sentence. The
divergence sits inside one file, `services/harness-control-codec.ts`, and it is **principled along
an axis the copies actually vary on** — direction of travel, not carelessness:

- `decodeWireData` handles **inbound** wire data and answers with fixed sentences ("is not valid
  base64", "did not contain valid JSON").
- `serializeIntentDispatch` and `encodeInlineProxyConfig` are **outbound**, validating data _we_
  construct before it leaves. Their raw Zod detail is the point: the docstring says the check
  exists "so a wrong shape is caught here, not as an opaque harness
  `intent_missing_parameter`". A failure there is a server bug, and the message is for whoever
  has to diagnose it.

### Following the message all the way to the wire

The interesting question was not the posture but whether that raw detail can reach a customer,
since a Zod message can carry the value it rejected (V-1920). Traced link by link rather than
assumed:

1. `HarnessWireCodecError` is **never caught or mapped** — grep returns only its definition, its
   throws, and doc comments — so it reaches the global handler as a plain `Error`.
2. `normaliseError` wraps anything unrecognised as `new InternalError('An unexpected error
occurred.', err)` — generic detail, original as the cause.
3. `ApiError.toProblem()` returns `{...safeExtensions, type, title, status, detail?, instance?}`.
   **`cause` is not among them.** The cause is handed separately to the logger.

So the message a developer needs goes to the logs, and the customer gets the generic 500.

**And the chain is already pinned — by a guard that anticipated the precise regression I was about
to write one for.** `error-handler-internal-error-no-leak.test.ts` injects real requests against
throwing routes and asserts the serialized body carries neither message nor stack, existing
explicitly because the three textual pins on `error-handler.ts` "would NOT catch a regression in
`lib/errors.ts` — e.g. `ApiError.toProblem()` or `InternalError` starting to spread `cause` into
`extensions`/`detail`". It also pins the contrast: known typed errors still surface their
controlled detail, "so the handler is proven to hide _unknown_ errors specifically, not
blanket-hide everything". Opening it instead of trusting its filename is what stopped a duplicate.

**Boundary:** the shape sweep covers `apps/server/src`, treats a function as a validation helper
if it is ≤25 lines and both parses and throws, and reads the posture from `throw` statements only —
a helper that returns a result object rather than throwing is outside it, as is one whose parse and
throw are separated by more than that span. No source change, no new guard, no ratchet movement.

## V-1924 — an audit that expired, and the two internal fields it never saw (2026-08-27)

`project_response_serializer_exposure_clean` audited the read-side field-exposure dimension on
2026-06-02 and says "don't re-audit". My own note says an audit about another file expires when
that file changes. **359 commits have touched `routes/` since** — `agent-sessions.ts` alone 131,
`profiles.ts` 23 — so the instruction and the note disagree, and the note wins on the evidence.

The audit's claim is precise and testable: public serializers are ALLOWLISTS, "each returns a
hand-picked field set, never the raw row". Probed across `apps/server/src` with a synthetic
control that was detected: **38** public serializers, **3** of which spread a parameter — all in
`services/agent-public-redaction.ts`, a file first committed **2026-07-13**, six weeks after the
audit. The audit was right about what it saw and silent about what came later.

Reading them acquits two of the three and reframes the last. They are not row-to-response
serializers at all but type-preserving redactors — `publicAgentIntent(intent: AgentIntent):
AgentIntent` — narrowing a typed object by deleting one field. For the two typed on
`@driftstack/api-types`, the published contract bounds what a spread can carry. `TranscriptEntry`
is different: it is an **internal** interface from `services/agent-decomposer.ts`.

### What actually reaches the customer

`publicTranscriptEntry` spreads that internal entry, and `routes/agent-sessions.ts` writes the
result to the live transcript SSE stream through `JSON.stringify` — no schema in the path, so
nothing strips anything. Two fields ride along:

| field                   | declared in api-types | read by any client |
| ----------------------- | --------------------- | ------------------ |
| `awaitingConfirmation`  | **0 mentions**        | **0**              |
| `resumeFromIntentIndex` | **0 mentions**        | **0**              |

Zero across `gui-client`, `customer-dashboard`, `admin-panel` and `sdk-typescript`, against 34 and
18 hits for "transcript" in the first and last — so the search reached those trees.

Neither is a credential; both are executor control state. The finding is not the present exposure
but the posture: a denylist over an **internal** type means the next field added to
`TranscriptEntry` reaches customers by default, chosen by nobody. That is precisely the shape
V-1886 named — "a spread would inherit whatever the schema happens to allow" — and every other
public serializer here is an allowlist instead.

Removing fields from a live stream is a contract change and the owner's call. **Freezing the
emitted set is the unblocked half**, and compatible with either decision.

### The guard needed strengthening before it was worth committing

My first version pinned what a FIXTURE emits. A field added to `TranscriptEntry` and set in
production would have left that fixture untouched and the arm green — the exact regression the
file exists to catch, invisible to it. The critical arm now reads the interface's declared
properties from source and requires each to be on the frozen list. Proven on the real subject:
adding `internalDebugTrace?: string` to `TranscriptEntry` fails that arm and nothing else;
restoring returns 4/4.

**Boundary:** the property read is syntactic — it takes `PropertySignature` members of an
interface literally named `TranscriptEntry` in `agent-decomposer.ts`, so an inherited or
intersected member is invisible to it; and the behavioural arm proves what this projection emits,
not what the SSE route ultimately writes, which it reaches by spread. Ratchets 3057→3058 and
3233→3234.

## V-1925 — the other two SSE streams, and one guard instead of three copies (2026-08-27)

V-1924 found the transcript SSE stream serialising an internal type straight to the customer.
Generalising: which OTHER streams do that? The population came from a guard that already had it —
`every-sse-stream-shares-one-buffer-ceiling` names the four SSE sites, so I reused its enumeration
rather than inventing one.

**The detector failed its control first, and the control is the only reason I noticed.** Grepping
`"data: \${"` inside double quotes let the shell eat `\$`, so the pattern became `data: {`: it
reported a total of 5 while printing nothing, and the file I already knew contained the shape
came back **0**. Single-quoted, it finds all five and the known site is present. Of those five,
two write a pre-built string and three serialise an object.

| site                           | serialises          | type declared in                                           |
| ------------------------------ | ------------------- | ---------------------------------------------------------- |
| `agent-sessions.ts:3611/3636`  | transcript entry    | internal — pinned by V-1924                                |
| `status-stream.ts:125`         | `IncidentEvent`     | `services/incident-event-bus.ts`, **0 api-types mentions** |
| `account-notifications.ts:162` | `NotificationEvent` | `services/notification-event-bus.ts`                       |

**Neither new one is a defect, and reading them is what establishes that** rather than their
location. `IncidentEvent` uses snake_case `generated_at` — a wire spelling, not a service one — and
`NotificationEvent`'s only per-account field is the recipient's own id, which its bus documents
deliberately ("cross-account leakage stays impossible"). Both are wire-designed types that happen
to live under `services/`.

What is true of both is structural: nothing in the path validates or projects, `JSON.stringify`
writes whatever the type carries, and neither type is in the published contract. The next field
added to either reaches every subscribed customer by default, chosen by nobody.

**One guard, not three copies.** V-1922 recorded six copies of one helper drifting into three
behaviours; the fix for that is not a seventh copy. This freezes both types' key sets in a single
file, and deliberately does NOT re-pin `TranscriptEntry`, which V-1924 already covers alongside the
redaction behaviour that file exists for.

The frozen lists are **derived from source and spliced in**, never hand-typed — a hand-written
alternation is a guess, and `NotificationEvent` has 17 keys across four union members. The reader
collects from every member for that reason: a first-member-only reader would pin about five of
them and pass. Proven on the real subjects, each killing its own arm:

| mutation                                               | arm killed                                           |
| ------------------------------------------------------ | ---------------------------------------------------- |
| add `internalTraceId` to `IncidentEvent`               | _IncidentEvent emits exactly the frozen key set_     |
| add `internalStackHint` to the **fourth** union member | _NotificationEvent emits exactly the frozen key set_ |

The second deliberately targets `session.errored`, the last member, so the union-wide collection is
what the proof rests on rather than an accident of ordering.

**Boundary:** the reader is syntactic — it takes `PropertySignature` members of an interface or
type-alias literally named in the frozen map, within one named file under `services/`, so an
inherited, intersected, or imported member is invisible to it; and it pins the TYPE's declared
fields, not what any particular publisher actually sets. Ratchets 3058→3059 and 3234→3235.

## V-1926 — a "fully mined, don't re-pick" conclusion whose premise had since changed (2026-08-27)

The same 2026-06-02 memory V-1924 found expired carries two more audits at the same date, and one
of them closes an entire lens: _"all 5 egress paths … the egress lens is exhausted"_. Its SSE leg
rests on a stated premise — **"only `cost.threshold_alert` is actually published (the other 3 kinds
forward-declared/unwired)"** — and the conclusion follows from it: one published kind, carrying the
customer's own cost data, therefore no leak.

**The premise is stale. All four kinds now have live publishers**, and the code says so itself:
`bootstrap.ts` comments that its broadcast "retir[es] the kind's zero-publisher state". Measured,
with the audit's own claim as the control (`cost.threshold_alert` still exactly 1):

| kind                   | publishers now | method                  |
| ---------------------- | -------------- | ----------------------- |
| `cost.threshold_alert` | 1              | `publish` (per-account) |
| `incident.broadcast`   | 1 — **new**    | `publishBroadcast`      |
| `audit.high_severity`  | 1 — **new**    | `publish` (per-account) |
| `session.errored`      | 3 — **new**    | `publish` (per-account) |

**Re-tested rather than inherited, the conclusion still holds.** `audit.high_severity` is addressed
to the audited account; `session.errored` is addressed to the session's owner, behind a
"dropped errorEvent without an exact session-owner node match" guard, and its `errorClass` is the
harness `code` — bounded by `z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)`, which admits no dot,
colon or slash and therefore cannot carry the node IP the forward-guard in
`fleet-control-registry.ts` warns errorEvents can hold in `summary`/`detail`, neither of which is
forwarded. `incident.broadcast` is public platform data.

### The gap the re-test exposed

`publishBroadcast` fans one frame to **every** account with a live stream, stamping each copy with
that subscriber's own `accountId`. For an incident that is right. For an account-scoped kind it is
a cross-tenant leak _that looks legitimate at every downstream layer_ — account A's audit action
arrives at account B carrying B's own id, so neither the route nor the client can tell.

Three of the four kinds are account-scoped facts and all three correctly use `publish`. What was
pinned: `notification-bus-cross-source-invariant` asserts the bootstrap's broadcast call carries
`kind: 'incident.broadcast'` — a positive pin on ONE site, which keeps that publisher wired and
says nothing about a SECOND site appearing with an account-scoped kind.

`only-account-agnostic-kinds-may-be-broadcast.test.ts` closes that direction: every
`publishBroadcast` call in `apps/server/src`, in whatever file, must carry a kind from a frozen
account-agnostic set. It accuses an unreadable call too — a broadcaster whose argument is not an
object literal with a literal `kind` fails rather than passing, since that is precisely what must
not be waved through. Proven with the real regression: switching `account-audit.ts` from `publish`
to `publishBroadcast` fails the population arm and names both the file and `audit.high_severity`.

**Boundary:** the reader matches any `<x>.publishBroadcast({...})` syntactically within
`apps/server/src`, so a broadcast reached through an aliased function or a re-exported wrapper is
invisible to it, and it judges the literal `kind` at the call site rather than the type of the
value passed. Ratchets 3059→3060 and 3235→3236.

## V-1927 — the gate went red at a commit that passes, and this time the red kept its name (2026-08-27)

The gate failed at `18e579f24` with **2 of 3236** files red, then passed at the same commit,
unchanged, minutes later. Recorded rather than shrugged off, because a run that disagrees with
itself is a defect in the suite even when the code is fine.

**Attribution first, per the standing order.** `git status` was empty — no peer had a dirty file,
so the red came from committed state; and the only commits since the previous green (3235) were
mine. That made it mine to explain, not to hand off.

**It is not a logic failure.** Zero `AssertionError` in the whole run. Both failures are timeouts:

| test                                              | allowance                        | outcome   |
| ------------------------------------------------- | -------------------------------- | --------- |
| `a-source-gate-may-not-be-satisfied-by-a-comment` | 10 000 ms (project default)      | timed out |
| `a-workspace-declares-what-its-source-imports`    | **30 000 ms** (its own override) | timed out |

Run together in isolation, the two pass in **4.1 s** for 6 tests. A test carrying a 30 s allowance
exceeding it, then finishing in seconds alone, is CPU starvation under suite parallelism — not a
slow test and not a wrong one.

**My first instinct was that I had caused it, and the measurement says otherwise.** I have added
five AST guards in recent firings, so the load hypothesis was the honest one to check. Counted:
**230 pre-existing unit tests already use `readdirSync`** to walk the source tree, four of my five
use the same cheap `createSourceFile` pattern as those 230, and exactly **one** test in the entire
3236-file suite builds a TypeScript `Program` — mine, already rooted at `src/` (342 files, not the
config's 2836) and with its self-test arms rooted at their injected file alone. Five files added to
a suite where 230 already do the same work is not a plausible tipping point, and the green re-run
at the identical commit agrees.

**What this most likely is, stated at the confidence the evidence supports.** Two runs disagreed
and the subject did not move — same HEAD, clean tree both times — so the variance is in scheduling,
not in the code. V-1918's durations run found only one test above half the ceiling; these two sat
at roughly 25% and 38%, which is ample margin on a quiet machine and evidently not on a loaded one.

⭐ **A note on the earlier unexplained red.** Much earlier this session the gate went red once at
`bc576990e` and I could not name the test, because a filter had eaten the identity before I read
it. That red was never explained. This one has the same signature — a transient failure at a commit
that passes on re-run — and the mechanism here is now evidenced. I am not claiming they are the
same event: that one's identity is unrecoverable, so this is a consistent hypothesis and not a
resolution. What changed is that capturing full output to a file, which V-1889 forced after that
episode, is why this red kept its name long enough to be diagnosed.

**Not fixed, deliberately.** Both timing-out tests belong to other work, and the one already
carrying a 30 s override would only be papered over by a larger number. The finding is the
fragility itself: a suite in which scheduling variance alone can red a run, at tests whose quiet
margin looks comfortable.

**Boundary:** two runs of one commit on one machine, with no other load controlled or measured — so
this establishes that the suite is non-deterministic under contention, not how often, nor which
tests sit closest to their ceiling under real CI parallelism. Ratchets unchanged at 3060/3236;
32137 tests pass on the green run.

## V-1928 — quiet-machine timings cannot predict which tests time out, and that is the result (2026-08-27)

V-1927 established the suite is non-deterministic under contention and stated what it had not
measured: which tests sit closest to their ceiling. Measuring that, and the answer is the opposite
of what the question assumed.

**The instrument needed fixing first, and its own control caught it.** Comparing every test to the
10 s project default — as V-1918 did — is wrong, because a test carrying its own override has a
different margin entirely. A per-test ceiling reader, validated against three known positives,
failed one of them: `a-workspace-declares-what-its-source-imports` declares 30 s through
**`vi.setConfig({ testTimeout: 30_000 })`**, a file-level call no per-`it` reader can see. Extended
to `vi.setConfig` and `describe`-level options, all three controls pass: **29 945 tests, 58 with a
non-default ceiling.**

**On a quiet machine, nothing is close.** Joining durations to each test's own ceiling across the
whole suite:

| measure                                                    | result    |
| ---------------------------------------------------------- | --------- |
| highest ratio of duration to own ceiling                   | **17.7%** |
| tests above 50% of their own ceiling                       | **0**     |
| tests above 80%                                            | **0**     |
| `the-server-source-type-checks` (42.8 s against its 300 s) | 14.3%     |

And the test that actually timed out at 10 000 ms in V-1927's red run — `a-source-gate-may-not-be-
satisfied-by-a-comment` — runs here in **1771 ms**. It needed a **5.6× stall** to fail. The 30 s
one needed roughly 8×.

### The negative result, which is the useful part

**Duration profiling on a quiet machine cannot identify the tests that will flake.** I have now
built that instrument twice, once in V-1918 and once here with a strictly better ceiling model, and
both times it reports comfortable margins for a suite that demonstrably reds itself. A ranked list
of "closest to the ceiling" is not a fragility list: the failures are not marginal tests tipping
over, they are order-of-magnitude stalls that land wherever the scheduler happens to squeeze.

The corollary matters for anyone tempted by the obvious fix: **raising a timeout is not the
remedy.** Margins are already 5.6× and more; a number large enough to absorb an 8× stall would
stop being a timeout in any useful sense.

**One hypothesis tested and refuted.** Tests that shell out compete for whole processes rather than
threads, so child-process spawning was the natural cause. Neither timing-out file spawns anything —
`execFileSync`/`execSync`/`spawnSync` count zero in both. The theory does leave a real side
observation: of the 20 highest-ratio tests, **7** sit in child-process-spawning files, against
**135 of 32 137** tests suite-wide, so those files are disproportionately slow — they are simply not
the ones that failed.

**Boundary:** one run on one otherwise-idle machine, joined by (filename, test title); **2104 of
32 137** durations found no ceiling match and fell back to 10 s. That fallback can only make a test
look _closer_ to its ceiling than it is, never further, so it cannot be concealing a high-ratio
test — but it does mean the 58 non-default ceilings are a floor on that count, not an exact census.
The mechanism behind the stalls is still unidentified; this rules out thin margins and child
processes, and does not replace them with a cause.

## V-1929 — the prior art I should have read before concluding, and a second flake class (2026-08-27)

V-1928 ended with the mechanism "unidentified". A prior-art check afterwards found
`feedback_flaky_tests_are_defects_not_noise`, written from this repo, which says two things I had
not applied:

1. **"when a gate is red in a sweep and green on re-run, the re-run proves nothing."** That is
   exactly the inference V-1927 rested on. I did better than a bare re-run — I read the captured
   log and found the timeouts — but I then ran the two tests **in isolation**, and the same note
   records that these "pass 5/5 in isolation" so isolation proves nothing either.
2. The reproduction method is **repeated whole-suite runs**, not single files.

It also asserts that every load-dependent flake here traced to a **real test defect — a timing
assumption**. That is a stronger claim than "scheduling variance", and worth testing rather than
waving away.

**Tested. There is no timing assumption, and its absence is the diagnosis.** Both timing-out files
are purely synchronous scanners: `setTimeout`, `waitFor`, `Date.now`, `sleep` and `async` all count
**zero** in each. A test that awaits nothing cannot hold a timing assumption; it can only miss a
deadline by being denied CPU. So this is a **second class**, not a counterexample to the first —
and the two have opposite remedies, which is why telling them apart matters.

**Three causes refuted, which is what leaves contention standing rather than assumed:**

| candidate                | verdict                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a timing assumption      | no timing construct in either file                                                                                                                     |
| child processes          | `execFileSync`/`execSync`/`spawnSync` zero in both — though such files ARE disproportionately slow, 7 of the top-20 ratios against 135 of 32 137 tests |
| my own five added guards | the scanner selects only files defining `function X(re: RegExp): boolean`; none of mine does, and they cost **5 reads of ~3236**                       |

**And the rate V-1928 said it could not give.** Three further full runs at the same commit, by the
documented method: all three green, zero timeouts, no failing files. Counting every `verify-suite`
execution at `18e579f24`: **1 red in 5**. A sixth full pass (the JSON-reporter run) was also clean.

**What stands, and what does not.** V-1928's measurement stands — nothing exceeds 17.7% of its own
ceiling, so quiet-machine profiling cannot find these, and raising a timeout is not the remedy when
the margin is already 5.6×. What does not stand is stopping at "unidentified" before reading the
repo's own note on the subject; the note did not solve it, but it named the reproduction method and
a rival hypothesis worth eliminating, and both were a single grep away.

**Boundary:** six full-suite executions on one otherwise-idle machine at one commit, so 1-in-5 is an
observed frequency on this hardware and not a CI rate; and the refutations rule three candidates out
without establishing which contended resource — CPU, page cache, or worker scheduling — actually
starves the scanners.

## V-1930 — 68 unbounded strings, or zero, depending on which direction you measure (2026-08-27)

Turning from egress to ingress: the harness control protocol, where a Mac fleet node's frames
drive real state. The question was whether length bounds are applied uniformly, since one
unbounded string among bounded siblings is the growing-family shape.

**My first measurement said 68 and was worthless.** Counting `z.string()` across
`harness-control-protocol.ts`: 182 occurrences, 112 bounded by `.max()`, 2 by a regex length
quantifier, **68 apparently unbounded**. Reading three of them stopped that list from being
published. The file carries BOTH directions and says so at line 732:

- **ControlInbound** — server ENCODES → harness: `sessionAssign`, `intentDispatch`, `sessionEnd`,
  `ping`, and the CP→node request frames.
- **HarnessOutbound** — server DECODES ← harness: `heartbeat`, `sessionStatus`, `intentResult`,
  `capabilityReport`, `errorEvent`, and the rest.

Only the decode side is ingress. `IntentDispatchSchema` and `CookiesRequestSchema` — two of my 68 —
carry comments saying "server → harness" and "CP→node … NOT in HarnessOutbound". **A schema we
construct ourselves needs no length cap.** A direction-blind count on a bidirectional protocol is
not a weak measurement; it is a meaningless one.

**Scoped to the transitive closure of `HarnessOutbound` — 66 schemas — the count is ZERO.** Every
string a node can send is capped. Both controls hold: `ErrorEventPayloadSchema`, a genuine member
payload, is inside the closure, and `IntentDispatchSchema` is outside it.

The closure has to be transitive, not top-level: an envelope member reached through another schema
still carries whatever the node sends, so walking one level would check the envelope and miss every
payload in it.

### Bounded is not the same as `.max()`

`code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)` has no `.max()` and is the most carefully
bounded field in the file — the same regex that, in V-1926, was what made `errorClass` safe to
forward to a customer. A checker recognising only `.max()` would report a false positive on it. The
guard counts `.max(...)`, `.length(...)`, and a `.regex(...)` whose pattern carries an upper length
quantifier, and one arm exists solely to pin that.

**Proven in both directions on the real schema, which is the whole point:**

| mutation                                                          | result               |
| ----------------------------------------------------------------- | -------------------- |
| unbounded string added to `ErrorEventPayloadSchema` (decode side) | **1 of 3 arms reds** |
| the identical addition to `IntentDispatchSchema` (encode side)    | **stays green**      |

The second is what separates this guard from the file-wide checker that would have accused 68
innocent fields.

**Boundary:** the closure follows identifier references within
`apps/server/src/schemas/harness-control-protocol.ts` only, so a schema imported from another
module and embedded in an outbound frame is invisible to it; and bounding is judged syntactically
from the call chain, so a cap applied by an enclosing `.transform()` (as `ErrorEventSchema` does for
total serialized bytes) is not counted — which makes the check strictly conservative rather than
lenient. Ratchets 3060→3061 and 3236→3237.

## V-1931 — a red that is not mine, attributed before investigating, with the diagnosis handed over (2026-08-27)

The gate validating V-1930's ratchet came back **1 failed | 3236 passed (3237)**. Attribution
first, because the standing order is explicit that reds in `apps/gui-client` belong to A2:

- The failing file is `apps/gui-client/tests/unit/use-receipt-pdf-download.test.tsx` — the
  `gui-jsdom` project, A2's tree.
- Every path my commits since `21a3b65d4` touched: four files under `apps/server/tests/unit`,
  `docs/verification-log.md`, `scripts/verify-suite.mjs`. **Zero** under `apps/gui-client`.
- The working tree was clean, so no peer's uncommitted file is implicated either.

**My own change is validated regardless**, which is what the run was for: the gate collected
**3237** files against `EXPECTED_TEST_FILES_ALL = 3237`. The ratchet is right; the red is content
in someone else's test.

**Not fixed — theirs. But it is diagnosable from outside, so here is the diagnosis.** The failing
arm is _"bounds a stalled download with actionable recovery"_, and the file combines
`useFakeTimers` (1) and `advanceTimersByTime` (1) with `waitFor` (2). That pairing is named in this
repo's own flake note:

> Beware fake timers: `waitFor` polls on real timers, so converting a `vi.useFakeTimers()` test to
> `waitFor` makes it hang. Leave fake-timer tests synchronous — they are already deterministic.

So this is flake **class one** — a timing assumption, the class whose remedy is to fix the
assumption rather than the assertion — and distinct from the class-two synchronous-starvation
failures of V-1927 through V-1929, which had no timing construct at all. Recorded here rather than
in `docs/internal/OPEN-ITEMS.md`, which is dirty with A2's rows and not mine to commit.

**Boundary:** this attributes the red and names a documented mechanism consistent with it from the
file's imports and helpers; I did not run the test, reproduce the failure, or read its body, so the
diagnosis is a strong lead for whoever owns it and not a confirmed root cause. Ratchets unchanged at
3061/3237.

## V-1932 — nine correlators, one shared guard, and the token sweep that accused two of them (2026-08-27)

Closing V-1930's stated boundary first: its closure followed identifiers _within_
`harness-control-protocol.ts`, so an imported schema embedded in an ingress frame would have been
invisible. The file imports **only `zod`** — no schema comes from elsewhere, so that closure was
already complete and V-1930's zero holds unqualified.

Then the sibling axis, since V-1930 measured strings and an unbounded **array** of bounded strings
is the same defect differently spelled. Scoped to the same 66-schema ingress closure: **5**
`z.array()`/`z.record()`, **all 5 bounded**, controls passing. Two apparent anomalies both
dissolved on reading — `.strict()` appearing 78 times against 41 `z.object(` is my own bad
comparison (multi-line chains put `.strict()` on its own line; 58 of the 78 are continuations), and
the single `.passthrough()` is `IntentResultHeaderSchema`, a documented _"cheap routing header used
before any full-envelope parse"_. Its one consumer reads only the three bounded identity fields and
then re-parses the **raw frame** strictly, so the passed-through keys are never read.

### The family that read exposed

That consumer carries a cross-session spoof guard whose comment says it "mirrors the identical
guard the six sibling request-correlators already carry". A shared fleet connection carries every
session on a node, so a frame echoing a known request id from a different session must be dropped —
settling it would hand one account's DOM, screenshot, extracted text or cookie jar to another
account's in-flight request.

**Sweeping for `sessionId` reported two gaps, and both were mine, not the code's:**

| correlator                        | sessionId compares | truth                                                                                                                                                    |
| --------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trim-profile-request-correlator` | 0                  | keys on **`profileId`** — "a profile at rest has no live session" — and drops on `profileId !== pending.profileId`, logging "cross-account spoof signal" |
| `session-readiness-correlator`    | 0                  | **connection-local**: one instance per `FleetControlConnection`, so ownership is structural and there is no cross-request correlation to spoof           |

The guard is keyed on the CORRELATION KEY, not on `sessionId`. I swept the token and it accused the
two members that vary — the third standing lesson, on a sweep I wrote minutes after invoking it.

**What was actually missing.** Eight correlators have their own test naming spoof or cross-session,
so each is individually covered. Nothing covers the FAMILY: every one of those tests opens only its
own file, so a tenth correlator added without a guard is invisible to all of them — the same shape
as V-1926, where one broadcast site was positively pinned and nothing prevented a second.

`every-correlator-drops-a-key-mismatched-frame.test.ts` freezes the roster **by file and by key**,
reads the roster from disk so a tenth is seen, requires each exemption to carry a reason, and
includes a matcher self-test — without which the population arm would pass just as happily against
a matcher that returned true for everything. That arm also pins the discrimination directly:
trim-profile satisfies a `profileId` check and must NOT satisfy a `sessionId` one.

Proven on real subjects: removing the real guard from `harness-dispatch-correlator` reds **2** arms
(the population arm and the self-test that names that file as a known positive), and dropping a
tenth correlator into `services/` reds the roster arm alone.

**Boundary:** the matcher is textual over a whitespace-normalised body, matching `key !==
pending.key` / `target.key` in either order, so a guard written through a helper call or an early
`return` inside a destructured comparison would not be recognised — it is conservative, accusing a
real guard it cannot see rather than passing one that is absent. Ratchets 3061→3062 and 3237→3238.

## V-1933 — the same test twice, which refutes what V-1929 said about where the stalls land (2026-08-27)

The gate validating V-1932's ratchet came back red on
`a-source-gate-may-not-be-satisfied-by-a-comment` — **`Test timed out in 10000ms`**, the same test
and the same arm that timed out in V-1927. The ratchet itself is validated: 3238 files collected
against `EXPECTED_TEST_FILES_ALL = 3238`.

**Two timeouts of the SAME test in seven full runs is concentration, and V-1929 said the opposite.**
That entry characterised the failures as landing "wherever the scheduler happens to squeeze". With
one data point that was the honest reading; with two on one test it is wrong, and the correction
matters because it moves this from an untargetable property of the suite to a property of one test.

**What that test actually costs, measured.** It reads **every** `*.test.ts` under `apps` and
`packages` — **3053 files, 26.3 MB** — to apply a two-condition filter that selects **8**. That is
O(whole suite) work per run, in a suite that grows daily; I added six files to it myself today.
Being the heaviest reader makes it the most exposed member under pressure, which is a cause of
concentration rather than a coincidence.

**One hypothesis tested and refuted.** If the exposure were I/O, competing readers should reproduce
it. Timed in isolation across five runs: **1414–1510 ms** after a 2458 ms warm-up — stable. With
four concurrent processes reading the same 26 MB: **1455 ms**, no slowdown at all; the page cache
absorbs it. So the stall is not I/O starvation, and the real condition — ten to sixteen CPU-bound
vitest workers each with its own heap — is one I have not reproduced outside a full run.

**What stands from V-1928 and what does not.** The margin measurement stands: this test sits at
17.7% of its ceiling on a quiet machine, the highest ratio in the suite, and no test exceeds 50% —
so quiet-machine profiling still cannot rank fragility. What does not stand is V-1929's inference
that the failures are unlocalised. They are localised, on the suite's single largest reader, and
that is a target rather than a shrug.

**Not fixed here.** The remedy is to stop reading 3053 files to find 8 — the filter's first
condition (`function \w+\(re: RegExp\): boolean`) could gate a cheap pre-filter — but that rewrites
a pre-existing V-923 guard while the suite is red, and the change deserves its own firing with its
own mutation proof rather than being folded into a ratchet validation.

**Boundary:** two observed timeouts across seven `verify-suite` runs at three different commits on
one machine, so this establishes concentration on that test and its workload, not a rate, and not
which contended resource produces the stall — I refuted I/O and did not replace it with a measured
cause. Ratchets unchanged at 3062/3238.

## V-1934 — the cause was never in the suite: the machine was at load 24 (2026-08-27)

V-1927 through V-1933 chased a timeout through five entries and never named a mechanism. It was
measurable the whole time, one command away, and my pre-flight does not look at it.

**The confirming run took 678.57s** against the usual ~380s — 1.8× slower — and timed out on the
same test again. That is a suite-wide slowdown, not a test-specific one, so the question was never
"what is wrong with that test".

```
load averages: 16.36 26.63 24.12     8 users, two accounts
```

Sampled over 40s it held at 12–25, with a 15-minute average of ~23, so it is sustained rather than
transient. The top consumers are all peer work: a WebKit fork process at **83%**, three Python
capture processes at **67–72%** each, and — in this very repository — `node
.../driftstack-api/node_modules/.bin/tsc` at **71%**, which is A2's W-12 typechecking.

### What this explains, and what it retires

| entry  | claim                                                            | status                                                                                                                            |
| ------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| V-1928 | no test exceeds 17.7% of its own ceiling                         | **stands** — measured on a quiet machine, which is exactly why the margins looked huge                                            |
| V-1929 | 1 red in 5 runs; failures land "wherever the scheduler squeezes" | rate stands; the unlocalised reading was already corrected in V-1933                                                              |
| V-1933 | concentrated on the suite's heaviest reader                      | **stands, and now has its cause** — 3053 files / 26.3 MB makes it the most exposed member under saturation, not the defective one |

So the timeouts are neither a suite defect nor a test defect. They are the expected consequence of
running a 3238-file suite on a machine already saturated by other agents' work, and the same test
fails each time because it is the largest reader in it.

⛔ **The procedural gap is mine.** My pre-flight checks three things — no second `vitest`, no dirty
tree, no writes in the last 90 seconds — and the standing order explains why each matters. **None of
them looks at machine load.** A gate launched at load 24 is expected to flake, so a red under those
conditions carries no information about the commit, and re-running it to "confirm" is worse than
useless: it burns ten minutes and adds to the contention. `uptime` before `verify-suite` costs
nothing and would have ended this thread five entries ago.

**The ratchet is validated regardless**, which is what the run existed for: **3238 collected**
against `EXPECTED_TEST_FILES_ALL = 3238`, with 3237 files passing and the single failure being the
known offender.

**Boundary:** load average and the process table are a snapshot of this machine over roughly one
minute, so this identifies the contention and its owners at 07:18 and does not establish that every
earlier red in this thread had the same load behind it — V-1928's durations run, by contrast, was
demonstrably taken quiet, since nothing in it exceeded 17.7%. Ratchets unchanged at 3062/3238; no
source change.

## V-1935 — the repeat timeout victim, made 2.9× cheaper instead of given a bigger timeout (2026-08-27)

V-1933 deferred this deliberately: the remedy for the suite's heaviest reader is to stop doing the
work, not to widen its allowance, and that deserved its own firing rather than being folded into a
ratchet validation. Load is still 9.7 on 10 cores, so this is CPU-light work and the gate is
deferred with it.

**V-1933's cost figure was too low, and reading the file is what corrected it.** I had measured
`gateFiles()` — 3053 files, 26.3 MB — and stopped. The dominant cost is a second walk:

```
for (const file of gateFiles())        // 8 gate files
  for (const m of body.matchAll(calls))  // its patterns
    classify(root, …)                    // walks apps/server/src ENTIRELY, per pattern
```

`classify` re-reads all **342** files under `apps/server/src` and re-runs `kindMask` — a
per-character lexer — on every call, and it is called **16 times** on the current roster. That is
**5,472 reads and ~70 MB lexed per run to answer 16 questions about the same unchanged bytes**,
on top of `gateFiles()`. The `{src, mask}` pair depends only on the file, never on the pattern.

Computed once per root and reused. The arm's own duration, from vitest's JSON reporter:

|        | run 1      | run 2      |
| ------ | ---------- | ---------- |
| before | 614 ms     | 614 ms     |
| after  | **213 ms** | **212 ms** |

**2.9×**, with the sibling arm unchanged at ~150 ms because it never calls `classify`.

⛔ **Wall clock said 20% and was the wrong instrument.** A single-file vitest run carries ~2.4 s of
boot, which swamps a 400 ms saving; the per-test duration is what isolates the work from the
harness. I nearly reported the 20%.

**Proven behaviour-preserving against a known positive, not against green.** A clean run passing
proves little when the expected result is an empty list. The construction that does prove it needs
**two** files — the token in a COMMENT inside `apps/server/src`, plus a gate call naming it — because
`classify` searches the source tree, not the gate file. My first attempt put the comment in the gate
file, got `code=0, comment=0`, and passed: the offender condition requires `comment > 0`, so a
wrongly-built positive is indistinguishable from a working detector. Built correctly it reds and
names the token, **before and after** the change alike.

**What this does and does not fix.** It does not remove the timeout risk — V-1934 established that
as machine saturation, and no amount of local thrift survives load 24. It removes 2.9× of the work
that made this particular test the most exposed member, which is the half that is mine to control.

**Boundary:** durations measured on a machine at load ~9–18, so the absolute figures are inflated
relative to V-1928's quiet-machine 1771 ms for the same arm and only the ratio is meaningful; and
the cache is per-root within one test file, so it changes nothing for any other test. `it(` count
unchanged at 2; no ratchet movement.

## V-1936 — four corrections to one detector, and the shape turned out not to be the cost (2026-08-27)

V-1935 fixed a test that re-walked 342 files sixteen times. The obvious next question — are there
others? — took four corrections to ask properly, and the answer is no. Load was 9.9 on 10 cores, so
this was static analysis with the gate deferred.

**The detector, and what each version got wrong.** A "walker" is a function reaching `readdirSync`;
the hunt was for walkers called repeatedly.

| version | rule                          | result  | why it was wrong                                                                                                                                           |
| ------- | ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | walker called inside any loop | **560** | a recursive walker calls ITSELF in its own loop to descend — that is how it works, and it flagged every recursive walker in the repo                       |
| 2       | …excluding self-recursion     | **312** | `for (const f of walk(DIR))` puts the walk in the ITERABLE, evaluated once; `walk(X).filter(cb)` puts it in the RECEIVER. Both were counted as "in a loop" |
| 3       | …loop BODY or callback only   | **60**  | `targets.flatMap((d) => walk(d))` walks two DIFFERENT trees once each — linear and correct                                                                 |
| 4       | …loop-INVARIANT argument only | **8**   | tractable, and read                                                                                                                                        |

Each correction is a real distinction, and every one of the three sampled false positives read
as an obvious defect until opened — which is the whole reason for opening them.

**The control failing is the most useful thing the detector said.** The pre-fix version of the file
I optimised in V-1935 never survives version 3, because its walk sits in the ITERABLE position:
`for (const f of tsFiles(root))`, evaluated once per `classify()` call. **The repetition was that
`classify` itself was called sixteen times** — a caller-level repeat, not a lexical one. My control
was never valid for the detector I was building, and it took until version 3 to notice.

**The eight survivors are real instances of the shape and cost nothing.** Measured per-arm:

| file                                                  | slowest arm |
| ----------------------------------------------------- | ----------- |
| `a-documented-error-status-is-derived-from-its-class` | 377 ms      |
| `public-app-v205-attribution-sweep`                   | 148 ms      |
| `astro-markup-escapes-server-data`                    | 147 ms      |
| `every-route-is-driven-over-http`                     | 121 ms      |
| `an-exempt-surface-that-can-drop-a-field-is-listed`   | 39 ms       |
| `api-reference-surface-doc-parity`                    | 6 ms        |

All below V-1935's 614 ms instance, none near a ceiling. `the-crypto-api-doc…` calls
`registeredRoutes()` inside a `.filter` predicate — once per documented route, the worst-looking
shape in the list — and runs in **1–2 ms**, because that walker reads only the four
`billing-crypto*` files. `routeRegistered` short-circuits on first match, so twelve entries cost
6 ms.

⭐ **The generalisation worth keeping: the shape does not predict the cost.** V-1935's instance was
expensive because of walk SIZE — 342 files, sixteen repeats, a per-character lexer on each — not
because it was a repeated walk. Cost is `size × repeats × per-file work`, which is a measurement;
"walker called in a loop" is a pattern, and patterns rank badly. **No fix, and no guard**: a guard
on this shape would fire on eight sites that are all fine, which is worse than no guard.

**Boundary:** the detector reads `apps`, `packages` and `scripts` test files, defines a walker
syntactically as a function reaching `readdirSync`/`globSync`, and cannot see the caller-level
repeat that V-1935 actually fixed — so this establishes that no LEXICALLY repeated walk in the
suite is expensive today, and says nothing about interprocedural ones beyond the single instance
already found and fixed. No ratchet movement; no source change.

## V-1937 — a months-old privacy finding, re-verified unchanged, and already correctly fenced (2026-08-27)

Ranking services by size against how little this log says about them put
`account-deletion-purge-sweeper.ts` at 512 lines and one mention. The ranking was misleading —
**18 test files** cover purge/deletion, including arm-independence and tenant-scope guards — but the
one mention was the lead: V-1134, in the archive, recorded that _"`account-deletion-purge-sweeper.ts`
never touches avatars. So avatar bytes survive both the DELETE and full account deletion"_, on a
**public-readable** bucket.

**Re-measured, because an archived finding is a claim about a tree at a date.** All three legs hold:

| leg                                     | now                                                               |
| --------------------------------------- | ----------------------------------------------------------------- |
| an avatar sweeper exists                | **no** — zero files, and zero avatar route registrations anywhere |
| the purge sweeper touches avatars       | **no** — `avatar` appears **0** times in it                       |
| the key still targets the public bucket | **yes** — `avatars/${accountId}.${ext}` in `lib/r2.ts`            |

Controls: 58 avatar mentions in `routes/account-me.ts` and 4 in `lib/r2.ts` prove the greps reached
their files, and `deleteObject` IS used four times elsewhere — profiles, trash purge, orphan sweep —
so the capability exists and is simply not applied to avatars.

**It is not an unnoticed gap. It is a recorded open decision, in the source.** `lib/config.ts:96-104`
carries V-1134's finding verbatim and states the question is live: _"D-2 — whether avatars belong on
a public bucket, and whether deleted avatars should be reaped rather than left in place — is still
open, and it cannot be decided against a description of this bucket that omits them."_ That is the
owner's call, like W-10, and the comment exists precisely so the decision is not taken against a
stale description.

**And the published promise does not contradict it.** `trust/security-overview.astro` says data is
_"permanently erased (hard delete) — profile data, sessions, captures"_: an enumerated scope, and
"profile data" here means the product's browser-profile objects, not an account picture. The DPA
separately lists "customer-uploaded avatars" among the R2 objects. So the public posture is
coherent rather than false.

**The one regression path is already closed, and finding that out is why I did not build a guard.**
The risk worth guarding is someone widening that public sentence to claim avatars are erased while
no sweeper exists. `marketing-site-pages-trust-security-overview-content-parity` pins the sentence
character-for-character _including the enumeration_ — `permanently erased\s+\(hard delete\) —
profile data, sessions, captures\.` — so adding "avatars" reds it. Its own title gives the reason:
the hard-delete scope must survive. A guard from me would have duplicated that.

**Boundary:** this verifies the three factual legs and the pinning at `b3a205c19` by reading source
and tests; it does not evaluate whether leaving avatars in place is the right posture, which is D-2
and not mine, and it does not check the R2 bucket's actual ACL — "public" here is what `lib/config.ts`
and `lib/r2.ts` call it, not something I queried. No source change; no ratchet movement.

## V-1938 — the summary cap the file declared and four of five branches ignored (2026-08-27)

`services/agent-intent-result.ts` maps a harness result into the customer-facing `IntentResult`.
Zero mentions in this log; ranked by size against coverage, it was the purest unaudited surface on
the list. Its header states the property exactly: _"Result summaries and failure reasons cross two
customer-data boundaries: the message response and the encrypted agent transcript … Harness output
is internal, but it can reflect a final redirect URL, WebDriver diagnostic, or page-controlled text.
Bound it before redaction."_

`safeResultText` implements that — bound to 4096, `redactText`, bound to `RESULT_SUMMARY_MAX_LENGTH
= 512`, all surrogate-safe. **It was called on two paths out of six.**

| summary branch                              | sanitised |
| ------------------------------------------- | --------- |
| `navigated to ${url}` (harness output)      | yes       |
| harness `errorMessage`                      | yes       |
| `tapped ${intent.selector}`                 | **no**    |
| `typed into ${intent.selector}`             | **no**    |
| `pressed ${intent.value}`                   | **no**    |
| `condition met: ${intent.selector} visible` | **no**    |

**The unsanitised four are not harness output, which is why they read as safe** — they interpolate
the intent the server dispatched. That is the right distinction, and it does not hold: `AgentIntent`
declares `selector: z.string().optional()` and `value: z.string().optional()` with **`.max(` appearing
zero times in the whole file**, and the only transitive bound is the dispatch schema's
`HARNESS_SCRIPT_MAX_CHARS = 262_144`. A selector is customer- and decomposer-supplied, so a summary
of **512× the cap this module declares** could reach the message response and the durable encrypted
transcript, carrying whatever the selector carried.

Verified nothing closes it downstream: `IntentResult.summary` is a bare `z.string()` in api-types
(the `.max(4096)` nearby is a different, session-level summary), and the transcript writer does not
touch it.

**The file's own tests state the intent and confirm the gap.** One arm redacts credentials from a
returned redirect URL "before customer and transcript boundaries"; another caps an over-long harness
message. The selector arm asserts only that the selector is _included_.

Fixed at the **boundary**, not per producer: `intentResultToCustomer` now wraps `summarize(...)` in
`safeResultText`. One site covers every branch including ones added later — the same fail-safe
direction this file already argues for in `REPLAY_SAFE_INTENT_KINDS`, where listing the safe kinds
means a new kind is effectful until someone says otherwise. It is idempotent for the navigate path
that already sanitises internally.

⛔ **My first proving fixture asserted nothing.** I wrote a fake token, `ds_live_sk_0123456789abcdef`,
and the arm failed — not because the fix was wrong but because the redactor's body class is
`[A-Za-z0-9]{12,}`, no underscores, so `sk_` immediately after the prefix breaks the run. A
made-up secret shape tests the fixture, not the redactor. Corrected to a real minted shape, the arm
asserts both halves — the cap and the `[redacted]` substitution. Mutation-proven: reverting the
source kills exactly this arm and no other.

**Boundary:** this bounds and redacts the SUMMARY string; it does not bound `AgentIntent.selector`
itself, which remains `z.string()` in api-types and is still admitted at 262_144 by the dispatch
schema — narrowing that is a published-contract change and not this fix. `it(` 18 → 19 in an
existing file, so no ratchet moves.

### ⛔ Two self-inflicted failures while landing this, both caught by post-conditions

**1. My own cleanup trap reverted the fix after I reapplied it.** The mutation proof ran
`trap 'cp <snapshot> <source>' EXIT` so the pre-fix source would be restored however the command
ended. Inside that same command I proved the arm red, then reapplied the fix — and **the trap fired
at command exit and overwrote it**. The test then passed (19/19, measured before exit), and the
source silently went back to unfixed. A trap that guarantees a clean state also guarantees it
against the state you meant to keep; the reapply has to happen in a later command, or the trap has
to be cleared first.

**2. The commit captured four of a peer's files.** I staged three explicit paths, and between the
`git add` and the `git commit` A2 staged their own in-progress updater work; `git commit` takes the
index, not my pathspec, so it swept in `apps/gui-client/**` — which my standing rules forbid
outright. Undone with `git reset --soft HEAD~1` (nothing was pushed), their four files unstaged with
`git restore --staged apps/gui-client`, and their content verified **byte-identical** by SHA-256
before and after, with their `M/M/M/??` working-tree status restored.

Both were caught the same way: a **post-condition on the artefact**, not a derivation from the
action. `grep -c 'safeResultText(summarize'` returned **0** after a commit I believed had landed the
fix, and `git show --stat` listed six files where I had staged three. Neither "the edit succeeded"
nor "the commit succeeded" would have revealed either. The orphaned commit `9023c4fc8` confirms it:
it carries the new test and **not** the source change, so the arm proving the fix was committed
against code without it — a state the pre-commit hook cannot see, because it runs typecheck and
lint, not the suite.

**The rule that generalises: `git add <paths>` does not scope `git commit`.** With a peer writing in
the same tree, the index is shared mutable state between those two commands. Verify
`git diff --cached --name-only` immediately before committing, and read `git show --stat` after.

## V-1939 — two agents, one machine, two gates: the load rule needed a second reading (2026-08-27)

The gate validating V-1938 came back **3 failed of 32163**, and none of the three is that change.

**Attribution first.** Two failures are `gui-client-src-tauri-content-parity`, which pins
`tauri.conf.json` and `Cargo.toml` verbatim; A2 changed `src-tauri` at 07:50 and bumped the app to
0.1.5 at 07:56, so the pins are theirs and now stale by their own edit. The third,
`db-webhooks-force-rotation-selection-drizzle`, is a real-Postgres integration test I have never
touched — **0** webhook paths across my commits — and it **passes 6/6 in isolation**. My own change
survived intact at HEAD after A2 committed on top: the fix and its arm both still count 1.

⛔ **My load pre-flight passed and was still wrong, because load is a snapshot.**

```
inner pre-flight: load=4.26/10      ← measured, gate launched
during the run:   26.27 → 30.90 → 37.93
load after:       27.89 24.21 16.63
```

V-1934 added `uptime` before a gate precisely so a red would carry information. It does — but only
about the moment of launch. A2's message says plainly _"Gate is running on my push now"_: we started
full suites minutes apart on one 10-core machine, and 4.26 became 37.93 while mine ran. **A
pre-flight cannot see a peer's gate that has not started yet**, and the thing my rule was written to
prevent happened anyway, one level up.

The correction is not a bigger threshold. It is that **the load reading belongs with the RESULT, not
only with the decision** — a red is uninformative if load was high at any point during the run, and
only the after-reading can say that. `verify-suite` finishing at load 27.89 is the datum that makes
this red unreadable, and I captured it only because I happened to print it.

**What actually validated the change**, since the gate could not: 3236 of 3238 files passed, the two
failing files are A2's pins, and the third passes alone. That is enough to say V-1938 did not break
anything, and not enough to call the suite green — a distinction worth keeping separate.

⭐ **A peer supplied a better fix than mine for the index collision.** V-1938 recorded that
`git add <paths>` does not scope `git commit`, and proposed verifying the staged set before and
after. A2 hit the same collision from the other side — their commit failed with _"cannot lock ref
HEAD"_ because mine moved under them — and their answer is better: **`git commit -- <paths>`** takes
the working-tree state of exactly those paths and ignores the index entirely. Mine detects the
breach; theirs makes it impossible. Adopted.

**Boundary:** the attribution rests on which files each failing test pins and on one isolated re-run
of the webhooks test at load ~17, so it establishes those three failures are not V-1938's and does
not establish the suite is green at this commit — that needs a run neither agent is competing with.
No source change; ratchets unchanged at 3062/3238.

## V-1940 — the decomposer's bounds, and my own token sweep accusing the one it enforces tightest (2026-08-27)

Closing V-1938's stated boundary from the upstream side: that fix bounds the SUMMARY, and left open
what actually reaches it. `AgentIntent.selector` is a bare `z.string()` in api-types and the dispatch
schema admits **262_144**, but intents originate in the decomposer, and the decomposer is the
narrower gate.

**It bounds every field it emits, and rejects rather than truncates:**

| action             | field            | limit              | mechanism                                             |
| ------------------ | ---------------- | ------------------ | ----------------------------------------------------- |
| `tap`              | selector / value | 4096 / 512         | `assertStringWithinLimit` — throws                    |
| `type`             | selector / value | 4096 / 10_000      | `assertStringWithinLimit` — throws                    |
| `press`            | value            | **20**             | inline guard `i.value.length <= 20`, drops the intent |
| `wait`             | selector         | 4096               | `assertStringWithinLimit`                             |
| `navigate`         | url              | 8192               | `assertStringWithinLimit`                             |
| `scroll` / `swipe` | —                | no strings emitted | —                                                     |

Also bounded upstream of those: `MAX_ANTHROPIC_RESPONSE_BYTES = 64 * 1024`, `MAX_PLAN_INTENTS = 8`,
`MAX_OBSERVATION_CHARS = 20_000`.

⛔ **My detector accused `press`, the most tightly bounded field in the file.** I swept for
`assertStringWithinLimit` per action arm and reported `press` and `scroll` as unguarded. `press`
caps its value at **20 characters** — a key name — through a filter condition rather than a throwing
assert, and `scroll` emits no string at all. Sweeping the token (`assertStringWithinLimit`) rather
than the property (is this field bounded) produced a two-item list in which the first entry was the
strictest bound in the file. That is the third standing lesson, on my own analysis, for the second
time today — and the reason the entry above is a table of mechanisms rather than of call sites.

**The correction this forces to V-1938.** That entry called the gap "512× the cap this module
declares", from `HARNESS_SCRIPT_MAX_CHARS = 262_144`. That figure is the dispatch ceiling and is
correct as stated, but it is not what is reachable: the widest summary the decomposer can actually
produce is `typed into ` + a 4096-char selector, ~**4108** characters — **8×** the declared 512 cap,
not 512×. The fix stands unchanged, and its justification is 8×, not three orders of magnitude. A
severity I overstated by citing the outer ceiling instead of the reachable one.

**Boundary:** this reads the decomposer's own emission path at `ba5ea6e48` and establishes what IT
can emit; recipes replay stored `intent_log`s validated against `AgentIntentSchema`, which carries no
`.max()`, so their bound is whatever the decomposer applied when the transcript was written — I did
not verify that a recipe cannot be constructed from an intent that predates a tightening. No source
change; ratchets unchanged at 3062/3238.

## V-1941 — a peer's finding, the guard that already answers it, and the 3226-item list I nearly built (2026-08-27)

A2 hit a defect worth generalising: in `gui-client-src-tauri-content-parity`, both arm **titles** said
0.1.3 while both **assertions** read 0.1.4 — a stale claim inside the file whose job is catching stale
claims. I had the mirror image hours earlier: a roster raised 21 → 33 with every assertion updated
and a comment thirty-seven lines above still saying 21. Two directions of one asymmetry: **a parity
file's assertions are checked by running it; its prose is checked by nobody.**

**My first instinct produced 3226 false positives.** The obvious guard — every number a title states
must appear in its arm's body — flags **3226 of 23373** arms, because titles legitimately name HTTP
statuses, contrast cases and RFC numbers that never appear as literals (bodies use constants, or
different representations). Unusable, and exactly V-1936's lesson: do not guard a shape whose
instances are overwhelmingly fine.

**The repo already solved this, and better.** `a-field-count-in-a-test-title-is-derived` (V-1018,
extended by V-1019) does not compare title to body — it **derives** the number, resolving
`X has N fields` against the actual `interface` or `z.object` literal. That found real drift when it
landed: `ProfileRecord` claimed 8 and has 15 — including `deletedAt`, the recycle bin, and
`sizeBytes`, the storage a customer is quoted for — `WebhookEndpointRow` claimed 15 and has 20, and
twelve more. The principle is pick a title shape whose number is DERIVABLE, then derive it.

**The coverage gap is real and currently empty.** That guard's regex requires the word `has`
(`X has [EXACTLY] N …`), so the `X = EXACTLY N values` phrasing — which is what my own admin-audit
title used — is outside it. Seventeen arms use that form. Measured against their own bodies:

|                                    | count         |
| ---------------------------------- | ------------- |
| title's N asserted in the same arm | **16**        |
| asserts a DIFFERENT number         | **0**         |
| no numeric assertion               | 1 — and sound |

The one outlier pins `format = EXACTLY 2 values (csv + json)` with
`toMatch(/format: z\.enum\(\['csv', 'json'\]\)/)`, an exact-set regex that a third value would break.
The count is pinned structurally rather than numerically; my flag was looking only for `toBe(N)`.

**So: no guard.** Extending the derived-title regex to the `=` phrasing would fire on nothing today,
and V-1936 already records what a guard with no live instances is worth. The finding is that the gap
exists, is measured, and is empty — which is what stops the next person re-deriving it.

⭐ A2's second observation is the one I would act on if it were mine to act on: that parity file
lives in `apps/server/tests/` while pinning `apps/gui-client/**`, so their full gui-client run — 257
files, 2424 tests, green — could not have caught it. A suite scoped by where the SOURCE lives does
not cover pins filed where the TEST lives.

**Boundary:** the 17-arm measurement covers `apps/server/tests` and the exact phrasing
`X = EXACTLY N (values|members|entries|kinds|actions)`; the 248 `N-value` and 102 `N values total`
matches are dominated by noise (RFC 7807 parses as 7807) and I did not triage them, so this says the
`=` phrasing is clean and says nothing about looser ones. No source change; ratchets unchanged.

## V-1942 — the dispatch mapper audited sound, and the fourth false-positive list of one shape (2026-08-27)

`agent-intent-to-dispatch.ts` is the symmetric companion to the file V-1938 fixed, so it was the
natural next target: 318 lines, one log mention. **No defect.**

**The one place it could leak, and why it does not.** Every failure `reason` it returns is a constant
string except one, which interpolates a Zod message:

```ts
reason: `${mapped.intentName} params failed harness-contract validation: ${parsed.error.message}`;
```

That matters because the params at that point carry `text: intent.value` — the customer's typed
secret when `sensitive` is set. Per V-1920 a Zod message CAN echo the value it rejected, so this is
the shape worth checking rather than assuming. Tested against the four reachable failure modes: a
too-long text, a bad strategy, an unknown key, and a wrong-typed text. **None carries the secret** —
the messages hold a length limit, the rejected _strategy_, the unrecognised _key name_, and a type
name respectively.

⛔ That first run used a MIRROR of `SendKeysParamsSchema`, which is the faithful-double trap. Checked
against the real one: `text` is `z.string().max(HARNESS_SEND_KEYS_MAX_CHARS)` and the only
value-echoing field is `strategy`, a `z.enum` whose domain is locator strategies. The conclusion
survives the correction, which is the only reason it is worth stating.

The sensitivity heuristic behind it is well built: `selectorImpliesSensitiveInput` reads only
selector metadata, never values, NFKC-normalises first, and its header names the asymmetry —
"a false negative can expose a password/OTP/card value". It is pinned by a corpus of **16** positive
selectors and **7** negatives, including `#ｐａｓｓｗｏｒｄ` in full-width characters, which is the
normalisation arm.

### ⛔ And I reported that corpus as "0 arms"

My count grepped `it(`. The file uses `it.each([...])`. That is the **fourth** list today built by
grepping for a canonical mechanism and concluding from its absence:

| grepped                   | accused                            | actually present                                             |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `assertStringWithinLimit` | `press` unbounded                  | inline `value.length <= 20` — the tightest bound in the file |
| `sessionId !==`           | trim-profile, session-readiness    | `profileId !==`; connection-local ownership                  |
| `.max(`                   | would have flagged `code`          | `regex(/…{0,127}/)`                                          |
| `it(`                     | a security heuristic with no tests | `it.each` — 23 fixtures                                      |

**It fails toward accusing the strictest code, and not by accident.** A field guarded by a bespoke
inline predicate is usually guarded that way _because_ the general helper was too loose — 20 chars
for a key name, an exact-set regex, a per-key comparison. So the sites that miss the canonical grep
are disproportionately the careful ones, and a gap list built this way is close to an inverted map of
the best code in the file. A2 hit the mirror image today — searching for an expected capability grant
and missing that CORS was the real mechanism — the same instrument error with the opposite sign.

**Boundary:** this covers the mapper's failure-reason paths and the sensitivity heuristic at
`bc6b0d0b1`; I did not exercise the harness end, so "the flag is forwarded" is a claim about what
this file emits, not about what the node does with it. No source change; ratchets unchanged.

## V-1943 — green, and the one-at-a-time protocol is what made the red readable (2026-08-27)

`verify-suite --all` at `60fb8f388`: **exit 0, 3238 files, 32147 passed, 16 skipped.** This is the
first clean full run since V-1938 landed a source change, so that fix — bounding and redacting the
intent summary at the customer boundary — is now validated against the whole suite rather than
against its own file.

**The load record, which V-1939 said belongs with the result rather than only with the decision:**

|                           | 1-min load          |
| ------------------------- | ------------------- |
| inner pre-flight (launch) | **4.38** / 10 cores |
| during                    | 18.04 → 26.76       |
| after                     | 15.74               |

Load rose to 26 during the run and it was green, because that rise is _my own_ ten-to-sixteen
workers rather than a second suite. Contrast V-1939, which peaked at 37.93 with a peer's gate running
and produced three failures that were all spurious — two of A2's own stale pins, one real-Postgres
test that passed 6/6 alone. **Same suite, same machine, same commit family: uncontended it is green;
contended it invents three reds.** That is the measurement that makes the protocol worth its cost.

The protocol itself came out of that collision and both agents now run it: announce before a full
run, hold until the other confirms, and release the slot explicitly. A2 announced at 08:11 with
`PUSH_EXIT=0`, I held through four firings of static-only work, took the slot at 08:14 and am
releasing it on this entry. Two suites that cannot both fit on ten cores are not a scheduling
inconvenience — they manufacture failures that then cost an hour of attribution each.

⭐ Worth recording as the cheapest half: **the log entry must be committed BEFORE the slot is
released.** Twelve tests read `docs/verification-log.md`, so writing it while the other agent's gate
runs corrupts their run exactly as their writes would corrupt mine. Ordering is log → commit →
release, not release → log.

**Boundary:** one green run on this machine at this commit with no peer suite competing; it validates
V-1938 and says nothing about CI, where the contention profile is different and unmeasured. Ratchets
unchanged at 3062/3238 and matched exactly by the collected count.

## V-1944 — /metrics is sound; the defect was in the note that sent me there (2026-08-27)

Audited the `/metrics` scrape route end to end after the ingress work, on the theory that a layer
recorded as inert in prod would have an unrehearsed on-path. **It does not, and the route is sound.**

`registerMetricsRoutes` is gated on `deps.metricsRegistry !== undefined` (`lib/app.ts:1259`), and the
registry is created only when a token is configured (`bootstrap.ts:587`, validated `.min(16)` at
`config.ts:331`). The route's own posture is fail-closed and does not depend on that gate holding: a
null-or-empty token throws a typed `FeatureUnavailableError` rather than serving counters, and the
authorization compare length-guards before `timingSafeEqual` so a wrong-length header yields a uniform
unauthorized outcome instead of throwing. All four arms are witnessed in
`tests/integration/metrics-scrape-end-to-end.test.ts` — no header → 401, wrong Bearer → 401,
unconfigured → 503, correct → 200 — with the challenge header separately pinned by the RFC 7235 guard.
The ON path is exercised by 21 files that construct a registry and by `buildTestApp`. No action.

**The finding is that three of the four line citations in my own note were stale, and two of them now
land on valid-looking but unrelated code.** `app.ts:906` resolves today to `'x-ratelimit-bucket'`;
`config.ts:216` to a bare `.positive()`. Neither errors when followed — they read as ordinary code and
quietly answer a different question, which is strictly worse than a citation that resolves to nothing,
because nothing is what triggers doubt. The file had also moved (`app.ts` → `lib/app.ts`), so the
obvious grep for the gate returned empty and briefly read as "the gate was removed".

**Two lexical wrappings of one citation defeated the first fix.** The repair keyed on backtick-wrapped
citations and corrected every one — while an unwrapped `bootstrap.ts:289` in the note's own description
field survived untouched, and only a post-condition sweep over _every_ `file.ts:N` occurrence caught it.
The general form is already recorded (sweep the shape, not the token); what is new is that it applies to
prose citations exactly as it applies to source, and that the description field is the easiest place to
miss because it restates the body in a different style.

Corrected all three, stamped the note with the code-side re-verification, and left the ops half open:
whether the scrape token is set in prod is an owner/ops call and outside what I verify from here.

## V-1945 — swept every line citation in my notes; the instrument was wrong first (2026-08-27)

V-1944 found three stale citations in one note, which is a population question, not a one-file fix.
Swept all 854 `file.ts:N` citations across 1279 notes against the tree. **Boundary: `.ts/.tsx/.mjs`
against driftstack-api only. The 564 `.cpp` citations belong to webkit-driftstack and are unchecked.**

**The first detector was wrong, and its control could not see the bug.** The citation regex excluded
`.` from the filename class, so every multi-dot name — which in this repo means every `*.test.ts` and
`*.spec.ts` — was captured from its last dot onward: `a-thing.test.ts` became `test.ts`,
`agent-decomposer-claude.ts` became `decomposer-claude.ts`. Those resolve to nothing, so the sweep
reported 85 missing files. **The control passed because I built it from `app.ts`, which has one dot.**
A control drawn from the convenient case tests the detector against the shape that was never at risk;
re-proving it on `a-thing.test.ts` failed immediately. Corrected, the 85 fell to 16 — 69 were mine.

**Of the 8 distinct survivors, 6 are naming shorthand or pre-monorepo paths whose subject is alive**
(`sessions-livekit-token.ts` for `routes/agent-sessions-livekit-token.ts`, `control-plane/src/` for
`packages/`). **Only 2 point at subjects that were retired**, and those are the ones that mislead:
`routes/saved-proxies.ts` (retired in `fc8fb3de2`; `openapi.ts` now records the /v1/proxies surface as
intentionally absent) and `pages/sessions.astro` (deleted in `ba1a9d270` with the whole operational
surface). The second is the worse shape — its note ends "don't wire, don't remove, don't
re-investigate," a verdict that was right about an implementation that no longer exists and that would
tell whoever rebuilds that surface its dead anchors were deliberate. Both corrected in place.

**What this sweep does NOT establish, and the number invites the opposite reading:** 638 citations came
back in-range, and in-range is not correct. The citation that started V-1944 was in range — `app.ts:906`
resolves today to `'x-ratelimit-bucket'`. This bounds only whether a coordinate resolves, never whether
it still means what the note says it means. The semantic half stays unmeasured, and a clean census here
is not evidence about it.

Also checked, since the search surfaced it: stale compiled `dist/routes/saved-proxies.js` for the
retired route is local residue only — dist is gitignored and untracked, that build is from Jun 10, and
the sole reference in the compiled entrypoint is a comment. Says nothing about the prod host, which I
cannot see from here.

## V-1946 — the semantic half: a lead generator, not a census (2026-08-27)

V-1945 left the semantic half of the citation sweep unmeasured — whether a coordinate that resolves
still _means_ what the note says. Attempted it: pair each citation with the identifier quoted beside it
and ask whether that symbol appears within six lines. Controls passed on all four cases, including the
real known-positive (`app.ts:906` + `registerMetricsRoutes` → correctly "symbol exists, but not here").

**It flagged 158 of 186, about 85%, and that number is the instrument.** A stale rate that high across
a corpus this heavily maintained is not credible, and the mechanism is visible on inspection: the
heuristic takes the _next_ backticked token after a citation, which is frequently not the symbol at
that line. Hand-read three. `middleware/auth.ts:144` is a pure false positive — it is exactly the
`requireTierFeature(ctx.account.tier, 'apiAccess')` its note claims, and the heuristic had paired it
with the enclosing `requireAuth`. The other two are real coordinate drift with the subject alive
(`AccountsAdminService` moved from `app.ts:861` to `:1106`). n=3. **So this stays a lead generator and
is recorded as one; the semantic rate is still unmeasured and 85% is not it.**

**As a lead generator it earned its keep.** It surfaced a note carrying a `[HIGH] ⬜ OPEN` WireGuard
IPv6 SSRF bypass — an unbracketed `fc00::9999` chopped to `fc00:` by a last-colon port heuristic, which
then classifies as safe. **Fixed at HEAD and witnessed by name:** `vpnEndpointHost` now returns early
on `isIP(e) === 6` with the case named in a comment, only strips a trailing `:digits` when the head has
no further colons or is itself a valid IPv6, and `webhook-target-guard.test.ts:263` asserts both
`fc00::9999` and `fc00::9999:5182`.

**The instructive part is how close I came to reporting it as live.** The note's own
`STATUS UPDATE: all 8 were FIXED — the ⬜ OPEN markers are STALE` sits ten lines below the marker I
matched, outside the 230-character window I printed around the citation. **A grep for a status marker
finds the marker, never the retraction that follows it, because they are different lines.** What
prevented the wrong report was ordering, not care: I verified against source before trusting the note,
so the code answered first. That ordering is the whole defence, and it is cheap.

Recorded two rules that generalize past this sweep: cite the symbol alongside the line, because the
symbol re-finds a drifted coordinate in one grep while a bare number that lands on plausible code
answers a different question silently; and a note recording an OPEN vulnerability expires exactly like
one recording a clean verdict, and is the more dangerous of the two stale, because it carries the
authority of a security finding while sending someone to fix what is already fixed.

## V-1947 — eight stale HIGHs re-verified, and a CORS escalation that did not happen (2026-08-27)

**Eight `[HIGH]`/`[MED]` findings carrying `⬜ OPEN` markers are all fixed at HEAD.** The note holding
them already said so, in a status line ten lines below the markers — but a grep for the marker finds
the marker, never the retraction, so the markers are now flipped in place. Verified individually rather
than on the strength of that line: `dispatchSessionEndOnClose` binds `targetNodeId = nodeId ?? null`
and reaches `findAnyWithLivekit()` only with no dispatched row; `vpnEndpointHost` returns early on
`isIP(e) === 6`, pinned by name against `fc00::9999` and `fc00::9999:5182`; `applyIpnStatus` transitions
inside `repo.withOrderLock`; `fleet-node-auth.ts` carries `'future_iat'` with a 300s lifetime and 60s
skew; the cross-node spoof check is factored into `isCrossNodeSpoof` across five call sites with its own
test — stronger than the per-site fix prescribed; the Go SDK retry loop documents the drift and pins it;
the per-account agent-session cap is wired. **Two of the eight had moved file (`fleet-node-auth.ts`
lib→services) or line (`:119`→`:169`), and both were still found in one grep because the note named the
symbol.**

**The CORS finding's own escalation condition is unfired, so it stays MEDIUM.** That note says prod
echoes any origin with credentials, and becomes CRITICAL "if a data route ever accepts the session
cookie." No cookie plugin exists — `@fastify/cookie` is not a dependency and nothing registers one, so
`request.cookies` is never populated. `middleware/auth.ts` reads only `authorization` and the SSE
`?ds_token=`. The one cookie the server reads is the PKCE flow cookie: `HttpOnly; Secure; SameSite=Lax`,
path-scoped, cleared after use, nonce-bound. CORS cannot reach it — SameSite is not overridden by CORS
and HttpOnly blocks JS reads.

**The near-miss inside that check is the part worth keeping.** Having verified the server, I was about
to record that `lib/app.ts`'s `credentials: true` comment describes a cookie session that does not
exist — true as far as it goes, and one step from someone removing the setting. Reading the client
side: the dashboard keeps its token in `localStorage` as `ds_web_session_token`, so there is no cookie
session; **but `credentials: 'include'` is deliberate and annotated as the PKCE cookie round-trip, so
`credentials: true` is required.** The comment names the wrong reason for a correct setting. **A comment
defect and a config defect are indistinguishable from the server side alone.**

**One of my own ten guards has the vacuity hole I went looking for after a peer shipped an inert
capability.** `a-void-switch-over-a-finite-union-must-be-exhaustive` asserts `findOffenders()` is empty
over a real-tree walk that skips anything outside `SRC_DIR`; a prefix drift, a misconfigured program
root, or a directory move each yield `[]` and a green arm. Its synthetic arms analyse hand-built source,
so they prove the matcher fires and say nothing about whether discovery found a file — and my own
comment above them calls those arms "why the arm above is worth anything," which is half true and reads
as fully true. **Three of the four the crude grep flagged were false positives with real floors** — an
equality against a frozen 39-element list, a recorded roster of six, and a disk-vs-roster assertion that
is the strongest floor of the set. Fix drafted with a census floor (`filesScanned`, and
`finiteUnionSwitches > 0` as the load-bearing half) and three mutations that must redden it; not applied
yet because the suite was held by a peer.

## V-1948 — the guard that could pass over an empty tree now has to say what it saw (2026-08-27)

`a-void-switch-over-a-finite-union-must-be-exhaustive` asserted `findOffenders()` was empty over a walk
that skips anything outside `SRC_DIR`. **`[]` is the pass condition, and an empty walk produces it as
readily as a clean tree.** Its two synthetic arms root the program at an injected file, so they prove
the matcher fires and cannot see discovery at all — while the comment above them read "the two arms
below are why the arm above is worth anything," which is half true and reads as fully true.

`findOffenders` now returns a census alongside the offenders, and a new arm floors it: `filesScanned`
above 270 and `finiteUnionSwitches > 0`. **Measured, not guessed** — the walk sees 342 files and 25
finite-union switches today, so the floor sits far under ordinary growth and far above a collapse. The
switch count is the load-bearing half: `filesScanned` alone still passes if the checker quietly stops
resolving unions, which would make every switch look non-finite.

**Three mutations, and the informative one is the survivor.**

- **Drifting `SRC_DIR` reddens the census — and leaves the original offender arm GREEN.** That is the
  defect demonstrated rather than asserted: discovery collapses 342 → 0, `offenders` is `[]`, and the
  old assertion passes. **This mutation is caught by the census arm and by nothing else.**
- **Forcing `finiteUnion = false` reddens the census and the synthetic positive arm**, correctly — a
  broken matcher is visible from both sides. So the two arms are complementary, not redundant.
- **Restricting the program roots to a single file SURVIVES, and should.** I predicted it would fail
  when I drafted the fix. Measured instead of assumed: one root still yields `filesScanned` 331 of 342
  and `finiteUnionSwitches` 25 of 25, because a TypeScript program is transitively closed over imports.
  **Coverage of the actual subject is fully preserved, so a floor that fired here would be wrong.** The
  real threat is the prefix drift, not the root list — which I had backwards in the draft.

tsc clean via `tsconfig.test.json` (the bare config excludes tests). No ratchet move: this adds an arm,
not a file.

## V-1949 — the corpus already floors 81% of these, and my regex was worse than its convention (2026-08-27)

> ⛔ **RETRACTED IN PART — the 81% in this heading is wrong, and so is the 88% it was corrected to.
> See V-1951.** The idiom classifier fails its own control: a known-unfloored file classifies as
> floored because its SYNTHETIC arm asserts a non-empty list. **The floored fraction is unmeasured.**
> Everything else in this entry — the three detector versions, the false positives, the 93-file
> residue — stands. This pointer sits here because a grep for `81%` finds the claim and not the
> retraction: a marker and its correction are different lines.

Having found one vacuity hole in my own guard (V-1948), swept the corpus for the shape: a test that
reads the real tree and asserts emptiness, with nothing establishing the scan was non-empty.

**The instrument needed three versions and the controls killed the first two.** The control pair is the
strongest available — the same guard before and after V-1948's fix, which must classify differently.
A file-level detector called the pre-fix version FLOORED, because its _synthetic_ arm asserts against a
non-empty list: **a floor on a fixture arm is not a floor on the tree-walk arm, which is exactly the
defect being hunted, reproduced inside the detector for it.** A per-arm version then failed the other
way, flagging both known-good guards, because **a floor need not live in the arm it protects** — both
put theirs in a separate arm. Only the hybrid passed all four.

**The population depends on the instrument, and saying so is part of the result: 347 files under the
arm-parsing version, 514 under the file-level one.** The arm parser balances parentheses and breaks on
regex literals and strings containing them, so it silently under-collected.

**Of 514 tree-reading emptiness tests, 421 — 81% [RETRACTED, see V-1951] — already declare a floor in the codebase's own
idiom** (`non-vacuous:`, `CRITICAL the scan finds …`, `toBeGreaterThan`, `not.toHaveLength(0)`). Two
hand-reads of my regex's "risks" were both false positives carrying arms named exactly that: _"CRITICAL
the scan finds the mints AND the logger calls, so an absence is measured against a real set"_ and
_"non-vacuous: admin force-actions explicitly opt into null scope"_. **The convention already in the
tree is a better detector than the assertion regex I brought to it** — matching how this codebase says
a thing beats inferring it from shapes.

The 93 without the idiom are mixed, not a defect list. Sampled two: one reads a single built file, where
a missing file throws rather than passing empty, so the failure mode does not apply; the other genuinely
walks a page directory with two `toEqual([])` and no count assertion at all. **So the residue needs
hand-reading per file, and I am recording it as a candidate list, not a finding.** I checked whether
that page directory had shrunk under the operational-surface deletion and my before/after command only
listed the top-level tree, missing nested page dirs — the comparison was invalid and is not reported.

## V-1950 — an assertion that could not fail, guarding a comment that was wrong (2026-08-27)

Chasing the vacuity shape into the other apps, the useful discriminator turned out to be **file versus
directory**: a test that names a missing FILE is almost always asserting its ABSENCE deliberately
(`expect(existsSync(PAGE)).toBe(false)`, "mirror page stays deleted"), while a walk names a DIRECTORY.
My first guard asserted "every path a test names still exists" and immediately flagged 30 intentional
absence tests — **a large, plausible finding that was entirely the detector's premise being wrong.** It
was deleted rather than committed.

With the discriminator applied to 3300 declared roots: **zero missing directories, and exactly one
empty one** — `apps/admin-panel/src/pages/accounts`, which is untracked local cruft and therefore absent
on a fresh checkout. The test naming it does this:

    const detailPage = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/accounts');
    expect(detailPage).toBeTruthy(); // the directory housing [id].astro

**`resolve()` returns a string and never touches the disk, so this cannot fail** — not "does not fail
today", cannot. And its comment names an `[id].astro` this app does not use: `/accounts/:id` is served
by a Cloudflare Pages 200-rewrite to a static shell, which `astro.config.mjs` documents ("no Worker/SSR
adapter is required"). **So the line asserted nothing, about a mechanism that was not the mechanism.**

The route itself is sound and well covered — eight tests exercise the detail page — so this is a defect
in the guard, not in the product. Replaced with the assertion it meant: the `_redirects` rule for
`/accounts/:id` must exist, and the shell page it points at must exist. **Mutation-proven by removing
the rewrite rule: the arm reddens with "every row href in this page 404s without it", where the old
assertion passed unchanged.** `_redirects` is a production file and was restored byte-identical from a
snapshot taken before the mutation.

**The mechanism behind the whole sweep, now stated precisely: 89 test files use a walk helper beginning
`if (!existsSync(dir)) return out;`.** That swallows a missing root and returns `[]`, which is the pass
condition for every emptiness assertion downstream — so a moved source tree makes those guards quiet and
green at the same instant. Nothing has drifted today (zero missing directories), so this is a recorded
hazard with a measured population, not an open defect. Making 89 helpers throw instead of swallow is a
larger change than I should make unilaterally.

## V-1951 — retracting my own corrected number, and capping the debt (2026-08-27)

**Retract both the 81% and the 88% from V-1949.** I corrected the first figure after finding the idiom
regex omitted `toHaveLength(<n>)`, then applied the control I had been recommending all day and the
classifier failed it: the pre-fix version of the guard I repaired in V-1948 — a known-unfloored file —
classifies as FLOORED, because it contains `toEqual([...])` with a non-empty list **in its synthetic
arm**. That is exactly the defect the number was measuring, and a file-level regex cannot see the
difference. **So the figure counts as protected the very population it was built to find, and errs
optimistically.** The floored fraction is unmeasured; I would rather record that than a third number.

**A correction is not a control.** I trusted 88% more than 81% _because_ I had corrected it — but the
revision fixed a missing alternative in the pattern and never asked whether the classifier could
separate the two cases at all. One known positive would have failed it at either value.

**What survives is what was enumerated or read, not sampled.** V-1950 said the 30 missing FILE paths
were "all absence tests" on a sample of two; enumerated all 30 — **26 assert absence via a named const,
and the remaining 4 do the same inline** (`expect(existsSync(resolve(REPO_ROOT, 'vitest.workspace.ts'))).toBe(false)`,
and three `robots.txt` deliberately absent from the private apps). **30 of 30 intentional**, so the
file-versus-directory discriminator holds at full enumeration rather than on the two I happened to open.

Two further "cannot fail" shapes swept clean, each with a passing control: **tautological length
comparisons** (`.length` ≥ 0) — zero; **always-true matchers** (`toContain('')`, `toMatch(/.*/)`) — one
hit, read, and it is correct code. `mfa-encryption-key-shared-cross-source-invariant` maps four modules
to their AAD purpose with `m?.[1] ?? ''` and asserts `.not.toContain('')`, so **a regex that stops
matching produces the identical red as a missing AAD purpose.** That is the inverse of every instrument
failure today: the fallback is wired to the alarm rather than to a clean-looking result.

Capped the walk-swallowing debt at its measured 89 rather than rewriting it. **A ceiling, not an
equality — the population must be free to shrink.** Mutation-proven both ways: adding a new swallowing
helper reddens the ceiling (90 > 89), and breaking the guard's own walker reddens the FLOOR **while the
ceiling stays green**, which is the point — a ceiling over an empty scan passes for the same reason the
guards it polices do.

Classified my 13 apps/server members for the follow-up: all but one name a source tree that is
git-tracked and present on a fresh checkout, so making those helpers throw is safe. The exception reads
`dist/`, which is gitignored and legitimately absent — **skip is correct there, and the count is a debt
marker, not a defect list.**

## V-1952 — the ceiling counted the wrong unit, and I edited a file off a dead list (2026-08-27)

**Two errors of mine, both caught by proofs rather than by review.**

**The ceiling from V-1951 counted FILES when the population is OCCURRENCES.** A peer's observation — a
population expressed in one unit and enforced in another — applies to it directly: two files carry more
than one swallow site (3 and 2), so **a file already inside the population could gain another occurrence
with the count unchanged.** Switched to occurrences, measured at **92 across 89 files**. Mutation-proven
in the form that justifies the change: adding a second site to an already-counted file yields
`93 across 89 files (ceiling 92)` and reddens — **the file count stays 89 throughout, so the previous
version could not have seen it.**

**The second error is worse and produced a commit-shaped near-miss.** Continuing the remediation, I
picked `public-route-has-a-consumer-invariant`, added a non-vacuity arm, and mutation-proved it by
vanishing the walk root — **and the proof showed three arms reddening, one of which I had not
written.** The file already had `it('CRITICAL the scan found the route surface and a consumer
corpus…')` flooring both corpora and asserting a known member, `routes).toContain('/v1/sessions')`.
**My addition was a duplicate of a better arm.** Reverted byte-identical.

**How I chose a target that did not qualify: I read it off a list my own correction had already
invalidated.** An earlier sweep printed 44 "genuine walkers"; I then corrected the classifier and
re-ran, and the corrected run reported **`apps/server residue: 0`**. Both sat in the same scroll-back
looking equally authoritative. **A correction retracts the NUMBER and leaves every artifact derived
from it in place** — the stale-marker problem one level up, a list and its retraction in different tool
calls rather than on different lines. The cheap guard is to re-confirm a target still qualifies before
editing it; one grep would have shown the existing arm.

**Consequence for the scope I proposed: it was sized from that dead list.** apps/server residue is
genuinely zero — my 13 files already have floors or are correct as they stand. The peer applied the
same check to their share and found **13 of 28 already floored**, so that side is 15 files rather than 28. **The remediation is roughly half what both of us estimated, and neither estimate came from
counting the thing being remediated.**

## V-1953 — one Cyrillic character evades the agent's confirmation gate (2026-08-27)

Mined the source for stated gaps rather than hunting fresh, and `services/agent-consequential-action.ts`
names one directly: **"RESIDUAL: cross-script homoglyph substitution (Cyrillic 'е' for Latin 'e') is NOT
folded by NFKC — caught by the v1.1 LLM-semantic classifier, out of scope for this conservative v1.0
keyword matcher."**

**The delegation does not resolve. There is no v1.1 classifier** — the only files matching
semantic/LLM-classifier vocabulary are `agent-consequential-action.ts`, its dist build and its test.

> ⛔ **CORRECTED.** This first read "the only occurrences of 'v1.1' are that comment", which is false —
> **52 files contain it.** A peer checked and narrowed it. The conclusion stands on the vocabulary
> search above; the string count never supported it. **A supporting claim cheaper to verify than the
> finding is the one that goes unchecked**, because the scrutiny lands on the headline. And the source
> itself is honest — it says RESIDUAL and "out of scope for this conservative v1.0 keyword matcher".
> **The accurate defect is one clause: a deferral to a version that was never built** — weaker than
> "covered elsewhere", and the weaker true claim is the one to hand an owner.
>
> ⛔ **NARROWED AGAIN, and this is the version to use.** "Never built" overstates it: **v1.1 is a real,
> documented scope**, referenced in `ai-b2b-harness-executor-design.md`, `ai-b1b-activation-design.md`
> and `byok-anthropic-key-storage-design.md`, with ~11 source sites deferring to it consistently. That
> is ordinary roadmap deferral, not a phantom. **What survives is only this: the gap is OPEN TODAY,
> measured, and reachable from attacker-controlled page text.** Whether to pull the fix forward of v1.1
> is a scheduling decision, not a correction of a false claim. Three successive narrowings of my own
> finding — "covered elsewhere" → "deferral to a version never built" → "open today, deferred to a real
> future release" — and each narrowing came from checking one more thing I had assumed. `classifyConsequentialAction` is the sole gate, wired through
> `consequentialHalt` in `services/agent-executor.ts:143` and applied at two dispatch sites. **So the
> residual is uncovered today rather than covered elsewhere**, which is a different claim from the one the
> comment makes.

**Measured, with controls.** `consequentialHalt` is what stops an agent before a purchase, payment or
account deletion to wait for human approval, and its input is a selector or value read off whatever page
the agent is browsing — **attacker-controlled text**. `Buy Now`, `place order`, `#buy-now` and
`complete purchase` all halt. **`Bуy Now` (U+0443), `plaсe order` (U+0441) and `#bуy-now` do not** —
each differs from a form that fires by exactly one character.

**My first probe was wrong and the control caught it.** It omitted `kind: 'interact'`, so the ASCII
control returned false alongside the Cyrillic cases — a uniform negative that would have read as "the
gate never fires". **An all-negative result with no positive control is indistinguishable from a
malformed fixture**, which is why the guard carries a fourth arm proving each homoglyph string is one
substitution away from one that halts.

**I wrote a 70-line parallel guard before checking for existing coverage, and eslint caught it only by
accident.** A bad cast failed the pre-commit hook; fixing the import led me to
`agent-consequential-action.test.ts` — **174 lines and ten arms already covering this matcher**,
including zero-width, bidi, fullwidth and the whole Default_Ignorable class, plus a precision arm and an
accent-preservation arm. Two of my three arms duplicated it. **The genuinely new thing was one arm.**
Deleted the parallel file, reverted the ratchets it required, and added two arms to the file that was
already there — the residual itself, and a control proving each homoglyph string is one substitution
from a form that fires.

**Mutation-proven as a live specification:** applying a confusables fold reddens exactly the residual arm
and leaves **all eleven** others green, so the proposed fix regresses no existing coverage. Source
restored byte-identical.

> ⛔⛔ **CORRECTED — "demonstrated to close the gap" was WRONG, and this is the sharper finding.** The
> fold I mutated with closed **one of the three** strings. `plaсe order` flips via `с→c`; both `у`
> strings do NOT — `Bуy Now` folds to `Byy Now` under the canonical skeleton (Unicode maps U+0443 to
> `y`, but the attack uses it in the `u` slot) and still misses. **The residual arm asserts three
> strings, and vitest fails an arm on the FIRST failing expect, so it reddened on `plaсe order` and
> never evaluated the other two. I read one red as three.** An arm that bundles N cases reports the
> same red whether 1 or N fail — the all-or-nothing shape, inside the proof used to certify the fix.
> A peer caught it independently. **Split the arm one string per assertion**, so partial coverage is
> legible instead of collapsing to a boolean.
>
> ⭐ The threat model was also backwards in my write-up. I picked `Bуy Now` because U+0443 renders like
> a Latin `y`, making it look like nonsense — a poor attack string by a visual-deception model.
> **Nobody is looking: the agent matches text and dispatches.** The attacker is free to choose any
> substitution that breaks the match, so the fold must generate every plausible skeleton for an
> ambiguous character rather than the single canonical one. **"Confusable" imports a human observer who
> is not present.**

**Fourth time today the tree already had it** — after the `toBeGreaterThan(2000)` census floor, the
existing non-vacuity arm in `public-route-has-a-consumer-invariant`, and a peer finding the same. The
lesson I recorded hours earlier — grep the concept before building the instrument — would have found
this in one command, and I did not run it because adding a test did not feel like an investigation.

**Not fixing it here.** Folding confusables changes a security-relevant matcher on an outward-facing
agent-safety path, and the direction is favourable but not free — over-matching costs an extra
confirmation, under-matching is the vulnerability. That is the owner's call, and the guard now makes it
a one-line decision with the test already written.

## V-1954 — I refuted my own second finding before it reached the owner (2026-08-27)

V-1953 surfaced two items on the consequential-action gate. **Only one survives.**

**Retracted: approval target-binding.** I reported that an approval granted for one element could be
consumed by a different same-phrase element, because the signature is `category:matchedPhrase` and does
not name the target. **The mechanism is real and a test asserting it would have passed** — hand-build a
`Set` with one signature, call the gate twice with same-phrase taps on different selectors, and the
second consumes the first's approval.

**It is not reachable.** `ControlPlaneAgentExecutor.execute` iterates `args.plan.intents` in plan order
and **returns on the first halt**. So the sequence is: halt at the first unapproved consequential tap →
customer approves → the same plan re-runs from the start → the first same-phrase tap consumes the
approval, which is deterministically the tap the customer was shown. Cross-consumption needs the plan's
intent ORDER to differ between confirmation and re-run, and nothing I found produces that.

**What caught it was writing the refutation conditions before building the reproduction.** One of them
was "check where the approval Set is constructed and how long it lives — the whole claim depends on one
Set outliving a single intent." That read ended it. **Had I written the test first it would have gone
green**, because the mechanism is real in isolation, and I would have shipped a passing reproduction of
something production never reaches.

⛔ **A green test cannot separate a mechanism from a reachable defect, because it constructs the
preconditions itself.** The homoglyph finding has both — the gate misses those strings on input it
genuinely receives from page content, so mechanism and reachability are one observation. This one had
only the mechanism, and I described it in language that implied the other.

**Also corrected: a supporting claim in V-1953 that I never ran.** I wrote that the only occurrences of
`v1.1` in the tree are that comment; **52 files contain it**. A peer checked. The conclusion survives on
a vocabulary search — the only files matching semantic/LLM-classifier wording are that source, its dist
build and its test — but the evidence I cited was invented. **Both peer corrections today landed on my
supporting numbers, never my conclusions: the scrutiny follows the headline and the cheap claim rides in
behind it.**

**And the framing was narrowed, correctly.** The source says `RESIDUAL ... out of scope for this
conservative v1.0 keyword matcher` — honest documentation of a known limitation, not a false coverage
claim. The defect is one clause: a deferral to a version that was never built. **The weaker true claim
is the one to hand an owner.**

Net: one finding on that gate, not two.

## V-1955 — the gap vocabulary in apps/server/src yields exactly one open item (2026-08-27)

Having found the homoglyph residual by grepping the word rather than building a detector, ran the same
approach to exhaustion over `apps/server/src`. **Boundary: server source only — not tests, not the
other apps, not `packages/`.**

**`residual` — 8 sites, 7 closed, 1 open.** Enumerated rather than sampled, and the word is
systematically ambiguous here: it marks a gap the surrounding code SHUTS at least as often as one left
standing. `auth-coalescer.ts` describes V-012's cold-start blip as the reason the coalescer exists — the
comment names the residual and the file IS the fix. `profile-snapshots-repo.ts` spells out how a forged
cross-account cursor would leak a snapshot-id-exists oracle, then closes it on the next line with
`eq(profileSnapshots.accountId, args.accountId)`. `openapi.ts` and `billing.ts` both say "V-481 #122
residual closed" about a route that previously had no scope gate. `ip-rate-limit.ts` and `auth.ts` say
"these gates close the residual abuse friction". `agent-sessions.ts` narrows a false-block window.
**Only `agent-consequential-action.ts:73` uses the word for something still standing, and it says so —
"out of scope for this conservative v1.0 keyword matcher".**

**Everything else in the gap vocabulary resolves to a documented decision.** `known gap`
(`agent-sessions.ts:3111`) is unbounded growth in two upload-counter maps — capped at 20 000 entries
with oldest-eviction, and the direction reasoned out: a false-cleared counter only ever widens a
session's own allowance, accepted as a soft best-effort cap matching the sibling maps. `does not handle`
is OpenVPN/WireGuard, Phase 2/3 by plan. `we accept` is multi-currency summing without a conversion
table. Three `TODO`s, all post-launch or gated on unstarted work. **`FIXME`: zero.**

**So the vein is exhausted at one open item, and the discriminator is worth keeping: a comment that
names a gap and then closes it reads identically to one that names a gap and leaves it.** The word does
not distinguish them — the surrounding sentence does, and only reading it does. A count of "residual"
mentions would have reported eight open items; seven are the opposite of that.

⭐ This is the second bounded negative today worth recording as a result rather than a non-event: the
first was tautological length assertions and always-true matchers, both zero with passing controls.
**Knowing a vein is dry is worth the same as a finding, provided the boundary is stated with it.**

## V-1956 — a comment promised a fallback that was never written, and two pins froze it (2026-08-27)

`RedisMfaChallengeStore.consume` carried: _"GETDEL is atomic in Redis 6.2+; falls back to GET + DEL
pipeline for older Redis."_ **No fallback exists.** The method calls `getdel` directly, so on a pre-6.2
server the command rejects and MFA verification fails closed — which is the safe direction, but it is
not what the comment describes, and someone debugging a pre-6.2 deployment would look for a code path
that was never written.

**The call also went through `this.redis as unknown as { getdel: … }`.** ioredis declares `getdel` in
`RedisCommander.d.ts:2345`, and `package.json` has pinned `^5.11.0` since the scaffolding commit — the
only commit that ever touched that declaration. **So the cast was never necessary, and in a
security-critical path an `as unknown as` is precisely what absorbs a future signature change in
silence.** Removed; `tsc` via `tsconfig.test.json` is clean against the real ioredis type.

**Two tests pinned the false sentence, including in their arm titles.** A content-parity test matched the
comment verbatim AND the cast expression; a cross-source invariant matched three fragments of it. Source
and both pins updated in one commit — and the titles too, because a grep for "falls back to GET + DEL
pipeline" would otherwise still find the claim living in a test name. **Same shape as the stale OPEN
markers: the claim and its correction are different lines, and a marker in a title is still a marker.**
`it(` counts unchanged at 15 and 20; mutation-proven by reinstating the cast, which reddens both.

⛔ **The pin I wrote first was self-referential and failed immediately.** I asserted
`not.toMatch(/as unknown as \{\s*getdel/)` — and the new comment EXPLAINS the removed cast, so it
contains that phrase. **An absence assertion broken by the sentence documenting the absence.** Third
self-reference of the day, after a ceiling guard that counted its own fixture. Retargeted at the call
expression `this.redis as unknown as`, which prose does not contain.

⭐ Prior art was opened first and did not cover this: the MFA store has five memories, one calling these
primitives "textbook" with `consume` = "atomic Redis GETDEL one-shot". **That description is accurate
and was never the problem — the inaccuracy was in a clause about a fallback nobody had reason to
re-read.**

## V-1957 — an OAuth TOCTOU left conditional on future work; the condition fired and is satisfied (2026-08-27)

Picked the target from coverage data rather than instinct: `routes/auth-oauth-client.ts` has 77 branches
at 63.6% and is security-critical. **Boundary: that figure is from the `--all` run, which excludes the
233 e2e tests, so branches exercised only end-to-end read as uncovered.** The prior art turned out to be
the better lead — eight OAuth memories, six clean, two naming gaps.

Both gaps are resolved, but one closed **conditionally**: an authorization-code-reuse TOCTOU, fixed at
the interface in June, ending _"only the persistent impl's adherence remains"_ — the check deferred until
a persistent store existed. **It exists now** (`db/oauth-store.ts`, migration
`0106_oauth_provider_persistence.sql`), so the condition is live.

**It is satisfied.** `consumeCodeForToken` runs entirely inside `db.transaction`, and reads the code row
with `.limit(1).for('update')` — a `SELECT … FOR UPDATE`. A concurrent exchange blocks on that lock until
the first commits, then sees `consumedAt !== null` and returns `'code_unavailable'`, so the check-then-act
is atomic. It also `.for('update')`-locks the client row and compares the client secret with
`constantTimeHashEqual`. Witnessed against real Postgres by
`db-oauth-code-single-use-lock-drizzle.test.ts`, whose arm is _"CRITICAL consumeCodeForToken BLOCKS while
another session holds the authorization-code row"_, driving two exchanges through `Promise.all`.

⛔ **The note would have reported itself unmet if I had grepped for what it prescribed.** It required
"the single conditional `UPDATE oauth_codes SET consumed_at=$at WHERE code=$code AND consumed_at IS NULL
RETURNING`", and named the method `consumeCodeIfUnconsumed`. **Neither exists** — that identifier
survives only inside a comment elsewhere. The implementation satisfies the PROPERTY (atomic against a
concurrent exchange) by pessimistic locking instead of the prescribed MECHANISM. **A requirement written
as a mechanism accuses correct code that met the requirement another way**; write the invariant and name
a mechanism only as an example.

No action. Recording it because a conditional deferral is the easiest kind of item to lose: it is neither
open nor closed at the moment it is written, and nothing fires when its precondition arrives.

## V-1958 — a migration's "cannot collide" argument, verified to its premise (2026-08-27)

Swept absolute concurrency claims in `apps/server/src` — `race-free` (3 sites) and `no race` (1),
chosen over `atomic` (97) because an absolute claim is falsifiable and a hedged one is not. **All four
are sound.** Three are the same claim: the signup canonical-email dedup is race-free because
`accounts_canonical_email_unique` backstops the pre-check, and that index is real —
`CREATE UNIQUE INDEX IF NOT EXISTS` in migration `0096_accounts_canonical_email.sql:67`. The fourth is
an SSE slot cap incremented synchronously between check and use, which single-threaded Node makes safe.

**The interesting part is `0102`, which backfills a uniquely-indexed column and defends itself with an
argument rather than a mechanism:** _"idempotent and cannot introduce a new unique collision — 0096's
stricter canonical form already prevented two non-Gmail values differing only by a plus suffix from
coexisting; this migration only expands each affected canonical value back to its already-unique
literal email."_

**The argument depends on a premise it does not state: that `lower(email)` is injective over the table
— i.e. no two rows differ only by case.** `accounts_email_unique` is on the RAW column, so it permits
`A@x.com` and `a@x.com`; 0102 writes `lower(email)` into the unique canonical column, where they would
collide. **Enumerated every writer rather than sampling: there are exactly two `insert(accounts)` sites**
— `db/auth-flows-repo.ts:125`, which writes `args.email.trim().toLowerCase()`, and `db/seed.ts:39`,
whose `SEED_EMAIL` is already lowercase. OAuth signup is not a third writer; it routes through the same
repo dependency. **So the premise holds for every row the current code can create, and the argument is
sound.**

⛔ **Boundary, and it is the whole caveat: this verifies the CODE, not the DATA.** A row inserted before
lowercasing was introduced would keep a mixed-case `email`, and two such rows differing only by case
would fail 0102's index. I cannot check production data from here. **0096 is honest about exactly this
— "a human should reconcile any such existing duplicate accounts before this migration can land; this
was NOT verified against production data" — while 0102's flatter "cannot introduce a new unique
collision" reads as unconditional.** The two comments are about the same hazard at different confidence,
and only the earlier one carries the caveat.

No action: both migrations are single-transaction with an auto-revert path in `db/migrate.ts`, so the
failure mode is a rolled-back deploy rather than a half-applied schema.

## V-1959 — three delegations, three outcomes, and the wording is what decided them (2026-08-27)

Swept `exactly once` in `apps/server/src`. **Boundary: the literal phrase, case-insensitive, server
source only — and the count moved with the instrument: 21 case-sensitive, 23 case-insensitive.** The two
extra include `db/session-operations-repo.ts:186`, capital-E `Exactly-once`, which my first grep missed
and which turned out to matter. Of the 23, **ten are the scheduled-sweeper re-arm pattern — counted by
SHAPE, not token**: a `grep -c "re-arm exactly once"` finds 7, because the same sweeper idiom is also
spelled "re-armed exactly once", "re-arm runs exactly once" and "still re-arms". One more is the
`withOrderLock` fix verified in V-1947. The fresh one is billing: `agent-runtime.ts:1229`, _"Account
that work exactly once whether the answer is published, sanitized to empty, fenced by a new controller,
or suppressed by a transcript-storage failure."_

**Sound, and correct for the reason that usually fails.** `recordUsageRowWithRetry` retries a write,
which is at-least-once unless the write is idempotent — so the claim rests entirely on a delegation
("see the `recordId` contract"). **Verified end to end rather than trusted:** the caller generates
`recordId` ONCE and reuses it across every attempt; `DrizzleAgentDecomposerUsageRecorder.record` uses it
as the row `id` and issues `insert.onConflictDoNothing()`. Same id + primary key + ON CONFLICT is
genuinely idempotent, so a retry after a commit-that-appeared-to-fail is a no-op. Witnessed at both
layers by dedicated tests — `agent-runtime-usage-record-retry-idempotency` and, against real Postgres,
`db-usage-record-retry-idempotency`. The interface even names the precise hazard: a connection reset
after the statement committed producing "a SECOND $0.10 row for one turn".

⭐ **Three delegations examined today resolved three different ways, and the difference was in how each
was WORDED:**

- **`agent-consequential-action`** deferred a homoglyph residual to "the v1.1 LLM-semantic classifier".
  v1.1 is a real planned scope, but it has not shipped — **so the gap is open today** and the present
  tense in "caught by" reads as coverage.
- **The OAuth code-reuse TOCTOU** prescribed a MECHANISM — a specific conditional `UPDATE … WHERE
consumed_at IS NULL RETURNING`, under a named method. The implementation satisfied the PROPERTY by
  pessimistic locking instead. **Grepping for what the note prescribed would have reported correct code
  as non-compliant.**
- **The usage recorder** prescribed the PROPERTY — "reused by every retry attempt, so the write is
  idempotent" — and left the mechanism open. The implementation chose PK + `onConflictDoNothing`, which
  satisfies it, and a reader checking the contract can confirm adherence without knowing what was
  intended.

**A delegation that names a property can be verified against any implementation; one that names a
mechanism can only be verified against the implementation its author imagined.** Same lesson as the
parity pin freezing text rather than truth: the wording is what the next reader checks, and it is not
itself under test.

**Enumeration completed rather than sampled: all 13 non-sweeper sites read.** Each is a design statement
that holds — a compiler-enforced taint brand (`BYOKAnthropicKeyPlaintext`), a deliberate refusal to
fabricate a second terminal when storage rejects, a `ConflictError` on a concurrent profile transfer, a
single funnel so outcome counting cannot drift, a boolean return that IS the once-ness
(`markEmailVerified`), the CAS-backed paid transition, re-arm safety, paired terminal fields, and a
`close()` idempotency flag.

⭐ **`services/email.ts:886` is the positive example the rest of today lacked, because it scopes its own
claim:** _"Every other template — and every non-transient category even on a security-critical template
— sends exactly once."_ The retried path is security-critical templates hitting a TRANSIENT category,
and that path is deliberately at-least-once — a lost Postmark acknowledgement re-sends, because the
alternative is a password reset that never arrives. **The comment carves out precisely the case where
its guarantee does not hold, so a reader can trust the sentence without reading the loop.** Every
inaccurate comment found today failed at exactly that step.

No action.

## V-1960 — a pin froze the value; the CAS needed the relationship (2026-08-27)

Following the `exactly once` sweep into `db/session-operations-repo.ts`, whose comment is the clearest
statement of today's property-versus-mechanism lesson written by someone else: _"The design doc
originally said `running`, which cannot expire an operation that never started — a queued operation past
its deadline would have been unsettleable forever. Exactly-once is preserved either way, because what
guarantees it is excluding the TERMINAL statuses, not naming a single live one."_

**The CAS is sound** — `settle()` updates `WHERE inArray(status, [...LIVE_STATUSES]) AND incarnation`,
`.returning()`, and treats zero rows as `superseded`. **And it is well pinned**: an existing parity
guard freezes `LIVE_STATUSES = ['queued', 'running']` verbatim in the repo AND the partial-index
predicate in the DDL, so the constant cannot drift unnoticed.

⛔ **But a pin freezes a value, not a relationship.** `LIVE_STATUSES` is an ALLOW-list; the status set
lives in four places (the DB CHECK in migration 0108, the Drizzle `$type` union, the exported
`SessionOperationStatus`, and the live list). **Add a seventh status to the first three and every
existing assertion stays green while the new status is neither live nor terminal — so `settle()` can
never reach it, and an operation in that state is unsettleable forever.** That is the identical defect
the comment records as already fixed once, in a new spelling.

Landed a cross-source invariant asserting the RELATIONSHIP: the four declarations agree, LIVE and
TERMINAL are disjoint, and their union exactly exhausts the set — with each terminal status enumerated
alongside the reason it is terminal. A new status now fails until somebody classifies it, which is the
decision the original bug skipped. **Mutation-proven twice: adding `paused` to all three declarations
(so they agree) reddens the partition arm; reverting `LIVE_STATUSES` to `{running}` reddens all four,
including the arm named for that regression.** All files restored byte-identical.

⭐ **My own extractor was wrong on the first run and the guard's floor caught it.** `status: text('status')`
appears in many tables in `schema.ts`, so the unanchored regex returned another table's union —
`['emitted','queued']`. The non-vacuity arm asserts a COUNT per source, so it failed before any set
comparison could spuriously agree. **Had that arm asserted merely "non-empty", two wrong sets could have
matched each other.** Anchored to `sessionOperations = pgTable(`.

## V-1961 — three instruments failed before reading found the answer in one grep (2026-08-27)

Targeted `services/durable-webhook-delivery.ts` from coverage data — 125 branches at 62.4%, a delivery
path with signing, retries and a customer-controlled outbound URL. **Sound, no action, and the low
coverage has a benign cause I should have established first.**

**Three instrument failures on the way, each producing a confident wrong answer:**

1. **A scoped coverage run reported 0/125 branches.** I selected 27 test files by grepping their text
   for `durable-webhook-delivery`, so the run measured "do these 27 files touch it" — not "is it
   covered". **A scoped coverage run answers a different question than coverage**, and 0% next to the
   gate's 62.4% is the tell.
2. **Parsing the istanbul HTML gutter gave uncovered "lines" 17-24, 50-67, 103…** The gutter had 179
   entries for a 901-line file, so the indices are not source lines. The sanity check killed it: line 17
   is an import, line 50 a comment, line 103 a bare `*/`. **None of those can be a branch.**
3. **Grepping the file for `unsafeWebhookTargetReason|classifyUnsafeHost` found nothing**, which read as
   "the durable path is unguarded" — a real finding if true. **The guard is applied through a WRAPPER:**
   line 49 imports `ssrfGuardedFetch`, line 123 is `const fetchFn = deps.fetch ?? ssrfGuardedFetch`.
   Sweep the shape, not the token — the guard's name is not the guard's application point.

**The file is SSRF-safe by default and its comment is the model of the practice the rest of today kept
finding violated:** it states the guarantee, the reason (a future cutover keeps the connection-time
DNS-rebind pin without the wirer remembering to inject it), the limit (a create-time guard cannot stop
rebind), AND the exception (_"Tests inject `deps.fetch` and bypass it"_).

⭐ **Why the coverage was low, verified with a control:** `DurableWebhookDelivery` is referenced nowhere
outside its own file and one schema comment — it is the documented forward path, **not wired in
production**; the live sender is `webhook-worker.ts`. The control was grepping bootstrap for `tickOnce`,
which finds three live wirings, so the empty result is real rather than a broken pattern. **Low branch
coverage on an unwired path is expected, not a defect — so coverage-driven targeting needs "is this path
wired?" as its FIRST question, not its last.** I asked it fourth, after three instruments.

**Boundary: this audits the durable sender's own guarding and wiring. It does not re-audit the live
`webhook-worker.ts` path**, whose SSRF layers are recorded as fixed in prior art and were not re-checked
here.

## V-1962 — four docs guards that reported clean over zero pages (2026-08-27)

Four `apps/docs` drift guards walk `apps/docs/src/pages` and assert `expect(offenders).toEqual([])`.
`walk()` opens `if (!existsSync(dir)) return out;`, so a moved or renamed root returns an empty list and
**every arm passes over nothing**. Demonstrated rather than argued: pointing the root at
`apps/docs/src/pages-RENAMED` leaves _"every .md page has a frontmatter block"_, _"declares layout,
title, and description"_ and _"uses the canonical DocLayout"_ **all green**, reading zero pages.

Added one arm each asserting the walk found the pages. **A named member rather than only a count**:
a count floor churns as pages are added and gets bumped without being read, while
`mdFiles.some((f) => f.endsWith('api/account.md'))` cannot be satisfied by an empty walk and needs no
maintenance. Both are asserted — the member proves the walk reached the tree, the low floor catches a
collapse to one or two files. Measured: `mdFiles` 57, `guideFiles` 10, `allFiles` 130.

⭐ **`docs-no-dev-notes-baseline` spans TWO roots** — `apps/marketing-site/src/pages` and
`apps/docs/src/pages` — so it gets a member from EACH. With one member, the other root could vanish
silently and the surviving member would keep the arm green. **A collection built from N roots needs N
members, or it degrades to guarding whichever root you happened to name.**

⛔ **Scope, honestly: this fixes 4 of 19.** The other 15 build their collections inside arms or through
shapes that differ per file, so there is no scripted pass — the same per-occurrence conclusion the
swallowing-walk debt reached.

⛔ **And my dry run was itself wrong, in the reassuring direction.** Before writing anything I dry-ran
the patcher to print, per file, the module-level collection it matched — it reported "(none found)" for
seven of ten, which is what made me stop and read them individually. **At least one of those seven does
have a module-level collection**: `docs-no-dev-notes-baseline`'s
`const allFiles = targets.flatMap((d) => walk(d)).filter(...)`, missed because my pattern required
`= walk(` immediately. The dry run correctly stopped a bad batch edit AND under-reported the tractable
set — **a dry run is an instrument too, and its negatives need the same suspicion as any other zero.**

## V-1963 — the same hole in eight dashboard guards, and this time it WAS a batch (2026-08-27)

Eight `apps/customer-dashboard` guards share one module-level line —
`const pages = walk(PAGES).filter((f) => /\.astro$/.test(f));` — against one root, and every arm asserts
`toEqual([])`. Same defect as V-1962: `walk` returns `[]` for a missing directory, so a renamed root
makes all of them report clean over zero pages. Confirmed by drifting the root in one file: the new arm
reds and the two original arms pass.

**Unlike the docs set, this genuinely was uniform — and I only know that because I checked instead of
assuming in either direction.** V-1962's dry run found 3 of 10 sharing a shape and stopped a scripted
pass; the same dry run here reported 8 of 8 READY, and the applied result matched. **The lesson is not
"never batch" — it is that whether a batch is safe is a measurement, and it costs one command.**

Each file gets one arm: a floor of 12 against a measured 24 pages, plus
`pages.some((f) => f.endsWith('billing.astro'))`. **The named member is the load-bearing half** — it
cannot be satisfied by an empty walk and does not churn as pages are added, while the count alone would
be bumped without being read the first time someone adds a page.

Running total on the shape: **12 of 19 floorless set-enumerating tests now floored** (4 docs in V-1962,
8 here). The remaining 7 build their collections inside arms or through per-file shapes and need
individual reads — the same per-occurrence conclusion the swallowing-walk debt reached, and the reason
the ceiling guard caps that population rather than pretending it is scriptable.

## V-1964 — the control-plane outbound gate cannot fail to release (2026-08-27)

One of three streaming questions raised for the owner's "picks up after a lag" work is whether the
congestion gate releases promptly once `bufferedAmount` drops. **For the control-plane gate the answer is
structural, and answerable statically: it holds no state to release.**

`assertFleetOutboundCapacity(bufferedAmount, frameBytes)` in `routes/fleet-events.ts` is a pure function
of the CURRENT buffered amount — `if (bufferedAmount + frameBytes > FLEET_WS_MAX_BUFFERED_BYTES) throw`.
**No latch, no hysteresis, no sticky flag**, so there is no state that can remain set after congestion
clears. The next frame is admitted the moment the queue has drained enough to fit it. The source states
the same intent: a synchronous refusal, correlators convert the throw to their bounded error outcome and
clear their pending timers, and _"the shared node socket stays open, so a later request can proceed once
the existing queue drains."_ Witnessed by three files, including direct assertions on the exported
function in `routes-fleet-events-content-parity`.

⛔ **Boundary, and it is the whole value of this entry: this is the FLEET CONTROL-PLANE WebSocket
outbound gate in `apps/server`. It is not the GUI or SFU data-channel gate.** Searched `apps/server` for
a stateful shed/backpressure/throttle mechanism and there is none — the only "shed" is a node-lifecycle
drain/cordon in the harness protocol schema, which is a session-admission state rather than a per-frame
gate. **So this answers the question for one gate and says nothing about the one that likely matters for
frame pacing**, which lives outside this repo.

⭐ Recording it because a structural answer is worth more than a measurement here: a gate with no state
cannot be observed sticking, so no amount of load testing this particular gate would have been
informative. **The measurement effort belongs on the gates that DO hold state**, and identifying which
those are is the cheaper first step.

## V-1965 — the inbound gate releases on a clock, not on pressure clearing (2026-08-27)

V-1964 answered the OUTBOUND control-plane gate: stateless, nothing held, cannot fail to release. **The
INBOUND direction is the opposite shape and gives a different answer.**

`FleetInboundFrameBudget.admit` (`services/fleet-inbound-frame-gate.ts`) is a per-node token bucket. It
holds state, and its release is a function of ELAPSED TIME, not of congestion having cleared:

    elapsedSeconds = Math.max(0, now - state.refilledAtMs) / 1000
    frameTokens     = min(256,      frameTokens     + elapsed * 32)        // 8s empty→full
    byteTokens      = min(64 MiB,   byteTokens      + elapsed * 8 MiB)     // 8s empty→full
    largeFrameTokens= min(4,        largeFrameTokens+ elapsed * 1)         // 4s empty→full

**So after the bucket is drained, admission is capped at 32 frames/sec for up to 8 seconds regardless of
whether the network recovered instantly.** A bucket cannot "notice" that pressure cleared — that is what
a token bucket is, and it is the correct shape for abuse limiting. It is also, precisely, a mechanism
that does not pick up promptly after a lag.

⛔ **What is certain and what is not, stated separately.** The arithmetic above is certain — read from
the constants and the refill expression. **What I have NOT established is whether a lag episode actually
drains these buckets.** A slow network delivers FEWER frames, which does not drain an inbound bucket;
the drain would come from the backlog arriving as a burst once the link recovers. **That reconnect-burst
shape is the hypothesis this points at, and it is a measurement, not a reading** — it needs the real
frame rate of the harness protocol under a recovered link, which I cannot obtain from this repo.

⭐ **The useful half is the triage rule, not the number:** V-1964's gate holds no state, so no amount of
load testing it could show a stick — testing it would have been effort spent proving a tautology. This
gate holds three independent buckets with an 8-second worst case. **When asking "does the gate release
promptly", establish first whether the gate HAS state; the stateless ones are answerable by reading and
the stateful ones are the only ones worth instrumenting.**

**Boundary: both entries cover `apps/server` control-plane gates only.** The SFU and data-channel pacing
that governs frame smoothness is outside this repo and unexamined here.

## V-1966 — the inbound budget does not shed, it CLOSES the socket, and nothing records it (2026-08-27)

V-1965 read the inbound gate as a shed-and-recover mechanism releasing on a clock. **Following the
refusal to its consumer shows that framing is wrong, and the real behaviour is more consequential.**

`FleetControlConnection.handleInboundBytes` returns `'parse-budget-exhausted'` when the token bucket
refuses. At `routes/fleet-events.ts:176` the caller does:

    const admission = conn.handleInboundBytes(messageToBuffer(data));
    if (admission === 'accepted') return;
    // Policy-close the whole authenticated socket after the first rejected
    // frame. Do not log or reflect payload text
    inboundRejected = true;
    socket.close(1008, admission);

**Exceeding the inbound budget terminates the node's control connection.** There is no shedding and
nothing to un-shed. And the budget is `/** Reconnect-resistant token buckets */` — one map keyed by
node, created once at registry construction and **never reset on register or unregister** — so a node
whose budget is exhausted reconnects into a bucket that is still empty and can be closed again, until
enough wall-clock refill has elapsed (up to 8 s for frames and bytes, 4 s for large frames).

⭐ **The anti-abuse design is correct and I am not calling it a defect.** Reconnect-resistance is the
whole point: a node must not be able to reset its budget by reconnecting. **What composes badly is the
combination — a hard socket close, budget state that deliberately survives the reconnect, and a
time-based refill — which together produce a close/reconnect window rather than a degradation.**

⛔ **And the entire chain is unobservable.** The gate has no metric and no logger; the call site's comment
says _"Do not log or reflect payload text"_ and logs nothing at all; the typed verdict
`'parse-budget-exhausted'` is referenced in exactly three places — its own union declaration, its return,
and one test. **No production code consumes it.** So if this is happening, it leaves no trace beyond a
1008 close, which is exactly the shape of a complaint about lag spikes with no diagnostic trail.

**Certain versus hypothesis, kept apart.** CERTAIN: the close, the reconnect-resistant state, the absence
of any log or metric — all read from source. **HYPOTHESIS, unmeasured: that real post-lag traffic
actually exhausts 256 frames or 64 MiB.** A slow link delivers FEWER frames; the exhaustion would come
from a backlog arriving as a burst once the link recovers. **That is a measurement, and it is currently
impossible to make from production data because nothing records the event.**

⭐ The smallest thing that would settle it is in scope and does not touch the fork: a counter on the
1008-close path, carrying the bounded reason and no payload — which respects the existing comment, since
that forbids reflecting payload TEXT rather than recording that the event occurred.

## V-1967 — recording the close, and why it had to be a log rather than a counter (2026-08-27)

V-1966 established that exhausting the inbound token budget closes a fleet node's control socket, that
the budget deliberately survives the reconnect, and that **nothing anywhere records it** — the gate has
no logger and no metric, and the typed `parse-budget-exhausted` verdict had no production consumer. The
hypothesis that this is behind "doesn't properly pick up after a lag" was therefore untestable from
production data.

Landed the recording. `routes/fleet-events.ts` now emits a bounded `req.log.warn` on the 1008 path —
`component`, `event: 'inbound_admission_refused'`, `nodeId`, `reason` — and no payload, which is what the
pre-existing comment actually forbade ("do not log or reflect payload TEXT"). The comment is reworded so
it no longer reads as forbidding the record itself.

⛔ **I proposed a counter and had to withdraw it against my own earlier finding.** V-1944 established
that `MetricsRegistry` is constructed only when `METRICS_SCRAPE_TOKEN` is set, and that the token is
unset on the deployment I had notes for. **`metrics?.inc` is optional-chained everywhere, so a counter
here would be a silent no-op on exactly the deployments where this needs to be visible** — instrumentation
that cannot emit, proposed to make an invisible failure visible. The request logger is unconditionally
wired; that is the whole reason for the choice.

**The pin enforces the INTENT, not the line.** Besides asserting the warn and its bounded fields, it
asserts `body` does NOT match `metrics?.inc(...admission...)`. **A future change that "upgrades" the log
to a counter looks like an improvement and silently stops recording anything**, so that swap has to fail
loudly. Mutation-proven both ways: deleting the log reddens the arm, and replacing it with a metric
reddens it too.

⭐ **Wider than the budget, which the entry above understates.** `FleetInboundAdmission` has three
members — `accepted`, `parse-budget-exhausted`, and `uncorrelated-large-frame` — and the log fires on
`reason: admission` for BOTH non-accepted verdicts. So it also records a large download frame that
arrives without a matching pending fetch claim, which closes a node's socket for a different reason and
was equally silent. **The second cause is arguably the more interesting one**, since an uncorrelated
large frame implies a claim that expired or never existed rather than a node simply being too fast.

⭐ **The general shape, and it is the third time today: an instrument that is gated on configuration is
not an instrument.** Verify what is WIRED before choosing where to emit — the same question that
explained `durable-webhook-delivery`'s coverage and the same one that made "is there a v1.1 classifier"
answerable. **Boundary: this records the event; it does not establish that the event occurs.** That is
one production log line away, and if it never fires the hypothesis is excluded cheaply.

## V-1968 — the remaining seven were all false positives; the work was already done (2026-08-27)

V-1962 and V-1963 reported "12 of 19 floorless set-enumerating tests now floored", implying seven
outstanding. **Enumerated and read all seven. Every one is a false positive.** The correct statement is
**12 genuinely vacuous, all fixed and mutation-proven, and 7 misclassified** — the remediation was
complete when I wrote that it was 63% done.

**Five ways a "walks a tree and asserts empty" test is NOT vacuous, four of which my classifier could
not see:**

- **Reference-set lookup.** The walk builds a `Set` of known-good values and the arm accuses anything
  NOT in it (`guides-index-href`, `index-card-href`). **An empty walk accuses EVERYTHING** — loud
  failure, the exact opposite of a vacuous pass. The question is whether the collection is the SUBJECT
  accused or the REFERENCE accused against.
- **A bare `readdirSync(dir)` throws.** Only a walk that SWALLOWS — `if (!existsSync(dir)) return out` —
  degrades quietly. `nav-endpoint-children`, `admin-pages-endpoint-parity` and `tier-table-sweep` have
  no `existsSync` at all; verified empirically that `readdirSync` on a missing directory raises ENOENT.
  **The swallow is the defect, not the walk**, and my detector keyed on the walk.
- **The walk feeds nothing.** `customer-route-doc-coverage-parity` imports `readdirSync` while every
  assertion iterates a hardcoded `ROUTE_TO_DOC` map. **My tree-reading regex matched the IMPORT.**
- **A floor in an unrecognised form.** `docs-sdk-method-refs-integrity` already asserts
  `expect(/client\.\w+\.\w+\(/.test(corpus)).toBe(true)` — a perfectly good non-vacuity check that an
  empty corpus fails. My pattern list knew counts and member checks, not regex-over-corpus.

⭐ **Why the twelve were right while the residue was entirely wrong: the twelve were confirmed by
MUTATION and the seven were only classified.** Drifting the root and observing which arms redden is
unfakeable — the vacuous ones stay green while the new arm fires, and I ran exactly that on one member
of each batch. **A classifier selects candidates; only running the failure mode confirms one.** The
seven were never mutated because they were the "remaining work", and remaining work does not get
proofs — which is precisely how a 100%-false list survives to be reported as a backlog.

**No code change: nothing here needs fixing.** Recording it because "seven files still need a floor"
would otherwise have stood as a durable, entirely fictional item of debt.

## V-1969 — warm tabs: owner chose rehearse-then-enable; procedure written (2026-08-27)

Owner decided directly: **rehearse the rollback while the flag is still OFF, then a watched single-node
enable.** Procedure written to `docs/internal/warm-tabs-rollback-rehearsal-and-watched-enable.md`.

**Why it was never enabled, assembled from notes dated 07-08 → 07-11 rather than from the relay chain:**
it shipped deliberately dark behind `DRIFTSTACK_WARM_TABS=0`, split across two owners; the 07-10 handoff
records it as _"BUILT+STAGED but DISABLED + never validated"_; a 07-09 box-rebuild window was awaiting a
smoke pass I cannot confirm completed; and on 07-11 a real failure was reproduced on the deployed fork —
`-1004` / `ECONNREFUSED errno 61`, root-caused to the fork not tearing down the WebDriver listen socket.
**That last one is the only blocker with a reproduction behind it rather than an unvalidated status.**

⛔ **Two things recorded as NOT established, because they are attributed to me and I cannot verify
either.** The assessment that the "never validated" blocker is stale, and the hardening specifics (a
1400 MB reap guard, an LRU, memory-pressure eviction), live in the private repo's `OPEN-ITEMS.md` under
my name — but were **transcribed from my messages rather than written by me**, as the transcriber has
since confirmed. **A citation pointing at me that I cannot read is the stale-citation problem with the
citation reversed**, and the correct response is to mark it unverified rather than let it carry my
authority into a production enable.

⭐ **The rehearsal-first ordering is the day's own lesson applied to an operation rather than a test.**
Three separate mechanisms were found today that were documented and never built — a v1.1 classifier, a
GET+DEL fallback, a cookie session justifying a real setting. **A rollback procedure is exactly that
class of artifact: written once, never executed, and trusted at the moment it is needed most.** Phase 0
costs nothing while the flag is off and converts the escape hatch from a plan into a control.

⚠️ Phase 0 also answers a question that has been open since the flag was written: `DRIFTSTACK_WARM_TABS`
appears in **zero** ops records despite a bus post recording a daemon carrying it set to `1`
(`ops=0 bus=8`). **Capturing the daemon env during the rehearsal settles whether it has ever run
enabled** — "off on the box" and "never ran anywhere" are different claims and only the first is
established.

**Execution boundary: none of this is mine to run.** A watched enable on fleet hardware is deploy-class
work on the fork runtime, and my standing constraints are no push, no deploy, and no `driftstack` /
`webkit-driftstack`. The procedure is the deliverable; the operation needs an owner with those surfaces.

## V-1970 — I nearly "fixed" a correct comment back into a falsehood (2026-08-27)

Auditing D-2 (avatar orphans) from my own note, which states the bucket is _"presign-only, 1h TTL — no
public-direct URL"_ and that _"the R2 client has no deleteObject"_. **Both are false, and acting on them
would have reintroduced a claim V-797 removed as untrue.**

The route comment justifies leaving orphaned objects with _"avatars are already public-readable so
leaving stale objects is no worse than the public bucket already is"_. Against my note that read as a
false security claim understating the posture, and I set out to correct it. **V-797 had already settled
it the other way:** the avatar bucket IS the public bucket, and the presigned URL is _"a stable
time-limited LINK, not an access control: anyone holding the object URL can fetch it."_ The customer
page is pinned to say `public-readable bucket` and pinned NOT to say `stored privately on Cloudflare
R2`, and it tells customers to **treat an avatar as public content**. **My correction would have
re-asserted the privacy framing V-797 deleted.**

**The second claim is stale in the ordinary way.** `lib/r2.ts` now exports `deleteObject`, used by four
services — and `profile-blob-orphan-sweeper` is a working app-side precedent for precisely the
orphan-reaping the note said to prefer doing in infra. **So D-2's stated blocker is gone**: the
capability exists and the pattern is proven. Whether to reap avatars is still a product call, but it is
no longer blocked by "we cannot".

⭐ **What stopped the wrong edit was the pin-checking rule, and not suspicion.** The standing rule is fix
source plus every pin in one commit, so before touching the comment I searched for pins — and the pin's
own arm title reads _"avatar R2 storage framing, corrected by V-797"_. **The provenance was in the test
NAME, which pointed straight at the authority that had already adjudicated it.** A pin is usually a
coupling to satisfy; here it was a citation that prevented a regression.

⛔ **The direction of the rot is the part worth keeping.** Both stale claims made the surface sound
SAFER than it is — "presign-only, no public URL" and "we cannot delete anyway". **A note that drifts
toward reassurance is more dangerous than one that drifts toward alarm**, because nobody re-checks a
claim that says there is nothing to do. Same asymmetry as a stale OPEN versus a stale CLEAN, one level
down: this was a stale JUSTIFICATION.

No code change: the comment is accurate and its future-tense "a future sweeper job" is exactly the
honesty V-797 praised while faulting the customer page for promoting it to a guarantee.

## V-1971 — scope enforcement holds, and my clean bill was an empty detector (2026-08-27)

Expiry-checked a note marked RESOLVED 2026-05-26 ("API-key scope enforcement implemented across all
wired customer-write routes"). **A resolved note expires like an open one, and its residue was already
moot** — its single deferral, `saved-proxies`, names a route retired outright in `fc8fb3de2`.

⛔ **My first measurement reported "0 authed mutating routes lack a scope gate" and was meaningless.**
The control — how many routes did the matcher SEE — returned **0 of 173**. The registration regex matched
nothing at all, so the zero described the regex, not the routes. **I would have reported a clean bill
from a detector that never fired.** Rewritten with a line-window matcher whose control passes 173/173.

**With a working instrument: 99 of 173 mutating routes are `requireAuth`-gated, and 14 of those carry no
inline `requireScope`. All fourteen are explained, by four different mechanisms:**

- **Ten enforce at the service layer** — `webhooks` (6), `api-keys` (3), `email-preferences` (1) — exactly
  the set the 2026-05-26 note recorded as "already enforced at the service/route layer".
- **Three are auth flows** (`auth.ts` mfa/step-up, `auth-cli` bind-device-code, `oauth` authorize/complete)
  where the caller holds a web session rather than an API key, so the scope concept does not apply.
- **One delegates to a COMPOSITE preHandler.** `agent-sessions-transport-report` uses
  `controlKeyOrAccountAuth`, which calls `requireAuth` then `requireScope('read:sessions')` internally —
  deliberately the read scope, per its own comment. **My matcher reads the inline preHandler array, so a
  route that composes its auth looks unscoped.**

⭐ **That last one is the reusable caveat: a per-route gate check sees the registration, not the call
graph.** Any route whose auth is factored into a helper reads as ungated, and the more carefully a
codebase factors shared auth, the more false positives this class of check produces —
[[feedback_a_grep_for_the_canonical_helper_accuses_the_strictest_code]] in a new place.

⛔ **A separate false alarm, self-inflicted, worth recording because it cost a detour:** checking file by
file I found `mfa` with zero `requireScope` sites and briefly read it as a regression. **`routes/mfa.ts`
does not exist** — the file is `account-mfa.ts` and it does use `requireScope('read')`. I derived eight
filenames from the note's shorthand instead of enumerating the directory. **A grep against a filename
you guessed returns absence, not evidence.**

No action: enforcement is intact, and `route-auth-coverage-invariant` already carries an enumerated
exemption roster (35 public, 1 manual-auth, 54 disabled) for the auth dimension.

## V-1972 — the SDK's audit-log filters were untested end to end (2026-08-27)

`packages/sdk-typescript/src/resources/audit-log.ts` was the lowest-covered file in the gate's summary:
**0 of 14 branches**, 2/5 statements, 2/5 functions. **Boundary: those figures are from the full-gate
`coverage-summary.json`, so they describe the whole suite's coverage of that file, not one test's.**

Every uncovered branch was a query-building spread — `...(query.action !== undefined ? { action } : {})`
and its siblings in `list` and `iterate`. The code is correct and idiomatic; what was missing is any
assertion that a supplied filter reaches the wire. **The customer-visible failure that implies is a
filter which silently stops filtering**, and no server-side test can see it because the parameter never
leaves the SDK. Cross-SDK guards pin the audit action roster and the pagination envelope, but nothing
pinned the query surface.

Added five arms to the existing test file — no new file, so no ratchet move. The load-bearing one passes
`action` ALONE and asserts the outgoing query is exactly `{ action }`: **that catches both a dropped
filter and the opposite defect of inventing `{ limit: undefined }`, which some clients serialise as the
literal string "undefined".** A second arm covers `iterate` with only `limit`, which is the mirror of
the action-only case and reaches the two arms the first four left untouched.

**Post-condition, not a derivation: branches 0/14 → 14/14, statements 2/5 → 5/5, functions 2/5 → 5/5.**
Measured from a fresh coverage run rather than inferred from "I added arms covering those branches".

⭐ **And coverage is not assertion, so it was mutation-proven too.** Deleting the `action` spread from
`list` reddens three arms including the CRITICAL one. **100% branch coverage is reachable by tests that
assert nothing about what the branches DO** — the mutation is what distinguishes arms that exercise code
from arms that check it. Source restored byte-identical; only the test file changed.

## V-1973 — the census floor could not see half the repo disappear (2026-08-27)

The full-suite gate went red on `a-workspace-declares-what-its-source-imports.test.ts`:
**Test timed out in 30000ms**. Two separate defects came out of chasing it, and the timeout was
the less interesting one.

⛔ **First, my own instrument lied about the result.** The gate wrapper ran
`verify-suite.mjs | tail -25` and reported `$?` — which is **tail's** exit status, not the suite's.
It printed `GATE EXIT 0` over a red run. The wrapper is fixed to log in full and read the exit code
directly; proved on a known-red command (`false`), where the old shape reports 0 and the new one
reports 1. **`verify-suite` itself was honest throughout** — it printed
`verify-suite: NOT TRUSTWORTHY / - vitest exited 1`. My first grep searched for `verify-suite: OK`,
so the red verdict could not match my own filter. A scan of all 341 archived gate outputs confirms
39 `OK` and 4 `NOT TRUSTWORTHY` verdicts and **zero** that claim `OK` alongside a failed file.

⭐ **Second, and the real finding: the file's non-vacuity floors were half-blind.**
`workspaces()` carried `if (!existsSync(dir)) continue;` over `['apps','packages']`, and every floor
in the file was **combined across both roots** — `>400` sources, `>2000` test files. Measured
populations: **apps/ holds 8 workspaces, 533 src and 3261 test files; packages/ holds 7, 93 and 63.**
So apps/ alone clears every combined threshold, and **losing packages/ entirely — all three SDKs,
whose dependency declarations are exactly what this file checks — passes silently.** Losing apps/
would be caught; losing packages/ would not. A union floor cannot see partial loss.

The sting: **that exact fix was already made**, in `scripts/typecheck-test-backlog.mjs`, in commit
`3eecd02d2`, with a comment explaining per-root floors in detail. The identical shape survived in the
test file beside it because that sweep matched the script and not its neighbour.

⭐ **Mutation-proved, two-sided.** Making `packages/` yield zero workspaces: the new per-root arm
fails with `workspaces found under packages/: expected 0 to be greater than 4`, while
**all four pre-existing arms PASS** (`1 failed | 4 passed`) — the file reported a clean result about a
repo missing half its structure. Renaming the root away now fails loudly with `ENOENT` across four
arms where it previously continued to a passing census. Restored byte-identical from a snapshot.

**On the timeout, the honest numbers.** The previous 10s → 30s raise recorded a solo baseline of
"2.6s" in a comment so the next person would have a number. **That number then rotted, unmeasured, to
3.86s as the repo grew** — the 11x margin quietly became 7.8x, and a 21-worker run at load 28 spent
it. A figure typed into a comment is not a measurement.

Rather than guess a larger multiple, the waste was measured and removed: `setParentNodes` was `true`
while the visitor uses only `forEachChild` and type predicates and never reads `node.parent` —
**949ms → 637ms over all 3324 test files, with byte-identical specifier output on every one**. Arms 1
and 2 both walked and re-parsed the same 626 `src` files, so parsing is now memoised by path (only
for the read-from-disk case; a caller passing `code` is handing over one script block of a template,
where the same path legitimately yields different results). **Net: 3.86s → 2.57s, 33% faster while
adding a fifth arm.**

⭐ **But parse is ~1.5s of a ~3s run — there is no hot spot; the work is genuinely I/O over ~4000
files.** So the clock was set to accommodate contention and **regression detection was moved to the
instrument that can actually carry it**: under variable load a wall-clock timeout fires on a busy box
and passes on an idle one regardless of the code, whereas a census floor fails on its own evidence.
The floors are now per root, which is why raising the timeout costs no coverage.

## V-1974 — two SDK recorders could not observe the query they were named for (2026-08-27)

Enumerating the request recorders across the 18 `packages/sdk-typescript/tests` files that declare
one: **12 push `opts` wholesale** (query observable), **3 copy named fields including `query`** (the
`*-iterate` files, built for it), and **3 copy named fields and drop it** — `agent-sessions`,
`egress`, `recipes`.

⛔ **A first pass over-flagged 13 of 18 as "cannot assert query", including `audit-log-export`, where
I had just written five passing arms that assert `seen[0]?.query`.** Its recorder pushes `opts`
wholesale, so a check for field-by-field copying missed it. The discriminator is wholesale-push
versus named-field copy, not the presence of a `query` key — the corrected split is above.

Of the three that drop it, **`egress` builds no query at all**, so its recorder is harmless. The
other two were real:

⭐ **`recipes.test.ts` had an arm literally titled "list forwards pagination query params only when
present" that tested neither half.** It called `list()` with no arguments — the absent direction
alone — and the recorder it asserted against destructured only `{method, path, body}`, so **even a
passing query could not have been seen.** The forwarding half was untestable by construction.

⭐ **`agent-sessions.test.ts` had no `list` or `iterate` arms at all** — 19 arms covering create, get,
message, close, takeover, handback and livekitToken, with the entire pagination surface (method, path
and query alike) untested.

Both recorders now capture `query`, **recorded only when non-empty**. That is the property under
test, not a convenience: `list()` with no arguments must put no key on the wire, which reads as the
absence of `query`. Recording an empty object would make the absent case indistinguishable from
`{ limit: undefined }` — the defect where a client serialises the literal string "undefined" into a
URL. A key present with an undefined value still has length 1, so it is still recorded and caught.

Arms: recipes 5 → 9, agent-sessions 19 → 23. Each assertion sits in its own arm so a mutation cannot
be masked by an earlier failure in a bundled one.

⭐ **Mutation-proved against the real subject, and — the load-bearing half — proved that HEAD was
blind to the same mutation.** Deleting the `cursor` spread from `RecipesResource.list` reddens 3 new
arms; **HEAD's test file passes 5/5 against that identical mutated source.** Deleting it from
`AgentSessionsResource.list` reddens 2 new arms; **HEAD's passes 19/19.** So the SDK could have
silently stopped threading pagination cursors — the walk repeating page 1 or stopping early — and
nothing in either file would have reddened. Sources and tests restored byte-identical from snapshots.

The `iterate` arms are the ones that carry that: they assert page 2 requests
`{ limit: 1, cursor: 'cur_2' }`, which a count of yielded items cannot see.

⛔ **A truncated grep nearly produced a false finding.** `account.ts` sends `query: { keep: 'current' }`
under a comment recording that omitting it "made this method a guaranteed 400 in every SDK", and
`grep -rn keep … | head -4` returned only unrelated matches — reading as an unpinned past regression.
It is pinned: `untested-resources.test.ts:114` is a CRITICAL arm asserting exactly that query. The
two irrelevant files sort first, and `head -4` cut the real hit. **A truncated read is a scoped
search.** Full SDK suite after the change: 31 files, 352 tests, green; `tsc` clean.

## V-1975 — the timeout family, swept by shape rather than by the file that failed (2026-08-27)

The gate after V-1973/V-1974 came back red again, on a _different_ file with the _identical_ shape:
`no-request-body-reaches-a-logger.test.ts`, **Test timed out in 10000ms**, walking and TS-parsing
`apps/server/src`. V-1973 had fixed one walker; this is the same family one file over — the exact
failure mode recorded that morning as "a fix applied to the file you were looking at is a fix to one
call site of a shape".

⭐ **The instrument fix from V-1973 proved itself immediately.** The rewritten wrapper printed
`=== GATE EXIT 1 (verify-suite's own, not a pipe's) ===` beside `verify-suite: NOT TRUSTWORTHY`. The
old shape would have printed `GATE EXIT 0` over this red, exactly as it did before.

**Scoping the sweep honestly, because the first cut was far too wide.** 353 test files call
`readdirSync`, and 350 run on the 10s default — but only two have ever timed out, so "walks the
filesystem" is the wrong predicate. The expensive combination is _walking a tree AND parsing it
through the TypeScript compiler_: **16 files, 15 of them on the default**, 9 of which also walk
recursively. That is the family.

⭐ **Measured before touching anything.** All nine run in **4.7s of test time COMBINED (~0.5s each)**
on a quiet box. So the file that failed needed >10s for ~0.5s of work — roughly **20x starvation**,
on a machine a second workload was holding at load 50. Nothing here is slow; the box was
oversubscribed.

⛔ **My floor detector over-flagged four of the nine as having no non-vacuity guard at all.** Reading
them refuted it: they carry **exact count pins**, which are stronger than thresholds —
`route-auth-coverage-invariant` `toHaveLength(307)`, `openapi-route-coverage` `toBe(234)`/`toBe(256)`,
`effective-account-header-authz-invariant` `toHaveLength(32)`, `route-mutation-ratelimit`
`toHaveLength(173)`. The regex only knew `toBeGreaterThan` and `toContain`. **All nine are guarded** —
five by floors, four by exact pins.

That is what makes the change free rather than a wave-through: a wall-clock timeout fires on a busy
box and passes on an idle one regardless of the code, so it was never the detector here. The census
assertion is, and it is intact and strong in every one of the nine. `vi.setConfig({ testTimeout:
60_000 })` therefore costs no coverage — ~120x the measured solo cost.

⭐ **The config placement was mutation-proved, not assumed.** Setting one file's value to `1` produces
`Test timed out in 1ms`, so the inserted `vi.setConfig` is honored where it sits rather than being a
decorative comment above nine files. Restored byte-identical. `it(` counts unchanged against HEAD in
all nine; nine files, 63 tests, green; `tsc` clean.

### V-1975 addendum — what the timeout raise actually traded away (2026-08-27)

V-1975 says raising the family's clock "costs no coverage", and that is true of _coverage_ — every
assertion those nine files make is unchanged, and their exact count pins and floors are intact. But
the claim deserves its other half stated plainly rather than left to imply nothing was given up.

**A 10s timeout did detect one thing the pins do not: a runtime regression that returns the right
answer slowly.** After the raise, a census walk that got 10x slower while still finding the same 307
routes would pass. Checked rather than assumed: the bench suite is **3 files / 11 benchmarks**
(auth-cache, rate-limit, webhook-signature) and **none of them walks or parses the source tree**, so
nothing else monitors that runtime either.

That trade is still the right one, for reasons worth recording:

- The 10s clock was never a _reliable_ runtime detector. It fired at load 50 and passed at load 8 on
  identical code — it reports the box, not the regression. Keeping an unreliable detector because it
  is the only one is how a flaky red gets re-run until green.
- A slowdown in a **test-only** census costs CI minutes, not customers, and a gross one still surfaces
  in the suite's own `Duration` line (487s → 741s across today's runs, which is exactly how the
  contention was spotted in the first place).

⛔ **The honest boundary: after V-1975, correctness regressions in these nine walks are caught by
their pins; runtime regressions in them are caught by nobody.** Recorded so the next person reads a
measured trade rather than an unqualified "free".

## V-1976 — the same pagination blind spot in the other two SDKs (2026-08-27)

V-1974 closed the `recipes` / `agent-sessions` query gap in the TypeScript SDK. The pagination
contract is cross-SDK, so the obvious next question is whether Python and Go carried it too. They did.

**Matrix, measured before touching anything** — does any test assert that a caller's `limit`/`cursor`
reaches the wire?

|        | recipes            | agent_sessions     |
| ------ | ------------------ | ------------------ |
| ts     | ✓ closed in V-1974 | ✓ closed in V-1974 |
| python | ⛔ none            | ⛔ none            |
| go     | ⛔ none            | ⛔ none            |

⛔ **The detector that built that matrix produced a false positive first**, and it is worth recording
because the token was the problem: a bare `limit` search "found" a hit in
`test_resources_agent_sessions.py` that was the substring inside
`"https://errors.driftstack.dev/rate-limited"`. Re-run with word boundaries: **zero** `\blimit\b`,
`\bcursor\b`, `\bparams\b` in that file. Its 22 tests covered create, get, message, close, takeover,
handback and livekit_token — precisely the shape the TS file had.

⭐ **All three implementations are CORRECT; this is a coverage gap, not a live defect.** Read rather
than assumed: Python builds `_encode_query({"limit": limit, "cursor": cursor})` which skips `None`
(`if value is None: continue`), Go guards with `if query.Limit > 0` / `if query.Cursor != ""`, and the
server parses via the shared `PaginationQuerySchema` with a conditional cursor forward. The chain is
sound end to end.

⛔ **A second false alarm, from my own extractor.** `_encode_query` is defined FOUR times — copied into
`agent_sessions.py`, `recipes.py`, `profiles.py`, `profile_snapshots.py`, 14 call sites, 0 test
references. My body-slice regex stopped only at `def`/`class`, so one copy ran on into unrelated
constants and I printed "⛔ THEY HAVE DIVERGED". **The four bodies are byte-identical.** Extract both
ends of a body, not just the start.

⭐ Also refined honestly: Python's shared `iterate_paginated` **is** well covered (26 direct test
references, and it guards a non-advancing cursor). So the Python risk was narrower than the TS one —
the unpinned path was `_encode_query` → URL, not the pagination loop.

Arms added: python recipes 6 → 12, python agent_sessions 22 → 28, go recipes 4 → 6, go agent_sessions
+2. Both languages get the absent direction, limit-alone, cursor-alone, and a cursor-threading
`iterate` arm; Python gets async mirrors because, as that suite's own docstring puts it, the async
method "is a separate method and therefore a separate chance to omit the query".

⭐ **Mutation-proved in both languages, and — the load-bearing half — HEAD proved blind to the same
mutation.** Dropping `cursor` from both Python `list()` calls: 4 new tests fail, **HEAD's 6 and 22
pass**. Removing the `q.Set("cursor", …)` from both Go `List` methods: 4 new tests fail, **HEAD's
whole Go suite passes `ok`**. Sources restored byte-identical, confirmed by an empty `git diff`.

Post-conditions: Go `go test -count=1` (cache-busted, because the first restore run reported
`(cached)` and a cached pass is not a measurement) and `go vet` both clean; Python **377 passed, 9
skipped** (was 365), ruff check and format clean, mypy clean. ⭐ And ruff's scope was proved rather
than trusted: a deliberately misformatted function in one of the two files is caught with
`Would reformat`, so "already formatted" is a real pass and not a silent exclusion.

## V-1977 — the SDK surfaces are identical; what diverged is what their tests check (2026-08-27)

Having found the same pagination hole in all three SDKs (V-1974, V-1976), the question one level up
is whether the surfaces themselves diverge. **They do not.** Measured across
`packages/sdk-{typescript,python,go}`:

- **19 / 19 resources present in all three.**
- Every TypeScript method has a counterpart in Python and Go.

⛔ **Every apparent gap the first pass produced was my own naming model, not a real one** — five in a
row, each refuted by reading:

| flagged as missing                    | reality                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `profiles.import` absent from Python  | Python spells it `import_` — `import` is a **keyword**                             |
| `usage.current` absent from Python/Go | Python `current_period`, Go `CurrentPeriod`                                        |
| `cryptoOrders.listAll` absent         | Python/Go spell that walk `iterate`                                                |
| `api-keys` resource absent from Go    | Go names the type `APIKeysResource` — **idiomatic initialism caps**, not `ApiKeys` |
| 19 × `constructor` "missing"          | a TS-only construct with no Python `def`                                           |

⭐ **And the two genuinely TS-only methods are deliberate, documented cross-SDK aliases**, which is the
opposite of a defect. `UsageResource.currentPeriod` is a synonym for `current`, and its doc says why:

> "The Python (`current_period`) and Go (`CurrentPeriod`) SDKs name this operation after the billing
> period it reads; TS keeps the historical `current` name and exposes `currentPeriod` as a thin
> synonym so the three SDKs share a vocabulary and a customer porting between them does not hit a
> rename."

`cryptoOrders.listAll` beside `iterate` is the same pattern, and `iterate` delegates to the shared
paginator specifically so the endpoint inherits the non-advancing-cursor guard.

⭐ **The finding is the contrast, and it is what makes V-1974/V-1976 worth having done.** Surface
parity was already **100%** while _test_ parity had a four-cell hole: `recipes` and `agent_sessions`
pagination was asserted in no SDK before V-1974 and in only one after it. **The three SDKs implement
the same product faithfully; what drifted was what each language's tests were willing to check.** A
cross-SDK parity guard that compares _surfaces_ would have reported green throughout — surface
symmetry is not evidence about assertions.

**Boundary, stated with the result:** this measures the public _method surface_ by name only. It says
nothing about behavioural equivalence, argument shapes, or return types, and nothing about test
coverage — which is precisely where the real divergence was.

## V-1978 — three shipped SDK methods had no test in any language (2026-08-27)

V-1977 established that the three SDK _surfaces_ are identical and that the divergence lives in what
each language's tests check. Turning that into a measurement: for every public TS method, is it
referenced by the TypeScript, Python **and** Go test corpora?

**Three methods are referenced by none of them** — confirmed by direct search over every naming
convention (`rotateSecret` / `rotate_secret` / `RotateSecret`, and likewise for the others):
**0 references, in any SDK.**

| method                  | route                                 | verdict               |
| ----------------------- | ------------------------------------- | --------------------- |
| `webhooks.rotateSecret` | `POST /v1/webhooks/:id/rotate-secret` | implemented correctly |
| `team.listTeams`        | `GET /v1/teams`                       | implemented correctly |
| `team.renameTeam`       | `PATCH /v1/teams/:id`                 | implemented correctly |

⭐ **Audited end to end before writing a line of test: all three are sound in all three languages.**
Verbs, paths, bodies and documented scopes match the server — `team.ts:155` registers
`app.get('/v1/teams')` under `read`, `:166` registers `app.patch('/v1/teams/:id')` under
`account_owner` with `RenameTeamBodySchema`, and `webhooks.ts:321` serves the rotate route. This is a
pure coverage gap, not a live defect. It is worth closing anyway because `rotateSecret` **mints a
credential and returns the plaintext exactly once** — a client that dropped a response field would
lose a secret the server will not show again.

⛔ **An earlier grep for the team routes returned nothing and I did not treat that as absence** — the
pattern was wrong for the file's style, and the routes are there. An empty grep is not evidence.

⭐⭐ **The most valuable thing here is a vacuous arm that mutation testing caught before it shipped.**
The two Python encoding arms matched a respx route written as `/v1/teams/team%2Fwith%20space`. **respx
percent-DECODES the pattern before matching**, so that route also matches a request that sent the
slash _unencoded_ — the arms passed with `quote()` removed from the source. Proved by observing what
the mutated SDK actually sends: `b'/v1/teams/team/with%20space'`. Rewritten to assert
`request.url.raw_path`, they now fail under that mutation. **Two arms that could never fail were
indistinguishable from two that worked, right up until the mutation.**

The same trap in Go was avoided the same way: `r.URL.Path` is already decoded, so the arms assert
`r.RequestURI`. A first draft carried a `t.Logf` fallback instead of an assertion — a branch that
cannot fail — and was replaced.

⭐ **Mutation-proved in all three languages, and HEAD proved blind to every mutation.**

- TS — dropping `encodeURIComponent` from `renameTeam` and `body: {}` from `rotateSecret` reddens the
  two new CRITICAL arms, while **the entire TS SDK suite at HEAD passes: 31 files, 352 tests.**
- Python — dropping `json_body={}` from both `rotate_secret` calls reddens 2 arms; dropping `quote()`
  from both `rename_team` calls reddens the 2 rewritten encoding arms.
- Go — dropping `url.PathEscape` from both methods reddens both arms, while **the whole Go suite at
  HEAD reports `ok`.**

Sources restored byte-identical in every case, verified by an empty `git diff`, and one mutation
script aborted on its own assertion (`n==2` when the async spelling differed) rather than silently
mutating nothing — the run that followed it was correctly discarded as evidence.

Post-conditions: TS **359 tests** (was 352) and `tsc` clean; Python **384 passed, 9 skipped** (was 377) with ruff check, ruff format and mypy clean; Go `vet`, `go test -count=1` and `gofmt` all clean.

## V-1979 — 38 SDK methods are tested in TypeScript only, and four in no language at all (2026-08-27)

V-1978 closed the three methods no SDK tested. Widening the same measurement — for every public TS
method that Python **and** Go also implement, is it referenced by each language's test corpus? —
gives the shape of what is left:

**38 methods are implemented in Python and Go, covered in TypeScript, and untested in at least one of
the other two.** The detector was spot-checked against direct greps rather than trusted: for
`refresh`, `signup`, `mfa_step_up`, `mfa_challenge`, `transfer`, `set_byok_anthropic_key` the Python
corpus has **zero mentions at all**, not merely zero call sites.

The distribution is lopsided and worth naming: **Python's `test_resources_auth.py` covers 3 of ~15
auth methods** — only the `cli-authorize` trio — while Go's `auth_test.go` covers 9. So "the SDKs are
at parity" (V-1977) and "the SDKs are equally tested" are very different claims.

⭐ **Closed here: the four untested in BOTH Python and Go** — the intersection of security-critical
and doubly-uncovered.

| method              | route                         |
| ------------------- | ----------------------------- |
| `auth.verifyEmail`  | `POST /v1/auth/verify-email`  |
| `auth.refresh`      | `POST /v1/auth/refresh`       |
| `auth.mfaChallenge` | `POST /v1/auth/mfa/challenge` |
| `auth.mfaStepUp`    | `POST /v1/auth/mfa/step-up`   |

Audited before writing tests, as with V-1978: **all four are correct in all three languages**, same
verb and path throughout. Again a coverage gap, not a live defect.

⭐ **The load-bearing arm is the MFA factor split.** `code` and `recovery_code` are alternatives —
`omitempty` in Go's `MfaChallengeRequest`/`MfaStepUpRequest` — so a challenge answered with a TOTP
code must put **no** `recovery_code` on the wire, and the recovery answer must carry no `code`.
Sending an empty string beside a real factor is a different request than the caller made. Both
directions are pinned, in both languages.

The other arms pin what a caller cannot recover if it is dropped: `refresh` must return the **rotated**
token (returning the old one silently pins a caller to an expiring session) with a decodable
`expires_at`; `verifyEmail` mints the web session; `mfaStepUp` returns `mfa_satisfied_at`, which is how
a caller knows how long the step-up lasts.

⭐ **Mutation-proved in both languages, with HEAD blind to every mutation.**

- Go — removing `omitempty` from `MfaChallengeRequest.RecoveryCode` makes the key appear on a
  code-only request and reddens the new arm; **HEAD's whole Go suite passes.**
- Python — the body is forwarded verbatim there, so what these arms actually pin is the **route**, and
  that is what was mutated: `step-up → challenge` and `refresh → login` redden 4 arms, while **the
  entire Python suite at HEAD passes: 384 tests.** Naming what an assertion really pins matters — the
  Go arm pins serialisation, the Python one pins routing, and mutating the wrong thing would have
  "proved" nothing.

Sources restored byte-identical, verified by empty `git diff`. Post-conditions: Python **391 passed,
9 skipped** (was 384) with ruff and mypy clean; Go `vet`, `go test -count=1`, `gofmt` clean.

⛔ **Still open — the remaining 34**, recorded so the next pass has the list rather than the count:
`account.{clearAvatar, listWebSessions, rateLimits, revokeWebSession, updateMe, uploadAvatar}` (go),
`account.{clearByokAnthropicKey, getByokAnthropicKey, setByokAnthropicKey, testByokAnthropicKey}` (py),
`account.{getBundledLlmSettings, getBundledLlmStatus, updateBundledLlmSettings}` (py+go),
`agent-sessions.{resume, sendInputEvent, setMode}` (py+go),
`api-keys.revoke` (go),
`auth.{confirmPasswordReset, consumeMagicLink, logout, requestMagicLink, requestPasswordReset, signup}` (py),
`profiles.{import, launch, listTrash, purge, transfer}` (py+go), `profiles.trim` (py),
`sessions.extract` (py+go), `sessions.{interact, wait}` (go),
`team.{listInvites, listMembers}` (go).

## V-1980 — "Mints a copy" was the one sentence customers had, and it implied the opposite (2026-08-27)

Auditing `profiles.transfer` end to end — one of the methods V-1979 left untested in Python and Go,
picked because a cross-account ownership change is where an authz bug would hide.

⭐ **The authorization and concurrency are sound, and better than I expected.** `transferProfile` looks
the source up owner-scoped (`findById({ id, accountId: sourceAccountId })`, null → 404), so you cannot
transfer a profile you do not own. The recipient cap is measured against the RECIPIENT. Retiring the
source and inserting the recipient row happen in ONE transaction with a checked claim — the comment
records the concurrent-transfer bug that motivated it, where two transfers of the same source to
different recipients both "succeeded" and one profile became two. The route honours
`X-Driftstack-Account` (V-734) and compares the self-transfer guard against the SOURCE account rather
than the caller.

⛔ **What the audit did find is what the customer is told.** A transfer moves the profile RECORD —
name, archetype, description — and mints a **fresh** data key bound to the recipient. It does **not**
move the profile's stored browser state: there is no blob copy anywhere in the path. That is correct
and deliberate; the server cannot re-encrypt, and D-2026-07-12-01 names "moving a genuinely
authenticated profile would risk transferring session cookies or other credentials" as a risk to
avoid. **But every customer-facing surface said only "Mints a copy in the recipient's account"** —
identical wording in all three SDKs — with no top-level `description` on the OpenAPI operation at all.
"Copy" reads as "the contents come too", which is the opposite of what happens.

Corrected in all four places, and the retirement was verified as a **post-condition**: `Mints a copy`
now returns **0 occurrences** repo-wide, rather than deriving that three edits landed.

⭐ **The guard pins the docs AND the behaviour, because a pin on comment text defends a false claim
just as happily as a true one.** Two arms, kept separate so a mutation cannot be masked:

- all three SDKs plus the OpenAPI description carry the warning and point at export/import, and none
  still says "Mints a copy" — four surfaces is four places a correction gets applied to three of;
- `transferProfile` still mints `mintProfileIdentity(args.recipientAccountId)`, inserts
  `transferIdentity.wrappedDek`, and **never references `source.wrappedDek`** — the source key is
  bound to the SOURCE account's TMK, so carrying it across accounts would hand the recipient a key
  wrapped under someone else's master key.

Mutation-proved on the real subjects: stripping the warning from the **Go** SDK alone reddens the
first arm (`Go warns the stored state does not move`), and changing the service's insert to
`wrappedDek: source.wrappedDek` reddens the second. Both restored byte-identical.

⛔ **Two of my own instruments failed on the way, both caught by reading.**

- A grep for `wrappedDek` near "transfer" reported the fresh-key property unpinned. It is pinned —
  `profiles-service.test.ts:1039` **unwraps the DEK with the RECIPIENT's account id and asserts 32
  bytes**, which is stronger than anything I was about to add. The test spells it "wrapped DEK" with a
  space; my token could not match it. Sweep the shape, not the token — ninth such over-flag today.
- My body extractor for `transferProfile` bounded only the start and threw on the end, the same defect
  that produced a false "DIVERGED" verdict in V-1976. The guard's own extraction bounds **both** ends
  and asserts the slice is non-trivial before reading it.

⛔ One detail worth keeping: the OpenAPI description is built by string concatenation, and my first
draft split "STORED BROWSER STATE does not move" across a `' + '` boundary — **the guard failed
against text that read correctly in the source.** The phrase now sits in a single literal with a
comment saying why.

Boundary: this audited the route, the service and the three SDK call paths by reading, and pinned the
result. It did not execute a transfer against a live database — the existing integration suite
(`profile-transfer.test.ts`, `db-profile-transfer-concurrency-drizzle.test.ts`) does that, and neither
asserts anything about the stored state either way.

Post-conditions: 9 affected test files / 114 tests green; `tsc` clean on src and tests; Python 391
passed with ruff and mypy clean; Go vet, test and gofmt clean.

### V-1980 follow-up — the guard I wrote tripped two guards of its own (2026-08-27)

The gate after V-1980 came back RED on three files, all mine, from two root causes. Both are worth
recording because each was a rule I already had.

⛔ **I wrote the exact construct my own standing instructions name.** The first draft of the cross-SDK
arm matched `/STORED BROWSER STATE does\s*\n?\s*(?:\*|#|\/\/)?\s*not move/i` to tolerate a line wrap
across four comment styles. `a-parity-regex-may-not-be-ambiguous-about-whitespace` failed it:
_"these guards carry a redundant ambiguous-whitespace construct; it is identical to `\s_`and hangs
the suite when the match fails"*. That is verbatim the third standing lesson —`\s*\n?\s*`accepts
precisely what`\s\*` accepts and backtracks catastrophically on a miss.

The fix is not a narrower regex. The phrase is kept **contiguous in all four sources**, so the arm is
a plain `toContain` and needs no whitespace tolerance at all — the defect class is removed rather than
patched. Post-condition: **0** occurrences of the construct remain in the file.

⛔ **And a source edit had a committed generated artifact downstream that I did not think to look
for.** `packages/sdk-python/openapi.json` is a dumped copy of the spec, checked in and read by
**thirty-one test files**; adding an operation `description` made it stale, failing both
`openapi.test.ts` and `sdk-python-openapi-snapshot-sync`. The nine tests I pre-ran did not include
either, because I picked them by _reading the files I had touched_ rather than by asking **what is
generated FROM the file I touched.**

⭐ Regenerating had a trap of its own: `npm run sdk:python:dump-spec` writes expanded JSON while the
committed copy is prettier-formatted, so the raw dump produced **6974 insertions / 1698 deletions**
for a one-line semantic change. Running prettier collapses it to **1 file changed, 1 insertion** —
exactly the new description. A diff that large for a one-line change is the signal to stop and format,
not to commit.

## V-1981 — the BYOK credential surface says four things; all four are true (2026-08-27)

Audited `account.{get,set,clear,test}ByokAnthropicKey` — customer-managed Anthropic keys, and the
methods V-1979 left untested in Python — by taking each claim in the SDK doc comments as a testable
assertion about the server. **All four hold.**

| claim                                                | verdict                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| get returns "metadata only… never the plaintext key" | ✓ returns `{has_key, set_at, last_used_at}` and nothing else                          |
| get needs "broad read **or** account_owner"          | ✓ route requires `read`, and `auth.ts:796` makes `account_owner` satisfy bare `read`  |
| set / clear / test need `account_owner`              | ✓ all three                                                                           |
| clear is "idempotent"                                | ✓ unconditional `clearKey` → 204, no 404 on an already-cleared key                    |
| test runs "without ever echoing it back"             | ✓ returns `{ok}` or `{ok,reason}`; **every `reason` is one of five module constants** |

⭐ The surrounding code is better than the docs promise: clearing or rotating **evicts the plaintext
already handed to live sessions** (V-730 — "a clear that does not revoke is not a clear"), and an
idempotent clear still emits an audit entry so an operator investigating a "key disappeared" report
sees every DELETE attempt.

⛔ **I twice concluded a property was unpinned and was twice wrong.** The production tester's
reason-boundedness is pinned directly and thoroughly — `anthropic-key-tester.test.ts` asserts the
result never contains the upstream body, the key, an internal hostname, or the IP, across the invalid
/ rate-limit / 5xx / network paths. My candidate guard would have been redundant. Note the distinction
that nearly misled me: `byok-anthropic-test-metrics.test.ts` pins the metric label through an
**injected** `testResult`, so it never exercises the production default — the boundedness evidence
comes from the other file, not that one.

Boundary: this audited the four routes, the tester service and the scope-resolution rule by reading,
and verified each documented claim against them. No code changed; nothing was executed against a live
Anthropic endpoint.

## V-1982 — the agent-session control surface documents eight things; all eight are true (2026-08-27)

Same method as V-1981, applied to `agent-sessions.{setMode, resume}` — the human-takeover control
surface, and two more of the methods V-1979 left untested in Python and Go. Each sentence of the SDK
doc comment was taken as a testable assertion about the server and traced to the code that
implements it.

**`setMode` — five claims, five verified.**

| claim                                                                        | where it holds                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| "atomic dual-column write of `mode` + `pair_mode_state`"                     | `setModeIfActive` is one `.set({ mode, pairModeState, updatedAt })`                                           |
| "…and the lifecycle predicate is part of the same UPDATE"                    | `.where(and(eq(id), eq(status …)))` — a close winner gets neither a late overwrite nor the audit entry        |
| "transitioning INTO 'pair' initializes to `{kind:'ai-driving'}`"             | `target === 'pair' ? initialPairModeState() : null`, and that helper returns exactly `{ kind: 'ai-driving' }` |
| "transitioning OUT clears it to null"                                        | the `: null` arm of the same expression                                                                       |
| "idempotent — a no-op returns the existing row, `pair_mode_state` preserved" | `if (rec.mode === target)` returns `rec` untouched **before** any write                                       |

⭐ The idempotency claim is the one that would matter most if it were false: a no-op `pair → pair`
that re-initialised the state would clobber a live takeover back to `ai-driving`. It returns early,
before the write, so it cannot.

**`resume` — three claims, three verified.** Returns exactly
`202 { status: 'resume_requested', session_id }`; 409 when the session is not active; and the 404
genuinely does not leak existence — `rec === null || !callerCanAccessAgentSession(...)` raises the
**same** `NotFoundError`, so an unknown id and another account's id are indistinguishable.

⭐ The route also carries a tier gate the SDK doc does not mention, and the comment explains why it
exists: without it "a free/personal account creates a `mode:'manual'` session (open on every tier) and
flips it LLM-driven here, bypassing the tier matrix entirely". Manual-ward flips stay open on every
tier deliberately — "handing back to a human must never be tier-refused, even after a mid-session
downgrade." Undocumented in the SDK, but that is server-side enforcement, not a customer promise.

**Tallying the three audits this session: ~17 documented claims checked across a credential surface,
a control surface and an ownership transfer. Sixteen were accurate. One was not** — `transfer`'s
"Mints a copy in the recipient's account", fixed in V-1980. That ratio is the useful result: the SDK
doc comments in this repo are load-bearing and generally trustworthy, which is exactly why the one
misleading sentence was worth correcting rather than shrugging at.

Boundary: all three audits verified documented claims against the route, service and repository code
by reading. None executed against a live database or a live provider endpoint; the existing
integration suites do that, and none of them asserts the specific doc claims checked here.

## V-1983 — the webhook dual-sign promise, traced end to end and attacked (2026-08-27)

V-1978 pinned the _call_ to `rotateSecret`; it never checked the behaviour that method promises —
"the previous secret stays active for 24h during which Driftstack dual-signs every outbound delivery
(both new + old HMAC)". If that were false, **every customer who rotated would silently lose
deliveries** the moment their verifier saw an unknown signature. Traced the whole chain.

**Six links, all sound.**

1. **Customer rotate** stores the old secret and `secret_prev_expires_at = now + graceMs`, where
   `graceMs = opts.graceMs ?? 24 * 60 * 60 * 1000` — the documented 24h.
2. **Server force-rotate** (the 91-day auto-rotation) sets `secretPrev` ← current secret **and**
   `secretPrevExpiresAt` ← the 7-day deadline, alongside `graceWindowEndsAt`.
3. **Both delivery paths dual-sign** — `webhook-worker.ts` and `durable-webhook-delivery.ts` each
   compute the same `prev && prevExpiresAt > now` predicate and pass `secretPrev` to the signer.
4. **The signer emits both**: `parts = ['t=…','v1=<curr>']`, pushing a second `v1=<prev>` when prev is
   supplied.
5. **All three SDK verifiers accept ANY `v1`**, in constant time — TS
   `signatureHexes.some(constantTimeHexEq)`, Python iterating `signature_hexes`, Go ranging the same.
6. **`clearStaleSecretPrev`** retires rows whose window has elapsed, keyed on
   `secret_prev_expires_at < now AND secret_prev IS NOT NULL` so never-rotated rows are untouched.

⭐ **The two grace fields look redundant and are not.** `secretPrevExpiresAt` is what the OUTBOUND
signer reads; `graceWindowEndsAt` is what the INBOUND HMAC validator reads. A force-rotation sets both
to the same instant, which reads like duplication a tidy-minded change would collapse — and
collapsing it would stop outbound dual-signing for every server-initiated rotation while every test
that mentions `graceWindowEndsAt` kept passing.

⛔ **So I attacked exactly that.** Deleting `secretPrevExpiresAt: input.graceWindowEndsAt` from
`forceRotateSecret` **still type-checks** — the dangerous kind of defect. Two integration arms in
`db-webhooks-secret-rotation-grace-drizzle.test.ts` fail on it. **The assignment is pinned, proved by
breaking it rather than by reading a test name.** Source restored byte-identical.

⛔ **And the pin I first found was the wrong kind.** `services-webhook-secret-force-rotation-content-parity`
freezes a _comment_ — "The 7-day grace window is honoured by the v2-#20 worker via
`secret_prev` / `secret_prev_expires_at`" — which is text about the behaviour, not the behaviour. Had
that been the only guard, the mutation would have survived it untouched. The real guard was in an
integration file my own scan had already listed with six mentions; I fixated on the unit row and did
not open it. Two instrument misses in one audit: the field is `secretPrev`, not `prevSecret`, so my
first sweep reported the delivery services as unaware of rotation entirely.

⭐ The customer-visible promise is itself guarded: `published-webhook-verifier-actually-verifies`
extracts the snippet **published to customers** and asserts it "accepts the OLD secret during a
rotation grace window", plus that it rejects a tampered body, the wrong secret, and a stale timestamp
— so the accept case cannot pass vacuously.

Boundary: this traced rotation → storage → both delivery paths → signer → three verifiers → sweep by
reading, and mutation-tested the single link whose redundancy invites removal. It did not deliver a
webhook to a live endpoint; the existing integration suites cover that. **No defect found and no code
changed.**

## V-1984 — Python's auth suite reaches Go's, 7 of 14 → 14 of 14 (2026-08-27)

Closing a named slice of the 34 methods V-1979 left enumerated. The auth resource is the sharpest
case of the asymmetry that entry described: **Go's `auth_test.go` covers all 14 methods; Python's
covered 7** — the three `cli_authorize` calls, plus the four V-1979 added. Seven were untested:
`signup`, `login`, `request_magic_link`, `consume_magic_link`, `request_password_reset`,
`confirm_password_reset`, `logout`.

Each new arm asserts the contract Go already asserts: POST, the exact path, and the body forwarded
verbatim. That last one is checkable because `coerce_body` passes a dict through unchanged, so an
extra or renamed key would be a different request than the caller made.

⭐ **The route pairs are the point.** `magic-link/request` vs `magic-link/consume` and
`password-reset/request` vs `password-reset/confirm` are adjacent, near-identically shaped methods —
the exact shape a copy-paste slip takes. **So that is what was mutated**: pointing `consume_magic_link`
at the request route and `confirm_password_reset` at the reset-request route. Three new arms fail on
it, while **the entire Python suite at HEAD — 391 tests — passes.** Source restored byte-identical.

⭐ The `logout` arm pins a claim its own docstring makes: it "revokes THAT token, not the session the
call authenticated with", which holds only if the supplied token actually reaches the wire in the
body. An implementation that ignored it and revoked the caller's own session would be indistinguishable
from the caller's side — the assertion is on the outgoing body for that reason.

Post-condition, measured rather than derived: **Go covers 14 distinct auth methods, Python now covers 14.** Python suite 400 passed / 9 skipped (was 391); ruff check, ruff format and mypy clean.

Boundary: this is method-and-route coverage, matching what Go's arms assert. It does not exercise the
server's auth semantics — session minting, token revocation and MFA gating are the server suite's, and
this only pins that the SDK asks the right endpoint with the caller's own body. **27 of the 34 methods
in V-1979's list remain.**

## V-1985 — the log outgrew the format hook a third time, and the live-half probe rotted with it (2026-08-27)

The gate went red on `no-formatted-markdown-outgrows-the-format-hook`: `docs/verification-log.md`
had reached **1,508,063 bytes against a 1,500,000-byte budget** — over by 8,063. I put it there,
appending an entry per finding all session. The guard exists precisely so this surfaces as a nudge
rather than as Prettier dying inside a V8 stack trace mid-commit, which is what happened before it
existed (V-1214/V-1216).

Split at V-1707 — which is fittingly the entry recording the _second_ split. **V-1500..V-1671 moved
to `verification-log-archive-through-v1671.md`** (648,445 bytes); the live file is now **861,328
bytes with 638,672 of headroom**, comparable to the previous archive's 886 KB.

⭐ **The split was verified per entry, not per file.** Counting headings would pass even if an entry's
body were truncated at the boundary, so every entry was extracted heading-to-next-heading from the
pre-split file and from the two post-split files and compared as text: **447 distinct V-numbers before,
447 after, no overlap between halves, and 0 entries whose text changed.** A first, cruder check
compared concatenated bodies and reported a 1-character difference — that was **my own reconstruction's
`rstrip`**, not the files, which is why the per-entry comparison is the one worth trusting.

⛔ **The interesting part is what the split broke silently.** The V-858 guard probes one known V-number
per half so a discovery that dropped a half fails loudly; its live-file probe was `## V-1500 `. The
third split moved V-1500 **into an archive** — and because the arm searches the _assembled_ body, the
anchor kept matching from its new home. **The arm would have gone on passing while no longer probing
the live file at all**, which is the exact failure mode it was written to prevent, one level up.

A hardcoded live anchor rots at every split, so the live half is now probed **structurally**: the live
file must contribute headings that appear in no archive. That holds across every future split without
anyone remembering to update it. Mutation-proved by pointing `LOG` at an archive — the new assertion
fails with "the LIVE file contributes headings found in no archive"; restored byte-identical, and the
`it(` count is unchanged against HEAD because the assertion joined the existing arm.

The header note now names all three archives — it had never been updated for the second split — and
the new archive is listed **literally** in `.prettierignore`, as that file's own comment demands
("a glob here would be a silent mistake").

Boundary: 12 log-reading guards pass (80 tests), the size guard passes explicitly, and `tsc` is clean
on the test project. This changed no product code. ⚠️ `apps/gui-client/src/views/ProfilesView.tsx` was
dirty in the shared tree throughout and is A2's; it is excluded from this commit.

## V-1986 — Go could not tell the single web-session revoke from the bulk one (2026-08-27)

Next slice of V-1979's list: the six `AccountResource` methods Go's tests never reached. Go pinned
`Me`, the four BYOK calls and the bulk web-session revoke; `UpdateMe`, `UploadAvatar`, `ClearAvatar`,
`ListWebSessions`, `RevokeWebSession` and `RateLimits` were unasserted. **Go account coverage is now
12 of 12.**

⭐ **One of the six is destructive if confused, and that is the one Go could not see.**
`RevokeWebSession(id)` targets the ITEM path `/v1/account/web-sessions/{id}`; `RevokeAllOtherWebSessions()`
targets the COLLECTION `/v1/account/web-sessions`. **A single revoke that pointed at the collection
would revoke every session on the account, and return the same `nil` error.** The TypeScript suite
pins that distinction explicitly — "so the single and bulk revocations cannot be confused for each
other" — and Go did not.

**Mutation-proved, and HEAD proved blind.** Repointing `RevokeWebSession` at the collection path
reddens the new arm (`raw request URI = "/v1/account/web-sessions", want the id encoded on the ITEM
path`) while **HEAD's entire Go suite reports `ok`.**

The arm asserts `r.RequestURI`, not `r.URL.Path`, for the reason V-1978 recorded: `URL.Path` is
already percent-decoded, so an arm built on it passes whether or not the id was encoded. It also
asserts the single revoke carries **no** `?keep=current` — that confirm-intent query belongs to the
bulk call, and its presence would mean the wrong method was reached.

⭐ Second property pinned: `UpdateMeRequest` is four `*string` fields with `omitempty`, so a partial
update must carry ONLY what the caller set. Dropping `omitempty` from `Timezone` reddens the arm with
`body = map[name:New Name timezone:<nil>], want exactly {name}` — a name change that also asks the
server to **clear the timezone** is a different request than the caller made.

The remaining arms pin what a caller cannot recover if it decodes wrong: `ListWebSessions` must decode
`current` as true (it is how a UI avoids offering "revoke" on the session you are using — decoding it
false makes that control self-destructive) and both timestamps; `RateLimits` must decode
`refill_per_second` as a **float** (an int would floor a sub-1/s bucket to zero and read as "never
refills") and `override_expires_at` as nil rather than empty string.

⛔ **A mutation script aborted on its own assertion and I nearly read the run that followed as
evidence.** The first `omitempty` mutation targeted `types.go`, where `UpdateMeRequest` does not live —
it is in `account.go`, and my earlier struct dump had concatenated every non-test file, hiding which
one. The assert caught it (`count=0`), nothing was mutated, and the green `go test` immediately after
proved nothing. Same shape as the aborted script in V-1976.

Post-conditions: `go vet`, `go test -count=1` and `gofmt` clean; Go account methods covered 6 → 12.
**21 of the 34 methods in V-1979's list remain.** ⚠️ `apps/gui-client/src/views/ProfilesView.tsx` is
A2's and dirty in the shared tree; excluded from this commit, and the full gate is deferred until the
tree is quiescent.

## V-1987 — "503 on every call" told customers a live feature was dead (2026-08-27)

Auditing `agent-sessions.sendInputEvent`, one of V-1979's untested methods, by the V-1980 method:
take each sentence of the doc as an assertion about the route.

The TypeScript and Go docs both said the endpoint "returns `FeatureUnavailableError` (503) **on every
call, in every mode**" and is "unavailable **everywhere, not per-deployment**". **Both are false.**
Traced through the route:

- `mode='ai'` → **409**, not 503.
- `mode='pair'` + `pair_mode_state.kind === 'ai-driving'` + `client_id` → **200
  `{kind:'pair-mode-takeover-fired', pair_mode_state}`** (routes/agent-sessions.ts:3964). It fires the
  takeover-request transition, commits it, audits it and records a heartbeat.
- only `mode='manual'`, and `mode='pair'` once the state has left `ai-driving`, reach the 503.

⭐ **And the 200 is reachable everywhere**, which is what makes "not per-deployment" wrong in the
direction that matters: `pairModeLock` is constructed **unconditionally** at `bootstrap.ts:1383`, with
no env gate. A customer reading the TS or Go SDK would conclude the whole endpoint is dead and never
build the pair-mode takeover trigger — a flow that works today and that the customer dashboard's
ManualControlOverlay is built on.

⛔ **Both files contradicted themselves.** The TS module comment (lines 42-45) documents
`'pair-mode-takeover-fired'` correctly as a real 200; the method doc 470 lines later says everything
503s. Go says "503 on every call" and, **three lines down**, explains the `client_id` "required when
the first input-event in a pair-mode ai-driving session fires the takeover-request transition".
Python was the only SDK that had it right.

⛔ **My first reading of this was wrong and further reading refuted it.** I took the `ping` branch
(:4025, returns 200 `{kind:'forwarded'}`) as a second live path. It is not: it sits inside
`currentState.kind === 'human-driving'`, and `human-driving` is produced only by a `takeover-grant`
transition that **nothing emits** — verified by grep (`kind: 'takeover-grant'` appears only as a
type-union member) and stated outright at `bootstrap.ts:1410`. So `'forwarded'` really is dead code,
exactly as the TS module comment and Python say. **I read a branch without checking whether its
enclosing guard could ever be entered.**

⭐ **The existing pin was sound and stays.** `sdk-current-state-copy-parity` requires each SDK to carry
"No deployment forwards input events" — which is TRUE, and remains true beside the corrected text: the
takeover-fired arm forwards nothing, it fires a state transition. What was false was the wording the
TS and Go docs had grown _around_ that sentence. The pin's own comment said "the route throws
FeatureUnavailable unconditionally"; it is the harness-FORWARD path that does, and the comment now
says so.

⭐⭐ **A new arm pins that nobody re-widens it — and its first draft was half vacuous.** It matched
`/503\)? on every call/`, so a re-widened doc reading "Returns 503 FeatureUnavailableError on every
call" **passed straight through**: the words between `503` and `on every call` defeated the adjacency.
Caught by mutating the Go doc back and seeing green. Widened to the phrase itself, which then
**self-tripped** on my own corrected Python text "NOT on every call" — a phrase guard cannot parse a
negation — so the doc was reworded to "not a blanket 503" instead. Both mutations are now caught:
re-widening any SDK reddens it, and renaming the `pair-mode-takeover-fired` mention reddens it.

Post-condition: **0 occurrences** of "on every call, in every mode" or of the phrase in any of the
three SDK surfaces; the pinned sentence intact in all three. Python 400 passed, ruff + mypy clean; Go
vet, test, gofmt clean; `tsc` clean on the SDK and test projects. No behaviour changed.

## V-1988 — the profile cap counts trashed rows, nothing pinned that, and the published count disagrees (2026-08-27)

Auditing `profiles.purge` / `listTrash` by the V-1980 method. Purge's doc says it frees a cap slot
"immediately (trashed profiles otherwise count toward the tier limit until the 30-day auto-purge)".
**That claim is true**, and checking it turned up two things the claim depends on.

⭐ **The two profile counts deliberately disagree, and only one is authoritative.** Side by side:

- `countByAccount` — `.where(and(eq(accountId), notDeleted))`, i.e. **LIVE only**.
- `insertWithLimit` — `.where(eq(profiles.accountId, …))` with **no filter**, i.e. **LIVE + TRASHED**.
  `transferAtomic` matches it.

The second is the one that refuses a create, and the comment records why: _"Anti-abuse (2026-06-17):
count LIVE + TRASHED against the cap… Trashed profiles still hold a row + DEK + sealed [blob]… to
hoard unbounded recoverable profiles past their limit."_ Every gating call site pairs the loose
pre-check with the atomic re-check — five call sites checked, all paired — so the loose count never
gates anything on its own.

⛔ **But nothing pinned the anti-abuse property.** Adding a `notDeleted` filter to `insertWithLimit`
reopens the hoarding hole and **type-checks**; measured 2026-08-27, that mutation passed **474 test
files / 6374 tests** — the subset of the suite mentioning profile / cap / limit / tier terms, not all
3241 — without a single failure. `every-tier-cap-has-an-atomic-backstop` pins that enforcement exists
and takes a lock, but never what it counts.

A new arm there pins **both** directions, because pinning one invites "fixing" the other: enforcement
must NOT filter `notDeleted`, and `countByAccount` must. Mutation-proved each way — adding the filter
to `insertWithLimit` reddens it, and removing it from `countByAccount` reddens it. Sources restored
byte-identical.

⛔ **The second finding is customer-facing and I did NOT fix it.** `/v1/account/me` publishes
`profile_cap` and `profile_count` side by side, and `profile_count` is the LIVE-only number while the
cap that refuses a create counts LIVE + TRASHED. A customer holding trashed profiles sees headroom the
create path will not honour, for up to the 30-day retention. The field carries **no description** in
the published spec, so there is no false text to correct — the number itself is what misleads.

**Left for the owner deliberately.** Changing what a published field counts alters the contract, which
is the same reason W-10 is parked; the schema is also frozen by a 743-character regex and read by the
dashboard's ProfilesView. The divergence is now documented at the call site in `routes/account-me.ts`
with the reason and the pointer, so the next reader meets it rather than discovering it. `docs/internal/OPEN-ITEMS.md`
does not exist in this tree, so this entry is the record.

⛔ **Three of my own instruments failed inside this audit.** A widened mutation run reported
`exit=1`/"No test files found" — zsh does not word-split an unquoted variable, so 474 paths went in as
one argument; read as evidence it would have looked like a guard firing. A mutation script aborted on
its own assertion because the target string occurs twice in the file, and the green run after it
proved nothing. And the first run's boundary was a grep for "profile", which I widened to the cap
vocabulary before trusting the zero.

## V-1989 — the storage gate counts a population the count gate deliberately does not (2026-08-27)

Following the thread V-1988 opened. The profile **count** cap counts LIVE + TRASHED, deliberately,
because "a trashed profile still holds a row + DEK + sealed blob" and excluding it would let a
customer hoard past their limit (2026-06-17). The **storage** quota does the opposite, and nothing
records a reason.

**Traced, each link read rather than assumed:**

1. Soft delete is `.set({ deletedAt, updatedAt })` and nothing else — `size_bytes` stays on the row
   and no R2 delete is issued. `profile-blob-orphan-sweeper` states the same from the other side:
   "a trashed profile still owns its blob until purge".
2. `sumSizeBytesByAccount` sums **LIVE profiles only** (`notDeleted`), and its own comment says so:
   "trashed profiles don't count toward the storage quota, mirroring the live read paths".
3. That sum is the **enforced numerator**: `getStorageState` → `assertWithinStorageQuotaForLaunch`,
   called before driver dispatch on a profile-backed create in both `routes/sessions.ts` and
   `routes/agent-sessions.ts`, and documented as "the enforceable point to block NEW state growth".
4. Retention is **30 days** (`PROFILE_TRASH_RETENTION_DAYS`), swept daily at 04:00 UTC.

⛔ **So trashing a large profile lowers the number the launch gate reads while the R2 bytes it
represents persist for up to 30 days.** An account at the hard cap can trash, launch again, and grow
new state — with real stored bytes above the cap for the retention window. That is the same shape as
the count-dimension hole, in the dimension where the bytes actually live.

⭐ **The codebase has recognised this family twice and closed it twice, in the other two directions.**
The count cap was hardened in 2026-06-17; the trash→**restore** path was hardened in 2026-06-30
("a trash+restore round-trip silently bypassed the hard cap for the entire 30-day trash retention
window"), which re-validates storage under a `FOR UPDATE` on the account row. The trash→**launch**
path in the storage dimension is the remaining member and carries no note either way.

**Boundary, stated with the result: this is a read-level finding about which population each gate
counts.** I did not execute the sequence against a live database, and nothing here proves a customer
has done it. What is established is that the two gates disagree about trashed rows, that the
disagreement is documented as deliberate on one side and unexplained on the other, and that the bytes
demonstrably survive a soft delete.

⛔ **Not changed, deliberately.** Making the storage numerator include trashed bytes changes what the
launch gate refuses for real customers — the same class of call as `profile_count` (V-1988) and W-10,
and not a sweep's to make. Recorded here for the owner; `docs/internal/OPEN-ITEMS.md` does not exist in
this tree. No guard added either: pinning the current numerator would freeze a choice that has not been
made.

## V-1990 — the cap-population sweep came back clean, and the guard watching it covers four files (2026-08-27)

Generalising V-1988's axis: for every capped resource, **which population does the enforcement count,
and is that population right?** Enumerated the enforcement methods by naming convention
(`*IfUnder*` / `*WithLimit` / `*Atomic`) across `apps/server/src/db` — 9 methods — and read each one's
count.

| resource        | counts                     | verdict                                                                        |
| --------------- | -------------------------- | ------------------------------------------------------------------------------ |
| sessions        | `isNull(destroyedAt)`      | ✓ a destroyed session must not hold a slot                                     |
| agent-sessions  | `status = 'active'`        | ✓                                                                              |
| webhooks        | `active = true`            | ✓ a disabled endpoint delivers nothing                                         |
| profiles ×2     | every row (LIVE + TRASHED) | ✓ deliberate anti-abuse, pinned in V-1988                                      |
| account-proxies | every row                  | ✓ the table has **no** soft-delete column, so every row is live                |
| api-keys ×2     | —                          | not cap gates; atomic revoke/rotate that match the name                        |
| team-members    | —                          | not a cap gate; a compare-and-swap on the invite. **No team seat cap exists.** |

Widened past the naming convention with a count-then-compare **shape** sweep (112 candidates across
`apps/server/src`) to catch caps enforced by hand. The three that were per-account row/spend caps all
resolved sound: the second `account-proxies` site is the **in-memory test double**; the monthly import
cap is a soft anti-churn ceiling (2× the tier limit) behind which the hard row cap still applies
atomically; and the bundled-LLM monthly spend cap is a **documented** read-then-act soft cap whose
comment names the race and bounds it with a per-account in-flight limiter — "the overshoot past the cap
is bounded by `limit`, not unbounded".

⛔ **So no cap is mis-counted. What the sweep did find is how little of that surface the guard sees.**
`every-tier-cap-has-an-atomic-backstop` derives its subjects from `export function *LimitFor(`
declarations. Replicating that derivation: **exactly 2 helpers exist, so it watches 4 files.**
`routes/account-me.ts` (proxy cap, reads `PROXIES_PER_TIER` directly) and `services/webhooks.ts`
(flat `MAX_ENDPOINTS_PER_ACCOUNT = 10`) enforce real per-account caps correctly and are watched by
none of it.

A new arm covers them from the other end: every conditional-insert backstop must be **reached** by a
caller outside `db/`. A resource whose cap is a flat constant is invisible to the helper-derived
pairing, so an orphaned enforcement method is the only trace left when its caller drifts back to
reading a count and hoping. **Mutation-proved two-sided**: pointing `services/webhooks.ts` at a naive
insert reddens the new arm while **all four pre-existing arms pass** — which is the blind spot,
demonstrated rather than argued. Source restored byte-identical.

⛔ **Three of my own detectors failed inside this one sweep, each caught by demanding a known
positive.** The first missed four methods because it matched drizzle's `count()` helper and they use
`sql\`count(\*)::int\``. The second returned **0** count-then-compare candidates because its alternation
listed `LIMIT|Limit|CAP|Cap|MAX|Max`and the code says`>= limit`, lowercase. The third still returned
0 after that fix, because `\b`before`>=`can never match — there is no word boundary between a space
and`>`. The control (`if (current >= limit)`exists in`services/profiles.ts`) is what exposed all
three; without it each zero would have read as "no unguarded caps".

Boundary: enforcement enumerated by naming convention in `apps/server/src/db` plus a shape sweep over
all of `apps/server/src`; caps outside both — enforced in a route with no count and no convention —
would still be missed.

## V-1991 — two non-vacuity floors had drifted 40% and 54% below their corpus (2026-08-27)

V-1990 found a guard watching four files of a larger surface. The generalisation is the same question
one level down: **how much of a population can vanish before its floor fires?** V-936/937/939 already
did this sweep once and raised floors "to just under the measured N"; two floors were missed, and both
are walks the whole suite leans on.

| guard                                                  | population now | floor was | slack   | floor now |
| ------------------------------------------------------ | -------------- | --------- | ------- | --------- |
| `a-workspace-declares-what-its-source-imports` (files) | 3,324          | 2,000     | **40%** | 3,000     |
| same, bare specifiers                                  | 4,334          | 2,000     | **54%** | 3,900     |
| `no-test-file-runs-in-no-project` (files on disk)      | 3,241          | 2,500     | **23%** | 3,000     |

⭐ **The `no-test-file` raise is demonstrated, not argued.** Truncating its walk to 2,900 files — a loss
the old floor accepted — now fails with `expected 2900 to be greater than 3000`. 741 files, more than
an entire workspace's suite, could previously have vanished with the arm still reporting non-vacuous.
The workspace-walk raise is proved to BITE (a 3-of-15-workspace walk fails at 299) but that mutation
does **not** demonstrate the improvement, since 299 would have failed the old floor too; there the
improvement is the arithmetic above, not something the mutation shows.

⛔ **And that guard's recorded measurement was wrong in a way its own file refutes.** The note read
"MEASURED: 2,891 test files on disk, **of which 29 are e2e (playwright)**" — but the NOTE forty lines
above it states the e2e specs are named `*.spec.ts`, so a `*.test.ts(x)` walk "never sees them". The
walk cannot contain a single e2e file; measured now, it contains zero. Both the count and the clause
are corrected.

⛔ **The sweep that found these was wrong at the top of its own ranking, twice.** Pairing each floor
with the nearest measurement above it ranked `every-webhook-event…` at 98% slack and
`global-scope-db-tests…` at 94% — both **false**: the extractor had grabbed the _next_ assertion in the
arm (an enum length, a sub-count), and both files' real floors were already raised to ~11% slack by
V-939. A third row paired a "2,891" comment with a `toBeGreaterThan(0)` glob check and reported 100%.
**Every candidate that survived came from reading the arm, not from the ranking.**

Boundary: floors paired with a recorded measurement within six lines, across
`apps/server/tests/**/*.test.ts` — 63 pairings, of which the three above are the ones a hand-read
confirmed. A floor whose measurement is recorded further away, or nowhere, is outside this
measurement entirely.

## V-1992 — two more corpus floors, and a way to measure one without replicating its walk (2026-08-27)

Continuing V-1991 with a cleaner discriminator than the last ranking, which was wrong twice at its
top: **which corpus floors carry no sweep marker at all?** V-936/937/939 and V-1991 leave a marker
within a few lines of every floor they raised, so their absence identifies a floor that was never
revisited. Measured across `apps/server/tests/**/*.test.ts`: **19 floors carry a marker, 370 do not**
— but most of the 370 are byte-length non-vacuity checks (`source.length`, spec file size), not corpus
counts, and their slack means something different.

Reading the file-count ones rather than ranking them:

| guard                                                 | population | floor was | slack   | floor now                                                                            |
| ----------------------------------------------------- | ---------- | --------- | ------- | ------------------------------------------------------------------------------------ |
| `a-walk-that-swallows-a-missing-root-does-not-spread` | 3,272      | 2,500     | **24%** | 2,900                                                                                |
| `a-test-arm-may-not-hide-all-its-assertions`          | 3,055      | 2,500     | **18%** | 2,750                                                                                |
| `no-permanently-skipped-tests`                        | ~3,241     | 3,000     | 7%      | left alone — already raised, and its own message records the V-1033 raise from 1,500 |

⛔ The first is **my own guard**, landed earlier today with the 2,500 floor I chose; its ceiling arm
polices walks that swallow a missing root, and its non-vacuity floor had the same slack as the walks
it polices.

⭐ **The measurement technique is the transferable part.** Twice in V-1991 I got a population wrong by
re-implementing a guard's walk in Python — once counting `node:` builtins the guard skips (12,579 vs a
real 4,334). Here each guard was made to report its **own** number instead: set its floor to `999999`,
run it, and read the count out of the assertion message —
`expected 3272 to be greater than 999999`. No replication, so no replication error.

⭐ **Demonstrated, not argued.** Truncating the walk to **2,711** files — a corpus the old floor of
2,500 accepted — now fails with `expected 2711 to be greater than 2900`. A first attempt sliced both
roots and landed at 1,411, which the old floor would have rejected too; that proves the floor bites
but not that it improved, so the mutation was redone to land between the two floors. Restored
byte-identical; 3/3 pass.

Boundary: floors `>= 20` in `apps/server/tests/**/*.test.ts`, classified by whether a sweep marker
appears within eight lines above them; the three file-count guards above are the ones a hand-read
confirmed as corpus floors. Byte-length floors were not assessed.

## V-1993 — "now + 24h grace" was true for most keys and wrong for the ones that need it (2026-08-27)

Auditing the api-keys surface by the V-1980 method. Six of the seven documented claims hold exactly:
the plaintext is returned once and never by `list`; `create` requires `account_owner`; `revoke` is
idempotent; and the "old key auto-revokes via the existing expires_at-driven auth gate" promise is
carried by **four** separate expiry checks in `services/auth.ts` — cached path, live path and two
revalidation sites, which matters because an expired key surviving in the auth cache would defeat all
three others.

⭐ **The implementation is exemplary and taught me what the docs omit.** `rotateApiKeyAtomic` takes a
`FOR UPDATE` lock, refuses an already-revoked or already-expired key, and carries two documented
anti-laundering fixes (V-775): scopes DE-ESCALATE (`driftstack_internal_admin` dropped, legacy `admin`
→ `account_owner`) because "rotation must not launder one", and `createdByAccountId` is carried forward
because a rotated key otherwise "survived removal of the member who minted it, with the same authority
and no expiry".

⛔ **What all three SDKs say is "sets the OLD key's expires_at to now + 24h grace", and two behaviours
sit underneath it that none of them mentions:**

- the grace is `min(now + graceMs, locked.expiresAt)` — it never EXTENDS an expiry, so rotating a key
  that expires in an hour buys an hour, not a day;
- the successor is inserted with `expiresAt: locked.expiresAt` — it INHERITS the old expiry, so
  rotating a key _because_ it is about to expire does not hand you a longer-lived one.

Both bite only when the key carries an `expires_at`, which **customers can set**: `expires_at` is an
optional field on `CreateApiKeyRequestSchema` and the route honours it. So the omission lands exactly
on the customer who set an expiry deliberately and then rotates near it.

⛔ **The uniformity across three SDKs was not coincidence — a guard enforced it.**
`cross-sdk-grace-window-parity` (W680) exists to catch a 12h/48h/7d drift, and its own charter states
"old key.expires_at = now + 24h". That purpose is sound and is preserved: it pins loose substrings
(`/24h grace/`, `/Both keys work concurrently during the/`) which the corrected docs still satisfy.
What it could not see is a claim that is incomplete rather than wrong.

Two arms added there, kept separate so a mutation cannot be masked: every SDK must state that the
grace never extends an expiry and that the successor inherits it, **and** the repo must still clamp
(`locked.expiresAt < candidateGraceEnd`) and still insert `expiresAt: locked.expiresAt`. Mutation-proved
both ways — replacing the Go warning reddens the doc arm; replacing the clamp with `false` reddens the
behaviour arm. Sources restored byte-identical.

Post-conditions: 32 api-keys/grace test files, 442 tests green; Python 400 passed with ruff + mypy
clean; Go vet, test and gofmt clean; `tsc` clean. No behaviour changed.

## V-1994 — the crypto-order money path documents little and gets all of it right (2026-08-27)

Audited `crypto-orders` by the V-1980 method, picked because it is the money path and the only
unaudited surface where a doc/behaviour mismatch costs a customer directly. Its SDK docs are terse —
four checkable claims rather than V-1993's seven — and **all four hold**.

| claim                                                           | verdict                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quote` previews "without minting an order"                     | ✓ `billing-crypto-quote.ts` has **0** insert/create/update calls in 114 lines, and sources price from the same `PricingService.listEffective()` the order will use |
| `createCheckout` — "send an `idempotencyKey` to dedupe retries" | ✓ atomic, see below                                                                                                                                                |
| `list` — "newest first"                                         | ✓ `listAll` orders `desc(createdAt)`; the `asc` ordering in the same file belongs to `listPendingOlderThan`, a sweeper, where oldest-first is right                |
| `cancel` — "abandon a **pending** order"                        | ✓ `cancelOrder` re-checks the pending + ownership guards **against the locked row** via `withOrderLock`, returning `not_cancellable` with the blocking status      |

⭐ **The idempotency is the part worth reading.** The key is SCOPED
(`<account_id|_anon>:<Idempotency-Key>`), so one account's retry cannot return another's order; the
unique index is **partial** (`WHERE idempotency_key IS NOT NULL`) so the many keyless orders are
unconstrained; and the dedupe is a single `INSERT … ON CONFLICT DO NOTHING … RETURNING`, with the
replay path fetching the prior order and comparing a stored body fingerprint so a key reused with a
different body is logged rather than silently honoured. The route also discards client-supplied
`price_cents`/`price_currency` in favour of the server table.

⭐⭐ **The transferable detail is the ON CONFLICT arbiter**, and the code carries the scar: a PARTIAL
unique index only matches an `onConflict` whose arbiter repeats the SAME predicate. Without the
`where`, "real Postgres raises 42P10 … and every idempotent crypto checkout 500s" — and the comment
notes it was **"invisible to the pglite/in-memory tests, only real PG enforces it."** A test double
that accepts an ON CONFLICT the real engine rejects is the failure mode that lets this ship.

Boundary: this verified the four documented claims against the route, service and repository by
reading, plus the schema for the index backing the dedupe. It did not execute a checkout against real
Postgres — which is precisely where the 42P10 class of defect appears, and the reason the existing
integration suite matters more here than anywhere else I have audited today. **No defect found, no
code changed.**

## V-1995 — swept the ON CONFLICT arbiter class repo-wide; clean, and already guarded where it matters (2026-08-27)

V-1994 surfaced a production-only failure mode worth generalising: **an `ON CONFLICT` whose arbiter
names a column backed by a PARTIAL unique index must repeat that index's predicate**, or real Postgres
raises 42P10 and every such insert 500s — and the in-memory twins do not enforce it, so tests pass.
Swept the whole server for it.

**Measured across `apps/server/src`:** 27 unique indexes in `schema.ts`, of which **7 are partial**;
**14 `onConflict` call sites**, all through the drizzle builder. Every mention of "ON CONFLICT" in raw
SQL turned out to be a comment describing one of those 14, so there is no escape hatch outside the
enumeration. Both partial unique indexes defined in migrations (`profiles_account_name_unique`,
`crypto_orders_idempotency_key_unique`) are mirrored in `schema.ts`, so classifying from the schema
does not miss one.

**Result: exactly one site targets a partial index with an arbiter — `crypto-orders-repo`'s
`insertWithIdempotencyKey` — and it correctly repeats `WHERE idempotency_key IS NOT NULL`.** The only
other site on a table with partial uniques is `session-operations-repo`'s **bare**
`onConflictDoNothing()`, which names no arbiter and therefore needs no predicate; its own comment says
so ("`ON CONFLICT DO NOTHING` covers either"), and covering either of that table's two partial indexes
is the intent. Every remaining site targets a FULL unique index.

⭐ **And the property is already guarded by the right instrument.** `db-crypto-orders-sweep-ordering-drizzle`
carries an executing arm in the **real-Postgres** integration block, with the reasoning in full: the
arbiter "must carry that same predicate or real Postgres raises 42P10 and EVERY idempotent crypto
checkout 500s. This only reproduces against real Postgres (pglite/in-memory twins don't enforce
partial-index arbiter matching)". A static guard of mine would have been strictly weaker than an
assertion that actually runs the engine that enforces it.

⛔ **My first pass reported a defect that does not exist, by the exact mechanism the dominant lesson
names.** It flagged `stripe-webhooks-repo`'s `onConflict` on `cryptoEntitlements.orderId` as targeting
a partial index with no predicate — a 42P10 in the entitlement-granting path. Reading the schema
refuted it: `crypto_entitlements_order_id_unique` carries **no** `.where`. My extractor took a
300-character lookahead from each `uniqueIndex(...)` and swallowed the `.where` belonging to the NEXT
index three lines below — matching the text BETWEEN two definitions. Re-classifying with each
definition bounded at the next one changed the partial count from 5 to 7 and cleared the accusation.

Boundary: unique indexes classified from `schema.ts` with each definition bounded at the next index
declaration, `onConflict` sites enumerated across `apps/server/src`, migrations cross-checked for
partial uniques. **No defect found, no code changed, no guard added — the existing one is better than
the one I would have written.**

## V-1996 — the flag I planned a rollout around was already on, and had been for four days (2026-08-27)

A2 found a root cryptominer on the fleet box (planted 08-21, running 08-23 → 08-27, ~600% of twelve
cores, disguised as `com.apple.airportd`; write-up in
`docs/runbooks/box-access-and-2026-08-27-incident.md`). Two consequences land on work of mine, and one
does not.

⛔ **The rollout plan I wrote this morning rested on a false premise.**
`docs/internal/warm-tabs-rollback-rehearsal-and-watched-enable.md` opens "gated default-OFF, and never
validated under load", and its Phase 0 is "rehearse the rollback **with the flag still OFF**". Warm
tabs was **already enabled** — `DRIFTSTACK_WARM_TABS=1`, durable in `node.env`, for four days. **Phase
0 as written would have flipped a flag that was already set**, and captured a "before" state that
never existed. Corrected in place: a banner at the top, the Phase 0 heading fixed, and the one
remaining in-body claim annotated so it cannot be acted on by a reader who skips the banner.
Post-condition checked — every surviving "still off" occurrence now carries the correction.

⭐ **The question I refused to collapse is what made it answerable.** That doc recorded: a bus post
shows a daemon carrying `DRIFTSTACK_WARM_TABS=1`, but the flag appears in **zero** ops records
(`ops=0 bus=8`), and _"'off on the box' and 'never ran anywhere' are different claims and only the
first is established"_. It resolved the way the ledger did not: **it ran enabled; the ops record was
simply never written.** `ops=0` meant "nobody wrote a record", not "the flag was never on". Had I
treated the ledger's silence as evidence of absence, the plan would have shipped with the wrong
premise and no trace of why.

⭐⭐ **The lesson A2 draws is the inverse of the one I spent the day on, and it is the sharper of the
two.** `harnessd.err.log` carried **43,661 lines** of `[HOST-CORES] busiest core 99% — single-core
saturation; per-session timing may diverge` out of 212,089 — **one line in five, for six days,
unread**. I spent today hand-verifying twenty-odd detectors that over-reported; here a detector
reported perfectly, named its own consequence, and got no attention at all. **Distrusting the
instrument has to mean both directions**, and only the noisy direction announces itself.

⛔ **What is contaminated, stated narrowly.** Fleet-box **timing** measurements from 2026-08-21 onward
are unreliable — a host missing half its CPU makes bursty delivery more likely, so a timing-derived
cause may be a symptom of the miner. That does **not** touch V-1965: "the inbound gate releases on a
clock, not on pressure clearing" is arithmetic over declared constants
(`min(256, tokens + elapsed × 32)`), true at any host load. And the burst-causation hypothesis A2
flags was never written into this log at all — it lived in a turn, so there is nothing to retract.
The `inbound_admission_refused` log added earlier is worth **more** now: it is the only way to tell
budget exhaustion from host starvation, and a clean host is the baseline to measure it against.

⚠️ Credential rotation remains OPEN and is **not mine**: something held root for six days, so the
fleet key, the `administrator` password and any token that lived on that box are to be treated as
exposed. My standing rules forbid credential mutation, and a peer cannot lift that — flagged here and
answered to A2 rather than acted on. SSH is now key-only
(`ssh -i ~/.ssh/driftstack_fleet_ed25519 -o BatchMode=yes …`).

## V-1997 — the suite's 16 skips, audited; and why forcing a retired guard to run proves nothing (2026-08-27)

Applying the lesson from the fleet-box incident locally: **the suite prints "16 skipped" every run and
nobody asks which.** That is the same shape as 43,661 unread saturation warnings, at a smaller scale.
So I asked.

**Measured across `apps/**/tests`and`packages/**/tests`: 169 files carry a skip construct, 188
occurrences.** Almost all are `describe.skipIf(!CI && !DATABASE_URL)` on integration files — legitimate,
and they RUN under the gate, which sets `DATABASE_URL`. The residue is a small family of
**"retire when the feature ships"** unit gates: `skipIf(hasEgressImpl)` ×6, plus `isSubscribable`,
`cryptoIsLive`, `failedIsLive`, `incidentIsSubscribable`, `hasCustomerMtls`.

Running that family directly: **10 arms skip, 64 pass.** Every skip is a retire-when-shipped gate that
has legitimately retired.

⛔ **I then made an error worth recording in full, because it nearly became a false accusation against
another agent's files.** Reasoning that V-1987 had established customer egress 503s on every
deployment, I concluded `hasEgressImpl` must be wrong and six marketing guards had retired on a false
signal. To test it I forced the condition false so the arms would run — and the honest-disclosure arm
failed with **three offenders**: `changelog.astro`, `comparison.astro`, `self-hosted.astro`, all in
`apps/marketing-site`, which is A2's area.

**Reading them refuted the conclusion.** Customer-controlled egress IS shipped — through a different
route than the one V-1987 examined. `bootstrap.ts:1230` constructs `new SocksProxyBackend()`
unconditionally and wires it at `:2842`; `SocksProxyBackend implements SessionEgressService`; and a
create carrying `proxy_id` has "the route validate ownership and the dispatch resolve it (owner-scoped
unwrap + SSRF re-guard)", gated further by a LIVE connectivity probe that blocks the launch with 422.
What is unshipped is only the per-session attach route `/v1/sessions/:id/proxy` — which is exactly
what V-1987's own doc said when it scoped its claim: _"the reusable proxy CRUD methods on this resource
are unaffected."_ So `hasEgressImpl` is right, the gate retired correctly, and all three pages are
honest.

⭐⭐ **The transferable lesson: forcing a retired guard to run does not test the code — it tests
whether the guard's premise still holds, and a retired guard fails BY CONSTRUCTION.** Its assertion
was written for a world that has since moved. "Three offenders" was not evidence of a marketing
overclaim; it was evidence that the arm retired for the reason it says it did. The probe answered a
different question than the one I asked it.

⭐ **And this gate had already solved the problem I came looking for.** `marketing-egress-claim-sweep`
carries an arm whose title is _"the sweep reached the marketing pages, and the gate below has RETIRED
— both facts stated out loud"_, with the reasoning: an `if (hasEgressImpl) return;` early-return "is
indistinguishable in the summary from a real check", so the arms are conditional skips that show in
the count **and** an arm records why. The retirement is loud, not silent.

Boundary: skip constructs enumerated across `apps/**/tests` and `packages/**/tests`; the
retire-when-shipped family executed directly to see which arms skip today. Integration skips gated on
`CI`/`DATABASE_URL`/`REDIS_URL` were classified as legitimate by their condition, not by running them
without a database. **No defect found, no code changed, and no page reported to A2 — the accusation my
own probe generated did not survive reading.**

## V-1998 — the real-Postgres seam re-measured: V-1576's number holds, its sentence does not (2026-08-27)

2026-08-27. Picked the target from the coverage artifact rather than instinct, then from prior art rather
than the artifact — the prior art was again the better lead.

**Boundary of the coverage artifact first, because it decides what the ranking can mean.** `coverage/`
(15:42 today) spans **311 files: 285 in `apps/server`, 26 in `packages/sdk-typescript`** — no api-types, no
Python/Go SDK, no front-end. Within `apps/server/src` it holds 285 of the 342 tracked `.ts` files, and
**all 55 files under `src/db` are absent** — v8 reports only modules that were _loaded_, and the run had no
`DATABASE_URL`, so every `skipIf` integration gate skipped and the persistence layer never loaded. Absent
is not 0%; it is no row at all. **No statement below is about db-layer coverage.**

### The recorded claim, re-measured

V-1576 (archived) measured 376 integration files and concluded: _"Exactly one integration file uses a real
database AND injects an HTTP request"_, then generalised one sentence further — _"Nothing drives a
customer-facing route against real Postgres."_ That sentence is the quotable one, and it is the one that
is false.

**The narrow claim holds, on a population 9× larger.** Across **every `*.test.ts`/`*.spec.ts` tracked by
git at HEAD — 3282 files, repo-wide, not one directory** — exactly one _integration_ file both reaches
real Postgres and drives a route: `atlas-priority-events-end-to-end.test.ts`, still on an internal route.
`build-test-app.ts` still wires 47 in-memory repositories and contains no `postgres(` call.

**The broad sentence is false, and V-1576 contains its own refutation.** 41 Playwright specs (215 `test()`
calls) import `./helpers/server.js`, which calls the real `buildApp`, opens `postgres(dbUrl)`, migrates,
and `listen()`s on a socket. They drive customer-facing routes — `account-me.spec.ts` exercises
`GET`/`PATCH /v1/account/me` including a **409 slug collision**, which only a real unique constraint can
produce. V-1576 knew: three paragraphs down it says _"Playwright drives the app end to end"_. The
generalisation over-reached the evidence in the same entry that supplied it. The sentence appears once, in
the archive, and is cited nowhere else — stale, not load-bearing.

### The census V-1576 gestured at but never produced

**Boundary: 41 Playwright specs vs the 166 customer-facing operations published in `openapi.json`
(234 total, 68 admin), path segments normalised.**

```
 69  (41%)  driven against real Postgres by an e2e spec
 97  (59%)  driven by no e2e spec — in-memory repos only
```

Those 97 are precisely where a V-1565-class defect (a route handing an unvalidated value to a `uuid`
column) survives: the route half answers 200 in-memory, the column half is fed already-valid values by
repo contracts, and the join is untested. **`vitest.config.ts:13` excludes `**/tests/e2e/**`**, so none of
those 215 tests run in my gate — every green gate I report has an e2e-shaped hole, and this states its size.

⛔ **My normaliser was biased toward the finding.** It collapsed `${id}` but not literal prefixed ids, so
`wsess_{}` never matched `{web_session_id}` — undercounting coverage and inflating the gap. Corrected to
normalise per _segment_; the headline did not move (69/97, because the ten mismatches were admin paths or
duplicates) and the unmatched residue fell 10 → 1. **A number that survives a real correction to its
instrument is worth more than one that was never corrected.** The single residue,
`POST /v1/oauth/authorize/complete`, is deliberate: the route-coverage guard's own `NOT_PUBLIC_API` and
`lib/openapi.ts:2613` both record it as dashboard-internal, requiring an interactive web session.

### Chasing the residue into a clean audit

The class V-1565 fixed is guarded **as a shape** — a scan for the loose hex-or-dash literal, proved by
planting it in an unrelated route. That cannot see the _no-regex_ case, so I swept the boundary parser
itself: **`uuidFromPrefixedId` is defined independently in 12 route files and exported from none**, and
its regex `PUBLIC_ID_RE` exists in **13 copies with 4 distinct spellings** — `[a-z]{3}` (10×), `[a-z]+`,
`[a-z]+` **case-insensitive**, and a literal `^sub_`.

**All four are correct, and only history shows it.** `git log -L` on each line: `sessions.ts` and
`admin-audit-log.ts` were born strict from their first commit and never accepted uppercase, so they never
needed `/i`. `profile-snapshots.ts` was born `[0-9a-fA-F-]{36}` — the loose class — which _did_ accept
uppercase hex, and its fix (`8ed6e72b4`) added `/i` to preserve the input set customers have had since
V-312. `[a-z]+` is required, not lax: `psnap_`/`prof_` are 4–5 characters and `[a-z]{3}` cannot parse them.
`admin-status-subscribers.ts` bakes the prefix into the regex (`^sub_`), so it needs no `startsWith` check
at all. **Classify divergent copies by reason, not by difference** — differencing them yielded four groups
and named the wrong file.

**No defect. No code changed.**

### ⛔ Four instrument failures in one investigation, all caught before they were reported

1. **My behavioural grouping accused the best file.** `admin-status-subscribers.ts` came out as the outlier
   "missing the prefix check" — it is the cleanest of the twelve, because its prefix is _in_ the regex.
   This is verbatim the standing lesson: a detector whose accused file is the repo's best example of the
   discipline it tests for.
2. **My comparison was mis-specified.** I "proved" sessions.ts rejects what profile-snapshots accepts using
   a `prof_` id — a 4-letter prefix sessions.ts was never meant to parse. The difference I measured was
   prefix _length_, not case. Re-running with a 3-letter prefix isolated the one real variable.
3. **A pin that stops one character short reads exactly like the covering pin.** The v312/v326e
   cross-source invariant freezes the regex body and ends at `$/` — it never asserts the `/i`. I checked
   that one file, found the flag unpinned, and generalised. **The flag is pinned twice**, proved by
   mutation: dropping `/i` reds `routes-profile-snapshots-content-parity` ("STRICT uuid shape
   (case-insensitive)") and V-927 `a-published-bound-matches-the-route`, which compares the route against
   the generated document and asserts case sensitivity **per path** — "/v1/profiles/{id} is case-sensitive
   and /v1/profiles/{id}/snapshots is not". Had I trusted the read, I would have added a redundant third
   pin and logged a coverage gap that does not exist. **Checking one member of a pin set and reporting on
   the set is the same error as a census that reports its size instead of enumerating it.**
4. **Two runs that never ran.** `--reporter=basic` is not valid in vitest 4 (it tried to load a reporter
   module), and BSD `xargs` has no `-a`. Both exited non-zero and printed nothing my grep matched; a
   summary-line grep on a run that never started is indistinguishable from a clean pass. Read the log's
   length, not just its greps.

Mutation discipline held throughout: snapshot keyed by path, anchor asserted unique (count=1), `cmp`
proving the file actually differed before the run, restore proved byte-identical afterwards, and both pins
re-run green (24 passed) on the restored source.

## V-1999 — the May e2e coverage audit's recommendations, checked: the high-leverage half is closed (2026-08-27)

2026-08-27. V-1998's census raised an obvious follow-up: prior art on the e2e layer is
`docs/internal/v540-e2e-coverage-audit.md`, which catalogued the gap between the route inventory and the
Playwright specs and sorted the gaps "by leverage" — then ended STAGED, deferring the fix to a later wave.
A staged recommendation is the same shape as the conditional deferral V-1957 found: neither open nor
closed at the moment it is written, and nothing fires when its wave arrives.

**The doc is honest about its age and needs no correction.** It carries `Date: 2026-05-10`, `Wave: 19`,
`Status: STAGED`, and its "32 route modules" is a point-in-time count, not a claim about today (there are
60). A dated audit that states its date is a record, not a stale assertion — cf. the rollup-date check.
Its follow-on wave did land: `account-me.spec.ts` is headed "V-540.B-3".

**Checked by paths driven, not by filenames.** A roster keyed on spec filename is the V-1547 error, and
`team` proves it matters here — `team.spec.ts` exists, but the `/v1/team` paths are actually driven by
`a-team-member-role-is-enforced-on-the-owner-account.spec.ts` and
`acting-as-an-owner-spends-your-own-bucket.spec.ts`. **Boundary: the `/v1/...` literals reached through
`${baseUrl}` in the 41 Playwright specs, matched against each named module's registered prefix.**

```
HIGH    account-mfa                CLOSED   5 paths
HIGH    billing                    CLOSED   3 paths
HIGH    legal                      CLOSED   3 paths
HIGH    profile-snapshots          CLOSED   3 paths
MEDIUM  auth-cli                   CLOSED   3 paths
MEDIUM  team                       CLOSED   5 paths
MEDIUM  admin-incidents            still no e2e
MEDIUM  admin-validation-harness   still no e2e
MEDIUM  admin-overview             still no e2e
```

**All four HIGH-leverage gaps are closed; two of five MEDIUM are; the residue is three admin surfaces.**
That is the audit's own ranking being followed, not drift.

**Not written here, and why.** Adding the three specs is real work of the right kind, but a Playwright
spec cannot be validated in my gate — `vitest.config.ts:13` excludes `tests/e2e/**`, and the suite runs
under `playwright test` against a real Postgres it drops and migrates. Shipping three specs I had not run
would be exactly the blind-ship this log exists to prevent, and the machine is at load 23.8 with a peer
building. Recorded with the residue named so the next wave starts from a verified list rather than
re-deriving it.

⭐ The transferable half: **e2e runs in CI (`.github/workflows/ci.yml:219`) but not in my gate.** So this
layer is protected — just not by anything I run. Every "suite green" I report is scoped to vitest, and
V-1998 states the size of what that scope omits.

## V-2000 — a ceiling went red on a commit that added no debt: the guard counted a comment (2026-08-27)

2026-08-27. The gate came back **NOT TRUSTWORTHY — 1 failed of 3241 files, 32216 passed**:

```
a-walk-that-swallows-a-missing-root-does-not-spread.test.ts
AssertionError: walk sites that return [] for a missing directory: 93 across 89 files (ceiling 92).
```

**Attributed before investigating.** Tree clean at `12df9638c`. Of the commits since the last green gate,
mine touched only `docs/verification-log.md` — a docs file cannot add a walk. Diffing the swallow-site
count per changed test file found exactly one mover: `workspace-tier-slug-sweep.test.ts`, 1 → 2, in A2's
`456021b41`.

**Then the attribution dissolved: A2 added no swallow site.** The two occurrences in that file are

```
line 16    if (!existsSync(dir)) return out;              <- real code, pre-existing
line 34   * MISSING root produces — `walk` opens with `if (!existsSync(dir)) return out;`. So a
```

Line 34 is inside a JSDoc block explaining _why_ the sweep now asserts its walk roots — the commit was
`test(marketing): assert the walk roots so an empty sweep cannot read as clean`. **Documenting the shape
incremented the debt counter for it.** The failure was mine, in a guard I own; A2's commit was correct and
is what exposed it.

**The guard had already made this exact judgement — for one file, and never generalised it.** It excludes
itself from its own scan, with the reason written out: _"A fixture demonstrating the pattern is not an
instance of the debt."_ That sentence is the general rule; it was applied as a special case. The fix is to
apply it everywhere, so the marker counts code and not prose. SELF stays regardless — its fixture is a
**string literal**, which no comment filter removes.

⛔ **My first fix ate a real site, and only a known-positive test caught it.** I wrote the obvious
comment-stripper (`/\*[\s\S]*?\*\//g` plus a `//` pass) and measured "2 phantoms". The second was
`docs-anchor-link-integrity.test.ts:34` — an actual `if (!existsSync(dir)) return out;` in an actual
`walk`. A regex literal containing a slash-star opened a phantom block comment that swallowed to the next
`*/`, deleting real code before the matcher ever saw it. **A stripper that narrows the corpus narrows every
claim built on it**, and shipping it would have made the ceiling blind to genuine debt while looking like a
correctness fix. The landed version never modifies the source: it matches over the whole file as before and
discards a hit only when the line it STARTS on opens with `*` or `//`. Whole-file matching is retained
deliberately so a site wrapped across lines still counts.

⛔ **I re-implemented the guard's walk and got a different population — again.** My replication said 95
across 91 files; the guard says 92 across 89. The guard gates on `src.includes('readdirSync')` before
counting, which my copy ignored. **Asked the guard instead** (ceiling → -1, read its own assertion):

```
before A2's commit, recorded : 92 across 89 files
with the phantom counted     : 93 across 89 files   <- the red
after the fix                : 92 across 89 files   <- the recorded baseline, exactly
```

**The ceiling needs no change.** Returning to the previously recorded number is the strongest evidence the
filter is right: it neither invented debt nor hid any.

**Mutation-proved in both directions**, on a real subject rather than the guard's own list
(`a-capability-file-that-is-not-listed-is-inert.test.ts`, snapshot keyed by path, `cmp` before and after):

- append a **real** `if (!existsSync(dir)) return [];` → **93 across 90 files, RED**. The guard still bites.
- append the **same text inside a JSDoc block** → the raw matcher finds it in the subject, guard **GREEN**.

The first attempt at mutation A appended nothing — my anchor did not match — and the guard passed. That
green meant "the tree is clean", not "the guard held"; the `cmp` assert is the only reason it was not read
as a result. `tsc -p apps/server/tsconfig.test.json` clean, `it(` count 3 unchanged, ceiling and header
comment still accurate at 92/89.

⭐ **The transferable half: a guard that documents its own exception has stated a rule it is not
enforcing.** The SELF exclusion was a correct judgement written in prose and applied to one path. Every
other file was left to trip over it, and the one that finally did was a commit whose whole purpose was to
make a sweep harder to fool.

## V-2001 — the published spec inlines one union 13 times, and W-10 is not the reason (2026-08-27)

2026-08-27. Re-verified my own open item W-10 while a gate ran, then chased what it costs — and the answer
turned out to be a different defect standing next to it.

**W-10 unchanged: 39 of 83 declared component schemas carry no operation `$ref`** (44 referenced), boundary
`packages/sdk-python/openapi.json` at HEAD. The orphans include the core resource types — `Account`,
`AgentSession`, `ApiKey`, `CreateSessionRequest` — so operations describe those shapes inline while a named
component sits unused beside them.

**That spec is consumed by a generator, which I first said it was not.** I grepped `package.json`,
`packages/*/package.json` and `scripts/*.mjs` for a codegen tool, found none, and wrote "not generated by a
codegen tool". Two commands later `packages/sdk-python/src/driftstack/_generated/models.py` opened with
`# generated by datamodel-codegen: filename: openapi.json`. **A negative conclusion is only as wide as the
paths the grep covered, and I stated it as though it were about the repo.**

### What the inlining actually costs

**Boundary: `_generated/models.py`, 209 classes, datamodel-codegen 2026-08-26, class bodies compared
verbatim.**

```
112  classes belong to numbered families (Intent, Intent1, … )
 61  distinct shapes they encode
 51  REDUNDANT classes — 24% of the whole model surface
 48  of those 51 come from ONE concept
```

Confirmed at the source rather than inferred from the SDK: serialising every `oneOf`/`anyOf` subtree in the
spec and counting identical ones gives **17 distinct unions, 7 of which appear more than once**, the
largest being a 6-branch intent union — `navigate, interact, wait, capture, scroll, behavioral_pause` —
**inlined 13 times, byte-identical**. Each occurrence is materialised separately downstream, so a Python
caller gets 54 `Intent*` classes for 6 shapes and no way to know which one an object will satisfy.

**This is not W-10.** `Intent` is not an orphan — it is not in `components.schemas` at all. W-10 is
declared-and-never-referenced; this is referenced-everywhere-and-never-declared. They are opposite halves
of the same policy, and the policy is pinned: `lib-openapi-content-parity` freezes the rationale
_"promote to components.schemas so codegen produces named types … instead of inline anonymous shapes"_. The
actual orphan families (`Session`, `SessionLoginResponse`, `SearchResponse`, `IntentResult`) contribute
**3** redundant classes between them. **The evidence I went looking for to strengthen W-10 belongs to a
different finding, and attributing it to W-10 would have inflated a blocked item with someone else's
numbers.**

⛔ **Three readings, and the first two were wrong in opposite directions.** First: "112 duplicate classes,
54% of the SDK" — dramatic, uniform, and it fit my hypothesis. Then reading three classes refuted it —
`Intent`/`Intent1`/`Intent2` are `navigate`/`interact`/`wait`, each with a `kind:` discriminator, so they
are union BRANCHES, not duplicates. **That refutation was also incomplete.** Only comparing bodies verbatim
got it right: they are union branches AND they are 9-fold duplicated, 54 classes over 6 shapes. A
correction is not a control; the second answer needed the same scrutiny as the first.

**No fix proposed.** Promoting the union and `$ref`-ing it is semantically identity-preserving after
dereference, but it rewrites the published document, so it is the same class of call as W-10 and belongs
with the owner. Recorded so the decision carries a number: one promotion collapses 48 of the 51 redundant
classes.

## V-2002 — my own fix generalises half the rule, and the canonical mechanism was already in the repo (2026-08-27)

2026-08-27. Immediately after landing V-2000 I ran the generalisation of its own lesson as a sweep: **which
guards exclude THEMSELVES from their own scan?** Each such exclusion is a judgement applied to one path, and
V-2000 was one of them going wrong. **Boundary: test files under `apps/*/tests` and `packages/*/tests`
referencing `import.meta.url` with a SELF comparison — 7 files.**

One of the seven is `a-source-gate-may-not-be-satisfied-by-a-comment.test.ts`. **The repo already has a
guard for the exact class I had just fixed by hand**, and it is stronger than what I wrote.

**V-923 does not heuristic its way to code-vs-prose — it masks.** It builds a per-character kind array over
each file (`Code | Str | Comment | Regex`) and classifies a match by the kinds its characters carry. Its
header records that the rule was **calibrated, not chosen by taste**: a stricter "matches ONLY comments"
test was tried first and would have missed V-921, whose gate scored 4 comment hits and 1 string hit, the
single string exonerating it. It also records that **strings and comments had to be separated**, because
lumping them together reported three legitimate route-registration gates as defects.

### The honest limitation of what I landed

My filter discards a hit whose line opens with `*` or `//`. **That generalises the COMMENT case and not the
STRING case** — and the string case is precisely why the walk-guard's SELF exclusion exists. Its control arm
reads

```
expect(SWALLOWS.test('  if ( ! existsSync( PAGES ) ) return [];')).toBe(true);
```

a line opening with `expect`, so my filter counts it. No mutation needed to establish this; the guard's own
SELF exclusion is the standing proof, which is why that exclusion had to stay. **So the fix I wrote while
criticising a rule that was stated generally and applied narrowly is itself stated for two comment shapes
and applied to two comment shapes.** Any file that adds a swallow-site fixture as a string literal
reproduces V-2000's false red exactly.

**Not consolidated here, deliberately.** V-923's masker is `function classify(...)` — module-local, and
shaped for a different job (scan a source TREE with a gate's regex, not count sites within test files). The
reusable part is the masker beneath it. Extracting it into a shared helper touches two guards and requires
re-proving both by mutation, which is a change worth making on its own evidence rather than bolted onto a
red-clearing fix at the end of a turn. **Recorded as the follow-up with its mechanism named**, so the next
pass starts from "extract V-923's mask" rather than writing a ninth spelling of comment-stripping — which
is what today already produced twice, once as `uuidFromPrefixedId` (12 copies) and once as `codeOf` (5).

⭐ The pattern worth keeping: **the sweep that found this was V-2000's own lesson turned into a query.** A
finding names a shape; running that shape across the repo immediately, while it is still in hand, is what
turns one fix into a class — and here it turned up both the canonical mechanism and the hole in my own.

**The other six self-excluders, measured but not judged.** Of the 7 files that exclude themselves,
**none of the other six carries any comment-awareness** — no `codeOf`, no mask, no stripper — while all six
count occurrences. **Boundary: that is a measurement of what the files contain, NOT a finding that any is
defective.** Whether a comment can inflate a given count depends on what each one counts, and answering
that needs the same per-file reading V-2000 needed. Naming the population is the useful half; calling it a
defect list without reading it is the error V-1547 recorded (`admin-*` by filename) and the one V-2000
repeated in miniature.

## V-2003 — the self-excluder population judged: six, all reasoned, and one of my own numbers was a token collision (2026-08-27)

2026-08-27. V-2002 named a population and explicitly declined to judge it — "measured but not judged". This
closes that, by reading each member.

⛔ **First, my own count was wrong, in exactly the way the third standing lesson names.** I swept for the
TOKEN `SELF` and reported 7 self-excluding guards. `every-legal-clause-citation-resolves` uses
`const SELF = /\bthis (DPA|AUP|Agreement|Policy|Addendum|Section)\b/i` — a regex for **self-referential
clause language**, so a citation saying "this Agreement" resolves to its own document. It excludes no file
and has nothing to do with the class. **The population is 6.** Sweeping the shape here would have meant
matching a file-path comparison, not an identifier name.

**All six are reasoned, and two are stronger than mine.**

```
a-source-gate-may-not-be-satisfied-by-a-comment  4-way per-char mask (Code|Str|Comment|Regex), calibrated
a-test-arm-may-not-hide-all-its-assertions       boolean codeMask(src), matches filtered by mask[index]
the-egress-claim-gate-has-one-definition         exclusion carries a NOTE and two mutation proofs
test-fixtures-never-seed-unconvertible-secrets   parser exposed as secretsInSource(src,label) so a test drives it
a-walk-that-swallows-a-missing-root-does-not-spread   mine (V-2000) — comment-aware, NOT string-aware
```

⭐ **The same rule is independently rediscovered in at least three of them.** The walk guard: _"a fixture
demonstrating the pattern is not an instance of the debt"_. The fixtures guard: _"a guard that flags its own
example reports a defect that does not exist — which it did on the first run"_. V-923's header records the
same distinction as a **calibration** result, having found that lumping strings with comments reported three
legitimate route-registration gates as defects. Three statements of one rule, each encoded for one path.

### The block-comment blindness, tested for liveness rather than asserted

`codeOf` has **5 independent definitions** and every one strips `//` lines only — V-1565 recorded that
limitation and it still holds. Counting spellings of "is this match in code?" across the repo: \*\*5 `codeOf`

- 2 maskers + my line-prefix filter = 8\*\*, differing in STRENGTH rather than in history. That makes it
  unlike the `uuidFromPrefixedId` family (12 copies, 4 spellings, every one justified by its own git history);
  here the weakest and strongest answer the same question.

**Boundary: each of the 5 `codeOf` users' own pattern, applied to its own subject files, counting matches
that fall inside a `/* */` block.**

```
req.guiControlKeyAuthorized = true   agent-sessions.ts (89 block comments)   1 match,  0 in a comment
publicEndpoint(                      webhooks.ts                             5 matches, 0 in a comment
createIdempotent({                   billing-crypto.ts                       1 match,  0 in a comment
throw new BundledLlm*Error           agent-sessions.ts                       2 matches, 0 in a comment
export class X extends ApiError {    errors.ts — 2 block comments, 0 braces
```

**Zero live instances. The hazard is latent in all five, not active in any.** The status-code guard is the
one with real teeth if it ever goes live: it **brace-counts** from a class declaration to find `status:`, so
a single unbalanced brace inside a block comment in `errors.ts` would make it read the wrong class body and
pin the wrong code. errors.ts has two block comments and neither contains a brace — checked, not assumed.

**No code changed.** The consolidation V-2002 named is now better evidenced — 8 spellings, three
independent statements of one rule — but it touches six guards that each need re-proving by mutation, and
a latent hazard with zero live instances does not justify that on today's evidence. Recorded so the case is
cumulative rather than re-derived.

## V-2004 — both payment webhook receivers audited: sound, and a money-path runbook that names one cause of two (2026-08-27)

2026-08-27. Target chosen with V-1920's instrument — routes ranked by how little the log says about them.
**Boundary: mentions of each route's filename stem across both verification logs, 59 route files at HEAD.**
Five score zero, and two of those are the inbound payment receivers: `webhooks-stripe.ts` and
`webhooks-nowpayments.ts`. Both take unauthenticated POSTs from a third party and move billing state.

⛔ **My prior-art check returned zero four times, and all four were my bug.** I ran `grep -ainE` with
`\|` for alternation — in EXTENDED regex that is a literal backslash-pipe, so the searches never matched
anything. Four independent zeros is not a result, it is a smell; a control (`grep -aicE webhook` → 119)
exposed it immediately. Corrected, the logs carry 75 `stripe` lines and 9 `nowpayments` — but only as a
header inventory (`stripe-signature`, `x-nowpayments-sig` listed as "inbound from a third party"). **No
end-to-end audit of either verifier existed.**

### Both receivers are sound

**Stripe** (`lib/stripe-signing.ts`): timestamp checked against a 300s tolerance so a captured delivery
cannot be replayed indefinitely; empty signing secret refused before hashing (V-1465 — Node's HMAC accepts
an empty key and returns a valid digest, so without it an attacker who knows body and timestamp verifies);
EVERY `v1` candidate accepted for zero-downtime secret rolls, each compared constant-time; hex validity
asserted **before** `Buffer.from(hex,'hex')` with the reason written down.

**NOWPayments** (`lib/nowpayments-signing.ts`): HMAC-SHA512 over the sorted-key canonicalisation the
provider's protocol mandates, `timingSafeEqual`, digest-length guard, false-on-malformed.

**The state machine behind the IPN handles replay and reordering.** `applyIpnStatus` decides inside
`withOrderLock` (a real `SELECT … FOR UPDATE`), rejects an IPN whose `payment_id` differs from the one
bound at createPayment, and gates transitions on `isTerminalForward` — `paid`/`failed`/`cancelled` never
move, `partial` advances only to `paid`/`failed`, `pending` is never re-entered. Side-effects read the
LOCKED prior status, so a re-delivered `paid` fires no second webhook or receipt.

**The signing tests are not vacuous**, which is the failure mode that would make all of this hollow. The
canonicalisation arm signs an **unsorted** body `{z,a,m}` against a **hardcoded literal** canonical form
`{"a":2,"m":3,"z":1}` — not against a re-implementation of `sortKeys` — so deleting canonicalisation fails
it. Nested key sorting is pinned the same way.

### The finding: a triage bullet that names one cause of two

`docs/internal/2026-06-03-crypto-payment-path-security-audit.md` carries an explicitly open,
money-critical item: the verifier canonicalises by re-serialising through the JS number formatter, while
NOWPayments signs with PHP `json_encode`, which can emit float fields (`price_amount`, `actually_paid`)
as different bytes. When they diverge, **a genuine IPN fails verification and a real payment is silently
dropped.**

**The operator runbook, which is what someone actually reads during an incident, gave that log line one
cause:** _"IPN secret mismatch. Compare the `NOWPAYMENTS_IPN_SECRET` env var against the value in the
NowPayments dashboard."_ An operator hitting the serialisation divergence would compare the secrets, find
them identical, and stall — or worse, rotate a correct secret. **Neither document referenced the other.**

Fixed by adding the second cause with a diagnostic that separates them (recompute the HMAC over the RAW
body and over the canonical form; raw-verifies-canonical-does-not is the divergence, not a secret
problem), an explicit _do not rotate the secret_, and a pointer to the audit item. Pinned as its own arm
rather than folded into the existing three-causes arm, and **mutation-proved on the real subject**:
deleting the block from the runbook reds exactly that arm, 1 of 8. `it(` count 7 → 8 as intended, tsc
clean via `tsconfig.test.json`, diff is 37 insertions and 0 deletions.

**The audit's condition has NOT fired, and that is verified rather than assumed.** The runbook records
"we have no live merchant account", and the route registers only when `NOWPAYMENTS_IPN_SECRET` is set
(`app.ts:1350`). So the item is correctly still open — and its recommendation #2, _verify against BOTH the
raw body and the canonical form and accept either_, **is not implemented**: line 58 computes exactly one
candidate (`canonicalizeJsonObject(bodyStr) ?? bodyStr`), falling back to raw only when the body is not a
JSON object. Not changed here — the audit deferred money-path verification semantics to the owner pending
a real sandbox IPN, and that judgement is not mine to overturn.

### One dead mechanism, verified and deliberately not "fixed"

`nowpayments-signing.ts` wraps `Buffer.from(signature,'hex')` in a try/catch and documents _"Returns false
… signature is not valid hex"_. **Measured: `Buffer.from('zz','hex')` does not throw — it returns a
0-length buffer. The catch is dead**, and the documented behaviour is delivered by the digest-length guard
instead. Consequence, also measured: a correct signature with trailing garbage (`goodHex + "zz"`) decodes
to the same 64 bytes and is **accepted** — signature malleability.

**Not a vulnerability, and not changed.** Producing that input requires already holding the correct
HMAC, at which point the unmodified signature works; nothing downstream keys on the signature string. The
sibling verifier guards the identical hazard explicitly (`constantTimeHexEq` asserts hex before decoding),
and the security audit already credits the **length guard** — not the catch — as the real mechanism, so
the audit's description is accurate. Recorded because V-1465 was the reciprocal of exactly this comparison
(the empty-secret check NOWPayments always had and Stripe lacked): **reading the two sibling verifiers
against each other keeps paying, in both directions.**

## V-2005 — a length is not a shape: three routes accepted any 36 characters into a uuid column (2026-08-27)

2026-08-27. Continuing V-2004's target selection — routes ranked by how little the log says about them —
into the remaining zero-mention files. `admin-billing.ts` and `egress-echo.ts` are clean (the latter's
`req.ip` rate-limit key is safe because prod sets `trustProxy: 1`, one hop, so a client-supplied
`X-Forwarded-For` cannot win; archive records CORS/trustProxy as LOCKED). `admin-rate-limit-overrides.ts`
was not.

### The defect

Three routes normalise an admin `account_id` query parameter that may arrive as `acc_<uuid>` or bare:

```ts
? parsed.data.account_id.length === 36
  ? parsed.data.account_id                                    // ← no shape check at all
  : uuidFromPrefixedId(parsed.data.account_id, 'acc')
```

**A length is not a shape.** Thirty-six dashes are thirty-six characters, and so are thirty-six hex digits
with no dashes. Either passes through untouched into `eq(<table>.accountId, value)` where the column is
`uuid` — verified in `schema.ts` for all three targets (`rateLimitOverrides`, `apiKeys`, `sessions`). Sites:
`admin-rate-limit-overrides.ts:71`, `admin-api-keys.ts:73`, `admin-sessions.ts:80`.

**The sibling was already fixed, and its comment states the rule.** `admin-cost.ts` carries V-1580:
_"Stripping and validating are different jobs, so the shape check belongs here, at the call site, on the
normalised result. `cost_daily.account_id` is a `uuid` column: without this a malformed id reaches Postgres
as an invalid cast (22P02) and the route answers 500 where the boundary owes 400."_ One file fixed, three
siblings missed — the same distribution V-1565 found for the loose hex-or-dash class, in the same admin
surface.

⭐ **This is the residue V-1998 predicted and could not find an instance of.** V-1565 guarded its class _as
a shape_, scanning route files for the loose regex literal — and that guard structurally cannot see this,
because there is **no regex here to find**. The bypass is a `.length` comparison. Sweeping the shape
(`\.length === 36` as a stand-in for uuid acceptance) found all three; sweeping the token would not have.

⛔ **The arm that should have caught it was one character-count away.** Each route already has an arm
titled _"CRITICAL refuses a malformed account_id, and refuses a WELL-FORMED id carrying another resource
prefix"_. Its inputs are `not-an-id` (**9** chars) and `key_<uuid>` (**40**). Neither is 36, so both take
the `uuidFromPrefixedId` branch and the arm passed identically before and after this fix. **A refusal test
that never supplies the length the branch keys on is testing the other branch.**

### The fix, and what the proof does and does not cover

`BARE_UUID_RE` at each site — V-1580's literal verbatim rather than a new spelling, `/i` deliberately: an
uppercase bare uuid is accepted today and narrowing that is a separate decision (the same reasoning V-1998
established for profile-snapshots' `/i`). The malformed branch then falls through to `uuidFromPrefixedId`,
which already throws `BadRequestError` → **400**, so no new error path was introduced.

**Post-condition, not derivation:** zero occurrences of `parsed.data.account_id.length === 36` remain in
`apps/server/src` or `apps/server/tests`. Six pins across three content-parity and three cross-source
files updated in the same commit — retraction paraphrased in the prose, the new expression quoted in the
assertions; `it(` counts unchanged in all six (9/6/6/14/12/12), `tsc -p tsconfig.test.json` clean.

Three behavioural arms added, one per route, each asserting the refusal with inputs that are **exactly 36
characters** and asserting that length in the arm itself so a future tidy-up cannot silently defeat it.
Mutation-proved on the real subject: restoring the pre-fix `admin-sessions.ts` reds exactly that arm.

⛔ **Boundary, and it is the interesting part.** The mutation failed with `expected 200 to be 400` — **not** 500. Against `buildTestApp`'s in-memory repositories a garbage filter matches nothing and the route answers 200. So these arms prove the route now REFUSES AT THE BOUNDARY; **they cannot exhibit the 500**, because no
route test in this suite meets real Postgres — the seam V-1998 measured, where exactly one integration file
drives a route against a real database and it is an internal one. The 500 is inferred from the verified
`uuid` column type plus V-1580's documented experience of the identical shape, and is **not reproduced
here**. That inference is exactly what V-1565 described: _"the route half is tested in-memory, where a
garbage filter matches nothing and returns 200; the column half is tested by repo contracts handed
already-valid values. The failure lives in the join."_

### Two instrument failures, both caught by their own asserts

**My post-condition matched my own comment.** `grep "length === 36"` after the fix returned three hits —
all of them the explanatory comment I had just written, which quotes the defect. The same shape as V-2000,
committed by me, one turn later, while writing the comment that explains V-2000's cousin. Re-run against
the pinned expression (`parsed.data.account_id.length === 36`) it is a clean zero.

**A python raw string double-escaped my anchor** (`r"\\."` is backslash-backslash-dot; the file holds
backslash-dot), so the pin rewrite matched nothing. `assert n == 1` fired on the first file and **nothing
was modified** — the run aborted before any write, which is the only reason the next command's output was
not a false green.

## V-2006 — the class V-2005 fixed, closed: every other call site reads sound, and the guard now says so (2026-08-27)

2026-08-27. V-2005 fixed three routes that substituted `.length === 36` for a uuid shape check. Two
questions it left open, both answerable: **are there more bypasses**, and **what stops a fourth?**

### Are there more? No — and the counting instrument found three candidates that reading refuted

**Boundary: the 12 route files that DEFINE `uuidFromPrefixedId`, comment lines stripped, comparing parser
CALLS against request-id READS.** Three files show a gap, and none is a bypass:

```
admin-webhooks.ts   4 calls / 7 reads   the 3 extra reads pass the RAW public id to withAudit(...)
sessions.ts        11 calls / 12 reads  an inline /^prof_([0-9a-f]{8}-…)$/ with 400 on mismatch
admin-accounts.ts  11 calls / 10 reads  more calls than reads — one validates a CURSOR, not a param
```

`admin-webhooks` is validation-then-reuse: every handler calls the parser on the line above, and the audit
row should record `wdl_<uuid>` — the id the operator acted on — not the bare uuid. `sessions.ts` cannot use
its own file's parser because that `PUBLIC_ID_RE` is `[a-z]{3}_` and `prof` is four letters, the same
constraint that forces `[a-z]+` in profile-snapshots; its inline regex is strict, pins the prefix in the
pattern, and throws `BadRequestError`. `admin-accounts` running a cursor through the parser is the V-1565
cursor lesson applied.

⭐ **A call-count gap is a candidate, never a finding.** All three would have been offenders on the count
alone. The three that were real (V-2005) had the opposite signature — the parser was defined, strict, and
simply not reached.

### What stops a fourth? Now: an arm on the guard that already owns the parser

`twelve-copies-of-the-id-parser-must-agree` proves every copy is strict — its arms check that each regex
accepts the prefixes its file asks for and mints, that each REFUSES a non-uuid, and that each pins the
prefix somewhere. **Not one of them could see V-2005**, because all three defective routes had perfectly
good parsers. **Verifying a parser exists is not verifying it is reached**, and that distinction is the
whole finding.

Added there rather than in a new file, because it is a property of the same subject. 36 is the uuid string
length, so a `.length` comparison against it inside a route file is a shape check wearing a length's
clothes.

**Detector proved on known positives before its zero was trusted** — the pre-fix sources are still in the
scratchpad, keyed by path:

```
3/3  found in the three pre-fix route files
 ✓   a spelling wrapped across lines is still caught (non-comment lines are joined before matching)
 ✓   `* … .length === 36 …` in a block comment does NOT count
 ✓   `// x.length === 36` does NOT count
 0   occurrences across 60 route files today
```

The comment cases matter because the arm's own explanation quotes the construct it forbids — the V-2000
failure, which I committed once already and will not commit again by writing the guard that describes it.

**Both controls run, not asserted.** Planting `v.length === 36` into `routes/legal.ts` — a route this arm
was not written for, the same control V-1565 used — reds it naming `legal.ts (1)`. The non-vacuity floor
was probed rather than trusted: setting it to 999999 reports _"expected **60** to be greater than or equal
to 999999"_, so the arm really walks 60 route files and the floor of 55 carries ~8% slack. Restored and
re-run green, 7 of 7.

⛔ **My habitual `it(` check has a false positive, found here.** The standing rule is to compare the `it(`
count against HEAD after every pin edit. `grep -c 'it('` reported 6 → **8** for a one-arm addition, and the
extra match is `.split('\n')` — **`split(` ends with `it(`**. The precise count is `^\s+it\(`, which reads
6 → 7. It has never mattered before only because no line in the files I touched contained `split(`; a
count that can silently gain a phantom is exactly the instrument this log exists to distrust.

## V-2007 — V-1565's class survived outside the directory its guard walks (2026-08-27)

2026-08-27. Ran a **post-condition** on a fix from months ago rather than trusting it: does the loose
hex-or-dash class V-1565 removed still exist anywhere? **Boundary: `apps/server/src` and `packages/*/src`,
every spelling of a 36-wide hex-or-dash character class (`[0-9a-fA-F-]`, `[a-fA-F0-9-]`, `[\da-fA-F-]`,
`[0-9a-f-]`), detector proved against three known-positive spellings and correctly rejecting the strict
8-4-4-4-12 form.**

Three hits. Two are comments explaining why the file no longer uses it. **One is code:**

```
apps/server/src/services/profile-blob-orphan-sweeper.ts:73
const SEALED_KEY_RE = /^profiles\/([0-9a-f-]{36})\.sealed$/;
```

⭐ **V-1565 guarded this "as a shape, not a filename" — and scoped the walk to route files.** A shape
guard scoped to one directory is a filename guard wearing a shape's clothes. `services/` was never in
range, so the identical class sat there untouched.

### The consequence chain, verified link by link

The captured value goes to `findExistingProfileIds`, which runs `inArray(profiles.id, chunk)`; `profiles.id`
is a `uuid` column (checked in `schema.ts`). A 36-character non-uuid therefore makes the query throw. The
sweeper swallows a per-tick failure and re-arms **by design** — its header says so: _"one bad pass can never
silently stop the reaper forever."_ **For a poison key the design inverts: every tick lists the same key,
throws on the same query, and is swallowed identically, so reclamation stops permanently and silently.**
`profiles-repo.ts` already records the other half of this — _"that sweeper is wrapped to never throw, so the
failure would have been a log line and a reap pass that silently did nothing."_

⛔ **Mechanism is not reachability, and this one is latent.** The only writer is
`profileSealedBlobKey(<real uuid>)` in `lib/r2.ts:238`, so the app cannot produce a malformed key. It needs
one entering the bucket from outside. **Fixed anyway because the blast radius is total and silent while the
fix is one character class** — and because the comment above it already claimed the strict property
(`profiles/<uuid>.sealed`) that the pattern did not enforce.

⛔ **Third instance in two days of an arm that cannot reach the branch it is named for.** The sweeper's
test carries _"ignores non-sealed keys + malformed uuids under the prefix"_ — and its malformed input is
`profiles/not-a-uuid.sealed`. **`not-a-uuid` is TEN characters**, so `{36}` rejected it on WIDTH and never
on shape: that arm passed identically whether the class was loose or strict. V-2005 was the same shape (9
and 40 characters against a 36-length branch). **A refusal fixture has to be the width the pattern
accepts, or it is testing the length check.**

Extended with both 36-character forms — 36 dashes and 36 undashed hex — and the arm now asserts their
length, so a later tidy-up of the literals cannot quietly stop exercising the branch.

**Mutation-proved, and the mutation shows something worth stating.** Restoring the loose class makes the
arm report `reaped` **3** instead of 1: the two garbage keys are treated as orphaned profile blobs and
deleted. **That is the test double's behaviour, not production's** — `findExistingProfileIds` is faked here
and does not cast, whereas real Postgres throws on the `inArray` first and the tick aborts before any
delete. So production's consequence is the silent stall, not data loss; the double reaches a different
failure through the same defect.

### The scope fix

A new arm on `twelve-copies-of-the-id-parser-must-agree` walks **all of `apps/server/src`**, not routes.
Comment lines are dropped before matching, which is load-bearing: three files quote the old class while
explaining why they abandoned it, including the sweeper this arm was written for. Detector proved 1/1 on
the pre-fix source and 0 on all three comment-only mentions; floor probed rather than trusted — forcing it
reports **342 server source files walked**, so the floor of 300 carries ~12% slack. Restoring the loose
class reds the arm naming the sweeper.

### Two sweeps that came back clean, stated so they are not re-run

**Prefix-stripping** (`startsWith('acc_')` / `.slice(4)` / `.replace(/^acc_/)`) across routes, services and
lib: every site validates before stripping — `profiles.ts:526` runs a full strict regex on the whole
`acc_<uuid>` before `.slice(4)`; `account-web-sessions.ts` checks the prefix then a strict uuid;
`currentWebSessionIdFromRequest` strips a server-side auth-context value, not caller input. `admin-cost.ts`
is the V-1580 site, already fixed. **No unvalidated strip anywhere.**

## V-2008 — the scope question V-2007 raised, asked of two more guards: both narrow, neither live (2026-08-27)

2026-08-27. V-2007's transferable half is that **a shape guard scoped to one directory is a filename guard
wearing a shape's clothes** — V-1565 walked `routes/` and the class it removed survived in `services/`.
That is a question worth asking of every guard that hardcodes a scan root, so I asked it of the two whose
property is least route-specific. **Boundary: `apps/server/src` in full for each property, comment lines
distinguished from code.**

**`client-ip-shared-parser` — narrow scope, zero live instances.** Its arms are named _"no ROUTE reads
X-Forwarded-For outside the shared reader"_ and it walks a route roster. A service parsing the header
itself would be invisible. Measured across all of `apps/server/src`: **seven mentions, every one a
comment** (`schema.ts`, `app.ts` ×2, `bootstrap.ts`, `client-ip.ts`'s own header, `config.ts`,
`legal.ts`) — **no code reads it anywhere outside `lib/client-ip.ts`.** The guard also derives its consumer
roster rather than hardcoding it (its arm _"discovery found the consumers, and the historical roster is a
subset of them"_), which is the design that stops the roster rotting.

**`every-intent-emission-goes-through-the-public-projection` — narrow scope, and the boundary is the point.**
It scans `ROUTES_DIR` only, and the three projections (`publicAgentIntent`, `publicIntentResult`,
`publicTranscriptEntry`) live in `services/agent-public-redaction.ts`. Three services both write to a
transport and carry intent/transcript payloads — `harness-dispatch-correlator`, `fleet-control-registry`,
`cookies-request-correlator`. **None is a gap**: the first is the core of the `/v1/fleet/events` WSS sender,
a server-to-fleet-node channel, and the projection exists to redact at the CUSTOMER boundary. Sending
unprojected intent to our own harness is the design, not a leak. **A guard's scope is defensible when it
matches a trust boundary rather than a directory** — here `routes/` happens to BE the customer boundary,
which is why the scope is right and V-1565's was not.

⛔ **Two of my own searches returned false zeros in this sweep.** `git grep -- 'apps/server/src/services/**/*.ts'`
matched nothing — git pathspecs do not glob `**` that way — and I read it as "no service mentions intent".
The control (the same query against `routes/`, a known positive) exposed it; with `*.ts` the answer is 50+
files. Earlier the same turn, four concept greps returned zero because I used `-E` with `\|`, which is a
literal backslash-pipe in extended regex. **Both zeros were plausible and both were my syntax.** A zero
from a search whose positive control has not been run is not a measurement.

**No code changed.** Recorded so the scope question is asked once and answered, rather than re-derived the
next time a directory-scoped guard looks suspicious.

## V-2009 — the poison-key class enumerated and closed: one member, already fixed (2026-08-27)

2026-08-27. V-2007 fixed a sweeper whose loose key pattern could feed a malformed id to a `uuid` column,
where the throw is swallowed by design and every subsequent tick fails identically — a permanent, silent
stall. The question that leaves open is whether the repo has other sweepers shaped that way.

**Boundary: the 12 self-arming sweepers and reapers under `apps/server/src/services`, all of which catch a
per-tick failure and re-arm.** Catch-and-re-arm alone is not the defect — it is the correct design. The
defect needs four things together:

```
1  input that originates OUTSIDE the database          (a listing, a filename, a fetch)
2  a parse that can admit a value the DB will reject   (a pattern looser than the column)
3  that value fed to a typed column in a BATCH query   (one bad element aborts the whole tick)
4  the throw swallowed + the chain re-armed            (so the stall is silent and permanent)
```

All 12 have (4). **Four touch an external source**: `profile-blob-orphan-sweeper`,
`account-deletion-purge-sweeper`, `profile-trash-purge-sweeper`, `scheduled-jobs-prune-sweeper`. **Exactly
one has (2)** — the sweeper V-2007 fixed, and it was the only one parsing a key at all.

⛔ **Checked the shape, not the token.** "Parses a key with a regex" would have been a token search, so the
other three were also swept for `split('/')`, `.slice(`, `.replace(` and a `.key` read — the ways an id can
be derived from an external name without a regex. **Zero hits**, and confirmed by reading rather than by
the zero: `profile-trash-purge-sweeper` runs `for (const id of purgedIds) r2.deleteObject(profileSealedBlobKey(id))`.
That is the safe direction — a database id becomes a key — and never the reverse.

**The class has one member and it is fixed.** Recorded so the next person reading V-2007 does not have to
re-derive whether it was an instance or a category.

## V-2010 — the customer-facing webhook verifiers: two accept a forgery, the third throws (2026-08-27)

2026-08-27. Ran the same technique that found V-2007 — a **post-condition on a historical fix** — against
V-1465, which added an empty-secret refusal to `lib/stripe-signing.ts` because _"Node's HMAC accepts an
EMPTY key and returns a perfectly good digest, so without this an attacker who knows the body and timestamp
computes `HMAC-SHA256('', "<t>.<body>")` and it verifies."_ The question that generalises: **does every
verifier in the repo refuse an empty key?**

**Boundary: all 12 `createHmac` call sites in `apps/server/src` and `packages/*/src`.** Signing sites are
not at risk (an empty key there is a config error, not a bypass); the verifiers are. Server-side, all three
are guarded — `nowpayments-signing` always was (`!opts.secret`), `stripe-signing` since V-1465, and
`oauth-client-state` since **V-1466**, whose own comment records that "the verifying half was missing it".

⭐ **The verifier customers actually run is not in the server.** `lib/webhook-signing.ts:46` says so
outright: it is the _"inverse of `verifyWebhookSignature` in @driftstack/sdk"_. So the question moves to the
three SDKs — and that is where it had never been asked.

### Measured, in all three, with controls

The forged header is built with the **empty key on purpose**. A signature made with a real secret would be
refused for the ordinary reason and would prove nothing about this branch.

```
Python  verify_webhook_signature(secret="")   ->  ACCEPTED  — the forgery verifies
Go      VerifyWebhookSignature(…, "")         ->  ACCEPTED  — the forgery verifies
TS      verifyWebhookSignature({secret: ''})  ->  THREW DataError: Zero-length key is not supported
```

Controls passed in every case: a correct signature under a real secret verified, and a signature under the
wrong secret was refused — so the probes were discriminating, not vacuous.

**Three SDKs, three answers, and all three contradict their own documented contract.** Python's docstring:
_"Returns `False` on any failure mode — never raises."_ Go's doc comment, pinned by
`webhook-signature-policy-cross-source-invariant`: _"Never panics; returns false on any failure mode."_ An
empty secret is a failure mode. Python and Go neither raise nor return false — they **verify**. TypeScript
does not verify, but only by accident of WebCrypto refusing a zero-length key, and it violates the same
contract from the other side by throwing into the customer's webhook handler.

### The fix

An empty-secret refusal at the top of each public entry point, mirroring V-1465's server-side wording.
Behavioural regressions added to each SDK's **own** suite — TS vitest, Python pytest, Go `go test` — because
a content-parity pin freezes text while these assert the property. **Each mutation-proved on its real
subject**: removing the guard reds exactly that SDK's new test and nothing else, and every source restores
byte-identical from a path-keyed snapshot.

One content-parity pin broke and was updated in the same commit — the TypeScript flow arm asserted the
function opening immediately followed by its first statement, which the guard now precedes. Retraction
paraphrased in the arm title, the new line quoted via `toContain` rather than extended into the `\s*` chain,
which is the shape that rots. The Python and Go drift guards gained a matching assertion so deleting the
guard cannot leave the SDK's own suite as the only witness. `it(` counts: TS parity unchanged at 24, Python
6→7, Go 11→12 — each exactly the arm added. `tsc -p tsconfig.test.json` clean.

**Post-condition:** re-probed all three after the fix — Python `False`, Go `false`, TS `false` (no longer
throwing), with the real-secret control still accepted in each. Full affected surface green: 13 vitest
files / 149 tests, `go vet` + `go test ./...` ok, and the Python suite 401 passed / 9 skipped.

⛔ **Reachability, stated rather than implied.** This needs a customer who calls the verifier with an empty
secret — an unset or blank `DRIFTSTACK_WEBHOOK_SECRET`, a config default, a `.get()` that returned empty.
It is not remotely triggerable against a correctly configured integration. **That is exactly the situation
V-1465 judged worth fixing server-side**, and the reciprocal comparison between sibling verifiers has now
paid three times in two days: V-1465 found it by comparing Stripe against NOWPayments, V-2004 was the
reciprocal of that comparison, and this is the same question asked one layer out — at the boundary the
customer owns.

## V-2011 — the fix I shipped one entry ago regressed the contract it was written to restore (2026-08-27)

2026-08-27. V-2010 added an empty-secret refusal to all three SDK webhook verifiers because Python and Go
verified an attacker-forged HMAC against `secret=""`. **The TypeScript guard I wrote for it was
`input.secret.length === 0`, and that spelling throws.**

Asking the question one layer out — _who actually calls this?_ — answers it: a webhook handler is usually
plain JavaScript, where `secret` arrives from an unset env var or a missing config key with no compiler in
the way. **Boundary: the same forged-header probe as V-2010, run against three versions of the function.**

```
                       secret=''      secret=undefined         secret=null
before any guard        ACCEPTED*     THREW DOMException       returned false
`.length === 0` (mine)  false         THREW TypeError          THREW TypeError   <-- regression
`!input.secret`         false         false                    false
                                                     * the V-2010 forgery, on Python/Go; TS threw
```

⛔ **`null` returned false before my change and threw after it.** The guard existed to make the function
honour _"returns false on any failure mode"_, and it broke that promise for the caller most likely to hit
it. A fix that narrows one failure mode while widening another is not a fix, and the only reason this was
caught is that I kept probing the same function after committing rather than treating the commit as the
end of the work.

**Only TypeScript was affected.** Python's `if not secret:` covers `None` and `""` in one — verified, not
assumed — and Go strings cannot be nil, so `secret == ""` is complete there. **The two guards I wrote
idiomatically were right; the one I wrote as a length test was not**, which is the same lesson as V-2005 in
a different costume: a length is not the property.

Fixed to the falsy test. **Mutation-proved in both directions**, restoring byte-identical each time:
restoring `.length === 0` reds _only_ the new untyped-caller arm (22 others pass), and deleting the guard
entirely reds _both_ it and V-2010's empty-secret arm.

The content-parity pin now carries a **negative** assertion beside the positive one — `input.secret.length`
must not reappear — because the whole point is the spelling, and a future tidy-up back to `.length` is
exactly how this returns. `it(` counts: parity file unchanged at 24, SDK suite 22→23. Post-condition:
`undefined`, `null` and an absent property all return false; 8 files / 98 tests green across the webhook
surface.

### The tolerance sweep, run at the same time and clean

While probing the verifiers I checked the other property a signature verifier can get wrong: a one-sided
timestamp comparison, which lets a **future**-dated signature replay indefinitely. **Boundary: all four
verifiers — the three SDKs and `lib/stripe-signing.ts`.** All four take the absolute delta.

⛔ **My first sweep said Go did not.** I grepped for `Abs`/`abs` and Go has no `Duration.Abs`; its idiom is

```go
delta := now.Sub(signed)
if delta < 0 { delta = -delta }
```

Reading it refuted the hit. **Sweep the shape, not the token** — three files spell this property with a
function call and the fourth spells it with a negation. All three SDKs also already carry a
future-timestamp test, and the TypeScript one names the exact drift in its own comment: _"Drift to
one-sided `now - timestampMs >` would let future-dated signatures slip through."_

⚠️ **Gate caveat, disclosed.** The full run that covered V-2010 came back green (3241/3241, 32226 passed),
but a peer wrote `apps/marketing-site/tests/unit/workspace-overclaim-phrase-sweep.test.ts` at 17:37:14
against a run that started at 17:34:22, so that one file ran against an indeterminate version. It is their
file, it passed, and they have since committed it. The other 3240 files ran against my committed state.

## V-2012 — the neighbourhood check applied to my own guards, and two sweeps that came back clean (2026-08-27)

2026-08-27. V-2011's lesson is that an early return intercepts a _neighbourhood_ of inputs, not just the
one that motivated it. The first thing to do with a lesson like that is turn it on my own recent work.

**Both guards I added today pass it. Boundary: each guard's actual input type, traced to its source.**
V-2005's `BARE_UUID_RE.test(parsed.data.account_id)` is reached only through
`account_id: z.string().min(1).max(100).optional()` plus an explicit `!== undefined`, so Zod closes the
neighbourhood before the guard sees it — a string of 1–100 characters or nothing. V-2007's
`SEALED_KEY_RE.exec(obj.key)` takes a typed key from the R2 listing, and a missing one would coerce to
`"undefined"`, fail to match, and `continue`. **Neither has the hole the TypeScript guard had**, and the
reason is the same in both cases: the value was constrained before it arrived.

### Sign/verify asymmetry — one pair, already fixed

V-1466's shape generalises: _"a bare `32` in the signing guard and the verifying half had no [check]"_ —
**a validation enforced on one half of a sign/verify pair and not the other.** **Boundary: every exported
`sign*`/`verify*` function in `apps/server/src/{lib,routes,services}` — 12 of them.** Most are verify-only
(the signing counterpart is Stripe's, NOWPayments', or a password hash). Exactly one is a true in-repo
pair sharing a secret constraint — `oauth-client-state.ts` — and that is the pair V-1466 already fixed,
its comment recording that the verifying half was the one missing it.

### PKCE is S256-only, enforced three times independently

`lib/oauth-pkce.ts` exports `verifyPlainChallenge` — RFC 7636's `plain` method, where the challenge IS the
verifier, and the one an attacker who intercepts the challenge can complete. Worth checking whether it is
reachable.

**It has zero call sites.** `services/oauth.ts:631` imports and uses only `verifyS256Challenge`.
**Post-condition across `apps/server/src`: no `'plain'` literal exists**, and the method is constrained at
three independent layers — `routes/oauth.ts:55` `z.literal('S256')` at the HTTP boundary,
`services/oauth.ts:517` re-checking `!== 'S256'` inside the service, and the service's own type declaring
the literal. `lib/openapi.ts:2554` publishes the same literal, so the contract customers read matches.

**Not dead code to delete.** Its own comment explains it — _"supported for completeness but the route
layer refuses anything other than S256 at registration time"_ — and four test files cover it, including an
RFC 7636 cross-source invariant. An implemented-but-unreachable weak method with a stated reason and its
own tests is a documented decision, not debt. Recorded so the next reader who greps `plain` and finds a
constant-time comparison of `verifier === challenge` does not have to re-derive that nothing calls it.

## V-2013 — an expand-phase table with read and update paths and no create path, behind two published operations (2026-08-27)

2026-08-27. Sweeping the unique-constraint class (a caller-supplied value into a UNIQUE column with no
23505 handler answers 500 where 409 is owed) led somewhere else. **Boundary: the 28 unique constraints in
`schema.ts` — 1 `.unique()` and 27 `uniqueIndex(...)` — narrowed to the ones a caller controls.**

**The class itself is in good shape.** `lib/pg-error.ts` is the canonical translator, and its own comment
records the subtlety that matters — it reads `err.cause`, because "a top-level-only read would then MISS
the 23505". The customer-facing constraints are handled end to end: `accounts_slug_unique` throws
`SLUG_TAKEN` in `auth-repo.ts:178` and `account-me.ts:332` converts it to a 409;
`team_invites_owner_email_pending_unique` is a **partial** index and its upsert repeats the predicate —
index `.where(isNull(acceptedAt))`, `onConflictDoUpdate` with `targetWhere: isNull(teamInvites.acceptedAt)`
— so it cannot raise 42P10, which is the trap V-1995 swept.

### What the sweep actually turned up

`teams_slug_unique` can never be violated, because **nothing inserts a `teams` row.** Verified with a
working control rather than from a bare zero: the same grep form finds `insert(teamInvites)` in the same
file, and finds no `insert(teams)` anywhere in `apps/server/src`.

The table is nonetheless read and written: `listTeamsOwnedBy` selects from it and `renameTeam` updates it,
both in `team-members-repo.ts`, and both are wired — `renameTeam` to `routes/team.ts:180`. **Both
operations are published**: `GET /v1/teams` and `PATCH /v1/teams/{id}` are in `openapi.json`. So a customer
or a generated SDK sees two operations of which one returns an empty list for everyone and the other
answers `404 Team not found.` for everyone.

⭐ **This is the design, not a defect, and the commit message says so:** `fa4df20a1` — _"feat(db): a team
becomes a thing, not an account id (0114, **expand phase**)"_. Expand/contract: the table, the reads and
the update land first; the create and backfill land in a later phase. The 404 is what an expand phase looks
like from outside, and **naming it is the whole contribution here** — the alternative is someone
rediscovering it as a bug.

⛔ **The alarming reading was checked and is false.** `/v1/account/me` publishes a `teams` array, which
would be permanently empty if it read this table. It does not: `ctx.teams` comes from team MEMBERSHIPS via
`services/auth.ts` (`liveTeams`), and each entry carries a `mem_` membership id. **The customer-visible
account payload is unaffected** — that is the first thing to check and it was checked before anything else
was written down.

**V-1048's guard cannot see this.** It lists published routes that can never succeed, and its detector is
the `FeatureUnavailableError`/503 shape — a handler that throws unconditionally. These two succeed
structurally and fail on data, which no source scan of throw-sites reaches. **Not extending it here**:
detecting "the backing table has no writer" statically is fragile, and the state is temporary by
construction. Recorded instead as the conditional deferral it is — nothing fires when the contract phase
lands, which is exactly why V-1957 argued such items are the easiest kind to lose.

## V-2014 — four bounded scans, three say so: the one that stays silent is the one that paginates (2026-08-27)

2026-08-27. Ran the post-condition on the _other_ half of V-1565 — it fixed id filters (swept in V-2005)
**and** a cursor shape, and the cursor half had never been re-asked.

**The cursor class is sound, and the fail-soft is deliberate.** `lib/keyset-cursor.ts` is shared by seven
repos with one call shape, and its header states the property rather than leaving it to be inferred: a
malformed cursor yields `undefined` so the caller "skips the keyset anchor and starts from the first page…
turning a malformed-cursor 500 into a graceful first-page response. The downstream `WHERE account_id = …`
filter is independent of the cursor, so this is purely a robustness fix — **it never widens what a caller
can read**." That supersedes V-1565's "clean 400" intent with a documented decision. `crypto-orders` has
its own private codec, and it is also correct — composite `{ts, id}`, both types validated on decode,
compared in memory against a JS array, so it never reaches a `uuid` column.

### What the sweep actually found

**Boundary: `services/crypto-orders.ts`, the four sites that establish a scan bound (`scanLimit ?? <n>`),
each mapped to its enclosing method.**

```
listForAdminPage            1_000    discloses truncated: NO
getDailyBreakdownForAdmin  10_000    discloses truncated: YES
getStatsForAdmin           10_000    discloses truncated: YES
getPendingAgeHistogram     10_000    discloses truncated: YES
```

**The published shapes agree.** `GET /v1/admin/crypto-orders` publishes `{ orders, next_cursor }`; its
three siblings on the same resource publish `truncated`, two of them `scanned` as well. `truncated` occurs
10 times in the spec, so disclosure is the established convention and this is the exception to it.

⛔ **The silent one is the case where silence costs most.** The other three return an aggregate — a
truncated total is wrong, but it is visibly a total. This one **paginates**, and when the cursor's anchor
falls outside the 1000-row window it returns `{ orders: [], nextCursor: null }` — byte-identical to "you
have reached the end", which its own comment names as the caller's stop signal. **Three states collapse
into one response**: no more rows, a malformed cursor, and a list longer than the window. `scanLimit` is
service-internal, so an admin cannot widen it from the route.

**Latent, not live**, and stated as such: it needs more than 1000 crypto orders, and the operator runbook
records that there is no live merchant account. **Not fixed here** — adding a field to a published admin
response is a contract change and belongs with the owner, the same disposition as W-10 and V-1988.

**The unblocked half landed instead**: a roster arm on the drift guard asserting that every scan-bounded
method discloses truncation _except_ the one named, with the exemption unable to rot — if
`listForAdminPage` ever starts disclosing, or stops bounding, the arm says so. That is V-1048's philosophy
(a thing that cannot succeed is on a list somebody had to look at) applied to a thing that cannot tell you
it was cut short, and it stops a **fifth** bounded scan landing silently on the undisclosed side.

⛔ **My guard was a rubber stamp on its first mutation, and only mutating caught it.** Planting a fifth
bounded scan left it **green**. The attribution walk-back used `/^ {2}(?:async )?([a-zA-Z]\w*)\(/`, which
cannot match a name beginning with `_`, so the probe method was invisible and its bound was misattributed
to an earlier, disclosing method. Widened to `[A-Za-z_$][\w$]*` and re-proved with **two** plants — one
underscore-prefixed, one ordinary (`listRecentForAudit`) — each now redding with the offender named. The
floor was probed rather than trusted: forcing it reports 4, the exact population.

⭐ The transferable half: **an arm whose subject is "methods matching a shape" needs a plant whose NAME is
ordinary.** I chose `__probeBoundedScan` because it looked obviously synthetic and easy to spot in a diff,
and that choice is precisely what made the mutation land in the one blind spot my regex had.

## V-2015 — the guard I landed yesterday knew one word for a two-word convention; and the cursor family, twice misread, is clean (2026-08-27)

2026-08-27. Two things, from one sweep.

### The guard was one token short of its own subject

V-2014's roster arm required every scan-bounded method to publish `truncated`. Sweeping the class
repo-wide to check whether its file scope was too narrow — the V-2007 question — turned the instrument on
itself. **Boundary: every `<name>Limit ?? <n>` default in `apps/server/src/services/*.ts` outside
comments, 25 sites, nothing filtered out.** Three disclose at 10_000, `listForAdminPage` is the silent one
at 1_000, `sweepExpiredOrders` bounds at 500, and the remaining 20 are page sizes (50) or cap checks (0).

⛔ **I classified `sweepExpiredOrders` as undisclosed. Reading refuted it.** It returns
`{ expired, capped }`, and its own comment calls `capped` _"the honest signal"_, explaining that an exact
remaining count would require the full-table scan the limit exists to avoid. **The disclosure vocabulary in
this codebase is two words, not one** — measured: `truncated:` 13 occurrences, `capped:` 19, and nothing
else (`partial` is a `CryptoOrderStatus` literal; `hasMore` means "more pages are reachable", which is the
opposite claim). Sweep the shape — disclosure — not the token.

`sweepExpiredOrders` is outside the arm's population today (it bounds with `limit`, not `scanLimit`), so
there was no live false red. **But the arm would have redded on a correct `capped` disclosure the moment
one landed under `scanLimit`, and a guard that cries wolf teaches people to widen the exemption list
instead of the answer.** Predicate widened to `/\b(truncated|capped):/`.

**Proved on both sides, with ordinary method names** (V-2014's lesson — a plant named `__probeX` landed in
the one blind spot the attribution regex had):

```
plant listRecentCapped  disclosing via `capped`   -> GREEN   (the widening works)
plant listRecentSilent  disclosing via neither    -> RED, naming listRecentSilent
```

⭐ **B is the control for A.** A green on A alone would also be what an invisible plant looks like; B shows
the arm does see a method of that name shape, so A's green is the disclosure and not blindness.

### The cursor family: read as a defect twice, clean both times

Chasing V-1565's cursor half further: **three different malformed-cursor behaviours back the published
list endpoints.** `parseUuidCursor` (8 repos) and `decodeDeliveryCursor` (webhook DLQ) both fall back to
the first page; crypto-orders' private codec returns an empty page.

**First misreading:** that crypto-orders violated a cross-cutting contract, since `decodeDeliveryCursor`'s
comment names one — _"first page, matching the prior 'invalid cursor → first page' contract"_. **Second
misreading:** that the published pagination doc over-generalised, promising the empty-page behaviour for a
matrix of eight endpoints, seven of which restart.

**Both wrong, and the doc is what settles it.** Its validation bullet says _"a malformed cursor (**not
valid base64url JSON of `{ts, id}`**)"_ — the crypto-orders cursor format specifically — and its lifetime
section names the `(created_at, order_id)` pair for the same reason. The doc self-scopes through the
format it names, and closes by saying encoding, ordering, limits, filters and field names are
route-specific. The SDKs are defensive independently: the pagination iterators terminate on an
empty-string cursor with a comment describing the exact `c1 -> "" -> c1` cycle that would otherwise occur,
plus a stall guard on an unchanged cursor.

**And the contract has no stranded callers.** **Boundary: every GET in `openapi.json` whose 200 schema
declares `has_more` or `next_cursor` — 16 operations.** Nine publish both; seven use `next_cursor: null`
alone as the completion signal; **zero publish `has_more` without a `next_cursor`**, which would tell a
caller more exists while giving no way to reach it.

⛔ **One slip worth recording.** My first attempt at the predicate edit asserted against text with ten
leading spaces; the file has eight. I had read the indentation off a `sed 's/^/  /'` display that adds two.
The assert caught it and nothing was written — **derive indentation from the file, never from a rendering
of it.**

## V-2016 — the bounded-scan class confirmed closed by a second detector shape, and a money-path route audited clean (2026-08-27)

2026-08-27. Two clean results, recorded so neither is re-derived.

### The bounded-scan class, re-measured with a differently-shaped detector

V-2014/V-2015 measured scan bounds by `<name>Limit ?? <n>`. **That is a token, and a bound can equally be
a named constant** — the third standing lesson applied to my own instrument. **Boundary: 196 files under
`services/` and `db/` (no migrations), every `const [A-Z_]*(MAX|LIMIT|CAP|WINDOW|SCAN)[A-Z_]* = <n>` that
is actually used as a limit in the same file.**

```
500  crypto-order-expiry-sweep-job.ts  CRYPTO_ORDER_EXPIRY_BATCH_LIMIT  file discloses (capped)
100  admin-accounts-repo.ts            ADMIN_ACCOUNTS_PAGE_MAX          caller clamp, not a scan window
100  profile-snapshots-repo.ts         SNAPSHOT_PAGE_MAX                caller clamp
 16  scrub-node-diagnostics.ts         …INPUT_MAX_LENGTH                input length, not a limit
```

**No new member.** A page maximum is not silent truncation — the caller asked for more than allowed, gets
the maximum, and receives a `next_cursor` to continue on. **Two independently-shaped detectors now agree
the class has exactly one member** (`listForAdminPage`), which is worth more than one detector agreeing
with itself.

### `billing-crypto-quote.ts` — audited end to end, sound and better guarded than I expected

Picked by V-1920's instrument: **one filename mention across both logs, 114 lines, customer-facing, money
path.** The route reads its price from `pricing.listEffective()` — the same authoritative read the crypto
CHARGE uses — and its own comment records why (reading the `TIER_PRICE_CENTS` constant directly "diverged
the quote from the charge the instant the owner edited a tier price"). It reports the SETTLEMENT currency
rather than echoing the caller's, with the defect that motivated it written down: quoting `api_scale`
rendered "€1,499.00" for an order that then charged $1,499 USD. It is stateless, scope-gated on
`read:billing`, and answers 400 rather than 500 for a tier missing from the price table.

**The gap I went looking for is already guarded, twice.** The route hand-maintains a literal
`SUPPORTED_PRODUCTS` of six tiers, so a new priced tier could be checkout-able but not quote-able.
`billing-crypto-quote-product-list-cross-source-invariant` asserts that list equals the price table
exactly, and — the part worth stealing — **also pins that the CHECKOUT route stays auto-derived
(`Object.keys(TIER_PRICE_CENTS)`), so the hand-maintained side remains the only one the guard must
watch.** `the-purchasable-product-set-is-one-set` (V-924) covers the published half, comparing derived
sets on both sides with a non-vacuity arm. Measured today: quote list 6, `AccountTier` 8, difference
exactly `free` and `enterprise`.

**One acknowledged limit, already documented, not a finding:** quote and charge are separate requests each
doing its own read, so an owner price edit between them can change the charged amount relative to the
quoted one. The route says so — _"'quote == charge' means same SOURCE, not same instant… There is no
quote-binding token."_ Naming it is what keeps it from being rediscovered as a bug.

## V-2017 — the acting-as split is by trust boundary, and a tripwire already guards it (2026-08-27)

2026-08-27. Audited `account-oauth-links.ts` end to end — **picked by V-1920's instrument: two filename
mentions across both logs, 84 lines, a customer-facing auth surface.**

**Sound, and read-only by design** (driftstack-side revoke is a separate slice). `requireAuth` +
`requireScope('read')` + the global bucket; `listForAccount(ctx.account.id)` so a caller can only ever see
their own links; the querystring is Zod-validated rather than trusted from the `Querystring` generic, with
V-1367's reason written down — a repeated query key parses to an ARRAY, so `?active_only=true&active_only=true`
used to return **200 with the revoked links the caller asked to hide**, a wrong answer rather than an
error. The public projection deliberately omits `provider_avatar_url` and `provider_name` so a future
re-link cannot leak as a profile update.

### The question worth asking: it does NOT resolve the acting-as header

**Boundary: the seven `/v1/account/*` route modules, counting `resolveEffectiveAccount` /
`readEffectiveAccountHeader` references.**

```
account-me            3 / 3      honours acting-as
account-audit         3 / 3      honours acting-as
account-oauth-links   0 / 0
account-web-sessions  0 / 0
account-mfa           0 / 0
account-notifications 0 / 0
account-rate-limits   0 / 0
```

⭐ **That split is by trust boundary, not by accident.** Under `X-Driftstack-Account` a team admin acts as
the owner. Four of the five that ignore it are personal credential surfaces — OAuth links, web sessions,
MFA, notification preferences — and the two that honour it are the account profile and the audit log,
legitimately team-scoped. **The safe direction is the one taken:** those routes can never return another
account's credentials, whatever header arrives.

**`account-rate-limits` is the fifth and its reason is different, which is worth getting right rather than
lumping in.** It ignores the header because the limits that apply to the caller ARE the caller's own — the
e2e spec `acting-as-an-owner-spends-your-own-bucket` pins exactly that: _"a member acting as an owner
charges their OWN bucket at their OWN capacity."_ Reporting the owner's buckets there would describe
limits the caller is not subject to. That spec exists because of a real destructive bug on the adjacent
control-key path, where two writers sharing one Redis key disagreed on capacity and a conservative `free`
floor collapsed a paying owner's 6,000-token bucket to about 59.

### And it is guarded, in the direction that matters

`effective-account-header-authz-invariant` parses every route with the **TypeScript AST** — so aliases,
generics and formatting cannot hide a read — and asserts that every `readEffectiveAccountHeader` call is
passed directly as `resolveEffectiveAccount`'s acting-account argument, that no route holds a raw
`X-Driftstack-Account` literal, and it carries adversarial arms for an aliased parser, a local-function
alias, and multiline composition.

**The roster arm answers my question directly.** It pins `reads` at exactly 32 across exactly 10 files, and
calls itself _"a review tripwire, not the security assertion"_. The scan walks every non-test `.ts` in
`routes/`, so **a credential route gaining acting-as behaviour moves both numbers and trips a review** —
which is the control I was looking for. The exact count also serves as its own non-vacuity check: an
emptied walk reads 0, not 32.

⚠️ **One weakness, stated because a tripwire that can net out is worth knowing about.** It pins COUNTS
(32 reads / 10 files) plus the exact route pairs for `account-me.ts` alone. A change that adds a read to a
credential route while removing one elsewhere nets to 32/10 and passes. That affects only the
review-prompting, not safety — the security assertion beneath it is set-based and complete — and the arm's
own framing is honest about which half it is. **Not changed**: the guard is carefully reasoned, its author
scoped the claim correctly, and widening the pinned pairs from one file to ten is a judgement about review
noise rather than a defect.

## V-2018 — "two writers sharing one key must agree on its capacity" was an instance fix; now it is a class guard (2026-08-27)

2026-08-27. `middleware/rate-limit.ts` carries an invariant that came out of a real, destructive incident:
the store key is `rl:<accountId>:<bucketKey>` with no tier in it, the token-bucket script persists
`math.min(capacity, …)`, so a writer arriving with a LOWER capacity **permanently truncates** the other's
bucket. A control key charging a conservative `free` floor collapsed a paying `api_scale` owner's
6,000-token bucket to about **59**, for as long as the desktop Simulator kept polling. The fix routed the
control key through the same live owner authority the effective-owner path already used.

**Re-asked as a post-condition, and it holds.** **Boundary: every bucket-key literal in
`apps/server/src` — `bucketPrefix: '<x>'` and `` key: `<x>:` `` on the IP/internal side, `rateLimit('<x>')`
on the account side.**

```
IP/internal key prefixes : 14   egress_echo, global_ip, oauth_provider_*, status_*, atlas_priority_token …
account bucket keys      :  4   global, sessions:create, agent_sessions:message, agent_sessions:input_event
INTERSECTION             :  0   the namespaces are disjoint
```

Within the account namespace all 198 `rateLimit('global')` call sites reach the store through one
middleware that derives capacity from a single authority, which is what the incident fix established.

### The instance was fixed; the class was not

A new call site consuming a token bucket with its own capacity, on a key colliding with an existing
namespace, reproduces the incident exactly and **no test would have noticed** — the existing guards are
per-file drift pins on `ip-rate-limit.ts` and the route files, none of which sees the class. New guard,
`a-bucket-key-is-written-by-one-authority`, with three assertions and a rot arm: namespaces disjoint; a
token-bucket consume lives only in an acknowledged writer (`services/rate-limit.ts`,
`middleware/ip-rate-limit.ts`, `routes/internal-atlas-priority.ts`); and every listed writer must still
exist and still consume.

⛔ **The rot arm caught my own detector on the very first run.** I keyed it on
`.consume({ … capacity: … })` — an inline object — and `ip-rate-limit.ts` builds `consumeArgs` as a
variable and passes it, so the file scored **zero** and the "listed writer no longer consumes" arm fired.
Without that arm the guard would have shipped watching two of its three writers. **A roster arm that
checks its own exemptions is also checking the detector that populates them.**

Corrected to the shape — the module calls consume AND declares a capacity — and **validated in both
directions**: it finds exactly the three real writers, and excludes `services/auth-flows.ts`, which calls
`.consume(` three times on the MFA challenge store and never mentions a capacity. A receiver-name detector
would have got that wrong in one direction or the other.

**Mutation-proved on real subjects, restored byte-identical:** changing `egress-echo`'s prefix to `global`
reds the collision arm naming `global`; planting a bucket consume in `routes/legal.ts` reds the roster arm
naming `routes/legal.ts (1)`. **All three non-vacuity floors probed rather than trusted** — 342 source
files walked (floor 300), 14 prefixes (floor 10), 201 account bucket-key call sites (floor 50).

`EXPECTED_TEST_FILES` 3065 → 3066 and `EXPECTED_TEST_FILES_ALL` 3241 → 3242 for the one file added; the
two pins that reference those constants name them rather than their values and still pass.

## V-2019 — the token bucket has no memory-vs-Redis seam, and the one untested shape is the one now prevented structurally (2026-08-27)

2026-08-27. V-2018 guarded the key-collision class statically. The obvious follow-up is whether the
MECHANISM behind the incident is testable at all where the tests actually run — the V-1576 question, asked
of the rate limiter.

**No seam here, and the reason is that both implementations spell the clamp identically.**

```
redis-rate-limit-store.ts  (Lua)   local refilled = math.min(capacity, tokens + elapsed * refill_per_sec)
memory-rate-limit-store.ts         const refilled = Math.min(capacity, existing.tokens + refill)
```

Both clamp to the capacity passed IN, so a writer arriving with a lower capacity truncates the bucket in
**either** store. **A test against the in-memory store can reproduce the incident** — which is the opposite
of the profile-route situation V-1576 measured, where the in-memory double answers 200 for input that
would 500 against Postgres. The difference is that this double implements the same arithmetic rather than
standing in for a database.

**And the Lua script is tested against real Redis**, not just replicated in JS:
`redis-rate-limit-lua-token-bucket.test.ts` opens with _"CRITICAL redis is reachable, so the arms below
cannot pass vacuously"_ — a reachability control before the behavioural arms — then covers a fresh key
starting full, draining to exactly capacity, spending the LAST token (pinning that the allow branch is
`>= cost`, not `> cost`), refilling in proportion to elapsed time and never past capacity, and **100
concurrent consumes on one key yielding exactly capacity successes**.

⛔ **One shape is absent, and naming it is the point.** Every Lua arm uses a SINGLE capacity. The incident
was two writers with DIFFERENT capacities on one key, and no behavioural test drives that — which is
consistent, because after V-2018 the situation is prevented structurally rather than detected at runtime:
the namespaces are disjoint and a new consume site has to be acknowledged. **A property enforced by
construction does not need a behavioural test, but it does need someone to have noticed that is why the
test is missing** — otherwise the next reader adds one and concludes the gap was an oversight.

**No code changed.** Recorded so the "is the memory store a faithful double?" question is answered once for
this subsystem, with its answer (yes, for the arithmetic) and its boundary (the two-capacity case is
structural, not behavioural).

## V-2020 — a reachability argument recorded in prose, made enforceable (2026-08-27)

2026-08-27. An archived entry examined `BACKOFF_MS_BY_ATTEMPT`, found the tables identical across the
rails but the **per-lookup fallbacks divergent by a factor of sixty** — the durable service reads
`?? 60 * 60_000`, the worker `?? 60_000` — and proved the divergence inert: both lookups sit behind a DLQ
boundary at 6, both tables carry keys 1–5, so no reachable attempt number misses. It changed nothing, and
said why: _"the divergence is real and the consequence is nil, and those are different things."_ That was
the right call.

**Re-asked as a post-condition, the argument still holds — and I checked the half it did not.** **Boundary:
the three real definitions (`durable-webhook-delivery.ts`, `webhook-worker.ts`,
`webhook-delivery/src/in-memory.ts`; the package's `index.ts` re-exports and `types.ts` only mentions it in
prose), plus every lookup site.** The archive argued the UPPER bound. The lower one holds too: the durable
rail indexes `attemptNumber` and the worker `delivery.attempts + 1`, so neither can present `0` to a table
keyed from 1 — worth checking because `webhook-worker.ts:55` documents "attempt indices 0..5", and a
0-based index against a 1-keyed table would have missed on the FIRST retry.

⛔ **What nothing enforced is the link the argument rests on.** Raise `DEFAULT_MAX_ATTEMPTS` to 7 without
extending the tables and attempt 6 becomes reachable on both rails: **the same failing endpoint then
retries after one HOUR on the durable path and one MINUTE on the worker.** Every existing arm stays green —
they pin each table's SIZE at 5 and compare the tables to one another, and both remain true when the
boundary moves. **A reachability argument written in prose protects nothing once the constant it depends on
is edited by someone who never read it.**

New arm on `webhook-backoff-schedule-agrees-everywhere`: the attempt numbers each DLQ boundary admits must
be exactly the table's key set, on both rails — `DEFAULT_MAX_ATTEMPTS` imported from the durable service,
`MAX_ATTEMPTS` parsed out of the worker source.

**Mutation-proved in three directions, each restored byte-identical:** raising the durable boundary to 7
reds with `expected [1,2,3,4,5] to deeply equal [1,2,3,4,5,6]`; raising the worker's does the same on its
own rail; and adding an unreachable key 6 to the durable table reds _two_ arms — mine and the existing
size pin — so the reciprocal drift was already covered and now has a second witness that names the reason.

⭐ The transferable half: **when an entry concludes "real divergence, nil consequence", the consequence is
nil only while some invariant holds — and that invariant is usually a relationship between two constants
in different files.** Writing the relationship down is worth less than asserting it, and the assertion is
generally three lines.

## V-2021 — the guards corrected themselves; the prose that cited them could not (2026-08-27)

2026-08-27. V-2020's lesson turned into a sweep: **53 recorded "cannot fire / unreachable / inert"
conclusions across both logs**, each resting on an invariant nobody asserted. Working them found one
already fully closed and one whose premise had quietly become false.

**V-1653 — nothing to do, and better covered than I expected.** Its trap (a `clientReferenceId` branch that
would take precedence over the derived customer id, with no cross-check) is still unreachable — all five
call sites pass `null`, verified — **and it is tested against real Postgres**:
`db-stripe-webhook-attribution-drizzle` drives the unwired branch's precedence, and pins the seam
explicitly — _"a NON-UUID client_reference_id THROWS against Postgres, where the in-memory double returns
null"_ — with a further arm freezing that disagreement deliberately.

### V-1524(c): the premise fired, and three documents did not notice

That entry parked an item as unreachable because "nothing constructs `AuditArchiveService`". **V-1591 wired
it.** `bootstrap.ts` constructs the service and `registerSessionEventsArchiveJob` +
`enqueueNextSessionEventsArchive` claim it on a recurring chain.

⭐ **Precision matters more than the finding here, and the first framing overstated it.** The job takes
`Pick<AuditArchiveService, 'archiveTable'>` and calls `archiveTable('session_events', …)`. **Post-condition:
`archiveAll()` is invoked nowhere in `apps/server/src`** — so ADR-006 §3's HEADLINE, "a cadence that has
never run", still holds exactly. What went stale is the evidence offered for it, in three places:

```
ADR-006 top note   "nothing constructs it: bootstrap never calls it"
ADR-006 §3         "not constructed in bootstrap.ts, no recurring job claims it,
                    and every-service-is-wired-or-recorded-as-dormant lists it as dormant"
services/audit-archive.ts   the same claim + "tick-services-are-wired lists this service
                            in NOT_WIRED_PENDING_DECISION for exactly that reason"
db/audit-archive-repo.ts    "it has never run: no scheduler was ever added"
```

⛔⛔ **Every one of those cites a guard that now says the opposite — and each guard carries an arm that
FORCED its own correction.** `every-service-is-wired-or-recorded-as-dormant`: _"a recorded-dormant service
that becomes wired must leave the list"_. `tick-services-are-wired-invariant` records the removal in its own
comment — _"V-1591 — was THREE. AuditArchiveService is wired now"_. The top note even closes _"this note and
that guard move together"_. **The guard moved. The note did not.** The executable half of the record
self-corrected on the day it changed; the prose half had no mechanism and drifted for days, on a privacy
retention promise, where the reader who meets it cold is a diligence or counsel review.

**Corrected per the repo's contradicted-ADR convention** — the 2026-08-19 note is PRESERVED and a dated
2026-08-27 note added beside it, so the record shows what was true when written; `Status` untouched, because
`docs/adr/README.md` requires a superseding ADR for `Superseded by`. Both source headers corrected. A
debt-tracker arm pins the new note and, deliberately, pins that it still states the half that holds —
without that, a future reader could take "V-1591 wired it" for "ADR-006 is implemented", which is a
different wrong answer. Mutation-proved: deleting the note reds exactly that arm; restored byte-identical.
11 files / 109 tests green across the ADR, both sources, and the four wiring guards.

⛔ **My first retraction quoted the phrase it retracted, and my own post-condition caught it.** Grepping
`apps/server/src` for the retracted clause returned two hits — both inside the corrections I had just
written. That is precisely why the standing rule is _retraction paraphrases, sentinel quotes_: a quoted
retraction leaves the false sentence findable and indistinguishable from a live claim. Reworded to
paraphrase; the post-condition then returns zero. **The ADR is the deliberate exception** — that convention
preserves the original text, so a grep finding it there is the convention working, not a leak.

## V-2022 — V-1750's arithmetic, verified against the right constant and made executable (2026-08-27)

2026-08-27. Continuing the sweep of recorded reachability arguments. V-1750 noted that `safeguardChecks`
permits `.max(16)` entries each with `detail: z.string().max(4096)`, that **16 × 4096 = 65,536 = exactly
the frame cap**, and that this is safe only because the producer emits three entries — closing with
_"the producer is what makes it safe today, not the schema"_ and a ⚠️ that the arithmetic "becomes live the
day safeguardChecks turns dynamic".

**Verified, and measured rather than recomputed.** **Boundary: the schema at
`harness-control-protocol.ts:1233-1242` and the cap at `:130`.** A max-size array alone serializes to
**66,263 bytes** — over by 727 before any other field — and `CapabilityReportSchema`'s transform rejects it.

⛔ **One correction to the archive: V-1750 named the wrong constant.** It compared against
`HARNESS_HEARTBEAT_MAX_SERIALIZED_BYTES`; a capabilityReport frame is bounded by its own
`CAPABILITY_REPORT_MAX_BYTES`. Both are `64 * 1024`, so **the arithmetic and the conclusion are
unaffected** — but the constant cited is not the one that binds this frame, and a reader checking the claim
would have verified a neighbouring cap.

⛔ **Half of this invariant is not assertable in this repo, and that is the finding.** `buildCapabilityReport`
does not exist here — a post-condition search finds only consumers in `apps/gui-client` and the schema
itself. The producer is the Swift harness in the driftstack repo, which is out of bounds. So "emits exactly
three entries" cannot be guarded from here; **only the arithmetic can.** V-1750 said as much and left it in
prose.

New arm: a frame whose every per-field cap is respected — the array at exactly 16, each detail at exactly
4096, both asserted so the fixture cannot drift off the ceiling it is testing — is rejected on the
aggregate. It follows the `activeSessionStates` arm already in that file, which makes the identical point
for a different field.

**Mutation-proved, and honestly scoped:** raising the cap to 1 MiB reds it. ⚠️ It reds **two existing arms
too**, so this is not the sole witness to a cap change — it is the one that names the `safeguardChecks`
arithmetic, which is the thing V-1750 predicted would go live. The first run of the mutation showed only
the two pre-existing failures in a truncated view; re-run grepping for this arm's own title before
claiming it fired.

⛔ **Two instrument slips, both caught.** An `import {...}` anchor matched twice — once in the import block,
once inside an existing arm — and the assert stopped the write; resolved by locating the import block's
bounds and deriving the indentation from the file. Earlier, a probe listing the module's exports was piped
through `tail -6`, and `CAPABILITY_REPORT_MAX_BYTES` sorts first alphabetically, so I read a truncated list
as complete and briefly concluded the constant was not exported. It is; there are 103.

## V-2023 — the reachability sweep triaged, and the one input that keeps an auth premise true (2026-08-27)

2026-08-27. Finishing the sweep V-2020 started. **Boundary: 53 lines across both verification logs
asserting a reachability conclusion ("cannot fire", "unreachable", "no input reaches", "dominated by",
"is inert").** Working the candidates whose invariant is a constant or caller-set relationship produced a
triage rule worth more than any single one of them.

⭐ **Not every recorded "unreachable" needs asserting. Only the ones where the condition changing is BAD.**

```
V-2020  backoff fallbacks      BAD      diverge 60x once attempt 6 is reachable   -> asserted
V-2022  safeguardChecks caps   BAD      schema-valid frames rejected on aggregate -> asserted
V-1902  empty-token early return  BAD   skips the rate limit AND auth             -> asserted here
V-1653  clientReferenceId      BAD      takes precedence, never cross-checked     -> already tested, real PG
V-1834  usage-repo `continue`  BENIGN   a defence-in-depth filter starts working  -> nothing to do
V-1524c AuditArchiveService    FIRED    three documents went stale                -> corrected (V-2021)
```

⭐⭐ **V-1606 is the model, and it was written before any of this.** It found that a null `account_id`
collapses every caller into one `_anon` idempotency scope, verified unreachability by tracing the single
`createIdempotent` call site (still exactly one, behind `requireAuth` + `requireScope`), **and then built
the guard anyway** — its own words: _"This file fails on that change rather than after it, and says in its
header what the next person has to decide."_ That is the whole lesson, already practised.

### V-1902's premise, verified on both branches and now pinned

`routes/internal-atlas-priority.ts` opens its per-token limiter with `if (token.length === 0) return;` — a
bare return that skips the rate limit — annotated "validate() would have already thrown; defensive".
**Verified, and it is stronger than the entry claimed:** `validate()` throws when `tokenBuf === null`
(auth disabled), and otherwise the constructor guarantees `tokenBuf.length > 0`, so an empty candidate
fails the length pre-check. Unreachable on **both** deployment shapes, not just the configured one.

**The premise was guarded by branch and not by input.** The existing arms cover the disabled deployment,
the length-mismatch branch and the constant-time compare — but every fixture is a non-empty token, and
`Authorization: Bearer ` with nothing after the space is the ONE value that yields `token === ''` in that
preHandler. New arm supplies exactly that, on both deployment shapes.

**Mutation-proved, and it is the sole witness.** Letting an empty candidate skip the length pre-check
(`candidate.length !== 0 && …`) reds **one** arm of eight — the new one. The pre-existing "different
length" arm passes straight through it, because `'Bearer short'` is length 5 and still hits the mismatch
throw. ⭐ **The branch was covered; the input was not** — the same distinction V-2005 found when a refusal
fixture of 9 and 40 characters never reached a 36-character branch, and V-2007 found again at 10
characters against a 36-wide pattern. Third and fourth instances of one rule: **a refusal fixture must be
the value the other side actually produces.**

## V-2024 — eight hand-copied audit wrappers, all recording on failure, all pinned; and a grep that invented a gap twice (2026-08-27)

2026-08-27. V-1890 mentioned in passing that an admin audit wrapper "records on BOTH paths —
`result: 'success'` in the try, `` result: `error: ${code}` `` in the catch before re-throwing". That is a
property worth holding across a compliance surface, and the wrappers are hand-copied, so it is a
divergent-copy question.

**Boundary: the eight `withAudit*` definitions across six route files in `apps/server/src/routes` —
`admin-accounts` (three), `admin-crypto-orders`, `admin-force-actions`, `admin-incidents`,
`admin-validation-harness`, `admin-webhooks`. No shared implementation; each is its own copy.**

**All eight record on the error path**, with the same field set and a re-throw. Verified by reading
`admin-webhooks`' in full rather than trusting the sweep, and the sweep's detector was checked against a
constructed success-only wrapper, which it flags. A uniform 8/8 is the shape that usually means the
instrument is broken; here it survived both checks.

### ⛔ Then my second instrument invented a gap, twice, and mutation refuted it both times

Asking "is the error path PINNED?", I grepped the six content-parity files for `error: ${code}`,
``result: `error`` and `catch (err)`. Two came back **zero** — `admin-force-actions` and
`admin-incidents` — which reads as two compliance surfaces where dropping the audit-on-failure would go
unnoticed.

**Both are pinned. Dropping the catch body proves it:**

```
admin-force-actions  -> reds "withAudit wrapper: D-025 success + error dual-write with deferred
                        target/payload authority"
admin-incidents      -> reds TWO arms, including one pinning the error-code derivation
                        ("NotFoundError" → "notfound") because the admin audit-log filter chips read it
```

The pins simply word their assertions differently than my three patterns. **Grepping the guards asks
whether they use MY wording; mutating asks whether they catch the change.** Those are different questions
and only the second is the one I wanted.

⭐ **Second time today.** V-1998 read a pin that stopped one character short of a regex flag and concluded
the flag was unpinned; it was pinned twice, in files I had not opened, and mutation is what showed it.
**To ask whether a property is guarded, break it.** A guard census answers a question about vocabulary.

**No code changed.** Recorded because "eight hand-copied wrappers on the audit path" is exactly the shape
that usually yields, and this time the copies agree and every one is held — worth knowing before someone
spends another sweep on it.

## V-2025 — the AAD-purpose census was keyed by basename, and 18 basenames are not unique (2026-08-27)

Started from the cross-file duplicate-name census (V-2024's boundary: 342 tracked `.ts` files under
`apps/server/src`, comment lines stripped) and picked `buildAdditionalAuthenticatedData`, 6 copies, as the
sharpest candidate — an AAD binds a ciphertext to its context, so disagreeing copies mean decrypt failures
or context confusion.

**The premise was wrong, and reading refuted it.** The 6 are not copies of one function. They are six
per-domain builders that share a name, each binding a different tuple:

```
lib/byok-anthropic-encryption.ts            [PURPOSE, 2, accountId]
lib/platform-secret-value-encryption.ts     [PURPOSE, 2, name, ROLE]
lib/webhook-secret-encryption.ts            [PURPOSE, 2, accountId, endpointId, ROLE]
lib/gui-control-key-encryption.ts           [PURPOSE, accountId, sessionId]      + field-width validation
services/agent-session-transcript-…ts       [PURPOSE, accountId, sessionId]      + field-width validation
services/recipe-payload-encryption.ts       [purpose, 2, accountId, recipeId, slot]
```

Divergence is the design. Two conventions coexist — nine bind the version as its own element, two spell it
into the label (`…v2`) — and `gui-control-key` uses colon separators where the rest use dots. Both bind the
version; the split is stylistic, not a defect.

⛔⛔ **My census printed a verdict over an empty set.** `git grep -hoE "AAD_PURPOSE\s*=\s*'[^']+'"` returned
**0 rows**, and my template still printed `COLLISIONS: none — every domain has its own purpose ✓`. **`git
grep -E` is POSIX ERE, where `\s` is not a class**; the same pattern with a literal space returns 12. A
zero population is the one input on which a distinctness check cannot fail, and I wrote the conclusion into
the print template rather than deriving it. Re-measured with a Python walker, proved against an injected
duplicate: **12 `*AAD_PURPOSE` constants under `apps/server/src`, 12 distinct values, no collisions.**

⛔⛔ **The guard I was about to write already exists, and anticipated that exact error.**
`mfa-encryption-key-shared-cross-source-invariant.test.ts` carries `aadPurposes()` — the same walk — plus a
non-vacuity arm whose stated job is that _"the distinctness arm below cannot fail on an empty map"_, a
distinctness arm, and an arm pinning that the four modules sharing `MFA_ENCRYPTION_KEY` carry four
different labels, because byok-anthropic and mfa-totp build identically shaped `[purpose, 2, accountId]`
AAD from the same key — there the label is the entire cryptographic distance between a stored Anthropic
API key and that account's TOTP secret. Found by opening prior art before writing, not after.

### The real finding: the census key

The walker keyed its map `` `${entry.name}:${constant}` `` — **basename**, not path. Measured: **18 of the
342 files under `apps/server/src` share a basename with another** (`auth.ts` x3, and the `routes/X.ts` +
`services/X.ts` pairing this repo uses throughout). Two same-named files each declaring the bare
`AAD_PURPOSE` collapse to one entry, and the collision disappears with the evidence.

The arm's own title had already reasoned one level down — _"a census keyed by name alone would drop a
second bare declaration and pass by losing the evidence"_ — and a basename is not unique either.

**Mutation-proved both directions** by planting `lib/zz-aad-probe.ts` + `services/zz-aad-probe.ts`, same
basename, same constant name, same label:

| census key                      | result against the plant                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `entry.name` (before)           | **9/9 GREEN** — blind                                                                |
| `relative(SRC_ROOT, p)` (after) | reds, naming `lib/zz-aad-probe.ts:AAD_PURPOSE, services/zz-aad-probe.ts:AAD_PURPOSE` |

Re-proved against the final prettier-formatted bytes; plants removed; 9/9 green on the clean tree; `it(`
count 9 at HEAD and 9 in the tree.

⚠️ The non-vacuity arm is a floor (`> 9`) against a population of 12, so a silent drop of one entry would
not have redded it either. Left as-is — the floor follows the repo's just-under-measured-N convention, and
the path key removes the mechanism that would drop an entry.

⛔ **An aborted edit script printed like a success.** My first patch asserted on JSDoc line-wrapping I had
typed from memory rather than derived; it died on the first `assert`, edited nothing — and the `prettier`
and `9/9 passed` lines that followed printed exactly as they would have on success. The assert is the only
reason that was visible. Same shape as V-1976/V-1986/V-1988.

## V-2026 — eight modules share MFA_ENCRYPTION_KEY, not four; the guard's roster named half (2026-08-27)

Followed the duplicate-name census to `decodeKey`, 8 copies — the least-covered candidate (no prior
verification-log entry; the two memory hits were `project_livekit_secret_encryption_audit_clean` and
`project_config_env_validation_audit`, both opened first).

**All 8 copies are one behaviour.** Boundary: 342 tracked `.ts` files under `apps/server/src`, comments
stripped, whitespace-normalised — 8 `function decodeKey(` definitions, 8 "distinct" bodies, and every
difference is error-message text. Each does `Buffer.from(keyBase64, 'base64')` and rejects unless the
result is exactly 32 bytes. So the config audit's claim for its boot-time `.refine()` — _"identical decode
logic to decodeKey, so they can't disagree"_ — holds across all eight, not just the four it enumerated.

**And all 8 decode the SAME key.** `mfaEncryptionKey` is the only encryption-key field `config.ts`
declares (one Zod field, one env read), and `bootstrap.ts` hands `config.mfaEncryptionKey` to every
consumer, including `secretEncryptionKeyBase64` (platform secrets) and `payloadEncryptionKeyBase64`
(recipe payloads). So the fail-fast guarantee that audit established covers eight surfaces, and one
rotation rotates eight surfaces' ciphertexts — the header said four.

### What was actually pinned, established by mutation rather than by grep

`mfa-encryption-key-shared-cross-source-invariant.test.ts` is titled "4-class" and enumerates four `lib/*`
modules. Rather than infer under-coverage from the roster, I planted a rogue key source
(`process.env.WEBHOOK_ENCRYPTION_KEY ?? keyBase64`) inside `webhook-secret-encryption.ts` — one of the
four modules the roster does NOT name:

    Tests  1 failed | 8 passed (9)     <- rogueKeyEnvReads()

**It reds.** That arm walks all 342 files, so "no second key source exists" was already a tree-wide
property, and the distinctness arm (V-2025) spans all 12 labels tree-wide too. The four-module roster
governs only the per-module TEXT pins. ⭐ The roster reads like a coverage boundary and is not one — the
same shape as V-2024, where grepping guards invented a gap that mutation refuted.

### The one real hole, and the guard for it

A key-sharing module that silently loses its AAD label reds nothing: the distinctness census just gets
smaller and stays collision-free, and its non-vacuity floor was `> 9` against a population of 12.

Added `sharedKeyDecoders()` — walks for `function decodeKey(`, keyed by path relative to `SRC_ROOT` (the
V-2025 lesson) — and three arms:

| arm                        | mutation                                        | result                                                                        |
| -------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| census non-vacuity         | floor probed to `999999`                        | `expected 8 to be greater than 999999` — the guard's own walk, floor set to 7 |
| every decoder binds an AAD | renamed `WEBHOOK_SECRET_AAD_PURPOSE`            | reds: `[ 'lib/webhook-secret-encryption.ts' ]`                                |
| the exemption cannot rot   | gave `platform-secret-encryption` its own label | reds — exemption no longer load-bearing                                       |

⭐ **The exemption is keyed by its REASON, not by a filename.** Exactly one of the eight declares no label,
and it is exactly the one whose AAD is caller-supplied through an `authenticatedContext` parameter —
V-1679's finding, reached independently here. The clause reads "declares a label OR takes the context from
its caller", so a module that loses its label without gaining that parameter is caught, and a future
module cannot inherit the exemption by sitting in the same file.

Header corrected to state the real family size; the four per-module text pins left untouched, since they
pin prose those four files actually carry. 12/12 green, `it(` 9 → 12, `tsc -p apps/server/tsconfig.test.json`
clean.

## V-2027 — the app's JSON parser is chosen by billing configuration (2026-08-27)

Measured which route files have never been audited. Boundary: 60 route files under
`apps/server/src/routes`; "unmentioned" = the filename stem never appears in any
`docs/verification-log*.md`. **Exactly one: `_webhook-raw-body.ts`.**

It registers a global `application/json` content-type parser so webhook routes can reach the raw
bytes for HMAC verification, stashing `req.rawBody` only for URLs in a hand-written
`RAW_BODY_URLS` set. Two properties audited clean by reading:

- **The URL coupling holds today** — the set is exactly the two paths the two opted-in routes
  register, and both consumers **fail closed**: missing signature header → 401, then
  `typeof rawBody !== 'string' || rawBody.length === 0` → 400 _before_ any verification. A path
  that drifted out of the set would break the webhook, never forge one.
- **Route-level `bodyLimit` is not clamped by the parser's.** The parser declares
  `bodyLimit: 1 MiB` for all JSON, and three routes deliberately raise their own above it
  (`account-me` to 3.5 MiB). Read from the installed fastify 5.11.0 rather than recalled:
  `content-type-parser.js:237` picks `options.limit === null ? parser.bodyLimit : options.limit`,
  and `route.js:380` sets `options.limit = opts.bodyLimit || null` — **the route wins.** No app
  sets a server-level `bodyLimit`, so the default is fastify's own 1 MiB and the parser matches it.

### The finding: which parser runs depends on whether payments are configured

`registerWebhookRawBodyParser(app)` is called only from _inside_ the two webhook route registrars,
and `lib/app.ts:1338` / `:1350` call those registrars **conditionally**, on
`stripeWebhookSigningSecret` and `nowpaymentsIpnSecret`. Both trace to optional env vars —
`STRIPE_WEBHOOK_SECRET` and `NOWPAYMENTS_IPN_SECRET`, conditional spreads at `config.ts:770`/`858`.
So a deployment with neither configured never registers the parser and runs fastify's built-in one.

The two disagree on one input, and it is not a rare one:

| `Content-Type: application/json`, zero-length body | result                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| custom parser (payments configured)                | `text.length === 0 ? {}` → handler receives `{}`                 |
| fastify default (neither configured)               | 400 `FST_ERR_CTP_EMPTY_JSON_BODY` (`content-type-parser.js:314`) |

That reaches the whole API, not the webhook routes. **15 request-body schemas parse `{}`
successfully** — boundary: 88 `.ts` files under `apps/server/src/routes` + `packages/api-types`,
heuristic over TOP-LEVEL keys of `*Request|*Body*Schema = z.object({…})`, counting a key optional
if its segment carries `.optional()`/`.default()`/`.nullish()`; `CreateSessionRequestSchema`
verified by reading. So `POST /v1/sessions` with an empty JSON body **creates a session on a
payments-configured deployment and 400s on one without.**

⛔ **And the suite only ever exercises the configured side.** `build-test-app.ts:1485` sets
`stripeWebhookSigningSecret = 'whsec_test_fixture_secret'` unconditionally, so every integration
test registers the custom parser. The branch a minimal or self-hosted deployment actually runs has
no coverage at all.

**Not fixed — the fix picks a contract.** Registering the parser unconditionally makes every
deployment agree but changes empty-body behaviour where payments are unconfigured; making the
custom parser mirror `FST_ERR_CTP_EMPTY_JSON_BODY` makes them agree the other way and changes it
where payments ARE configured, which is production. Owner's call, alongside W-10.

**Guarded what does not need that call.** New
`a-webhook-that-needs-its-raw-body-declares-its-url.test.ts` walks `routes/` for opted-in files
rather than listing them — the file header invites the drift ("Stripe + NowPayments + future"):

| arm                                  | mutation                                             | result                           |
| ------------------------------------ | ---------------------------------------------------- | -------------------------------- |
| census non-vacuity                   | removed one `registerWebhookRawBodyParser(app)` call | 1 failed / 2 passed              |
| every opted-in path is declared      | dropped `/v1/webhooks/nowpayments` from the set      | reds naming the path             |
| every consumer refuses an empty body | neutered stripe's refusal to `if (false)`            | reds naming `webhooks-stripe.ts` |

⛔ The third mutation aborted first on `a=0`: I typed a 6-space indent read off a display that had
been piped through `sed 's/^/  /'`. Derived from the file it is 4. Same class as the aborted-script
entry in V-2025 — and the same assert caught it.

## V-2028 — the boot key probes audit clean, and an audit boundary re-measured rather than trusted (2026-08-27)

Same never-audited measurement as V-2027, widened. Boundary: files under `apps/server/src/{services,
lib,db,middleware}` whose filename stem never appears in any `docs/verification-log*.md` — **39 of
273** (services 24/141, lib 11/70, db 4/55, middleware 0/7). Picked `lib/boot-key-verification.ts`
for continuity with V-2026.

**It audits clean, and its own claim is exact.** The file exists to replace a raw
`"Unsupported state or unable to authenticate data"` at boot with a message naming the subsystem and
the env var, and its header says it was written as a function "rather than inlined nine times".
Measured: **9 `verifyBootEncryptionKey(` call sites**, all in `db/*-repo.ts`, and all 9 enclosing
methods are invoked from `lib/bootstrap.ts` — 8 envelope migrations plus `encryptLegacySecrets`.
Zero unreachable probes.

Its existing test file already pins the wrapper's behaviour across five arms — rethrows, does not
throw on success, names subsystem + env var, attaches `cause`, and can never see key material. What
none of them pins is that the wrapper is ON the boot path; a perfect wrapper that nothing calls is
still dead. ⭐ **That gap does not exist**: `lib-bootstrap-content-parity.test.ts` pins all 9
invocations, confirmed by mutation rather than by reading — neutering
`await recipesRepo.migratePayloadEnvelopes(500)` reds it with
`expected … to match /await recipesRepo\.migratePayloadEnvelopes\(500\)/`. **No guard added; the
useful result was not writing a redundant one.** Third time this session that mutating refuted a
gap a guard census suggested (V-1998, V-2024).

### The envelope write-lock verdict, re-measured because its own trigger had fired

`project_at_rest_envelope_versioning_audit_clean` (V-1873) recorded all NINE at-rest surfaces under
`apps/server/src/lib` as write-locked, and stated its expiry honestly: re-check on a new
`lib/*-encryption.ts` or an existing one gaining a second `createCipheriv`. **Two commits have
touched `apps/server/src/lib` since.** Ran the check: neither adds a `createCipheriv` or an
encryption module. **Verdict holds.**

⭐ **I expected a scope gap and did not find one.** The audit's boundary was a DIRECTORY (`lib`),
while the key-sharing family V-2026 established spans two (`services/recipe-payload-encryption`,
`services/agent-session-transcript-encryption`). Widening the measurement to all of
`apps/server/src`: `createCipheriv` occurs in **exactly 9 files, every one under `lib/`**. Both
`services/` modules delegate to `encryptPlatformSecret` — the shared low-level primitive whose
callers own versioning, exactly as recorded. Hypothesis refuted by measurement; the directory
boundary was the right one.

⛔⛔ **I hit the `git grep -E` class trap ~20 minutes after writing it into memory.**
`git grep -nE "webhooksRepo\.\w+" -- apps/server/src/lib/bootstrap.ts` returned **0 rows** — `\w` is
PCRE, not POSIX ERE — and I read that zero as "bootstrap never calls the webhooks repo", one step
from reporting a live boot probe as unreachable dead code. `bootstrap.ts:487` calls it. Only a wider
grep that happened not to use `\w` refuted it. Knowing the trap did not prevent it, so the rule is
now mechanical: no `\s`/`\d`/`\w`/`\b` in a `git grep -E` pattern, and **a zero that would itself be
a finding gets re-asked with an instrument that cannot fail the same way.** A negative about
REACHABILITY is the most expensive kind to get wrong — it turns live code into reportable dead code.

## V-2029 — a documented MUST that nothing enforced: the replay verifier's optional nonce cache (2026-08-27)

Continued the never-audited sweep (V-2028's 39) into the fleet nonce caches. **Both implementations
audit clean.** `lib/redis-fleet-nonce-cache.ts` is a single `SET key '1' EX ttl NX` — the command
_is_ the check-and-record, so there is no read-then-write window; the key is NUL-separated so a
crafted nonce cannot forge a different `(nodeId, nonce)` pair, and the TTL is clamped to `max(1, …)`
so a zero or negative lifetime cannot pin a nonce forever. `services/fleet-nonce-cache.ts`'s
in-memory variant is instantiated **nowhere under `apps/server/src`** — it is a test/dev double, and
production wires the Redis one from a non-nullable `const redis = new Redis(...)`.

### The finding is in the verifier, not the caches

`FleetNodeAuthImpl`'s second constructor parameter is optional, and `verify()` skips replay defence
entirely when it is absent:

```ts
constructor(private readonly repo: FleetNodesRepo, private readonly nonceCache?: FleetNonceCache) {}
…
if (this.nonceCache !== undefined) {           // <- absent cache = no replay check at all
  const firstSight = await this.nonceCache.checkAndRecord(claims.iss, claims.nonce, ttlSeconds);
  if (!firstSight) return { ok: false, reason: 'replayed_nonce' };
}
```

The optionality is deliberate and the source says so — signature/expiry unit tests want no
nonce-cache fixture — and the same JSDoc states the consequence: a captured fleet-node JWT "CAN be
replayed" within its 5-minute window, so "production deployments MUST inject the cache". ⭐ **That
MUST lived only in prose.** Omitting the argument is not a type error, because the parameter is
optional, and it reds nothing.

Measured: **exactly one production construction** (`bootstrap.ts:2537`) and it passes the cache. So
nothing is broken today — the exposure is the next one.

⛔ **And it was already half-guarded, which grepping would have missed in the other direction.**
`lib-bootstrap-content-parity.test.ts:570` pins both `new RedisFleetNonceCache(redis)` and
`new FleetNodeAuthImpl(drizzleFleetNodesRepo, fleetNonceCache)` as literals, and its title names the
risk outright ("split the nonce cache (replay-defence gap)"). **Fourth suspected gap this session
that mutation refuted.** What that pin cannot do is see a SECOND construction added elsewhere: it
asserts this line still exists, not that no unguarded construction exists — the distinction in
`a pin asserts a value, never that the value is enough`.

New `a-replay-verifier-is-never-built-without-its-nonce-cache.test.ts` walks `apps/server/src` (test
files legitimately use the one-argument form) and requires two arguments at every construction:

| arm                                                    | mutation                              | result                           |
| ------------------------------------------------------ | ------------------------------------- | -------------------------------- |
| census non-vacuity                                     | renamed the constructor out of src    | 1 failed / 1 passed              |
| every construction passes a cache                      | dropped the 2nd arg, single line      | reds: `lib/bootstrap.ts (1 arg)` |
| ⭐ same, **prettier multi-line with a trailing comma** | one real argument, one trailing comma | reds: `lib/bootstrap.ts (1 arg)` |

⭐ **That third row is the control V-1679 lacked.** Its argument counter counted depth-0 commas, and
prettier writes a trailing comma on every multi-line call — so a one-argument call spread over lines
counted as two and the guard passed a mutation it should have failed. This walker splits at depth-0
commas and **drops the empty tail**, so both spellings report `1 arg`. Sweep the shape, not the
token: the same defect has two spellings and only one of them looks wrong.

## V-2030 — a 5-second destructive sweep runs off process-local state (2026-08-27)

Generalised V-2029's wiring question across the codebase. Boundary: 342 tracked `.ts` under
`apps/server/src` — **17 exported `InMemory*` classes, 14 of which are constructed nowhere in `src`**
(pure test doubles; production wires a Redis sibling). The three that ARE wired in `bootstrap.ts`:

    InMemoryByokKeyCache              lib/bootstrap.ts   — accelerator, per-instance is correct
    InMemoryExitIdentityCache         lib/bootstrap.ts   — accelerator, per-instance is correct
    InMemoryPairModeHeartbeatTracker  lib/bootstrap.ts   — NOT an accelerator

The third has teeth. `PairModeHeartbeatSweep` is wired over it at `bootstrap.ts:3216` on a
`setInterval` every 5 seconds, and for each session it considers stale it fires the
`heartbeat-timeout` state-machine transition, persists the post-transition state, and emits an
`agent_session.pair_mode.timeout` customer audit row. Narrowed: **6 `setInterval` sites in
bootstrap, exactly one driven by process-local state** — this one. The other five read database,
Redis, or service state. (My first pass reported line 3187 too; that was my 40-line scan window
spilling from `statusSnapshotTimer` into the sweep below it, not a second site.)

**The assumption is documented, on one side.** `services/agent-pair-mode-heartbeat.ts` says
outright: _"Single-replica today. A future redis-backed swap can replace the in-memory Map with
redis-hash storage."_ Nothing enforces it, and the surrounding code is already multi-replica-ready
in a way that makes the assumption easy to violate by accident — the pair-mode **takeover lock** for
the very same feature is `RedisPairModeTakeoverLock` (`bootstrap.ts:1383`), and so are the fleet
nonce cache and the MFA challenge store. One half of pair mode is distributed; the other half is not.

⛔ **The V-785 boot seed amplifies it rather than containing it.** The tracker is seeded from
`agentSessionsRepo.listActivePairModeSessionIds()` — a **global** query, not one scoped to this
process — so on a two-replica deployment BOTH replicas adopt EVERY parked session. Heartbeats arrive
as ordinary HTTP requests and land on whichever replica the load balancer picks, so the replica that
does not receive them watches its own copy of the entry go stale and, 30 seconds later, times out a
session that is alive and heartbeating to its peer — terminating live customer work and writing a
customer-visible audit row saying it timed out. The seed is right for its stated purpose (V-785: a
restart must not strand a parked session forever); it is the global scope that does not survive a
second replica.

**Conditional, and the condition is not verifiable from this repo.** This is inert at one replica
and I cannot confirm the deployed replica count from source — stated rather than assumed.

⭐ **It joins a known class.** `docs/internal/2026-05-31-autopilot-run-handoff.md:820` already
records the scheduled-jobs `dedup:true` race in exactly these terms — _"LOW severity today
(single-replica … ) but a latent MULTI-REPLICA bug"_ — with a clean fix that needs a migration.
That makes two, recorded in two different places, with no inventory of the class and no ADR or
runbook stating the constraint that keeps both inert. The scheduled-jobs one costs a duplicate row;
this one costs a live customer session.

**Not fixed — the fix is a design choice** (redis-hash the tracker, or scope the seed to sessions
this process owns, or state single-replica as an enforced deployment constraint). Owner's call,
alongside W-10 and V-2027's parser question.

Audited clean along the way, both never-audited before: `services/mfa-challenge-store.ts` — `consume`
is `GETDEL` with no fallback (fails closed on pre-6.2 rather than degrading to a non-atomic read),
`incrAttempts` is one Lua step so a dead connection cannot strand an immortal counter, and
`releaseAttempt` is one Lua step so it can neither act on a replaced value nor resurrect an expired
key as `-1`; and `services/fleet-nonce-cache.ts` + `lib/redis-fleet-nonce-cache.ts` — a single
`SET NX EX` with a clamped TTL and a NUL-separated key, with the in-memory variant wired nowhere in
`src`.

## V-2031 — two more never-audited files, both clean, and six refuted gaps in one turn (2026-08-27)

Continued the V-2028 list, biggest-first.

**`services/session-duration-sweeper.ts` (10.3 KB, the largest never-audited file) — clean.** It
auto-destroys free-tier sessions past a 20-minute wall-clock cap, so the load-bearing claim is its
own: "Paid tiers have a null cap and are NEVER auto-destroyed." The tier loop is the right shape —
it iterates `AccountTierSchema.options` (derived, so a new tier is automatically considered) and
skips any tier whose `maxSessionMinutesFor` is null, rather than matching `'free'` by name. Measured:
8 tiers, exactly one capped. `MAX_SESSION_MINUTES_PER_TIER` is typed `Record<AccountTier, number |
null>`, so a new tier cannot be silently omitted — but it could be given a NUMBER, which would
enroll paying customers into a destructive sweep.

That is pinned, and conclusively: `api-types-common-content-parity.test.ts:169` pins the whole table
literally (`free: 20, solo_manual: null, … enterprise: null`), so any paid tier gaining a cap reds
it. Four further dedicated guards exist that I did not know about — `an-unbounded-paid-session-is-a-
visible-choice`, `the-published-free-session-cap-is-the-enforced-one`, `tier-cap-helpers-cross-
source-invariant`, `a-numeric-tier-cap-that-only-guards-creation`.

**`lib/hijacked-reply.ts` — clean.** `reply.hijack()` hands over the socket, so no `onSend` hook
runs and `x-request-id` plus the rate-limit headers the request already paid for are computed and
discarded. Measured: **4 real `.hijack()` calls across 3 route files, every one preceded by a
`writeHead` spreading `hijackedReplyHeaders(reply)`** (92→142, 123→213, 3591→3666, 5236→5280).

⛔ My first pass scanned the 12 lines AFTER each hijack and reported all four as missing the helper.
The helper runs BEFORE the hijack — writeHead first, then hand over the socket. **The window had the
wrong shape, not the wrong size**, and widening it would have produced the same wrong answer more
slowly. Reading one site settled it.

Also already guarded, by a test that derives the roster the same way this audit did:
`cors-allow.test.ts:117` counts the hijack sites in each file and requires a matching header call,
with the comment "a fifth hijack route cannot be added uncovered."

### The pattern worth recording

**Six suspected gaps this turn, six refuted** — V-1998-style guard censuses proposed a hole and
mutation or a direct read found the guard: the boot-probe roster (V-2028), the `FleetNodeAuthImpl`
construction (V-2029), the tier-cap table, the hijack coupling, and two smaller ones. The four
findings that DID survive were never missing guards; every one was a guard whose **derivation was
keyed or scoped a little too narrowly** — a census keyed by basename where basenames collide
(V-2025), a roster naming four of eight key-sharing modules (V-2026), a URL set with no tie to route
registration (V-2027), a literal pin on one construction site that cannot see a second (V-2029).

⭐ **So the productive question in a densely-guarded codebase is not "is this guarded?" but "what is
the guard's KEY, and is it unique over the population it walks?"** Asking the first question six
times cost most of this turn; asking the second produced every finding.

## V-2032 — the basename-key sweep is closed: V-2025 was the only instance (2026-08-27)

Applied V-2031's own conclusion — ask what a guard's KEY is, not whether the thing is guarded — as a
sweep. Question: does any other census guard key a collection by a BASENAME while walking a tree
recursively, the defect fixed in V-2025?

**Boundary: 2023 unit test files, 143 of which walk a directory tree recursively (`readdirSync` +
`isDirectory()`). One hit, refuted by reading. Zero remain.**

⭐ **The detector was validated against a known positive before its zero was believed** — the pre-fix
bytes of the very file V-2025 corrected, read straight out of `git show bbf81ea8e^:…`, with the
post-fix bytes as the negative control:

    detector on the KNOWN POSITIVE (basename key) : True  -> catches
    detector on the KNOWN NEGATIVE (path key)     : False -> correct

That control also caught the first version of the detector being too narrow: it matched only
`` .set(`${entry.name}…` `` and `.set(entry.name…`, missing a basename bound to a variable first.
Widened to resolve `const <v> = entry.name | basename(…)` and treat any key mentioning `v` as a
basename key — then re-validated on the same positive before running. Sweep the shape, not the token.

**The single hit was a false positive, and reading is what showed it.**
`dist-reading-suites-have-fresh-artifacts.test.ts` contains both a recursive walker and a
basename-keyed Set — in two unrelated functions. The recursive `walk()` pushes FULL paths; the
basename key is `found.add(owner)` where `owner` comes from a **single-level** scan of `apps/`, whose
entries are siblings in one directory and therefore unique by construction. My detector matched two
true facts in one file and inferred a relationship between them that does not exist — the same
mistake shape as the dominant lesson, caught the same way.

So the V-2025 fix was not one of many: it was the only occurrence, and the class is now empty.
Recorded so the next sweep of this shape can stop at this line.

## V-2033 — a security allowlist keyed by FILE, exempting a USE (2026-08-27)

Gate-31 first: **3244 test files, 32244 passed, 16 skipped, exit 0** — verify-suite's own verdict, so
last turn's ratchet bumps (3068/3244) are confirmed by a full run rather than by arithmetic.

### Generalising V-2029: the "optional dep bypasses a validated default" class

V-2029 found one instance; `services/agent-session-orphan-sweeper.ts:77` is a second
(`deps.maxLifetimeHours ?? resolveMaxLifetimeHours()`). Swept the class. Boundary: 342 tracked `.ts`
under `apps/server/src`, comment lines excluded, matching `<deps|opts|options|config|args>.X ??
someFn()`.

⛔ **The first run found 4 sites; the shape actually has 8.** My callee pattern was `(\w+)\(\)`, so
every `?? Date.now()` was invisible — a dot in the callee, nothing more. **Half the population was
hidden by the spelling I happened to write**, which is the third time today the sweep-the-shape rule
has cost me a re-run. Widened to allow a dotted callee:

    randomJti()                      lib/livekit-token.ts:117
    randomNonce()                    lib/oauth-client-state.ts:72
    resolveMaxLifetimeHours()        services/agent-session-orphan-sweeper.ts:77
    resolveDisconnectGraceSeconds()  services/worker-disconnect-reaper.ts:80
    Date.now()  x3                   lib/livekit-token.ts:105, lib/oauth-client-state.ts:73,157
    this.nowFn()                     services/crypto-orders.ts:1216

**All 8 clean**, each checked by reading its caller population rather than by pattern: no production
caller supplies `jti`, `graceSeconds`, `maxLifetimeHours` or `issued_at`; the two production callers
that DO pass `nowMs` pass a server clock read, and `agent-sessions-livekit-token.ts:233` deliberately
captures `const tokenNowMs = nowMs()` once so the token's `exp` and the response's `expiresAt` cannot
disagree. `crypto-orders.ts:1216` returns an object carrying BOTH `issued_at` and `created_at`, so
the seam is receipt-generation time, not the order's stored timestamp.

`resolveMaxLifetimeHours` also audits clean on its own claim ("can never be silently disabled"):
`Number('')` and `Number(' ')` are 0 → caught by `<= 0`; `'abc'` → NaN and `'Infinity'` → caught by
`!Number.isFinite`; the `120000`-for-`12` typo → caught by the 30-day upper bound. Bootstrap
constructs the sweeper with `repo` alone, so the resolver governs.

### The finding

`randomJti()` in `lib/livekit-token.ts` feature-detects `crypto.getRandomValues` and falls back to
**`Math.random()`** — while its sibling `randomNonce()` in `lib/oauth-client-state.ts` is a plain
`randomBytes(16)`. The file imports `createHmac` from `node:crypto`, so it is server-only, and
`package.json` declares `"node": ">=22.12.0"`, where the webcrypto global has existed since Node 19.

⛔ **That is already vetted, and with better reasoning than I had.**
`no-insecure-randomness-for-secrets.test.ts` names the file in its header — "dead code in Node 22 …
the `jti` is a replay/uniqueness marker, NOT a secret — the LiveKit token's security is its
HMAC-SHA256 signature, so a predictable jti can't forge a token." **Seventh suspected gap refuted
this session.**

⭐ **But its exemption is keyed by FILE, and what it vetted is a USE.** The check is
`if (MATH_RANDOM.test(code(f))) { if (!ALLOWLIST.has(rel(f))) offenders.push(...) }` — pure presence.
An allowlisted file may carry any number of `Math.random` uses. The existing rot arm asserts each
allowlisted file _still contains_ `Math.random`, so it catches an exemption that shrinks to zero and
not one that **grows** — and the guard's own header reasons about exactly one use per file.

Added a use-count arm. Counts read from the guard's own `code()` via a probe rather than
re-implemented (`webhook-worker` 2, `livekit-token` 1, `playwright` 1, `sdk-typescript/retry` 1), and
an allowlist entry with no vetted count fails loudly, so the two lists cannot drift apart.

| mutation                                                                      | result                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------- |
| ⭐ **real subject**: a second `Math.random` planted in `lib/livekit-token.ts` | reds — `vetted 1, found 2`                   |
| a new ALLOWLIST entry with no count                                           | reds — `allowlisted but no vetted use-count` |

Both restored byte-identical; `it(` 3 → 4; `tsc -p apps/server/tsconfig.test.json` clean. This is the
fifth finding of one shape this session — **the guard existed and its KEY was coarser than the
property it protected** — and the first where the coarse key guards a security exemption.

## V-2034 — the same coarse key in the at-rest binding guard, and a proxy metric I nearly reported (2026-08-27)

Turned V-2033 into a sweep. Boundary: 2023 unit test files; exemption-style lists
(`ALLOW|EXEMPT|WAIV|SKIP|IGNORE|KNOWN|RECORDED|DORMANT`) whose entries are FILE PATHS —
**14 lists across 9 files**.

⛔ The first detector found **5**. Its name pattern was `[A-Z][A-Z0-9_]*(?:ALLOWLIST|…)`, which
requires at least one character BEFORE the keyword, so a list called plainly `ALLOWLIST` — the one I
had just fixed in V-2033 — did not match. **The detector failed its own known positive and I only
noticed because I ran it against that file deliberately.** Fixed, re-validated, re-ran: 14, not 5.
Second time this turn a spelling hid most of a population.

### ⛔ Then I measured the wrong property

I swept for which lists have a length pin, and got a headline: 12 of 14 "CAN GROW". **That metric
does not track the defect.** Adding an entry to an exemption list is an explicit edit to a test file
— a reviewer sees it in the diff. What V-2033 found was the opposite: the exemption widened with **no
edit to the list at all**, because a new `Math.random` in an already-listed file inherited the
waiver. A count pin guards the visible direction and leaves the invisible one open.

I was one step from reporting a 12-row list of files that are not defective. The tell was asking what
a failure of the pinned property would actually look like — a diff someone already has to approve.

### The right question, and what it found

**Is the exemption's KEY as fine-grained as the thing the reason reviewed?** Re-checked the
highest-consequence lists by reading:

- `route-auth-coverage-invariant.test.ts` — entries are `(file, registrar, exact method+path,
posture, reason)`; a new unauthenticated route in an exempted file is NOT covered. Correctly keyed.
- `route-mutation-ratelimit-coverage-invariant.test.ts` — entries are `{file, method, path, reason}`
  matched by `routeMatches`. Correctly keyed.

⭐ **Both are route guards, and that is the pattern: the coarse key appears where the exempted thing
has no natural identifier.** A route has `(method, path)`. A `Math.random()` call has nothing, so
V-2033's author keyed by file. That predicts where to look next — guards over CALL SITES.

**`an-at-rest-secret-is-bound-to-what-it-belongs-to.test.ts` is one, and it has the same shape.** Its
`ALLOWED` entries are `{file, fn, reason}` and the forward arm filters
`!ALLOWED.some((a) => a.file === s.rel && a.fn === s.fn)` — so **every** context-free site sharing a
`(file, fn)` pair is excused, while each reason describes one specific call ("this writer has zero
production callers", "the v1 READ path"). Its staleness arm checks an exemption still matches at
least one site: the shrink direction again.

Probed the guard's own `contextFree` scan: three exemptions, each covering exactly 1 site today.
Added a site-count arm keyed the same way, with an exemption lacking a count failing loudly so the
lists cannot drift apart.

| mutation                                                                                 | result                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| ⭐ **real subject**: a second 2-arg `encryptPlatformSecret` in the already-exempted file | reds — `reviewed 1 context-free site(s), found 2` |
| an exemption with no reviewed count                                                      | reds — `exempted but no reviewed site-count`      |

Both restored byte-identical; `it(` 5 → 6; `tsc -p apps/server/tsconfig.test.json` clean. What the
new arm protects is the file's own stated property: an unbound at-rest secret "decrypts under any
record, for any account".

⚠️ Nine suspected gaps refuted this session against six findings — and every finding was a guard
whose key was coarser than its property, never a missing guard.

## V-2035 — the account-deletion purge path, audited end to end (2026-08-27)

Switched from sweeps to an end-to-end audit of the GDPR Art. 17 erasure path — the destructive one,
where a wrong predicate deletes live customer data and a missing arm retains it past the promise.

**Six erasure arms, all wired.** `AccountDeletionPurgeSweeperService` takes one required repo (BYOK
key) and five optional ones (proxy secrets, profiles+snapshots, turn receipts, agent sessions,
recipes). Bootstrap passes all six. Three are deliberately KEY-FREE, with the reason written at the
wiring site: binding an arm to `MFA_ENCRYPTION_KEY` "would make an unrelated flag switch off a fourth
retention promise — the exact defect 2eeddefa7 fixed for the other three".

**Every erasure query scopes to a terminated account.** Boundary: the 7 purge/candidate functions
under `apps/server/src/db`, bodies sliced from declaration to next top-level member — all 7 carry
`status = 'deleted'` AND `deleted_at IS NOT NULL` AND `deleted_at < cutoff`. Notable for any future
guard over this family: **six express it in Drizzle (`eq(accounts.status, 'deleted')`) and
`purgeRecipesForTerminatedAccountsBefore` expresses it in RAW SQL** (`WHERE a.status = 'deleted'`), so
a detector shaped for one mechanism is blind to the other.

⛔ **Two instrument faults inside that measurement, both caught by reading.** My function list was
HAND-WRITTEN, so it missed `purgeRecipesForTerminatedAccountsBefore` entirely — the name did not
match any I had guessed. And it flagged `agent-turn-receipts-repo.ts:177` as missing the filter; that
is a 3-line wrapper delegating to the filtered free function 16 lines below it. Derive the set, never
list it, and read every accusation.

### The hypothesis I nearly shipped, and what refuted it

The BYOK arm is wired `...(byokAnthropicService ? { byok: … } : {})`, i.e. gated on
`MFA_ENCRYPTION_KEY`. I verified `clearKey()` decrypts nothing — it is `repo.clear({accountId, now})`,
a NULL write — and concluded the FIRST arm still carried the coupling its three siblings had been
freed from, by the very commit their comments cite. I was drafting the rewiring.

⭐ **`git show 2eeddefa7` settled it against me.** Its message addresses this arm by name: "That was
correct when the BYOK Anthropic key was the only thing it purged: **no key storage configured meant
nothing to do.** … The BYOK dependency is now optional and **its arm no-ops when unwired** … An
unwired BYOK arm does not even run its candidate query." The case was considered and decided.

**The lesson is new and general: when a comment cites a sha, read that commit's MESSAGE before
forming the hypothesis.** The sibling comments were accurate about themselves and silent about the
arm I was looking at — a comment explains its own line, only the commit explains the set. A decision
to EXCLUDE something is stated in prose and appears nowhere in the diff.

Also already guarded: `account-deletion-purge-arm-independence.test.ts` pins independence in every
direction, including "with the BYOK service UNWIRED, the proxy and profile arms still run" and "an
unwired BYOK service does not even QUERY for candidates" — plus per-arm failure isolation and a
retention-window sanity arm. **Twelfth suspected gap refuted this session.**

⚠️ Residual worth stating rather than dropping: a deployment that once had `MFA_ENCRYPTION_KEY` and
later unset it retains unreadable BYOK ciphertext, since the arm no-ops. Narrow, and the sweeper
emits `count('byok', 'skipped')` once per tick precisely so an unwired arm is visible rather than
indistinguishable from an empty one — good design, though a counter is only a control if someone
reads it.

### Gate-32 red — attributed, not mine

`verify-suite: NOT TRUSTWORTHY`, GATE EXIT 1, while **all 3244 files and 32246 tests passed**. The
sole cause: `EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was
pending`, originating in `apps/gui-client/tests/unit/simulator-window-control-actions.test.tsx` —
A2's territory, so flagged to them and not investigated here. Gate-31 at the same HEAD minus my two
commits had ZERO occurrences; gate-32 ran 497s against gate-31's ~250s because our suites overlapped
at load 40+. Load-sensitive teardown race, consistent with the known gui jsdom flake.

⭐ Worth recording about the harness rather than the flake: **vitest exits 0 on an unhandled
rejection** and warns it "might cause false positive tests". A plain `vitest run` reads green here.
Only verify-suite's own verdict line caught it — which is exactly why the gate echoes that verdict
instead of trusting an exit code.

## V-2036 — my own quiescence check counts postgres backends as vitest (2026-08-27)

**Gate-33: 3244 files, 32246 passed, 16 skipped, 0 teardown errors, 285.11s, `verify-suite: OK`.**
Against gate-32's 497.81s and one error, on the same HEAD plus three doc/test commits. The flake is
now **1 of 30 retained full-suite runs**, and the one occurrence is the second-slowest in the set.

### A2 refuted the causal half of my attribution, correctly

I told A2 the trigger was likely the heavy console output in the named file — the "view exploded" /
ToastProvider error-boundary fixtures. **Wrong on both counts.** Those fixtures live in
`ErrorBoundary.test.tsx`, which already suppresses them with four `spyOn(console)` calls, and
`simulator-window-control-actions.test.tsx` has no console calls at all. ⭐ **A teardown RPC race
names a LOCATION, not a cause** — the file vitest reports is where the shared worker happened to be
when the rpc closed. The claim never reached the verification log (it was in the message only), but
the log did frame the named file as "originating", which reads as attribution; it is not.

A2's own account is the better one: gate-32 is the single run where their marketing suite overlapped
my gate, which is a violation of the one-at-a-time protocol rather than a defect in any file.

### The finding: the check the standing order prescribes over-matches

Building a mid-run contention sampler, I ran it as a control against my OWN live gate — every worker
on the machine descends from my run, so the correct answer is zero foreign runners. It reported
**six**:

    FOREIGN 73859: postgres: driftstack driftstack_a3_vitest ::1(57633) idle in transaction
    FOREIGN 73861: postgres: driftstack driftstack_a3_vitest ::1(57634) SELECT waiting
    …

⛔ **They are postgres backends.** The test database is named `driftstack_a3_vitest`, so the token
`vitest` is inside the DATABASE NAME, and `ps -Ao pid,command | grep "[v]itest"` — the exact check the
standing order specifies, and the one I have run every turn — matches every backend connected to it.
Measured live: at one moment 6 of the matches were postgres, at another 0 of 11 were. It is
intermittent, tracking whether a suite currently holds connections.

⭐ Consequence is mild and in the safe direction — the check over-reports "busy", so the gate waits
or aborts rather than running contended — but every "vitest procs: N" figure I have quoted this
session is an upper bound, not a count. **The fix is one token: `| grep -v 'postgres:'`, or require
the module path `node_modules/vitest`.** Sweep the shape, not the token: `vitest` identifies a
runner only when it is a path component, never as a bare substring.

### The harness gap it came from

The pre-flight is **point-in-time**. It proves the machine was quiet at the instant the suite started
and says nothing about the 300–500s that follow, so a peer starting mid-run is invisible and the
resulting red looks like a defect in whichever file the dying worker was running. `gate2.sh` now runs
the suite in the background and samples throughout for a vitest process whose ancestor chain does not
reach the suite's own PID, printing the verdict next to the exit line. Written as a NEW file rather
than an edit, because `gate.sh` was being executed by a live background job at the time and bash
reads a script incrementally.

⭐ The sampler is only trustworthy because the control ran first: a detector that reported six
foreign runners on an uncontended run would have labelled every future gate as contended, and the
label would have been believed exactly when a real red needed explaining.

## V-2037 — the same detector bug in a second costume: my own argv (2026-08-27)

V-2036 fixed a detector that counted postgres backends as vitest runners, because the test database
is named `driftstack_a3_vitest`. A2 proposed a second instance and explicitly framed it as a
hypothesis to test rather than a finding: **the Bash tool passes the entire script as one argv, so
the shell running a detector carries every literal in that detector's own source** — and the
`[v]itest` bracket trick protects only the pattern token, not the rest of the script.

**Tested, confirmed:**

    my own `/bin/zsh -c …` command line, untruncated:  927 chars
    occurrences of `node_modules/vitest` inside it:     1

⛔ **My first check returned ZERO and I nearly reported the hypothesis disproved.** The difference is
`ps` truncating command lines at some widths and not others, so the self-match is an INTERMITTENT
false positive. That is worse than a constant one: absent every time I probed it deliberately,
present on some future real run — and it would have fired precisely when a red needed explaining.

⭐ **The fix is one rule instead of one exclusion per collision: key on the EXECUTABLE, not the
text.** A real runner is exec'd as `node`/`npm`/`npx`; a shell that merely mentions vitest is exec'd
as `zsh`, and a postgres backend as `postgres`. Both false-positive classes fall to the same rule.
The ancestry check stays for the suite's own workers. Token filters need a new exclusion every time a
name collides; exec-identity and ancestry need none.

**Proven in both directions, because a clean negative proves nothing.** The positive took two
attempts, and the first failure was mine:

| test                                                       | result                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| own shell, argv contains the token, no suite running       | not flagged ✓                                                                                 |
| postgres backends on `driftstack_a3_vitest`                | not flagged ✓                                                                                 |
| synthetic runner launched as a CHILD of the root passed in | 0 foreign — **my test was malformed**, it descended from the root, so "not foreign" was right |
| synthetic runner, root = an unrelated leaf process         | `FOREIGN 79360: node -e … node_modules/vitest/dist/workers/forks.js` ✓                        |
| same, after it exits                                       | none ✓                                                                                        |

The synthetic was a real `node` process carrying the runner path rather than a real suite, so the
proof cost no machine time while a peer held it.

⭐⭐ Both bugs are the same bug: **a token identifies a thing only where it is structural — a path
component, an exec name — never as a bare substring of a line that other software is free to
compose.** A database name and a shell's own argv are both "other software composing the line". The
only reason either was found is that a control ran first, on a case where the answer was known.

## V-2038 — two more never-audited lib files, both clean (2026-08-27)

Continuing the V-2028 list.

**`lib/canonical-one-time-token-url.ts` (633 B) — clean.** It exists so a one-time token never rides
through Cloudflare's slashless→slash redirect, which would preserve the query string. The security
question is whether `baseUrl` can be customer-influenced: a token appended to an attacker-supplied
origin is mailed to the attacker. Traced all six call sites — `config.authFlowUrls.verifyEmail`
(×2), `.magicLink`, `.passwordReset`, `` `${dashboardBaseUrl}/team/accept` ``, and
`` `${config.dashboardOrigin}/auth/oauth-client/confirm-merge` `` — **every one operator config, none
request-derived**, and `dashboardOrigin` is `z.string().url()` with a trailing-slash transform at
config parse. Root-path edge holds too: `'/'` → strip → `''` → `'/'`.

**`lib/bounded-memory-rate-limit-store.ts` — clean, and the interesting part is a path that would be
a bypass if it existed.** The store deletes a bucket BEFORE deciding (delete-then-set is how it moves
the key to the newest slot so FIFO eviction targets the least-recently-touched one). That makes any
early return a rate-limit bypass: a denied request would erase its own bucket and the next one would
start with a full bucket, so a caller could never be limited. Read both exits — the allowed path sets
`{tokens: remaining}` and the denied path sets `{tokens: refilled}` ("persist refilled tokens but
don't consume"). **No path leaves the bucket deleted.** The bound itself holds: at `maxBuckets` a new
key evicts the oldest before inserting, `maxBuckets < 1` throws, and the refill divides by
`Math.max(refillPerSecond, 0.0001)`.

⭐ Its two wirings differ, and the difference is justified rather than drift:
`middleware/ip-rate-limit.ts:37` is MODULE-level because that file builds many gate instances from a
factory and the comment says so ("across the many factory-built gate instances during an outage");
`middleware/rate-limit.ts:99` is per-plugin-instance because a Fastify plugin registers once, and its
comment says that. A store constructed per REQUEST would silently defeat the fallback — neither is.

Both files were on the never-mentioned list from V-2028, which has now yielded four clean audits
(boot key verification, the two nonce caches, the MFA challenge store, these two) against two
findings (V-2027's parser coupling, V-2030's per-replica sweep). **Recording the clean ones is the
point: a file that has been read to the bottom and found sound should not be re-swept.**

## V-2039 — a sensitivity heuristic blind to every CSS combinator (2026-08-27)

`services/agent-sensitive-input.ts` (1.1 KB, never audited) decides whether a `type` intent's
selector implies a secret field. Its own header states the asymmetry: a false positive "merely
disable[s] typo correction and suppress[es] input logging", while a false negative "can expose a
password/OTP/card value to ordinary input telemetry".

**The token boundary was a hand-listed delimiter class, `[#.[\]_\-\s"'=:]`, and CSS combinators are
not in it.** Measured against the live regex:

    #password>input    -> false        #password~span   -> false
    #password,#email   -> false        :is(#password)   -> false
    #password+label    -> false        #otp,#submit     -> false

The token is present; the character after it merely was not on the list.

**Consequence, traced to three call sites.** `agent-public-redaction.ts:19` is the sharp one —
`publicAgentIntent` deletes `value` only when the intent is sensitive, so a false negative leaves the
typed password or one-time code in the public copy of the intent. The other two
(`agent-intent-to-dispatch.ts:147`, `agent-decomposer-claude.ts:740`) each read
`intent.sensitive === true || selectorImpliesSensitiveInput(...)`, so this is the defence that
matters precisely when the caller did not set the explicit flag — which is the case it exists for.

⭐ **The existing tests could not have caught it.** All 16 positive fixtures put the token at the end
of the string or before a character that happened to be on the list (`#password`, `#login_passwd`,
`.totp-input`). **Not one placed a combinator after the token**, so every fixture passed identically
with the bug present — the same shape as the malformed-id fixtures in V-2005/V-2007, where the
refusal input never reached the branch being tested.

**Fix: the boundary is now any non-alphanumeric.** Not `\b`, because `_` and `-` must remain
boundaries for `#login_passwd` and `.totp-input`; and alphanumeric on either side still blocks a
substring hit. Validated against every existing fixture before editing: 16/16 positives still true,
7/7 negatives still false, the 6 failures now true, and `#spin` / `#pinboard` / `#tokenizer` /
`#weaponstore` still false.

⚠️ The other two regexes (`SENSITIVE_AUTOCOMPLETE_RE`, `PASSWORD_TYPE_RE`) were checked for the same
flaw and do NOT have it: they match inside an attribute selector, which always closes with `]`, and
`]` is on their list. `[type=password],#x` is fine. Scoped the fix to the one regex that needed it.

**Mutation-proved on the real subject:** restoring the old delimiter list reds exactly the 6 new
fixtures and none of the 16 pre-existing ones. Restored byte-identical; 33 tests in the file;
`agent-public-redaction` consumers green; `tsc -p apps/server/tsconfig.test.json` clean. No parity
pin quotes the regex source — checked with both the import-path and the symbol-name patterns.

## V-2040 — cross-node session ownership: enforced everywhere, and one expired justification (2026-08-27)

`services/fleet-session-ownership.ts` (1.2 KB, never audited) is the shared predicate that stops a
compromised fleet NODE injecting events into another customer's session — inbound frames resolve
their target purely from the attacker-controllable `frame.sessionId`.

    isCrossNodeSpoof(sessionNodeId, reportingNodeId) =
      reportingNodeId !== undefined && sessionNodeId !== reportingNodeId

⭐ **The `undefined` arm is a fail-open**: no reporting node means the frame is allowed. The JSDoc
says it is "retained only for legacy callers that do not enter through FleetControlRegistry".

**All three frame types the header names are protected, though not all by this predicate.**
`challenge-relay.ts:65` and `profile-save-failed-relay.ts:70` call it; `agent-session-terminal-close.ts:110`
calls it; and **pageState does not** — `session-page-state-relay.ts` enforces the same rule INLINE
with a REQUIRED parameter (`(frame, reportingNodeId: string)`, dropping when
`session === null || session.nodeId !== reportingNodeId`). That inline form is equivalent, and
strictly stronger on the null case, since a required parameter cannot reach the fail-open at all.
Two further paths enforce ownership below the service layer — `agent-sessions.ts:720` inline, and
`agent-sessions-repo.ts:717` in the WHERE clause (`eq(agentSessions.nodeId, reportingNodeId)`).

**The fail-open is unreachable from production.** The only field typed optional is
`AgentSessionTerminalCloseArgs.reportingNodeId?`, and the sole production caller of
`closeAgentSessionOnTerminalStatus` is line 199, inside `makeAgentSessionTerminalStatusRelay`, whose
own signature is `(frame: SessionStatus, reportingNodeId: string)` — required. `bounded-node-latest-relay`
types it required throughout too.

⚠️ **But the justification has expired.** "Retained only for legacy callers that do not enter through
FleetControlRegistry" — measured, there are no such callers in `apps/server/src`. The reason written
for the fail-open no longer describes anything real, which is the same shape as a parity pin
freezing a claim that has stopped being true. Tightening the field to required is the obvious
hardening and I have NOT done it: several test files construct these args, so the change has test
impact and it narrows a security predicate's contract — the owner's call, not a sweep's. Recorded so
the choice is visible rather than inherited.

### Boundary-idiom sweep from V-2039

Swept the generalisation of the combinator bug. Boundary: 342 tracked `.ts` under `apps/server/src`,
comment lines excluded, matching the regex boundary idiom with an explicit character class
(`(?:^|[…])`, `(?=$|[…])`, `(?<=[…])`). Detector validated against the PRE-fix bytes of
`agent-sensitive-input.ts` (2 hits). **Population: 2 sites, both in the file V-2039 already fixed.**
No second instance of a hand-listed token boundary in server source.

## V-2041 — a prose-only invariant, and four files `git grep` cannot read (2026-08-27)

**Gate-34: 3244 files, 32258 passed, 16 skipped, `verify-suite: OK`** — and the first run to carry a
contention verdict:

    --- contention during the run ---
    samples=31 foreign_vitest_pids=0
      none — no vitest outside our own process tree for the whole run

31 samples across the run, so the V-2039 privacy fix is verified against a run that is _labelled_
uncontended rather than assumed to be. Gate-32's ambiguity cannot recur silently.

### `services/byok-anthropic-key-cache.ts` — an invariant written down instead of asserted

The cache holds a customer's decrypted BYOK Anthropic key, keyed by agent-session id, TTL **13h**
hardcoded (`opts.ttlMs ?? 13 * 60 * 60 * 1000`), and `bootstrap.ts:1496` constructs it with no
override. Its comment justifies the number: _"just past the 12h orphan-sweep session cap, so a live
session's key is never evicted mid-run"_.

⛔ **The two values are independent.** V-2035 established the session cap is
`DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS` — operator-settable, sanity-bounded at 30 DAYS. The
cache never references `resolveMaxLifetimeHours`; nothing enforces `ttl > cap`. Raise the cap above
13h and the stated property silently stops holding for any session that outlives the TTL. Exactly the
shape of "a nil consequence holds only while an invariant does" — the fix is to derive the TTL from
the same source rather than restate its value in prose.

⭐ **I over-read the consequence first and reading refuted it.** I expected the expired cache to
substitute the platform's key for the customer's — a billing/attribution defect. It does not: the
fallback leg at `agent-sessions.ts:4691` requires `headerByokKey === undefined && cachedByokKey ===
undefined && bundledLlmService !== undefined && deploymentFallbackKey !== undefined`, and then gates
on `settings.consent` with its own concurrency cap and `bundledLlmRequestTotal` counters. It is the
consented, metered bundled-LLM product, not an accidental switch. A non-consenting customer gets an
error. **The real consequence is a functional degradation on a raised cap, not a silent substitution
— narrower than my first draft, and recorded at the narrower size.**

### Four source files that `git grep` will not read

`git grep` reported `services/exit-identity-cache.ts` as _binary_. It carries one raw **NUL byte** at
offset 1992 — ``return `${accountId}\x00${proxyId}`;`` — a composite-key separator written as a
literal byte rather than an escape. Swept the repo: **4 of 4625 tracked text-type files contain a raw
NUL**, all deliberate separators or, in one case, a fixture whose point is to feed a NUL:

    apps/gui-client/src/lib/SettingsContext.tsx:239        (A2's — flagged to them)
    apps/server/src/services/exit-identity-cache.ts:41
    apps/server/tests/unit/idempotency-key-shared-parser.test.ts:130
    packages/recapture-automation/src/matrix.ts:83

⭐ **The repo is fine; MY tooling was not.** The repo's own guards walk the filesystem
(`readFileSync`/`readdirSync` in 1683 unit tests) and read NULs without trouble — no guard shells out
to `git grep`. But every `git grep` census I ran this session had a 4-file blind spot, including one
unit test. `git grep -a` reads them correctly, and that is the fix — not churning four source files
for a tooling nicety.

⚠️ **One published audit used the affected method.** `docs/internal/v524-public-leak-audit` records
that personal-name leaks were "confirmed with `git grep -E \"…\"`" — the same blind spot, on a
privacy audit. Re-ran that pattern over the four files with a NUL-safe reader: **0 matches in all
four.** The blind spot hid nothing and the audit's conclusion stands — but it was luck, not method,
and it is now checked rather than assumed.

## V-2042 — a new outbound caller could read an unbounded body and nothing would notice (2026-08-27)

Started from `lib/nowpayments-api.ts` (9.3 KB, largest never-audited lib file). **It audits clean**:
bounded body via the shared reader, a 10s AbortController, a response validator that rejects a
missing or empty `payment_id`/`pay_address` (its comment explains that without it
`String(res.payment_id)` persists the literal `"undefined"` as an order's payment id), and every
error message carries only method, path, status and the limit constant — the header's claim that
"upstream response text is never copied into the Error" holds across all five throw sites.

`lib/bounded-response-body.ts` audits clean too, and the interesting part is the ORDER: it checks
`content-length` and cancels, then enforces the cap DURING streaming on `value.byteLength`, throwing
before appending. A lying `content-length` cannot evade it, and the limit is wire bytes rather than
UTF-16 length, exactly as its docstring claims.

### The measurement, and two false positives inside it

Boundary: 342 tracked `.ts` under `apps/server/src`, comment lines dropped — **9 files issue an
outbound request**. My first sweep flagged two as unbounded. Both were wrong, and both for the same
reason: **I keyed on the shared helper's NAME rather than on the property.**

- `services/webhook-worker.ts` has its own `readExcerpt` — 64 KiB streaming cap, reader cancelled in
  `finally`, and `slice` rather than `subarray` with a comment explaining that a view retains the
  entire backing buffer when a decompressed chunk exceeds the cap. It cites the undici decompression
  advisory. It is _stronger_ than the shared helper, and my detector called it unbounded.
- `services/agent-decomposer-claude.ts` likewise caps at `MAX_ANTHROPIC_RESPONSE_BYTES` 64 KiB.

⭐ Reading also found a NINTH caller my first sweep missed entirely (`durable-webhook-delivery.ts`),
and that `lib/oauth-client-exchange.ts` defines its **own local copy** of `readBoundedResponseBody`
rather than importing the shared one. Diffed the two: structurally identical — same content-length
precheck, same streaming byte counter, same throw-before-append — differing only in parameter name, a
hardcoded constant versus a parameter, and the error type. Equivalent today, coupled by nothing.

**All 9 are bounded**, by three legitimate mechanisms: the shared reader (2), an equivalent local or
own streaming cap (4), and cancelling the body outright while reading only `status`/`ok` (3 —
verified by reading each, they call `res.body?.cancel()` and never touch content).

### The gap: the property was not guarded forward

Planting a NEW file under `apps/server/src` whose whole body is
`const res = await fetch(url); return await res.text();` **passed the entire unit suite — 2020 files,
20984 tests, zero failures.** Removing the bound from an EXISTING caller IS caught, but incidentally:
the now-unused import trips `the-server-source-type-checks`. Nothing asserted the property, and
nothing at all noticed a new caller.

New `an-outbound-response-body-is-bounded.test.ts` walks for callers rather than listing them and
rosters each with the mechanism that bounds it — prose, not `true`, so an entry added without a
reason is as visible as one missing.

| arm                                                              | mutation                                  | result            |
| ---------------------------------------------------------------- | ----------------------------------------- | ----------------- |
| census non-vacuity                                               | —                                         | floor on the walk |
| ⭐ **the forward case**: a new unbounded caller planted in `src` | reds — `[ 'lib/zz-probe-outbound.ts' ]`   |
| a real caller dropped from the roster                            | reds — `[ 'services/webhook-worker.ts' ]` |
| rot: roster a file that issues no outbound request               | reds — `[ 'services/rate-limit.ts' ]`     |

Ratchets 3068→3069 / 3244→3245; `tsc -p apps/server/tsconfig.test.json` clean.

## V-2043 — retracting a stale claim of my own, and the advisory-lock family (2026-08-27)

**Gate-35: 3245 files, 32261 passed, 16 skipped, `verify-suite: OK`, 30 contention samples, zero
foreign runners.** V-2042's guard and ratchet bump verified.

### ⛔ Retraction — V-2030's third class member is not open

V-2030 listed the scheduled-jobs deduplicated-enqueue race as a live latent multi-replica defect and
counted it as one of the class's known members, on the authority of a May internal handoff note that
described the path as an unserialised check-then-insert with no unique-index backstop. **That
description no longer matches the code.** `DrizzleScheduledJobsRepo.enqueue` now runs the whole
`dedupOnAccountAndType` branch inside `db.transaction`, taking
`pg_advisory_xact_lock(hashtextextended(JSON.stringify([accountId, jobType]), 0))` BEFORE the
existence check and holding it through the insert. A Postgres advisory lock is database-scoped, so it
serialises across replicas — which is precisely what the note said was missing. The source comment
names the same scenario the note did, and
`db-scheduled-jobs-repo-content-parity.test.ts:55` pins it with an arm titled "enqueue dedup is
cross-replica atomic".

So the defect was fixed after the note was written, by a route the note did not anticipate — the note
proposed a partial unique index and rejected it as an unapplicable migration; someone solved it with
a lock and no migration at all. **My entry inherited the note's staleness without re-checking the
code, which is the whole failure mode of citing a document as evidence of a present state.** The
class in V-2030 therefore has one confirmed live member (the pair-mode heartbeat tracker), not two.

### The advisory-lock family — audited, and the rule is coherent

Boundary: 342 tracked `.ts` under `apps/server/src`, every line calling `pg_advisory_*` — **12
sites**. Ten build the key inline from a namespace literal, two call the shared
`profileSessionAdvisoryLockKey`. That looked like neglect until the namespaces were counted:

    profile-session:          2 files  -> shared constructor
    mfa-credentials:          4 sites, ALL in db/mfa-repo.ts
    account-proxy-create: / agent-session-create: / session-create: /
    platform-secret-upsert: / webhook-endpoint-create:   1 site each

⭐ **The one namespace used across two FILES is the one with a constructor**, and
`db/profile-session-lock.ts` exists because those two drifted apart once. Every inline namespace is
confined to a single file, where a reader sees all of its uses together. The rule is consistent, not
absent. Verified the constructor's own claim with both patterns: both session-create surfaces call it
(`agent-sessions-repo.ts:357`, `sessions-repo.ts:105`) and the literal `profile-session:` appears
nowhere but inside the constructor. The twelfth site keys on a JSON tuple rather than a prefix.

**`services/oauth-retention-sweeper.ts` + `OAuthStore.pruneExpired` — clean**, and a positive example
of what V-2041 found missing elsewhere: `AUTHORIZATION_CODE_TTL_MS` is ONE constant with THREE
consumers — the read path, the exchange check, and the prune cutoff — so the sweep deletes exactly
what the auth path already rejects, and they cannot disagree. All three deletes run in one
transaction, and the header's claim that the backing `api_keys` actor rows survive for
session/audit foreign-key integrity is carried out and commented at the delete site.

### Correction to V-2041: a NUL hides from READING too, not only from `git grep`

I recorded that a raw NUL makes a file invisible to `git grep`. A2 measured the worse half: **the
byte renders as nothing in ordinary terminal output**, so `sed -n '41p'` on the affected line shows
what looks like a plain separator, and they had already read that exact line without seeing it. So
"read the file instead of grepping it" is not the workaround.

Re-measured the reveals myself rather than repeating the list:

    cat -v            shows `^@`         ✓  (BSD cat lacks -A, but -v is there)
    perl -ne '/\0/'   reports the line   ✓
    python bytes      b'\x00' in data    ✓
    grep -rlI         classifies binary  ✓  (its complement finds them)
    grep -a <NUL pat> matched ALL 77 lines — the pattern behaves as empty, so it is useless here

⚠️ That last row corrects advice I gave: `grep -a` makes an already-known file's content readable,
but it cannot be used to FIND NUL-carrying files.

⭐⭐ The generalisable lesson is A2's, from their own case: their grep for the cache's writer returned
zero, and their control — does the class even define a setter — also returned zero. **Two zeros
agreeing read as corroboration when they were one instrument failing twice.** A control that runs
through the same mechanism is a second sample, not a check. Proving a detector on a known positive
only works if the proof does not share the detector's blind spot.

## V-2044 — the pair-mode takeover lock, audited against the repo's own lease defect (2026-08-27)

`services/agent-pair-mode-lock.ts` was never audited, and V-2030 established it is the DISTRIBUTED
half of pair mode (Redis) while the heartbeat tracker beside it is per-process. Audited it against
the checklist from this repo's known lease defect — claim sets an owner, settle writes `WHERE id`
with no reference to the lease — rather than against a generic Redis-lock list.

**It does not have that defect.** Acquire is `SET pair_lock:<sessionId> <clientId> NX EX 30`; release
is the canonical Lua compare-and-delete, `if redis.call("get", KEYS[1]) == ARGV[1] then del else 0`.
The release IS fenced on the owner — precisely the fencing the `scheduled_jobs` settle lacks.

⭐ **The security-relevant part is an ORDERING, and it is right at both call sites.** `clientId` is
`parsed.data.client_id` — it comes from the REQUEST BODY, and the Lua CAS matches on the stored
VALUE. So if the `try/finally` that releases the lock also wrapped the acquire, a contending client
could send the holder's `client_id`, fail to acquire, and have its own `finally` delete the holder's
lock. Measured at both usages in `routes/agent-sessions.ts`:

    3894  tryAcquire(...)
    3898  if (!lockResult.acquired) throw new PairModeConflictError(...)   <- OUTSIDE the try
    3901  try { ...transition... } finally { release(...) }

    4210 / 4214 / 4217 — identical ordering

A failed acquire throws before the `try` is entered, so `release` is unreachable without a successful
acquire and the customer-supplied identity cannot be turned into a lock-steal. Both copies agree;
this is the kind of sequence where one divergent copy would be the whole defect.

⚠️ One residual, and it is smaller here than the prior art implies. The CAS script returns 1 on
delete and 0 when the value did not match — meaning the caller's lock had already expired or been
taken — and `release` discards it (`Promise<void>`, documented as a no-op when not held). My lease
memory argues that discarded result is the only in-band evidence of a duplicate execution. **That
argument does not transfer at full strength**: in the queue case an unfenced settle OVERWRITES the
new owner's row, so the lost signal accompanies real corruption. Here the fenced release simply does
nothing, so the cost is observability alone — nobody learns that a 30s TTL expired under a live
holder. Worth knowing, not worth a change.

Also clean, from the same pass: `db/profile-session-lock.ts` — its claim that both customer
session-create surfaces serialise on one key holds, verified with both the symbol and the literal
patterns (`agent-sessions-repo.ts:357`, `sessions-repo.ts:105`, and the literal appears nowhere else).

## V-2045 — a guard that predicted my sweep's two false positives, in writing (2026-08-27)

Audited the request-correlator family: nine files under `apps/server/src/services` that hold
`pending` entries keyed by a request id and settle them from frames arriving on a SHARED fleet
connection — one socket carries every session on a node, so a frame echoing a known request id but
belonging to a different session must be dropped rather than used to settle. Settling it hands one
account's page output — DOM, screenshot, extracted text, cookie jar — to another account's in-flight
request.

**Boundary: the 9 correlator files; "compares" = a non-comment line comparing an incoming frame's id
against the pending record's. My sweep reported 7 of 9 comparing and accused two.** Both accusations
were wrong:

- `session-readiness-correlator.ts` keys its pending map BY `sessionId`
  (`pending.set(sessionId, …)`, `pending.has(frame.sessionId)`), so the lookup IS the check.
- `harness-dispatch-correlator.ts:181` carries `if (target.sessionId !== header.data.sessionId) return;`
  under a comment naming it the cross-session spoof guard. **My regex listed `pending.` / `entry.` /
  `p.` as the receiver names and this one is `target.`** — a hand-listed set under-counting, for the
  third time this session.

⛔⛔ **And the family guard already exists — `every-correlator-drops-a-key-mismatched-frame.test.ts`
(V-1932) — whose header names BOTH of my false positives before I made them:**

> "The guard is keyed on the CORRELATION KEY, not on `sessionId`. Sweeping for `sessionId` reports two
> false gaps … trim-profile keys on `profileId` … session-readiness is CONNECTION-LOCAL … A
> token-level check would accuse both."

It carries four arms: the on-disk roster must equal the recorded one (so a tenth correlator fails
until reviewed), every non-exempt correlator must drop on ITS OWN key, every exemption must carry a
reason, and — the arm I would not have thought to write — **the matcher itself is proved against a
correlator that does not compare**, so the detector cannot silently stop detecting.

⭐ The lesson is not "the sweep was wrong", it is **where the answer already was**: a file named
`every-correlator-drops-a-key-mismatched-frame.test.ts` would have told me the whole shape, including
the two variations, before I wrote a line of detector. Grep the guard corpus for the FAMILY NAME
before measuring the family.

### ⛔ I contaminated a peer's suite window, and the rule I had was aimed at the wrong action

To test whether the property was guarded, I removed the guard line from
`harness-dispatch-correlator.ts`, ran the unit subset (4 tests across 3 files failed — it IS caught),
and restored byte-identical. A2 started a full `verify-suite --all` at 21:09:45, inside or adjacent
to that window. I disclosed the exact timing and which failures would be mine.

**My standing quiescence rule is phrased as a precondition for LAUNCHING a suite. A mutation is a
WRITE, and a peer's run is ruined by a write exactly as thoroughly as by a second suite** — the
standing order says so in both directions, and I had still filed the rule under the wrong verb.
Check for a running suite before touching the tree, not only before starting one.

### Two more never-audited files, both clean

**`lib/sse-backpressure.ts`** exists because a 4 MB socket ceiling was declared three times with three
content-parity tests each pinning its own copy — "Every copy was covered; nothing said they had to
AGREE" — and it removes the failure mode rather than guarding it. Checked the post-condition rather
than the change: **no `4_000_000` / `4 * 1024 * 1024` ceiling literal survives anywhere under
`apps/server/src`**, and all three consumers import the constants, with the heartbeat lane correctly
taking the tighter 64 KiB bound. ⚠️ My literal sweep did flag `1780314000000` in a migration journal —
a digit-substring match on a timestamp, the characteristic false positive of numeric-literal sweeps.

**`lib/unhandled-rejection-backstop.ts`** makes an ordering claim — installed before any async wiring
so a bootstrap-window rejection is caught. Verified: `index.ts:25` installs, `index.ts:29` is the
first `await`. Its metric sink documents that a second attach would double-count, and there is
exactly one call site (`bootstrap.ts:606`).

## V-2046 — W-10 re-verified and characterised: not 39 dead schemas, 39 shipped models (2026-08-27)

W-10 has sat open as "39 declared component schemas, no operation `$ref`s — the fix changes the
published contract so it needs the owner's call". That is a count, not a decision. Re-measured it
properly so the call can be made on facts.

**Boundary: the checked-in generated spec `packages/sdk-python/openapi.json` (2,068,750 bytes),
produced by `apps/server/src/lib/openapi.ts`.**

    components.schemas declared     83
    referenced DIRECTLY from paths   40
    referenced TRANSITIVELY          44
    unreachable from any operation   39

⭐ The count survives a stronger test than the one that produced it. Direct-reference counting alone
would report **43**; four schemas are reachable only through another schema's body. So 39 is right,
and now right transitively.

### The cause, which changes what the fix is

**82 of the 94 operations with a JSON request body inline their schema; only 12 use `$ref`.**
`POST /v1/sessions` publishes an inline 6-property requestBody and an inline 14-property 201, while
`CreateSessionRequest` and `CreateSessionResponse` sit in `components.schemas` referenced by nothing.

So the document carries the same contract twice. **It cannot drift, and that is worth stating
precisely rather than hoping:** `openapi.ts` registers each component from the SAME Zod object the
route uses (`r.register('CreateSessionRequest', CreateSessionRequestSchema)`), so both renderings are
one schema emitted twice. Verified on four pairs — request and response for
`/v1/sessions`, plus `/v1/webhooks` and `/v1/api-keys` requests — **identical property sets and
identical `required` lists** in every case.

### The consequence is real, measurable, and confined to one SDK

`packages/sdk-python` is GENERATED: `sdk:python:dump-spec` writes the spec into the package and
`scripts/generate.sh` runs `datamodel-codegen` over it into `_generated/models.py`. Measured against
that file: **209 classes generated, and all 39 of the unreachable schemas are among them** (control:
the referenced `Problem` is generated too, so the detector works; 0 unreachable schemas missing).

**So the Python SDK ships 39 named Pydantic models that no endpoint accepts or returns.** The
TypeScript and Go SDKs are hand-written and unaffected.

⛔ **Two measurements died on the way to that, and the control is what killed them.** I first asked
"does each SDK emit these types" by name presence: python 7/39, typescript 36/39, go 30/39. Switching
to actual declarations flipped it: python 39/39, typescript 4/39, go 28/39 — **opposite directions
for two of three languages**, which means at least one instrument was badly wrong. The control
settled it: `Problem` IS referenced by every problem+json response, yet neither TS nor Go declares a
type by that name, and TypeScript's real exports are `AccountSelfProfile`, `WebSessionEntry`,
`ListWebSessionsResponse`. **The hand-written SDKs do not use the spec's component names at all, so
the question was never well-posed for them** — the first pass over-counted on substring noise, the
second under-counted nothing but was only meaningful for the generated SDK.

### What the owner is actually deciding

Not "delete 39 dead schemas". The choice is whether operations should `$ref` the components they
already register — which changes the shape of the published document (inline → `$ref`) and therefore
what `datamodel-codegen` emits for existing Python users — or whether the 39 unreferenced models are
an acceptable cost of keeping named types available. Still not mine to make; it is now costed.

## V-2047 — my own guard was a checkbox; making it price the remedy (2026-08-27)

A2 reframed what the second arm of an exemption guard is FOR, and the reframing indicts a guard I
landed earlier today. Their words, because they are better than mine: a one-arm guard reliably
produces DECLARATIONS, because declaring is one line and fixing is a real change — so the guard
accepts the cheapest possible response to itself. **"A guard that only detects omissions is a
checkbox; a guard that prices the remedies is a design force."**

They demonstrated it rather than asserted it: hitting `bootstrap-unwired-optional-deps-are-declared`
on `RedisExitIdentityStore.opts`, they could have added a declared entry in one line. They wired the
TTL through bootstrap instead, and said plainly they would not have without the arm that makes a
declaration keep having to be true.

### Applying that standard to V-2033, which fails it

My `no-insecure-randomness-for-secrets` use-count arm reds with `vetted 1, found 2` when a new
`Math.random` appears in an allowlisted file. Its two remedies were **bump the number (one
character, permanent)** or fix the use. On a SECURITY exemption, that reliably produces bumps — the
exact checkbox shape, written by me, hours after arguing the opposite elsewhere.

⛔ **My first fix did not fix it, and testing the claim is what showed that.** I attached a `why`
string to each count. A new use could still be absorbed by editing `count: 1` to `count: 2` while the
existing justification sat untouched — I had added a prose floor for entries that already existed and
changed the price of a new use by nothing.

**The working form: the count IS the number of justifications.** `ReadonlyMap<string, readonly
string[]>`, one line per use, and the arm compares `actual` against `vetted.length`. There is no
number to increment; admitting a use means writing the sentence that defends it.

| mutation                                                                      | result                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| ⭐ **real subject**: a second `Math.random` planted in `lib/livekit-token.ts` | reds — `justified, 2 found — every Math.random here needs its own line…` |
| the cheap door: find a number to bump                                         | **0 numeric counts in the map** — nothing to increment                   |
| buy it off with a thin justification (`'ok'`)                                 | reds — `too thin to review`                                              |
| add a real justification for the new use                                      | green — the only remedy that passes                                      |

Both files restored byte-identical; `it(` 4 at HEAD and 4 in the tree; `tsc -p
apps/server/tsconfig.test.json` clean.

⭐ The generalisation I had been missing all session: I have been writing rot arms for staleness
hygiene and getting the pricing effect by accident. The question to ask of every exemption list is
not only "what fails when an entry stops being needed" but **"which remedy does this guard make
cheapest?"** If the answer is "adding an entry", it will produce entries, and the population will
look reviewed while nothing was fixed. Re-checked V-2042's outbound roster against the same standard:
it passes for the same reason this one now does — an entry must name the bounding MECHANISM in prose,
so there is no numeric door, and its rot arm drops an entry whose file stops calling out.

## V-2048 — the exhaustiveness axis has no if/else sibling, and the gate's blind-spot figures hold (2026-08-27)

Two axes checked and closed, both clean. Recording them so neither is re-swept.

### The `if/else-if` spelling of the void-switch defect

`a-void-switch-over-a-finite-union-must-be-exhaustive.test.ts` (V-1917) covers a real compiler gap: a
switch over a finite literal union inside a **void** function has no return obligation, so
`noImplicitReturns` cannot see a missing case. Its scope is deliberately narrow and every exclusion
is a shape the compiler already covers — a value-returning function (caught by `noImplicitReturns`),
a `never`-returning one (TS2534), a switch over bare `string` (legitimately permissive).

⭐ **Its scope is `switch`, and an `if/else-if` chain over the same union is the same defect in a
different spelling** — TypeScript cannot check that one either. Swept for it. Boundary: 342 tracked
`.ts` files under `apps/server/src`; chains of ≥2 branches comparing ONE identifier against string
literals with no final bare `else`. Detector controlled against an in-memory known positive AND a
known negative before running (the negative differs only by having a final `else`), because A2's
suite was importing the tree and a planted probe file would have been a write into their run.

**One candidate in 342 files, refuted by reading.** `db/webhooks-repo.ts:318` buckets delivery counts
with three branches — `delivered` / `failed` / `dlq` — over a status enum with **five** members
(`'pending' | 'in_flight' | 'delivered' | 'failed' | 'dlq'`, DB default `'pending'`). That is not a
dropped case: the target type is `EndpointDeliveryCounts = { delivered, failed, dlq }`, so omitting
pending and in-flight rows from a delivered/failed/dlq breakdown is the projection the type declares.
A pending delivery has not been delivered, failed, or DLQ'd.

The axis is closed: the codebase dispatches on unions with `switch` (29 of them, all covered), not
with chains.

### The gate's own blind-spot figures

`verify-suite.mjs` records the CI jobs it does not run, with figures "RE-MEASURED 2026-08-26". A
dated count of live statistics is the shape that rots, so it is worth re-checking rather than
trusting. **41 Playwright spec files recorded, 41 tracked on disk.** The Python figure (365 passing)
cannot be settled statically — measured 276 `def test_` declarations across 32 tracked pytest files
plus 10 `@pytest.mark.parametrize` decorators, which is a LOWER bound since parametrize expands at
runtime, so 365 is consistent and the statics are inconclusive by construction. Stated rather than
resolved; running pytest would have contended with a peer's suite for a figure that is documentation.

## V-2049 — storage as a trust boundary: the class A2 hit, swept across the codebase (2026-08-27)

A2 fixed a live defect in their own hour-old change and stated the class better than I would have:
**"changing where a value lives changed who can write it, and my validation did not move with it."**
Their exit-identity store moved from an in-process Map to Redis; the read path validated types but
not shapes, so an empty `region` or a country like `"USA"` passed and then threw inside
`SessionAssignSchema.parse`, failing a whole session launch over the IP panel. An in-memory map has
one writer and its invariants are enforced by the code that fills it; a Redis key can be written by
anything holding the connection, including an older deploy of the same service.

That generalises, so I swept it. **Every Redis read path in `apps/server/src` validates what it reads
back.** Boundary: all `redis.(get|getdel|hget|hgetall|mget|lrange|smembers)` call sites —

- `services/cli-authorize.ts` — `parseStoredCode` reconstructs a normalized discriminated union and
  states the principle in its own header: _"Redis is an external trust boundary: deploy drift,
  operator writes, or a partial restore can leave syntactically-valid JSON whose runtime shape no
  longer matches StoredCode … so malformed values never reach constant-time comparison or secret
  decryption with attacker-controlled types."_ It checks a 64-hex hash, a non-empty state, a finite
  non-negative timestamp.
- the MFA challenge consumer (`auth-flows.ts`) — `parseMfaChallengePayload`, and on failure it
  CONSUMES the corrupt entry so malformed data fails closed rather than becoming a repeatable 500.
- `services/auth-cache.ts` — has its own dedicated guard, `auth-cache-security-schema.test.ts`.
- `agent-pair-mode-lock` returns a display string only; `redis-fleet-nonce-cache` returns a boolean
  from `SET NX` and reads no stored payload.

**So the discipline is established here and A2's file was the exception, not the rule** — worth
saying, because it means their fix aligned with a convention rather than inventing one.

### The same class one layer down: jsonb

Drizzle's `$type<T>()` on a jsonb column is a COMPILE-TIME cast, and a row written by an older deploy
carries whatever shape that deploy wrote — the identical trust-boundary shape at the database. 23
jsonb columns are declared in `schema.ts`.

The execution-driving one, `scheduled_jobs.payload`, is read as
`(r.payload as Record<string, unknown>) ?? {}` — the WEAKEST possible assertion, which is the honest
one: every field arrives as `unknown`, so TypeScript forces each handler to narrow before use.
Measured that narrowing across the tree (boundary: tracked `.ts` under `apps/server/src`, comment
lines dropped, lines reading a field off a `payload` object): **13 lines guard with `typeof` or a
schema parse, 1 casts.**

⛔ The single cast is a false positive for this class, and reading is what showed it.
`durable-webhook-delivery.ts:150` casts on the **write** path — `opts.payload` is a caller-supplied
in-process object being narrowed for an INSERT, not a value read back from storage. Its consequence
is safe besides: `webhookDeliveries.eventType` is a pg enum column, so an invalid value is rejected
by Postgres rather than silently stored.

Axis closed. ⚠️ Recorded with its boundary because the sweep keys on the identifier `payload`; a
jsonb column read under a different local name is outside it.

## V-2050 — "docs cannot break a test" was false here, and the log has a measured budget (2026-08-27)

A2 announced their gated SHA (`f5b7358cc`) and, rather than waving my two docs-only commits through
as harmless, recorded them as OUTSIDE it — noting that "docs cannot break a test" is a claim about
today's test set, and several tests read files. **Checked rather than assumed, and they were right:
twelve tests reference the verification log**, among them
`a-verification-log-number-resolves-to-one-finding` (V-numbers must be unique),
`docs-verification-log-content-parity`, and `no-formatted-markdown-outgrows-the-format-hook`.

Ran the four that read it against my ungated commits: **17 tests, all pass.** So the commits are
fine — but they were never outside the reach of the suite, and I had said otherwise.

⛔ My own check of that claim was also wrong in the other direction: a grep for tests referencing
`docs/` returned **0** while twelve were sitting in the previous command's output. The pattern was
double-quoted inside an already-quoted shell string, so the search that ran was not the one I wrote —
the same quoting trap that is already in my notes, hit while checking a peer's caveat about
unverified assumptions.

### The budget I am consuming fastest

`no-formatted-markdown-outgrows-the-format-hook` exists because prettier's markdown parser once
exhausted memory on a large file — "it exits inside a V8 out-of-memory stack trace, so the first sign
is every commit touching the file breaking at something that does not look like a rule". It reads
`.prettierignore` rather than carrying its own list, so the three frozen archives are exempt for the
same reason they are exempt from the hook. **The ACTIVE log is not exempt.**

    MARKDOWN_BUDGET_BYTES   1,500,000
    docs/verification-log.md  1,103,599   (73.6% consumed)
    headroom                    396,401   (26.4%)
    entries                         344
    my 25 entries this session average 3,755 bytes  ->  room for ~105 more

Not urgent and not a defect — the guard's stated intent is "a nudge to split with room to spare
rather than as an emergency", and the split has been done three times before (V-1214/V-1215).
Recorded because I am the fastest writer of this file and a budget nobody has measured is one that
gets discovered by hitting it.

## V-2051 — two green gates on the same SHA range verified different populations (2026-08-27)

A2 and I built a protocol this turn: whoever gates last announces the SHA, so the other can run
`git merge-base --is-ancestor` and get an answer without trusting a report. It is a good protocol and
it is **not sufficient**, which this pair of runs shows.

    A2, HEAD f5b7358cc:  Test Files  3128 passed | 117 skipped (3245)
                         Tests      31440 passed | 845 skipped (32285)

    mine, HEAD 4f38d2347: Test Files  3245 passed (3245)
                          Tests      32269 passed | 16 skipped (32285)

**Same totals, different executed counts — a 117-file, 845-test difference.** My gate exports
`DATABASE_URL` and `REDIS_URL` before running; theirs evidently ran without a reachable database, so
every DB-backed file self-skipped. Both runs print `verify-suite: OK`, both are honestly green, and
they verify different populations.

⭐ **So "X is gated" is ambiguous, and the ambiguity survives the ancestry check.** Ancestry answers
"was my commit in the tree that ran"; it says nothing about whether the files that would exercise it
actually executed. A change to a DB-backed repo could be inside a green SHA and never have run.

The fix is one line in the announcement: **carry the executed count, not just the SHA.** "Green at
`f5b7358cc`, 3128/3245 files executed" is checkable and self-limiting in a way that "green at
`f5b7358cc`" is not. This is the same lesson as `a-gate-that-does-not-name-its-blind-spot-reads-as-total`,
applied to a gate's own summary rather than to the jobs it omits — a skip count IS a blind spot, and
it is printed right next to the pass count where it reads as reassurance.

⚠️ Nothing is broken by this: `f7057a882` (my Math.random guard) is an ancestor of `4f38d2347`, so it
is inside a run that executed all 3245 files. The finding is about what the protocol can promise, not
about an unverified change.

Recorded also because the skip is invisible in the one-line verdict most readers stop at:
`verify-suite: OK — exit 0, no unhandled errors, full file count` is emitted for both runs, and "full
file count" refers to files DISCOVERED, not files EXECUTED.

## V-2052 — a budget guard that has never nudged, and a split-verification flaw caught before use (2026-08-27)

### The size guard fires as a red, never as the nudge it describes

`no-formatted-markdown-outgrows-the-format-hook` says its budget sits "far below the size that killed
the hook, so it fires as a nudge to split with room to spare rather than as an emergency". **Its own
history falsifies the nudge half.** V-1985, earlier today: "The gate went red … had reached
1,508,063 bytes against a 1,500,000-byte budget — over by 8,063." The split happened because the
suite was already failing.

⭐ Not a defect, and the distinction is worth stating: **it converts a catastrophic failure into a
legible one.** Before it existed the symptom was Prettier dying inside a V8 out-of-memory stack trace
mid-commit (V-1214/V-1216), which looks like anything but a size problem. What it cannot do is warn,
because a test has exactly one signal and that signal is failure. "Nudge with room to spare"
describes an intent the mechanism cannot express — so acting early is the writer's job, not the
guard's.

Measured: `docs/verification-log.md` is **1,108,171 bytes, 73.9% of budget, 346 entries
(V-1707..V-2051)** — the only formatted markdown past half the budget, the next being 29.4%. At this
session's rate (25 entries averaging 3,755 bytes) that is ~105 entries of headroom, and nothing will
say so until entry ~106 turns the suite red.

### The split, dry-run and verified — and the flaw in my first verification

Candidates measured, then dry-run entirely in memory while a peer's suite held the tree:

    after V-1900   archive 589,665 B   active 520,217 B  (34.7%)
    after V-1950   archive 754,392 B   active 355,490 B  (23.7%)
    after V-1999   archive 914,849 B   active 195,033 B  (13.0%)   <- 915 KB, matching the 886 KB v1499 archive

⛔ **My first dry run keyed entries by `int(V-number)`, and that key is wrong here.** The log contains
`## V-1793b`, a deliberate follow-up to `V-1793`, so both collapsed to key `1793` and the later
overwrote the earlier — a verification that would have reported "0 entries changed" while silently
dropping `V-1793b`. Two of my own counts disagreeing (346 headings vs 345 distinct numbers) is what
exposed it; the guard `a-verification-log-number-resolves-to-one-finding` already models this
distinction in its header, counting canonical `## V-<n> ` headings separately from distinct numbers.

⭐ **This is V-1985's warning one level up.** It said counting headings would pass even if a body were
truncated at the boundary, so it compared per entry. My per-entry comparison was right in shape and
wrong in KEY — the same class of error, in the fix for it. Re-run keyed by the full heading token
(`V-\d+[a-z]?`): **346 before, 294 + 52 = 346 after, no overlap, none lost, 0 entries whose text
changed, and `V-1793b` present as archive entry #88.** Trigger for the real split: ~90% of budget,
rather than waiting for the red.

### The migration journal audits clean

Boundary: 115 tracked `.sql` files under `apps/server/src/db/migrations` against the 115
`entries[].tag` values in `meta/_journal.json` — **the sets match exactly both ways**, `idx`
contiguous from 0, no duplicates.

⚠️ One `when` runs backwards: idx 21 (2026-05-16) precedes idx 22 (2026-05-06) by ten days. Not
cosmetic in general — drizzle-orm 0.38.4 **silent-skips** a pending migration whose `when` is at or
below the max applied `created_at` — but harmless here, because that check applies only to unapplied
entries and both are long applied. Guarded by `scripts/migration-immutability-check.mjs` (Check 3,
P0), wired as a pre-deploy gate at `deploy-bridge.sh:234`, with its own regression tests and a unit
pin.

⛔ Its reachability was already asked and answered — the archive log records that the script "looked
orphaned but is" active. I re-derived it after grepping the guard corpus for the family word
(`migrations`, 71 hits) but not the log for the specific ARTIFACT name. **Grep prior art by the
artifact's own name the moment you can name it, not only by its family.**

⭐ Operational note: the inline quiescence check I adopted last turn **fired and blocked this entry's
first write attempt** — a peer's suite had started between my previous check and the commit. That is
the race that bit me twice, caught by a guard rather than by disclosure afterwards.

## V-2053 — a control proves the detector fires; it does not prove the population is right (2026-08-27)

Set out to measure a structural blind spot I already knew existed: `buildTestApp` wires in-memory
repos, so a route test cannot see a Postgres cast error — the class V-716 and V-2005 both lived in.
**Premise confirmed first**: `apps/server/tests/integration/_helpers/build-test-app.ts` has ZERO
matches for `postgres(`, `new Pool`, `drizzle(` or `isolated-database`, and wires **47** in-memory
repos.

Then asked which `db/*.ts` files are never exercised against a REAL database. I produced three
answers:

    boundary = tests importing `isolated-database` (21 files), matched by file stem   -> 34 of 55
    same boundary, matched by exported symbol name                                    -> 36 of 51
    boundary = tests gated on a real DB at all (147 files)                            ->  4 of 51

⛔⛔ **The first two are wrong by an order of magnitude, and my controls did not catch it.** I ran a
known-positive control both times — `webhooks-repo.ts` must be found — and it PASSED at the 21-file
boundary exactly as it passed at the 147-file one. The control proves the detector fires. **It says
nothing about whether the population it fires over is the right one**, and a too-narrow population
produces a long, confident, entirely false list of "uncovered" files.

⭐ **What falsified it was an external number, not an internal check.** A2's gate ran without a
database and reported **117 skipped files**; only 21 import `isolated-database`. Those two facts
cannot both describe the same DB-dependent population, and the gap forced the real mechanism into
view: `describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)` — **134 occurrences**, plus 12
`RUN_DB_TESTS`. A peer's skip count audited my boundary; nothing I was running could have.

**The corrected result: 47 of 51 `db/*.ts` files have an exported symbol named by a DB-gated test.**
The four that do not are pure or infrastructural, verified by reading — `chunkIds` (splits id lists,
0 SQL), `assertSeedTargetIsLocal` (0 SQL), `profileSessionAdvisoryLockKey` (7 lines, audited V-2043),
and `client.ts`, the factory every one of the 147 DB tests exercises implicitly. Real-DB coverage of
the db layer is complete.

### The bind-parameter question, already answered better than I asked it

Reading `chunk-ids.ts` ("so a single statement never exceeds the driver's bind-parameter limit")
suggested a sweep: which unbounded `inArray` sites chunk and which do not — 23 sites across 12 files,
3 files using `chunkIds`. **`an-unbounded-repo-scan-is-a-recorded-decision.test.ts` had already done
it, and better.** It classifies **165 repo SELECTs, 12 bounded by nothing the caller controls, and 3
whose size is customer activity**, and it carries a production incident in its prose:
`status-subscribers listPurgeCandidates` — "a backlog past the bind-parameter ceiling made the purge
throw, and the erasure did not happen. The fix chunked the WRITE. The READ that produced the
oversized list is still this."

⭐ It has every arm I have been arguing for this session: a non-vacuity floor on the census
(`> 150`), a forward arm (no unbounded scan without a recorded justification), a rot arm (no recorded
entry that stopped being unbounded), and an **exact-set pin** on the three customer-growth scans so a
fourth is a red rather than one row in a roster of twelve. Its header names four while the pin holds
three, and that is not drift: both the roster and the assertion carry the same in-place note that
`audit-archive selectArchivableRows` left the set at V-1591 by gaining a row cap.

## V-2054 — customer recipe create/delete emit no audit row, and the exemption covering them is false (2026-08-27)

The ADMIN side has a route-coverage invariant (`admin-audit-route-coverage-invariant`, V-1007) that
fails when a new admin mutation forgets its audit row. It exists because `services/admin-audit.ts`
claimed "Every /v1/admin/\* endpoint writes one row here" and that sentence was false in two ways.
**The CUSTOMER side has no equivalent** — its guards pin the service's SHAPE (header text, field
counts, method counts, scope gates). Nothing asserts which customer mutations write an `account_audit`
row; coverage rests on `docs/internal/2026-05-19-audit-log-coverage-audit.md`, whose own method was
"spot-check route files".

**That audit's named remediations all landed** — checked as a post-condition against the current enum
and every tracked `.ts` under `apps/server/src`: `account.byok_anthropic_key_{set,cleared,tested}`,
`proxy.{created,deleted}`, `account.bundled_llm_consent_changed`,
`account.email_preferences_changed` — 7 of 7 declared AND emitted. The enum is fully wired:
**47 declared actions, 47 appearing as literals in server source, 0 orphans.**

### The gap its own text now mis-describes

It placed recipes under "Acceptable gaps (not customer-action-driven)": _"recipes — read-only customer
surface (list bundled recipes); no modification ⇒ no audit needed."_ **No longer true.**
`registerRecipesRoutes` registers:

    line 141  POST   /v1/recipes       requireAuth + requireScope('write') + rateLimit
    line 225  DELETE /v1/recipes/:id   requireAuth + requireScope('write') + rateLimit

The POST/DELETE at 255/258 are the 503 stubs from `registerRecipesDisabledRoutes`. `app.ts:1648`
picks the real pair when `recipesRepo` and `agentSessionsRepo` are both wired, and `bootstrap.ts:1235`
constructs `recipesRepo` unconditionally — so on a production deployment these are live customer
mutations.

**Neither audits.** `services/recipes.ts` contains ZERO occurrences of the substring `audit`, the two
handlers emit nothing, and **no `recipe.*` action exists in `AccountAuditActionSchema` at all** — so
this is not a wiring omission; the action was never defined.

⭐ It matters at the weight the doc gave its own Tier-1 items. A recipe carries `intent_log` and
`transcript_snapshot`, which V-2035 established hold **full customer URLs, path and query** — that is
why the retention sweeper purges them for terminated accounts. The doc's Tier-1 argument for
saved-proxies applies verbatim: _"Customer needs to audit which proxies have been minted under their
account (especially for shared-team-RBAC sessions where any member can mint)."_ Recipes are
account-scoped, so on a shared team account any member with `write` can create or delete one and
nothing records who. The analogous customer-owned object is audited — the doc's Tier-3 list reads
"profile lifecycle (created/deleted/exported/imported): ✓".

**Not fixed here, for the reason the doc itself gives.** `recipe.created` / `recipe.deleted` would
extend a published enum in `packages/api-types` that the three SDKs consume, which it classifies as a
"Class-A schema change". Owner's call, alongside W-10 — though the precedent is encouraging rather
than blocking: every Tier-1 and Tier-2 item on that list was an enum extension and all landed the
next day.

⛔ **Two of my detectors were wrong before this one was right.** A literal extractor over the enum
block matched apostrophes inside interleaved comments and reported 9 "never-emitted actions" that were
comment fragments — the precise failure my standing lesson names. Stripping comments first gave 47/47.
And a route-file-level sweep reported **20 of 27** customer route files as unaudited; the emit happens
one hop away in the service layer, so resolving each route's service imports cut it to 9, of which the
billing four are explicitly accepted by the doc ("Stripe is the audit boundary for billing"). Reading
the remainder is what left one real finding.

## V-2055 — the shared date-namespace has a third adopter, protected only by assertion shape (2026-08-27)

A2 fixed a real defect the moment their gate began executing the DB-backed files it had been
skipping: `db-webhooks-force-rotation-selection` isolates itself by seeding historical secret dates
under a year-2000 cutoff, and `db-webhook-rotation-reminder-repo-drizzle` seeds 1998/1999 into the
same global, unscoped sweep — so its rows entered the due set, sorted to the front of an oldest-first
ordering, and displaced the file's own rows inside `limit`. Their generalisation is the durable part:
**an isolation device that two files adopt stops being isolation and becomes a shared namespace, and
the second adopter is invisible because each file's comment reasons as if it were alone.**

Swept for other adopters. Boundary: 2418 tracked test files under `apps/server/tests`, literal date
strings with a year before 2010 on non-comment lines. Detector validated against A2's known-positive
pair, which it finds.

    1970                    db-agent-session-transcript-migration-drizzle.test.ts
    1998 1999 2000 2001     db-webhook-rotation-reminder-repo-drizzle.test.ts
    1998 1999 2000 2001     db-webhooks-force-rotation-selection-drizzle.test.ts   <- now isolated
    2000                    rate-limit-overrides-repo-contract.test.ts
    2001 2003               webhook-sweeps-survive-one-undecryptable-row.test.ts   <- THIRD adopter

**There are three files in that namespace, not two.** `webhook-sweeps-survive-one-undecryptable-row`
seeds `2001-01-01` and `2003-01-01` into the same `webhook_endpoints` table and calls the same two
global sweeps — `findEndpointsNeedingRotationReminder` and `findEndpointsNeedingForceRotation`. A2's
fix gave `force-rotation-selection` its own database; **the other two both take the shared
`DATABASE_URL`** (`process.env.DATABASE_URL ?? DEFAULT_DB_URL`, no `ensureIsolatedDatabase`), and
they share the literal `2001-01-01`.

⭐ **It does not red today, and the reason is worth stating exactly, because it is not isolation.**
Its arms assert membership — `expect(ids).toContain(goodEndpointId)` and `.not.toContain(poisonEndpointId)`
— with `limit: 500`. A2's failing arm asserted ORDER and that the limit was honoured. Foreign rows
entering this file's result set are invisible to a membership assertion until they push the row it
cares about past 500. **So the protection is the shape of the assertion and a generous limit, not the
absence of a collision** — and an assertion that cannot see interference is exactly the kind that
later gets tightened into one that can.

⚠️ Not fixed here. The remedy is the one A2 already applied — `ensureIsolatedDatabase`, structural
rather than moving dates, since moving the boundary is what the next adopter breaks. It sits inside
the webhook test family A2 is actively working, so it goes to them rather than being edited by a
second agent in the same area. `rate-limit-overrides-repo-contract` (2000) and
`db-agent-session-transcript-migration-drizzle` (1970) are in the same date space but touch different
tables, so they do not join this namespace.

## V-2056 — amending my own remedy: isolation that works per-file can fail in aggregate (2026-08-27)

### The recommendation I recorded is wrong at n=3

V-2055 closed by pointing at the fix A2 had already applied — give the colliding test its own database
via `ensureIsolatedDatabase` — and called it structural rather than moving dates. **That advice does
not survive being applied to the rest of the namespace.** Converting the two remaining files, A2
measured: the reminder file passes **13/13 alone**, and running the three webhook files together
produces **2 failed | 1 passed**. The breakage is in the interaction, not in any file — three workers
concurrently creating and migrating fresh isolated databases, **115 migrations each**, against one
Postgres.

⭐ So the property to state is sharper than "use an isolated database": **isolation that works
per-file and fails in aggregate is not isolation.** A per-file remedy verified per-file reproduces
exactly the blind spot the original defect had — green alone, green in every narrow run, red only at
full scale. And the asymmetry is the same one as the 117 skipped files, one layer down: this would
surface in a full gate and never in a targeted one.

Amending rather than leaving the earlier line to be followed: the remedy for that namespace needs to
be chosen with n=3 in mind, not n=1.

### ⛔ Correcting a correction — the third adopter calls two sweeps, not three

A2 reported that `webhook-sweeps-survive-one-undecryptable-row` calls three global sweeps, adding
`findEndpointsNeedingGraceExpiringNotice` to the two I recorded. Checked both versions before
accepting it:

    committed HEAD      .findEndpointsNeedingForceRotation( x1   .findEndpointsNeedingRotationReminder( x2
    working tree (theirs) identical — same two

`findEndpointsNeedingGraceExpiringNotice` occurs exactly once in that file, on **line 5, inside the
header comment** naming the sweep family the file is about. It is never invoked. V-2055's "two global
sweeps" stands. This is the comment-versus-code trap that cost me nine phantom audit actions earlier
in this same turn — a name appearing in a file is not a call, and a header that lists a family reads
exactly like code that uses it.

### The gate I killed, and what it cost to not kill it

Launched gate-37 on `690216e6c` with a clean pre-flight. Ninety-three seconds in, A2 disclosed that
two `apps/server/tests/integration` files were dirty and BROKEN in the tree my run was importing, plus
two vitest invocations of their own inside my window. **Killed the run rather than asking them to
freeze**: it would have produced either a red I must discard or a green that says nothing about the
files in question, and holding a peer for 300s to protect an uninterpretable result is a bad trade.
Declined their offer to revert — a revert is a second write into the same import window and makes the
state harder to reason about, not easier.

⭐⭐ The structural point, now with evidence from both sides: **two agents adopted "check quiescence
before any write" explicitly, and both breached it within one hour** — mine by writing 22 seconds into
their run, theirs by writing and then running tests inside mine, each after running the check and
finding it true. A point-in-time check cannot establish a property that must hold over an interval, in
either direction. **The rule is not the fix and cannot be**; a worktree makes the interference
structurally impossible, which is what both of us skipped because the edit felt small.

## V-2057 — the customer half gets the invariant the admin half already had; and I retract V-2056's amendment (2026-08-27)

### ⛔ Retraction — I amended correct advice on someone else's unverified measurement

V-2056 walked back V-2055's remedy, arguing that giving each colliding test its own database stops
working once three files do it, on the strength of a peer-reported result of two failures when the
three webhook files ran together. **I did not reproduce that before recording it.** Run now on a
quiescent machine with a real database:

    3 test files, 23 tests, ALL PASSING together

The failures were an artifact of contention rather than of the remedy: `ensureIsolatedDatabase` opens
its admin connection with `connect_timeout: 2`, and that timeout expired under my own full-suite gate
running at the same moment. So the chain that produced a false entry in this log was: my gate ran
during a peer's work, their helper timed out, they reported the failure in good faith, and I wrote it
down as a structural property of the fix. **One protocol breach of mine, laundered through a peer's
honest report, became a retracted claim about someone else's correct design.** My standing rule is to
verify claims myself; I applied it to their sweep-count claim in the same turn and not to this one,
because this one agreed with a conclusion I found interesting.

V-2055's original recommendation stands. ⭐ Worth preserving from the episode: that
`connect_timeout: 2` makes the helper fail LOUDLY under load — the reachability arm reds rather than
the file skipping quietly — which is the right design and should not be "fixed".

### The invariant

`admin-audit-route-coverage-invariant` (V-1007) fails when a new admin mutation forgets its audit
row. The customer half had nothing equivalent: its guards pin the audit SERVICE's shape, and coverage
rested on a 2026-05-19 document whose method was "spot-check route files" — which V-2054 showed has
drifted, since it files recipes as a read-only surface and recipes now register an authenticated
write-scoped POST and DELETE.

New `a-customer-mutation-audits-or-says-why-not.test.ts` walks `src/routes` for customer files that
register a mutation and resolves, for each, whether the file OR any service it directly imports
reaches `account_audit`. **The one-hop resolution is the whole measurement**: a route-file-level check
reports 20 of 27 files silent and every one of those is wrong, because routes call
`api-keys`/`mfa`/`auth-flows`/`profiles` and those emit.

All 27 classify. Eighteen audit; nine are recorded with a reason — four billing routes the 2026-05-19
audit ruled acceptable because the provider holds the record, `session-proxy` (throws
`FeatureUnavailableError` unconditionally, V-823, so it changes no state), `agent-sessions-transport-report`
(logs and returns 204), `legal` (writes a dedicated `lacc-` acceptance record with IP and user-agent,
a stronger artifact than an audit row), `status-subscribe` (public and unauthenticated, so there is no
account to attribute to), and **recipes, recorded as a GAP rather than excused**.

| arm                                                            | mutation                                  | result                                    |
| -------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| ⭐ forward: a new customer route that mutates and never audits | planted `zz-probe-customer.ts`            | reds — `[ 'zz-probe-customer.ts' ]`       |
| rot: roster a file that DOES audit                             | added `account-mfa.ts` to the list        | reds — `[ 'account-mfa.ts' ]`             |
| non-vacuity: break the one-hop service resolution              | pointed the import regex at a missing dir | reds — `expected 6 to be greater than 10` |

That third arm is the one worth having: without hop resolution the census still returns 27 routes and
still compares two sets, it just believes six of them audit instead of eighteen. Restored
byte-identical; ratchets 3069→3070 / 3245→3246; `tsc -p apps/server/tsconfig.test.json` clean; the
whole unit corpus green at 2022 files / 20998 tests.

## V-2058 — my gate never rebuilds, and is protected from stale artifacts by a guard rather than a build step (2026-08-27)

Followed a recorded blind spot of my own: `apps/customer-dashboard` has page tests that execute the
compiled inline `<script>` from BUILT `dist/<page>/index.html` in jsdom, not from source, so they give
a stale pass/fail unless a build ran first. **48 test files execute a page out of a gitignored
`dist/`**, and staleness is wrong in both directions — a stale artifact makes suites green against
markup the source no longer produces (measured 2026-07-30 on admin-panel: 10 falsely green until a
rebuild), a missing one produces a wall of ENOENTs naming nothing.

**My gate does not rebuild.** Verified rather than assumed: neither `scripts/verify-suite.mjs` nor my
gate wrapper contains `npm run build`, `build:apps` or `astro build`. CI does — `npm run build` runs
`build:apps` across every workspace before `vitest run` — which is exactly why
`dist-reading-suites-have-fresh-artifacts` says in its header that it exists "for the local runs that
agents gate their commits on". That is me.

**So the green I have been quoting rests on a guard, not on a fresh build.** Checked the artifacts
directly — boundary: newest file mtime under each app's `dist/` against the newest under its `src/`:

    customer-dashboard   dist 08-27 09:22   src 08-26 05:10   fresh
    admin-panel          dist 08-27 09:22   src 08-20 03:38   fresh
    marketing-site       dist 08-27 09:22   src 08-26 12:15   fresh
    docs                 dist 08-27 09:22   src 08-26 05:12   fresh

All fresh — and **coincidentally so**, because something built at 09:22 today, not because anything in
my run guarantees it.

⭐ **Mutation-proved that the protection is real rather than assumed.** Touched
`apps/customer-dashboard/src/pages/api-keys.astro` (content untouched, mtime only) and the guard went
red immediately, naming the app, both timestamps and the remedy:

    customer-dashboard: built 2026-08-27T13:22:36Z but source changed 2026-08-28T02:44:19Z
    — REBUILD, do not repin assertions onto stale markup

Restored the original mtime with `touch -t`; verified byte-identical restore and a clean tree.

⭐⭐ **The design is better than the one I would have reached for.** My instinct on finding "the gate
does not rebuild" was that the gate should rebuild. It should not: a build step would add minutes to
every run and would MASK the condition, whereas a guard inside the suite makes it visible and
actionable at the moment it matters. The gate is not required to guarantee a fresh artifact; it is
required not to be green when the artifact is stale — and it is not.

⚠️ Operational consequence worth stating for both agents: **editing any `apps/*/src` file makes the
next full gate red on dist staleness rather than on a defect.** Granularity is whole-app `src` by
design (a changed shared Layout restales every page), so this fires on edits that touch no page the
suites read. The fix is a rebuild, and the red is correct.

---

## V-2059 — a retention audit's "Covered" list is the half nobody re-reads: `web_sessions` has no retention (2026-08-27)

Applied the V-2054 method — re-checking whether a dated audit's conclusions still hold — to
`docs/internal/2026-06-10-data-retention-audit.md`.

### The finding I started with, and why it dissolved

GAPS item 2 reads "**`scheduled_jobs`** finished rows — STILL OPEN … Implement next wave". That is
false today: W441 (`services/scheduled-jobs-prune-sweeper.ts`) hard-deletes finished rows older than
`SCHEDULED_JOBS_PRUNE_RETENTION_MS` (30 days), registered at `bootstrap.ts:1620` and enqueued at
`:1625`, deleting via `db/scheduled-jobs-repo.ts`, guarded by both
`tests/unit/scheduled-jobs-prune-sweeper.test.ts` and
`tests/integration/db-scheduled-jobs-prune-finished-drizzle.test.ts`.

⛔ **But the doc records that resolution** — a "**W441 update:**" paragraph 26 lines below, under a
different heading. I had read the GAPS section and the document's tail and concluded "the doc never
recorded W441", which is a claim about the whole document drawn from two windows of it. The remaining
issue is hygiene, not a false record: item 1 was annotated ✅ **in place**, item 2 only remotely, so a
reader who stops at the bullet — which is what a GAPS list is for — sees "STILL OPEN". Annotated in
place. **State the boundary of a measurement in the same sentence as its result, and "the doc says X"
is a claim about every line of it.**

### The real finding

The Covered table listed ``| `web_sessions` / auth tokens | `expires_at` + sweeper |``. **No code
path deletes a `web_sessions` row.**

Measured over the 342 `.ts` files under `apps/server/src`, by a census of every `.delete(<ident>)`
call site — 53 distinct identifiers. The census is self-validating: it contains both known positives
(`scheduledJobs`, the W441 prune above; `systemHealthProbes`, `health-probes-repo.ts:60`) and the
four `AUDIT_TABLES`. `webSessions` is absent. Corroborated two further ways, because the claim is a
negative: a NUL-safe filesystem walk for `.delete(webSessions)` / `DELETE FROM web_sessions` over the
same 342 files returns 0, and `apps/server/migrations` carries no partition/TTL/delete policy naming
the table. All 60 `webSessions` references in src are `.insert` / `.update` / `.select`.

What exists instead: revocation sets `revoked_at`; expiry is enforced at READ time (`gt(expiresAt,
now)` in `auth-repo`, `auth-flows-repo`, `mfa-repo`); `onDelete: 'cascade'` from `accounts` reclaims
rows for _deleted_ accounts only. TTL is 30 days (`AUTH_TOKEN_TTL_MS.webSession`), so a row is dead
weight 30 days after mint and retained indefinitely — one row per login per device. Precisely the
class this document exists to catch, and the same shape as the two incidents its siblings cite: the
2026-05-19 `scheduled_jobs` accumulation, and the 2026-05-20 stale-auth-token audit whose sweeper
header does the arithmetic ("~10 rows at 10 customers; ~70K rows at 10K").

Retention period and delete-vs-anonymise are an owner's call per that document's own heading; the
measurement is not. Recorded as GAPS item 3, not implemented.

### ⭐⭐ Why this row survived three passes of the same document

**An audit's GAPS list is re-read; its COVERED list never is.** Both gaps in this document were
chased and annotated — one in place, one remotely, and a whole later section exists to explain why a
third had been resolved a third way. The safe-list got no such attention in 78 days across three
dated passes.

⭐ **And the row was half true, which is what made it durable.** "`web_sessions` / auth tokens" pairs
an uncovered table with a covered one under a single label and a single mechanism string. The
auth-token half is real (`auth-flows-sweeper`, per-kind) — and it duplicates the row directly above
it, so the pairing added no true unique claim while lending the false half its credibility. A reader
scanning for "is X covered?" finds X in the safe-list and stops.

⛔ **A near-miss inside the instrument, worth more than the finding.** My first pass mapped doc rows
to table identifiers by hand and reported three "NO DELETE" verdicts. Two were **my own mapping
errors**: I wrote `healthProbes` for `systemHealthProbes`, and I looked for
`emailVerifyTokens|magicLinkTokens|passwordResetTokens` when that repo deletes through a **dynamic**
`const t = tableForKind(args.kind)` — visible in the census only as an identifier called `t`. Had I
trusted the first output, I would have reported two live prunes as missing. **A name-keyed census
cannot see a table chosen at runtime**, so a zero from one means "no delete under this spelling",
never "no delete". The one verdict that survived did so because the same census that missed those two
found both known positives — which is the only reason its zero is worth anything.

Doc corrected: misleading row removed, item 2 annotated in place, `web_sessions` recorded as GAPS
item 3 with the measurement and its boundary, and the closing "Both retention gaps … now closed"
qualified — it asserted completeness over a safe-list nothing had verified.

Related: V-2054 (the same method, opposite direction — a doc claiming a gap that was closed).

---

## V-2060 — the guard on that register walked repo→doc only; the reverse arm is the one that catches a false safe-list (2026-08-27)

`the-retention-audit-does-not-outlive-its-findings.test.ts` already guards the register V-2059 found
wrong, and it is a good guard: it reads the scrubbed tables from the REPO rather than pinning prose,
it floors its own reader ("the first version matched `.update(x)` and found NOTHING — the
anti-vacuity floor is what caught it"), and it states its limits explicitly rather than implying
them.

⭐⭐ **Every one of its four arms runs in one direction: repo → doc.** Code closes a gap, therefore
the document must acknowledge it. That is the V-2054 direction, and it is the direction that gets
attention because a stale OPEN item wastes visible work. **Nothing walked doc → repo** — a row
claiming coverage was never asked whether the thing it claims exists. So the register's safe-list
could assert a mechanism that had never been written, which is precisely what it did for 78 days.

This is the missing-reverse-arm shape again, and the third time it has produced a finding here: a
forward assertion ships, the reverse one does not, and the reverse one catches the failure that
**looks like success**. A gap wrongly listed as open is loud and gets chased. A gap wrongly listed as
covered is silent by construction.

### The arm

For every row of the Covered table, the mechanism cell must name at least one artifact that exists —
a source file stem or a declared symbol under `apps/server/src`. Resolution requires structure
(camelCase, UPPER_SNAKE, or kebab) so that a bare English word cannot satisfy it; without that the
arm would grade prose and pass on the exact row that motivated it. "sweeper", "prune" and "delete"
name nothing.

Deliberately weaker than "the mechanism works", which is not mechanically checkable, and much
stronger than prose. The pricing is the point: to put a table in the safe-list you must name the code
that covers it, and if nothing can be named, the row does not belong in the table. That is the same
inversion as the exemption-list second arm — the cheap door becomes the expensive one.

### Proof

- **Known-positive, on the real subject rather than the guard's own list:** restoring the historical
  ``| `web_sessions` / auth tokens | `expires_at` + sweeper |`` row reds exactly one arm — the new
  one — printing `` `web_sessions` / auth tokens -> "`expires_at` + sweeper" ``. The defect this was
  written for is reproduced verbatim and caught. File proved to differ before the result was read;
  restored byte-identical from a path-keyed snapshot.
- **Vacuity:** breaking the table parser so it matches no rows reds the FLOOR arm
  (`expected 0 to be greater than or equal to 4`), not the main arm silently passing. Both failure
  modes — a resolver that resolves nothing and a parser that parses nothing — report opposite
  verdicts from the same bug, so both are floored.
- Resolver floors on known positives (`pruneOlderThan` as a symbol, `auth-flows-sweeper` as a file)
  so a broken resolver reds instead of condemning every row.
- 4 → 6 `it(` against HEAD; `tsc -p apps/server/tsconfig.test.json` clean; no new test file, so no
  `EXPECTED_TEST_FILES` change.

### What the arm immediately priced

One surviving row named no artifact: `crypto-order idempotency dedup | in-memory 24h TTL prune`. The
mechanism is real — `pruneIdempotency` in `services/crypto-orders.ts`, called on each idempotent
create — so the remedy was to name it, not to remove the row. That is the guard working as intended
on its first run: it did not find a second missing mechanism, it found a row that could not be
distinguished from one, and the fix took the ambiguity away.

⛔ **Scope, stated rather than implied.** This checks the Covered table of one document. The same
weakness — a safe-list nothing re-reads — is generic to every audit register in `docs/internal`, and
this arm does not reach them.

Related: V-2059 (the finding), V-2054 (the same register class, opposite direction).

---

## V-2061 — REFUTED: the redaction posture's prose rule holds for all nine callers, by two different mechanisms (2026-08-27)

Continuing the V-2059/V-2060 vein into the population those entries pointed at: **28 "do NOT
re-audit / don't re-sweep" markers across 13 registers in `docs/internal`**, all dated 2026-05-16 to
2026-06-23 — two to three months of change ago. A clean verdict that instructs future readers not to
check it is the maximally unguarded case: it cannot be falsified by anyone following it.

Took the highest-risk one whose subject I had recently touched.
`2026-06-09-credential-redaction-posture.md` lists five covered egress channels under "What's covered
(don't re-audit)", and the channel where V-2039's live privacy defect sat (`publicAgentIntent`, the
agent-intent payload) is **not among them** — so that finding does not falsify this list; the channel
was never on it.

Its next section states a rule in prose: a new free-text egress channel must run through `redactText`
(server) or `scrubText` (gui) **and pin the wiring in a content-parity test**, because "un-wiring a
redactor is a silent re-leak". A rule stated only in prose is the shape that has produced findings
here repeatedly, so I measured it.

**Nine modules call `redactText`** (comments stripped, so a mention in a comment is not a call):
`sentry`, `logger`, `durable-webhook-delivery`, `scheduled-jobs`, `webhook-worker`,
`scrub-node-diagnostics`, `agent-intent-result`, `agent-executor`, `cost-alert-dispatcher`. Seven
carry a content-parity pin naming both the module and `redactText`.

⛔ **My first verdict was that the other two were unpinned. Wrong, and the detector is why.** Keying
on "a test naming both the module and the identifier `redactText`" cannot see a test that asserts the
redacted OUTPUT instead of the call. Both have exactly that, and it is the stronger form: proved by
mutation rather than inferred — un-wiring `redactText` from `scrub-node-diagnostics.ts` and
`agent-intent-result.ts` reds **5 arms across the two files**, including one asserting
`https://[redacted]@internal.test/put?token=[redacted]`, which is `redactText`'s output and not that
module's own IP scrubbing. Both restored byte-identical; 28/28 green after.

**No finding. The rule holds for all nine, by two mechanisms.**

⭐ **The reusable part is the near-miss.** A sweep keyed on "is the wiring pinned in a content-parity
test?" — the literal words of the documented rule — reports two false positives, because the rule
names ONE acceptable mechanism and the codebase uses two. **A prose rule that prescribes a mechanism
will be enforced by a sweep that greps for that mechanism, and every compliant-by-other-means site
becomes a finding.** Ask what property the rule protects (here: un-wiring cannot be silent), then
test THAT — by mutation — rather than the mechanism the prose happens to name.

⚠️ Scope: this checks one rule in one of 13 registers carrying such markers. The other 27 markers are
unmeasured, and the population is now enumerated for whoever takes it next.

Related: V-2059, V-2060 (the register class), V-2039 (the agent-intent channel this doc never listed).

---

## V-2062 — sharpening V-2059: those rows carry a per-login IP and user-agent, and the repo's own scrub principle reaches them (2026-08-27)

A2 verified V-2059 independently by a schema-level path rather than my `.delete(` census — a
different mechanism, so a shared blind spot could not carry both — and confirmed every element:
`webSessions` cascades only from `accounts`, no migration deletes it, no sweeper names it, with a
control proving their greps DO find deletions in `agent-session-orphan-sweeper`.

They also offered a severity bound: the published Retention table lists **"Account data — Duration of
Subscription + 7 years post-termination"** (Article 52 _Algemene wet inzake rijksbelastingen_), so
indefinite retention would be consistent with what is published, making this unbounded growth rather
than a compliance exposure. **Verified the row exists and says that, at
`apps/marketing-site/src/pages/legal/privacy.md:468`.** Also verified my V-2059 entry made no
compliance claim in the first place — it argued unbounded growth and a false register — so nothing
needed retracting.

⛔ **But the bound does not hold as stated, for two reasons I found by checking it rather than
adopting it.**

**1. The same table has a second candidate row.** Two lines below Account data:
**"Session metadata — 90 days operational; aggregated counters (no PII) retained indefinitely"**. The
2026-08-07 re-audit's finding 2 was _"Session metadata is never deleted (disclosed: 90 days
operational)"_, resolved by the retention-scrub covering the proxy `sessions` table — so the
established internal reading of that row is `sessions`. Whether a dashboard login session falls under
it or under Account data is a **legal classification, not an engineering call**, and I am not making
it. What matters is that two rows are candidates and the severity differs by a factor of ~28 between
them.

**2. The rows are not bookkeeping.** `web_sessions` carries **`issued_from_ip`** and
**`user_agent`** — a source IP and a device string per login, kept forever. That is the fact the
"account data, therefore fine" reading has to survive, and it is not what "internal job bookkeeping"
looked like for `scheduled_jobs` (W441), where PRUNE was chosen precisely because the rows had no
customer content.

⭐⭐ **The decisive evidence is the repo's own principle, not my reading of the policy.**
`db/retention-scrub-repo.ts` states it in its header: _"Keeping the row while scrubbing what
identifies it is therefore the disclosed behaviour, not a workaround."_ It then enumerates personal
data **per column** with the reasoning written out — `sessions.label` and `sessions.metadata` scrubbed
to NULL; `api_keys.name` and `key_hash` to a sentinel; `sessions.purpose` deliberately NOT scrubbed
because an enum of internal vocabulary is not personal data; `api_keys.key_prefix` left intact as a
non-secret lookup fragment under a unique index.

**That principle covers `issued_from_ip` and `user_agent` exactly. The implementation's table list
does not reach them.** The remedy already exists, is designed, is deployed, and has a sentinel
convention and a documented ordering — it simply enumerates three tables, and a fourth carrying the
same class of column was never added.

So the owner's-call item is sharper than "pick a retention period": the question is whether these two
columns join the existing scrub, and that is a smaller decision than the one V-2059 recorded, because
the mechanism needs no design. Updated GAPS item 3 accordingly.

⭐ **Method note, since this is the second time it has mattered.** I have recorded before that I
verified a peer claim which contradicted me and adopted one that agreed — the asymmetry, not the
verification, was the defect. This time the agreeing claim was checked at source, and checking it is
what surfaced the second policy row and the two columns. **A claim that lowers the severity of your
own finding deserves the same scrutiny as one that raises it**, and it is easier to skip precisely
because accepting it costs nothing in the moment.

---

## V-2063 — VERIFIED CLEAN holds: the MFA register's three claims, and an operator asymmetry that will read as an off-by-one to the next sweep (2026-08-27)

Sampling the 28 "do NOT re-audit" markers enumerated in V-2061, per A2's suggestion to sample rather
than sweep. Picked `2026-05-31-mfa-challenge-not-attempt-bounded.md` on churn: it cites only two
source files, so it can be verified in full, **both changed since it was written**, one of them today
— and its subject is brute-force bounding on a second factor.

**All three "What's solid (do NOT re-audit)" claims verify against current code:**

- **TOTP** — `TOTP_PERIOD_SECONDS = 30`, `TOTP_DIGITS = 6`, `TOTP_DRIFT_WINDOWS = 1`, constant-time
  per-window compare with no early break. Holds, and is now **stronger** than the claim: V-353b added
  `last_used_totp_counter`, making each 30s window single-use.
- **Challenge token** — `randomBytes(32).toString('base64url')`, `TTL_SECONDS = 5 * 60`, atomic
  `GETDEL` with an explicit "there is NO fallback here" note, bound to `account_id` / `email` /
  `source_ip`. Holds.
- **Recovery codes** — scrypt-verify against stored rows, `markRecoveryCodeUsed` on match,
  `regenerateRecoveryCodes` present. Holds.

`MAX_MFA_CHALLENGE_ATTEMPTS = 5` survives, pinned by four test files.

### ⭐⭐ The part worth recording: one constant, two comparisons, both correct

    auth-flows.ts:1007   if (attempts >= MAX_MFA_CHALLENGE_ATTEMPTS)   // login MFA
    auth-flows.ts:1354   if (attempts >  MAX_MFA_CHALLENGE_ATTEMPTS)   // step-up reauth

Same constant, same file, opposite boundaries — the exact shape a sweep reports as an off-by-one.
**It is not one, and the asymmetry is load-bearing.** The login path increments _only on a failed
verification_, so `attempts` counts failures including the current one and `>=5` kills the token on
the fifth. The step-up path **reserves a slot before verification for every proof** — "each in-flight
proof reserves a slot … invalid proofs retain it, while valid proofs and verifier errors release only
their own" — so `attempts` includes the in-flight call and `>5` refuses the sixth. Both permit
exactly five failures. **Changing either operator to match the other would silently move a
brute-force bound**, in opposite directions.

The step-up counter keys on `accountId`, which makes it a per-account lockout — the thing the register
recorded as SURFACED policy rather than implemented. Its safety rests on the caller already holding a
session, and that assumption is enforced rather than assumed: the route registers with
`preHandler: [app.requireAuth, loginGate]` and takes `accountId: ctx.account.id` from the
authenticated context, never from the body. So an attacker cannot lock out an arbitrary account
without already holding that account's session. Checked because a counter keyed on caller-supplied
identity would be a remote lockout vector.

**No finding. One of 28 markers sampled and sound** — which is evidence about that marker, not about
the other 27.

Related: V-2061 (the enumerated population), V-2059/V-2060.

---

## V-2064 — two amendments after peer review: a third disclosed row, and the operator asymmetry is already netted (2026-08-27)

### Amending V-2062 — a third candidate row, verified at source

A2 checked my correction rather than accepting it and found a row I had missed, which cuts against
their own position rather than for it. Verified verbatim at `docs/legal/privacy-policy.md:469`:

    | Authentication data (hashed API keys, key metadata) | Until revocation; 90 days after
      revocation the record is anonymised — the key hash and key name are destroyed. …

**Three candidate rows now, not two.** A `web_sessions` row is a hashed authentication credential
carrying a `revoked_at` — the ordinary reading of that promise covers it, and the parenthetical
`(hashed API keys, key metadata)` narrows it. Genuinely arguable in both directions, which is exactly
why the classification is a legal call and not one I should make. What changes is that the
severity band is now wider, not narrower: indefinite / 90-days-operational / 90-days-post-revocation.

The engineering facts are unchanged and are what the decision actually turns on: the two columns
exist, and `retention-scrub-repo.ts` names `web_sessions` **zero** times while stating a principle
that reaches it.

### Amending V-2063 — the asymmetry is guarded in both directions, by different mechanisms

A2 read the `>=` / `>` pair as a live hazard because "both sites would still look right" after a
consistency cleanup. **Measured instead of accepted, and it is already netted — each direction is
caught, by a different mechanism:**

- Unifying the login site to `>` leaves the token alive after the fifth failure.
  `tests/integration/auth-mfa-challenge.test.ts` submits **exactly 5** wrong codes and then asserts a
  CORRECT code still fails; that arm goes green-to-red. The bound is pinned **behaviourally**.
- Unifying the step-up site to `>=` breaks a literal content-parity regex,
  `/if \(attempts > MAX_MFA_CHALLENGE_ATTEMPTS\) \{\s*await this\.releaseStepUpAttemptBestEffort/`.
  Pinned **textually**.

⭐ **Half-pinned in a way worth naming, though:** the login `>=` has no textual pin at all, and the
step-up `>` has no behavioural one. Neither site is guarded twice, and the two guards fail for
different reasons — so a change that defeats one is not automatically caught by the other. They are
adequate, not redundant.

Landed the cheap half of A2's suggestion regardless: a comment at each site naming the other, stating
why the operators differ and which guard catches a unification there. **The comments do not add
safety; they make an existing red legible.** A parity failure reading "expected `>` " on a line
someone just "fixed" for consistency looks like the test is wrong, and that is how a correct guard
gets edited away. Content-parity pin verified still matching after the edit (28/28), plus 58/58
across the three auth-flows guards, `tsc -p tsconfig.test.json` clean.

⭐⭐ **A2 also stated the sharper version of the method point from V-2062, and it belongs here because
it is about me as much as them:** scepticism applied only to claims from outside is not scepticism.
Their tell is better than mine — **the claim cost them nothing.** It resolved an open item, agreed
with their prior, and required no work; any one of those should prompt a harder check, and all three
together did not. The direction matters for the same reason the doc→repo asymmetry does: a
severity-LOWERING claim closes an investigation, so a false one is silent, while a false
severity-raising claim gets chased and dies of its own accord.

---

## V-2065 — second sample of the "do NOT re-audit" population: the clean claims hold, the surfaced note is stale (2026-08-27)

Second of the 28 markers from V-2061, chosen the same way as V-2063 — on churn, and small enough to
verify in full. `2026-05-31-auth-flow-token-audit.md`: two subject files, one changed after it was
written, subject is the user-facing auth-flow tokens.

**Every "VERIFIED CLEAN — do not re-audit" claim holds.** Token primitive: `randomBytes(...)` →
`base64url`, `createHash('sha256')` at rest, lookup by hash. Passwords: scrypt `logN: 15, r: 8, p: 1`
via the api-keys path. TTLs: 30 min / 15 min / 60 min / 30 days, exactly as claimed. Replay: the
conditional UPDATE still carries `isNull(t.consumedAt)` and `findActiveAuthToken` still filters
`gt(expiresAt, now)` AND `isNull(consumedAt)` — the load-bearing predicate, checked first because a
refactor dropping it would be silent and would re-open replay.

### The finding — the surfaced hardening note is stale, in the V-2054 direction

The register's LOW-severity note says `consumeAuthToken` returns `void`, so a caller cannot tell it
lost a concurrent race, and both callers proceed to act. **It returns `Promise<boolean>` now**
(`rows.length > 0`), and the comment states the contract: "0 → already consumed (a concurrent
winner), so the caller must reject rather than double-run."

⛔ **A returned boolean is necessary and not sufficient — a value nothing reads is not added — so I
enumerated the callers rather than stopping at the signature.** All three flows (`email_verify`,
`magic_link`, `password_reset`) gate on it with
`if (!consumed) throw new AuthFlowError('invalid_auth_token')`.

⭐ **And the remedy is stronger than the one the note proposed.** The note asked for an affected-row
count gated on winning the claim. The code calls `consumeAuthTokenFamily`, which atomically consumes
every still-unconsumed sibling of the same kind and account and returns true only when the presented
id was in that UPDATE — so it closes not just the concurrent double-submit but the _sequential_ case
the note never raised: an older or resent link cannot later mint a second session. The note's
"benign-to-minor session sprawl" analysis no longer describes the code.

Annotated in place. Same hygiene point as V-2059's item 2: a reader stops at the heading, so a
resolution recorded anywhere else is not recorded for them.

⚠️ **Loose end, stated rather than fixed:** the single-token `consumeAuthToken` now has **no
production caller** — it survives on the `AuthFlowsRepo` interface, the drizzle implementation, an
in-memory test double, and four test files that exercise it directly, including a content-parity pin
on its body. So it is guarded code with no live path. Traced across `apps`, `packages` and `scripts`
before saying so, because a negative about reachability is the most expensive kind to get wrong.
Removing it is a judgement call about whether the interface method earns its place; I have not made
it.

**Two of 28 markers sampled, both sound on their clean claims, one stale on a surfaced item.** That
is evidence about two markers.

Related: V-2061 (population), V-2063 (first sample), V-2054 (the stale-OPEN direction).

---

## V-2066 — third sample: both latent findings have moved, one to enforced and one to fixed (2026-08-27)

Third of the 28 markers (V-2061), same selection rule. `2026-06-03-duration-sweep-and-rearm-audit.md`
— "Clean (don't re-audit)" plus two findings surfaced for a maintainer decision.

**The clean claims hold** (per-session destroy isolation, cutoff math over the full tier enum,
poller-retry resilience, the re-arm dedup posture). But **both** surfaced findings have moved since,
in the two different directions this vein keeps producing.

### Finding 1 — still latent, and the invariant that keeps it latent is now asserted

`minCapFor` records the SMALLEST cap across matched tiers on every destroy event, because candidate
rows come back without their tier. Correct only while exactly one tier is capped. **That precondition
is enforced:** `session-duration-sweeper.test.ts` (V-1523) reads `MAX_SESSION_MINUTES_PER_TIER`,
filters to capped tiers, and reds the moment a second appears, its message naming both the
consequence and the right fix (carry the candidate's tier, don't adjust the arm).

⭐ This is the "a nil consequence holds only while an invariant does — assert it, don't write it down"
shape, already applied here. I checked for prior art _before_ measuring rather than after, which is
the only reason I did not re-derive it: the register describes the precondition in prose, and prose
is what I would have gone on.

### Finding 2 — RESOLVED, and the register still asks for the decision

The fan-out: handler re-arms (B) → `markComplete` throws → retry re-arms again (C) → two chains
forever, because `dedup:false` never collapses them. The proposed fix was to exclude the executing
job **by id** and restore `dedup:true`.

**`dedup: false` no longer appears anywhere in `apps/server/src`.** The re-arms pass
`dedupOnAccountAndType: true` together with `dedupAfterRunAt: currentRunAt`, and — checked, because a
field nothing reads is not a fix — the repo consumes it: `gt(scheduledJobs.runAt,
input.dedupAfterRunAt)` inside the dedup predicate. Same fix, keyed on **run-time cohort** instead of
id, and it solves both halves at once: the in-flight job (runAt ≤ current) is excluded so the re-arm
is never blocked, which is what `dedup:false` existed for; a prior pending successor (runAt > current)
still collapses, so the retry creates no second chain. Applied to **16 self-re-arming services**.

⛔ **Method note on how that zero was read.** `grep 'dedup: *false'` returning nothing is exactly the
shape of a broken pattern, and I have twice reported a live thing as absent from such a zero. I did
not treat it as the finding: I read the re-arm, then its implementation, then the repo predicate. The
absence turned out to have a _reason_, and the reason is the finding. **A zero is a question, not an
answer** — and it becomes evidence only once you can say what replaced the thing you were looking for.

**Three of 28 sampled.** All sound on their clean claims; **two of three carried a stale surfaced
item** (V-2065, this one). That ratio is now worth naming as a pattern rather than a coincidence: the
"do NOT re-audit" heading protects the VERDICT, and the verdicts have held — what rots is the
open-item list underneath it, because closing an item elsewhere never sends anyone back to the
register that raised it.

### Suite state at this point

Full `npx vitest run`: **3129 passed | 117 skipped (3246 files), 31445 passed | 845 skipped**, 248.7s
— matching `EXPECTED_TEST_FILES_ALL` exactly. `verify-suite`: OK, exit 0, full file count, with its
own honest note that the 117 collected-but-never-executed files gate on `DATABASE_URL`. **Executed
3129 of 3246 discovered**, which is the number that means anything.

Related: V-2061 (population), V-2063 and V-2065 (first two samples).

---

## V-2067 — CORRECTION to V-2065/V-2066: the stale-surfaced-item pattern was recorded in memory on 2026-06-07, and I re-derived it (2026-08-27)

Grepped memory _after_ landing V-2065 and V-2066 rather than before, and it holds the result twice
over.

`project_auth_token_single_use_concurrency_fix` records the fix at commit `e1dc85f1` (2026-06-06):
`consumeAuthToken` returning `rows.length > 0`, all three callers rejecting the race-loser.
`project_auth_flow_token_audit_2026_05_31` records it **again** under "UPDATE 2026-06-07 — LOW
HARDENING NOTE ALREADY RESOLVED (verified before churning)" and a third time as "W427 (2026-06-10) —
✅ RESOLVED … Don't re-surface."

⛔⛔ **And that same memory already states V-2066's generalisation, in one line:** _"the surfaced-LOW
backlog has been actively hardened; treat old 'SURFACED not fixed' notes as likely-resolved,
verify-then-skip."_ I presented "two of three sampled registers carry a stale surfaced item" as a
pattern worth naming. It was named ten weeks ago, by me, from three instances in a single session.

**What survives as new, stated narrowly:**

- The **register itself** was never annotated. Memory knew three times; `docs/internal/2026-05-31-auth-flow-token-audit.md` still read "SURFACED, not fixed" until this turn. That gap — memory current, document stale — is real, and is the same doc→repo asymmetry as V-2060 with memory as the third store.
- The **`consumeAuthTokenFamily` escalation is in neither memory.** Both record `consumeAuthToken`
  returning a boolean with callers at `auth-flows.ts:554/818/880`. Current code calls
  `consumeAuthTokenFamily` at `:815/1118/1203`, consuming every unconsumed sibling of the account —
  which closes the _sequential_ old-or-resent-link case that neither the original note nor the fix
  addressed. The code moved again after 2026-06-10 and no store recorded it.
- Single-token `consumeAuthToken` having **no production caller** is in neither store.

**V-2063 and V-2066 are unaffected** — the MFA operator asymmetry, the `dedupAfterRunAt` cohort fix
across 16 services, and the V-1523 precondition arm were each verified directly this turn and appear
in no prior store I can find.

⭐ **The failure is procedural and I have recorded it before.** My memory index says, in its own
header, to grep prior art **before the first measurement, not after** — and notes that three errors in
one day were memories I had already written and never read. This is the fourth. The cost here was low
(the doc annotation was worth doing regardless) but the shape is the expensive one: **a re-derived
result reads exactly like a discovery, and nothing in the measurement itself can tell the two apart.**
The only instrument that distinguishes them is a grep I keep running afterwards.

⭐ Sharpening it into something mechanical, since intending to remember has now failed four times:
**the trigger is naming a document, symbol, or subsystem — not finishing an analysis.** The moment
`2026-05-31-auth-flow-token-audit.md` appeared in my sampling list was the moment to grep memory for
`auth.flow.token`, and that is a cheaper action than the measurement it would have replaced.

---

## V-2068 — REFUTED, and it calibrates the technique: "never named in the audit record" is not "unguarded" (2026-08-27)

Applied `measure which files the audit record has never named` to a root it had never been run
against. Prior runs covered `routes/` (1 of 60) and `services/lib/db/middleware` (39 of 273, yielding
three findings). **`packages/` had never been measured.**

**3 of 93** `.ts` files under `packages/*/src` are never named by stem in any verification log —
boundary stated in the same sentence: _by stem_, across the four `docs/verification-log*.md` files
(6,136,885 chars, asserted non-empty before believing any zero, since a mistyped glob makes every file
look unaudited). A file audited under another spelling would not show here.

    packages/behavioural-simulation/src/typing-sequence.ts   8,562 B
    packages/api-types/src/agent-intents.ts                  6,272 B
    packages/api-types/src/agent-models.ts                   3,160 B

### The largest is the repo's best answer to every hypothesis I formed from it

`typing-sequence.ts` (V-530.H) generates typo-aware keystroke streams — anti-detection-relevant, and
it states its own invariants in its header, which is where the technique says to look for the
hypothesis. Each one is already guarded, in a dedicated suite of **18 arms** at
`packages/behavioural-simulation/tests/typing-sequence.test.ts`:

- _"Replaying the events reproduces the intended text exactly"_ → an arm replays at
  `typoProbability: 0.5` across five seeds.
- Graphemes → _"emits emoji, combining sequences, and flags as intact grapheme keystrokes"_.
- `MAX_TYPING_REPLAY_EVENTS` / `MAX_TYPING_REPLAY_INSERTED_CODE_UNITS` → arms accept the exact limit,
  reject one over, **and** _"replay the generator worst case at both exact derived limits"_.
- `MAX_TEXT_LENGTH` → an arm asserts the function's OWN check fires rather than relying on the
  delegated `generateKeyboardCadence` call.

Two hypotheses survived the arm list and died on reading:

1. **Replay-with-typo is only exercised on ASCII** (`'log in and reply to my messages'`), and graphemes
   are exercised in a different arm — so the intersection looked untested. It is **unreachable by
   construction**: a typo requires `QWERTY_NEIGHBOURS[char.toLowerCase()]` to exist, and the branch is
   guarded `if (neighbours && neighbours.length > 0 && …)`. No emoji or combining sequence is a key, so
   no grapheme is ever substituted, and the correction retypes the whole `char`.
2. **Index misalignment** — the loop iterates `graphemes` but reads `cadence.delaysMs[i]`, which would
   skew every delay if the cadence were code-unit-indexed. `generateKeyboardCadence` splits graphemes
   too, and its JSDoc says so: _"`delaysMs[i]` is the delay BEFORE Unicode grapheme keystroke `i`"_.

The other two unnamed files are guarded as well — `agent-intents` by four cross-source invariants,
`agent-models` by a dedicated `api-types-agent-models-parity.test.ts` plus both index-export pins.

### ⭐⭐ The calibration, which is the reusable output

**"Never named in the audit record" is a proxy for attention, not for protection, and the two come
apart where a subtree owns its own tests.** In `services/lib/db` the proxy held — those files are
guarded from `apps/server/tests`, so an unaudited file there really was an under-examined one, and 39
unnamed produced three findings. In `packages/`, every workspace carries its own `tests/` dir, so a
file is guarded by its package regardless of whether any audit ever wrote its name down. Same
measurement, same repo, opposite yield.

⛔ Note the scope trap I avoided only because I read prior art first: the guards for all three files
live across `apps/*/tests` **and** `packages/*/tests` — **fifteen** directories match that pattern, and
`agent-models`'s export pin lives in `packages/api-types/tests/` where an `apps/server/tests` survey
would never see it. A "this file is unguarded" claim greped from one test dir is the same false
negative in a different costume.

**No finding. One root closed, and a bound on when the technique is worth running:** measure the
audit record against subtrees whose tests live somewhere else; expect little from those that carry
their own.

Related: V-2067 (grep prior art on naming the subject — followed here, and it is what produced the
fifteen-directory caveat).

---

## V-2069 — the one src file no test names, and my guard for it carried the exact defect class I was hunting (2026-08-27)

V-2068 measured _attention_ (the audit record). This measures **protection**: which source files are
named by no test anywhere. Boundary in the same sentence: by stem, across the corpus of all fifteen
`apps/*/tests` and `packages/*/tests` directories — 3329 files, 29,979,274 chars, with three
known-guarded stems asserted present before any zero was believed.

**5 of 623.** Four are `apps/gui-client` (A2's, not investigated). One is mine:

    apps/server/src/scripts/seed-local-fleet-node.ts   4,812 B

An operator CLI that registers a Mac harness node and stores its LiveKit credentials, documented for
**prod** (`DATABASE_URL=<prod> … npx tsx …`), referenced by no `package.json` script and imported
nowhere — invoked by hand. A production credential-writing path with no test naming it, in a repo
where 618 of 623 source files are named by some test.

### Audited end to end. Every hypothesis I formed died, and the reasons are the point

- **AAD bound to mutable columns** (`nodeId`, `apiKey`, `wsUrl`) — a later edit to `wsUrl` alone would
  make the ciphertext permanently undecryptable. Refuted: `setLivekitCredentials` writes all three
  **in one UPDATE**, so the tuple can never drift from the ciphertext authenticating it, and it is the
  only setter — both call sites go through it.
- **Encrypt/decrypt AAD drift** — refuted by construction: both call one shared
  `buildLivekitSecretAad(context)`.
- **Encrypt-before-register**, since `fleet_nodes.id` is DB-minted — refuted: `repo.register(` is at
  offset 3716, `encryptLivekitSecret(` at 3975.
- **Empty env vars defeat the all-or-nothing guard.** `withLivekit` tests `!== undefined`, which
  `LIVEKIT_API_SECRET=` passes — so a blank var in an operator's shell looked like it would store a
  bogus credential, exactly what the header promises cannot happen. Refuted downstream:
  `assertSecretBytes` rejects `length < 1`, and `assertBoundedUtf8` applies a `1..max` bound to
  `apiKey` and `wsUrl` too. Every empty case throws loudly.
- The envelope migration probes an already-v2 row with the operator key **before** rewriting any
  legacy row, and rejects an incomplete tuple explicitly.

⭐ **The file is safe because it is thin.** Its 4.8 KB is env parsing, ordering and console output;
every security-relevant operation delegates to guarded, defensive code. "Named by no test" located it
correctly — but the risk depends on what the file does _itself_, and here that is almost nothing.

### The one property nothing downstream can enforce

The AAD binds `nodeId`, and the library validates only that it is **a** UUID — never that it is the
id of the row being written. `fleet_nodes.id` is minted by the database. So the binding is correct
**only** because the script registers first and encrypts with the returned `node.id`. Reverse the two
steps, or pass a caller-chosen uuid, and every check above still passes: the envelope encrypts
cleanly, stores cleanly, and fails at decrypt time on a production node long after the operator has
gone. Guarded now, with a rot arm that reds if the library ever gains row-binding validation, so the
pin gets retired rather than left as a fossil.

### ⛔⛔ My guard shipped the defect class this whole session has been about — twice — and only mutation found it

**Version 1.** `expect(src).toMatch(/nodeId:\s*node\.id/)` — file-scoped. `nodeId: node.id` occurs
**twice** in that script (line 77 the setter, line 80 the encrypt context). Mutating the setter's copy
left the encrypt's intact and **all four arms passed**. A guard whose key is the FILE, asserting a
property that belongs to a CALL.

**Version 2**, written to fix exactly that, scoped each call with
`/setLivekitCredentials\([\s\S]{0,300}?\}\)/`. The setter's call **literally contains the encrypt
call as an argument**, so the lazy match stops at the nested `})` and the "scoped" region swallows
both bindings. Mutating the setter passed again. **I re-introduced the same defect while fixing it,
in a narrower spelling** — which is the third lesson verbatim: sweep the SHAPE, not the token.

**Version 3** takes the first `nodeId:` after each call marker. All three mutations now red:
setter-binding → 1 arm, encrypt-binding → 1 arm, renaming the register call → 2 arms (the floor and
the ordering). Script restored byte-identical from a path-keyed snapshot each time, and proved to
differ before each result was read.

⭐⭐ **What this cost and what it bought.** I have spent this session finding guards whose key is
coarser than the property they name — a census keyed by basename, an exemption keyed by filename, a
roster keyed per-file for a per-use review, a covered-list keyed on prose. **I then wrote one, twice,
inside an hour of writing that sentence down.** Knowing the shape does not prevent the shape. The only
thing that caught it was the rule that a mutation must edit the REAL SUBJECT and be applied to _each_
occurrence separately — a single mutation on a two-occurrence property is not a proof, it is a coin
toss that lands green.

⚠️ Ratchets `EXPECTED_TEST_FILES` 3070→3071 and `EXPECTED_TEST_FILES_ALL` 3246→3247 for the one file
added. `tsc -p apps/server/tsconfig.test.json` clean.

Related: V-2068 (attention vs protection), V-2060 (a guard whose key was coarser than its property).

---

## V-2070 — a safety predicate written to prevent duplication is duplicated; and V-2069's corpus missed a sixteenth test directory (2026-08-27)

### First, a correction to my own boundary

V-2069 states its measurement ran "across all fifteen `apps/*/tests` and `packages/*/tests`
directories". **There are sixteen.** `scripts/tests/` holds 9 test files, is matched by
`vitest.node.config.ts`'s `include` (`'scripts/tests/**/*.test.ts'`), and therefore runs in the gate
like any other.

⛔ **The fifteen came from a memory whose entire purpose is warning that a narrow test-dir scope
produces false negatives** — it enumerates the dirs and misses this one. **A note about incomplete
scope, itself incompletely scoped**, and I inherited the gap by trusting the enumeration instead of
globbing for it. Corrected there too.

**The numbers survive.** Re-measured with the corrected corpus: 4 of 623 source files are named by no
test, all four in `apps/gui-client`. V-2069 reported 5 — the difference is
`seed-local-fleet-node.ts`, which is no longer unnamed **because the guard V-2069 added names it**.
The symbol measurement is unchanged at 75 of 1000. So the finding stands and only the stated boundary
was wrong, which is exactly the kind of error that survives when a boundary is quoted rather than
measured.

### The finding: two copies of the destructive-target classifier

`lib/loopback-host.ts` exists specifically to stop this, and says so:

> "The classification lives here rather than in either caller because two copies of a safety predicate
> is exactly the shape that drifted the session-lock key into two independent locks: one copy gets a
> new spelling of loopback, the other does not, **and the weaker one is the one that matters**."

Its two stated callers do import it — `db/seed-target-guard.ts` and
`tests/e2e/helpers/destructive-target-guard.ts`. **A third does not.** `scripts/e2e-local.mjs:31`
declares its own:

    const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);   // script
    const LOOPBACK_HOSTS = new Set([… , '0.0.0.0']);                              // canonical, 5 entries

Both are consumed as _refuse unless loopback_, and the stakes are the same: this script's harness
`TRUNCATE`s every table in whatever `DATABASE_URL` names and `flushdb()`s the Redis index.

⭐ **No live defect, and the direction is why.** The script's set is a strict SUBSET, and it does not
lower-case the parsed hostname where the canonical path does — `postgres:` is not a special scheme, so
WHATWG leaves an opaque host's case intact. Both differences make the script REFUSE where the shared
rule would allow. Fail-closed on both counts.

**But the module's claim is false, the copy is structural, and nothing detects the next divergence.**
`scripts/e2e-local.mjs` is plain `.mjs` and the classifier is TypeScript, so it cannot import it —
this is not an oversight anyone can simply fix, which is precisely the case an invariant is for.

### The invariant

Added to `scripts/tests/e2e-local-target.test.ts` (7 → 9 arms, no new file, no ratchet change): the
script's host set must be a **subset** of the canonical one. Deliberately subset and not equality —
stricter is safe and is the status quo; more permissive means a host that authorises a TRUNCATE
against a target the shared rule refuses.

Mutation-proved with **fail-closed mutations only**, since this guards a destructive operation in a
shared tree: dropping `'localhost'` from the canonical set (making it stricter) reds the subset arm
naming `'localhost'` as the extra; renaming the script's constant so extraction yields nothing reds
the **floor** (`expected 0 to be greater than or equal to 3`) rather than passing vacuously — a subset
of nothing holds trivially, which is the failure mode this arm exists against. Both files restored
byte-identical from path-keyed snapshots, each proved to differ before its result was read.

⚠️ What it does not check: the two are compared as source-literal sets. It cannot see a divergence in
how each is _applied_ — the case-folding difference above is real and invisible to this arm. Stated
rather than implied.

### Suite

`verify-suite`: **exit 0** at the bumped ratchets (`EXPECTED_TEST_FILES` 3071,
`EXPECTED_TEST_FILES_ALL` 3247). That is the post-condition my second standing lesson asks for — the
bump was a derivation from the previous run's 3246, and a derivation confirms only that the change
happened.

Related: V-2069 (the measurement corrected here), and the exemption-list shape — a duplicated list
whose copies nothing compares.

---

## V-2071 — REFUTED: "referenced nowhere in this repo" is not "dead" when the consumer is another repo (2026-08-27)

Followed the symbol measurement from V-2069/V-2070 into its largest cluster: 23 of the 75
never-named-by-a-test exports live in `schemas/harness-control-protocol.ts`, which bounds untrusted
input arriving from the harness. The hypothesis was the one that has paid out repeatedly here — a
declared `*_MAX_*` bound that no schema references is an unenforced bound.

**Refuted on the bounds, immediately and cleanly.** Of 102 SCREAMING_CASE exports in that file, every
cap is referenced in `apps/server/src`. Exactly **three** are referenced nowhere beyond their own
declaration:

    HARNESS_SCROLL_DEFAULT_DISTANCE_PX = 600
    HARNESS_SCROLL_DEFAULT_DIRECTION   = 'down'
    HARNESS_WAIT_FOR_DEFAULT_TIMEOUT_SECONDS = 30

All three are **defaults**, not caps — and the schemas that would apply them declare those fields
`.optional()` with no `.default()`. Each is mentioned in exactly two files repo-wide: its own
declaration, and a content-parity test pinning its literal value. So the shape read as: _a parity pin
freezing three constants nothing applies_, which is a pin on documentation wearing the costume of a
pin on behaviour, and I have logged that shape before.

⛔ **It is not that, and the contract doc says so plainly.**
`docs/internal/cross-agent-control-plane-contract.md:381` — _"distance_px?: number (TOTAL distance,
**default 600**; **harness decomposes into momentum flicks**)"_ — and `:455` lists exactly these as
"Caps/defaults as exported consts". **The default is applied by the HARNESS, in another repository.**
The server declares the contract value and deliberately does not apply it, which is precisely why
nothing here reads it, and the parity pin is the right guard for a value whose consumer cannot import
it.

⭐⭐ **The calibration, which is the reusable part.** My unreferenced-symbol detector answers "is this
symbol read inside this repository", and I framed its output as "dead". Those are different questions
wherever a repo publishes a contract someone else implements — a protocol schema, an SDK constant, an
API type. **The detector cannot see the consumer by construction**, so every hit in a cross-repo
surface is a candidate false positive until the contract is checked, exactly as V-2068 found that
"named by no test" measures attention rather than protection. Two measurements, two turns, the same
correction: the instrument answers a narrower question than its name suggests.

⚠️ **The genuine residual, stated rather than fixed.** Nothing verifies the harness actually defaults
to 600. The server pins the constant, the doc states the behaviour, and the two are joined only by
prose — if the harness changed its default, the constant and its parity pin would both stay green
while the contract was violated. That is a real cross-repo drift hazard and it is **not verifiable
from this repo**: the harness lives in `driftstack`/`webkit-driftstack`, which this lane does not
touch. Recorded so it is owned rather than rediscovered; whoever holds both sides can close it with a
mirror check of the kind V-2070 added for the loopback sets.

**No finding.** Three constants that read as dead are a published contract, and the reason is one
`grep` into a doc that names them.

Related: V-2069/V-2070 (the measurement), V-2068 (the first calibration of the same instrument).

---

## V-2072 — the name-absence detector family is exhausted here, and the instrument I pick targets with reads 42% of the audit record (2026-08-28)

Two results from following V-2068–V-2071 to the end of the vein. Both are negative, and the second
changes how the next target gets chosen.

### 1. Five variants, 253 hits, zero defects

| detector                                  | hits                  | what they turned out to be                                                                                                                                                                              |
| ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| files never named in any verification log | 3 of 93 (`packages/`) | all guarded; packages own their tests                                                                                                                                                                   |
| files named by no test, repo-wide         | 5 of 623              | 4 are a peer's; 1 safe because it is thin                                                                                                                                                               |
| exported symbols unreferenced in `src`    | 3                     | a cross-repo contract the harness implements                                                                                                                                                            |
| exported symbols named by no test         | 75 of 1000            | **all 75 consumed elsewhere in `src`; zero orphans**                                                                                                                                                    |
| modules imported only by DB-gated tests   | 25                    | 22 `db/*` repos by design; of the 3 others, one is an interface module with **zero value exports**, one is covered by an ungated ROSTER test that names it as a string literal rather than importing it |

⭐ **Every one failed the same way: the key was coarser than the property.** "Is this symbol named in a
test" is not "is this behaviour guarded" — coverage flows through call chains, roster tests, interface
implementations and other repositories, and a name-match sees none of those. The last row is the
sharpest: my detector keyed on `import` statements, and the guard it missed reads the file by name.

**This family is done in this repo.** Guard density is high enough that name-absence produces
attention, never risk, and the next defect will not come from it.

### 2. ⭐⭐ The targeting instrument reads less than half the record

V-1920's instrument — rank routes by how little the verification log says about them — is what the
standing order points at, and what V-2004 used. It counts mentions **in `docs/verification-log*.md`
only**. Measured today:

    verification logs   6,154,667 chars
    memory corpus       8,414,460 chars across 1320 files

**The store it does not read is the LARGER of the two.** The distortion is not marginal, it inverts
the ranking:

    webhooks-nowpayments     log  1  memory 11
    _webhook-raw-body        log  1  memory 15
    account-byok-anthropic   log  2  memory 11

All three rank as least-audited on the log alone, and all three are thoroughly audited — `nowpayments`
end to end by V-2004 **today**, BYOK by three dedicated memory files. I was one step from re-auditing
`nowpayments` and stopped only because I grepped prior art on _naming_ the route, which is V-2067's
rule doing exactly the job it was written for.

Re-ranked on `log + memory`, the genuinely least-covered substantial route is
**`agent-sessions-transport-report`** — 6 log mentions and **zero** in memory, 8,973 B. Nothing else
in the top ten has a zero in either column.

⛔ **The general shape, and it is the same one as the sixteenth test directory:** an instrument that
reads one store answers a question about that store, and its name says "audited". Two stores exist
here for historical reasons and neither is authoritative — so any "how well examined is X" measurement
must span both, and any that does not should say which store it read in the same sentence as its
result.

Related: V-2068 and V-2071 (the first two calibrations of the same family), V-2004 and V-1920 (the
instrument corrected here), V-2070 (the same one-store error in the test-dir corpus).

---

## V-2073 — the schema says every numeric is bounded; one is not, and the arm named for that property checks half of it (2026-08-28)

First target picked with the corrected two-store instrument from V-2072:
`routes/agent-sessions-transport-report.ts`, the only substantial route with a zero in either store
(6 log mentions, **0** in memory).

**The route is well built.** Dual-path auth (`controlKeyOrAccountAuth`) with an explicit ownership
check — `callerCanAccessAgentSession(ctx, session.accountId)` — plus `app.rateLimit('global')` in the
preHandler AND `consumeEffectiveOwnerRateLimit(...)` charging the owner, because the control-key path
leaves `request.account` absent and the generic limiter keys off it. The body carries **no free-text
field at all**, so the structured log line it emits cannot be injected into.

### The finding

The schema's own doc comment states the invariant:

> "**Every numeric field is bounded** (a hostile/buggy client can't log a nonsensical value)"

Five numerics. Four are bounded — `rtt_ms` `.int().max(60000)`, `packet_loss_recent_pct` `.max(100)`,
`jitter_ms` `.max(60000)`, `decode_fps` `.max(1000)`. The fifth was
`freeze_count: z.number().nonnegative().nullable().optional()` — **no ceiling, and no `.int()` on a
field that is a count.** So a client could report `freeze_count: 1e12` or `2.5` into the log line the
route exists to aggregate for a transport decision.

⛔⛔ **And the guard is named for exactly the property it does not check.** The arm was titled
_"schema: bounds are exactly as documented"_ and asserted three of six fields — `rtt_ms` fractional,
`decode_fps` over its max, and for `freeze_count` **only the lower bound**, because the lower bound
was the only constraint that existed. **A subset check under a total name.** This is the same shape as
V-2069's file-scoped assertion and V-2060's covered-list: the name states the property, the key checks
less than the property, and the gap is invisible because the arm is green.

### Fixed, and why the bound is loose

`freeze_count: z.number().int().nonnegative().max(1_000_000)`.

⭐ **The bound is deliberately generous, and the reason is a failure mode specific to this route: the
client swallows every error by contract** ("Best-effort by contract: the client swallows every error,
so a failure here NEVER affects the stream"). A rejected report is therefore **silently dropped** —
losing exactly the telemetry the endpoint exists to collect. A too-tight ceiling would be a worse
defect than the missing one, so the number is anchored in the schema's own figures: a million freezes
is 1000 seconds of freezing at the `decode_fps` ceiling directly above it. `.int()` is separately safe
— the client reads `RTCInboundRtpStreamStats.freezeCount` (spec: unsigned long) straight through, and
every gui-client fixture is `0` or `null`, checked before touching a shared contract.

The arm now checks the property its name claims: an upper bound on **all five** numerics, `.int()` on
both counts, the lower bound, and that the **exact** ceiling is still accepted — an off-by-one in the
bound is otherwise indistinguishable from the bound working.

**Proof.** Dropping `.max` reds one arm; dropping `.int` reds one arm; source restored byte-identical
from a path-keyed snapshot, proved to differ before each result was read. `it(` count unchanged at 19
(the arm was replaced, not added). `tsc -p apps/server/tsconfig.test.json` clean. All **six** files
referencing this route pass, 64 tests — and the six were found only by running BOTH grep patterns:
the import-path spelling and the quoted basename return **different, partly disjoint** sets here.

⛔ Two aborted edits are worth recording. Both replacements asserted `count == 1` and both hit `0`, so
nothing was written: I had copied the indentation out of terminal output that carried a
`sed 's/^/  /'` display prefix, making every line two spaces wrong. **Derive indentation from the
file, never from what a pager printed** — the assert is the only reason this cost a retry instead of a
malformed file.

Related: V-2072 (the instrument that chose this route), V-2069 and V-2060 (the same subset-under-a-
total-name shape).

---

## V-2074 — stop ranking files, start checking what they claim about themselves (2026-08-28)

V-2072 closed the name-absence family (5 variants, 253 hits, 0 defects). Two more targeting axes died
the same way today:

- **Recency** — routes ranked by last commit. Non-discriminating: most of the surface moved on
  2026-08-27.
- **Code newer than its last audit**, across BOTH stores (1840 dated log entries + 1320 memory files).
  **1 route of 60**, and it was a false positive: `admin-owner.ts` scored `0000-00-00` because my date
  extraction matched no dated section, while it is covered by 7 log mentions and 6 memory files
  including a dedicated `admin_owner_gate_audit_clean`. A prior entry had already run this exact
  analysis — "**did the subject move?** Every audited file has since: `admin-owner.ts` 3 commits".

**Seven targeting instruments, zero defects between them.** The route surface is saturated by every
measure of _how much has been written about a file_.

### ⭐⭐ What actually produced every finding today

Not one came from a ranking. Every one came from a file stating a rule about itself and the rule not
holding:

| finding | the file's own words                                                          |
| ------- | ----------------------------------------------------------------------------- |
| V-2059  | the retention register's Covered table: "`expires_at` + sweeper"              |
| V-2070  | `loopback-host.ts`: "the classification lives here … so the two cannot drift" |
| V-2069  | the seed script: "NO fake dev defaults are applied"                           |
| V-2073  | the transport schema: "**Every numeric field is bounded**"                    |

That is a mechanizable search, and it is the inverse of the exhausted family: instead of asking what
the RECORD says about a file, ask what the FILE says about itself, then check it.

**Boundary, stated with the count:** comment lines under `apps/server/src` matching
`every <noun> <verb>` — a universal over an enumerable set, which is the checkable form. **46 claims.**
(The looser pattern including `always|never|no X can|cannot` yields 2275 across 283 files, too coarse
to work through; the narrow form is the one that pays.)

### Four checked this turn, three held

- ⭐ `agent-session-control-key.ts`: _"A header IS present → every failure is a hard 401 (never a
  fallthrough to account data with attacker-controlled input)."_ **Holds.** Exactly two `return`s and
  four `throw`s; the only `{ authorized: false }` is guarded by
  `header === undefined || header.length === 0`. The empty-header case — the input that in V-2023 was
  the sole witness for an MFA bound — is handled explicitly here and falls through as "no key
  presented", which is the safe reading.
- ⭐ `webhook-target-guard.ts`: _"Matches a host whose every dot-separated label is a
  decimal/hex/octal number."_ **Holds** for all four documented smuggling forms — decimal
  `2130706433`, hex `0x7f000001` (and `0X`, the regex is `/i`), octal `0177.0.0.1` (octal digits are
  decimal digits, so `\d+` covers it), inet_aton short form `127.1`. A match returns
  `'numeric-encoding'` — rejected outright, fail-closed.
- ⭐ Same file: _"Shared by the webhook SSRF guard AND the SOCKS5 egress backend."_ **Holds, and
  understates** — six consumers, including `proxy-backends/socks5.ts` and
  `proxy-connectivity-probe.ts`.
- Its IPv6 allowlist checked **before** the blocklist is the one structure that looked like a bypass
  and is not: `PUBLIC_SPECIAL` holds only IANA's genuinely routed exceptions inside the otherwise
  non-global `2001::/23` parent (PCP/TURN/DNS-SD anycast, AMT, AS112-v6, ORCHIDv2, DET), so the parent
  can fail closed without rejecting routed ranges. Deliberate, and the comment says so.

**Yield so far: 1 defect from 4 claims checked (V-2073), against 0 from 253 ranking hits.** Small
sample, but the direction is the opposite of everything else tried today, and 42 claims remain as a
standing work-list.

⚠️ The instrument's own blind spot, stated: it finds claims written in comments. A file that states no
rule about itself is invisible to it, and a rule stated in a doc rather than beside the code (V-2059's
register) will not appear.

Related: V-2072 (the family this replaces), V-2073 (the finding this generalises).

---

## V-2075 — the file warns on the benign race and is silent on the defect; a backstop that fires without a trace (2026-08-28)

Working V-2074's list of 46 self-claims. **Five checked this firing, four held.**

### The four that held

- `routes/auth.ts`: _"Every endpoint here is public … EXCEPT POST /v1/auth/mfa/step-up."_ **Exact.** 12
  registrations, exactly one behind `requireAuth`, and it is the one named; the header's route list is
  12 for 12 with no drift either way — notable because the comment records that the list was wrong
  once ("stopped at ten"). ⭐ It is also already **enforced**, by
  `route-auth-coverage-invariant.test.ts` — surfaced only by the quoted-basename grep, never by the
  import-path one, which is why the rule is to run both. That guard discovers the surface with the
  TypeScript compiler, carries an "exact, unique and **non-stale**" arm on its exemption list, and is
  mutation-paired with `route-registration-locations-are-pinned`. A guard of mine would have been
  strictly worse.
- `routes/auth-cli.ts`: _"Every failed bind must retire the just-minted key, including
  infrastructure/serialization failures."_ **Holds.** The mint completes and `try` opens on the next
  line — nothing between them can throw — and the catch revokes unconditionally for any error type,
  logs a secondary compensation failure, and rethrows the original. The route declares no response
  schema and returns only primitives, so Fastify serialization cannot fail after the handler returns.
  (Residual, inherent to compensation rather than a defect: a crash between mint and bind leaves a key
  whose plaintext never left the process — inert storage, and the comment says exactly that.)
- `db/sessions-repo.ts` / `db/admin-accounts-repo.ts`: _"every status/tier is present (no hardcoded
  list to drift from the enum)."_ **Holds** — but the claim lives in helpers the comment does not
  show, and both iterate `SessionStatusSchema.options` / `AccountTierSchema.options`. `emptyTierCounts`
  exists twice, byte-identical; both derive from the same enum, so 2 copies but 1 behaviour and no
  drift surface.
- `services/anthropic-key-tester.ts`: _"Every failure reason is fixed customer-safe copy: upstream
  response bodies, native transport errors, and the plaintext key never enter the result."_ **Holds** —
  all five failure returns use module-level constants, and the second half of the claim is real too:
  `void response.body?.cancel()`.
- `services/fleet-control-registry.ts`: _"Every HarnessOutbound member must be dispatched here."_
  **Holds**, via `const _exhaustive: never = frame` — with the reason written down (V-1915:
  `noImplicitReturns` cannot see the omission because the function returns void).

### ⭐⭐ The finding, three lines below that last one

The same `switch` is wrapped in `} catch {` — **no binding, no log, nothing**. Its comment justifies
swallowing (the node's receive loop and the process must survive, which is right) and stops there.

**The class holds a logger, and this very file already uses it twice** — `this.logger?.warn(...)` at
`:480` and `:520`, both for a _stale/superseded connection dropping a frame_, which is a benign
reconnect race. Then it goes silent for the strictly more serious case: a frame that passed admission,
JSON parsing **and** schema validation, whose handler threw. **The idiom was two hundred lines away,
applied to the lesser signal and not the greater one.**

Severity is bounded and I checked the bound rather than assuming it: every registered handler logs its
own handled failures (5–8 logger references each), so this catch only sees an error that escaped a
handler — which makes it rarer and _more_ interesting, not less. Nothing retries it either: unlike the
pending-teardown path below (which retains the id for the next reconnect), the frame is dropped
permanently.

⭐ **Swept the SHAPE rather than the site: five bare `catch {` in this file.** One is legitimately
silent — `:529`, a non-JSON frame from an untrusted node is expected garbage, not a defect signal. The
other four swallow errors in our own code. I fixed only `:713`, because it is the one whose own comment
calls itself a "last-resort backstop" and the only one where nothing retries; `:874`/`:971` (reaper-hook
errors) and `:891` (a re-dispatch that RETAINS the id) have different, arguable justifications and are
recorded here rather than swept up in one edit.

**Fixed:** `catch (err)` with a warn carrying `component`, `nodeId`, `frameType` and `err`.
⚠️ **Frame TYPE only** — the body carries customer page state, cookies and profile data; `err` is safe
because the logger's serializer runs `redactText` over every string in a serialized error (W342).

**Proof.** New arm asserts the throw is recorded, names the frame type, carries the error, AND that the
payload never reaches the log record (a `sessionId` sentinel must be absent). Removing the warn reds
exactly that arm; source restored byte-identical from a path-keyed snapshot, proved to differ first.
`it(` 44 → 45, no new file so no ratchet change, `tsc -p apps/server/tsconfig.test.json` clean, and all
**16** files importing the registry pass (291 tests) — the thirteen importers were enumerated with both
grep patterns.

Related: V-2074 (the instrument), and the pre-existing arm at `:511` which proved the throw does not
escape — surviving was tested, recording was not.

---

## V-2076 — 228 catch blocks, zero undocumented; and my fence detector produced two false positives on one character (2026-08-28)

Continuing V-2074's list. **Three more claims checked, all held**, plus a sweep of the shape V-2075
came from.

### The claims

- `db/scheduled-jobs-repo.ts`: _"every settle is fenced on `locked_by = workerId` and returns whether
  it matched."_ **Holds** — `markComplete`, `markRetry`, `markFailed` are the three settle-shaped
  methods of seven, each carries `eq(scheduledJobs.lockedBy, …workerId)` in its WHERE and each returns
  `rows.length > 0`. The reason is written down and is a real hazard: `claimDue` re-claims a row whose
  lock is older than the stale window **without excluding the current worker's own running job**, so an
  overrunning handler's late write could otherwise complete a job still running, or `markRetry` one
  already completed and re-run a side-effecting sweep.
- `db/session-operations-repo.ts`: _"Every fence is enforced by Postgres, never by process memory."_
  **Holds absolutely** — the file contains no `Map`, `Set`, or module-level mutable at all, so there is
  no process memory in which a fence could be held, and all three write fences (`admit`,
  `markRunning`, `settle`) constrain inside a `.where(...)`.

### ⛔⛔ My detector said two of the three settles were unfenced. Both were false, and the cause is one character

I keyed the fence check on the literal `eq(scheduledJobs.lockedBy, workerId)`. `markRetry` and
`markFailed` take their worker id in an options object and spell it **`opts.workerId`**. Two
false positives, refuted by reading — and had I trusted the output, I would have reported a missing
concurrency fence on a job runner that has one.

⭐ **This is the same failure as every other instrument today: I matched the TOKEN, not the SHAPE.**
The corrected detector is `eq\(\s*scheduledJobs\.lockedBy\s*,\s*[\w.]*workerId\s*\)` and is
proved on three controls before use — the bare spelling, the `opts.`-qualified spelling, and a
non-match. That "prove it on a known positive first" step is what separates this from the version I
nearly published, and it cost one command.

### The sweep behind V-2075, and a result worth stating positively

V-2075 found a `catch` that swallows a defect signal without recording it. Swept the shape:
**228 bare `} catch {` sites across 90 files under `apps/server/src`; 36 of those files hold a logger.**

That list is **not** a finding and I am not filing it as one. Most bare catches are legitimately silent
— expected garbage from untrusted input, best-effort cleanup — and the discriminator that made V-2075
real (does the swallowed error indicate a defect in OUR code, or expected input?) is not mechanically
detectable. A 228-item list I cannot triage is the false-positive machine my dominant lesson warns
about.

⭐⭐ **The mechanizable narrowing is a swallow nobody wrote a reason for — and there are ZERO.** Every
catch block in `apps/server/src`, all 228 bare ones included, carries either a statement or an
explanatory comment. Detector proved on four controls first (empty; empty-but-bound; comment-only;
statement-only), because a zero from an unproven detector is worth nothing.

**So the repo's norm is already "always say why you swallow" at 100%.** V-2075's gap was a different
property that the norm does not cover: **documenting a swallow and recording it when it fires are not
the same guarantee**, and a comment explaining why an error is discarded reads exactly like a comment
explaining why it is safe to discard.

Running total on the V-2074 instrument: **8 claims checked, 7 held, 1 finding** — and the finding came
from reading the code _around_ a claim that held, not from the claim itself.

Related: V-2075 (the finding this sweeps), V-2074 (the instrument).

---

## V-2077 — two more claims hold, and my detectors went 0-for-4 on true positives this firing (2026-08-28)

- `services/webhook-worker.ts`: _"Cannot spin: every claimed row is marked in_flight and settles to
  delivered, dlq, or pending with a FUTURE next_attempt_at, so it leaves the ready set."_ **Holds.**
- `db/schema.ts` / `lib/webhook-signing.ts`: _"During the grace, every outbound delivery is signed
  twice (`v1=<curr>, v1=<prev>`)."_ **Holds** — `signWebhookPayload` pushes the second `v1=` whenever
  `secretPrev` is set, and the worker computes `dualSign` as `secretPrev !== null && secretPrevExpiresAt
  > nowMs`, passing the prev secret only then. ⭐ Its `secretPrev !== ''` guard is the same defence as
  > V-1465's Stripe empty-signing-secret refusal: an empty HMAC key produces a valid-looking digest, so
  > "empty means absent" is the safe reading in both places. Consistent discipline, arrived at twice.

### ⛔⛔ The spin claim looked false twice, and both were my instrument

`grep 'nextAttemptAt: at'` — the current time, where the retry paths at `:285` and `:493` compute
`at + backoffMs + jitterMs` — returned two sites, and a row re-queued to `pending` with a
non-future attempt time stays in the ready set and spins the drain loop. That is a real liveness
hazard, and both hits were false:

- `webhook-worker.ts:317` is the branch where **the recovery write itself failed**. The row stays
  `in_flight` — which is OUT of the ready set — for stale reclaim, and the path logs `error` with
  "row stays in_flight for stale reclaim". The returned `{ kind: 'retry', nextAttemptAt: at }` is a
  report to the caller, not a database write; the write is what just failed.
- `webhooks-repo.ts:1125` is `resetDeliveryToPending`, an operator replay path. Immediate eligibility
  is the _point_ there, and it is not a worker settle.

**Scoreboard for this firing: my detectors produced four false positives and zero true positives.**
Two on the settle fence (`opts.workerId` vs `workerId`, V-2076), two here. **Every finding came from
reading — including V-2075, which came from reading the code AROUND a claim that held.** The claims
themselves are holding at 10 of 10; their value is not that they are wrong, it is that checking one
puts you in the right file with a specific question, and the defect is usually three lines away.

⭐ Both false-positive pairs have the identical cause and it is now the most repeated lesson of the
session: **I matched a token where the property needed a shape and a context.** `nextAttemptAt: at` is
only a spin if the row is also written to `pending`; neither hit was. A grep cannot see the second
half of a conjunction, so a one-token detector on a two-part property will fail exactly this way every
time.

Running total on the V-2074 instrument: **10 claims checked, 10 held, 1 finding** (V-2075, adjacent to
a held claim).

Related: V-2076 (the first false-positive pair), V-2075 (the finding), V-1465 (the empty-secret
defence this one mirrors).

---

## V-2078 — a universal that omits its own deliberate exception, and five instrument failures in one investigation (2026-08-28)

`agent-runtime.ts` claims _"Every later mutation is independently active-only as a second fence."_
Checked all three mutation-shaped methods called after it:

- `debitTokensIfActive` — active-gated in name and body. ✓
- `appendTranscriptIfAuthorityRevision` — fences on `admission.authority.revision`, i.e. the exact
  control-lane revision. Arguably stronger than "active". ✓
- `recordUsageRowWithRetry` — **deliberately not gated**, and both post-fence call sites say so:
  _"Account that work exactly once whether the optional answer is published, sanitized to empty,
  **fenced by a new controller**, or suppressed by a transcript-storage failure."_

**The code is right; the universal is imprecise by one documented exception.** Compare `routes/auth.ts`
(V-2075), which states the same kind of claim _with_ its exception named — "Every endpoint here is
public EXCEPT POST /v1/auth/mfa/step-up" — and holds exactly. The repo has the right pattern in one
file and not the other. **Amended the comment to name the exception**, because the blanket wording
invites a future edit to "fix the inconsistency" by gating the cost row — and that edit would stop a
superseded turn advancing `sumMonthlySpendCents`, which the code four lines below calls "the ONLY
enforcement of the bundled-LLM monthly soft-cap". No test would fail and nothing would raise.

**The billing ordering is honoured in BOTH decompose branches, each with its reasoning written down:**
the success path records at L925 before any authority re-read, and the settled-error path records at
L864 before the re-read at L886 ("Preserve real spend/budget accounting before surfacing the fatal
protocol error").

### ⛔⛔ Five instrument failures, one investigation, one cause

1–2. **The settle-fence detector** (V-2076): keyed `eq(scheduledJobs.lockedBy, workerId)`; two methods
spell it `opts.workerId`. Two false "unfenced" verdicts on a job runner that is fenced.

3–4. **Two runtime probes read `recorder called: 0`** and looked like proof that settled provider work
goes unbilled. Both were mis-sequenced: `getAuthoritySnapshot` has **two** call sites and **both run
before the decomposer**, so my "first call succeeds, rest return null" fake refused the turn at
admission — no provider call, correctly nothing to bill. I nearly reported unbilled revenue from a
fake I had wired wrong, twice.

5. ⭐ **A guard I wrote failed on its own premise.** I pinned "the cost row is written before THE
   authority re-read" using `indexOf` on the fence expression. It reds: `expected 41274 to be less than
31010`. The cause is not an ordering bug — **`authorityStillCurrent(session.id, admission)` occurs
   SEVENTEEN times** in `runTurn` (lines 708 … 1361), so `indexOf` matched the first of seventeen and I
   had reasoned about the one at 960. The guard was reverted, not "fixed": with seventeen re-checks the
   design is re-check-before-every-mutation, and "precedes the fence" is not a property that file has.

⭐⭐ **All five have the identical cause, and it is now the single most repeated lesson of this
session: I keyed on a token without enumerating its occurrence set.** Once for a qualifier
(`opts.`), once for a call-order assumption, once for a string that appears seventeen times. The fix
is mechanical and I keep not doing it: **before building any detector on a literal, count how many
times that literal occurs and look at each** — `indexOf` and a first-match grep are only sound on a
set of size one, and nothing tells you the size unless you ask.

⭐ The two probes are worth separating from the three greps. A grep that lies gives a list you can
read. **A test double that is wired wrong gives you a passing test and a number** — `0` — that looks
exactly like evidence. The only thing that caught it was reading the source to ask _why_ the number
should be 0, which is the same move that refuted the other four.

Running total on the V-2074 instrument: **13 claims checked, 13 held, 1 finding** (V-2075), 1 comment
amended.

Related: V-2076, V-2077 (the earlier false-positive pairs), V-2075 (`routes/auth.ts` as the pattern
this file now follows).

---

## V-2079 — a 30/25 split that reads as drift is the trust boundary applied field by field (2026-08-28)

`schemas/harness-control-protocol.ts`: _"Inbound fleet frames share a 96 MiB socket allowance, so
**every string that is retained or persisted must have its own much smaller semantic bound**."_
Same shape as V-2073's `freeze_count`, on the file that parses everything an authenticated harness
node sends.

**Counted before building anything on it**, per V-2078's rule: **179 `z.string()` occurrences**, of
which 64 carry no `.max`/`.length`/`.uuid`/`.regex`. **That 64 is not a finding and I did not report
it** — the claim is scoped to strings that are _retained or persisted_, and most of the 64 are
transient routing ids. A count whose population does not match the claim's population is not evidence.

Narrowing to id-shaped fields (`requestId`, `sessionId`, `intentId`, `challengeId`, `profile_id`,
`tabId`) gave **55 fields: 30 bounded by `HARNESS_FRAME_ID_MAX_LENGTH`, 25 unbounded** — a near-even
split, which reads exactly like a convention half-applied. The obvious story was attractive: a
correlator key is retained in a Map until its request settles, so an attacker-controlled multi-megabyte
`requestId` would be a memory-amplification vector up to the frame cap.

⛔ **It is not drift. Grouped by enclosing schema, the split is perfect and it falls on the trust
boundary:**

    30 bounded    →  IntentResultIdentity/Header, ProfileSaved, ChallengeDetected, ProfileSaveFailed,
                     PageStateFrame, CookiesResult, SetCookiesResult, NavigateHistoryResult,
                     UploadResult, DownloadsListResult, DownloadDataResult, SetEgressResult,
                     SessionStatus, ErrorEventPayload, CapabilityReportPayload, TrimProfileResult
                     — every one an INBOUND frame the harness sends US.

    25 unbounded  →  NavigateHistoryRequest, IntentDispatch, ResumeSession, CookiesRequest,
                     SetCookiesRequest, UploadFileRequest, ListDownloadsRequest,
                     FetchDownloadRequest, TrimProfileRequest, SetEgressRequest,
                     SessionAssign, SessionAssignProfile, SessionEnd, PauseSession
                     — every one an OUTBOUND command WE send, carrying ids WE mint.

**30 of 30 and 25 of 25.** Not one exception in either direction. The claim holds exactly, and the
file applies it per-field on the direction of travel.

⭐⭐ **Sixth population error of the session, and the first whose discriminator no regex could see.**
The previous five keyed on the wrong token (`opts.` qualifier, a literal occurring seventeen times, a
call-order assumption). This one keyed on the right token — the field name — and still had the wrong
population, because whether `requestId` needs a bound depends on **which direction the frame is
travelling**, which is a property of the enclosing schema, not of the field. **"Is this input
untrusted?" is answered one level up from wherever the input appears.**

⚠️ Boundary in the same sentence as the result: this is a static read of one schema file. It confirms
every inbound id field carries `HARNESS_FRAME_ID_MAX_LENGTH`; it does not confirm the bound is the
right size, nor that the outbound ids we mint are in fact short.

Related: V-2073 (the same claim shape, which DID find a gap), V-2078 (count occurrences before
building a detector), and the trust-boundary scoping rule this is an instance of.

---

## V-2080 — the SSE ceiling claim holds and is already guarded; the claims instrument is saturating too (2026-08-28)

`lib/sse-backpressure.ts`: _"`reply.raw.writableLength` grows without bound until the process is out
of memory. **Every stream therefore ends its own representation past a ceiling.**"_

**Holds: 4 streams, 4 ceilings.** Enumerated the population independently of who imports the constants
— files setting `text/event-stream` — which gives five files, and reading each separated them:
`account-notifications.ts` (1 stream, ceiling at L153), `status-stream.ts` (1, L117),
`agent-sessions.ts` (2 — the event lane at L3592/L3581 and the heartbeat lane at L5237/L5272), while
`middleware/auth.ts:41` is JSDoc on `requireAuthEventSource` and `lib/openapi.ts` is the published
spec. ⭐ Two of `agent-sessions.ts`'s four `text/event-stream` lines are a content-type **check** and a
**comment** — the count says four, the population is two.

⭐ **And it is already enforced, better than I would have.**
`every-sse-stream-shares-one-buffer-ceiling.test.ts` carries four arms: a non-vacuity floor ("the scan
found the streaming routes, so a clean result is a real one"), the forward assertion, an
**anti-redeclaration** arm ("no route compares against a redeclared or inline ceiling"), and an
ordering arm keeping the heartbeat ceiling far below the payload one. The anti-redeclaration arm is
the one I would have missed: the original defect was not a missing bound but **three copies that
nothing required to agree**, each with its own passing content-parity pin.

### ⚠️ The instrument is saturating, and I should say so before it wastes another firing

Fifteen claims checked across V-2075–V-2080. **Fifteen held.** The yield:

- **1 defect** — V-2073's unbounded `freeze_count`, found before I had named the method.
- **1 imprecision** — V-2078's fence comment omitting its deliberate exception.
- **1 adjacent finding** — V-2075's silent backstop, from reading _around_ a claim that held.
- **4 claims already enforced by a purpose-built guard** I found only by grepping prior art:
  `route-auth-coverage-invariant`, the scheduled-jobs settle pins, `every-sse-stream-shares-one-buffer-ceiling`,
  and the harness-protocol bound census.

**That is not a failing instrument — it is a well-guarded codebase, and the claims are true because
someone checked them.** But the marginal claim is now returning "already correct, already guarded",
which is the same curve the name-absence family hit in V-2072 after 253 hits. The remaining ~27
claims are worth finishing (they are cheap, and V-2073 came from one), but they should not be the only
thing a firing does.

⭐ Six populations mis-specified across this stretch (V-2076 ×2, V-2077 ×2, V-2078, V-2079) against one
defect found. **The instrument that keeps being wrong is mine, not the codebase's** — and every one
was caught by reading the source rather than by a better regex.

Related: V-2072 (the previous family to saturate), V-2073 (this one's single defect), V-2079.

---

## V-2081 — W-10 re-derived independently at HEAD: 39, and its preventive half was already built (2026-08-28)

V-2080 said the claims instrument is saturating and a firing should not be only that. Switched to my
own blocked open item on the principle that **a blocked item usually has an unblocked preventive
half**.

**W-10's facts, re-derived from scratch at HEAD.** Boundary in the same sentence: measured against the
GENERATED artifact `packages/sdk-python/openapi.json` (2,068,750 B, committed same day as its
builder), not against `lib/openapi.ts` — the builder constructs refs programmatically and contains
only two literal `#/components/schemas/` strings, so counting it would measure the file that NAMES the
spec rather than the one that IS it.

    declared component schemas              83
    reachable from an operation (transitive) 44
    ORPHANED                                 39

⭐ **39 exactly — matching the figure W-10 has carried, re-derived with a different implementation.**
That is the post-condition form: not "the number was 39 when recorded", but "the set is still exactly
that today".

⛔ **My first attempt said 37.** I tested reachability with a substring (`'#/components/schemas/' + name`
appearing anywhere), which matches `…/ApiKeyList` when looking for `ApiKey` — marking a schema
referenced when only a longer-named sibling is, and therefore UNDER-counting orphans. Fixed by walking
the document and collecting actual `$ref` VALUES, with a control asserting every extracted name
resolves to a declared schema. Seventh population error of this stretch, same family as the rest.

### The preventive half already exists, and is better than the one I was about to write

`the-openapi-orphan-set-does-not-grow-while-w10-is-open.test.ts` (V-1918). It is explicit that it does
not take the owner's decision — it only stops the set growing in silence — and three of its choices
are ones I would not have made:

- ⭐ **Frozen by NAME, not by count**: _"A count would let one orphan be fixed and another appear on
  the same day and still pass, and it could never say which schema moved."_
- **Transitive reachability on purpose**, with both readings measured and recorded: transitive gives
  39, operation-`$ref`-only gives 43, _"so the naive reading over-accuses four schemas"_.
- It names the guard that covers the INVERSE case (`openapi-spec-validity-invariant` catches a
  dangling `$ref`) and states that an orphan is the mirror of it, which nothing covered.

**So W-10 is engineering-complete: the gap is frozen, growth is impossible in silence, and what
remains is only the contract decision.** Recorded plainly because "still open" on an item whose
preventive work is done reads as more outstanding than it is — the same stale-status shape as V-2059.

⭐ **Fifth prior-art pre-emption of this session**, and the fourth where the existing guard was
stronger than my plan. All five were found by grepping before building. The rule is earning its keep
at a rate I did not expect: `route-auth-coverage-invariant`, the scheduled-jobs settle pins,
`every-sse-stream-shares-one-buffer-ceiling`, the harness bound census, and now this.

Related: V-1918 (the guard), V-2080 (why I switched axis), V-2059 (a status reading worse than reality).

---

## V-2082 — the differential axis is covered 29/29, and it was swept by the same method I just re-invented (2026-08-28)

Switched off static reading to a **differential** axis: route tests run against in-memory repo doubles
(the V-1576 seam — `buildTestApp` wires them with zero drizzle references), so a double that diverges
from its real counterpart makes route tests pass against a fiction. That is a genuine hazard class and
nothing I had measured.

**Measured: 29 in-memory doubles under `tests/integration/_helpers`, 30 `*-repo-contract.test.ts`
files, and every one of the 29 is referenced by at least one contract test. Zero uncovered.**

⛔ **My first pass said 19 of 29 were uncovered.** I matched double-name against contract-test-name —
and the contract tests are named for the CLAIM (`mfa-totp-replay`, `session-cap`,
`account-audit-count`), not the repo. That is this repo's stated naming convention and it is written
in my own memory as the reason topic-keyword filename greps miss guards here. **Eighth population
error of the session**, and the one with the least excuse.

### And the axis was already swept, by this exact method

`team-members-repo-contract.test.ts` (V-1209) says so in its header: _"The fourth of the twenty-nine…
**I swept every double/repo pair for it** rather than waiting to trip over the next one: for each
Drizzle method carrying an `ORDER BY`, does its double impose the same order? Eight candidates, of
which **three were false positives from my own heuristic**… **Four were real.**"_ The divergence it
fixed was not a different order but the REVERSE one — the real repo newest-first, the double insertion
order — so "the team list a unit test believed it was asserting was upside down relative to the one
the customer is shown."

⭐ Its arms are genuinely dual (`…, in both`), and it records a vacuity trap I would have walked into:
a first draft backdated the SECOND row, which makes write order and newest-first coincide, so _"all
nine arms passed against a double that does not order at all"_.

### Axis state, recorded so the next firing does not re-derive it

| axis                            | state                            | evidence                               |
| ------------------------------- | -------------------------------- | -------------------------------------- |
| name-absence (5 variants)       | **exhausted**                    | 253 hits, 0 defects (V-2072)           |
| file self-claims                | **saturating**                   | 15 checked, 15 held, 1 defect (V-2080) |
| ranking by audit attention      | **exhausted, and mis-specified** | reads 42% of the record (V-2072)       |
| recency / code-newer-than-audit | **exhausted**                    | 1 of 60, a false positive (V-2078)     |
| double-vs-repo differential     | **covered 29/29**                | this entry                             |
| W-10 orphan set                 | **engineering-complete**         | frozen by name (V-2081)                |

⭐⭐ **Six prior-art pre-emptions in one session, four where the existing artifact was stronger than my
plan.** The pattern is now the most reliable predictor I have: on a mature surface, the hypothesis that
feels novel is usually one someone already had, and the artifact they left encodes a constraint the
fresh version misses. Grepping first is not politeness toward past work — it is the cheapest way to
inherit a decision.

⚠️ What is genuinely untried, for whoever picks this up: runtime probing of a booted server against
local Postgres/Redis (the `e2e-local` path exists and is guarded), and the ~27 remaining self-claims
(cheap, and V-2073 came from one).

Related: V-1209 (the sweep this re-invented), V-2080 (the saturation call), V-2081.

---

## V-2083 — the db layer measured against real Postgres: 26 Drizzle methods whose SQL has never run (2026-08-28)

V-2082 named runtime execution as the untried axis. **It was tried — V-1035 — and recorded in
`verify-suite.mjs`'s own comment block**, a file whose OUTPUT I had quoted twice this session without
reading its source. Tenth prior-art pre-emption, and the first where I had already published the claim
that it was untried.

### The post-condition, re-derived at HEAD

V-1035 measured `apps/server/tests/integration` against a disposable migrated Postgres: 357 files,
3258 tests, zero skipped, all passing. **At HEAD: 397 files, 3857 tests, zero skipped, all passing**
(108.8s, `driftstack_a3_vitest` at 115/115 migrations, Redis index 13 chosen because it held 0 keys
while 0/11/12/14/15 hold live data; no `flushdb` exists in the vitest integration path). The set has
grown 40 files and 599 tests and still runs clean — so "nothing has decayed behind the gate" is true
today, not merely when written.

### The instrument the guard names, run for the first time over the whole layer

`every-drizzle-repo-is-driven-against-a-real-postgres.test.ts` states its own limit — _"asserts
EXECUTION, not assertion quality"_ — and names the closer: **v8 coverage over the db layer, NOT a
method-name census** (that census was retired in V-1835 at ~10 of 12 false positives). V-1849 ran it
for ONE file (`oauth-store`, 24/24). Run over the layer:

    db-layer coverage from the integration suite:
      Functions   94.58%  (699/739)   → 40 never executed
      Statements  87.66%   Branches 75.33%   Lines 89.79%

**Boundary in the same sentence: this is coverage from `tests/integration` alone**, so `migrate.ts`,
`seed.ts` and `seed-target-guard.ts` read 0% as a scope artifact — they are CLI/unit-tested surfaces,
and `seed-target-guard` is the very file V-2070 audited through its unit test.

⭐ **Excluding those, ~26 Drizzle methods have never had their SQL executed.** Naming them, because a
Drizzle method builds SQL at runtime and one that never runs has never been validated at all:

    sessions-repo            findSessionUnscoped, countAllByStatus, setEgressCapabilityReport,
                             emptySessionStatusCounts
    auth-flows-repo          findAccountById, markEmailVerified, touchWebSession
    webhooks-repo            enqueueDelivery, resetDeliveryToPending, deleteDelivery
    agent-sessions-repo      setGuiControlKey, setPairModeState
    crypto-orders-repo       upsert, getById
    status-subscribers-repo  findByConfirmTokenHash, listAll
    account-proxies-repo     create, rowWrappersAreV2
    api-keys-repo            setExpiresAt          auth-repo         touchWebSessionLastUsed
    fleet-nodes-repo         getDetail             team-members-repo removeMember
    stripe-webhooks-repo     upsertSubscription    agent-turn-receipts-repo purgeForTerminatedAccountsBefore
    audit-archive-repo       _processedStripeEventsAliasNote

⚠️ `countAllByStatus` and `emptySessionStatusCounts` are the pair I verified **by reading** in V-2077.
The claim ("every status is present, no hardcoded list") is true; the code implementing it has never
run against a database. Reading proves the shape, not that it executes.

### ⛔ Two instrument traps caught, and one guard corrected

**1. A stale coverage artifact that reads exactly like a fresh one.** `coverage/coverage-summary.json`
at the repo root reported 311 files and 2959 functions. My run wrote
`apps/server/coverage/coverage-summary.json` (739 functions) because `--root apps/server` moves the
output. The root file was 54 minutes old, from a different, wider run. **Caught only because its
totals disagreed with the text report I had just read** — not by noticing the path.

**2. One file makes the recommended instrument read false, and nothing said so.**
`account-proxies-repo.ts` reports **75% functions** and reads as a credential-handling repo with a
quarter of its methods unexercised. It is the ONLY file of 47 that keeps its in-memory double beside
the Drizzle class — deliberately, per its own comment ("for unit tests + the in-memory app stack") —
and an integration run against Postgres cannot execute a double. **Of its 9 unexecuted functions,
SEVEN are the in-memory class; only `create` and `rowWrappersAreV2` are Drizzle.** I read it as a
25% gap for several minutes. Added the caveat to the guard header where the coverage run is
recommended, so the next person reads it before the number.

**3. The guard's header number was never right.** It said _"53 source files sit in it"_. The directory
held **54** at the guard's own commit and holds **55** now — wrong at birth, then drifted. Fixed by
removing the hand-typed number and having the completeness arm report the population it walks;
planting a class-less `db/*.ts` now fails with `classified 56 db/*.ts files; …`, proved by mutation and
the probe removed.

Related: V-1035 (the measurement re-derived), V-1849 (the single-file version), V-1835 (the retired
census), V-2077 (the claim whose implementation turns out never to run).

---

## V-2084 — a peer's mutual-deferral finding verified, and the same config audited claim by claim (2026-08-28)

A2 reported that gui-client's coverage is measured by nothing: its own config disables coverage
because "the root project's coverage report is the load-bearing one", while the root config excludes
it as "not in scope". **Verified at source, both halves:**

    apps/gui-client/vitest.config.ts:23-28  "Don't measure coverage from this project — the root
                                             project's coverage report is the load-bearing one."
                                             coverage: { enabled: false }
    vitest.config.ts:44                     "- GUI client (Tauri) — not in scope."
                                             include: ['apps/server/src/**', 'packages/sdk-typescript/src/**']

Neither file is wrong alone. Each defers to the other, and a reader who checks either one is told it
is handled elsewhere. **177 source files and 258 test files measured by nothing** — their figures,
their lane, and I have not touched the config while they are mid-measurement on it.

### The generalisation: that exclusion list carries FIVE rationales, so I checked each

| rationale                                          | verdict                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Drizzle repos (`src/db/`)                          | ⭐ **exemplary** — annotated as expired, re-measured twice (V-1002, V-1798), and V-1002 proved lifting it is free (92.29/90.74/90.94/81.74 against 85/83/84/75). Explicitly left as a decision "somebody makes, not one a measurement makes for them". |
| GUI client — "not in scope"                        | ⛔ mutual deferral (A2's finding, above)                                                                                                                                                                                                               |
| api-types — "Zod runtime, **no .test.ts imports**" | ⛔ false: **3 of its 4 own tests import `../src`** and execute it                                                                                                                                                                                      |
| Astro apps — "**not under vitest scope**"          | ⚠️ substantially true, categorically overstated                                                                                                                                                                                                        |
| generated code (sdk-python `_generated/`, sdk-go)  | ✅ trivially true, and NOT load-bearing — both packages hold **zero `.ts` files** and the include is TypeScript-only, so vitest coverage cannot reach them either way                                                                                  |

⭐ **The Astro entry is the one worth stating carefully, because the raw counts invite an overclaim.**
marketing-site has 190 test files and customer-dashboard 145, and the vitest include glob
`apps/**/tests/**/*.test.ts` matches all of them — so "not under vitest scope" reads plainly false.
It is not: **180 of the 190 and 140 of the 145 read source with `readFileSync` rather than importing
it**, and the bulk of both apps is `.astro`, which vitest cannot instrument. The claim is right about
the apps.

**Measured tail, stated with its boundary:** counting distinct `src/` modules that an excluded
workspace's tests actually IMPORT (not read as text) — **9 TypeScript modules total**: marketing-site
3 of its 5 `.ts` files (`data/capabilities`, `data/pricing`, `data/sub-processors`),
customer-dashboard 4 of 5 (`data/tier-display-names`, `lib/api-base-url`, `lib/oauth-provider-consent`,
`lib/safe-next`), api-types 2 of 24 (`common`, `egress`). That is executable source running under
vitest that the coverage gate does not measure — real, and small.

⭐⭐ **Proportion matters here and I want it on the record: A2's hole is 177 source files; mine is a
9-module tail.** The same shape at two orders of magnitude, and a write-up that presented them as
equivalent findings would be the more expensive error. The instrument that found both is the same one
that has been paying all session — **read what the artifact claims about itself, then check the
claim** — applied to configuration rather than code.

⚠️ Not fixing the config. The Drizzle entry sets the precedent for how this file handles an expired
rationale (annotate, measure, leave the decision), and changing a coverage `include` changes what CI
enforces. A2 is measuring that file's subject right now, so the correction is theirs to land with
their numbers.

Related: V-2083 (the same config's db exclusion, from the other side), V-2074 (the self-claim
instrument this applies).

---

## V-2085 — running a workspace's own vitest project is not running its tests, and the split is by file extension (2026-08-28)

A2 reported that their first gui-client coverage numbers were invalid: running from inside
`apps/gui-client` executed 176 test files where the suite holds 258, so they measured most of the
source against two thirds of the tests. Their invalid run listed **18 files at 0% functions** and they
had begun classifying it as a gap list — including `sanitize-ui-diagnostic.ts`, a credential redactor
that read 0% and looked like the day's best security finding. **It has a dedicated test file that
simply had not run.** The corrected run reports 3 files at 0%, two of them artifacts.

**Measured the mechanism, because a ratio is not a cause:**

    apps/gui-client/vitest.config.ts:18   include: ['tests/**/*.test.tsx']    ← .tsx ONLY
    vitest.node.config.ts:9               'apps/**/tests/**/*.test.ts'        ← .ts ONLY

`*.test.ts` does not match `*.test.tsx`. gui-client holds **176 `.test.tsx` + 82 `.test.ts` = 258**, so
the two projects **partition by file extension** with no overlap and no double-counting, and the 176 is
exactly the `.tsx` half. Running the workspace's own project therefore silently omits the 82 `.ts`
files — which is not a subset "roughly two thirds", it is a specific, nameable set.

⭐ **Bounded across the repo: only two workspaces have their own vitest project, and only one has the
hazard.** `apps/server`'s include is `tests/**/*.test.ts` and it holds 2420 `.test.ts` and **zero**
`.test.tsx`, so its own project collects all of its tests. gui-client is the only app carrying both
extensions, and therefore the only one where "run the workspace project" ≠ "run the workspace tests".

### ⛔ I checked whether this invalidated my own run before writing any of it

V-2083's db-layer coverage used `--root apps/server tests/integration`.
`find apps/server/tests/integration -name '*.test.ts'` → **397 on disk, 397 collected.** Complete. The
reason is incidental rather than clever: I passed an explicit path filter under a root that collects
everything, instead of running inside a workspace project. Had the target been a workspace with its own
config, I would have hit A2's case exactly. **V-2083 stands, and only because of a choice I did not
make deliberately.**

⭐⭐ **The pair is the artifact worth keeping.** `sanitize-ui-diagnostic.ts` read **0%** and looked like
a credential redactor with no tests; `account-proxies-repo.ts` (V-2083) read **75% functions** and
looked like a credential repo a quarter unexercised. **Both manufacture a security finding out of a
coverage number, in opposite directions, and in both cases the tell was two readings disagreeing** —
A2's "0% but a test file exists", mine "739 functions vs the artifact's 2959". Neither instrument
announced itself; neither error was visible in the number alone.

⚠️ And both reductions landed in the same place: A2's 18 zero-coverage files became **one** genuinely
untested live view plus a misdescribing comment; my 190 Astro test files became a **9-module** tail.
Classify before reporting has out-produced every detector either of us built today.

⛔⛔ **CORRECTION, same turn: this was already in my own memory, dated 2026-08-25**, under a name
that states the conclusion — "vitest --root flag runs only half the gui suite". It holds the
mechanism, names the discriminator ("the `.tsx` extension is the discriminator"), gives the remedy
("run the whole GUI surface with a path, not `--root`"), and records the counts at the time (173 `.tsx`
/ 74 `.ts` / 247; today 176 / 82 / 258). **I measured it from scratch and wrote it up without citing
it.** A2 reports the same — it was in their notes too, about this exact suite.

⭐⭐ **Both agents had it written down; both re-derived it on the same day.** That is the sharpest
evidence yet about what a recorded lesson can and cannot do: **a note prevents nothing unless
something makes you read it before you measure.** The habit that works is mechanical — grep prior art
when you NAME a subject, not when you finish analysing it — and it paid **eleven** times this session,
four of them where the existing artifact was stronger than my plan. The eleventh was this note, and
the cost of skipping it was one full measurement plus a write-up that omitted its own source.

Memory refreshed with today's figures and the scope bound rather than left to rot.

Related: V-2083 (the mirror case), V-2084 (the config audit that prompted the run).

---

## V-2086 — V-2083's 26 unexecuted methods, classified: 11 are a real work-list and the rest are not (2026-08-28)

V-2083 measured ~26 Drizzle methods whose SQL never executes against Postgres and called it a
work-list. **A raw list is not a work-list**, which is the lesson A2 and I converged on yesterday, so
this classifies it before anything is written.

### The classification, and the three instrument corrections it took

**Pass 1 — "does src call it?" keyed on `\.name\(`.** Returned 17 called / 8 uncalled. ⛔ Unsound:
the key is the METHOD NAME with no receiver, so `.create(`, `.getById(`, `.upsert(`, `.listAll(`
matched any object. It attributed `status-subscribers-repo.listAll` to `routes/admin-api-keys.ts`,
which is plainly wrong.

**Pass 2 — bound it by name uniqueness inside `src/db`.** 12 names are defined in exactly one db file
(so a bare call attributes correctly); 5 are defined in 3–6 files each (`upsert`, `getById`, `listAll`,
`create`, `purgeForTerminatedAccountsBefore`) and cannot be attributed by grep at all. ⛔ Still
unsound: uniqueness was measured **within the db layer**, and a caller may be invoking a same-named
SERVICE method. `routes/team.ts:268` calls `service.removeMember(...)`, not the repo's.

**Pass 3 — require a repo receiver.** Confirmed 7, dropped 5. ⛔ **Four of the five drops were false.**
The regex wanted `this.repo.` or `…Repo.`, and the real call sites are `this.deps.repo.countAllByStatus()`,
`this.deps.repo.setEgressCapabilityReport()`, and bare `repo.touchWebSessionLastUsed()` /
`repo.getDetail()`. Only `removeMember` was correctly dropped.

**The answer came from reading all five call sites, not from a fourth regex.**

### Read-verified result

    ✅ REAL — called on a repo in src, SQL never executed (11)
       sessions-repo         countAllByStatus, setEgressCapabilityReport
       auth-flows-repo       findAccountById, markEmailVerified
       webhooks-repo         enqueueDelivery, resetDeliveryToPending, deleteDelivery
       status-subscribers    findByConfirmTokenHash
       auth-repo             touchWebSessionLastUsed
       fleet-nodes-repo      getDetail
       stripe-webhooks-repo  upsertSubscription

    ⚪ NOT a gap — no dot-invocation in src at all (8): findSessionUnscoped, emptySessionStatusCounts,
       touchWebSession, setGuiControlKey, setPairModeState, rowWrappersAreV2, setExpiresAt,
       _processedStripeEventsAliasNote
    ⚪ UNATTRIBUTABLE by grep (5 ambiguous names) + removeMember (a service call, not the repo's)

⭐⭐ **`findSessionUnscoped` is the one that would have been a mistake to "fix", and it is worth naming.**
It reads as the highest-value target on the raw list: an UNSCOPED by-id read in a codebase whose
isolation boundary IS the account predicate, with zero coverage. It is a **deliberate legacy escape
hatch pinned at zero callers** — `unscoped-finders-admin-only-sweep.test.ts` asserts exactly that, with
the discrimination written out ("a CALL is a dot-invocation … the definition and the interface
declaration have no leading dot"), because admin force-actions now use atomic primitives with an
explicit `accountId: null` instead. **Its SQL never running is correct.** Writing the integration test
I had planned would have added execution to deliberately dead code and improved a number without
improving safety — a checkbox, and the guard scans `apps/server/src` only, so nothing would have
stopped me.

⚠️ Boundary in the same sentence as the result: "called on a repo in src" is established by reading
every call site of the 12 uniquely-named candidates; the 5 ambiguous names are **unresolved, not
cleared**, and resolving them needs type information rather than grep.

Related: V-2083 (the raw measurement), V-2085 (classify before reporting, from the other side).

---

## V-2087 — a content-parity pin is a SHAPE assertion, and 8 of the 11 have nothing but that (2026-08-28)

V-2086 produced a read-verified list of 11 repo methods called in production whose SQL never executes.
Asked the next question: **what IS guarding them?**

**Measured across `apps/server/tests` (both spellings, 500+ test files): 8 of the 11 are pinned only by
source-TEXT guards** — `*-content-parity` and `*-cross-source-invariant` files carrying regexes over
the method body — with no execution behind them:

    countAllByStatus, setEgressCapabilityReport, findAccountById, markEmailVerified,
    resetDeliveryToPending, deleteDelivery, findByConfirmTokenHash, touchWebSessionLastUsed

⚠️ The other three (`enqueueDelivery`, `getDetail`, `upsertSubscription`) showed apparent behavioural
arms in my proxy — "the name appears in an integration file that also contains `new Drizzle`" — which
is a **file-level co-occurrence, not a call**. Coverage is the authority and reports zero execution for
all eleven, so my proxy over-counts by three. Stated rather than quietly dropped, because it is the
same over-attribution that cost three passes in V-2086.

### Why this is the sharper version of V-2085

`markEmailVerified` is the clean example. Its guard is real and well-written —
`db-auth-flows-repo-content-parity` pins the whole body, and
`db-auth-flows-repo-v079-cross-source-invariant` states the property out loud: _"markEmailVerified
once-only guard — and(eq(id), isNull(emailVerifiedAt)) — prevents overwriting the verification
timestamp."_ Four pins across four files.

**Every one of them asserts what the source SAYS.** The method is a CAS first-transition claim —
`UPDATE … WHERE id = ? AND emailVerifiedAt IS NULL RETURNING id` — whose boolean gates the one-time
signup-welcome email, and **no test has ever asked Postgres whether the second call actually loses.**

⭐⭐ **So a content-parity pin is subject to exactly the limit V-2085 found in reading.** I wrote there
that "reading proves the shape, not that it executes"; a text pin is reading, mechanised and repeated
on every run. It catches an EDIT to the source. It cannot catch the database disagreeing with the
source's assumption — a migration adding a default to `email_verified_at`, a nullability change, or
`.returning()` behaving differently than the author assumed. **Checked the live column: nullable, no
default**, so the guard is behaviourally reachable and correct today; that is a fact no text pin
establishes.

⭐ The in-memory double was worth checking and is **faithful** here — missing account → false,
already-verified → false, otherwise claim — so this is not a V-1209 divergence. The gap is execution
alone.

⚠️ Boundary in the same sentence: "pinned only by source text" means no test in `apps/server/tests`
calls the method on a Drizzle instance, established by coverage rather than by grep; the guard census
itself is a name-match over content-parity/cross-source filenames and would miss a behavioural arm
living in a differently-named file.

**The recipe for closing one, worked out but not yet landed** (a peer holds the machine):
`db-canonical-email-dedup-is-enforced-drizzle.test.ts` already constructs `DrizzleAuthFlowsRepo` with
seeding and cleanup helpers, so the arm is: create an unverified account → `markEmailVerified` → expect
**true** → call again → expect **false** → **read `email_verified_at` back and assert it is the FIRST
timestamp**. That last step is the one that matters: the boolean alone cannot distinguish a working
`isNull` guard from a broken one that returns true twice and moves the timestamp.

Related: V-2086 (the classified list), V-2085 (reading proves the shape), V-1209 (the divergence class
this is NOT).

---

## V-2088 — the first of the eleven closed: Postgres now enforces the verification first-transition, not just the source text (2026-08-28)

V-2087 established that 8 of the 11 never-executed repo methods are guarded only by source-TEXT pins.
This closes the first one, with the recipe that generalises to the rest.

**`markEmailVerified`** is a CAS first-transition claim —
`UPDATE accounts SET email_verified_at WHERE id = ? AND email_verified_at IS NULL RETURNING id` — whose
boolean gates the one-time signup-welcome email. Four pins across four files already assert the body
SAYS `and(eq(id), isNull(emailVerifiedAt))`, one of them stating the property outright. **None had ever
run it.**

**New arm** in `db-canonical-email-dedup-is-enforced-drizzle.test.ts` (an existing host that already
constructs `DrizzleAuthFlowsRepo` with seeding and cleanup, so no new file and no ratchet change):
positive control that a fresh account starts unverified → first call **true** → second call **false** →
**read `email_verified_at` back and assert it is the FIRST timestamp**. That last step is the one that
matters: the booleans alone cannot separate a working guard from a broken one that returns true twice
AND moves the timestamp.

**Proof.** Removing `isNull(accounts.emailVerifiedAt)` from the real subject reds the arm
(`expected true to be false`); source restored byte-identical from a path-keyed snapshot, proved to
differ before the result was read. `it(` 5 → 6, `tsc -p apps/server/tsconfig.test.json` clean.

### The remaining ten are all cheap, and now priced

Every one already has an integration file constructing its repo, so each is an arm in an existing file
— no new file, no `EXPECTED_TEST_FILES` bump:

    DrizzleWebhooksRepo          14 hosts   enqueueDelivery, resetDeliveryToPending, deleteDelivery
    DrizzleAuthFlowsRepo         10 hosts   findAccountById
    DrizzleSessionRepo            9 hosts   countAllByStatus, setEgressCapabilityReport
    DrizzleStripeWebhooksRepo     7 hosts   upsertSubscription
    DrizzleAccountAuthRepo        6 hosts   touchWebSessionLastUsed
    DrizzleStatusSubscribersRepo  4 hosts   findByConfirmTokenHash
    DrizzleFleetNodesRepo         3 hosts   getDetail

⭐ **A `*-repo-contract` host would be strictly better and is not available here.** Those run one
contract against BOTH implementations, pinning double↔Drizzle parity as well as execution. But
`auth-token-family-repo-contract`'s `inMemorySubject().account()` returns a bare UUID **without
creating a row**, which is fine for token-family arms and makes the double's `markEmailVerified` return
`false` on the FIRST call. Using it needs a shared-harness change. Recorded with the blocker rather
than attempted.

### ⭐⭐ The seam behind all of this, measured

**165 of 397 integration files (42%) construct a Drizzle repo at all; 200 use `buildTestApp` only.**
Boundary in the same sentence: "constructs" means the `new Drizzle*` spelling, so a factory-obtained
repo would not count. That is the V-1576 seam quantified for the first time, and it explains V-2083
entirely — most of the "integration" suite exercises routes and services against in-memory doubles,
which is the design, not a defect. The SQL is tested by the `db-*-drizzle` minority.

### ⛔ A hazard I created and a distinction worth keeping

I wrote this arm, went to run it, and the inline check found a peer had started — so an **unverified**
test edit sat in a shared tree their gate could collect. I withdrew it byte-identical, then re-wrote it
later in a single write-and-run action once the tree was free.

**The dirty-file hazard is not symmetric.** A dirty _docs_ file is inert unless a guard reads it. A
dirty _test_ file is EXECUTABLE, and an unverified one is arbitrary code injected into someone else's
verification run — the failure mode is not "my number describes a slightly different tree", it is
"your gate reds on my bug and you spend twenty minutes attributing it". A2 independently reached the
same conclusion and retracted their earlier framing that the two were the same class.

**The rule that follows is the one that has worked all day: make the window not exist rather than check
that it is empty.** Write-and-run as one action; if the inline check fails, nothing is written.

Related: V-2087 (text pins are shape assertions), V-2086 (the classified list), V-1576 (the seam).

---

## V-2089 — three more closed in one arm, and both webhook write fences now bite against Postgres (2026-08-28)

Continuing V-2086's list. `enqueueDelivery`, `resetDeliveryToPending` and `deleteDelivery` share
`DrizzleWebhooksRepo`, so one lifecycle arm executes all three — and the interesting part is not the
execution, it is that **both write fences are safety properties nothing had ever tested**:

    resetDeliveryToPending   .where(and(eq(id), ne(status, 'in_flight')))
    deleteDelivery           .where(and(eq(id), eq(status, 'dlq')))

Reset refuses an `in_flight` row because a live worker owns it. Delete matches id **AND** status, so —
in the repo's own words — "a concurrent state change (e.g. a worker requeued the row between the
service's findDeliveryById and this call) won't accidentally delete a non-DLQ delivery."

**The arm**, in `db-durable-webhook-claim-reclaim-drizzle.test.ts` (an existing host that builds the
repo inside an ISOLATED SCHEMA dropped in `afterAll`, so no cleanup code and no new file): enqueue →
assert `pending` → force `in_flight`, reset must return **null** and leave the row untouched → force
`delivered`, reset must succeed (without this the refusal above could pass on a reset that never works
at all) → delete a `pending` row must return **false** and leave it → force `dlq`, delete returns
**true** and the row is gone.

**Proof.** Removing each fence separately from the real subject reds exactly one arm — mine — and
nothing else; source restored byte-identical from a path-keyed snapshot both times. `it(` 2 → 3, tsc
clean.

### ⛔ The first attempt reported "no tests", which is a syntax error wearing a green-adjacent costume

My `it(...)` title is a single-quoted JS string and I wrote `status='dlq'` and `the service's read`
into it. Both terminate the string. Vitest reported **`Tests no tests`** — not a failure — which is
exactly the symptom the standing rules name and which I have now hit a fourth time this session.
`tsc -p apps/server/tsconfig.test.json` located it immediately (TS1005 at the title line); the run
alone would not have.

⭐ Added `assert "'" not in title` to the generator before rewriting. **The lesson is not "escape your
quotes", it is that a title is CODE** — long prose in a quoted string is the most quote-dense thing in
a test file, and it is the one part nobody proofreads because it reads as documentation.

### Running total on the eleven

**4 closed** (`markEmailVerified`, `enqueueDelivery`, `resetDeliveryToPending`, `deleteDelivery`),
**7 remain** — `findAccountById`, `countAllByStatus`, `setEgressCapabilityReport`, `upsertSubscription`,
`touchWebSessionLastUsed`, `findByConfirmTokenHash`, `getDetail` — each with an existing host that
already constructs its repo.

⭐ Both closures so far found the same thing: the method was pinned by source text, and the property
worth asserting was a **fence** — a WHERE clause whose whole job is to refuse. A text pin proves the
fence is written; only execution proves the database applies it.

Related: V-2088 (the first closure), V-2087 (why text pins are shape assertions), V-2086 (the list).

---

## V-2090 — the V-2077 loop closed, and a jsonb round-trip on a column where that defect once lived (2026-08-28)

Two more of the eleven, both on `DrizzleSessionRepo`, in one arm on the existing tenant-scope host.

**`countAllByStatus` closes a loop I opened myself.** In V-2077 I verified its claim — _"zero-filled
from `SessionStatusSchema.options` so every status is present (no hardcoded list to drift from the
enum)"_ — **by reading the helper**. V-2083 then showed the code had never executed. The arm now asserts
`Object.keys(counts)` equals `SessionStatusSchema.options`, importing the enum so the test and the code
resolve the same source, plus that the seeded `ready` session is actually counted.

**`setEgressCapabilityReport` writes TWO jsonb columns**, which is the exact shape of a defect this
repo has had before — postgres-js `JSON.stringify` double-encoding under a jsonb cast. The arm writes
an object and reads it back through raw SQL, asserting `typeof` is `object` rather than a string, that
both columns round-trip by value, and that an unknown id is a **null no-op** rather than a throw.

**Proof.** Slicing one member off the enum the zero-fill iterates reds the completeness assertion;
dropping `egressCapabilityReport: args.raw` from the `.set()` reds the round-trip. Each mutation reds
exactly one arm — mine — and source was restored byte-identical from a path-keyed snapshot both times.
`it(` 1 → 2, tsc clean.

### ⛔ Two self-inflicted errors, both the same shape as the ones I keep finding

**1. `Cannot find name 'SessionStatusSchema'`.** My generator added the import conditionally —
`if 'SessionStatusSchema' not in t` — but ran that check AFTER inserting the arm that references it.
The symbol was present, so the import was never added. **The check's population included the thing I
had just added**, which is the same error as a census counting its own fixture, and it produced a file
that typechecked as broken.

**2. The previous arm reported `Tests no tests`** (V-2089) because a quoted status value and an
apostrophe terminated the `it(` title string. Both were caught by `tsc -p tsconfig.test.json`, not by
the run — the run reported "no tests", which is not a failure and not a pass.

⭐ The generator now asserts `"'" not in title` before writing, and adds imports unconditionally with
an assert that they are absent first. **Both fixes are asserts, not care** — the third time this
session that converting an intention into a precondition is what actually worked.

### Running total

**6 of 11 closed** — `markEmailVerified`, `enqueueDelivery`, `resetDeliveryToPending`, `deleteDelivery`,
`countAllByStatus`, `setEgressCapabilityReport`. **5 remain**: `findAccountById`, `upsertSubscription`,
`touchWebSessionLastUsed`, `findByConfirmTokenHash`, `getDetail`, each with an existing host.

⭐ Every closure so far has found the same thing: what the method needed was not coverage but a
**property nobody had asserted against the database** — a first-transition claim, two write fences, an
enum-derived zero-fill, a jsonb round-trip. The coverage number located them; it was never the point.

Related: V-2089, V-2088 (the earlier closures), V-2077 (the claim this loop closes), V-2086 (the list).

---

## V-2091 — the Stripe event-recency guard, and a one-character boundary now pinned by execution (2026-08-28)

Seventh of the eleven, and the richest. `upsertSubscription` is not a plain upsert: it carries an
**event-recency guard**, because Stripe re-delivers failed events for up to three days with no ordering
guarantee.

    target:   subscriptions.stripeSubscriptionId
    setWhere: `${subscriptions.updatedAt} <= excluded.updated_at`
    returns:  { applied: result.length > 0 }

A stale event matches the conflict target but fails the WHERE, so Postgres writes nothing,
`.returning()` yields no row, and `applied` is false. **Callers gate the tier mutation on that
boolean** — so a guard that stopped biting lets a re-delivered event move a customer's tier.

⭐⭐ **And `<=` rather than `<` is deliberate**: `event.created` is second-granularity, so two genuinely
ordered events (a `created` immediately followed by an `updated`) can share a second and must both
apply. That is a one-character boundary, and **no source-text pin can check which way it points** — it
only shows the operator is written.

**The arm** (in `db-stripe-event-idempotency-drizzle.test.ts`, whose subject this exactly is): fresh
insert applies → a NEWER event applies, updates in place, and leaves **one** row not two → a STRICTLY
OLDER event returns `applied: false` and the tier does not move → an **EQUAL-time** event still applies.

**Proof — two mutations, each redding its own assertion:**

    setWhere removed        → "a stale re-delivered event must NOT apply" reds
    <= changed to <         → "an equal-time event must still apply - the guard uses <= not <" reds

Each reds exactly one arm, they red DIFFERENT ones, and source was restored byte-identical from a
path-keyed snapshot both times. That is the difference between an arm that executes a method and an
arm that pins a boundary.

### ⛔ The indentation trap, fourth time, and the fix that finally holds

The first attempt aborted on `assert t.count(cleanup) == 1` → 0. I had typed a six-space anchor read
from terminal output carrying a `sed 's/^/  /'` display prefix; the file uses four. **Nothing was
written, because every assert runs before the single write** — that structure is why four
indentation mistakes this session have cost retries instead of broken files.

⭐ The fix is not care, it is derivation: the anchor is now found with
`re.search(r'^([ \t]*)await client\.end\(\{ timeout: 5 \}\);$', t, re.M)` and its indentation
taken from the match. **Never type whitespace you read from a pager.**

### Running total

**7 of 11 closed.** Remaining: `findAccountById`, `touchWebSessionLastUsed`, `findByConfirmTokenHash`,
`getDetail` — the four thinnest, all plain by-id or by-hash reads. ⭐ `findByConfirmTokenHash` is the
one still worth real care: `status_subscribers` holds **two** token-hash columns
(`confirm_token_hash`, `unsubscribe_token_hash`) with a lookup each, so cross-kind isolation — a
confirm token must not resolve an unsubscribe lookup — is a genuine security property and the natural
arm.

Related: V-2090, V-2089, V-2088 (the earlier closures), V-2086 (the classified list).

---

## V-2092 — the eighth closure lands in a CONTRACT test, so it pins parity as well as execution (2026-08-28)

`findByConfirmTokenHash` and `findByUnsubscribeTokenHash` are two token-credential lookups against one
table holding **two** hash columns. Neither had executed a line of SQL, and neither was mentioned
anywhere in `status-subscriber-confirm-repo-contract.test.ts` — the file whose whole subject is confirm
tokens (0 mentions each).

⭐ **This one goes in a contract test**, unlike the previous seven: the arm runs against BOTH the
in-memory double and Drizzle, so it pins **parity** as well as execution. That was not available for
`markEmailVerified` (V-2088), where the auth contract's `inMemorySubject().account()` returns a bare
UUID without creating a row. Here `Subject.pending()` creates a real pending subscriber in both, so the
arm just works. **Both implementations pass** — no divergence.

**What it pins:** a positive control that a live pending row resolves by its confirm hash; an unknown
hash resolves nothing; after `markConfirmed` the spent confirm hash **no longer resolves** (the column
is nulled, so the link cannot replay); the unsubscribe token resolves through its own lookup; and —
the non-trivial one — **that same live unsubscribe hash must NOT resolve a CONFIRM lookup**. The
cross-kind check matters precisely because the unsubscribe hash IS stored, so a lookup matching the
wrong column would find it.

**Proof, and an honest overlap.** Pointing `findByConfirmTokenHash` at the unsubscribe column reds my
positive control (`expected undefined to be '<uuid>'`). Removing `confirmTokenHash: null` from
`markConfirmed` reds **two** arms — mine and an existing contract arm, _"the same confirmation link was
accepted twice"_. ⚠️ **So single-use was already guarded**, through `markConfirmed` refusing a second
call. My arm adds a different observable — the spent hash no longer RESOLVES — which overlaps rather
than duplicates, and I would rather say so than present the mutation as proof of new coverage it does
not provide.

### ⛔ Two aborts, both caught by asserts rather than by review

**1. The arm landed outside the contract function.** My anchor was "the last `it(` in the file", and
the last one lives outside `statusSubscriberContract`, in a scope with no `make` or `enabled`. tsc said
`Cannot find name 'enabled'`, and the run showed 1 of 18 failing — **which looked exactly like an
implementation divergence.** It was my arm failing to compile. Re-anchored on the last arm whose body
calls `enabled()`, which is provably inside the contract.

**2. `confirmTokenHash: null` occurs TWICE** — `markConfirmed` and `purgeEmails`. The mutation refused
on `assert t.count(...) == 1` rather than silently editing the wrong method, and the fix was to scope
the replacement to `markConfirmed`'s body. That is the V-2078 rule paying out again: **count a literal
before building on it.**

### Running total

**8 of 11 closed.** Remaining: `findAccountById`, `touchWebSessionLastUsed`, `getDetail` — all three
plain by-id reads with no fence, no guard and no boundary, which is why they are last: for these,
execution genuinely is the whole property, and an arm would assert little beyond "the row comes back".

Related: V-2091, V-2090, V-2089, V-2088 (the closures), V-2086 (the list), V-1209 (the divergence class
this contract format exists to catch).

---

## V-2093 — stopping at 8 of 11, because the last three would be checkbox arms (2026-08-28)

V-2092 asserted the remaining three — `findAccountById`, `touchWebSessionLastUsed`, `getDetail` — were
"thin". That was a judgement, so I measured it before acting on it.

**All three are `select().from(X).where(eq(id)).limit(1)` with no fence, no boundary and no
compare-and-swap** — the shape every earlier closure had something to say about and these do not. The
one thing a by-id read still does is run a row MAPPER, and a mis-mapped or swapped column is exactly
the kind of defect a source-text pin cannot see. So the question was whether the mappers were already
exercised.

**Measured against `apps/server/coverage/coverage-final.json`** — an artifact produced BEFORE my eight
new arms, so it can only under-state coverage:

    auth-flows-repo.ts   toAccountRow   executed 16 times
    fleet-nodes-repo.ts  rowToDetail    executed 99 times

`toAccountRow` has 5 call sites and `rowToDetail` 6; the siblings already drive both. **So an arm on
these three would assert that a row comes back, against a mapper run ninety-nine times, through the
simplest expression drizzle can produce.** That is a number going from 8 to 11 and nothing else.

⭐ **Not closing them, and this is the same call as `findSessionUnscoped` in V-2086** — where the
highest-looking target on the raw list turned out to be a deliberate escape hatch whose SQL never
running was correct. Both times the discipline was the same: **the list was a starting point, and the
last items on it earn a reason, not an arm.**

### What the eight closures actually bought, stated plainly

Not coverage. Every one landed on a property nobody had asserted against the database:

    markEmailVerified          a CAS first-transition: the second caller must LOSE and not move the timestamp
    resetDeliveryToPending     refuses an in_flight row - a live worker owns it
    deleteDelivery             matches id AND dlq, so a concurrent requeue cannot destroy a live delivery
    enqueueDelivery            returns the DB-generated id; the row lands pending
    countAllByStatus           the zero-fill covers EVERY enum member, not just statuses with rows
    setEgressCapabilityReport  two jsonb columns round-trip as objects, not double-encoded strings
    upsertSubscription         a stale Stripe event is rejected, and <= not < at the equal-second boundary
    findBy*TokenHash           a spent confirm link stops resolving; an unsubscribe hash never resolves a confirm lookup

⭐ **Seven of the eight are refusals** — a WHERE clause whose entire job is to say no. A content-parity
pin proves the refusal is written; only execution proves the database performs it. That is the whole
content of V-2087, demonstrated eight times rather than argued once.

⚠️ Boundary, in the same sentence as the result: the coverage figures above are from a run of
`tests/integration` alone with `DATABASE_URL` set, so they measure execution by that suite and not by
the unit suite or e2e.

Related: V-2086 (the classified list), V-2087 (why text pins are shape assertions), V-2088 through
V-2092 (the closures).

---

## V-2094 — a superseded repo method sits beside its safer replacement with nothing stopping a caller (2026-08-28)

After V-2093 closed the never-executed work, I asked the systematic version of what those eight arms
kept finding: **seven of eight pinned a REFUSAL, so how many refusals does the db layer have, and are
they exercised?**

**Census: 130 write statements under `apps/server/src/db`, of which 44 carry a compound WHERE** — an
`and(...)` combining more than the primary key, i.e. a fence. Boundary in the same sentence: the
pattern requires the WHERE to begin `and(` with more than one predicate, so a fence expressed in raw
`sql` or across a longer chain would not be counted.

Intersected with coverage: **40 of the 44 already execute, 3 were closed by my arms this session, and
exactly ONE has never run** — `team-members-repo.removeMember`, whose fence is
`and(eq(id), eq(ownerAccountId))`, i.e. owner-scoped team-membership removal.

### It has never run because nothing calls it, and that is the finding

`removeMember` was **superseded on 2026-07-10** by `removeMemberWithInvites`, which does the same
owner-scoped DELETE _inside a transaction_ that also cancels the removed member's outstanding invites
— closing a membership-resurrection race where an `acceptInvite` that read the invite before the
removal could slip its upsert in between — and, per V-726, revokes every live key that member minted
on the owner's account. The service calls only the replacement. The original was left in place: **on
the repo interface, implemented by the in-memory double, fully typed, and reachable by anyone reaching
for the obvious shorter name.**

⭐ **This is the third instance of one pattern**, and the asymmetry is the point:

    findSessionUnscoped   superseded by atomic admin primitives   ✅ GUARDED at zero callers
    consumeAuthToken      superseded by consumeAuthTokenFamily    ❌ nothing
    removeMember          superseded by removeMemberWithInvites   ❌ nothing

The first is pinned by `unscoped-finders-admin-only-sweep`, so a new invocation fails loudly. The
other two are not, and **calling either looks entirely correct at the call site** — both do a real,
owner-scoped write; they just do less than the method that replaced them.

### The guard, and how it was itself caught by the hazard it describes

New `a-superseded-repo-method-keeps-zero-callers.test.ts`: a roster of (weak, strong, file), a
zero-callers assertion over `apps/server/src`, a non-vacuity control requiring the REPLACEMENT to be
found by the same matcher, and a rot arm requiring both halves of each pair to still exist — because
an entry whose strong method vanished means the supersession was undone, and the rule would then be
enforcing the wrong thing.

⛔ **First run: one offender — `routes/team.ts` calling `service.removeMember(...)`.** That is the
SERVICE's method, which happens to share the name. **A guard written to catch a shared-name hazard was
defeated by a shared name.** Fixed with a narrow, named exclusion of service receivers, plus a control
that a repo call through any spelling this codebase uses (`repo.`, `this.repo.`, `this.deps.repo.`,
`…Repo.`) still reads as a call — otherwise the exclusion could silently swallow the thing being
guarded.

⭐ It scans through the repo's shared `codeOnly` helper rather than raw text, so a commented-out call
is not a call. **Proved as a pair:** switching the service to `this.repo.removeMember(` reds two arms;
adding the same call as a COMMENT reds nothing. Service restored byte-identical.

⚠️ **Deletion is the better remedy and is not mine to make.** `removeMember` is on the
`TeamMembersRepo` interface and implemented by the double, so removing it touches three files and a
published-ish contract — and `findSessionUnscoped` shows this repo sometimes retains such a method
deliberately. The guard makes the hazard loud without taking that decision.

### Suite

Full run **with `DATABASE_URL`** so every arm from V-2088–V-2092 actually executed:
**3249 files passed, 32296 tests passed, 16 skipped**, 192s. Ratchets 3072→3073 / 3249→3250 for the
file added here.

Related: V-2093 (the refusal observation this generalises), V-2086 (where I excluded `removeMember` for
lack of a repo-receiver call — correctly, and it turned out to be superseded), V-2065 (`consumeAuthToken`).

---

## V-2095 — the superseded-method pattern swept systematically: two more confirmed, four left as candidates (2026-08-28)

V-2094 found `removeMember` by accident, as the one unexecuted fence in a census. Three instances of
one pattern is enough to sweep for it deliberately.

**Candidate generator, stated as a heuristic rather than a finding:** methods declared in the same
file where one name PREFIXES another (`removeMember` / `removeMemberWithInvites`). **127 such pairs in
`apps/server/src`; 23 where the short name has zero dot-invocations anywhere in src.** Deduplicated
across the repo file and its service-interface twin, that is 10 distinct pairs.

⛔ **Prefix is not supersession, and most of the 23 are not.** `countActive` / `countActiveForProfile`
are different queries. `introspect` / `introspectForClient` are different OAuth surfaces. `findApiKey`
/ `findApiKeyUnscoped` is the pattern REVERSED — there the longer name is the weaker one, and it is
already guarded. The heuristic generated candidates; reading decided them.

### Two confirmed, by the replacement's own comment

    sessions-repo   insertSession   -> insertSessionIfUnderLimit
    webhooks-repo   insertEndpoint  -> insertEndpointIfUnderLimit

Both replacements name the superseded method themselves: _"closes the count-then-insert TOCTOU … a
bare countActiveSessions + **insertSession** lets N concurrent creates all pass a stale count and
exceed the tier cap"_, and the same for endpoints. The bare inserts do no counting and take no lock,
so a production caller reaching for the shorter name reopens a race that **two browser tabs are enough
to hit**. Roster extended 2 → 4.

⭐ **Complementary to `every-tier-cap-has-an-atomic-backstop`, not a duplicate.** That guard asserts
the SAFE method is reached by every file consulting a tier limit; this one asserts the WEAK method is
not called at all. A file can satisfy the first — it calls the conditional insert somewhere — while
also calling the bare insert elsewhere, and nothing there would notice. Verified it never names
`insertSession` or `insertEndpoint`.

### Four left OUT, with the reason

`appendTranscript`, `setGuiControlKey`, `setMode`, `setAccountTier` are all callerless in src and all
prefix-paired with a conditional variant — but **no comment states a supersession**, so adding them
would be my inference dressed as the repo's. Recorded as candidates. (`setGuiControlKey` also appeared
in V-2086's "no dot-invocation in src" group, so two independent measurements agree it is callerless.)

⚠️ **A discriminator I expected to work and does not:** test-call counts. `insertSession` has 21 test
calls and `removeMember` 4, but both have zero src calls — tests use the bare insert to SEED fixtures,
which is legitimate. The scope split is what resolves it, and the guard already had it: it scans
`apps/server/src` only, because a test may call the weaker method to prove it still behaves and
production may not.

**Proof.** Switching `services/sessions.ts` from `insertSessionIfUnderLimit` to `insertSession` — the
exact TOCTOU regression — reds the zero-callers arm AND the non-vacuity control (the replacement loses
its only caller, which is that control working). Service restored byte-identical.

⭐ **One flaw the extension introduced, and it is the shape I have spent the session finding.** Arm 2's
title enumerated what the original two pairs cost — "the invite cancellation and key revocation on
removal, or the sibling-token claim on consume" — so growing the roster to four made the title describe
half of it. Rewritten to defer to the header and the failure message, which names the offending pair,
so it cannot go stale as the roster grows. **A guard's prose is subject to exactly the rot the guard
exists to prevent.**

Related: V-2094 (the pattern and the guard), V-2086 (the callerless group this corroborates).

---

## V-2096 — a deletion was verified at the deleted thing, never at the four artifacts pointing to it (2026-08-28)

Started from a technique my own notes say is the only one still paying here: ranking instruments
("files no test names", "files the log never mentions") are exhausted — seven of them, 253+ hits, zero
defects — so instead ask what a FILE claims about itself and check the claim. **39 universal claims in
comments across 32 files in `apps/server/src`** (comment lines only; a claim in a doc or a `.mjs`
script is outside this boundary). The one that broke: `services/sessions.ts` — _"Every method takes an
AccountContext and enforces account-scoped ownership."_

Three of its seventeen public methods take no `AccountContext`. Two are fine and the reading says why:
`autoDestroyExpired` is called only by the duration sweeper over sessions it listed itself, and
`destroyAllForAccount` only by the staff suspend/reclaim path. **The third, `findOwnedSessionLite`, has
zero callers anywhere — no source, no test.**

### What it was, and what happened to it

`97785484b` built it as the ownership seam for the V-531.B route `/v1/sessions/:id/livekit-token`.
`58a0a2521` **deleted that route** — owner-greenlit, because a customer could mint a _publisher_ token.
That commit removed the seam's only call site, an `isSessionOwned` adapter in `app.ts`. The seam stayed.

⭐ **The deletion was verified, and verified well — at the wrong population.** A prior pass (memory
note, 2026-08-27) confirmed at HEAD that the route file is gone, the path is registered nowhere, and
`app.ts` records the removal at the old registration site. All true. Nothing asked what still POINTED
at the route. Four artifacts did:

| artifact                               | what it claimed                                    | kind                                    |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------- |
| `lib/bootstrap.ts` comment             | the route's ownership check uses this seam         | source comment                          |
| `docs/runbooks/livekit-go-live.md`     | same, plus "publisher/subscriber role mapping"     | **operator runbook, `[x]`**             |
| `services-sessions-content-parity` pin | freezes the dead method's body AND its doc comment | guard                                   |
| `lib/bootstrap.ts` metric HELP string  | see below                                          | **runtime string served at `/metrics`** |

The surviving route is a different surface over a different subject — agent sessions, not browser
session records — and its check is not merely fine but _better_ than the prose described: it uses
`callerCanAccessAgentSession`, the canonical helper its four sibling routes share, and its comment
explains that raw owner-equality wrongly 404'd a legitimate team admin. **The code was sound the whole
time. Only the things describing it were false.**

### ⛔⛔ The stale prose was hiding the dead method from my own census

Building a caller census, I got a _known-positive control failure_: the detector did not find
`findOwnedSessionLite`. Cause — the bootstrap comment wrapped the name so that a dot-qualified receiver
was followed by an open paren, and a census matching a dotted call **counted the comment as a call
site**. Prose that names a symbol joins the population every name-based instrument measures, so such a
census must strip comments (`tests/unit/_helpers/code-only.ts`). Then I re-created the same hazard in
my own retraction by quoting the offending spelling verbatim — the standing rule is that a retraction
PARAPHRASES and only a sentinel QUOTES, and I broke it while documenting it. Now paraphrased, and both
the raw and comment-stripped counts agree at zero.

Census, with control passing: **164 methods named in an `async X\(` pin regex across 868 parity files;
9 have zero callers** in the comment-stripped source of all 15 source roots. Read all nine. `refresh`
is a matcher artifact (called bare after destructuring, and gui-client is a peer's scope);
`consumeAuthToken` is V-2094's roster entry, callerless by design. Two looked like the dangerous
inverse — a SAFE variant nobody calls — and **both resolve in the safe direction, checked at the
production call sites rather than assumed**: transcripts go through `appendTranscriptIfAuthorityRevision`
(7 sites, the strongest of a three-level chain) and invites through `acceptInviteAtomic`.

### ⭐ The correction reached the doc and not the thing the doc describes

`bootstrap.ts` registers the mint counter with a HELP string — served to operators at `/metrics` —
saying it is _"Emitted by both /v1/sessions/:id/livekit-token (V-531.B) and /v1/agent-sessions/:id/…;
the role label discriminates publisher (legacy session-livekit surface) from subscriber."_ The only
bump site in the tree is the agent-sessions route, with `role: 'subscriber'` hardcoded. So one named
emitter does not exist and two of three advertised label values can never appear.

Meanwhile `apps/docs/src/pages/reference/metrics.md` **already says the right thing** — "the sole
token-mint path", and that the legacy publisher route "was removed". The customer-facing page was
corrected when the route died; the runtime string it describes was not. ⚠️ Severity checked rather than
assumed: **no alert rule matches `role="publisher"`**, so nothing is sitting green forever today — this
is observability accuracy, not a dead alert. Fixed the string and its `build-test-app.ts` mirror
identically, in this commit. The compiled `dist/` copy is stale until the next build.

### A guard defect found by using it, with a measured blind spot

Documenting the deletion in the runbook turned V-756 red: **every `/v1/*` path in an operator doc must
resolve to a registered route** — so naming a deleted path is forbidden, and a truthful deletion notice
is unwriteable. Its per-occurrence context check had two defects:

1. **Unanchored vocabulary.** `no` matched inside `none`, `not`, `note`, `non-launch`, `NOWPayments`.
   Measured over its own 26 docs and 163 path occurrences: the live form exempted **40 (24%)**, a
   word-anchored form exempts **16 (9%)** — **24 occurrences, 15% of the population, exempt by
   accident.** Worst case is the common one: an endpoint table with `none` in its auth column exempts
   every path in that table, and an endpoint reference table is where a stale path both hides best and
   hurts most.
2. **No way to say "deleted".** It could say "was never built" but not "existed and was removed".

Both fixed in one regex. ⚠️ Stated plainly: anchoring surfaced **no** new stale paths — all 24 resolve —
so this is preventive, and what it buys is that those 24 are now actually checked.

**Two-sided proof.** Two probes planted in a `none`-bearing table, one deliberately ordinary-looking
(`/v1/status/uptime`) and one obvious: the anchored guard names **both**; the old unanchored regex, with
the runbook held at HEAD so the regex is the only variable, is **green 3/3 — blind to both**. First
attempt at that arm was confounded (the old regex also re-flagged my own retraction) and my output
filter hid it; re-run isolated. All files restored byte-identical from snapshots.

**Left for the owner, with evidence rather than a recommendation:** deleting `findOwnedSessionLite` and
its parity pin. Zero callers, zero test calls, its consumer removed by an owner-greenlit commit. ⛔ Note
the incentive the pin creates — deleting the dead method **reds a test**, so the guard prices removal as
expensive and retention as free. That is the inverse of what a guard should do.

⛔ **Correction, same day (see V-2097): the closing point above is not new, and the repo said it first.**
`unscoped-lookup-containment-invariant.test.ts` already states it in its header, about two other
methods: _"They are pinned by several content-parity guards, so they will not be removed … Nothing
would fail: the parity guards assert the method EXISTS, not that it stays out of customer reach."_
It then answers it structurally rather than by deleting. The observation stands and the framing as a
fresh insight does not — I found it after measuring instead of grepping the guards first, which is the
recurring error, not a new one.

Related: V-2094/V-2095 (the superseded-method family this census overlaps), V-756 (the guard fixed here),
V-2097 (the refutation that corrected this entry).

---

## V-2097 — refuted: the unscoped-access guards are keyed correctly, and my widening was wrong (2026-08-28)

V-2096's census left `setExpiresAt` (`api-keys-repo`) looking like a latent cross-tenant write: it
updates on `eq(apiKeys.id, id)` with no account predicate, has zero callers, and sits beside
`revokeApiKeyAtomic`, which carries an explicit nullable account scope. Two guards exist for this class
— `unscoped-finders-admin-only-sweep` and `unscoped-lookup-containment-invariant` — and **both key on
the NAME suffix `*Unscoped`**, which `setExpiresAt` does not carry. That reads like the familiar defect:
a guard keyed more narrowly than the property it claims.

**It is not, and the measurement is what says so.** Widening the key from the naming convention to the
actual property — "a by-id predicate with no account predicate in the body" — over all 55 `db/*.ts`
files yields **73 methods: 55 writes and 18 reads** (brace-matched method bodies, comments stripped;
controls: `setExpiresAt` and `findSessionUnscoped` found, the scoped `findSession` correctly absent).

Almost all 73 are correct by design. `agent-sessions-repo.get`, `scheduled-jobs-repo.markComplete`,
`webhooks-repo.recordDelivered`, `admin-accounts-repo.setStatus` — the architecture checks ownership at
the ROUTE and then acts by id, and a scheduled job or a delivery row has no owning account at all. **A
73-item list where ~70 are by design is not a finding; it is the ranking-instrument failure mode again.**

⭐ **What the `*Unscoped` convention actually marks is not "lacks an account predicate" — it is "a
SCOPED SIBLING EXISTS and this one deliberately skips it."** `findApiKey`/`findApiKeyUnscoped` and
`findSession`/`findSessionUnscoped` are pairs; picking the wrong half of a pair by autocomplete is the
specific hazard, and the name is exactly the right key for it. `setExpiresAt` has no scoped sibling, so
it is an ordinary by-id write like the other fifty, carrying the same caller-checks-ownership contract.
Its risk is that it is dead, not that it is unscoped.

**What I got wrong, recorded because the shape repeats:** I read a narrow key and inferred a gap before
measuring the wider population. The guard's key being narrower than a property I named does not make it
narrower than the property that matters — I have to state which property, then count. Here the count
refuted me in one pass.

⚠️ Also corrected V-2096 in place: its closing point about a parity pin pricing removal as expensive was
already written in `unscoped-lookup-containment-invariant`'s header, for two other methods, before I
derived it. Prior art found after the measurement instead of before it.

Nothing changed in source. Recorded so the next sweep does not re-open these 73.

---

## V-2098 — a delete-detector that reads prose, and the rot arm that makes it loud (2026-08-28)

Continuing the universal-claims sweep. `db/scheduled-jobs-repo.ts` claims _"every settle is fenced on
`locked_by = workerId`"_. **It holds**: `markComplete`, `markRetry` and `markFailed` all carry
`eq(scheduledJobs.lockedBy, workerId)`; the fourth write, `pruneFinished`, is a prune and not a settle.

⛔ **Getting there needed three passes at my own instrument, and the first two lied.** Counting writes
with a Drizzle-only matcher (`.update(`/`.delete(`) missed every raw-SQL statement — including
`claimDue`'s own `UPDATE scheduled_jobs`, which is the file's central write. Fixing that produced a
worse list: `\bUPDATE\b` matched `FOR UPDATE` (a SELECT row-lock, not a mutation), and non-greedy
backtick pairing mis-aligned across comments containing backticks. Then `UPDATE without`,
`UPDATE lost`, `UPDATE returned` — English inside _error-message strings_, matched only because the
regex was case-insensitive; real SQL here is uppercase. **The known-positive control failed at every
stage and is the only reason I noticed.**

**Settled measurement, boundary stated:** in the 55 files of `apps/server/src/db`, comments and SQL
`--` comments stripped, case-sensitive, `FOR UPDATE`/`DO UPDATE` excluded — **11 raw-SQL mutating
statements**, 5 `UPDATE` and 6 `DELETE FROM`, on `account_proxies`, `agent_sessions`,
`agent_turn_receipts`, `profile_snapshots`, `profiles`, `recipes`, `session_operations`, `sessions`,
`api_keys`, `scheduled_jobs`, `webhook_deliveries`. **Any census of "every write in the db layer" built
on Drizzle call syntax alone is missing these eleven.**

### The guard that already knew, and the one gap in it

`a-cascade-from-a-row-nobody-deletes-is-not-a-bound` maintains the roster of tables whose only removal
path is a cascade from a parent nobody deletes. I expected it to be Drizzle-only and it is not — it
matches `DELETE FROM` too, and none of the six raw-SQL-deleted tables appear in its roster, which is
correct. Hypothesis refuted by reading the detector.

⚠️ **What it does not do is strip comments**, and both its patterns need it. The raw-SQL matcher is
case-INSENSITIVE, so ordinary prose parses as SQL. Measured across the same 55 files: **one phantom
today** — `schema.ts:1983`, _"Cascade-delete from either side so…"_, capturing a table named `either`.
Harmless only because nothing is called that.

Direction matters: a phantom names a table → the table enters `direct` → `cascadeOnly()` skips it → it
leaves the roster. The negative-sentinel arm has the mirror problem: a future comment explaining _why_
accounts are never row-deleted would quote `DELETE FROM accounts` and fail the arm asserting nothing
does.

⭐⭐ **The rot arm contains it, and that is the finding worth keeping.** Because this guard asserts
BOTH directions — no unrecorded cascade-only table, and no recorded table that has stopped being
cascade-only — a phantom cannot shrink the roster quietly. Proven, not argued: planting the ordinary
sentence _"Revocation is an UPDATE, not a delete from web_sessions -- the row stays."_ into
`auth-flows-repo.ts` leaves the fixed guard **green 8/8**, and with only the two reads reverted to raw
text it goes **red**: `recorded table(s) that are no longer cascade-only: expected [ 'web_sessions' ]`.
Both files restored byte-identical. **So this was a fragility, not a defect** — the third arm my notes
keep calling "the one usually missing" is present here and is doing exactly the job it exists for.

Hardened anyway: both reads now use the shared `codeOnly`. A red traced back to a sentence costs a
reader an hour, and the fix is one import. `it(` count unchanged at 8.

⚠️ **The meta-guard cannot see this class.** `no-guard-strips-comments-by-hand` (V-1258) polices _how_
a guard strips — forbidding hand-rolled regexes in favour of the shared helper — and says so in its own
header: a guard that deliberately does not strip "is not a violation at all". A guard that strips
nothing is therefore invisible to it. That is a correct scope, not a bug in the meta-guard, but it
means "does this guard need stripping?" stays a human question.

Related: V-2096 (prose satisfying a structural pattern, in the false-negative direction), V-2097.

---

## V-2099 — a `);` inside a help string disarmed the metric-cardinality guard, and the pin froze the undercount (2026-08-28)

Full suite after four commits: **3250 files, 32315 tests, 3 failed, 195s** (DATABASE_URL + REDIS_URL
from `.env`, so integration files execute rather than skip).

Two failures are environmental and not code: `parked-pair-mode-survives-a-restart` and
`production-bootstrap-arms-every-chain` both die on _"Webhook signing secrets: stored data could not be
decrypted with the configured MFA_ENCRYPTION_KEY."_ My run pointed at the dev database, whose stored
secrets were encrypted under a different key. ⚠️ Not connectivity — zero `ECONNREFUSED` in the log;
these two are the ones hardened by `80a422ee1` ("18 integration files reported PASSED against a dead
service") to fail loudly instead of vacuously, and they did their job.

The third was mine, and it inverted on inspection.

### The pin was right to go red, and wrong about why

`metrics-label-cardinality-cross-source-invariant` pins the distinct label keys in use. It went from 16
to 17, the new key being `role`. I had changed a metric HELP string in V-2096, so my first read was that
I had introduced a label. I had not.

The extractor was `/register(?:Counter|Gauge|Histogram)\s*\((.*?)\);/gs` — **non-greedy, stopping at
the first `);`**. The old help text ended a clause with `…/v1/agent-sessions/:id/livekit-token (LK.3);`.
That `)` and `;` sit **inside a string literal**, and the regex cannot tell. So the captured body ended
before the label array, `TRAILING_ARRAY` matched nothing, and that registration contributed **zero**
keys. Verified against both revisions: at `0c74605fb^` the site extracts `[]`; at HEAD it extracts
`['role', 'outcome']`. **My edit did not break the guard — it removed the `);` and thereby revealed
what the guard had never been able to see.** The recorded list of 16 was a pin frozen around an
extraction bug, which reads exactly like a pin frozen around a fact.

⛔⛔ **The consequence is not a wrong number.** Those keys were invisible to the CRITICAL arm as well —
the one that forbids identifier-shaped labels because the registry keys each series by its label VALUES
in a never-evicted Map, so a `session_id` label costs one entry per session for the life of the process.
**Any counter whose help text contained a `);` could have registered `['session_id']` and passed.**

**Proved two-sided, on the real subject.** Planting `session_id` into a real registration whose help
string carries a `);`: with the old regex the CRITICAL arm reports **`✓` — passed while the offending
label was registered**; with the balanced extractor it fails naming
`session_id (src/lib/bootstrap.ts)`. Restored byte-identical.

⭐ **Neither anti-vacuity floor could catch this, and the reason generalises.** They floor the number of
SITES found (≥18) and DISTINCT KEYS (≥12). Truncation reduces neither: 21 sites still matched, 16 keys
still cleared the floor, and the one site that mattered contributed nothing. **Floor the EXTRACTION, not
just the discovery** — a parser that finds things and extracts nothing from them satisfies every
discovery floor ever written.

### Fixes

1. The extractor now balances parens while skipping string literals, so prose in a help string cannot
   truncate a call. Boundary: **22 registration sites** under `apps/server/src` (`metrics-registry.ts`
   excluded, as the guard already does), of which exactly one is legitimately label-less.
2. `role` added to the recorded list, 16 → 17.
3. A new arm: every registration yields at least one label key, or is recorded in `LABELLESS_METRICS`
   with the rot check that an entry gaining labels must leave. `it(` 3 → 4, deliberately.

⛔ **The new arm's first version was vacuous, and the mutation caught what review did not.** I keyed the
exemption by FILE — `{ metric: 'unhandledRejectionTotal', file: 'src/lib/bootstrap.ts' }` — and the one
deliberately label-less counter lives in `bootstrap.ts`, so the exemption covered **every registration
in that file, 12 of the 22**. Deleting a real label array left the arm green. Re-keyed to the metric
identifier; the same mutation now fails naming `METRIC_NAMES.livekitTokenMintTotal`. This is
[an exemption keyed by filename] one more time, written by me, in the arm whose whole job was to close a
blind spot — the third instance this session of prose or a coarse key defeating a structural check.

Related: V-2096 (prose satisfying a structural pattern, same class), V-2098 (comments parsed as SQL).

---

## V-2100 — sweeping the shape from V-2099, and a magic-number floor that cannot see the gap that matters (2026-08-28)

V-2099 fixed one regex that ended a call capture at `);` and was truncated by prose inside a string
argument. The standing rule is to sweep the SHAPE, not the token, so I did.

⛔ **First attempt was the ranking-instrument failure again: 396 hits across `apps/server/tests`, and
almost all correct by design.** Content-parity pins routinely match a SPAN between two anchors with
`[\s\S]*?`, which is a different use — a truncated span makes an assertion FAIL, loudly, rather than
silently yielding wrong data. The defect needs two properties together: the capture must BE the
parenthesised argument list, and the result must be **parsed further as data** rather than merely
asserted to exist.

**Narrowed sweep, boundary stated: 3097 files across `apps/server/tests`, `apps/server/src`, `packages`
and `scripts`; regex literals whose capture group is exactly the argument list, closed by an escaped
`)`. Two hits.** Control first: the detector finds the pre-fix V-2099 regex in the version at
`d26d60793~1`.

One hit is the old pattern quoted inside the explanatory comment I wrote in V-2099 — prose, not live
code. ⚠️ Worth noting anyway: documenting a pattern reproduces it into every sweep for that pattern,
which is the same reason a retraction paraphrases rather than quotes. It is inert here only because the
sweep is mine and reads the comment as text.

### The live hit: the chaos-scenario roster

`chaos-scenarios-restore-on-every-exit` derives its roster by parsing `SCENARIOS=(…)` out of
`scripts/chaos/run-all.sh` — deliberately, and its header says why: _"a guard that hardcoded its own
list would drift the same way the moment a scenario is added."_ The parse is
`/SCENARIOS=\(([\s\S]*?)\)/` and returns `[]` when it fails.

**No live defect.** The array holds five bare slugs with no parentheses, so nothing truncates it, and
an empty roster is caught: an arm asserts `SCENARIOS.length > 4`. Roster and disk agree exactly —
`01, 02, 03, 04, 06`, five files, five entries (`05` simply does not exist; the numbering skips it).

⭐ **But the floor is a magic number, and a magic number cannot see the gap that matters.** A scenario
script ADDED to `scripts/chaos` and never added to `run-all.sh` is executed by **neither the chaos
suite nor this guard**, and a roster of five or six still clears a floor of four. The thing being
trusted is the roster's COMPLETENESS, so the assertion has to be the relationship the repo owns —
roster equals disk — not a count that happens to be right today. The count also degrades as the family
grows: at five entries the floor catches losing one; at ten it would not notice losing five.

Added that arm, with its own non-vacuity check (a `readdir` returning nothing would make the comparison
agree with an empty roster, which is precisely the failure being guarded).

**Proved two-sided, on the real subject rather than the guard's list.** Dropping an unrostered
`07-probe-scenario.sh` into `scripts/chaos`: the new arm fails naming it; the existing floor stays green
because the roster is still five and `5 > 4`. Probe removed, tree clean, 8/8 green. `it(` 3 → 4,
deliberately.

Related: V-2099 (the truncation this swept for), and the standing preference for asserting a
relationship over pinning a number.

---

## V-2101 — the consequential-action gate is enforced per class, not per interface (2026-08-28)

Checking another header claim: `services/agent-executor.ts` says _"Both real executors halt BEFORE
dispatching an unapproved consequential action (W443/W445)."_

**The claim holds, and understates itself — all THREE implementations gate, not two.** Boundary:
`apps/server/src`, classes matching `class X implements AgentExecutor`, comments stripped, bodies
brace-matched. `StubAgentExecutor`, `RealAgentExecutor` and `ControlPlaneAgentExecutor` each call the
shared `consequentialHalt`, and in the two that dispatch, the call precedes the first `await this.…`.
Verified by reading, then mechanically.

⭐ That header is also one of the better ones in the repo: it has been corrected twice in place, once
because it claimed both real executors halt on the first failing intent when only one does (V-1099), and
once because it described a stub-only slice after the real executor had shipped from the same file
(V-808). Both corrections sit at the paragraph a reader stops at rather than in a later section.

### What nothing covered

The gate turns a purchase, payment or account deletion the customer has not approved this run into a
halt BEFORE the dispatch. **Which executor runs is a deployment detail** — they are selected by
configuration, and the control-plane one says so itself: _"Identical gate to Stub/RealAgentExecutor:
the go-live swap must NOT silently drop it (a real box would otherwise execute the action for real)."_

Existing coverage is real but keyed on the members that exist: three behavioural test files, one per
CLASS, and a content-parity guard naming two FILE paths. **A fourth executor — a new transport, a new
file — is covered by neither, and nothing would fail.** That is the recurring shape: an invariant over
an interface, enforced once per implementation.

Added `every-agent-executor-gates-consequential-actions`, a source-shape guard. The reasoning for
preferring source shape over behaviour here is already written in
`every-intent-emission-goes-through-the-public-projection` and I am not restating it: such a guard
"has to fail for code that does not exist yet, which no runtime assertion can do".

Three arms: the scan finds exactly the three known classes with non-trivial bodies (floored in both
directions — an empty set satisfies every assertion below it, and a truncated brace-match would report
every class ungated); every implementation calls the shared gate; and in each implementation that
dispatches, the gate precedes the first dispatch, with a floor so that arm cannot go vacuous if the
dispatch idiom changes.

⚠️ **Scope stated rather than implied:** this asserts each implementation CALLS the shared gate before
dispatching. It cannot assert the gate is correct — `agent-consequential-action` owns that — nor catch
an executor that dispatches through a free function rather than a method.

⛔ Comments stripped, and it matters here: all three files discuss the gate at length in prose, and the
control-plane one names `consequentialHalt` in a comment four lines above where it calls it. A raw-text
scan would report a class as gated on the strength of a sentence describing the gate — the same failure
as V-2096, V-2098 and V-2099, now anticipated rather than discovered.

**Both arms mutation-proved separately, on the real subject rather than the guard's own list.**
Neutralising the gate in `RealAgentExecutor` reds the gate arm naming it; MOVING the gate to after the
dispatch — a change that reads almost identically in a diff and is worthless, since the purchase has
already happened — reds only the ordering arm. Restored byte-identical both times, with no peer suite
running during the window.

Ratchets 3073 → 3074 and 3250 → 3251 for the one file added.

---

## V-2102 — third pass of the ownership mutation sweep: two predicates asserted only by their own source text (2026-08-28)

V-2101 generalised to a question: which OTHER interfaces carry a safety step enforced once per
implementation? **19 interfaces have ≥2 implementations under `apps/server/src`** (comments stripped,
brace-matched bodies). Exactly one asymmetry — a guard-ish helper in some implementations but not all:
`Driver::requireSession`, present in `MockDriver` and `PlaywrightDriver`, absent in `WebKitDriver`.
**Refuted by reading:** `WebKitDriver` is a pure stub whose every method throws
`DriverNotIntegratedError`; it holds no session state, so the absence is correct.

⭐ 14 of the 19 are production/double pairs, and for those the invariant is agreement, not a guard.
The repo already knows this: **V-1197 traced eighteen db-layer defects to one cause** — unit tests
drive the in-memory double, so a property is proven in the double and unproven in the SQL that ships —
and V-1198 built the first contract test "as the template for the other twenty-eight". Measured now:
**45 interfaces with both an `InMemory*` and a `Drizzle*`/`Redis*` implementation, and 31 two-sided
contract tests.** The programme largely completed.

### The sweep, and what it actually found

Two repos sit outside every contract test AND outside both existing boundary sweeps: `recipes-repo`
(6 account predicates) and `agent-turn-receipts-repo` (2). Neutralised all 8 —
`eq(t.accountId, …)` → `eq(t.accountId, t.accountId)` — and ran the full suite. Peer notified first,
restore trapped, window ~4 minutes.

**Caught: 6 failing files against a 2-file environmental baseline.** But WHICH assertions caught it is
the finding:

- **`recipes` — behaviourally covered, three real-Postgres assertions fired:** `deleteById refuses to
delete` another account's row, `a recipe cannot be fetched by id from another account`, and
  `recipes are not listed to another account`. ⛔ I had inferred `db-repo-account-scoped-reads-boundary`
  covered only the three methods its header names. Wrong — **a header names what PROMPTED the file,
  not what it now covers**; that file has 11 tests and reaches recipes.
- **`agent-turn-receipts` — caught ONLY by `db-agent-turn-receipts-content-parity`, a TEXT pin.** No
  behavioural test failed. So the account scoping on `reserve`/`complete` was asserted by source text
  alone: a pin proves the predicate is WRITTEN, never that it holds against Postgres. That is exactly
  the distinction V-1197 was built on, surviving in the one repo the programme never reached.

⚠️ Severity stated rather than dramatised, and it is second-line: `(account_id, idempotency_key)` is
the table's composite PRIMARY KEY, so the predicate is half the row's identity — but `reserve` compares
session and request hash before returning a stored body, and that equality is what actually stops
disclosure. Unscoped `complete` yields a durable denial of the victim's idempotent turn (their row is
overwritten with ciphertext whose AAD names someone else, so their replay fails to decrypt), not a
disclosure. Defence in depth that nothing verified — the same posture the existing boundary file
already judged worth closing.

### ⛔ My first arm was vacuous, and mutation caught what review did not

The `complete` arm as first written varied account AND session AND hash together. `complete` matches on
**five** predicates — account, key, session, hash, state — so the refusal it observed came from the
session/hash mismatch and proved nothing about the account predicate it was named for. **It passed
under mutation.** Not a broken test: a test that would have been cited as proof of tenant isolation
while asserting something else, in the reassuring direction.

Rewritten to hold every field equal to the victim's except the account, which is the only construction
that attributes the refusal — at the cost of an unrealistic fixture (a real attacker would not know the
victim's session id), stated in the test. Both arms now fail under mutation:
`promise resolved "undefined" instead of rejecting`, and `expected 'mismatch' to be 'in-progress'`.
⚠️ The replay arm is honestly labelled as order-dependent: its unscoped read is a `limit(1)` with no
ORDER BY, so it catches the break only when the scan reaches the victim's row first.

Two fixture facts worth recording: `agent_turn_receipts_request_hash` CHECKs `^[0-9a-f]{64}$`, so a
readable label like `'victim-hash'` is rejected by Postgres — the constraint doing its job and the
fixture inventing a shape the column does not accept; and `complete` THROWS on a zero-row update rather
than returning silently, which the arm now asserts.

### The stale claim next to it

`recipes-repo.ts`'s header denied that any delete surface existed, citing the handoff that deferred one.
`DELETE /v1/recipes/:id` is registered, `write`-scoped, returns 204, and is **published in the OpenAPI
document**; `routes/recipes.ts` records the defer being pulled forward (V-530.I/.J). One file kept
recording a decision another file records as overturned.

⭐ The two findings are one blind spot: **a reader who believes there is no delete surface does not go
looking for the account scoping on it.** Corrected, and its content-parity pin — which had frozen the
false sentence and would have failed anyone who fixed it — now pins the corrected text plus a NEGATIVE
sentinel that the retracted claim cannot return. ⛔ The retraction is PARAPHRASED, not quoted: my first
draft quoted the stale sentence, which would have satisfied the new sentinel from inside the retraction
explaining it.

### Peer

A2 reported this red against their full gate and attributed it correctly before investigating — file
mtime stable, source repo unmodified, their own change confined to a gui-client test. Their diagnosis
sampled an arm I was mid-rewrite on. Two things of theirs I adopted: **verify a mutation restore against
GIT, not against your own snapshot** (`cmp` shares the mechanism that produced the snapshot; `git diff
--quiet` fails differently because HEAD is an artifact neither party produced during the operation) —
that is my own control rule, which I had been violating on every mutation this session; and their point
that a 5-file reproduction says little about interleaving at 397. Closed on their bar instead: the
rewritten arms green in a FULL run — **3251 files, 32326 tests, 2 failed**, both the environmental
`MFA_ENCRYPTION_KEY` mismatch against the dev database, zero failures in the new arms.

Related: V-1197/V-1198 (the programme this extends), V-2101 (the interface question that led here).

---

## V-2103 — V-993's db-layer coverage method does not reproduce as written, and three claims that hold (2026-08-28)

**The question.** V-2102 established that `agent-turn-receipts`' account scoping was asserted by source
text alone, found by mutating and running the full suite. That is the expensive way to learn something
an instrument reports for free: **a cold function's account predicate is unproven by definition.**
V-993 measured exactly this — 82.3% of statements in `apps/server/src/db`, 81 cold functions of 730 —
and V-994/V-995 closed items five and six of a list of 19 account-scoped `src/db` functions no
integration test executes. Re-running it at HEAD would give the current work-list directly.

⛔ **It does not reproduce. Five attempts, no coverage report for the db layer, and the variables are
worth recording so the next attempt does not repeat them:**

| attempt                                                                                                 | outcome                                                                                 |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| CLI `--coverage.include` + the config's `src/db` exclude                                                | empty file set — **V-993's own caveat, reproduced exactly**                             |
| CLI `--coverage.exclude` to replace the config array                                                    | does not replace it; still nothing                                                      |
| probe config OUTSIDE the repo                                                                           | `Cannot find module 'vitest/config'` — resolution is relative to the config's directory |
| probe config INSIDE the repo, exclusion absent                                                          | "Coverage enabled with v8", **no report written anywhere**                              |
| the real config edited, `reportsDirectory` outside then inside the repo, with and without a path filter | no report in any combination                                                            |

⚠️ **Stated as a boundary, not a verdict: I could not reproduce it. That is not proof the method is
broken for everyone** — coverage demonstrably works by another route. The peer session's
`verify-suite --all` produced `coverage/coverage-summary.json` at the same HEAD: **311 entries, 285
under `apps/server/src`, and 0 under `src/db`** — which independently confirms the exclusion is the
only thing between the gate and that directory, and that the collection machinery is fine. What is
established is narrower and still useful: **V-993's "Method, for whoever repeats it" paragraph is not
sufficient to repeat it**, and the next person should budget for that rather than assume a typo.

⭐ **Two guards caught the config edit, and the second is the interesting one.**
`workspace-vitest-config-content-parity` fired on the text, as expected. So did
`a-gate-that-does-not-name-its-blind-spot-reads-as-total` — which asserts the coverage gate NAMES its
blind spot, so DELETING the `src/db` exclusion made the gate's stated blind spot false and the guard
refused. A guard that fires when you silently WIDEN a gate's scope is the mirror of every "you
narrowed it" guard in this repo, and I had not seen one before. Both green again once restored; the
config verified identical to HEAD by `git diff --quiet`, and the peer's coverage artifact left
untouched (its mtime unchanged across all five runs).

### Three universal claims checked, all holding

Boundary: comment lines in `apps/server/src`, read at HEAD.

- `admin-accounts-repo` — _"zero-fill from AccountTierSchema.options so every tier is present (no
  hardcoded list to drift from the enum)"_. **Holds:** `emptyTierCounts` iterates
  `AccountTierSchema.options`, in both copies of the helper (`admin-accounts-repo`,
  `admin-billing-repo`). Duplicated, but both derive from the same schema so they cannot drift apart.
- `sessions-repo` — the same claim for statuses. **Holds:** `emptySessionStatusCounts` iterates
  `SessionStatusSchema.options`.
- `openapi.ts` S33 — _"Apart from page-state, every route returns a DISCRIMINATED 200 body in each
  relay case."_ **Holds** across the block's seven agent-session routes (lines 5401–5704): the cookie
  read + import pair, history, file upload, and the download list + fetch pair all carry
  `agentRelayStatus`; page-state is the stated exception.

⛔ **Both of my instruments were wrong first, in the two classic ways.** The route extractor anchored
with `index()` on a string that occurs FOUR times and started 5,200 lines early, returning
`/v1/sessions/*` routes and flagging all nine as violations — garbage, discarded. Re-anchored by LINE,
it then over-reached with a fixed 700-line window and flagged `livekit-token` and `recipe-suggestion`,
which belong to the "LK arc" section beginning at 5705. **The claim's own text enumerates its seven
endpoints; reading that is what bounded the window correctly.** A count that disagrees with the prose
beside it is the instrument, not the finding.

⛔ **RETRACTED THE SAME NIGHT — see V-2104. The method works; the tree was the problem.** A single
FAILING TEST anywhere in the run suppresses the entire coverage report, and every one of the five
attempts above carried two environmental failures. The line "`--coverage.exclude` does not replace the
config array" is simply WRONG — it does replace it. I varied the METHOD five times and never varied
the TREE, which is the error worth keeping from this entry; the rest of it is superseded.

No source change. Recorded so the cold-function work-list stays an open thread with its blockers named
rather than a measurement someone assumes was taken.

---

## V-2104 — the db layer measured at last: 708/739 functions, 31 cold — and why V-2103 was wrong (2026-08-28)

**708/739 functions (95.8%), 2276/2569 statements (88.59%), 31 cold, across 64 files under
`apps/server/src/db`** — from an all-green 397-file / 3865-test integration run against a disposable
database. Independently reproduced: the peer session got the identical 708/739 and 31 on a different
database, which is what makes it a measurement rather than one machine's opinion.

### ⛔ V-2103 was wrong, and the shape of the error is the lesson

That entry reported the method as non-reproducing after five attempts. **The method works.** Two
compounding causes, neither of them the method:

1. **A single failing test suppresses the entire coverage report.** Isolated three ways on one file
   each: a PASSING db file → report written; a FAILING file → no report; both together → no report.
   Every one of my five attempts included two environmental failures, so none could ever have produced
   a report regardless of flags. ⚠️ Note a _zero-test_ run ("No test files found", exit 1) DOES write
   a report — so a non-zero exit is not the trigger; a failed test is.
2. **I ran against the wrong database.** V-993's method names `driftstack_cov_dblayer`, a disposable
   database it left in place. I used the dev database, whose stored webhook secrets are encrypted
   under a different `MFA_ENCRYPTION_KEY`. **The method note contained the answer and I read past it.**

⭐⭐ **I varied the METHOD five times and never varied the TREE.** CLI flags, probe configs inside and
outside the repo, report directories, path filters — five variations of the instrument, zero of the
environment, while the environment was the whole problem. The peer succeeded not because their flags
differed (their exact invocation also produced nothing on my machine) but because their database was
clean. **When a documented procedure fails, vary the state before varying the procedure.**

⚠️ And the specific retraction: _"`--coverage.exclude` does not replace the config array"_ is false. It
does. That claim came from a run that could not have written a report for an unrelated reason, and I
attributed the silence to the nearest thing I had changed.

Getting to green took: migrating the disposable database (115 migrations — it was current as of V-993
on 2026-08-19 and had rotted since, failing `shared-database-is-migrated`), then clearing a leftover
`account_mfa` row whose legacy secret failed a canonical-base64 decode at boot. Both are stale state in
a throwaway database, not defects.

### The 31, triaged

| class                           | count | detail                                                                                             |
| ------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| CLI entrypoints                 | 7     | `migrate.ts` (4), `seed.ts` (2), `seed-target-guard` — not test targets                            |
| cold BY DESIGN, already guarded | 3     | `findSessionUnscoped` (containment guard), `removeMember` (V-2094 roster), `setExpiresAt` (V-2097) |
| `account-proxies-repo`          | 9     | the peer reports 7 are its in-memory double rather than a gap                                      |
| remaining                       | 12    | the residual worth reading                                                                         |

⭐ **A convergence worth recording.** `agent-sessions-repo.setGuiControlKey` and `.setPairModeState` are
both cold, and both are prefix-paired with conditional siblings that carry production's only callers
(`setGuiControlKeyIfActive` 1 src caller, `compareAndSetPairModeState` 3; the bare pair have **0** src
callers each). V-2095's prefix sweep flagged `setGuiControlKey` as a candidate and DEFERRED it for want
of a stated supersession. It stays deferred under that rule — neither sibling's comment states one —
but the candidate is now supported by **two independent instruments** (a static caller census and
execution against Postgres) instead of one grep. That is a stronger place to leave it than either
instrument alone.

⚠️ Boundary, because the number invites over-reading: 95.8% of db-layer FUNCTIONS are executed by the
integration suite — executed, not asserted. A function can run inside a test that never checks what it
did, which is exactly the `agent-turn-receipts` case in V-2102: warm, and its account predicate still
provable only by mutation. **Coverage bounds the cold set; it says nothing about the warm one.**

No source change. The residual 12 are the next work-list, and unlike an hour ago it is a measured one.

---

## V-2105 — the web-session last-used write: pinned as text, stubbed to a no-op, never executed (2026-08-28)

Working V-2104's residual twelve. ⛔ **First count was unreliable and the reason is a standing trap:**
`upsert`, `getById`, `listAll` and `findAccountById` are declared on several repos, so a
`grep '\.name('` census counts strangers. Resolved by the declaring interface instead —
`CryptoOrdersRepo.upsert` has 1 production caller, `.getById` 4, `StatusSubscribersRepo.listAll` 1.
**Resolving an identifier by name alone picks a stranger.**

Two findings, on the same column, from the distinctively-named half of the list.

### `auth-flows-repo.touchWebSession` is dead, and an exact duplicate

Zero callers anywhere in `apps/server/src`. It is **behaviourally identical** to
`auth-repo.touchWebSessionLastUsed` — same UPDATE, same SET, same WHERE, same table:

    .update(webSessions).set({ lastUsedAt: at }).where(eq(webSessions.id, id))

Two repos carrying the same write to `web_sessions.last_used_at`; production calls one of them.
Deletion is the owner's call, recorded rather than taken — consistent with how the other superseded
methods have been handled.

### The live one was asserted by nothing that executes

`auth-repo.touchWebSessionLastUsed` is production's only web-session touch, called from
`services/auth.ts:681` on **every authenticated web-session request**. It was cold — never executed
against Postgres (V-2104). Everything that looked like coverage was not:

- `db-auth-repo-content-parity` pins its **exact SQL as TEXT**, which proves the statement is written.
- At least a dozen unit tests supply `touchWebSessionLastUsed: () => Promise.resolve()` — a no-op stub,
  which proves callers tolerate it doing nothing.
- The in-memory double has a real local fallback, but **no seeded rows**: its writer `upsertWebSession`
  had no caller. V-1268 kept that seam deliberately, saying removing it would leave three methods
  "whose bodies can never do anything, which reads as working."

⭐ **Text, a no-op stub, and an unexecuted branch are indistinguishable from a working write.** And the
repo already knew this failure mode on the sibling column: the comment on
`API_KEY_LAST_USED_THROTTLE_MS` records that an unthrottled double "once masked a real Drizzle bug
where **last_used_at never updated**". The same bug on `web_sessions` had nothing standing in its way.

⚠️ **Severity, checked rather than assumed: display-only.** Nothing prunes or expires on
`web_sessions.last_used_at` — the sole reader is `orderBy(desc(webSessions.lastUsedAt))` behind the
dashboard's session list. A silently-dead write would mis-order that list and show a wrong "last used",
not admit anyone. Recorded at that weight.

⚠️ **An asymmetry noted, not changed:** `api_keys.last_used_at` is throttled to one write per key per
30s, with the stated reason that "the hot auth path doesn't write a row on every authenticated
request". The web-session path has **no throttle** and writes unconditionally on every authenticated
request. That is the owner's call, not a defect, and it is now written down next to the arm.

### The fix

Two arms added to `api-key-last-used-throttle-repo-contract` — the same repo, the same two
implementations, beside the api-key arms they mirror: the touch MOVES `last_used_at`, and touching one
session leaves another alone. They are the **first caller of `upsertWebSession`**, so the in-memory
fallback gets its first exercise too. `it(` 9 → 11, deliberately.

Two fixture facts worth recording. `web_sessions.last_used_at` is `DEFAULT now() NOT NULL` (migration
ground truth) — unlike `api_keys`, there is no never-used state, so the arms assert the value MOVES and
the fixture sets an explicitly old instant rather than letting the default seed "just used". And a bare
`Date` in a `postgres` tagged template is rejected for a `timestamptz` parameter; the repo's own raw-SQL
style is an ISO string with an explicit cast.

**Mutation-proved on the real subject, both directions, arms confirmed BY NAME rather than by count:**
neutralising the method to a no-op — the documented bug class exactly — reds the MOVES arm on the
drizzle half; dropping its WHERE so it stamps every row reds the leaves-another-alone arm; clean tree
20/20. Restored identical to HEAD by `git diff --quiet`.

Related: V-2104 (the cold measurement this works), V-2102 (the same text-versus-execution distinction,
found by mutation instead).

---

## V-2106 — the rest of the cold list: crypto orders clean, a vestigial purge wrapper, and my own roster's key (2026-08-28)

Closing out V-2104's residual twelve.

### Crypto orders — audited, clean

`CryptoOrdersRepo.upsert` and `.getById` are cold with five production callers between them, which is
the shape that produced V-2105. Both are sound, and both readings needed the call sites rather than the
method.

⚠️ `upsert`'s `onConflictDoUpdate` **sets `accountId`**, so an upsert onto an existing `order_id` would
reassign the order to another account — while the sibling `insertWithIdempotencyKey` deliberately does
`DO NOTHING` and re-selects. **Not reachable:** the single caller is `service.create`, whose only route
passes `order_id: newOrderId()` (server-minted) and `account_id: ctx.account.id`. A fresh uuid never
conflicts, which is exactly why the method is cold. Latent only if a caller ever supplies `order_id`;
recorded at that weight, not dramatised.

`getById(orderId)` carries no account predicate at all, and all four call sites are covered:
`createIdempotent` reads an id out of the server's own account-scoped idempotency cache; `getReceipt`
checks `order.account_id !== args.account_id`; `getOrderEvents` is documented and wired admin-only; and
the customer-facing `GET /v1/billing/crypto-orders/:order_id` checks
`order.account_id !== ctx.account.id` and throws **404 rather than 403** (anti-enumeration). Unscoped
at the repo, scoped at the route, shared with admin surfaces that legitimately read any order.

### Two corrections to my own triage

- **`auth-flows-repo.findAccountById` is NOT dead** — three production callers in
  `services/auth-flows.ts`. My "resolve the generic name by its declaring interface" heuristic returned
  _no calls in any file naming AuthFlowsRepo_, because the service holds it as `this.repo`. The
  heuristic fixed one false-positive class and introduced a false-negative one; reading caught it.
- **`audit-archive-repo._processedStripeEventsAliasNote` is a no-op doc anchor** —
  `function _processedStripeEventsAliasNote(): void {}` followed by `void …;`, existing to hang a
  comment on. Cold by construction and not a gap. ⚠️ It will sit in every future cold census as a
  permanent false positive.

### A vestigial wrapper whose use would undo a documented decoupling

`DrizzleAgentTurnReceiptsRepo.purgeForTerminatedAccountsBefore` is a **one-line delegation** to the
exported `purgeTurnReceiptsForTerminatedAccountsBefore`. Production never calls the method — bootstrap
wires the free function directly — and the isolated purge test drives the function too. The file says
why the standalone exists: _"Standalone so the purge does NOT depend on the encryption key… Wiring the
sweeper to the class would have made an unset key silently switch off a retention commitment that has
no relationship to it."_

⭐ So the method is not merely unused: **calling it reconstructs `DrizzleAgentTurnReceiptsRepo`, which
requires `MFA_ENCRYPTION_KEY`, reintroducing precisely the coupling that comment records removing.** The
obvious name is the trap.

### ⛔ …and the roster cannot express it, which is a finding about my own guard

The natural home is `a-superseded-repo-method-keeps-zero-callers`. Adding the entry **breaks it**:
`purgeForTerminatedAccountsBefore` is declared on THREE db repos, and the roster's matcher is keyed on
a **bare method name**. Measured with a probe entry: three arms red, and the zero-callers arm reports
`lib/bootstrap.ts` and `services/account-deletion-purge-sweeper.ts` as offenders — both legitimately
calling the profiles and snapshots methods of that name. **Resolving an identifier by name alone picks
a stranger**, in the guard I wrote to catch exactly this family.

The four existing entries are each declared in exactly one db file, so the key has been sound and
silently so. Added the arm that makes the assumption explicit: every roster weak-name must be declared
in exactly ONE file under `src/db`, floored so a broken read cannot report every name as unique. A
future shared-name entry now fails **there**, with the declaring files named, instead of two files away
with a wrong accusation. `it(` 3 → 4.

**Mutation-proved with the same probe:** the new arm reports
`purgeForTerminatedAccountsBefore declared in 3: agent-turn-receipts-repo.ts, profile-snapshots-repo.ts,
profiles-repo.ts`. Restored; the residual `git diff` is the arm itself, checked by stat rather than
expected to be empty, because the file legitimately carries uncommitted work.

The wrapper itself stays recorded rather than deleted — the owner's call, consistent with the other
superseded methods.

Related: V-2104 (the cold list), V-2105 (the first item worked), V-2095 (the roster this hardens).

---

## V-2107 — a re-derivation, and the one figure in it that had rotted (2026-08-28)

**Gate first: 3251 files, 32331 tests, 1 failed, 192s**, against the migrated disposable database.
The failure is `production-bootstrap-arms-every-chain`, on the `MFA_ENCRYPTION_KEY` mismatch —
and it **passes 2/2 in isolation**. Mechanism: the suite writes `webhook_endpoints` rows under a
test key during the run, and the production bootstrap then cannot decrypt them with the `.env` key.
Shared-database interference, transient (`webhook_endpoints` is back to 0 rows after the run), and
not attributable to my commits, none of which touch bootstrap or the job chains. The same file failed
against the dev database earlier tonight, so it predates the window.

### ⛔ The main body of this work was a re-derivation

I set out from the observation that the coverage `include` names only `apps/server/src/**` and
`packages/sdk-typescript/src/**`, leaving six packages with source and tests unmeasured — verified
that each of the six loads its own `src` by relative import (so all are measurable), and proved it
empirically on `webhook-delivery`: **49/51 functions, 296/305 statements from its own 66 tests, and
invisible to the gate.**

All of it was already known. `a-gate-that-does-not-name-its-blind-spot-reads-as-total` carries a
`PACKAGES_OUTSIDE_COVERAGE` roster naming all six WITH per-package figures, a membership arm requiring
any new package to be included-or-named, and a rot arm. Its header even explains the dist-resolution
nuance I re-derived from `package.json`. **I named "the coverage include" and did not grep prior art
before measuring — my own rule, and the second time this week.**

### What the re-derivation was nonetheless worth

Six packages, 67 source files, 31 test files, 518 tests, all passing:
**functions 246/280 (87.85%), statements 1562/1915 (81.56%)**.

Compared against the figures recorded on 2026-08-23, **five reproduce exactly** —
behavioural-simulation 98.4, recapture-automation 97.7, recipe-library 99.4, webrtc-streaming 89.4 —
to the tenth. webhook-delivery moved 96.6 → 97.0. That exactness is what makes the sixth meaningful
rather than noise: **api-types recorded 25.1%, measures 15.5%, a 9.6-point drop.**

⛔ Three hypotheses refuted before accepting drift. Not the `all` flag — `all=true` and `all=false`
both give 15.53%. Not a different quantity — lines 15.9%, functions 22.6%, files-loaded 8.3%, none of
them 25.1%. Not file growth — 24 src and 4 test files then and now, identical.

**It is real, and the cause is structural rather than accidental.** api-types grew by 216 insertions
across 11 files in five days — schemas added to `profiles.ts`, `sessions.ts`, `webhooks.ts` — while its
own tests load 2 of its 24 files. Every schema added to the API surface grows the denominator and
nothing grows the numerator, so the figure decays monotonically. ⭐ The five stable packages changed in
the same window too (6–69 insertions each) and did NOT move, because their own tests load everything
they ship. **The contrast is what identifies the mechanism**: this is not a roster that rots, it is one
entry that cannot help rotting.

Corrected to 15.5%, dated, with the decay direction stated so the next reader treats it as a moving
floor rather than a fact. ⚠️ Stated rather than automated: the file says its arm is "membership only",
and none of these figures can be re-measured by a unit test — coverage is not available in-process. So
a date and a direction is the remedy available, not a check.

Boundary: the six packages are unmeasured, not untested — 518 of their own tests pass, and five sit at
86–100%. The gate's silence about them is recorded in that roster, not in the config's "Excludes:"
prose, which names api-types with a reason ("no `.test.ts` imports") that is true of its consumers and
false of its own four tests, three of which import `../src/`.

Related: V-1422 (the measurement this reproduces), V-2104 (the db-layer equivalent).

---

## V-2108 — the recipes payload path audited clean, and why the production-boot test is environment-coupled by design (2026-08-28)

Two threads, both ending in "sound", which is the outcome an end-to-end audit is supposed to be allowed
to have.

### Recipes, end to end — clean

Audited after V-2106 found this file's own header denying a delete surface that ships. Boundary:
`routes/recipes.ts`, `services/recipe-payload-encryption.ts`, `db/recipes-repo.ts`, read at HEAD.

Five routes, each with `requireAuth` + a scope + `rateLimit('global')`; reads take `read`, the create
and delete take `write`. The header's remaining universal claim — _"Legacy plaintext arrays and
context-free v1 envelopes are readable only by a bounded compare-and-set bootstrap upgrader"_ —
**holds**, and the read path fails closed twice over: `readRecipeIntentLog` and
`readRecipeTranscriptSnapshot` each reject any stored value that is not a v2 envelope, and each throw
on a missing key rather than returning plaintext. Every read funnels through `rowToRecord`, so there is
no second path.

⭐ The AAD is bound on four axes — purpose, SLOT, `accountId`, `recipeId` — and the two payload columns
use **distinct purposes AND distinct slots** (`driftstack.recipe-intent-log.v2`/`intent_log` versus
`driftstack.recipe-transcript-snapshot.v2`/`transcript_snapshot`). So a ciphertext cannot be moved
between the two columns, between recipes, or between accounts. That is the property most easily got
wrong by reusing one AAD for both slots, and it is right here.

⚠️ Boundary: this audits the read/decrypt path and its bindings. It does not re-audit the 29 existing
recipes guards, and it says nothing about the migration path beyond that the normal readers refuse what
the upgrader accepts.

### Why the only production-boot test is coupled to its database

The gate's single failure (V-2107) is `production-bootstrap-arms-every-chain`, which passes in
isolation. The peer session analysed the isolation fix and **declined it, correctly**: the boot resolves
its database from `process.env.DATABASE_URL` inside `loadConfig()`, not from the file's local client, so
isolating the file would require mutating a process-global that **153 files capture at module scope** —
the repo's first such mutation, safe only under a default `isolate: true` nobody has stated. Their
framing is the one to keep: it works today and becomes a landmine the day someone sets `isolate: false`
for speed, in an edit that would look unrelated.

They handed back the better question — why the boot decrypts stored customer rows at all — and it has a
documented answer. `lib/boot-key-verification.ts` exists for exactly this: _"Every envelope migration in
bootstrap opens with a probe: read one already-encrypted row with the configured key and throw if it
cannot be decrypted. That check is deliberate and correct — it refuses to serve with unreadable
secrets."_ Nine call sites across eight repos (webhooks, MFA, BYOK, agent-session transcripts, platform
secrets, fleet-node LiveKit secrets, account proxies, recipes, profiles), with two stated invariants: it
never swallows, and it never names the key.

**So the eager decryption is a fail-closed safety property, not incidental startup work, and the test is
exercising it correctly.** What fails is not the boot and not the test: it is that a single suite run
puts TWO ENCRYPTION KEYS in one database — `buildTestApp` writes rows under a fixed test key while this
file boots with the `.env` key — and the probe is fatal by design.

⭐ That also explains why the peer measures 3251/3251 and I measure one failure **on the same commit**:
the condition is order- and residue-dependent, so both observations are correct. A green here is not
evidence the interference is absent.

No fix landed. Isolation cannot reach it without the global mutation the peer rightly refused; clearing
the probe tables would delete other tests' rows on a shared database; and the boot's own error already
names the subsystem, the env var and the remedy. Recorded so the next session does not re-open it — two
of us spent real time attributing this one.

Related: V-2107 (the gate run), V-2106 (the header that prompted the recipes audit).

---

## V-2109 — three negative results, a stale snapshot my control caught, and the population still unmeasured (2026-08-28)

Recorded because each cost time and none should cost it twice.

### Three threads that ended without a finding

- **Admin audit-log completeness.** Three route files claim "each mutation writes an `admin_audit_log`
  row". Grepped prior art before checking and found **80+ audit-related test files**, including
  `every-admin-mutation-writes-an-audit-row` and `every-mutating-admin-route-writes-an-audit-row` —
  which are complementary rather than duplicates: the first contrasts the documented claim against
  reality (mutations audit, GETs do not), the second guards the specific recurrence of a new admin route
  shipping with no audit wiring, which has happened twice. ⭐ The first file also records
  "Counts are deliberately absent… V-861 found the figures written here had already drifted" — the
  derive-don't-record remedy, already applied here, which partly pre-empts V-2107's lesson too.
- **Permissive CORS.** `cors-allow.ts` claims "When true, every origin is reflected". True, and the
  dangerous configuration is already fail-closed: `assertCorsPosture` throws on permissive-CORS-in-
  production so it cannot boot, pinned by `cors-posture.test.ts` for both wiring and strength, verified
  at HEAD on 2026-08-27. Thirty seconds because I grepped prior art first.
- **Cold × no-op-stub.** V-2105's shape — a production write stubbed to `() => Promise.resolve()` in a
  dozen tests AND never executed — generalised into a detector: cold db functions intersected with
  no-op stubs across `apps/server/tests`. **Two hits, both already handled**: the V-2105 case itself,
  and `upsert`, whose generic name I had already resolved and audited clean in V-2106. The vein is
  swept.

### ⛔ The control caught that my own input was stale

That intersection reported `touchWebSessionLastUsed` as still cold — which is impossible, since V-2105
added the arms that execute it. Cause: the cold set came from a coverage run taken **before** that fix,
so the analysis ran against a pre-fix snapshot. **Third time tonight a stale artifact read exactly like
a fresh one** (after the shared `coverage-summary.json` and the two coverage directories), and the only
reason it was caught is that the detector carried a probe whose expected answer I knew.

⚠️ A derived set is an artifact like any other. Re-derive it, or stamp it with the commit it was taken
at — the same discipline as a dated measurement, applied to intermediate data rather than to prose.

### What is actually unmeasured, stated so "saturated" is not overclaimed

Five consecutive threads this firing ended clean or pre-empted, which is real evidence that the STATIC
INSTRUMENTS I have been using are exhausted. It is **not** evidence the codebase is. Concretely, from
the peer's server-wide figure of **2748/2959 functions covered, excluding `src/db`**:

> **211 cold functions outside the db layer, across 287 source files — versus the 31 I triaged in the
> db layer this session.**

That population is seven times larger and has not been looked at once. The method is now known and
recorded (V-2104): an all-green run against a disposable database, because **a single failing test
suppresses the entire coverage report**. It needs the machine, and a peer is mid-write on the retention
scrub, so it is deferred rather than skipped.

No source change. Next firing's target is named and sized.

⛔ **Correction to this entry, minutes after landing it.** The paragraph above shipped with a MANGLED
identifier: written unbackticked in prose, prettier read the underscores as emphasis markers and
committed `admin` + `*` + `audit_log` into HEAD, with zero correct occurrences. The tell was a `MM`
status on this file — the commit hook reformatted a corrected version into the INDEX while the worktree
reverted, which reads exactly like the poisoned-index shape the shared-tree rules warn about and was
repaired the documented way (`git reset -q -- <path>`, index ← HEAD, worktree untouched).

Two things worth keeping: **an identifier containing underscores must be backticked in this log**, or
the formatter silently rewrites it; and the fix was verified by POST-CONDITION — zero occurrences of
the mangled form, at least one of the backticked form — then the same shape swept across the whole
file, where the five remaining matches are regex literals already inside code spans.

Related: V-2104 (the method), V-2105 (the shape worth hunting), V-2107 (the peer figure this uses).

---

## V-2110 — dead code bounded at 3 of 1736, and a 44-false-positive detector my controls could not catch (2026-08-28)

### The measurement I could not take, and why

Launched the non-db coverage run after checking 120s of tree quiescence, zero runners, and that the
peer's two touched tests passed 15/15. They wrote `retention-scrub-repo.ts` at 04:56, mid-run. Two
files failed and **the report was suppressed entirely** (V-2104), so the 211-cold-function measurement
is still unmade. Attributed by mtime before reading anything: the type-check arm named
`scrubExpiredWebSessionIdentifiers does not exist on type 'RetentionScrubRepo'` — a method their
sweeper referenced before their repo declared it.

⚠️ **The lesson is mine.** A quiescence check plus a green spot-check is necessary and NOT sufficient:
both describe the tree at launch and neither covers the window. Only a peer announcement does.

### The half that needed no machine

A cold function is not necessarily dead — it may be live code no test reaches — so the strict subset
that IS answerable statically is "declarations with no caller anywhere". Boundary: **1736 exported
top-level functions and class methods under `apps/server/src` EXCLUDING `db/`**, against a call index
built in one pass over 2851 files in `src` + `tests`, comments stripped, declarations excluded.

**Three have no caller, and all three are explained:**

- `services/sessions.ts` `findOwnedSessionLite` — V-2096's orphaned seam, deliberately left pending the
  owner's call. ⭐ It doubles as the built-in known-positive: the detector independently rediscovered
  the one declaration already proven dead.
- `services/fleet-control-registry.ts` `setEgress` — the live egress swap, built ahead of its route,
  which is this repo's documented wire-ready posture (the correlator beneath it is separately tested and
  the wire format is pinned). ⚠️ Its comment says "the route mints a uuid", present tense, about a route
  that does not exist — the V-2096 shape again, small.
- `services/oauth.ts` `resetForTest` — uncalled ON PURPOSE, and pinned that way:
  `oauth-production-wiring-content-parity` asserts the e2e helper does NOT call it, because wiping
  provider authority mid-run against a shared store is the harm.

⭐ **So dead code in non-db server source is bounded at 3 of 1736, none of it a defect.** That also
reframes the 211: they are not deletion candidates. Every one has a caller — they are cold because the
path reaching them is unexercised, which is what V-2105 turned out to be and needs tests, not removal.

### ⛔ The detector was wrong first, by 44, and the controls could not see it

The first run reported **44** zero-caller declarations. Every one was named `get`, `set`, `del`, `has`,
`inc`, `on`, `end` or `run`. Cause: my CALL index required `\w{3,}` — four characters — while the
DECLARATION scan had no length floor, so short methods were declared and never indexed.

⭐⭐ **All three controls were long names** (`verifyStripeSignature`, `buildAdditionalAuthenticatedData`,
`verifyBootEncryptionKey`), so every one passed while the detector was blind to an entire length class.
A control only proves the detector works _for inputs shaped like the control_. Fixed by aligning both
thresholds and adding SHORT known-live controls — `get` 1638 calls, `set` 957, `run` 29. **44 → 3.**

⚠️ The tell was in the output and readable without any of this: a result list whose members share a
shape the population does not (eight three-letter names out of 1736 declarations) is describing the
instrument, not the code.

### Also verified, clean

`lib/stripe-signing.ts` claims "each candidate must independently match a real HMAC". **Holds**, and the
implementation carries a fixed real defect worth knowing: V-1465 records that Node's HMAC accepts an
EMPTY key and returns a valid digest, so an empty secret verified — now refused before hashing. The
timestamp tolerance is checked before the HMAC, and `constantTimeHexEq` guards both subtle traps with
reasons: a length check first (`timingSafeEqual` throws on unequal buffers) and a hex-charset check
(`Buffer.from(x,'hex')` silently truncates on bad characters).

Related: V-2104 (report suppression), V-2105 (cold-with-a-caller), V-2109 (the population named).

---

## V-2111 — the 215 cold functions outside the db layer, measured and triaged: no defect (2026-08-28)

The measurement V-2109 named, taken on a fully green tree after the peer landed `e47fe3266`:
**3251/3251 files, 32321 tests passing**, and for `apps/server/src` EXCLUDING `db/` —
**functions 2476/2691 (92.01%), statements 16444/17754 (92.62%)**. That leaves **215 cold functions
across 62 files**, and the first useful split is that **160 are anonymous** (arrow callbacks, error
handlers, `map` bodies) and **55 are named**, in 29 files.

### The 55 named, and why each class is cold

| class                       | count | why                                                                                                                                                                                      |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| external I/O clients        | ~20   | `drivers/playwright.ts` (all 15 methods), `lib/r2.ts` (2), `lib/stripe-api.ts`, `lib/ssrf-guarded-fetch.ts`, sentry, logger — executing them needs a live browser, S3, Stripe or network |
| entrypoints and CLIs        | 4     | `index.ts`, `lib/dump-openapi.ts`, `scripts/seed-local-fleet-node.ts` (2)                                                                                                                |
| a stub that throws          | 3     | `drivers/webkit.ts` — every method throws `DriverNotIntegratedError` by design                                                                                                           |
| documented known exclusions | 3     | the atlas-priority admin mirror, below                                                                                                                                                   |
| in-process residue          | ~25   | webhook delivery (6), team helpers (2), billing pause/resume (2), agent-runtime, error constructors, session-event metadata                                                              |

Two checked to the bottom, because inventory is not a reading.

**`lib/r2.ts` `deleteObject` — cold by construction, not a gap.** It has FOUR production callers, all of
them erasure paths: profile delete, the orphan-blob reaper, the account-deletion purge and the trash
purge. Every test supplies a fake r2 client, so the real `s3.send(new DeleteObjectCommand(...))` never
runs — but it cannot, without a live bucket. Same category as `migrate.ts` in the db triage (V-2104),
and the method is a thin wrapper whose one subtlety (S3 DELETE is idempotent, so a never-saved blob is
safe to delete) is documented where it is relied on.

**`registerAdminAtlasPriorityRoutes` — a whole admin surface never registered in any test, and already
recorded.** Its gate is `if (deps.atlasPriorityEventsRepo !== undefined)`, deliberately independent of
the internal-fleet token gate, and bootstrap wires that repo unconditionally — so the two routes
(`/v1/admin/atlas-priority/queue` and `/event/:id`, both behind
`requireScope('driftstack_internal_admin')`) are live in production and registered in no test app.

⛔ **I expected to find that the refusal guards passed on a 404 and was wrong — they were already ahead
of it.** `templated-routes-refuse-anonymous-callers` derives its population from the LIVE route table
via `app.hasRoute()` rather than a hand list, names these two operations as conditionally registered,
and asserts an ALLOWLIST of exactly 401/403 precisely because "404 means the handler reached the
lookup… all four are the same defect". `admin-scope-refusal-coverage` carries them in an explicit
exclusion map — _"atlas-priority surface is registered only when enabled"_ — and states that a 404 would
mean the route is not registered, which makes the assertion meaningless. **Both refuse the reading I was
about to make.** Resolved by reading, not by preferring my own inference against their evidence.

⚠️ One prose nuance, recorded rather than changed: that exclusion reason reads as though the surface is
conditionally enabled in general, while in production the repo is wired unconditionally and the routes
are always on. Accurate about the test app, loose about production.

### Outcome

**No defect.** Every named cold function outside the db layer is explained by its class, and the two
deepest reads confirmed the explanation rather than assuming it. Combined with V-2110 — dead code
bounded at 3 of 1736 declarations — the non-db server source is now measured on both axes: almost
nothing is unreachable, and what is unexecuted is unexecuted for a stated reason.

That closes the target V-2109 named. ⭐ Eighth consecutive thread this session ending clean or
pre-empted by existing prior art, which is now the strongest available evidence that static measurement
of this repo is genuinely exhausted rather than merely unlucky.

Related: V-2109 (named this target), V-2110 (the dead-code bound), V-2104 (the method).

---

## V-2112 — the agent-session upload path audited end to end: clean, and already three times audited (2026-08-28)

Static measurement is exhausted (V-2111), so this is the mode the standing order prescribes for that
state. Boundary: `POST /v1/agent-sessions/:id/files` in `routes/agent-sessions.ts` — its caps,
reservation and release accounting only, not the ~5000-line route file around it.

**The question an audit adds over the existing guards.** `upload-account-inflight-cap`,
`the-documented-upload-caps-are-the-enforced-ones` and `upload-request-correlator` all assert the caps
REFUSE correctly. None of them asks whether the reservation is RELEASED on every exit path — and a
leaked per-account counter is not a refused request, it is a customer permanently throttled with no
error anywhere.

**Verified, and it holds on every point:**

- The reservation (`accountUploadInFlightBytes/Count.set`) is taken at one place, and the window
  between it and the enclosing `try` contains only comments, a `let`, two `Map.set` calls and an LRU
  eviction — **no return path and nothing that can throw**, so the reservation cannot escape the
  `finally`.
- The `finally` releases BOTH concurrent maps and **deletes the key at zero** rather than storing 0 —
  without that the per-account map would grow one permanent entry per account that ever uploaded.
- It also rolls the LIFETIME reservation back unless `lifetimeCommitted`, with `Math.max(0, …)`, and
  reads the current values through `?? reserveBytes` / `?? 1` so an entry cleared by the LRU eviction
  cannot drive a counter negative. Those two defaults only matter in the eviction case, and they are
  right.
- Byte reservation is taken on the ENCODED length BEFORE decoding, so the cap is consulted before a
  large copy is materialised.
- The lifetime check runs BEFORE the concurrent reservation, so a lifetime-rejected request never
  touches maps it would then have to release.

⭐ **The one unbounded-growth item is documented AND bounded.** The per-session lifetime maps are
deleted only along the customer-DELETE path, so a session reaped by worker-disconnect or the 12h orphan
sweep orphans its entry — stated in the code, then capped at 20,000 tracked sessions with
oldest-evicted, and with the safety argument written down: a falsely cleared counter only ever WIDENS
that session's remaining allowance, so eviction is not a security regression.

⭐⭐ **And the region already caught a real concurrency defect (V-721), recorded where it happened.**
Committing the lifetime total AFTER `await conn.requestUpload(...)` made the check-and-increment a
read-modify-write straddling the relay: every upload admitted while another was in flight read the same
pre-relay total and wrote back its own single increment, so a concurrent batch registered as ONE
upload and a caller keeping four in flight spent the per-session ceiling at roughly a quarter rate —
defeating the counter that exists to backstop the concurrent caps. Fixed by reserving in the same
synchronous block.

**Result: clean.** Three recorded audit passes are visible in the comments (2026-06-24, 06-30, 07-01)
and this is the fourth. Recorded so it is not audited a fifth time without a reason.

⚠️ Ninth consecutive thread ending clean or pre-empted. Stated with the same caveat as V-2111: that is
evidence about the surfaces reached so far, not a claim about the codebase.

Related: V-2111 (why the mode changed), V-721 (the defect this region already fixed).

---

## V-2113 — branch coverage as a new axis: 79 refusal paths never executed, one closed (2026-08-28)

Every instrument this session measured FUNCTIONS or STATEMENTS. Branches are a different axis and the
one that matters most for a guard: **an `if` whose refusal arm never runs is a refusal never observed.**
The all-green run from V-2111 already carried the branch maps, so this needed no new suite run.

**Boundary: `apps/server/src` excluding `db/`, from the 3251-file all-green run — branches
10434/12352 (84%), and 1918 never taken across 198 files.** Too broad to triage, so narrowed to the
shape that matters: an untaken branch whose opening lines refuse (`throw new …Error`, a 4xx reply).
**79 such refusal branches, concentrated in `routes/agent-sessions.ts` (24), `admin-incidents` (7),
`team` (7), `account-me` (5).**

⛔ **The narrowing has a false-positive mode and it fired immediately.** It reads the four lines from
the branch's start, so it attributes a refusal to whichever branch happens to open above it.
`middleware/auth.ts:304` came back as a never-executed refusal; it is `if (!ctx) return;` — an
impossible-case early return whose comment says "requireAuth would have thrown" — and the
`ForbiddenError` my window matched belongs to the NEXT statement. Read before believing, as ever.
`middleware/rate-limit.ts:64` is genuine but correctly cold: a double-invocation assert whose firing
would mean a programming error, not a customer condition.

### The one that was real, and is now closed

`services/profiles.ts:1145` — the concurrent-TRANSFER race loser:

    if ('sourceAlreadyRetired' in result) throw new ConflictError('Profile was transferred or deleted…')

⭐ The outcome IS proven at the SQL layer: `db-profile-transfer-concurrency-drizzle` runs two transfers
of one profile against real Postgres and asserts exactly one loses, because the retire is a CLAIM whose
result is checked. **What nothing did was drive the SERVICE with that outcome**, so the branch turning
it into a customer-visible 409 had never executed. A loser would have got whatever falling through
produces — `result.record` is not there — rather than the documented conflict.

The file already had the sibling for the other race (`translates a concurrent same-name 23505 (race
loser) into ConflictError, not a 500`); the transfer race simply never got one. Added beside it, using
the file's own idiom of overriding a single repo method on the existing faithful double — whose comment
notes it deliberately mirrors the claim, so "a double that skipped the claim would let the
concurrent-transfer bug pass here". `it(` 66 → 67.

**Mutation-proved on the real subject**, failing arm confirmed BY NAME: neutralising the branch so the
loser falls through reds exactly this arm and nothing else; clean tree 67/67; subject restored identical
to HEAD.

⚠️ Two process notes. The first mutation attempt aborted on its anchor assert because I typed the
indentation from `sed`-prefixed display output instead of deriving it — the assert did its job and
nothing was written. And the restore was performed FROM the snapshot but verified AGAINST git, which is
the distinction recorded earlier today; here the subject carries no uncommitted work, so an empty diff
is the right expectation.

**The remaining 78 are a measured work-list, not a claim** — several will be defensive asserts like the
rate-limit one and several more will be my window's false positives.

⛔ **Corrected in V-2114: "a new axis" is wrong.** V-973 ran branch coverage on `routes/agent-sessions.ts`
before me and its guard's comment says so outright. The transfer-race finding above stands and was
genuinely unclosed; the framing did not.

Related: V-2111 (function coverage exhausted), V-2112 (the audit that preceded this).

---

## V-2114 — the agent-sessions branch cluster triaged, and V-2113's "new axis" retracted (2026-08-28)

Worked the largest cluster from V-2113: **24 refusal-shaped untaken branches in
`routes/agent-sessions.ts`**, boundary as before (the all-green 3251-file run, `apps/server/src`
excluding `db/`). It resolves entirely, and one of the resolutions corrects me.

### ⛔ Branch coverage is not a new axis here, and the prior art says so in as many words

V-2113 closed by saying the axis "is productive where function coverage was exhausted", which reads as
though nobody had used it. **V-973 had.** `v2-37-agent-message-kinds-parity` carries this:

> _"Coverage shows none of these four translations is executed by any test — the cap itself IS tested,
> one layer down in agent-runtime.test.ts, so what went unchecked is the mapping to HTTP."_

I had independently reached exactly that about `account-turn-limit`: proven in `agent-runtime.test.ts`
at the service layer, never executed at the route that turns it into a customer-visible 429. The guard
already closes it the only way available — executing it needs a fabricated runtime result, so it pins
WHICH error class each kind maps to, with the consequence spelled out: `sdk-typescript/src/retry.ts`
retries 429 and no other 4xx, so demoting that cap to a 409 makes the customer's turn fail permanently
where it used to succeed once a slot freed. **An existence pin would not notice, because the branch is
still there.** ⭐ That is a better close than a test would have been.

The transfer-race finding in V-2113 stands — it was real, unclosed, and is now executed. The claim of
novelty did not.

### The other 20, and why the cluster is reassuring rather than alarming

- **~10 are Zod body-validation refusals** — `CreateAgentSession`, `SetCookies`, `NavigateHistory`,
  `UploadFile`, `DownloadFetchQuery`, `Handback`, `ResumeSession` and three bare
  `if (!parsed.success) throw new ValidationError(...)`. No test sends a malformed BODY to these
  endpoints. Uniform machinery, low per-endpoint risk, and a genuine gap in the "400 on malformed
  input" contract — recorded, not closed, because ten near-identical arms is a decision about test
  weight rather than a defect.
- **4 are V-973's translations**, already pinned structurally.
- **The rest are fail-closed defensive branches**, and I read them rather than assuming. The pair at
  `:4115`/`:4119` is the instructive one: when the caller is NOT the session owner — a control-key
  caller or a team admin — the handler looks up the OWNER's tier rather than the caller's, and refuses
  with `ForbiddenError` if the auth repo is unwired or the owner account has vanished. **Both arms
  refuse; neither falls through to the permissive path.** Cold is the correct state for a branch that
  only fires when a dependency is missing or an account was deleted mid-session.

⭐ **The pattern worth keeping from the whole cluster: every business-logic refusal I read fails
CLOSED.** A never-executed refusal is worrying exactly when the untaken arm is the permissive one, and
none here is. That is a cheaper triage question than "is this tested" and it disposes of most of a
79-item list.

Related: V-2113 (the axis, and the finding that stands), V-973 (the prior art that corrects it).

## V-2115 — the largest never-executed branch class is unreachable by construction, proved structurally (2026-08-28)

Completes the never-taken-branch triage. Outside `routes/agent-sessions.ts`: **97 refusal branches, classed
mapping=8, other=68, zod-parse=21.** ⚠️ Boundary, stated because the number moved: the repo-wide figure went
**79 → 121** between two passes because I _widened the refusal vocabulary_ (added `BadRequest`/`TierLimit`) —
a different boundary, not a contradiction. 121 = 97 outside + 24 inside `agent-sessions.ts`.

The `other` class is dominated by one idiom: the post-auth narrowing assert. Keyed by its **message** — the
only spelling-independent key — there are **121 sites across 43 files** (117 `after requireAuth`, 4 `after
requireOwner`). ⚠️ Do not sum my two intermediate censuses: the inline `if (!ctx)` count (108) and the
`requireCtx` helper count (11) **overlap**, because the inline pattern matches the `!ctx` spelling but not
the `!request.account` one.

**Unreachable by construction — proved from types and totality, NOT from coverage:**

1. `requireAuth` (`middleware/auth.ts:154`) is _total_: every path either assigns `request.account = ctx` or
   rethrows. Its reply parameter is `_reply`, unused — it cannot reply-and-return.
2. `authenticate` (`services/auth.ts:280`) and both slow paths (`:469`, `:641`) are declared
   `Promise<AccountContext>` — non-nullable under TS strict, so no nullish context can be assigned.
3. Therefore after `requireScope`'s lazy `await requireAuth(...)`, `request.account` is always set, the
   `if (request.account) requireScope(...)` guard always passes, and the handler-side assert cannot fire.
4. `requireAuthEventSource` (`:191`) is documented "Standalone (NOT a wrapper around requireAuth)"; that
   exception is about duplicated header-path code, not totality — it has the same throw-or-assign shape.
   `requireOwner` and `requireMfaFresh` lazy-auth identically. All five gates covered.

The **11 local `requireCtx` copies** carry 4 distinct spellings (falsy check; explicit null/undefined; bind-a-
local; plus-a-comment) and are **semantically identical** — an object type has no falsy non-null value.
Classified by reason rather than by difference: duplication without divergence, **no defect**. The cost is a
maintenance surface — converting the bare `Error` (500) to a typed 401 would be 121 edits.

⛔ **THE INSTRUMENT ERROR, recorded.** I measured 61 preHandler chains naming `requireScope` with **no**
`requireAuth` and read it as an unauthenticated admin surface — concentrated exactly where it looks worst
(`admin-crypto-orders` 11, `admin-accounts` 11). It is not one: `requireScope` lazy-auths. **The refutation
was already written in the code** at `middleware/auth.ts:237-254`, which predicts this exact misreading, names
the same concentration, and states its own figures — 61 scope-only / 104 naming both. I re-measured both
independently today: **still exact.** That comment exists because an earlier audit reached this and abandoned
it "one step from being filed". Mine is the second. The lesson is not "read the comment" but that a
_structurally alarming shape_ concentrated in money routes is precisely where a lazy-init pattern will be
misread, and the cheap disproof is to read the decorator, not to count its call sites.

⛔ **A numeric coincidence I nearly filed as a mechanism.** The 104 inline `after requireAuth` asserts equalled
the comment's "104 chains name both". Checking the per-file distribution killed it: chains naming `requireAuth`
number **129**, and the two populations are **anti-correlated** — admin files carry the asserts and zero such
chains, while `sessions.ts`/`profiles.ts` carry 14/13 chains and **zero** asserts (they use a local
`requireCtx`). Equal totals, opposite distributions.

The 7 mapping-class candidates all resolve clean: `profiles.ts:1145` (closed by me in `cb219b898` — a test that _executes_ it; the source line is unchanged),
`status-subscribers` ×3 (defensive; the invariant is executably asserted), `team.ts:189` (deliberate
anti-enumeration 404), `billing.ts:251` and `profiles.ts:652` (fail-closed).

⛔ **My own error, recorded:** I grepped the status-subscribers purge test camelCase-only and concluded an
invariant was unasserted. The file uses `snake_case` in raw SQL. My standing rule says enumerate with BOTH
patterns, and I used one.

**Blind spots, stated:** the proof is structural, so it does _not_ depend on the coverage artifact — which
matters here, because a peer's `vitest run --coverage` was regenerating `coverage-final.json` throughout this
measurement and reading it would have been racy. It covers only the five gates named above; a route that sets
`request.account` by any other means is outside it. The 21 `zod-parse` refusals and the ~68-member `other`
class remain never-executed by test weight, not by defect — recorded, not closed.

## V-2116 — the error taxonomy's "never leak raw error messages" claim holds, and its guard is not scoped narrower than the family (2026-08-28)

Checked by the universal-claim instrument (`Every <noun> <verb>` in source comments — 45 such claims in
`apps/server/src` today, matching the 46 recorded when the technique was adopted). `lib/errors.ts:3` claims
"Every thrown error that surfaces to the response layer is one of these `ApiError` subclasses", and its next
sentence carries the _checkable security_ half: **"We never leak raw error messages to clients."**

The first claim is not falsified by the 121 bare `throw new Error(...)` narrowing asserts of V-2115 — the file
states its own fallback explicitly ("Anything _else_ that escapes … is logged at error level and replied as
Internal (500)"). A two-sentence claim whose second sentence is the escape hatch.

**Three paths return an upstream message to the client; all three are deliberate and all three are guarded:**

- `error-handler.ts:112` — `detail: fastifyErr.message` for any error with numeric `statusCode < 500`.
  ⚠️ The condition is not Fastify-specific, so I checked what else in the tree throws with a numeric
  `statusCode`: exactly one site, `routes/_webhook-raw-body.ts:37-39`, whose message is the hardcoded
  constant `'Invalid JSON in request body.'`. No sensitive content can reach this path.
- `error-handler.ts:128` — a `StripeApiError` with `status < 500` returns `upstream.message` as a
  `BadRequestError` detail. A documented V-780 decision (a reused Idempotency-Key was surfacing as
  "an unexpected error occurred" while paging the operator), not an oversight — so it was not
  pattern-matched as a leak.
- `error-handler.ts:133` — everything else becomes `InternalError('An unexpected error occurred.')`.

⛔ **The hypothesis I formed and then refuted by reading.** The guard is named
`error-handler-internal-error-no-leak.test.ts` — a name that scopes it to the InternalError path — while V-780
_later added_ a path that deliberately returns an upstream message. That is exactly the shape where a guard
naming one member of a growing family goes blind. **It is not blind:** the file carries a dedicated
`describe('an upstream 4xx is not our 500 (V-780)')` block exercising the Stripe remap, a framework-4xx arm
that states its own safety rationale ("safe: describes client input, not server internals"), a typed-ApiError
contrast arm proving the handler hides _unknown_ errors rather than all errors, and the V-494 arm asserting a
token in the URL is redacted out of the echoed 404 detail. The guard grew with the family.

**Prior art was grepped before measuring, not after** — the adjacent Zod vein is already swept
(`z.enum`/`z.literal` echo the rejected value through `.flatten()`; `z.string()` length/type checks do not; all
23 interpolating `message:` templates carry constants or state names, and no sensitive field in this repo has a
low-cardinality domain). Nothing re-derived here.

**Boundary:** this checks which paths _can_ place an upstream string in a response body, and what the one
non-framework `statusCode` thrower puts there. It does not enumerate the message space of Stripe's own 4xx
catalogue, which is Stripe's to define and is customer-facing by their design. No defect.

## V-2117 — a security claim two parity guards froze was false for 5 of 20 methods; corrected without churning either pin (2026-08-28)

Found by the universal-claim instrument (V-2116). `services/sessions.ts:5` states **"Every method takes an
AccountContext and enforces account-scoped ownership"**. Measured on the class body: **20 methods, 15 take the
context, 5 do not** — `autoDestroyExpired`, `destroyAllForAccount`, `findOwnedSessionLite`,
`persistPostSuccessObservability` (private), `ingestEgressCapabilityReport`.

⛔ **Instrument error, recorded.** My first census reported 21/17/4. A two-space-indent regex matched the
`SessionRepo` **interface** members as service methods — 17 of them — and in the same pass counted two
interface members (`countActiveSessions`, `countAllByStatus`) as context-taking _service_ methods while missing
the `private` one entirely. The brace-scoped enumeration that **names** its members is the one that was right.
Enumerate the set; never report the size.

**All five are sound — each scoped another way rather than left unscoped:**

- `autoDestroyExpired` — acts on a `SessionRecord` the duration sweeper already fetched.
- `destroyAllForAccount(accountId)` — scoped by explicit argument; reached only from admin suspend/reclaim.
- `persistPostSuccessObservability` — `private`; its `accountId` comes from an already-authorized record.
- `findOwnedSessionLite(accountId, sessionId)` — scoped by argument, and has no callers (deletion candidate).
- ⭐ `ingestEgressCapabilityReport` — the one that justified the audit: it takes no context and is reachable
  from a fleet node. Enforcement is **one layer out**, in `session-capability-report-relay.ts:64` — a frame is
  dropped unless `session.nodeId === reportingNodeId` _and_ the session is not closed, and the id forwarded
  downstream is `session.driftstackSessionId` taken from the **resolved record**, never `frame.sessionId`. A
  node cannot target another node's session. The same id-binding discipline the seed-script AAD pin exists to
  protect.

⛔ **Two parity guards froze the false sentence** — `services-sessions-content-parity.test.ts:54` and
`sessions-v156-v136-v169-cross-source-invariant.test.ts:78-80`. A pin freezes _text_, not truth, and here it
made the overstatement **durable**: correcting the sentence breaks two tests, which is a standing disincentive
to correct it.

**The fix keeps both pins green.** Rather than rewrite the frozen sentence and churn two guards, I appended an
`EXCEPT` clause naming all five and where each is enforced — the idiom this repo already uses at
`routes/auth.ts:16` ("Every endpoint here is public … EXCEPT `POST /v1/auth/mfa/step-up`"). All four pinned
regexes still match, dry-run against the edited file _before_ running anything; both test files pass (47
tests); `tsc -p apps/server/tsconfig.json --noEmit` exits 0; the diff is 19 comment lines and prettier-clean.

**Why it matters in both directions** — the note says so at the source: trusting the sentence skips five
methods, while reading only the signatures accuses `ingestEgressCapabilityReport`, whose enforcement is not in
this file. That is the "gated is not a property of the route registration" trap one layer down, and I walked
into its second half before checking the relay.

**Also verified, no change:** `routes/auth.ts:16`'s claim holds exactly — 12 route registrations, exactly one
(`POST /v1/auth/mfa/step-up`) behind `requireAuth`, matching its EXCEPT clause; the "MFA pair"'s other half
(`mfa/challenge`) is correctly public because it _completes_ authentication rather than sitting behind it. The
adjacent MFA brute-force question was answered by prior art before I spent a measurement — atomic INCR attempt
cap `MAX_MFA_CHALLENGE_ATTEMPTS=5`, 300s TTL, already adjudicated sound and marked do-not-re-audit.

**Boundary:** this measures which methods take a context and where each exception enforces scope instead. It
does not re-audit the 15 that do take one.

## V-2118 — the boot-probe net is attached to migrations, not to keys; one repo inherits its safety and nothing asserted that (2026-08-28)

Third round of the universal-claim instrument (V-2116). Three claims checked, one real gap.

**`lib/boot-key-verification.ts:3` — "Every envelope migration in `bootstrap` opens with a probe."** Exact.
There are **nine** envelope migrations reached from `bootstrap` and all nine call `verifyBootEncryptionKey`
_inside the migration method itself_, verified by resolving each probe's enclosing function rather than by
checking that the file imports it: `migrateValueEnvelopes`, `migrateLivekitSecretEnvelopes`,
`migrateTotpSecretEnvelopes`, `migrateCiphertextEnvelopes`, `migratePayloadEnvelopes`,
`migrateTranscriptEnvelopes`, `migrateWrappedDekEnvelopes`, `migrateSecretEnvelopes`, and
`encryptLegacySecrets`. Nine also matches the file's own "rather than inlined nine times".

⭐ **The gap the claim cannot state, because it is true.** The probe is attached to the **migration**, not to
the **key**. A repo that never had a legacy envelope to migrate never acquired one — and
`agent-turn-receipts-repo` encrypts customer response bodies through `platform-secret-encryption` with no
migration, so it is the one envelope-bearing repo outside the net. On a bad key it would fail at _request_
time with the raw "Unsupported state or unable to authenticate data" that this very wrapper exists to replace,
at the moment an operator is least able to diagnose it.

**Consequence today is nil — but only because of a relationship nothing asserted.** `bootstrap.ts:1335`
constructs it with `config.mfaEncryptionKey`, the same key **seven of the nine** probes verify
(`MFA_ENCRYPTION_KEY`; the other two verify `PROFILE_MASTER_KEY`). So a wrong key is already caught at boot by
those seven. A nil consequence holds only while its invariant does, and this one was written nowhere and
checked by nothing: hand that repo its own key, or move the probes off `MFA_ENCRYPTION_KEY`, and the
inheritance ends silently, with no observable change until a rotation.

**Closed with a guard that asserts the relationship instead of recording it**
(`a-repo-outside-the-boot-probe-net-inherits-a-verified-key.test.ts`, 4 arms): a non-vacuity floor over the
probe census spanning both key families; the key-binding arm (paren-balanced argument extraction, so a nested
call cannot shift the index); the inheritance arm, which reds if the probes leave `MFA_ENCRYPTION_KEY` while
the binding arm still passes; and a self-retiring arm that fails — telling the reader to delete the file — if
the subject ever gains a probe of its own.

**Mutation-proved, three mutations, each on the real subject rather than the guard's own list**, snapshotted by
full path, restored under a trap, all 11 files verified byte-identical afterwards: rebinding the constructor
to another key killed the binding arm; adding a `verifyBootEncryptionKey` token to the subject killed the
self-retiring arm; renaming the key in all seven probe files killed both the inheritance arm and the
non-vacuity floor.

⛔ **Instrument error, recorded.** My first pass reported that **0 of 8** migrations probed — a uniform,
dramatic result, which is the signature of a broken instrument rather than an eight-way defect. Two causes:
the scan began at the _signature_ line, so the parameter list and the batch-limit guard consumed its window
before reaching the probe, and one target matched an **interface** declaration instead of the implementation.
A method body starts after the params, not at the signature. The corrected pass resolved each probe's
enclosing method and found 8 of 8, then 9 of 9.

⛔ **Second instrument error, caught by a precondition rather than by luck.** The snapshot step built its file
list in a shell variable and zsh did not word-split it, so `cp` received one impossibly long filename and
copied nothing. Because the rule is to _prove the snapshot exists before mutating_, the script stopped there —
had it run, three mutations would have been applied over a snapshot that did not exist.

**Suite:** full run 249.99s — **2958 files and 29844 tests pass**, 117 files / 850 tests skipped. The only two
reds are `EXPECTED_TEST_FILES` and `EXPECTED_TEST_FILES_ALL`, and the census names its own cause: it counts
**two** untracked test files, one mine and one a peer's, written concurrently. My pins move 3074→3075 and
3251→3252 — the +1 for the file I added, **not** absorbing the peer's, which stays theirs to carry in the
commit that lands it. ⭐ That the guard _names the untracked files_ rather than reporting a bare mismatch is
what made the attribution immediate.

**Also verified, no change.** `routes/auth-cli.ts:132` — "Every failed bind must retire the just-minted key,
including infrastructure/serialization failures" — holds end to end: the key is minted at `:108` and the
compensating `try` opens at `:118` with nothing but a blank line between, so there is no window in which a
throw escapes the revoke; and `apiKeysService.create` cannot throw _after_ its insert, its only post-insert
step being an audit write wrapped in `try { … } catch { /* swallow */ }`.

**Boundary:** these are source-text measurements. They establish which key a constructor is handed and which
function encloses each probe — not that any key decrypts any row, which is what the boot probe itself does at
runtime against a real database.

## V-2119 — two more universal claims verified exact; both of my detector's hits were false positives (2026-08-28)

Closing the universal-claim round (V-2116/V-2118). Recorded so neither is re-checked.

**`routes/account-mfa.ts:2` — holds in all three of its parts.** The claim is unusually precise, and each part
was checked separately against the six live registrations:

- "Every operation that changes MFA credential state requires an interactive web session" — `enroll`,
  `verify`, `DELETE /v1/account/mfa`, `disable`, and `recovery-codes/regenerate` all carry
  `requireInteractiveWebSession`.
- "API keys may read status" — `GET /v1/account/mfa` gates on `requireScope('read')` and is the one route
  without the interactive-session requirement. The exception is real and deliberate, not an omission.
- "Disable and recovery-code regeneration additionally require fresh MFA" — ⭐ the part worth checking, because
  there are **two** disable paths and the claim names "disable" in the singular. Both carry
  `app.requireMfaFresh()`: `DELETE /v1/account/mfa` at `:153` and its `POST` alias at `:169`, which the source
  marks "Same gate, same handler" and which shares `disableHandler`. Regeneration has it at `:189`. A hijacked
  interactive session cannot disable the factor through either path without a fresh one.

⚠️ The second registration block (`registerAccountMfaDisabledRoutes`) re-registers all six paths with **no
gate**, which reads alarmingly in a census. It is the activation-gate stub: every handler is a `stub` that
throws `FeatureUnavailableError`, registered only when MFA is unconfigured, and deliberately unauthenticated so
a stale token yields the real reason rather than a 401 pointing at the wrong problem. Both blocks can never be
registered together — Fastify rejects a duplicate route at boot.

**`services/anthropic-key-tester.ts:32` — "Every failure reason is fixed customer-safe copy: upstream response
bodies, native transport errors, and the plaintext key never enter the result."** Exact. Every `reason:` value
resolves to one of five module constants; the file contains **zero** template interpolations, **zero** reads of
the upstream body, and **zero** references to a native error message. The response body is explicitly discarded
(`void response.body?.cancel()`), and the four `apiKey` occurrences are the two signatures, the empty-length
check, and the outbound `x-api-key` header — none of them a result field.

⛔ **Both of my detector's flagged hits were false positives, found by reading rather than by the detector.**
It reported two `reason:` sites that were "not a fixed constant": one was the `reason: string` **type
annotation** in the interface, and the other a ternary **between two module constants**
(`controller.signal.aborted ? TIMEOUT_REASON : NETWORK_REASON`). A value extractor that matches a type
declaration will accuse every well-typed file it is pointed at.

**`services/email.ts:651` — "Every current call site for these 3 templates only ever sends to a KNOWN,
active account."** Holds across all five call sites, and the direction that matters is enumeration: a
security-critical template reaching an _unknown_ address is an oracle telling an attacker the address exists.
`auth-flows.ts:749` is the one site that passes the raw input `email` rather than a resolved `account.email`,
which is why it was read rather than counted — it sits inside signup, immediately after the account row is
created (the line above binds `accountId: account.id`), and the tracker matches case-insensitively on the
canonical address, so a case difference still resolves. The other three auth-flows sites pass `account.email`.
The fifth, `oauth-client-service.ts:103`, sends the merge-confirmation inside
`if (collidingAccountId !== null)` — the address belongs to an existing account by construction.

**Round tally, stated so the instrument's rate stays honest:** eight claims checked — `lib/errors.ts`,
`routes/auth.ts`, `services/sessions.ts`, `routes/auth-cli.ts`, `lib/boot-key-verification.ts`,
`routes/account-mfa.ts`, `services/anthropic-key-tester.ts` and `services/email.ts` — yielding **one overstated comment corrected** (V-2117) and **one real
latent gap closed with a guard** (V-2118). The remaining five were exact as written. That is consistent with
the rate recorded when the technique was adopted, and materially better than the ranking instruments it
replaced.

## V-2120 — the verification log split a fourth time, cut early rather than late, and the previous archive's name was found to misstate its contents (2026-08-28)

`docs/verification-log.md` reached **1,390,510 of the 1,500,000-byte budget — 92.6%**, with roughly 110 KB of
headroom against my own recent rate of ~21 KB per working session. Entries **V-1707..V-1919** (213 entries,
642,686 bytes) moved to `docs/verification-log-archive-through-v1919.md`, leaving V-1920..V-2119 live at
**747,824 bytes — 49.9% of budget**.

⭐ **Cut early on purpose.** The previous split happened at 1,508,063 bytes — already _past_ the budget, which
the guard's own header says is the wrong moment: past the threshold Prettier does not fail gracefully but dies
inside a V8 out-of-memory stack trace, so the first symptom is _every commit touching the file breaking at
something that does not look like a rule_. The format hook runs on every contributor's commit, so that failure
lands on whoever commits next rather than on whoever filled the file. This cut was made at 93%, while the move
was routine.

**The live file now carries the threshold, the failure mode and the remedy in its own header**, so the next
person to approach the budget meets a sentence instead of an OOM trace. Prompted by A2, who pointed out that
naming the failure mode is worth more than naming the number.

⛔ **Found while doing the split, not by looking for it: the previous archive's name misstates its contents.**
`verification-log-archive-through-v1671.md` actually holds **V-1500..V-1706** — 35 entries beyond the boundary
its name and the live header both claim ("Entries V-1500..V-1671 moved to …"). Verified as a _record_ error and
not a data one: the two files' heading sets are disjoint, V-1672..V-1706 appear in the archive and in no other
file, and nothing is duplicated or lost. Someone looking for V-1690 would read the header, conclude it should
still be live, and not find it.

The cause is worth stating because it is reusable: **a split names the boundary someone intended, then keeps
appending until it executes** — the name and the note freeze the plan, not the result. Both are now corrected
in place at the heading a reader actually stops at, and this split adopts the rule the previous one needed:
**name the archive for the last entry it contains, verified by reading the file rather than the plan.**

**Verified as a post-condition rather than as a derivation**, which is the only check that can see a botched
split: rejoining the archive body and the live body reproduces the pre-split bytes **exactly**; 414 headings in
= 214 + 200 out; zero duplicated numbers; zero lost. The pre-split file was snapshotted first, so the
comparison is against the original rather than against my description of what I did.

**Nothing needed repointing**, which is the earlier splits' design paying off: all three guards that read this
log discover archives by the pattern `/^verification-log-archive-through-v\d+\.md$/` rather than from a list,
the parity guard assembles `[live, ...archives]` before matching, and the live half is probed _structurally_
("must contribute headings that appear in NO archive") rather than by a hardcoded anchor that would rot at
every split. The one place still requiring a manual, literal entry is `.prettierignore`, deliberately — its own
comment records that a glob there would satisfy Prettier while leaving the guard red on a hook that was in fact
fine.

## V-2121 — a suspicion about hardcoded "MEASURED: N" prose in guards, raised and retired; and the crypto-replay mint predicate audited on the money path (2026-08-28)

**The money path first.** `routes/billing-crypto.ts:315` claims "Every other replay state is non-minting:
confirming/partial already has money in flight, and paid/failed/cancelled is terminal." Sound, on all three
things that could make it false:

- The predicate is **consulted**, not merely computed — `mayMintPayment` is declared at `:320` and appears as a
  **conjunct** in the `else if` at `:366`, alongside the provider, callback-URL and floor conditions. A
  predicate computed and never read prevents nothing, and the comment above it records that the broad `else if`
  once minted an orphan provider payment for every non-pending replay.
- Its enumeration is **complete**. The comment names pending / confirming / partial / paid / failed / cancelled
  — exactly the six in `CryptoOrderStatusSchema` and exactly the six in the Drizzle `$type<>` union on the
  column. Two sources of truth, checked separately, in agreement.
- The admission is narrow by construction: `!replayed || (status === 'pending' && payment_id === null)`, so
  even a status the comment failed to name could not mint.

**The suspicion, and why it does not survive.** `database-check-enums-agree-with-the-code.test.ts` carries
"MEASURED at 8 of 10" beside a hand-maintained `NO_EXPORTED_CONSTANT` set, which looked like the shape where a
self-correcting mechanism updates the LIST while every sentence citing it goes false. Two measurements killed
it:

1. ⛔ **The set is bidirectionally self-correcting, which I did not expect.** Its arm forces an unaccounted
   constraint IN, and a second half — "an entry here that has since GAINED a constant is stale, and leaving it
   would suppress a comparison that could now run" — forces a stale one OUT. It cannot drift either way. That
   guard also names its own blind spot in its header: it compares 2 of 10 enumerations and lists the other 8
   individually, "because a comparison that walks only the pairs it happens to find reports everything verified
   while covering two of ten."
2. **The class as a whole is provenance, not enforcement.** 216 `MEASURED`-number claims across 154 guard
   files; narrowing to undated claims whose number appears nowhere in the file's own code leaves 136 (detector
   validated against a known positive first). Sampling those: in every case the number sits beside a **set
   comparison** — `expect(violations, '…').toEqual([])` — or a deliberately slack non-vacuity floor, never
   standing in as the enforcement. `db-schema-matches-the-migrations-drizzle.test.ts` is the clearest: its
   comment records "52 tables and 539 columns" while the assertions are `>= 45` and `>= 500`, and the real
   regression detection is the next arm's table-by-table set comparison. A slack floor is right there: its job
   is to refuse a vacuous pass, not to detect a one-table regression.

⭐ So the numbers are dated-in-spirit records beside a mechanism that enumerates offenders by name — the repo's
own "enumerate the set, never report the size" discipline, one level up. **Suspicion retired, and recorded so
it is not raised again.**

⛔ **Three instrument errors on the way, all mine, all caught before anything was reported.**

- **A comment-stripping regex swallowed 12 of 53 table declarations.** `re.sub(r'/\*.*?\*/', '', t, DOTALL)`
  ate 36,918 characters of `schema.ts`, because the file holds 59 `/*` against 54 `*/` and the regex ran from
  an unbalanced opener to a distant closer. The tell was that ALL FOUR of my counts came out low at once — a
  uniform result is the instrument, not four independent errors in someone's prose. Line-level stripping cannot
  swallow a region and gives 53.
- **`grep -c "\$type<'"` returned 0 on a file I had just read the idiom in**, because the double quotes let the
  shell expand `$type`. A shell error and a true zero are indistinguishable in the output.
- **A character class `[a-z_]+` was my first suspect for the missing tables** and was innocent — checked by
  enumerating what the wider class caught, which was nothing. Worth recording because it is the kind of guess
  that gets "fixed" without ever being tested, leaving the real cause in place.

**Boundary:** the sampling of the 136 is a sample, not a census; it establishes that the idiom is provenance
beside a set comparison in the cases read, not that no counter-example exists. The crypto-replay result is a
source-text audit of the admission predicate and its two enum sources — it does not exercise a replay against a
live provider.

## V-2122 — "which DB guards pass silently when the database is down" is already guarded; my known-positive control was fabricated (2026-08-28)

Reading two integration guards raised what looked like a strong enumerable question: an integration test that
bails when its database is unreachable reports PASSED, so how many of them are green while testing nothing?

**Already guarded, and by a better mechanism than the one I was looking for.**
`an-integration-test-cannot-pass-without-its-database.test.ts` requires every integration file that bails on a
missing handle to also ASSERT the handle was there — so a dead database is a failure rather than a silent pass,
**independent of CI**. Run just now: green, 4 arms. Its own header records the history: 14 files were in that
state when it landed, and a later revision found **18 more that the first version had certified clean**,
because the assertion text it matched sat inside `beforeAll`, where `it()` registers nothing — vitest silently
drops it and the file's registered-test count is one lower than its `it(` occurrences. The scan is now
position-aware. A guard that matches text cannot tell a registered test from dead code in a hook, which is the
same defect it exists to catch, one level up.

⛔⛔ **The lesson worth the entry: my known-positive control was FABRICATED, and it inverted the result.** I
built a detector for "fails closed in CI" and validated it against `database-check-enums-agree-with-the-code`,
which I was certain contained `if (process.env.CI) { throw … }`. It does not. I had read a function named
`guardUnreachable()` with exactly that body in `db-schema-matches-the-migrations-drizzle.test.ts` minutes
earlier, saw the same _name_ called in the other file, and carried the _body_ across. `database-check-enums`
in fact uses a different and equally sound idiom — `if (!process.env.CI && !dbReachable) return;`: skip
locally, fall through in CI and let the real assertions fail, no throw required.

⭐ So when the control came back negative I concluded my detector was broken. **Both readings were wrong.** The
detector reported that file correctly; what was wrong was my belief about the file, and separately the detector
was too narrow — it recognised one of at least two sound idioms.

**Quantified, because a false-positive rate is the only honest description of an instrument:** 131 integration
files carry a reachability bail — 32 use `if (CI) throw`, **60 use the idiom my detector called silent**, 7
mention CI another way, and 32 never mention CI at all (correctly, since the real guard is CI-independent).
**67 of 131 misclassified.** Trusting it would have filed an 82-file list of "guards that pass silently", every
entry of which is fine.

⛔ **And I grepped prior art after building the instrument rather than before.** The guard that already answers
the question surfaced _inside my own detector's output_ — it was sitting in the result list as
`unit/an-integration-test-cannot-pass-without-its-database.test.ts`. The trigger for searching prior art is
naming the subject, not finishing the measurement.

**Boundary:** this establishes that every integration file which bails carries an in-`it()` assertion that its
handle was non-null, and that the guard enforcing it is green. It does not measure whether those assertions are
each _correct_ about the handle they name.

## V-2123 — a documented trip-wire had fired: `closed_reason` is customer-visible, and the file reasoning about its egress leak still called it internal-only (2026-08-28)

Reached by re-running an open note's post-condition rather than by a sweep. A memory from **2026-06-03**
recorded the `session.failed` webhook forwarding the raw driver `err.message` — unsanitized and
length-unbounded — into the customer webhook and the stored event row, filed LATENT because the real driver was
not wired. **86 days is long enough that an open note expires exactly like a clean one**, so I re-checked both
halves.

**The leak is closed, verified at source.** `services/sessions.ts` now derives a failure CLASS
(`classifySessionFailure(err)`, whose fallback arm returns `'unknown'`, so it is total) and renders the payload
from `sessionFailureCopy(class)` — an **exhaustive** switch over four classes with **no default arm**, each
returning a fixed customer-safe string. Checked as a post-condition rather than a derivation: **zero**
`err.message` / `error.message` occurrences remain anywhere in that file. A second layer,
`projectSessionFailedData`, closes the data again before persistence. ⭐ The gating condition never fired
either — `drivers/webkit.ts` still declares "Every method throws `DriverNotIntegratedError`" and all 11 do, so
the fix landed ahead of the trigger. The memory has been marked RESOLVED.

**Re-running the same sweep across the grown family is what produced the finding.** That audit swept three
`enqueueEvent` producers; there are now **seven**. The four added since are all clean, and deliberately so —
`challenge-relay` and `profile-save-failed-relay` both route their free-form field through
`customerSafeNodeDiagnostic` with a comment naming the exact lesson, and `challenge-relay` additionally drops a
frame from a non-owning node. `webhooks.ts` and `bootstrap.ts` are the method definition and a forwarder shim.

⛔ **THE FINDING. `services/agent-session-terminal-close.ts` carried a SECURITY note stating the close reason
"becomes the row's internal-only `closed_reason`", and closing with: "If a future webhook/SDK ever surfaces
`closed_reason`, scrub `direct=` first."** That condition **has fired**. `closed_reason` is now published in
`packages/api-types`, in the OpenAPI spec, in **both** the TypeScript and Python SDKs, returned on the session
resource by `routes/agent-sessions.ts:439`, and interpolated into a customer-facing error at `:4443`.

**The value is nonetheless safe, and the remedy taken was better than the one the note proposed.** Rather than
scrubbing at the sink, `SessionStatusSchema.reason` in `schemas/harness-control-protocol.ts` admits only
`^[a-z][a-z0-9_]{0,127}$`, and `fleet-control-registry.ts:532` `safeParse`s every inbound frame against
`HarnessOutboundSchema` before dispatch. A token matching that pattern cannot carry the `direct=<node-ip>`
diagnostic — the pattern has no `=` and no `.`. The schema's own comment shows the author knew: "persisted
verbatim into customer-visible `closed_reason`, so accept only the emitted snake_case token contract."

⭐ **So two files disagreed about whether a column is customer-visible, and the one that was wrong is the one
whose header reasons about egress leaks.** The remedy moved to the wire boundary and the prose specifying the
trigger was left behind — a guard's self-correction updating the mechanism while the sentence citing it goes
false, one level up. A reader auditing the terminal-close path would be told the value stays inside the system,
and could relax that regex, or add a close path writing free-form text, on that belief. Corrected in place: the
comment now states the exposure, names the enforcing regex and the `safeParse`, and says explicitly that the
value is safe **but not because it stays internal**. No pin froze the old text; the change is comment-only and
`tsc` is clean.

⛔ **Nearly resolved an identifier by name, one hour after writing the memory about it.** `SessionStatusSchema`
exists in BOTH `@driftstack/api-types` and `schemas/harness-control-protocol.ts`. The regex protection only
guards this path if the frame reaching the terminal-close consumer is the protocol one — resolved by reading
the **import** (`import type { SessionStatus } from '../schemas/harness-control-protocol.js'`), not by the
name. Had I taken the api-types definition, the delegation would have been "verified" against a stranger.

**Boundary:** this establishes which surfaces publish `closed_reason` and what the wire schema admits into it.
It does not exercise a hostile node against the live endpoint.

## V-2124 — the V-174 literal-`admin` class is closed AND its detection mask is gone; the note warning about the mask was stale (2026-08-28)

Second application of V-2123's technique — re-running an open note's post-condition rather than sweeping.
Population: 86 memory entries whose description still reads open/latent/deferred, of which most sit in the fork
and harness lanes outside this repo. `feedback_literal_admin_scope_is_latent_v174_bug` is one of the few
scoped here, and it states a post-condition that is testable by grep.

**The finding half holds and the class is closed.** The V-174 split moved `admin` → `account_owner` +
`driftstack_internal_admin`, and the alias runs one way only: `admin` satisfies the two, never the reverse. So
a literal-`admin` gate 403s every post-V-174 session. Re-run at HEAD with both spellings: **zero literal
`throwIfMissingScope(ctx, 'admin')` or `requireScope('admin')` gates remain.** Every `'admin'` occurrence in
`apps/server/src` is on the SATISFYING side — the alias predicate at `lib/errors-helpers.ts:64/86`, the
`ELEVATED_SCOPES` list at `services/api-keys.ts:301`, a seed key's own scopes — or in a comment.

⭐ **The stale half is the one worth recording, because it is the half that governs whether the class can come
back.** The note warned that detection was MASKED: `tests/integration/_helpers/build-test-app.ts` defaulted
`scopes` to `['read','write','admin']`, which satisfies a literal `admin`, so every admin test passed and hid
the bug — and it instructed writing the proving test with the realistic session scopes by hand. **That default
is now `['read', 'write', 'account_owner', 'driftstack_internal_admin']`.** The realistic set became the
default, so a newly-added literal-`admin` gate now fails in tests rather than hiding. The class went from
"fixed but silently regressible" to "fixed and self-detecting", and the note recording the hazard never caught
up.

⚠️ **Stated so the measurement is not read wider than it is:** 30 test files still construct
`['read','write','admin']`. Those are deliberate legacy-key fixtures — schema round-trips, the seed's own
scopes, `db-seed-cross-source-invariant` — not the app-builder default, and they are not a mask. The one that
mattered is the integration helper, and only that one.

**Boundary:** this is a source-text post-condition over `apps/server/src` plus a read of the integration
helper's default. It establishes that no literal-`admin` requirement remains and that the helper no longer
supplies a scope satisfying one; it does not re-derive the alias predicate's correctness, which
`lib/errors-helpers.ts` and its guards already own.

## V-2125 — V-2123's safety argument was under-verified in a way I had the evidence to catch, and the exclusion is proven by execution (2026-08-28)

Addendum to V-2123, from a peer's adversarial check plus my own re-verification. The conclusion is unchanged;
the VERIFICATION behind it was thinner than the entry implied.

⛔ **`harness-control-protocol.ts` declares TWO `reason` fields, and only one carries the strict pattern.**
`:942` is `z.string().min(1).max(512)` with **no pattern at all**; `:1062` is the
`^[a-z][a-z0-9_]{0,127}$` one my argument rested on. If the unpatterned field could reach `closed_reason`,
V-2123's safety claim would have a hole exactly the size of the two-definitions trap.

**It cannot, verified by resolving each to its owning schema rather than by name:** `:942` belongs to
`ControlCommandSchema` (declared `:938`) — operator-supplied text travelling **server → node** for the node's
own logs and audit trail. `:1062` belongs to `SessionStatusSchema` (declared `:1045`) — travelling **node →
server**. Opposite directions, different frames, no path between them. The argument stands.

⭐ **The uncomfortable part: `:942` was in my own grep output when I wrote V-2123.** The command that found
the strict pattern printed both lines. I read the one that confirmed the hypothesis and moved on without asking
which of the two feeds `closed_reason` — the first-matching-row habit, in a session where I had already
recorded twice that resolving by name picks a stranger. Finding a pattern that supports the conclusion is not
the same as establishing that no sibling defeats it.

⭐⭐ **And the exclusion is proven by EXECUTION, not only by reading the regex.**
`schemas-harness-control-protocol-content-parity.test.ts:1536` already parses hostile inputs through the real
schema and asserts refusal — including **`'browser_crashed direct=10.0.0.8'`**, the exact egress payload the
terminal-close note was written about, alongside a space-bearing reason, an HTML one, and the 128/129 length
boundary. So the protection is two-layered and **the layers fail differently**: the content-parity pin catches
an edit to the regex TEXT, while this arm catches any change that lets a diagnostic through — including one
that leaves the pinned line intact and adds an alternative elsewhere. That is adequacy, not redundancy.

**Nothing was built.** The guard I would have written exists, and was found by grepping prior art at the moment
the subject was NAMED rather than after measuring it. Recorded because the outcome of a good check is often
that no code should be added, and that outcome leaves no artifact unless it is written down.

**Boundary:** this establishes that the two `reason` fields belong to schemas travelling in opposite directions
and that the strict one's exclusion of `direct=` is asserted through a real parse. It does not enumerate every
other field in the protocol that reaches a published surface.

## V-2126 — a trip-wire that fires at the right moment but does not say what breaks (2026-08-28)

Third application of the open-note technique. `project_duration_sweep_rearm_audit` (2026-06-03) surfaced two
LATENT findings, explicitly not fixed. **#1 has a testable trigger:** the destroy event's
`max_session_minutes` comes from `minCapFor(cutoffTiers)` at `session-duration-sweeper.ts:114` — the SMALLEST
cap across all capped tiers, applied to EVERY candidate rather than the candidate's own, because the tier is
not carried on `SessionRecord`. Correct **only while exactly one tier is capped**.

**Trigger has not fired:** `MAX_SESSION_MINUTES_PER_TIER` still caps exactly one of eight tiers (`free: 20`,
seven `null`). The finding remains latent and correct today.

⭐ **And the invariant is already guarded — the guard I was about to write exists.**
`an-unbounded-paid-session-is-a-visible-choice.test.ts:111` asserts `capped` equals `['free']` and the cap is
20, reading the table from source, checking the built package agrees, and proving behaviourally that the
sweeper never targets an uncapped tier. Prior art was grepped when the subject was NAMED rather than after
measuring; that ordering has now prevented a duplicate guard four times.

⛔ **THE GAP, and it is a real one: the trip-wire fires at exactly the right moment but does not say what
breaks.** The arm named the consequence **zero** times. Its message frames a red as a product-baseline change —
"recorded here so raising or removing a cap is a deliberate edit against a stated baseline". So the engineer
who caps a second tier reads that, widens the expectation to `['free', 'solo_manual']`, and ships: the guard
did its job, printed a sentence about product intent, and the deferred sweeper defect went live silently. A
guard that fires without naming the consequence converts a stop into a speed bump.

**Fixed in the assertion MESSAGE rather than a comment**, because the message is what a failing run prints: it
now states that adding a cap makes the sweeper record a wrong `max_session_minutes`, names `minCapFor` and the
smallest-cap mechanism, and says explicitly _do not just widen this list — fix the sweeper in the same change_.
The in-code comment carries the deferral's provenance and why the fix is a maintainer's call.

**Mutation-proved on the real subject**, snapshotted by full path and restored under a trap: capping
`solo_manual` at 45 inside `MAX_SESSION_MINUTES_PER_TIER` reds two arms and prints the new message verbatim.
`it(` count unchanged against HEAD (5), `tsc -p apps/server/tsconfig.test.json` clean, file restored
byte-identical.

⛔ **The precondition earned itself again.** The first mutation attempt anchored on `'  solo_manual: null,'`,
which occurs **TWICE** in `common.ts` — a sibling per-tier table carries the same key. The assert-before-mutate
check refused, nothing was written, and the run's "5 passed" came from an unmutated tree. Without it that green
would have read as the guard surviving the mutation, i.e. exactly the wrong conclusion. Re-anchored by
searching for the key _after_ the `MAX_SESSION_MINUTES_PER_TIER` declaration.

**Boundary:** this checks trigger #1 of that note and the message its guard prints. Finding #2 — the poller
retry re-arming a self-re-arming job twice, since `markComplete` throwing after the re-arm leaves `dedup:false`
unable to collapse the duplicate — is untouched and remains a maintainer's call, as recorded.

## V-2127 — the deferred re-arm fan-out fix landed across all seven self-re-arming sweepers; the note deferring it is stale (2026-08-28)

Closes the second half of `project_duration_sweep_rearm_audit` (2026-06-03), whose finding #1 was checked in
V-2126. Finding #2 was recorded as INCIDENT-PRONE and explicitly **not** autopilot work: with `dedup:false`,
a handler that re-arms and then has `markComplete` throw is retried by the poller, re-arms **again**, and both
successors persist because `dedup:false` never collapses them — the sweep then runs at 2×, one extra chain per
recurrence. The note said the documented "single locked executor → one enqueue → can't fan out" reasoning
OMITTED the retry path, and prescribed the robust fix: dedup that excludes the in-flight job while re-arming
back to a deduplicating posture, fixing both chain-death and fan-out — "deliberate review, not an autopilot
flip".

**That fix has landed, and across the whole family rather than the two files the note named.** Every
self-re-arming sweeper in `apps/server/src` now enqueues with `dedupOnAccountAndType: true` — seven of them:
`session-duration-sweeper:232` (the subject), `daily-maintenance-jobs:146`, `scheduled-jobs-prune-sweeper:100`,
`crypto-order-expiry-sweep-job:112`, `account-deletion-purge-sweeper:499`, `agent-session-orphan-sweeper:170`,
and `auth-flows-sweeper:174`. The `dedup:false` posture the finding rested on is gone.

⭐ **And the mechanism is the one the note specified, not merely a flip back to dedup:true** — which would have
reintroduced the chain-death incident that caused `dedup:false` in the first place. `auth-flows-sweeper`
carries it explicitly: the re-arm "uses future-successor dedup. The current/older run-time cohort" is ignored
while future successors still collapse, via `dedupAfterRunAt`; bootstrap omits `currentRunAt` and dedups
against every pending row. That is exactly "the dedup query EXCLUDES the in-flight job", implemented as a
run-time cohort boundary.

⭐ **The stale documentation half is closed too.** The complaint was that the JSDoc's safety reasoning omitted
poller retries. `session-duration-sweeper.ts:174` now states the successor enqueue "survives handler replay
without creating parallel chains" — replay is named rather than assumed away.

**Boundary, stated because it is narrower than the finding:** this establishes the dedup POSTURE at all seven
enqueue sites and that the JSDoc now names handler replay. It does not re-derive that `dedupAfterRunAt`'s
cohort boundary is correct under every interleaving — that is behavioural, belongs to the scheduled-jobs repo's
own guards, and was not re-run here.

**Three of three findings from that note are now resolved or checked** (#1 latent-and-guarded per V-2126, #2
fixed here), so the note's "don't re-audit; the two findings want a maintainer call" no longer describes the
tree. Memory updated rather than deleted, since the audit's CLEAN list is still a useful do-not-re-audit record.

## V-2128 — the walk-swallow ceiling measured the token, not the shape: four single-subject tests could go green on a missing subject, and the guard could not see them (2026-08-28)

Post-condition re-run of `project_walk_swallow_debt_capped_at_89`. A guard-faithful re-scan (same regex, same
walk, same prose filter, run outside vitest) reproduced exactly **92 occurrences / 89 files / 3285 scanned**, so
the ceiling itself held. Then a second instrument that shares nothing with the first — a plain grep over the
shape's family, scoped to `apps`, `packages` AND `scripts` and every test extension — found **93 files**, and the
four-file disagreement was the finding.

**Three blind spots, all in the guard's own key:**

1. Its regex `existsSync\([^)]*\)\s*\)\s*return` cannot match an `||`-joined condition —
   `if (!existsSync(A) || !existsSync(B)) return;` (`docs-sdk-method-coverage-parity:26`,
   `docs-api-method-coverage-parity:40`).
2. Its `readdirSync` pre-filter defined the population as WALKERS, so the identical swallow inside an `it()`
   body that reads ONE subject was invisible (`auth-flow-no-sidebar-baseline:37`,
   `docs-sdk-method-coverage-parity:38`). The auth-flow one points at `apps/customer-dashboard/src/pages` — the
   tree the guard's own header cites as gutted in `ba1a9d270`. A guard whose header documents the exact failure
   it is blind to.
3. Its scan roots `['apps', 'packages']` omit `scripts/`, which `vitest.node.config.ts` executes — two more
   walker sites in `scripts/tests/verify-suite.test.ts` (equality-pinned census, so loud rather than quiet, but
   the shape).

Also found by the family scan and deliberately NOT converted to a throw:
`webhook-signature-verifies-in-every-sdk.test.ts:86/:117` — `!process.env.CI && !existsSync(<toolchain>)`. A
toolchain absent locally is a legitimate reason not to run, but a bare `return` there reads as a PASS, so a local
green said "verified in every SDK" about arms that never ran. They are now `ctx.skip('…')`, which the reporter
shows (proved: a bogus venv path → `3 passed | 1 skipped`).

**Fixes.** The four single-subject sites throw, with the consequence in the message (all 17 subjects verified
git-tracked: 7 pages, the 8 `PAIRS` files, `sessions.ts` + the quickstart). The guard is widened to the family
regex, scans `scripts/` too, and gains a single-subject arm held to `[]` — no exemption, because a legitimate
skip is `ctx.skip`, which has no `return` to match, so the exemption has nothing to rot. Ceiling 92 → 94 is
boundary honesty (+2 from `scripts/`, zero new debt). Matcher controls cover both new shapes and the
`ctx.skip` non-member.

**Mutation proofs — 6 of 6 killed, snapshot-restored, byte-identical after:** an `||` form planted in a
single-subject file plus a block form in an ordinary-named file → single-subject arm red naming both (the block
form alone is named at `agent-executor-stub.test.ts:390`); one more swallow inside a walker under `scripts/` →
ceiling red at 95 > 94; `select-tier.astro`, `api/team.md`, `sdk-typescript/…/sessions.ts` each moved aside →
the fixed test FAILS with its message where before it passed silently; bogus `PYTHON` path → a reported skip.

**Boundary, stated because it is narrower than it reads:** 5 files, 21 tests green, 0 skipped locally (the venv
and Go module both exist here); `it(` counts unchanged except the guard 3 → 4; server test tsconfig clean; the
docs and customer-dashboard test tsconfigs carry their PINNED backlogs (`scripts/typecheck-test-backlog.mjs`)
with ZERO errors in the three files touched — I did not re-derive those backlog numbers. No parity pin quotes any
of the five files. Ratchets untouched (no file added). The 90 walker members remain debt: this closes the
single-subject half, not the walker half.

**Lesson.** A control sharing the instrument is not a control — the guard-faithful re-scan could only confirm
the ceiling; the grep that disagreed by four was the one worth having. And the population's KEY (`readdirSync`)
was coarser than the PROPERTY (a swallow), so the guard reported its key's population as if it were the
property's.

## V-2129 — five open notes re-run by post-condition: three were stale in the code's favour, two still hold (2026-08-28)

The method that has produced every finding this week — re-run an OPEN note's stated post-condition instead of
hunting fresh — applied to the driftstack-api notes in the queue. Each result carries its boundary.

**Stale, closed (the code was fixed; the note was the stale half):**

- `project_agent_sessions_strict_fk_plan` said "NOT yet built". It is: `0080_agent_sessions_driftstack_fk.sql`
  (text → uuid, FK `ON DELETE SET NULL`, idempotent), `schema.ts` `uuid(...).references(sessions.id)`, and the
  create handler in `routes/agent-sessions.ts` normalizes `ses_<uuid>` then `findSession(uuid, ownerAccountId)`
  → 404 — the latent cross-account pointer is closed, not merely integrity-checked. Landed `90aa7a23d`
  (2026-06-16, the same day the plan was written). Tests: `agent-sessions-routes.test.ts` own → ok, foreign
  account → 404, malformed → 400, unwired repo → refused. NOT re-run: the prod `psql` column/FK check (step 6),
  which this box cannot reach.
- `project_sse_no_concurrent_connection_cap` said no stream had a concurrent cap and the public status stream
  had no pre-handler at all. All three are capped: `status-stream.ts` 500 total / 10 per IP before hijack
  (`7369614b1`), transcript per-account (`0d6cdcd51`), notifications `DEFAULT_MAX_SSE_PER_ACCOUNT = 10`
  (`1e6687a77`).
- `project_consequential_approval_redecompose_double_charge_2026_07_07` prescribed Option A — resume the stored
  plan instead of re-decomposing — as a maintainer decision. It landed the next day (`e00849cd1`):
  `reconstructHaltedPlan` rebuilds the paused plan from the `awaitingConfirmation` entry with `tokensConsumed: 0`
  and no usage, so no cost row and no debit; a caller preapproval is never forwarded into a fresh decompose.
  Seven arms in `agent-runtime.test.ts:1534-1802`, including concurrent double-approval dispatching once. Both
  halves of the finding (2× charge, re-plan drift) are closed.

**Still hold (open, and the note is right):**

- `project_agent_runloop_prompt_injection_frame_surfaced` — executor results are still `role: 'agent'` and
  `buildMessages` (`agent-decomposer-claude.ts:389`) still frames `'agent'` as `assistant`; no `observation`
  transcript role exists (the `'observation'` strings in `agent-runtime.ts` are an interrupt-reason kind, a
  stranger with the same name). Two things moved: `operator` entries now map to `user`, and a SECOND
  page-influenced channel exists — the read-back answer from `observePage` → `extractPageText` lands as
  `role: 'agent'` at `agent-runtime.ts:1278`, a model paraphrase passed through `sanitizeTranscriptText`. Bounded,
  named untrusted in code, and the real fix remains prompt-eval-gated — not autopilot work. Memory pointers
  refreshed.
- `project_sse_transcript_connect_race_surfaced` — the transcript SSE still replays the snapshot, THEN subscribes
  (`agent-sessions.ts` replay loop before `transcriptEventBus.subscribe`), so an entry published in that window
  is dropped until reconnect. Low, self-healing, deliberately not restructured alone. Unchanged.

**Also re-confirmed:** `project_profile_saved_ownership_gap_surfaced` (closed 2026-06-17) still holds — the
persister's ownership guard is wired whenever R2 is (`bootstrap.ts` `r2 !== null ? makeProfileSavedPersister(r2,
logger, { agentSessions, profiles })`), six refusal arms in `profile-store.test.ts`.

**Boundary:** every claim above is a grep or a read of the current tree at `6258e4487`, plus the landing commit
found by `git log -S`; no suite run and no behavioural re-derivation of the fixes. Memory: three notes marked
CLOSED with the landing SHA, two refreshed. The tally is seven stale notes across the seven re-runs that YIELDED this week — but two of today's re-runs found the note accurate and the defect still open, so the method's lesson is "the record is the likelier stale half", not "the record is always wrong". Either way the record needs its post-condition re-run on a cadence.

## V-2130 — the route↔OpenAPI spot-check becomes a guard: 254 registered (method, path) pairs against 234 spec entries, 16 undocumented, every one now exempt for a stated reason (2026-08-28)

Post-condition re-run of `project_openapi_route_coverage_spotcheck` (2026-06-03), which found no undocumented
customer route and recorded "NO automated route↔openapi COVERAGE guard" as the open half. `lib/openapi.ts` is
hand-maintained — one `registerRoute` per method + path — and nothing tied it to what `routes/*.ts` register.

**Measured instead of spot-checked.** A static census over `routes/*.ts` + `lib/app.ts`: **311 `app.<verb>`
sites, 254 distinct (method, path) pairs**, against **234 `registerRoute` entries** in the spec. Three
instrument corrections on the way, each caught by a control rather than by luck: (1) `:id` vs `{id}` made 40
routes read as undocumented — normalize both sides; (2) the first matcher missed the generic form
`app.delete<{ Params… }>('/v1/…')`, so **87 documented routes read as "registered nowhere"** — an absurd
result that was the instrument, not 87 phantoms; (3) one site registers a TEMPLATE path in a loop
(`/v1/auth/oauth/${provider}/callback`, google + github), which no literal matcher can see. The guard carries a
completeness arm — every `app.<verb>` occurrence must parse as literal, template, or listed non-/v1 — so a
fourth shape cannot hide the way the second did.

**Result:** 0 spec entries without a route (the spec is honest), and **16 registered-but-undocumented
routes**, every one a deliberate class that nothing pinned: internal fleet control plane (7:
`/v1/internal/atlas-priority/*`, `/v1/mac-nodes*`), inbound provider receivers (2: Stripe, NOWPayments), browser
legs of interactive flows (3, incl. the per-provider template), GUI-client-only (3: `gui-input`,
`gui-control-key`, `transport-report`), the public SSE stream, and **`GET /v1/whoami`** — customer-authenticated,
mentioned in `docs/reference/scopes.md`, absent from the spec. Adding it changes the published contract (W-10
class), so it is recorded as an exemption with that reason, not decided here.

**The guard** (`every-registered-route-is-in-the-spec-or-exempt-for-a-stated-reason.test.ts`, 6 arms):
census completeness + floors (311/254/234 measured; floors 280/230/210) and `path:` entries === paired entries;
every /v1 registration documented or exempt; every exemption still registered AND still undocumented (a stale
exemption is deleted, not kept); no spec phantom; the non-/v1 set is exactly the six infrastructure endpoints;
matcher controls for the generic, nested-generic, template and prose shapes.

**Mutation proofs — 4 of 4 killed, snapshot-restored, byte-identical after:** a planted
`app.post<{ Params… }>('/v1/profiles/:id/archive')` under an ordinary name → offenders arm names it; a spec
entry re-pointed at `/v1/sessionz` → phantom arm AND the offender arm (the real route lost its entry); an
exemption key for a retired route → stale arm; `/v1/whoami` added to the spec → "drop the exemption" arm.

**Boundary:** static text, not a booted app — a route registered through a helper that does not spell
`app.<verb>(` would need to appear in the completeness arm's `unparsed` list to be seen, and today that list is
empty by assertion, not by construction. Paths only; request/response shapes are the existing content-parity
pins' job. One new test file: ratchets 3077 → 3078 and 3254 → 3255. Suite at `25ec86b14` was green with the
full file count before this landed; the executed count for the combined HEAD is A2's full-capture run.

## V-2131 — the V-1228 `id DESC` tiebreaker re-run across its family: four subscription picks could answer differently per implementation and per read (2026-08-28)

Method: take a historical fix's post-condition and re-run it across every sibling, not the one site it named.
V-1228 fixed `latestAcceptancesForAccount` — a `DISTINCT ON … ORDER BY accepted_at DESC` with no tiebreaker,
so a same-timestamp tie was resolved by scan order and the recorded version changed between reads. The
predicate generalises: **any "latest row" pick ordered by a non-unique timestamp.**

**Census:** `DISTINCT ON` appears once in `apps/server/src/db` (the fixed one). `.orderBy(desc(<timestamp>))
… .limit(1)` with no second key appears at **10 sites**; each was read for what a tie would change. Six have
nil consequence by construction and were left alone: the crypto-entitlement stack anchor reads only the max
`expires_at` (a tie yields the same value); three fleet-node picks accept any node with credentials; the
atlas-priority probe is an existence check; the open-incident lookup is dedup-bounded per target. **Four are
material, all subscriptions:** `billing-repo.ts` `findActiveSubscription` / `findCollectingSubscription` /
`findCurrentSubscription` (created_at) and `stripe-webhooks-repo.ts` `downgradeAccountTierToBestRemaining`'s
"most-recently updated active subscription wins" (updated_at).

**Why the tie is reachable:** nothing at the database level limits an account to one live subscription — the
`subscriptions` table has a unique index on `stripe_subscription_id` only; the guard is `billing.ts:201`'s
checkout refusal, an application check a concurrent checkout or a Stripe-side second subscription walks past.
And Postgres `now()` is transaction-start time, so two rows touched in one webhook transaction share
`updated_at` exactly. **Then the two halves of the contract disagree:** the in-memory doubles kept the FIRST
inserted row on a tie (`>` comparison, stable sort) while Postgres returned whichever the scan reached — same
data, different answer per implementation, and per read in Postgres. No contract arm covered it.

**Fix:** `desc(subscriptions.id)` at the four Drizzle sites; the same rule in both doubles (`newerThan` in
`in-memory-billing.ts`, the sort comparator in `in-memory-stripe-webhooks-repo.ts`); a tie arm in each contract
test using V-1228's technique — low id inserted first so scan order AND insertion order both favour the loser,
then assert the greater id (billing: all three lookups; stripe: the surviving tier after a downgrade). The
fixtures gained an optional explicit id (+ timestamp for the stripe Drizzle insert, which otherwise defaults
`updated_at` per statement and cannot tie); the stripe double's `upsertSubscription` accepts a test-only `id`.
Two content-parity pins quoted the old `orderBy` and moved in this commit; `it(` counts unchanged.

**Mutation proofs — 4 of 4 killed, snapshot-restored:** dropping the Drizzle tiebreak in `billing-repo.ts` →
the billing tie arm fails on the Drizzle half (`findActiveSubscription resolved the tie to the lower id`);
dropping the double's tie rule → the same arm fails on the in-memory half; dropping the Drizzle tiebreak in
`stripe-webhooks-repo.ts` → the stripe tie arm fails; dropping the double's sort tiebreak → the same arm on the
in-memory half. Both halves verified to RUN (verbose reporter; the reachability arm was green) against
`driftstack_a3_vitest`.

**Boundary:** determinism, not policy — which of two simultaneously-updated live subscriptions SHOULD win is a
product question this does not answer; it only makes the answer the same everywhere. The "one live
subscription per account" invariant is still not enforced by the database. The six nil-consequence sites are
listed so nobody re-derives them. Gated: pending (this touches `src/db`; full-capture `--all` follows).

## V-2132 — four more historical-fix families re-run at 7ed30d8cb: all clean, each with the layer that makes it so (2026-08-28)

The V-2131 method applied to four more fixes, recorded so nobody re-derives them from a grep that measures
the wrong layer — which is exactly how three of the four would read as findings.

- **Re-entrancy of `tickOnce` sweepers** (from `project_pairmode_sweep_reentrancy_fix`). 14 of 16 sweeper
  classes carry no in-class `running` guard — a dramatic, uniform result, and the instrument. Every one of the
  14 is wired through `wireDailyMaintenanceSweep` / scheduled_jobs, whose locked single executor is what
  prevents overlap (V-2127's family). The five bare-`setInterval` callees in `bootstrap.ts` — pair-mode sweep,
  webhook delivery worker, validation harness, health probe, status snapshot — each carry a `running` guard.
  Overlap is prevented at the wiring layer for one set and the class layer for the other; the grep saw only
  the second.
- **Single-use `consume()` return checked** (from `project_mfa_challenge_single_use_concurrency_fix`). Seven
  call sites; the rate-limit stores read their result; `auth-flows.ts:1037` checks the MFA challenge's `null`
  (the fix); `:984` and `:1016` discard it deliberately — they BURN a corrupt or attempts-exhausted challenge,
  where the return has no meaning. Reading the sites, not counting them, is what separates the two.
- **`${JSON.stringify(v)}::jsonb` double-encoding** (from the postgres-js feedback note). Three production
  CAS predicates use that shape (`agent-sessions-repo.ts` transcript conversion, `recipes-repo.ts` intentLog /
  transcriptSnapshot conversion). Probed against `driftstack_a3_vitest` rather than reasoned: raw postgres-js →
  `jsonb_typeof = 'string'`, equality FALSE (the note is right); Drizzle's `sql` template → `'object'`, TRUE.
  The trap is the raw client in test fixtures; the production sites are correct, and their Postgres-backed
  migration tests asserting `converted: N` are real evidence. The note's scope is now recorded.
- **Lease released with the acquirer's identity** (from `feedback_lease_acquired_with_identity_released_without_checking`).
  The pair-mode takeover lock's `release` takes `clientId`; the in-memory impl compares it and the Redis impl
  is an atomic Lua CAS-DEL. The bundled-turn concurrency slot is a counting semaphore with no identity, and its
  `release` in the route's `finally` is guarded by `bundledSlotAcquired`, so a refused `tryAcquire` never
  decrements — the undercount that would have widened the soft-cap limiter is not reachable.

**Boundary:** each is a read of the current tree plus one direct probe (the jsonb one); no mutation, no new
guard. These are do-not-re-audit records with their reasons attached, not proofs that the wiring cannot change.

## V-2133 — the literal `admin` scope rule becomes a guard: 234 requirement sites, 0 literal, and the helper default that used to mask one is pinned (2026-08-28)

Post-condition re-run of `feedback_literal_admin_scope_is_latent_v174_bug` (2026-08-28): any
`requireScope('admin')` / `throwIfMissingScope(ctx, 'admin')` is satisfied only by a legacy `admin` key — a
customer dashboard session carries `account_owner`, a staff SSO session `driftstack_internal_admin`, and the
V-174 alias runs the other way — so such a route is unreachable for every live credential while every test
stays green, because the integration app helper defaulted keys to `['read','write','admin']`.

**Measured:** 342 source files, **234 scope-requirement sites**, **0** literal `admin` requirements outside
the two alias-predicate implementations (`lib/errors-helpers.ts`, `services/auth.ts`, which must name the
legacy value to alias it). The helper's two defaults now read
`['read','write','account_owner','driftstack_internal_admin']` — the masking is gone. Both halves hold; nothing
pinned either, so the rule lived in a memory note.

**The key is the requirement SHAPE, not the token.** A first census of the bare `'admin'` literal returned the
team-role enum, the OpenAPI `tags: ['admin']` and the alias predicate itself — 20+ hits, none a requirement.
The guard matches `requireScope | throwIfMissingScope | hasScope | scopesSatisfy` with `'admin'` as the scope
argument (closing quote immediately after, so `'admin:billing'` — a real granular scope — is not a member),
skips prose lines, and excludes the predicate files by path.

**Guard** (`no-route-requires-the-legacy-admin-scope-by-name.test.ts`, 3 arms): offenders `[]` with the
consequence in the message and floors on files (300) and requirement sites (150) so a blind matcher cannot pass
on silence; the helper's `scopes: opts.scopes ?? [...]` defaults contain no `'admin'`, re-anchored by count so a
rewritten helper is noticed rather than vacuously passed; matcher controls for all four shapes, spacing, and
the four non-members.

**Mutation proofs:** a planted `requireScope('admin')` on a real route → offenders arm names it; `'admin'`
restored into one helper default → the helper arm names the set. Both snapshot-restored, byte-identical after.

**Boundary:** static text over `apps/server/src`; a requirement passed through a helper parameter
(`app.requireScope(requiredScope)`, 2 sites) is seen only at the literal its callers pass, which today are all
granular or staff scopes. One new file: ratchets 3078 → 3079 / 3255 → 3256.

## V-2134 — the apps/server half of the walk-swallow debt is paid: 17 source-tree sites throw, the ceiling drops 94 → 87, and a fourth shape (`continue`) joins the family (2026-08-28)

Closes the `apps/server` lane of `project_walk_swallow_debt_capped_at_89`, which prescribed the remedy —
make the helper THROW, not add a floor — and warned that every site needs one judgement: does the root always
exist (throw) or is it build output (skip is right)?

**Judgement per site, not per file.** 13 files, 16 `return` sites, read with the roots each helper is CALLED
with, because a helper shared between a required root and an optional one must not throw for both. Every
root was checked to exist AND be git-tracked before its site was converted: `scripts`, `apps/server/src`,
the three SDK source dirs, `apps/docs/src/pages`, `apps/marketing-site/src/pages`, `infra/systemd`,
`infra/env-templates`, `infra/bootstrap`, `docs/{runbooks,deployment,operations,internal}`, the five site
`src/pages` AND `public/` dirs (all five have a tracked `public/`, so `walkAll` throws too), and the consumer
roots. **Kept as skips, deliberately:** `dist-reading-suites-have-fresh-artifacts` walks `apps/<app>/dist`,
gitignored and legitimately absent on a fresh checkout; `every-app-the-guards-read-is-actually-built:51`
returns `true` from a filter with unrelated semantics.

**A fourth shape.** The residual grep on the edited files found `if (!existsSync(x)) continue;` inside loops
over root LISTS — a missing entry is skipped and the sweep over the rest reads as complete. 9 sites in 8
walker files, all in `apps/server`; 0 single-subject. Two read tracked trees (`appRoots`, `DOC_DIRS`) and were
converted; the rest are per-workspace `src/` and `tests/` lookups where absence is a property of the
workspace, not a broken invocation, and stay counted. The guard's regex now matches the loop form, with
controls for inline and block `continue`.

**Result:** 15 `return` + 2 `continue` sites → throws with the consequence in the message ("a sweep over a
missing tree reports nothing to sweep, which reads as clean"), in 11 files. Walker population 94 / 90 → **87 /
85** with the widened family (80 `return` + 7 `continue`); ceiling set to 87 so the judgement is recorded.
12 touched files + guard: 74 tests green, `it(` counts unchanged, server test tsconfig clean.

**Mutation proofs:** `infra/systemd` moved aside → `docs-systemd-facts-match-the-unit-file` fails at load
naming the missing root, where before it passed on an empty unit list; one planted `continue` swallow in
`scripts/tests/verify-suite.test.ts` → ceiling red at 88 > 87. Both restored byte-identical.

**Boundary:** apps/server only — docs (22), customer-dashboard (21), admin-panel (5) remain, and A2 owns the
marketing-site (28) and gui-client members. The 7 remaining `continue` sites and the `dist/` walker are
counted, classified, and not defects.

## V-2135 — the docs, customer-dashboard and admin-panel walkers throw too: 48 sites converted, the walk-swallow ceiling drops 87 → 39 (2026-08-28)

The remaining members of `project_walk_swallow_debt_capped_at_89` in this lane: 22 docs, 21
customer-dashboard, 5 admin-panel test files — every one a single `if (!existsSync(dir)) return out;` inside a
walk helper (48 of 48 byte-identical), every helper called only with a constant root, and every root a
tracked source tree: `apps/docs/src/pages` (+ `api/`, `guides/`), `apps/server/src/routes`,
`packages/sdk-typescript/src/resources`, `apps/marketing-site/src/pages` (read by two docs sweeps),
`apps/customer-dashboard/src` (+ `pages/`), `apps/admin-panel/src/pages` (+ `shells/`). No `dist/`, no
optional root, no `continue` form — the judgement was uniform, and the same lesson applies: the population was
a debt marker, and these 48 were the mechanical part of it.

**Result:** 48 sites → throws with the consequence in the message; walker population 87 / 85 → **39 / 37**;
ceiling set to 39. 48 files + guard: 159 tests green. The three apps' pinned typecheck backlogs
(`scripts/typecheck-test-backlog.mjs`) read 12 / 168 / 94 before and after, with 0 errors in the touched
files — the conversion added no type debt to trees that carry some.

**Mutation proof:** `apps/admin-panel/src/pages` moved aside → 42 admin-panel test files fail at load
naming the missing root (every sweep there walks pages), where before this change each walker returned `[]`
and every emptiness assertion passed. Restored byte-identical; `git status` shows only the intended edits.

**Boundary:** what remains in the ceiling is 7 `continue` sites (per-workspace lookups where absence is a
property of the workspace), the `dist/` walker, the `return true` filter, and the 28 marketing-site + 1
gui-client members A2 owns. The debt marker is now mostly A2's lane plus classified keeps.

## V-2136 — the open owner decisions as of 2026-08-28, consolidated: nine items, each re-verified in the tree today, none autopilot work (2026-08-28)

Every open note re-run this session fell into one of two bins: stale (the fix had landed — V-2129, V-2130) or
genuinely open because it needs a product, contract, DNS or design call. This entry is the second bin in one
place, so the owner reads one list instead of nine notes, and so autopilot stops re-deriving them.

1. **`GET /v1/whoami` is outside the published contract.** `lib/app.ts:1850` registers it (auth smoke
   endpoint, customer-authenticated); `docs/reference/scopes.md` mentions it; `lib/openapi.ts` does not. Adding
   it changes the contract SDKs generate from. Pinned as an exemption with this reason (V-2130). Decision:
   document it, or leave it as an undocumented smoke endpoint.
2. **W-10: 39 declared component schemas with no operation `$ref`.** Frozen by name (V-2081), re-derived at
   39 by a second implementation, growth impossible in silence. Removing them changes the published spec.
   Decision: prune, or keep as documentation-only types.
3. **R2 endpoint has no EU-jurisdiction assertion.** `config.ts:110` `endpointUrl: z.string().url()` only,
   while the Sentry DSN is refined to `.de.` "per data-residency policy" and `docs/deployment/env-vars.md:70`
   calls the bucket "EU jurisdiction". A refine on the endpoint host would turn a misconfiguration into a boot
   failure. Decision: assert it (and which host pattern), or accept that residency for R2 is operational.
4. **DMARC and CAA are absent.** `dig txt _dmarc.driftstack.dev` → empty; `dig CAA driftstack.dev` → empty;
   SPF present. DNS, not repo. Decision: publish a DMARC policy (start `p=none` with `rua`) and a CAA record.
5. **Team invites have no tier gate and no seat cap.** `routes/team.ts:128` `POST /v1/team/invites` is
   `account_owner` + rate-limited only; any tier can invite without limit. Not a security or billing bug —
   members act on the owner's account. Decision: is seat count a packaging dimension.
6. **`/version` exposes `node_version`.** `lib/app.ts:1794`, public, unauthenticated. Low. Decision: keep
   (operational transparency) or drop.
7. **Transcript SSE subscribes after the replay.** `routes/agent-sessions.ts`: replay loop, then
   `transcriptEventBus.subscribe`; an entry published in that window is dropped until reconnect (self-heals via
   `Last-Event-ID`). The note asks not to restructure the critical handler for this alone. Decision: fold
   subscribe-first into the next deliberate SSE change.
8. **Avatar DELETE leaves the R2 object.** `routes/account-me.ts:946` nulls `avatarR2Key` only; the note
   reconciled itself to "open, LOW, do NOT app-side fix" and points at `profile-blob-orphan-sweeper` as the
   precedent if a reaper is wanted. Decision: reap in-app, in infra, or accept orphans.
9. **The agent run-loop still frames executor output as `assistant`.** `agent-decomposer-claude.ts:389`
   maps `'agent'` entries — which include sanitized executor summaries and the page read-back paraphrase — to
   the assistant role; the real fix is a distinct observation role, prompt-eval-gated (V-2129). Bounded by the
   sanitizer, the system prompt's untrusted framing, and the consequential-action gate. Decision: schedule the
   prompt-eval.

**Not on this list, because they closed today:** strict-FK on `driftstack_session_id`, SSE connection caps,
approval-turn double charge, `apiAccess` enforcement, `ws` CVE, `devalue` patch, webhook dual-signing on the
prod path, the snapshot-drift "blocker", and the walk-swallow debt in four of six lanes.

**Boundary:** each item is a read of the tree at `f38d339af` or a DNS query today; none was re-derived from
its note alone. Where a note said "owner call", this entry says what the call is, not what it should be.

## V-2137 — a correction to V-2134's boundary: four of the seven `continue` sites loop over tracked roots, not optional workspace dirs; converted, ceiling 39 → 35 (2026-08-28)

V-2134 said of the seven remaining `if (!existsSync(x)) continue;` sites that "the rest are per-workspace
`src/` and `tests/` lookups where absence is a property of the workspace." I had read two of the eight files
and generalised. Reading the other five: `an-sdk-may-not-say-calling-account-for-an-effective-route` loops
over `SURFACES` (the docs API pages and the three SDK resource dirs), `deployment-docs-env-names-resolve`
over `DOC_DIRS` (`docs/{deployment,runbooks,operations}`), `docs-catalogue-completeness-invariant` over the
docs and marketing pages, `docs-runbooks-file-references-exist` over runbooks + deployment — every one a
tracked source tree, every one a swallow of exactly the kind the guard exists for. Only three are optional by
construction: the two per-workspace lookups in `a-workspace-declares-what-its-source-imports` and the
`package.json` probe in `every-command-the-docs-tell-you-to-run-exists`, which skips a directory that is not
a workspace.

**Fix:** the four convert to throws (roots re-verified to exist and be tracked); ceiling 39 → **35**
(35 occurrences / 33 files), with the guard's measurement comment now listing what the 35 are: 3 optional
`continue` sites, the `dist/` walker, the `return true` filter, and the marketing-site + gui-client members.

**Lesson, the same one twice in one day:** a classification made from a sample and written as if it covered
the population. V-2134's sentence was a claim about seven sites derived from two; the record is corrected here
rather than edited in place. The guard's ceiling was never wrong — it counted them — the prose beside it was.

## V-2138 — one gate run was NOT TRUSTWORTHY and I announced it as green from the wrong line; the re-run is OK, and the cause is a 1-in-2 gui-client teardown race (2026-08-28)

**The misread.** The `--all` run at `44a9e250f` (full capture, 470 lines) showed `Test Files 3256 passed
(3256)` and `32367 passed | 16 skipped`. Two lines below: `verify-suite: NOT TRUSTWORTHY — vitest exited 1;
1 unhandled error(s) — workers that died or never started`. I grepped the counts, not the judge, and posted
"GATED" to A2, who was choosing a prod SHA. Retracted in-channel minutes later; prod stayed on `7ed30d8cb`,
whose judge line reads `OK — exit 0, no unhandled errors, full file count` and was re-read before saying so.
The background task had also reported "exit code 0" because the wrapper's last statement was an `echo`; the
wrapper's own `exit 1` was in the file. Recorded in memory as the third instance of "a filtered view is not
the tool's verdict" — the capture fixed the tail-cut failure and I reproduced it with a grep.

**The cause.** `EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending`,
originating in `apps/gui-client/tests/unit/simulator-window-control-actions.test.tsx` — a jsdom worker
closed its environment while a `console.log` forwarded from the test was still in flight. Zero test
failures; vitest exit 1; verify-suite exit 1. No commit in the window touched gui-client (server tests and
docs only).

**The re-run.** `31c057574`, full capture, judge line verbatim: `verify-suite: OK — exit 0, no unhandled
errors, full file count`; runner exit captured as `rc=$?` before any echo: 0; 3256/3256, 32367 passed, 0
unhandled. So the race reproduced 0 of 1 on retry — a flake, and a flake is a defect: it is recorded here
with the capture path (`suite-44a9e250f.log:212-219` in the A3 scratchpad) for the gui-client owner rather
than re-rolled a third time. The likely shape — a test that logs during unmount or after its last `await` —
is a claim for the owner to verify by reading that file, not one this entry makes.

**Boundary:** the gate at `31c057574` covers the five test/docs-only commits since `7ed30d8cb`; the flake
was not reproduced, so its trigger is unknown; the process correction (judge line first, verbatim; `rc`
captured before echo) is in memory and in this entry, not in a script.

## V-2139 — "gated is not a property of the route registration" becomes a guard: 22 auth-only routes, each pinned to the file and method that asserts its scope (2026-08-28)

Post-condition re-run of `feedback_gated_is_not_a_property_of_the_route_registration`, which recorded the
V-1792 near-miss: `GET /v1/account/audit-log` registers `preHandler: [requireAuth, rateLimit]` with no scope
while every sibling gates explicitly, and that read as "the most sensitive account endpoint is the least
gated" — the enforcement is `throwIfMissingScope(ctx, 'read:audit')` in `services/account-audit.ts`. A
preHandler-only audit yields false negatives, and nothing made the audit read the right layer.

**Measured:** 219 route registrations; **22** with `requireAuth` and no scope in the preHandler. Every one is
enforced below the registration: 17 in a service method (`services/webhooks.ts` ×9 — `read:webhooks` for
reads, `account_owner` for writes, `getWithCounts` delegating to `get`; `services/api-keys.ts` create/rotate/
revoke `account_owner`, list `read:api-keys`; `services/email-preferences.ts` list/set `account_owner`;
`services/account-audit.ts` list `read:audit` for both the list and the export route), 3 by a handler-level
refusal of every non-web-session credential (`mfa/step-up`, `cli-authorize/bind-device-code`,
`oauth/authorize/complete`), and 2 with no scope by design (`/v1/legal/documents`, a public catalogue;
`/v1/legal/required`, the caller's own acceptance status).

**Guard** (`every-auth-only-route-names-where-its-scope-is-asserted.test.ts`, 5 arms): the auth-only
population is computed from `routes/*.ts` (generic-aware registration matcher, `:param` → `{}`) and must be
covered by `ENFORCED_AT` entirely; every entry must still be an auth-only registered route (a route that
gains a preHandler scope or is retired makes its entry stale — delete it); every `enforcedIn` entry's method
must still contain its assertion text and every `handlerRefuses` token must still sit in that handler; floors
on registrations (200) and auth-only routes (15); matcher controls.

**The instrument error on the first run:** five live assertions read as vanished. The services declare an
INTERFACE whose member names match the implementing class at the same indent, and "find `async list(`" hit
the signature first — a body with nothing in it. Resolving a method by name picked a sibling, the same shape
as the day's other misresolutions; the guard now scans every occurrence and passes if any body asserts, with
a control fixture that carries both an interface signature and an implementation.

**Mutation proofs — 3 of 3 killed, snapshot-restored:** the assertion removed from `webhooks.listDeliveries`
→ named by the enforcement arm; `/v1/legal/documents` given `requireScope('read')` in its preHandler → the
stale arm names the entry; a new `requireAuth`-only route planted in `routes/status.ts` → the population arm
names it with the consequence ("callable by EVERY key of the account, including a read-only one, unless
something below the route asserts").

**Boundary:** static text; a service method that asserts through a helper the map does not name would need
the helper's text in the entry; the two "by design" entries are reasons, not assertions, and are the place a
future reader should look first. One new file: ratchets 3079 → 3080 and 3256 → 3257.

## V-2140 — the profileSaved ownership guard's optional parameter is now required: the legacy-wiring door is removed at the type level (2026-08-28)

Post-condition re-run of `project_profile_saved_ownership_gap_surfaced` (closed 2026-06-17 by an ownership
guard) with the "remove the door rather than price it" lens. The guard held — `bootstrap.ts` wires
`makeProfileSavedPersister(r2, logger, { agentSessions, profiles })` whenever R2 is configured, and
`lib-bootstrap-content-parity` pins that call shape — but the third argument was `ownership?:`, and the
factory kept a branch for its absence: no session→node binding, no session→profile binding, no
account-ownership lookup, then the R2 write. `profile-store.test.ts:495` pinned that path as behaviour ("no
ownership deps (legacy wiring): only the R2 write runs"). Production never took it; the next caller could.

**Change:** `ownership: ProfileSavedOwnershipDeps` is required. The three `ownership !== undefined` guards
collapse into the always-taken path; the "retain the ownership-free legacy/test shape" early return is
deleted, so every persister is the bounded, node-authenticated relay. The JSDoc now says why. Six tests that
constructed the persister without deps get an `owningDeps(nodeId, profileId)` helper and pass a matching
reporting node — because with the guard always on, a frame with no `reportingNodeId` is refused, which is the
point. The legacy-wiring arm is deleted (`it(` 27 → 26); all six refusal arms and the two DB-blip arms
stand. `profile-store.test.ts` 26 green, `lib-bootstrap-content-parity` and
`bootstrap-unwired-optional-deps-are-declared` green, server test tsconfig clean.

**Proof the door is gone:** a planted `makeProfileSavedPersister(fakeR2(vi.fn()), fakeLogger())` in the test
file → `TS2554: Expected 3 arguments, but got 2` — the pre-push typecheck refuses the caller before any test
runs. Restored byte-identical.

**Boundary:** no behaviour change for the one production caller; the sole runtime difference is that a
persister can no longer be built in the shape that skipped the guard. The guard's own arms were not
re-derived here — they were re-run and are unchanged. A2 was told before the primitive was touched.

## V-2141 — the 1-in-2 gui teardown flake: mechanism, deterministic reproduction, and the fix (2026-08-28)

**Mechanism (read from vitest 4.1.10 dist, not inferred).** The worker console spy batches every
`console.*` into a microtask flush that calls `rpc.onUserConsoleLog` UN-AWAITED (`chunks/console.*.js`);
`execute()` awaits `worker.runTests`, then `rpcDone()` — which awaits a SNAPSHOT `Array.from(promises)`
(`chunks/rpc.*.js:103`) — then a per-file cleanup rejects every still-pending call with
`EnvironmentTeardownError "Closing rpc while onUserConsoleLog was pending"` (`chunks/init.*.js`). A
console call whose flush lands after the snapshot — a continuation of the file's OWN code firing after
the last test returned — is rejected, and the un-awaited rejection is V-2138's unhandled error.
Per-file, so a cross-file source is structurally impossible.

**Emission (probed, not guessed).** `simulator-window-control-actions.test.tsx` emits nothing in 3
unloaded single-file `--disableConsoleIntercept` runs. A TEMPORARY probe arm deleting
`__TAURI_INTERNALS__` via a 0 ms macrotask while an owned End settled fired the exact class 3 times:
`[simulator] window operation failed (ignored): TypeError: Cannot read properties of undefined
(reading 'invoke')` — SimulatorWindow's `withCurrentWindow` swallow guard. The guard re-checks the
stub at ENTRY only; the dynamic import yields, and a deletion landing in that gap turns a straggler
into the warn. Under full-suite load the first import is real IO — the gap the flake needs; unloaded,
adjacent microtasks close it, which is why single-file runs are silent.

**Fix.** The three simulator-window family files no longer delete the stub in `afterEach` — `afterAll`
would only narrow the race to once per file, so it is not deleted at all; jsdom isolation discards it
with the environment. A pin arm (control-actions) fails if any family file reintroduces a deletion:
token-split pattern, comment-stripped scan — two drafts matched their own regex literal and then their
own title before the third scanned clean (dry-run the checker on the file it will read).
`open-simulator.test.tsx` keeps its inline delete: a test SUBJECT (the non-Tauri branch), not teardown.

**Proofs.** Green 3 files / 23 tests. Mutations, each asserted to differ before the run and restored
from path-keyed snapshots (cmp-verified): deletion reintroduced in the SIBLING (room-ownership) → pin
red naming room-ownership; in the pin's own file → red naming control-actions.

**Boundary:** the fix removes the only identified emission class in this file. If the flake recurs
here, the diagnosis was incomplete — the probe technique (mid-flight deletion on a macrotask)
reproduces candidates deterministically and is where to resume.

## V-2142 — the Playwright e2e arm runs at 9c1030770, and two ways a green gate lies about its environment (2026-08-28)

**The e2e run.** `scripts/e2e-local.mjs` — the one CI job the vitest gate never executes, and the only suite
that drives the real server against real Postgres and Redis through the whole stack — run at `9c1030770`
against the disposable `driftstack_e2e_a3` database (Redis index 12): **233 passed (55.7 s), runner rc=0, zero failed / flaky / skipped** — capture `e2e-9c1030770.log`, 453 lines, final line quoted verbatim. This puts the day's
two src changes — the subscription `id DESC` tiebreakers (V-2131) and the required profileSaved ownership deps
(V-2140) — under end-to-end boot, migration, and route traffic rather than only under vitest.

**Two environment failure classes, from A2's three-run saga at the same SHA, recorded so the class dies:**

1. **A bare environment skips 117 files BEHIND a green judge line.** With no `DATABASE_URL`, the judge still
   prints `OK — exit 0, no unhandled errors, full file count` — "full file count" is COLLECTED — and only the
   conditional next line (`verify-suite: NOTE — 117 test file(s) were collected but never executed`) says the
   run is not comparable. The executed-count claim must come from that line's ABSENCE, read in the capture:
   all four A3 gate captures today carry zero NOTE lines, which is what "3257/3257 executed" stands on.
2. **Sourcing the whole `.env` poisons the suite sideways.** Exporting everything set `MFA_ENCRYPTION_KEY`
   over a database seeded under the suite's defaults, and the two real-boot integration tests died in
   `verifyBootEncryptionKey` ("stored data could not be decrypted with the configured MFA_ENCRYPTION_KEY") —
   a red that looks like an encryption regression and is actually an env-hygiene bug in the runner.

**The recipe both agents now run:** exactly two command-prefix assignments —
`DATABASE_URL=<per-agent disposable db> REDIS_URL=<per-agent non-default index> node scripts/verify-suite.mjs
--all > <capture>.log 2>&1` — nothing sourced, nothing exported, `rc=$?` captured before any echo, the judge
line quoted verbatim from the capture, and the NOTE line checked before any executed-count claim.

**Boundary:** the e2e suite exercises the mock driver (`driver:mock`), not a real fleet box; the bench-regression, python-sdk and go-sdk CI jobs remain unrun locally today; the environment notes describe the two runners on this machine, not CI, whose job sets its own env. An earlier partial e2e run at `670a105f0` (29 tests, killed to keep a timing instrument unloaded) is superseded by this full pass.

## V-2143 — nine marketing-site walkers now throw on a missing root; ceiling 35 → 26, and nineteen members stay by recorded judgement (2026-08-28)

**The judgement, per the debt note's own rule.** The 28 marketing-site members are not uniform: 19
carry a recorded decision — a non-vacuity arm asserting the walk read real files, or prose making the
case for call-site root assertion over a throwing recursive guard (`workspace-tier-slug-sweep`, whose
walk guards every DESCENT, so a throw would also fire on a mid-walk symlink race it deliberately
tolerates; `workspace-readme-links`, which warns against scripted passes by name and whose second
`!existsSync` site IS the assertion). Those files keep their tolerant walk and remain counted
members. The NINE with no judgement recorded (api-reference-resource-coverage,
api-reference-status-group-parity, docs-cli-quickstart-parity, footer-href-integrity,
footer-nav-baseline, header-nav-href-integrity, workspace-api-key-scope-sweep,
workspace-id-prefix-sweep, workspace-image-alt-baseline) share one copy-pasted `walk` over
git-tracked roots only — every root checked tracked before conversion — and now open with the
established `throw new Error` shape (15 prior sites).

**Instrument discipline.** The new ceiling is the guard's OWN scan re-run post-conversion
(26 occurrences / 24 files), not arithmetic — though the arithmetic agrees. A first batch attempt
died mid-run on tier-slug's JSDoc QUOTING the shape (2 matches where 1 was asserted) and was fully
restored from path-keyed snapshots before any judgement was made; the abort is what forced the
per-file read that found the 19 recorded decisions.

**Proofs.** Ceiling test green at 26; a converted file green; mutation A — a converted file's root
pointed at a nonexistent dir → red with the throw text naming the path; mutation B — the swallow
reintroduced into a converted file → the ceiling arm red with "expected 27 to be less than or equal
to 26". Both mutations asserted to differ before running and restored from snapshots, cmp-verified.

**Boundary:** the 5 server/scripts members and the 19 compensated marketing members are unchanged;
their next reduction requires the same per-file reading, not a sweep.

## V-2144 — the pre-launch proxy warn: capture noise became a pinned assertion (2026-08-28)

Every full-gate capture carried 4 unattributed stderr lines: `pre-launch proxy re-test failed; using
the cached verdict TypeError: Cannot read properties of undefined (reading 'invoke')` from
`profiles-launch-stream.test.tsx`. Cause read, not guessed: the file mocks `testProxy` but leaves
`proxy-probe-cache` real, so its Tauri persistence throws in jsdom and `ProfilesView`'s fallback
branch warns — the branch WORKING, printing as noise. Same family as V-2141's cause (an un-stubbed
Tauri call in jsdom), but in-test and harmless.

Fix in the test only: a targeted `console.warn` spy that swallows exactly that message (every other
warn passes through — a blanket silence could hide an unrelated caveat) plus an assertion in the
first launch arm pinning that the message fired. The noise is now a detector: 11/11 green with 0
noise lines (was 4); mutation — the source warn removed — turns the pin red (1 failed | 10 passed),
restored from a path-keyed snapshot, cmp-verified.

**Boundary:** the un-mocked persistence path is unchanged and still exercised; only its console
output is intercepted, in this one file. The message text is now load-bearing in a test — renaming
it in `ProfilesView.tsx` must update the pin in the same commit.

## V-2145 — the bell's durable history: the deferred half of #18, shipped the way the bell's own header prescribed (2026-08-28)

V-1611 built the bell with an in-memory 16-event ring and recorded the boundary in its header: a
durable history "belongs on GET /v1/account/audit-log and is a separate piece of work". This is that
work. Opening the panel now fetches the account audit log (SDK `auditLog.list({ limit: 30 })`) into
its own labelled section — "Earlier — from the account audit log" — below the live feed. The pinned
`NotificationEvent` union is untouched (the header warns it is pinned across three surfaces); audit
rows map through a new pure `auditHistoryItem` (destructive/revoking actions read as warn, the rest
info — critical stays reserved for LIVE events). A 403 renders the explanation ("needs the read:audit
scope on your API key" — enforcement lives in services/account-audit.ts list(), no route change, so
the spec pin and the SSE cap are untouched); any other failure degrades to a quiet line and leaves
the live feed alone. `Shell` builds the callback in its unconditional hook block (it early-returns
below) and the bell stays a reader — no second SSE subscription, no client in the component. Unread
is still the live-feed contract: history rows never light the badge, and that is now pinned.

**Proofs.** 17/17 in the bell file (9 existing + 5 history arms + 3 for the pure 403 mapping, which
was extracted from Shell glue precisely so it could be tested without a render); 3 app-shell files
19/19. Mutations, snapshot-restored and cmp-verified: the bell that never fetches on open → 4 arms
red; the 403 branch collapsed to 'error' → exactly the missing-scope arm red.

**Boundary:** the fetch is on-open only — no polling, no background stream, so the
DEFAULT_MAX_SSE_PER_ACCOUNT interaction does not arise. Click-through navigation from a history row
remains open #18 work.

## V-2146 — bell click-through: a notification row takes you to its answer (2026-08-28)

The last #18 remainder. Live rows whose event has an in-app destination are now buttons:
`cost.threshold_alert` → the billing view, `session.errored` → sessions history. The mapping is a
pure `notificationTarget` in the digest lib (a string union, so the lib stays free of App types) and
two absences are decisions, not gaps: an incident's home is the external status page, and a
high-severity audit event's surface is the bell's own history section — both map to null and render
static. A click closes the panel BEFORE navigating (the destination otherwise renders under it).
History rows are never clickable, and that is pinned. Without shell wiring (`onNavigate` null) every
row stays static, so pure-panel tests and any future embedding are unaffected.

**Proofs.** 22/22 in the bell file (+5 arms). Mutations, snapshot-restored, cmp-verified: the mapping
collapsed to null → the mapping arm AND the button arm red (2 failed); `setOpen(false)` dropped from
the click → exactly the "navigates AND closes" arm red.

**Boundary:** #18 is now closed end-to-end (bell, panel, durable history, click-through, update
notices). Deep-linking a specific session row (sessions-history scoped to the errored session id)
would need a View payload change and is future polish, not a gap in this entry.

## V-2147 — a missing Simulator now installs itself, because the DMG never shipped one (2026-08-30)

**The defect is distribution, not configuration.** The owner hit "Install the Driftstack Simulator
app, then try again" — copy that names an app they cannot obtain. `gui-release.yml` runs
`tauri:build` only and has ZERO Simulator references, so the shipped macOS DMG contains
`Driftstack.app` alone; `Driftstack Simulator.app` is produced solely by `scripts/build-install-gui.sh`,
a dev-local script. `launch_simulator` (lib.rs) hard-requires `/Applications/Driftstack Simulator.app`
and there is no in-app fallback by design (V-1611's "still the same window" saga). So on a clean
customer install the live-view feature is unreachable and the error tells them to go get something
that does not exist. Diagnosed from the owner's own machine: BOTH apps absent from /Applications, and
their running instance was `Driftstack 3.app` under `AppTranslocation` — a quarantined copy outside
/Applications, which satisfies the eye but not the launcher's path check.

**Runtime fix (this entry).** `repair_simulator_install`: idempotent (an existing install returns
without copying), resolves a source through a pure ordered policy — the copy shipped inside the
running bundle's `Contents/Resources` FIRST (the only candidate that can exist on a customer machine),
then a sibling of the running `.app` (dev output; both apps dragged from one DMG) — refuses with a
stated reason when neither exists rather than inventing a path, then `ditto` + an ad-hoc re-sign
(a copied bundle's seal reads "code has no resources but signature indicates they must be present"
and macOS then refuses to open it — the recorded "cant open ap" trap). The launcher, on a
missing-app failure ONLY, repairs and retries exactly once; any other failure is not retried, and a
failed repair surfaces the ORIGINAL launcher reason, not the repair error.

**Proofs.** Rust: 3 arms on the source policy (shipped copy wins; no source outside a `.app`;
first-existing with an injected `exists`) plus one that the repair target IS the path
`simulator_open_args` uses — a drifted constant would "succeed" while the customer stayed broken.
TS: 15/15 in open-simulator, including that a non-installable failure never triggers an install.
Mutations, snapshot-restored and cmp-verified: the repair branch disabled → the self-heal arm red;
the predicate widened to `true` → the narrowness arms red (the retry-loop risk is pinned, not assumed).

**Boundary:** this makes the missing Simulator RECOVERABLE, and on a customer machine it is only
recoverable once the packaging half ships a Simulator copy inside the main bundle — until then
`simulator_repair_sources`' first candidate does not exist there and the repair correctly reports it
has no source. The owner's machine was fixed out-of-band (both variants rebuilt from HEAD, installed,
quarantine cleared, ad-hoc re-signed); that install predates this code, so it exercised the manual
path, not this one. A3's `the-release-workflow-ships-every-app-the-launcher-requires` guard pins the
packaging gap so it cannot be forgotten between the two halves.

## V-2148 — the release DMG ships one of the two apps the launcher requires; the gap is now a pinned assertion that flips when packaging closes it (2026-08-30)

**The finding is V-2147's** (`ca03d60a8`): the release DMG carries `Driftstack.app` alone while the launcher
hard-requires `Driftstack Simulator.app`, so a clean customer install dead-ends at "Install the Driftstack
Simulator app". Verified here independently before anything was written: zero `simulator` references in
`.github/workflows/gui-release.yml` (`tauri-apps/tauri-action@v0`, default config only);
`SIMULATOR_INSTALL_PATH = "/Applications/Driftstack Simulator.app"` in `src-tauri/src/lib.rs` with the
"is not installed" refusal; the companion built only by the dev-local `scripts/build-install-gui.sh`
(`tauri:build:simulator` → `tauri.simulator.conf.json`, product `Driftstack Simulator`, id
`dev.driftstack.simulator`); and five server guards reading the workflow, none pinning its artifact set — the
gap had no instrument. V-2147 landed the self-repair half; the packaging half is the follow-on. This entry is
the instrument that keeps the gap visible between the two.

**The instrument** (`the-release-workflow-ships-every-app-the-launcher-requires.test.ts`, 3 arms, one new file;
ratchets 3080 → 3081 / 3257 → 3258). Keyed off the LAUNCHER's requirement and the manifests, not the word
"simulator": the companion's config path is derived from the `tauri:build:simulator` script, its product name and
identifier from that config, and the launcher must still name that product (literal path or the
`SIMULATOR_INSTALL_PATH` constant) with the refusal copy still present — so a rename moves the pin instead of
detaching it, and if the launcher ever stops requiring the companion the first arm goes red and the pin is
retired. The third arm is the **KNOWN GAP**: it asserts, with the customer consequence in its message, that the
release workflow does NOT reference the companion build. When A2's packaging change lands (companion built in
CI or nested in the main bundle's Resources), that arm goes red and must be flipped in the same commit, citing
this entry — a gap written as an assertion instead of a message.

**Proofs:** 3 arms + the census test green (9 tests); server test tsconfig clean; ratchets verified against a disk census
(3081 `.test.ts` / 3258 with `.tsx`) rather than arithmetic, since A2's `ca03d60a8` landed between the bump and
the commit and added no file. **Mutations, 3 of 3 killed, snapshot-restored byte-identical:** a companion build
step appended to the workflow → the KNOWN GAP arm flips red with the retire message; the product renamed in
`tauri.simulator.conf.json` → the launcher arm fails naming the constant's actual value
(`/Applications/Driftstack Simulator.app`) against the renamed product; the build script renamed →
the derivation throws its re-anchor error before any arm runs.

**Boundary:** static reads of the workflow, the manifests and the launcher source; it does not download a
release or inspect a DMG, so a workflow that builds the companion but fails to upload it would pass the flipped
arm — that half belongs to a release-artifact check when packaging lands.

## V-2149 — two owner-reported GUI defects: a destructive menu that opened on hover, and a page whose own name was its faintest text (2026-08-30)

**"the clear shouldn't be hover but click to expand".** The profile card's `Clear…` disclosure opened
on `onMouseEnter` (and on `onFocus`). The rows underneath are the destructive ones — clear cookies,
clear history, clear everything — so a pointer merely crossing the word "Clear…" slid one of them
under the cursor, and a keyboard user tabbing past expanded it without ever choosing to look. Both
handlers are gone; the button toggles on click (Enter/Space when focused), which is what a disclosure
button promises. It still stays open once opened — that part was deliberate and is unchanged: a
submenu that retracts while the pointer travels toward it turns a careful click into a mis-click.
The doc comment that argued FOR hover was rewritten in the same edit rather than left contradicting
the code.

**"isn't properly viewable at settings tab page, the top Settings label".** The Settings hero rendered
the page's own name with `.section-label` — 10px, `tracking-widest`, uppercase, accent — above a 24px
`API connection` heading. That treatment is right for a divider INSIDE a page and wrong for the title
OF one: the page read as "API connection" and the word "Settings" was the least legible text on it.
Now 12px semibold with tighter tracking, and the loading skeleton was changed identically so the
title does not resize when the real hero replaces it. No layout bug was involved — the Save block is
`ml-auto` in the same flex row and never overlapped; this was a typographic hierarchy error, checked
before changing anything.

**Proofs.** 3 suites green (profile-phone-card, profiles-lifecycle-actions, SettingsView) — 49 passed
| 6 skipped. New arm asserts hover does NOT expand, focus does NOT expand, click expands, click again
collapses. Mutation, snapshot-restored and cmp-verified: `onMouseEnter` reintroduced → that arm red.

**Boundary:** the label change is scoped to the Settings hero and its skeleton; the other 101
`.section-label` uses are untouched, since a section divider at 10px is the size it should be. Whether
the remaining page heroes deserve the same promotion was not measured here.

## V-2150 — the input-receipt deadline follows the measured link, so a proxied session stops being called dead (2026-08-30)

**The last genuinely open piece of the "Device did not confirm the last input" work.** The receipt
budget was a flat `INPUT_RECEIPT_DEADLINE_MS = 5_000` for every input on every link, while
`livekit-latency-ping.ts` was already measuring RTT two feet away and showing it to the customer. A
proxied mobile session — the product's ORDINARY case — can sit at 1.5s RTT, where a tap's round trip
(publish → apply → ack) does not fit in 5s, so the badge accused the device of losing input it had
applied.

`receiptDeadlineForRtt` is pure and **monotone upward**: `3 × RTT + 2s` device budget, floored at the
old flat 5s and capped at 30s. The floor matters as much as the adaptation — shortening the budget on
a fast link would trade the slow-link false alarm for a new one, so a fast link keeps exactly what it
had, and an unmeasured link (`null`, a stale ping, a just-connected room) also keeps it, because an
unmeasured link is not evidence of a slow one. The cap matters too: past it the badge stops being a
latency report and becomes a way to never say anything, which is the failure it exists to prevent.

Wiring: the ping writes each sample to a per-Room `WeakMap` (`noteRoomRtt`) that the receipt layer
reads. Per-Room so two rooms cannot borrow each other's link quality; a WeakMap so a closed room's
sample cannot keep the room alive. Staleness and disconnect both clear it, using the same events that
already blank the displayed reading. An explicit `deadlineMs` still wins outright, so bulk text — which
scales with character count — cannot be shortened by a fast link.

**Proofs.** 19/19 in livekit-input-ack (7 new arms: never-shorter; 1.5s → 6.5s; capped; nonsense
samples ignored; per-room isolation + clearing; a registered receipt still open at the OLD deadline
and expiring at the new one; an explicit budget unshortened), plus 3 latency-ping suites 9/9 green.
Mutations, snapshot-restored and cmp-verified: adaptation flattened → 4 arms red; the cap removed →
exactly the cap arm red.

**Boundary:** the multiplier and device budget are judgement, calibrated to the shape of the failure
(one round trip plus apply time) rather than measured against a distribution of real sessions — if
the badge still cries wolf on a slow link, those two constants are where to look, not the mechanism.
The other three items of this arc were checked and left alone: the miss decay already exists, and the
eviction-counts-a-miss and strict-ack-shape behaviours are RECORDED decisions with their reasoning in
the source, not oversights.

## V-2151 — two labels that told the customer nothing useful (2026-08-30)

**The Simulator error told them to do something impossible.** "Install the Driftstack Simulator app,
then try again" survived V-2147, which established that the app is not distributed on its own — the
macOS DMG ships `Driftstack.app` alone. Worse, after V-2147 the only way to REACH that sentence is
for the automatic install to have run and found no copy to install, so the message was stale twice
over. It now names the real state and the one action that can fix it: "The Simulator app is missing
and could not be installed automatically. Reinstall Driftstack from your download, then try again."
Nothing else in source pinned the old sentence (only stale `dist/` and `target/` artifacts).

**A page hero that said its own name twice.** `TeamView` rendered a "Team" eyebrow directly above a
"Team" heading. Measured before touching it: 12 view heroes use the eyebrow pattern and 11 are
CORRECT — the eyebrow carries a category the title does not ("Network" above "Connectivity test",
"Diagnostics" above "Logs"). Only Team duplicated, so only Team changed. This is the same defect
class as V-2149's Settings hero but the opposite fix: there the page's name was demoted to the
eyebrow, here the eyebrow added nothing to the name, and a sweep over all 12 would have damaged the
10 that were right.

**Proofs.** simulator-open-error 7/7 with the new sentence pinned in its table; 3 suites / 24 tests
green across the touched views.

**Boundary:** the copy change is a customer-facing string, so the sentence itself is now load-bearing
in that test table — changing it again means changing both in one commit.

## V-2152 — the Claude 5 models, and the CHECK constraint that would have rejected them in production (2026-08-30)

The picker offered four models, all 4.x, because the registry had not been touched since the Opus 4.8
bump. Added `claude-opus-5` and `claude-sonnet-5`, listed first (that order IS the picker order on
every surface), and bumped `DEFAULT_AGENT_MODEL` to Opus 5. Every 4.x id stays selectable AND stays
accepted forever: `agent_sessions.model` holds them on existing rows, and an id the schema rejects
cannot be read back.

**⛔ The part that would have broken production.** The allowed set is not only a zod enum — it is a
Postgres CHECK constraint, `agent_sessions_model_check`, created in migration 0087. Editing the
TypeScript enum alone leaves the database rejecting every insert naming a 5-generation model, and the
failure lands at session-create time in front of a customer, not in a test. Migration 0115 follows
0087 exactly: DROP IF EXISTS + re-ADD with all six values (additive — no existing row violates it),
then moves the column default. The journal entry was added in the same commit because `.husky/pre-push`
blocks a migration without one. The schema comment now says the CHECK lives in the migration, so the
next person to add a model finds out before shipping rather than after.

**⚠️ The rates are PROVISIONAL and this is the honest part of the entry.** `CLAUDE_MODELS` carries
cost-to-serve rates that are Anthropic list price. I did not have verified 5-generation list prices,
so Opus 5 carries the Opus 4.x rate and Sonnet 5 carries Sonnet 4.6's, flagged in the source with the
same treatment 4.8 got on its own bump. This is internal accounting only — it does not touch customer
pricing — but it will under- or over-state margin until someone confirms the real figures. That is a
known-wrong number shipped deliberately and labelled, not an oversight.

**Surfaces updated in the same commit** (the registry is a cross-source invariant): api-types registry,
migration + journal, schema default/comment, the GUI picker list + type union + default, the TS/Python/Go
SDK unions and docstrings, the customer docs model lines and default sentence, the regenerated
`openapi.json` and Python `_generated/models.py`, and six parity/behaviour tests that pinned the old
list or the old default.

**A trap worth recording:** the first `sdk:python:dump-spec` produced a spec with ZERO new values. The
server consumes the BUILT `@driftstack/api-types`, not its source, so the spec was regenerated from
stale `dist/`. `npm run build:packages` first, then dump — otherwise the generated artifacts silently
disagree with the source that is supposed to define them.

**Proofs.** Ten model-touching test files run individually: api-types parity 5/5, openapi parity 15/15,
docs parity 14/14, TS-SDK parity 21/21, Python-SDK parity 14/14, cost tracking 12/12, response-schema
parity 9/9, decomposer 64/64, runtime 81/81, plus the two GUI model files.

**Boundary:** `claude-fable-5` was deliberately NOT added. The registry id is sent verbatim as the
Anthropic `model` field, so an id a customer's BYOK key cannot access fails at turn time; Opus 5 and
Sonnet 5 are the two the owner named. The DB CHECK now permits six ids — adding a seventh requires
another migration, not just an enum edit.

## V-2153 — a Bing tab silently became a second "New Tab" (2026-08-30)

Owner: _"when opening new tab, sometimes the previous tab title is false, and changes to the same tab
name, for example it had bing and new tab, and both were called new tab on opening."_

**Mechanism, read end to end.** The strip labels a tab from its URL, not its title
(`SimulatorWindow.tsx` `label()`): a blank-tab URL renders "New Tab" whatever the stored title says.
Page-state frames from the REST poll carry no `tabId` in production, and `resolvePageStateTabTarget`
routes a tabId-less frame to whatever tab is active _right now_. The protection against a lagging
frame is a grace window in which a frame whose URL is already held by a DIFFERENT tab is discarded as
that tab's stale poll. Two holes let the frame through:

1. **The grace was never armed on the two revert paths.** All four forward transitions
   (tabListRestore, new tab, close tab, activate tab) armed `lastSwitchAtRef`; the reject-revert
   (`activateTabResult{ok:false}`) and the congestion-revert did not — even though the code's own
   comment at the reject site says the box is publishing the rejected tab at that exact moment. A
   revert IS a switch, and it left the reverted-to tab unprotected precisely when a frame for the
   other tab was in flight. Both now arm it.
2. **The window was smaller than the thing it guards.** `PAGE_STATE_GRACE_MS` was 2500ms while a
   switch can take `ACTIVATE_ACK_TIMEOUT_MS × ACTIVATE_MAX_ATTEMPTS` = 3600ms and the affordance waits
   `SWITCH_AFFORDANCE_TIMEOUT_MS` = 6000ms, because a cold tab is a real page load on the device. It
   is now derived from that timeout (`SWITCH_AFFORDANCE_TIMEOUT_MS + 500`) instead of being an
   independent literal that could drift out from under it again.

The damage was not cosmetic: the frame writes `url` AND `title`, so tab 1's real title was destroyed,
never re-derived. It was also self-fulfilling — clicking the renamed tab afterwards asks the box to
navigate it to the new-tab page, because the activate path maps a blank-looking URL to `NEW_TAB_URL`.

**Why "sometimes":** it needs the grace to have lapsed, which is why it tracks slow/cold switches.

**Proofs.** 57/57 in simulator-window-tabs with a new arm that reproduces the owner's exact sequence
(real page → "+" → back to tab 1 → 5s → tab-less frame carrying the OTHER tab's url) and asserts tab
1 keeps both its url and its title. Mutation, snapshot-restored and cmp-verified: the grace put back
to the literal 2500 → exactly that arm red.

**Boundary:** this closes the routing hole for tab-less frames during and after a switch. The
investigation also surfaced three adjacent weaknesses left UNFIXED and unmeasured here — `onNewTab`
does not publish `tabsRef.current` synchronously the way close/restore do, `emitTabList` is called
from inside a `setTabs` updater (an impure updater React may defer or double-invoke), and
`updateActiveTab` reads `activeTabId` state rather than the synchronous ref every other writer uses.
None is needed to explain this report; each is a real race worth its own entry.

## V-2154 — "no exit IP, everything empty": the identity was captured by a peek that raced the socket (2026-08-30)

Owner: the Simulator's new-tab panel shows _"no exit ip, everything empty"_.

**The panel is not the marketing page.** `https://driftstack.dev/newtab/` is a SENTINEL: the fork
intercepts it before egress and serves a box-local page whose fields come from
`DRIFTSTACK_EXIT_IDENTITY_JSON`, injected as `window.__DS_EXIT_IDENTITY`. Empty fields therefore mean
that env var was never set — the marketing page is irrelevant to this report.

**Root cause.** The env var is sourced from `SessionAssign.exit_identity`, which the control plane
fills from the exit-identity cache, which is written in exactly one place: the pre-launch connectivity
probe. That capture read the body with `snapshot()` — a NON-awaiting peek of whatever bytes happened
to be buffered the instant the STATUS LINE parsed — justified in a comment by "a tiny Connection:close
response arrives in one TCP segment". Through a real remote proxy with a TLS upgrade that does not
hold: headers and body land in separate records, the parser (which needs the complete header block, a
content-length, AND the whole body) returned undefined, and nothing was cached. The result is not a
transient glitch — the identity is baked into the fork's environment ONCE at launch, so a single
missed capture leaves every new tab in that session reading "No exit IP" for the session's entire life.

**Fix.** `awaitTail(done, capMs)` waits — bounded, non-consuming, and unable to throw — until the
response is complete, the peer closes, or 1.5s elapses. The connectivity verdict is already decided
when it runs, and that invariant is the reason for every one of those properties: waiting for a panel
field must never turn a working proxy into a failed launch.

**The stopping condition is completeness, NOT parse success** — and getting that wrong first is worth
recording. My initial predicate waited for the identity to parse, which stalled the full 1.5s on any
complete body without an `ip` (our echo answers `{}` when Cloudflare's visitor-location headers are
off) and broke an unrelated auth arm by adding 1.5s to it. A finished answer is not a slow one.

**The miss now names itself.** A 200 whose response never completed returns a `detail` distinguishing
"headers did not arrive" (a race) from "no content-length / chunked" (a permanent outage — chunked
fails the parse every single time, and the two must not look alike). A complete body carrying no `ip`
is deliberately NOT dressed up as a capture failure: that is the echo endpoint's own answer, with a
different cause.

**Proofs.** 33/33 in proxy-connectivity-probe, including two new end-to-end arms driving a real fake
SOCKS5 proxy whose origin writes the head first and the body 120ms later — the exact shape the peek
could not see — plus one asserting that a body which NEVER arrives still passes the probe with the
verdict intact. Mutation, snapshot-restored and cmp-verified: `awaitTail` reverted to `snapshot()` →
exactly the late-body arm red. exit-identity-cache 19/19 unaffected.

**Boundary:** this fixes the CAPTURE. The investigation named four other paths to the same empty panel
that this does not touch, each real and each needing its own decision: a session with no customer
proxy omits the block entirely; VPN egress schemes are never probed; the cache TTL is 15 minutes, so a
create→dispatch gap longer than that is a miss; and even on a HIT, `region`/`city`/`timezone` are null
unless Cloudflare's visitor-location transform is enabled — a live proxied capture on 2026-07-06
recorded exactly those nulls, which renders Location blank on the device.

## V-2155 — a node-scoped harness errorEvent was dropped with no log line; the api-side half of "the load just stops, no error code" (2026-08-30)

The owner's most frustrating live report: a page load that fails and "just stops — no error code, nothing".
The harness half is A2's/A1's; this is the api half, traced read-only before anything was changed.

**Two lanes carry a failed load to the customer, and one of them was leaking.** (a) `pageState`: the harness
sends `state: 'errored' | 'stalled'` with `error{kind,message}`; `session-page-state-store` scrubs it and
`GET /v1/agent-sessions/:id/page-state` serves it; the GUI renders per-kind copy (`page-error-copy.ts`,
`SimulatorWindow.tsx:4230-4290`). Complete end-to-end — and `SimulatorWindow.tsx:306` records that the
harness emits `page_state.errored` ONLY for a main-frame navigation failure, so a load that produces neither
`errored` nor `stalled` reaches the GUI as silence by construction: that is the harness-side question. (b)
`errorEvent`: `session-error-event-relay` persists it on the agent session (`last_error_event`: code,
scrubbed summary/detail) and publishes `session.errored` with the code only (the toast says "Session X hit
`<code>`"). But `errorEvent.sessionId` is optional, and the relay's entry was literally
`if (frame.sessionId === undefined) return;` — a node-scoped failure (a driver fault the box does not
attribute to a session; a cold tab open is a plausible shape) vanished with no persistence, no notification
AND no log line. The test arm pinned the first two as intended ("drops … without customer mutation or
notification"); nothing asserted the third, so the server log was empty exactly when an operator would read it.

**Change:** the drop now logs one `warn` — component, reporting node, code, severity, actionable/retryable —
and never summary/detail, which the forward-guard on this relay exists to keep off customer state because they
can carry the node's own IP. Persistence and notification are unchanged (still none). The existing arm gains
the assertions: a second warn, its message prefix, the node and code in its context, and NO summary/detail
keys. 9 arms green, server test tsconfig clean, `it(` count unchanged.

**Mutation proof:** the silent `return` restored → the arm fails at `toHaveBeenCalledTimes(2)` ("no warn for
the node-scoped drop"); relay restored byte-identical, 9/9 green.

**Boundary:** a log line, not a customer signal — the node-scoped event still cannot be shown to a customer
because the api does not know whose it is. Whether the harness attaches `sessionId` to tab-open failures, and
why a failed load can produce neither `errored` nor `stalled`, are the harness questions that decide the
owner's report; this entry only guarantees the server log stops being blank. Single-file run only — the full
gate is held behind A1's capture loop.

## V-2156 — the Simulator's clock showed the operator's time, not the session's (2026-08-30)

Owner: _"Timezone at the simulator thats showin is puttin the host's time, instead of the one from the
iphone (the matching proxy IP timezone set inside browser)."_

A profile egressing through Amsterdam displayed the operator's Mac clock. That is the one element on
screen contradicting everything the fingerprint asserts — the fork exports the geo-resolved `TZ` to
the WebProcess, so the PAGE reports the proxy's zone while the chrome above it reported ours.

**It was a plumbing gap, not a wrong calculation.** The value already existed: the native
`proxy_exit_probe` returns `geo.tz`, `CachedProbe.exitTimezone` persists it to disk, and both launch
paths already read `exitCountry` from that same cached record. Nobody ever read the field next to it.
The Simulator is a SEPARATE app bundle with its own store and cannot read the main app's probe cache,
so everything it knows arrives in the launch handoff query — which carried `cc` and no zone. Added
`tz` to the handoff, `timezone` to `SessionQuery`, and threaded it into `IosStatusBar`;
`formatStatusTime` now formats through `Intl.DateTimeFormat` with that zone.

Fallback is deliberate and unchanged in shape: an absent, empty or unrecognised IANA id falls back to
host time rather than blanking the strip. A stale probe or an unmappable geo must not cost the clock.

**Proofs.** 20/20 in simulator-window with two new arms — the clock formatted in `Asia/Tokyo` matches
`Intl` for that zone (with a non-vacuity guard: the "differs from host" assertion only runs when the
host zone actually differs right now), and absent / empty / garbage zones all still render `h:mm`.
open-simulator 15/15 and simulator-window-tabs 57/57 unaffected. Mutation, snapshot-restored and
cmp-verified: the zone branch disabled → exactly the Tokyo arm red.

**Boundary — the value shown is the CLIENT's probe, not the harness's resolved zone.** The client
probe reads lumtest through the proxy; the zone the browser actually applies is resolved server-side
(Cloudflare `cf-timezone` → country-representative fallback → archetype default) and handed to the box
in `sessionAssign.exitIdentity`. Those can disagree, and the client's can be null where the server's
is not. This makes the clock right in the ordinary case using data already on the machine; making it
provably identical to what sites see needs the server's resolved value exposed to the GUI, which is a
new route or data-channel frame and is NOT done here.

## V-2158 — the planner was instructed to give up: "keep plans short" plus "always end with a capture" (2026-08-30)

Owner, on a signup task: _"it just goes to drifstack.dev and finishes up"_ — and separately, on the
"warm up this profile … browse naturally, scroll, read, follow a few internal links, pause between
pages" preset: _"it feels kinda very slow, need to ensure it really can use all things we have for
undetectable automation and is well instructed."_ The pasted transcript is one shape twice: `navigated
→ wait → wait → captured screenshot`, then done.

**That is what the prompt asked for.** The tail read _"OTHERWISE: emit a plan. Keep plans short (1-8
intents). Always end a plan with a capture intent so the customer gets something back."_ Two
instructions that compose into giving up: stay well under a small budget, and finish with a
screenshot. A navigate-wait-capture satisfies both perfectly while accomplishing nothing.

**The ceiling is not the problem.** `MAX_PLAN_INTENTS = 8` is enforced by the parser, which truncates
rather than throwing (a deliberate earlier fix: an over-long plan continues on the next turn instead
of discarding a paid turn). So the model does not need to be talked down to 1-8 — the cap is
structural. The prompt's job is to say the budget should be SPENT, and that a plan is one step of a
task that spans turns.

Rewritten to say exactly that, and to instruct the human-cadence verbs rather than merely listing
them: `behavioral_pause` between and within pages, multi-step scrolling instead of one jump, and
following in-page links rather than typing every destination — because a burst of navigations with no
reading time is the most obvious automation tell, and for an open-ended "browse naturally" task the
pauses and the scrolling ARE the task.

**Proofs.** Parity 20/20 with the pin rewritten in the same commit (it pinned the old sentence
verbatim); decomposer 64/64 and runtime 81/81 unaffected. Mutation, snapshot-restored and
cmp-verified: the new framing replaced with "Plans should be short." → the pin red.

**Boundary — this does NOT add autonomous continuation, and that is the larger half of the owner's
report.** One customer message is one turn is one plan; there is no loop that keeps going until the
task is done. A long flow still needs the customer to say "continue". This change stops the agent
from stopping EARLY within a turn and makes open-ended browsing behave like browsing; it does not
make a signup flow complete unattended. A step-budgeted continue-until-done loop is a separate piece
of work with its own cost-control questions, and it is not started.

**Also NOT fixed here, same report:** _"it seems to have no memory still when returning later to the
same chat."_ Diagnosed, not repaired — `use-agent-chat` closes the server session in an unmount
effect (deliberately, so leaving the view does not strand a running session and its dispatched Mac
until the reaper). Coming back therefore creates a NEW session with an empty transcript, which is
precisely why the agent answered _"I don't have a previous task on record in this session."_ The
supporting evidence is in the owner's own paste: per-turn token counts stay flat at ~1.2–1.5k across
the conversation, so history is not accumulating. The fix is the scoped `continue_from_agent_session_id`
revive (transcript copied into the new session under a re-derived envelope), not simply leaving the
session open.

## V-2159 — one warn every 3 seconds, for the life of every session (2026-08-30)

The owner sent a LiveKit log to investigate. Most of it is `Playout delay not supported in this
browser`, repeating every ~3s from connect to disconnect — hundreds of lines burying everything else
in the file they were trying to read.

**Ours, not the SDK's.** The adaptive playout controller samples RTP stats every 3s and re-asserts
`track.setPlayoutDelay(delay)` (deliberately idempotent: a resubscribe resets the track to 0). But
livekit-client's `setPlayoutDelay` does NOT throw when the browser lacks the hint — it checks
`'playoutDelayHint' in this.receiver`, logs that warn, and returns. So the `try/catch` wrapped around
the call, commented "setPlayoutDelay unsupported — ignore", never fired once: the SDK had already
logged by the time control returned.

Worse than noise: on such a browser the entire controller is dead weight — a `getRTCStatsReport()`
every 3 seconds, parsed, fed through the control law, to produce a value nothing can apply. The
Simulator's engine is WebKit, which has no `playoutDelayHint`, so this ran forever in exactly the
place the product spends its time.

`playoutDelaySupport()` mirrors the SDK's own test, and the tick stops the interval outright the first
time it answers `false`.

**The `null` case is the load-bearing part.** A track with no receiver yet is NOT unsupported, it is
unsubscribed — reading those the same way would kill the controller on every session before it ever
ran, turning a logging fix into a media regression. That distinction is what the mutation targets.

**Proofs.** 13/13 in livekit-adaptive-playout (5 new assertions across two arms), 47/47 in
agent-session-panel. Mutation, snapshot-restored and cmp-verified: absent receiver → `false` instead
of `null` → exactly the null arm red.

**Boundary:** this removes the repetition and the wasted sampling; it does not add playout adaptation
to WebKit, which cannot do it. The rest of the owner's log — rooms connecting then disconnecting
within seconds, and `[flight-recorder] previous run ended without shutting down` — is NOT explained by
this entry and remains uninvestigated.
