# AI pace modes (slow / medium / fast) — plan of record

**Status:** design, reviewed adversarially, NOT built. Read-only work: nothing here was run.
**Origin:** the owner's idea, 2026-09-20 — a slower AI does more reading and pausing, a faster one less.
**How this was produced:** three independent designs, a judged synthesis, then an adversarial critic whose fifteen
findings (C1–C15) are folded into the text below. Citations were checked against committed code at `dc0f83c86`;
line numbers drift, names do not.

**Two facts that changed after this was written, both on 2026-09-20:**

1. §1's open question is answered. The device team confirmed the field is resolved as a persona name or a speed
   modifier, and `'default'` is neither. `b1a1a2e47` stopped sending it: AI sessions now send
   `DEFAULT_BEHAVIORAL_PROFILE` (`regular`), and the dispatch config is typed from `DEVICE_BEHAVIOR_PROFILES`.
2. The device team also corrected a premise used in telemetry: a result's `behavioral` flag means "a persona was
   attached" (`persona != nil`) — configuration, necessary and not sufficient. For scroll the same predicate selects
   the flick-planned path over the flat segmented one; BOTH are native touch sequences. Report the path, never alarm
   on it.

**Open design question this plan leaves to the device team (ask 2):** whether our `pace` should ALSO select their
speed modifier (`slow → careful`, `medium → balanced`, `fast → fast`) through `SessionAssign.behaviorProfile`. Until
they say what the modifier scales, every pace keeps the `regular` persona and pace is server-inserted time only.

## 1. The finding that may outrank the feature — and the caveat on it

`SessionAssign.behaviorProfile` is documented as polymorphic: a direct person name (`casual|regular|power_user`) **or a speed modifier (`fast|balanced|careful` on the `regular` base)** or a `custom` fallback, with the note "a separate, complementary axis (speed on the `regular` base) that the API doesn't yet expose. Optional future: an API speed knob" (`docs/internal/cross-agent-control-plane-contract.md:196-209`). That is the owner's idea, already on the wire. The same paragraph records that before their W17 fix the lookup always missed and **all behavioural simulation was inert with nothing failing**.

Every AI session sends the literal string `'default'` — `apps/server/src/lib/bootstrap.ts:3154` → `apps/server/src/routes/agent-sessions.ts:1441`. `'default'` is none of the six documented names. The wire declares the field required with an explicit note that there is no safe default because "a wrong-fingerprint or inert-behaviour fallback would be a silent detection tell" (`apps/server/src/schemas/harness-control-protocol.ts:1034-1037`).

⛔ **Caveat, and it belongs in the same breath: that paragraph is dated 2026-06-05 and says the control-plane→device wiring was a stub at the time (`:208-212`).** I have not read their resolver. **Ask the device team what `'default'` resolves to today, before anything else is built, and do not report the conclusion to the owner as fact until they answer.** If it lands on an inert fallback, the AI product's human emulation is already off, pace is a bug fix rather than a feature, and this whole plan re-sequences behind it.

## 2. Customer model

**One control. Three values. Chosen when the chat starts; changeable between turns, never mid-turn.**

**Field name: `pace`, not `mode`.** `mode: z.enum(['manual','ai','pair'])` is already on this exact create body (`apps/server/src/routes/agent-sessions.ts:241`) with a live `POST /:id/mode` route behind it (`SetModeRequestSchema` at `:343`).

**Values: `slow` | `medium` | `fast`** — the owner's words, and a direct mapping onto the device's own speed axis is a feature. Cost accepted and stated: `pace: fast` and the device's `fast` will be conflated in conversation, so in every cross-team message write "our `pace`" vs "your speed modifier" (C9).

|            | Customer-facing promise                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slow**   | "Takes its time: reads pages before acting and pauses between steps. Best for warming up a profile, and for sites that notice a visitor who never stops to read. A long task may need more than one message to finish." |
| **Medium** | "Reads new pages and pauses between actions, and still finishes most tasks in one message."                                                                                                                             |
| **Fast**   | "Straight through, no added pauses. The quickest way to finish a task you just want done."                                                                                                                              |

Under the picker: **"Slow holds your session longer and gets less done per message. It does not cost more."** Checkable: session minutes are not billed and `quotas.session_minute` is null on every tier (`apps/docs/src/pages/api/cost-monitoring.md:9-21`); the AI rate card prices per **token** per model (`apps/server/src/db/migrations/0127_credit_rate_cards.sql:1-2`); pace adds no model calls. What slow spends is a **concurrency slot**, which is literally the thing the plan buys (`apps/docs/src/pages/guides/concurrency.md:7-13`) — 3 on `team_manual`, the lowest tier that gets AI at all (`packages/api-types/src/common.ts:449,:458,:463`).

⛔ **Banned from every customer-facing sentence (C9): "human", "like a person", "natural", "undetectable", "human-like".** Nothing in this system can support them, and the repo's own prompt only ever claims the negative direction. Enforce the ban as an arm on `the-run-ai-tasks-guide-teaches-only-what-the-api-and-sdks-do.test.ts`.

**Default: `fast` at launch.** Deliberate, temporary, reversible, with the flip criterion stated up front in §7. `fast` is defined as _the policy inserting nothing_, so the dispatch path is byte-identical to today — and that is enforced, not asserted (C11). Making `medium` the default on day one would silently slow every existing integration, convert some finished turns into "say continue", and — with today's telemetry — nothing in production could tell us it happened. **Cost, stated plainly: the product ships for one release with what the prompt calls "the single most obvious tell" as its default. The flip must not be allowed to drift.**

**Pace is not `behavioral_profile`.** That enum selects _who_ is browsing and is public on driver sessions only (`packages/api-types/src/sessions.ts:70-71,:161-168`). **Expose exactly one speed-shaped setting on AI sessions (`pace`), and do not expose `behavioral_profile` there in the same release.**

## 3. Policy table

### Where it is inserted, and why not the prompt

The planner prompt already contains the entire slow-mode instruction — "interleave the human beats you already have verbs for: behavioral_pause between and within pages… scroll in more than one step", and for open-ended tasks "the pauses and the scrolling ARE the task" (`apps/server/src/services/agent-planner-contract.ts:289-301`) — in a frozen constant identical for every session (`:105`). **Nothing checks whether a plan contains a single pause**; the only server-side construction of `kind: 'behavioral_pause'` is the planner-reply parser (`:880-890`). That unenforceability is why every task runs at fast today. **The prompt is byte-identical in all three modes in v1**, which also makes the mode's effect attributable.

### ⛔ Insertion point — the corrected ordering (C2)

The plan's original two rules were mutually exclusive against the real code: the look is at `apps/server/src/services/agent-executor-control-plane.ts:766-786` and the gate at `:806-818` — the gate runs **after** the look. The ordering that satisfies both intents, using the precheck the code already has:

```
Stop check (:726-733) → authority (:729-733) → Stop again
  → substituteCredentials (:739)
  → haltsUnlooked = consequentialHalt(plan's own words)   (:790-795)
  → IF it halts: NO PAUSE. Fall straight through to the gate.
  → pace policy: maybe dispatch a pacing pause
  → Stop check again
  → lookBeforeTap (:766-786)
  → consequential gate (:806-818)
  → onStepStart (:829) → runIntent
```

Two rules, now both satisfiable: **never between the look and the tap** (seconds there let a cookie banner appear after the look and take the tap), and **never in front of a screen waiting for a human approval**. **Stated residual:** a halt raised _only_ by the device's labels during the look still had a pause before it. Bounded, acceptable, written down.

### ⛔ An inserted pause is not a plan step — and not a step at all (C3)

It is never added to `plan.intents`, never enters `results`, never reaches `emitStep`, never enters the step history the planner sees. This is the decisive architectural property and it is verified three ways: the no-progress guard compares `replanned.intents` against `plannedIntents` (`apps/server/src/services/agent-runtime.ts:3497-3519`), `sameStep`'s deep-equality fallback (`:1346-1361`) never sees one, and the planner never learns to imitate them.

**It therefore needs its own dispatch path, `dispatchPacingPause()`, which:**

- serialises the wire dispatch directly (so `{kind:'decision'}` and `image_count` are reachable without touching the published union, `packages/api-types/src/agent-intents.ts:194-203`);
- honours Stop with the abandon-at-once branch of §4;
- **swallows every failure.** A pause that fails is a pause that did not happen. It must never touch `results` (`:699-706`), `ok: results.every(...)` (`:1013`), halt-on-first-failure (`:1009`), or `segmentRanToItsEnd` (`agent-runtime.ts:1196-1199`). A dropped frame on a pause ending a segment is the exact failure this path exists to prevent.

**And: never before the first emitted step of a turn** (C8), so `time_to_first_progress_ms` — "It never shows thinking progress is this number" (`apps/server/src/services/metrics-registry.ts:469-470`) — cannot be degraded by pace.

### What is inserted, where — with the bounding rule corrected (C1)

⛔ **The server bounds only what the server draws.** A device-drawn shape's duration is the device's catalogue, which is not in this repo (`docs/internal/cross-agent-control-plane-contract.md:232,:434`; `packages/behavioural-simulation/src/profiles.ts:44-51`), and the wire offers no ceiling param on it (`apps/server/src/schemas/harness-control-protocol.ts:451-461`). So:

- **Tier A — bounded, ships first.** Every pace beat that the budget in §4 counts is emitted as `{duration_ms}` **drawn from a seeded distribution the server owns**. Drawn, never a constant: a constant is the signature. This is the entire v1 policy.
- **Tier B — device-drawn, behind a default-OFF switch.** `{kind:'reading', word_count, image_count?, scroll_through:true}`, `{kind:'decision'}`, bare `{}`, and `scroll.pause_after_ms` (`harness-control-protocol.ts:438-447`, never emitted by the mapper today). Armed **only** after device ask #4 returns real distributions **and** ask #12 returns a `max_ms` ceiling on the wire. Until both land, Tier B is unbounded by construction and cannot be inside a budget.

| Beat                    | Where                                                                         | v1 (Tier A)                                              | Tier B, once armed                                                       | fast  | medium                  | slow                 |
| ----------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ | ----- | ----------------------- | -------------------- |
| **1. Reading beat**     | after a navigate/back/forward settles                                         | `{duration_ms}` drawn, scaled by the digest's word count | `{kind:'reading', word_count, image_count, scroll_through:true, max_ms}` | never | ~50% of loads with text | every load with text |
| **2. Field-to-field**   | between consecutive `send_keys`/`fill_form`                                   | `{duration_ms}` drawn                                    | bare `{}` (device's own draw)                                            | never | yes                     | yes                  |
| **3. Decision beat**    | before an already-gated committing tap, and before the first tap after typing | `{duration_ms}` drawn, longer band                       | `{kind:'decision'}`                                                      | never | yes                     | yes, longer          |
| **4. Scroll rhythm**    | on a long scroll                                                              | split into 2–3 scrolls                                   | `pause_after_ms` on the scroll itself                                    | never | split only              | split + pause_after  |
| **5. Unmotivated idle** | any site-visible step                                                         | `{duration_ms}` drawn                                    | bare `{}`                                                                | never | ~5%                     | ~12%                 |

**Never before the read-back.** The look is a document serialisation — the site sees nothing, so thinking time there buys nothing and costs clock.

**Where the word count comes from, with no extra device call:** the runtime already re-reads the page between segments (`observeForReplan → observeDigest →` one `get_page_source` raced against a 10 s deadline, `agent-runtime.ts:2054-2066`; `agent-executor-control-plane.ts:1070-1080`). Thread that digest's word count into `ExecuteArgs` for the **next** segment. Segments 2–6 get real reading sizes free; segment 1 is blind and uses the unscaled draw — **after** the first emitted step (C8).

### Randomness: seam, seed, bounds (C10)

- ⛔ **`opts.random` is injected**, the same way `opts.now` already is (`agent-executor-control-plane.ts:690`). Without a seam, none of §7's non-uniformity tests can be written.
- **Seed = the session id hashed with a server secret.** Stable within a session (the same "person" does not read at different speeds page to page), distinct across sessions (two sessions on one account running one task must not emit the same interval sequence — a cross-session timing correlation is a stronger tell than any single pause), and not derivable by a site from a public id.
- **The decision to pause is itself a draw.** Pausing after _every_ navigate is a regular rhythm even when every duration differs. Hence the probabilistic frequencies, over the two places a person always hesitates: a long page, and a commitment.
- **Reading time is proportional to CONTENT, not to position.** Falsifiable, and the primary correctness test (§7).
- **Bounded by three ceilings, all ours:** `PACE_STEP_CAP_MS`, the per-segment budget, the §4 taper. The 300,000 ms device cap (`harness-control-protocol.ts:63-67`) is a protocol limit, not a policy; if `capped` ever fires on a policy pause that is an alert, not a metric.
- **Replay:** an idempotent replay never re-runs a pause, because it never re-runs the turn — the receipt replays the stored terminal response (`apps/server/src/services/agent-turn-receipts.ts:1-4`; route `apps/server/src/routes/agent-sessions.ts:6582-6690`). Document the one edge: `requestHash` covers the message body, so a `POST /:id/pace` between turns does not invalidate a key, and a replay returns the answer computed at the old pace.

### Identical in all three modes, without exception

The confirmation gate and every approval; the pre-tap look and its 2 s deadline; credential substitution; halt-on-first-failure and its `wait` exemption (`:1009`); element-appear patience and its 15 s run-wide ceiling; every Stop check; the planner prompt; the plan itself; and the call bounds — 6 planner calls, 7 model calls, 2 re-plans (`agent-runtime.ts:876,:881,:851`), 8 intents per segment (`agent-planner-contract.ts:38`). **Pace changes when things happen, never whether they are allowed to.**

## 4. Bounds, with arithmetic

### The defect that exists today, before any pace work

`MAX_TURN_WALL_CLOCK_MS = 180_000` (`agent-runtime.ts:890`) runs on a real monotonic clock from the top of the turn (`:597-604`), so every millisecond a device spends inside a pause counts — but it is checked **only at the top of the loop** (`:3315-3318`), and its own comment says so, and even anticipates pacing: "six segments of eight steps, each with its human pacing and its element waits, is minutes… this bounds when the turn stops STARTING work" (`:884-890`).

**The executor's step loop has no time check at all.** So eight steps each pausing near the 300 s device cap, each with a 315 s dispatch deadline (`harness-dispatch-correlator.ts:59-64,:75-87` — `behavioral_pause` is in `SINGLE_CAP_LONG_INTENTS`), is **~40 minutes inside one segment** before the loop reaches the bound that would have refused segment 2. Reachable today by a planner-requested pause.

**Fix, shippable alone, and it does not violate the "never cut off" invariant.** The runtime declines to cut a segment because "abandoning a plan halfway leaves dispatched actions in an unknown state". Stopping **between** steps leaves nothing in flight — exactly what the existing Stop check at `:726-733` already does, returning `{results, ok:false, stopped:true}`. Add `turnHardStopAtMs` beside it, with a truthful reason.

### The constants (all control-plane; ours to set)

```
PACE_FRACTION        = { fast: 0, medium: 0.25,   slow: 0.45   }
PACE_SEGMENT_CAP_MS  = { fast: 0, medium: 12_000, slow: 30_000 }
PACE_STEP_CAP_MS     = { fast: 0, medium:  4_000, slow:  9_000 }   // Tier A only
PACE_TURN_RESERVE_MS = 45_000
TURN_HARD_STOP_MS    = { fast: 300_000, medium: 300_000, slow: 600_000 }

elapsed = nowMs() - turnStartedAtMs
budget  = clamp(0, (MAX_TURN_WALL_CLOCK_MS - elapsed - PACE_TURN_RESERVE_MS) * FRACTION,
                   PACE_SEGMENT_CAP_MS)
```

⛔ **These bound Tier A only.** A Tier B device-drawn pause is outside this arithmetic until the device ships a `max_ms` ceiling (C1, ask #12). That is why Tier B is default-OFF.

The reserve is what must remain for real work: a planner call (streamed, 25 s idle, 120 s thinking allowance, 300 s absolute cap; longest measured inter-chunk silence across 198 live calls was 1.4 s — `agent-decomposer-claude.ts:137,:158-159`), a segment of real dispatches, the 10 s read-back, and the answering call.

### Trace of a slow turn — why it degrades instead of failing

| t      | segment | budget                                         | spent                                      |
| ------ | ------- | ---------------------------------------------- | ------------------------------------------ |
| ~5 s   | 1       | (180−5−45)=130 × 0.45 = 58.5 → **capped 30 s** | 25 s work + 30 s pause + 5 s read → t≈90 s |
| ~95 s  | 2       | (180−95−45)=40 × 0.45 = **18 s**               | → t≈143 s                                  |
| ~148 s | 3       | (180−148−45) = −13 → **clamp 0**               | runs at fast                               |
| ~178 s | 4       | **0**                                          | starts, runs at fast                       |

Because the budget is `(remaining − reserve) × f` with `f < 1`, clamped at zero, **the inserted time can never consume the reserve**. Pace self-disables as the ceiling approaches. The failure mode is "ran out of pause budget and sped up", never "ran out of turn".

**Honest limit:** a task needing 5 segments at fast may get 4 at slow and end unfinished. That cannot be engineered away without making slow a no-op. What _is_ guaranteed: fast is identical to today; the taper means pace is never the last straw; a turn stopping on `wall_clock` says so in a named sentence (`agent-runtime.ts:942-960`) rather than showing a column of ticks; and the continuation turn gets a fresh 180 s.

### Every colliding bound, re-checked

| Bound                           | Value                                                                                                                                                          | Verdict                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_TURN_WALL_CLOCK_MS`        | 180,000 ms                                                                                                                                                     | **Unchanged in every mode.** The taper is what makes that possible.                                                                                                                                                                                                                                                              |
| `TURN_HARD_STOP_MS` (new)       | 300 s / 600 s                                                                                                                                                  | Bounds today's ~40-minute single-segment overrun for everyone, pace or not.                                                                                                                                                                                                                                                      |
| **Stop-claim TTL**              | 15 min (`agent-turn-stop-channel.ts:46-54`)                                                                                                                    | ⛔ **BREAKS — C4.** 600 s hard stop + a 615 s `login` started at 599 s + 10 s read-back + 300 s stream cap ≈ **25 min > 15 min**. Already reachable today (~45 min). **Derive the TTL from those four constants with a test that fails when any moves** — do not leave "several times the longest turn that can exist" standing. |
| **Device session max-duration** | **~1800 s, and it is in this repo** (`harness-control-protocol.ts:1038-1041`; `agent-sessions.ts:971-985,:3244-3249`)                                          | ⛔ **NEW, C5.** A 30-minute ceiling on the _whole chat_, ending in a generic disconnect. Slow spends it several turns deep. Send explicit values for AI sessions, or document the ceiling.                                                                                                                                       |
| Device session idle             | ~300 s, same citations                                                                                                                                         | Tier A gaps ≤ 9 s, far under. Tier B gaps are the device's own activity.                                                                                                                                                                                                                                                         |
| Credit reservation              | 30 min, DB CHECK `max_until <= created_at + interval '30 minutes'`, settle reason `max_age` (`0131_credit_reservations.sql:122-125`, **on disk, NOT at HEAD**) | 600 s is well inside — the reason to bound at 600 s rather than higher. Tell that team so they do not size the lease against a 3-minute assumption.                                                                                                                                                                              |
| SDK per-message wait            | 50 min (`packages/sdk-typescript/src/resources/agent-sessions.ts:540-546`)                                                                                     | Not binding; its comment already explains the overrun shape in the right customer words.                                                                                                                                                                                                                                         |
| Planner-call cap                | 6 planner / 7 model / 2 re-plans                                                                                                                               | **Unaffected** — a pause is device time, not a call. Pace can only make `wall_clock` arrive before `planner_call_limit`.                                                                                                                                                                                                         |
| Per-step device budgets         | 2×400 ms retries; 8×1,500 ms cold start; 10 s read-back; 5 s element-appear vs 15 s run ceiling; 2 s look                                                      | **Untouched** — a policy pause is a separate dispatch before them.                                                                                                                                                                                                                                                               |
| Dispatch deadline for a pause   | 315 s                                                                                                                                                          | Tier A's 9 s has enormous headroom.                                                                                                                                                                                                                                                                                              |
| Per-account AI-turn concurrency | 3 (`agent-runtime.ts:1730`)                                                                                                                                    | The real cost; say it in the docs.                                                                                                                                                                                                                                                                                               |
| `stopFor` on a re-plan          | records nothing (`:3305-3307`)                                                                                                                                 | **C14** — a `wall_clock` stop on a re-plan shows the customer no sentence. Fix in S1.                                                                                                                                                                                                                                            |

### Stop — two verified defects that pace turns from rare into routine

**(a) A Stop during a pause is not obeyed, and the message is nonsense.** `REPLAY_SAFE_INTENT_KINDS = new Set(['capture','wait'])` (`apps/server/src/services/agent-intent-result.ts:73`), so `intentReplayMayDuplicateEffect` returns true for a `behavioral_pause`. In `dispatchHonouringStop` (`agent-executor-control-plane.ts:1417-1448`) a replay-safe intent is abandoned **immediately**; a replay-unsafe one is awaited for `STOP_IN_FLIGHT_GRACE_MS = 15_000` (`agent-executor.ts:552`) and then recorded as "this step was already running when the task was stopped, and I could not confirm whether it happened — check the page before doing it again" (`agent-executor.ts:560-561`). Telling a customer to check the page after a **pause** is nonsense.

⛔ **The fix is NOT to add `behavioral_pause` to that set** — that would also make a scroll-through reading pause auto-retryable after an ambiguous failure, and it genuinely moves the viewport (the retry fence's own comment names "replay a dwell" as the harm, `:1455-1470`). **Split the two questions:** a pause is replay-**unsafe** (never auto-retried) but stop-**abandonable** (nothing on the page depends on its outcome), the same as `wait`. Branch at the Stop site only. Belt and braces: Tier A's `PACE_STEP_CAP_MS` tops out at 9 s < 15 s — **an argument that holds for Tier A and does not hold for Tier B (C1), which is a third reason Tier B stays off until `max_ms` exists.**

**(b) Residual, and it is the device team's: there is no cancel verb on the wire.** No `cancel`/`abort`/`interrupt` in `harness-control-protocol.ts`, and the contract's abort section is an unbuilt proposal whose own semantics are "cooperative cancel — never mid-intent" (`docs/internal/cross-agent-control-plane-contract.md:174-181`). After we abandon our wait the device keeps pausing, and the next turn's first dispatch can land on a device still inside a dwell. Ask #3.

### The other verified defect: a reading pause reads as "going in circles" — real, but NOT a slow blocker (C6)

The no-progress check (`agent-runtime.ts:3497-3522`) allows a repeated plan only when it `actsOnNothing` **and** `scrolls`, where `scrolls` tests `i.kind === 'scroll' || (i.kind === 'interact' && i.action === 'scroll')` (`:3512-3514`). A reading pause is `kind: 'behavioral_pause'`, so it fails that test **even though the mapper turns every reading pause into `scroll_through: true`** (`agent-intent-to-dispatch.ts:108-116`). The phone is scrolling and reading exactly as asked, and the product says it went in circles — the first time. The repeat guard already got this right and exempts pauses with the reason in source (`:1202-1219`); the no-progress check was never updated to match.

⛔ **Two corrections to how this was framed.** (1) It is **not** a slow prerequisite: inserted pauses never enter `replanned.intents`, and the prompt is identical in all three modes, so slow changes the input to this check by nothing. Ship it on its own merits. (2) **Only a pause carrying `reading_word_count` may count as scrolling.** A `{duration_ms}` or bare pause scrolls nothing, and excusing those defeats the `[wait, capture]` dithering case the check exists for (`:3505-3510`). Note also `sameMovingPlanRepeats < 1` (`:3516`): one repeat only, even after the fix.

### Cheap independent win

**Tell the planner how much time is left.** `TurnProgress` carries only the segment number, planner calls remaining and the step history (`agent-runtime.ts:3343-3348`; `agent-decomposer.ts:220-230`). A coarse `msRemaining` lets the model plan a smaller final segment instead of one it cannot finish. Helps all three bands; the highest-value single mitigation for "slow feels broken".

## 5. API, storage, override

**Field:** `pace?: 'slow' | 'medium' | 'fast'` on AI session create, default `fast`, echoed on the response.

**Migration.** The newest **committed** migration is `0130_credit_windows.sql`; `0131_credit_reservations.sql` exists on disk and is **not at HEAD**. So the pace migration is **0131 or 0132 — coordinate, do not assume.**

```sql
ALTER TABLE "agent_sessions" ADD COLUMN "pace" text NOT NULL DEFAULT 'fast';
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_pace"
  CHECK ("pace" IN ('slow','medium','fast'));
```

⛔ **The allowed SET lives in the migration, not in `schema.ts`** — the file says so in capitals for the sibling `model` column: adding an id to the TypeScript enum without the matching migration makes the database reject it at session-create time in production (`apps/server/src/db/schema.ts:2571-2574`). A fourth band later inherits the trap. `NOT NULL DEFAULT` follows `stop_on_exit_ip_change`, chosen there so the echoed field is a real value on every historical row.

**Request — declared, never checked in the handler.** `pace: z.enum(['slow','medium','fast']).optional()` beside `mode`/`model` at `apps/server/src/routes/agent-sessions.ts:241-244`. A validation expressed only imperatively is itself a guard failure here: `profile_id` had to gain a declarative `.regex()` because "the document promised a validation the route did not declare" (`:249-261`).

⛔ **The silent-strip trap.** `CreateAgentSessionRequestSchema` is a bare `z.object` (`:230`); only nested `geolocation` is strict. A newer app or SDK sending `pace` to an older server gets a **201 and a session that sprints**, no error anywhere. **Every surface renders what the server ECHOED, not what it picked**, and a mismatch surfaces as a one-line notice.

**Response — the parity guard fires by design.** `apps/server/tests/unit/agent-session-response-schema-parity.test.ts:36` asserts `expect(ifaceFields.length).toBe(21)` and set-equality with `AgentSessionSchema.shape`. Update four things together: the route interface, the api-types schema, the serializer, and **21 → 22**.

**Spec — add it twice.** Every create field is hand-mirrored at `apps/server/src/lib/openapi.ts:5187-5236`, and a guard fails when the published copy is looser than the enforced one.

**Per-message override: NO.** The message body accepts only `user_message` and `approve_consequential_actions` (`:323-341`). Add **`POST /v1/agent-sessions/:id/pace`**, mirroring `SetModeRequestSchema` (`:343`), accepted between turns and **refused while a turn is in flight** — a segment budget computed under one band must not be spent under another. Document that this does not invalidate an idempotency key (C10).

**Stored chats.** `pace` persists beside `model` and `profileId`, and ⛔ **must be OPTIONAL in `cleanChat` with a default applied at read.** `cleanChat` rebuilds each record field-by-field and returns null — dropping the chat from the rail — on a missing or wrong-typed field (`apps/gui-client/src/lib/chat-history.ts:170-202`), and the file carries the scar: `sessionId` was omitted from the rebuild, every stored chat came back without it, "invisible to types and to tests that build a StoredChat in memory instead of round-tripping one". **The test must round-trip a record written WITHOUT the field.**

**Saved tasks.** A recipe remembers nothing about session configuration (`apps/server/src/db/schema.ts:2794-2815`; `apps/server/src/routes/recipes.ts:31-59`). Strongest long-term argument that pace belongs on the task — a warm-up recipe should always be slow — but a second create body on a second resource with its own spec mirror, SDK edits and docs. **Defer; do not block v1.**

## 6. SDK, docs, spec, desktop

**SDKs — three hand edits, and no guard will catch a miss.** All three carry the create-option list by hand (`packages/sdk-typescript/src/resources/agent-sessions.ts:238-308`; `packages/sdk-python/src/driftstack/resources/agent_sessions.py:238-270`; `packages/sdk-go/agent_sessions.go:149-205`). ⛔ Verified: the "a new field on an AI answer reaches every SDK, or none" guard's arms cover **response** surfaces only — problem extensions (`:217`), plan-executed result fields (`:244`), `notice_reason` (`:271`), the capture fetch (`:315`), the transcript stream (`:340`). Pace in the server, the spec and one SDK would pass every test in this repo while two of three languages silently cannot set it. **Extend the guard to create options in the same slice.**

Docstring: _"Slow reads pages and pauses between actions; it holds your session longer and gets through less in one message. Medium pauses between actions. Fast adds no pauses. Read `pace` back off the created session — an older deployment ignores what it does not know."_

**Docs.** A short section in the run-AI-tasks guide, in WHAT terms only, with the C9 word ban enforced by that guide's own test. Slow's real cost belongs on `apps/docs/src/pages/guides/concurrency.md:7-13`. **Nothing in `cost-monitoring.md`** — pace does not change the bill, and the docs should say so.

**Desktop — not a third dropdown.** The mission bar already renders two `<select>`s plus a live toggle, a budget meter and two buttons, and it is `flex-wrap` because of the owner's own recorded complaint that buttons ran outside the panel (`apps/gui-client/src/views/agent-chat/MissionBar.tsx:84-89`). Use a compact three-position segmented control: narrower, shows all three at once, reads as one axis.

- **Lock on `started || sending`**, exactly like the other two (`:143,:165`). During the first send `started` is still false, so without `|| sending` the customer could change the pick after Send and the session would be created with the old value while the header showed the new one.
- **State in the provider, not the view** (`apps/gui-client/src/lib/AgentChatProvider.tsx:138-147`) — `model` and `profileId` live there because the view unmounts on every switch away and view-local state re-seeded itself, writing the same conversation into the rail a second time under a new id.
- **Teach `sameOptions` the fifth key.** Verified at `AgentChatProvider.tsx:102-110`: it compares exactly `model`, `tokenBudget`, `profileId`, `proxyId`. A fifth key it does not compare means a pace change is silently ignored.
- **Render what the server echoed**, per §5.

**Templates — the first consumers.** "Natural" is today entirely a sentence in a prompt: "browse them naturally — scroll, read, follow a few internal links, pause between pages" and "reading them for a little while before moving on" (`apps/gui-client/src/lib/assistant-templates.ts:31,:39`), and `AssistantTemplate` has no options field. Give it one; bind both warm-up templates to slow. Worth saying to the owner: **if pace does not ship, the most human-looking feature in the product is a request politely made to a language model.**

## 7. Telemetry and eval — what proves it

⛔ **Pace is unmeasurable in production today, and the plumbing is worth shipping whether or not pace does.** Verified: `paused_ms` has **exactly one** occurrence in all of `apps/server/src` — the schema declaration at `harness-control-protocol.ts:805`. Decoded, read nowhere. The wire's per-intent `durationMs` (`:1228`) has two consumers, both the pre-tap look's histogram (`agent-executor-control-plane.ts:1543,:1548` — **HEAD line numbers; the file is dirty**). The customer-facing `IntentResult` carries no timing field (`packages/api-types/src/agent-intents.ts:160-183`). The turn telemetry row (`apps/server/src/db/schema.ts:3150-3168`) has `duration_ms`, `time_to_first_progress_ms` and five phase aggregates — **no per-step duration, no pause total, no stop reason.** All device pause time lands inside `executing_ms`, indistinguishable from a slow page. Which bound ended a turn is **only a log line**, because "the row's columns are a closed vocabulary with no word for WHICH bound ended the turn".

**Prerequisite (customer-invisible):**

1. Stop discarding `durationMs` per step and `paused_ms` per pause.
2. New columns on the turn row: `pace`, `paused_ms`, `inserted_pause_count`, `loop_stopped_reason` — with `paused_ms` **subtracted out of `executing_ms`**, so pace time is a first-class number that can never be read as work.
3. Labels on the registry (`apps/server/src/services/metrics-registry.ts:462-500` — turn duration by outcome, phase duration by phase, time-to-first-progress by transport, the look's timings, **nothing per intent kind**): add `pace` to turn duration and phase duration, and add `driftstack_agent_turn_loop_stopped_total{reason, pace}`.
4. **A `pace` stream event** (C7) for each inserted pause, carrying `paused_ms`, so the GUI can draw a beat and exclude it from step durations — additive, so default-OFF until all three SDKs decode it.

**Claim → proof:**

| Claim                            | How it is proved                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Fast is unchanged"              | Regression, not discovery. `paused_ms` exactly 0 on every fast turn (non-zero is a bug alarm); dispatch sequence byte-identical to the pre-pace baseline (C11); median `duration_ms` / `steps_succeeded` match on the same task mix.                                                                                                                                                                                                                                                         |
| "Slow does not cost completions" | **The flip criterion.** Share of turns ending in `loop_stopped_reason ∈ {wall_clock, no_progress}`, by band, on the eval set. **Flip to `medium` only if medium's unfinished share is within noise of fast's; if medium raises it at all, `PACE_FRACTION.medium` is too large.**                                                                                                                                                                                                             |
| "The budget is honoured"         | `paused_ms_total ≤ budget` per turn, per band. Directly checkable — **and only checkable at all for Tier A** (C1).                                                                                                                                                                                                                                                                                                                                                                           |
| "Slow is non-uniform"            | Unit tests over the fixture corpus via the injected RNG seam (C10), 30 runs per band, no site or device: (i) no two runs share an interval sequence; (ii) reading time correlates with page word count and **not** with step index; (iii) no spike at any single value — which is what a server constant produces; (iv) two sessions differ, one session is stable across its own pages. **These are the only thing standing between this feature and a fixed delay with a marketing name.** |
| "Slow looks more human"          | **Our telemetry cannot prove this, and we should say so.** The only honest proxy is an outcome on a real site: challenge / interstitial / unexpected-login rate per band, same corpus, matched exits. Needs volume — plan for it, do not expect it in week one.                                                                                                                                                                                                                              |

**Eval.** Add `pace` as a dimension and run the bands **concurrently, not sequentially** — site behaviour and model latency drift day to day and a sequential comparison attributes that drift to pace. ⛔ **Separate "failed the task" from "ran out of clock"**, or slow is reported as worse at browsing when it is only worse at finishing inside 180 s. (HEAD `dc0f83c86` is itself about pacing the live model comparison under a provider's request limit without changing what it measures — a natural fit.)

**What the customer sees while watching.** The elapsed clock is the honest headline, and inserted pauses appear as **quiet beats between steps, not numbered steps** — which requires the `pace` stream event of prerequisite 4, because without it the desktop clock silently adds pause time to the next step (C7). The app's existing discipline is that its step times are "OBSERVED, not reported", drawing no clock at all rather than honest-looking zeros — **and none of that is committed yet**. Pace rides on that work; it must not invent its own clock, and it must not land on top of it mid-flight.

## 8. Asks of the device team

1. **What does `behaviorProfile: 'default'` resolve to in your resolver today, given we hard-code that literal on every AI session and it is none of the six names your contract documents?** — _No wire change if it resolves sanely; if it is the inert fallback, an immediate correction of the constant and this whole plan re-sequences behind a bug fix._
2. **Is the speed-modifier branch (`fast|balanced|careful` on the `regular` base) live after W17/W18, and does it scale typing cadence, flick speed and touch dwell, or only your own idle draws?** — _No wire change; it decides whether `SessionAssign.behaviorProfile` can carry pace directly._
3. **Can an in-flight `behavioral_pause` be pre-empted — by a new dispatch, or a cancel scoped to pauses specifically, the one long intent where abandoning mid-flight is provably safe?** — _A cancel/pre-empt message, or explicit confirmation of none, in which case Tier A caps every pause at 9 s and long reading is several short pauses._
4. **Publish the actual distributions — spread, not means — for a bare `{}`, a `{kind:'decision'}` and a `{kind:'reading', word_count: N}` pause, per person and per speed modifier.** — _A document. We quote no duration to the owner or a customer until it lands._
5. **⛔ NEW: will you add a `max_ms` (or `budget_ms`) ceiling param to the reading and decision pause variants?** — _Additive wire change, and the blocking dependency for Tier B. Without it the server cannot bound a device-drawn pause, so it cannot put one inside a budget, honour a Stop cheaply, or keep the turn's taper honest._
6. **Confirm `{kind:'decision'}` behaves as documented — we have never emitted one, because our customer union cannot express it.**
7. **Confirm reading `image_count` semantics — does an image count add dwell, or change the scroll plan?**
8. **Confirm `scroll.pause_after_ms` — after the whole scroll, or after each flick?** — _Decides whether we split scrolls ourselves; a pause attached to the scroll beats a separate dispatch after it._
9. **Does a reading pause with `scroll_through` emit real scroll events and trigger lazy-load fetches, or does the page go silent and then jump?** — _Decides whether reading time is worth spending at all: a pause that produces dead air costs the same clock and buys nothing._
10. **Is your timing seed stable within a session and distinct across sessions?** — _No wire change unless the answer is no, in which case we need a per-session seed field on `SessionAssign`._
11. **⛔ CORRECTED: confirm the AI-session idle (~300 s) and max-duration (~1800 s) defaults are still current, and whether a paced session should send explicit values.** — _Not "what are they" — they are recorded in our own protocol file. The question is whether a 30-minute ceiling on a whole chat is one you expect us to raise (C5)._
12. **Do you hold any detection or block-rate measurements per speed modifier, since you tuned `fast|balanced|careful` against something?** — _No wire change; our telemetry can prove pauses happened, never that they worked._

## 9. Ordered slices

**S0 — Ask, before building.** Asks 1–5 and 11. Ask 1 gates everything; ask 5 gates Tier B; ask 11 may add a slice. No code.

**S1 — The executor learns what time it is.** `turnHardStopAtMs` checked at the top of the step loop beside the existing Stop check (`agent-executor-control-plane.ts:724-733`), returning between steps so nothing is left in flight. **Plus C4: derive `AGENT_TURN_CLAIM_TTL_SECONDS` from the four constants that actually bound a turn.** **Plus C14: record a stop reason on the `replan` path too.** Bounds today's ~40-minute overrun for every customer, pace or not.

- `a-segment-cannot-outlive-the-turn-that-started-it.test.ts`
- `a-step-loop-that-runs-out-of-time-stops-between-steps-not-inside-one.test.ts`
- `the-stop-claim-outlives-the-longest-turn-the-constants-permit.test.ts`

**S2 — Keep the timing the device already sends.** Per-step `durationMs`, per-turn `paused_ms`, `loop_stopped_reason` as a column, `pace` labels, `driftstack_agent_turn_loop_stopped_total{reason,pace}`, `paused_ms` subtracted from `executing_ms`. Worth shipping whether or not pace does.

- `the-bound-that-ended-a-turn-is-a-column-not-a-log-line.test.ts`
- `pause-time-is-never-counted-as-work.test.ts`

**S3 — Stop means stop during a pause.** Branch at `agent-executor-control-plane.ts:1428` so a `behavioral_pause` hit by Stop is abandoned at once with a truthful reason. ⛔ Do **not** widen `REPLAY_SAFE_INTENT_KINDS` (`agent-intent-result.ts:73`); keep the retry fence. A bug fix on its own merits today.

- `a-stopped-pause-is-abandoned-not-reported-as-outcome-unknown.test.ts`
- `a-pause-is-stop-abandonable-without-becoming-retry-safe.test.ts`

**S4 — A page being read is not a page going in circles.** Teach `scrolls` (`agent-runtime.ts:3512-3514`) that a `behavioral_pause` **carrying `reading_word_count`** traverses the page, matching the repeat guard's exemption at `:1202-1219`. ⛔ **Independent of pace (C6)** — correct today, not a slow blocker, and narrow: a `{duration_ms}` or bare pause is not excused.

- `a-turn-that-reads-a-long-page-is-not-going-in-circles.test.ts`
- `a-plan-of-bare-pauses-is-still-going-in-circles.test.ts`

**S5 — Show the owner, before building the rest.** Three scenes on the existing harness — same task, same six steps, three clocks — named `audit-agent-chat-done-{slow,medium,fast}` (C13), reusing the in-flight per-step-timing work. ⛔ Sequence against the 16 modified GUI files rather than colliding with them. One fixture file, no product code.

- `the-gallery-shows-the-same-task-at-three-paces.test.tsx`

**S6 — The policy and its budget, Tier A only, behind a default-OFF flag (= fast = today).** The per-segment taper in the runtime; `pacePolicy` consulted at the **corrected insertion point** of §3 (C2); the dedicated `dispatchPacingPause()` that swallows its own failures (C3); the injected `opts.random` and per-session seed (C10); never before the first emitted step (C8); the digest's word count threaded into `ExecuteArgs`; `{duration_ms}` draws only. Plus `msRemaining` on `TurnProgress` (`agent-runtime.ts:3343-3348`).

- `an-inserted-pause-is-never-a-plan-step.test.ts`
- `a-pacing-pause-that-fails-does-not-fail-the-segment.test.ts`
- `a-pause-never-lands-between-the-look-and-the-tap.test.ts`
- `a-step-awaiting-approval-is-never-made-to-wait-longer.test.ts`
- `pace-runs-out-of-budget-before-a-turn-runs-out-of-clock.test.ts`
- `reading-time-follows-the-page-not-the-step-number.test.ts`
- `two-sessions-running-one-task-do-not-share-a-rhythm.test.ts`
- `pace-never-delays-the-first-thing-the-customer-sees.test.ts`
- `fast-dispatches-exactly-what-it-dispatches-today.test.ts`

**S7 — The deciding experiment, before any API work.** Run the eval across all three bands **concurrently** on one task list behind the hard-coded flag. Measure completion, turns-per-task, `loop_stopped_reason` shares, challenge/block rate. **If slow does not move the challenge rate, kill the feature here** — the cheapest possible place to find that out.

**S8 — The API field.** Migration (0131 or 0132 — check) with the CHECK in the migration and `NOT NULL DEFAULT 'fast'`; the declarative `z.enum`; the echoed response field (parity 21 → 22); the hand-mirrored spec; `POST /:id/pace` refused while a turn is in flight.

- `a-pace-the-database-does-not-know-is-refused-at-create-not-in-production.test.ts`
- `pace-cannot-change-under-a-turn-that-is-already-running.test.ts`

**S9 — The three SDKs, and the guard that should have forced them.** Hand edits in all three, **plus extending the cross-SDK guard to create options** — it covers response surfaces only today.

- `a-new-create-option-reaches-every-sdk-or-none.test.ts`

**S10 — Desktop.** Segmented control, provider state, `sameOptions` taught the fifth key, `cleanChat` taught it optionally with a round-trip test, the view rendering what the server echoed, and the `pace` stream event drawn as a beat rather than folded into the next step's clock (C7).

- `a-chat-saved-before-pace-existed-still-opens.test.ts`
- `the-header-shows-the-pace-the-server-stored-not-the-one-we-asked-for.test.ts`
- `a-paused-beat-is-not-added-to-the-next-steps-clock.test.tsx`

**S11 — The chat-length ceiling (C5).** Decide and implement: explicit `idleTimeoutSeconds` / `maxDurationSeconds` for AI sessions, or a documented limit on how long a paced chat runs. **This is a slice, not a footnote** — today a slow chat dies at ~30 minutes with a generic disconnect and no sentence.

**S12 — Docs and templates.** The run-AI-tasks section with the C9 word ban enforced, the concurrency sentence, the two warm-up templates bound to slow.

**S13 — Measure, then flip.** Publish the per-band table; flip the default `fast → medium` only if medium's unfinished share is within noise. One line, own changelog entry, reversible.

**S14 — Tier B, gated on device asks 5–9.** Device-drawn shapes (`{kind:'decision'}`, reading `image_count`, `scroll.pause_after_ms`, bare `{}`) behind a default-OFF `DRIFTSTACK_PACE_TIER_B=1`, armed only once a `max_ms` ceiling exists on the wire. Also: widening the **customer** union, and pace on saved tasks.

## 10. Decisions made

| Decision             | Chosen                                                                                                            | Why, and what it costs                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Field name           | **`pace`**                                                                                                        | `mode` is taken by `z.enum(['manual','ai','pair'])` at `agent-sessions.ts:241` with a live `POST /:id/mode` route.                                                                                       |
| Values               | **`slow` / `medium` / `fast`**                                                                                    | The owner's words; a direct mapping to the device's speed axis is a feature. **Cost:** collides with their internal `fast`; always disambiguate in cross-team writing (C9).                              |
| Copy                 | **No "human", "like a person", "natural", "undetectable"**                                                        | Nothing in this system supports the claim, and the repo only ever claims the negative direction. Enforced by the guide's own test.                                                                       |
| Default              | **`fast` at launch**, flip on a stated criterion                                                                  | The only choice under which no customer who never touches the setting can have a turn broken. **Cost:** the product ships with the tell as its default for one release; the flip must not drift.         |
| Enforcement          | **Executor, not prompt**                                                                                          | The prompt already asks for all of this and nothing verifies it — which is why today is fast. Executor-side also keeps pauses out of the plan, so no guard's input changes.                              |
| **Pause shapes**     | ⛔ **Tier A `{duration_ms}` drawn, ships first; device-drawn shapes default-OFF until a `max_ms` ceiling exists** | **Corrected (C1).** A server-chosen _constant_ is the signature — a server-drawn _distribution_ is not. A shape the server cannot bound cannot sit inside a budget, a Stop-latency argument, or a taper. |
| **Insertion point**  | ⛔ **After `haltsUnlooked`, before the look; skipped entirely on a halt**                                         | **Corrected (C2).** The original "before the look AND after the gate" is impossible: the gate is after the look at HEAD.                                                                                 |
| **Dispatch path**    | ⛔ **A dedicated `dispatchPacingPause()` that swallows its own failures**                                         | **New (C3).** Through `runIntent` a pause enters `results`, `ok`, `emitStep` and halt-on-first-failure — a dropped frame on a pause would end the segment.                                               |
| Turn ceiling         | **Unchanged at 180,000 ms in every mode**                                                                         | The taper makes slow fit rather than moving a constant.                                                                                                                                                  |
| Overrun backstop     | **New `TURN_HARD_STOP_MS`** (300 s / 600 s)                                                                       | Bounds today's ~40-minute single-segment overrun. Stops between steps, so the "never cut off" invariant holds.                                                                                           |
| **Stop-claim TTL**   | ⛔ **Derived, not asserted**                                                                                      | **Corrected (C4).** 600 s + a 615 s `login` + read-back + a 300 s stream cap ≈ 25 min against a 15-minute TTL. Already reachable today.                                                                  |
| **Session length**   | ⛔ **Its own slice (S11)**                                                                                        | **New (C5).** ~1800 s device max-duration is stated in this repo and kills the whole chat, not the turn.                                                                                                 |
| S4 (no-progress)     | **Ships on its own merits, not as a slow blocker; narrow to `reading_word_count` pauses**                         | **Corrected (C6).** Inserted pauses never reach `replanned.intents` and the prompt is identical in all three modes.                                                                                      |
| Per-insert cap       | **9 s (slow) / 4 s (medium)**, Tier A only                                                                        | Set by Stop latency, not taste: 9 s < `STOP_IN_FLIGHT_GRACE_MS` 15 s. **The argument does not extend to Tier B.**                                                                                        |
| Per-message override | **No.** `POST /:id/pace` between turns                                                                            | Pace would otherwise be the API's first per-message override; a budget computed under one band must not be spent under another.                                                                          |
| Two settings or one  | **`pace` only on AI sessions; do not expose `behavioral_profile` there in the same release**                      | Three speed names beside three behaviour names is one setting in the customer's head.                                                                                                                    |
| Saved tasks          | **Deferred**                                                                                                      | Second create body, second resource, own spec mirror, SDK edits and docs.                                                                                                                                |

**Scope honesty.** Every citation was re-checked against committed code at `dc0f83c86`. Corrected upstream: the GUI step clock **and its hook field** are absent at HEAD; the newest committed migration is 0130 (0131 is on disk only); the `durationMs` consumers are at `:1543,:1548` at HEAD, not `:1394,:1399`; the device idle/max-duration defaults **are** stated in this repo; the two insertion-point rules were contradictory; the Stop-claim TTL arithmetic does not close; the no-progress fix is not a pace dependency; the "prefer device-drawn shapes" rule is incompatible with the budget as written. **I ran no tests, no builds and no harness — this task was read-only.**

## Appendix — the critic's findings, as raised

#### C1 — CRITICAL. The budget arithmetic cannot bound a device-drawn pause. The whole taper rests on numbers the server does not choose.

§3 makes `{kind:'reading', word_count, scroll_through:true}` the primary slow beat and says "prefer the shapes the device draws over a server-chosen number". §4 then sets `PACE_STEP_CAP_MS = 9_000`, a per-segment cap and a taper — arithmetic over durations the server cannot see or constrain. `BehavioralPauseParamsSchema` has no ceiling field on the `reading` or `decision` variants (`apps/server/src/schemas/harness-control-protocol.ts:451-461`); the only ceiling is the device's own 300,000 ms cap and the sender is explicitly told **not** to pre-clamp (`:63-67`). What a reading pause actually lasts is the device team's catalogue, which this repo does not contain and says so (`docs/internal/cross-agent-control-plane-contract.md:232,:434`; `packages/behavioural-simulation/src/profiles.ts:44-51` — "a SIMPLIFIED reference model, NOT the production behavioral source").

**Scenario:** slow, a 4,000-word article, the device draws 180 s. The 9 s cap is fiction. The "9 s < `STOP_IN_FLIGHT_GRACE_MS` 15 s" argument that carries the whole Stop section collapses. The next segment's `(remaining − reserve) × f` is computed against an elapsed figure two orders of magnitude off, so the taper — the single property that makes pace "never the last straw" — silently stops holding.

**Fix.** Split the two cases and stop pretending they are one. (a) Anything the server must **bound** is emitted as `{duration_ms}`, drawn from a seeded distribution the server owns — that is not "a server constant", which is what §3 was right to forbid. (b) Device-drawn shapes are used only where an overrun is harmless, and only after device ask #4 returns real distributions; until then they sit behind a default-OFF switch. (c) **Ask the device team for a `max_ms` ceiling param on the reading and decision variants.** That is the one wire change this feature genuinely needs, it is additive, and without it "slow is bounded" is not a claim we can make. (d) Compare `paused_ms` against what was budgeted and alert on the gap.

#### C2 — CRITICAL. §3's two placement rules contradict each other and the code.

§3 says the pause goes "after the Stop and authority checks, before the pre-tap look" **and** "after the consequential-action gate decides to proceed, never before it". At HEAD those are mutually exclusive: the look is at `apps/server/src/services/agent-executor-control-plane.ts:766-786` and the gate is at `:806-818` — the gate runs **after** the look. Implementing "after the gate" puts the pause exactly where §3 forbids it: between the look and the tap, where a cookie banner can appear after the look and take the tap.

**Fix.** There is one ordering that satisfies both, and it uses a precheck the code already has. `haltsUnlooked` (`:790-795`) classifies the plan's own words before any look. So: Stop → authority → substitute → `haltsUnlooked` → **if it halts, no pause at all** → pause → Stop re-check → look → gate → `onStepStart` (`:829`) → dispatch. Write down the residual rather than leaving it to be discovered: a halt raised **only** by the device's labels during the look still has a pause before it. That is bounded and acceptable; it is not zero.

#### C3 — HIGH. An inserted pause routed through the executor's dispatch path can fail the whole segment, and cannot carry a `{kind:'decision'}` shape at all.

`emitStep` pushes into `results` **and** streams in one call (`:699-706`). The segment's verdict is `ok: results.every(r => r.kind === 'success')` (`:1013`). Halt-on-first-failure breaks on any non-`wait` failure (`:1009`). `segmentRanToItsEnd` requires every result to be a success or a `wait` (`apps/server/src/services/agent-runtime.ts:1196-1199`). And the correlator synthesises a `durationMs: 0` failure on a lost dispatch (`apps/server/src/services/harness-dispatch-correlator.ts:111`).

**Scenario:** a dropped frame on an inserted pause — a pause, which changes nothing — ends the segment, marks it as not having run to its end, and changes which branch the turn loop takes. Separately, `dispatchHonouringStop` is typed on `ExecuteArgs['plan']['intents'][number]` (`:1417-1421`) and `runIntent` maps back through `intentResultToCustomer(intent, parsed)`; an executor-inserted `{kind:'decision'}` pause has no customer `AgentIntent` to carry, because the published union cannot express one (`packages/api-types/src/agent-intents.ts:194-203`). The plan's central unlock — "executor-inserted pauses bypass the published union" — is true of the _wire_, and false of _this executor's code path_.

**Fix.** A separate `dispatchPacingPause()` that serialises the wire dispatch directly, honours Stop, and **swallows every failure**: a pause that fails is a pause that did not happen, never a step that failed. It never touches `results`, `ok`, `emitStep`, or `intentResultToCustomer`. Test: `a-pacing-pause-that-fails-does-not-fail-the-segment.test.ts`.

#### C4 — HIGH. §4's own numbers break its own Stop-claim argument.

`AGENT_TURN_CLAIM_TTL_SECONDS = 15 * 60`, justified as "several times the longest turn that can exist" (`apps/server/src/services/agent-turn-stop-channel.ts:46-54`). §4 asserts the premise survives because the hard stop caps the tail at 600 s. It does not. `TURN_HARD_STOP_MS` is checked **between steps**, so a step started at 599 s runs to its own dispatch deadline — 315 s for a pause, **615 s for `login`** (`harness-dispatch-correlator.ts:75-96`) — then the read-back (10 s) and the answering call (absolute stream cap 300 s, `apps/server/src/services/agent-decomposer-claude.ts:159`). Worst case ≈ 600 + 615 + 10 + 300 ≈ **25 minutes against a 15-minute TTL**. The claim expires under a live turn: a recorded Stop can expire with it, and the concurrency claim releases a slot the turn still holds.

This is already reachable today (180 s + 8 × 315 s ≈ 45 min). Pace turns it from a tail case into the normal shape of a slow turn.

**Fix.** Derive the TTL instead of asserting it: `TTL ≥ TURN_HARD_STOP_MS + max dispatch deadline + read-back + stream cap + margin`, with a test that fails when any of those four constants moves. A comment that says "several times the longest turn that can exist" while the arithmetic says otherwise is worse than no comment — it certifies a stale premise as a checked one.

#### C5 — HIGH. The device kills an AI session at ~30 minutes, and this repo does state it. The plan says it does not.

The plan's device ask #10 and its "the default is not stated in this repo" are both wrong. It is stated twice: `apps/server/src/schemas/harness-control-protocol.ts:1038-1041` ("omit → harness defaults (transportMode→h2-and-h3, idle→300s, max→1800s)") and `apps/server/src/routes/agent-sessions.ts:971-985`, where `MANUAL_SESSION_MAX_DURATION_SECONDS = 14400` exists precisely because the device default "hard-kills an interactively-watched sim mid-use after half an hour with no explanation — the GUI only learns via a generic disconnect". AI sessions deliberately keep the device defaults (`:3244-3249`).

**Scenario:** the ceiling that bites slow first is not the 180 s turn, and not the 30-minute credit reservation. It is a **30-minute ceiling on the whole chat**, four or five turns deep, ending in a generic disconnect with no sentence. Slow multiplies chat wall-clock without adding a single turn to it.

**Fix.** This is a slice, not a footnote. Either send explicit `idleTimeoutSeconds`/`maxDurationSeconds` for AI sessions — the fields are already optional on the wire and the manual path already uses them — or document a hard ceiling on how long a paced chat runs. Ask #10 becomes "confirm 300/1800 is still current", not "what is it".

#### C6 — HIGH. S4 is presented as a slow-blocker; under the chosen architecture it is not, and the fix as written is too wide.

§3 keeps inserted pauses out of `plan.intents` and keeps the prompt byte-identical in all three modes. So slow changes planner-emitted pause frequency by **exactly nothing**, and the no-progress check's input (`replanned.intents`, `agent-runtime.ts:3497`) is unchanged. S4 is a genuine bug today — verified, `scrolls` tests only `i.kind === 'scroll' || (i.kind === 'interact' && i.action === 'scroll')` at `:3512-3514`, so a reading pause that the mapper turned into `scroll_through: true` (`apps/server/src/services/agent-intent-to-dispatch.ts:108-116`) is not counted as scrolling — but it is **independent of pace**, and saying otherwise buys a dependency the plan does not have.

The fix must also be narrower than "teach `scrolls` about pauses": **only** a `behavioral_pause` carrying `reading_word_count`. A `{duration_ms}` or bare pause scrolls nothing, and excusing those defeats the exact case the check exists for — `[wait, capture]` repeated on an unchanged page (`:3505-3510`). Note also `sameMovingPlanRepeats < 1` (`:3516`): even after the fix, a third identical reading plan stops.

#### C7 — MEDIUM-HIGH. §7's "quiet beats" contradicts §3's "never announced", and today would make the in-flight step clock lie.

If the pause is never emitted, the desktop app cannot draw a beat. Worse: the app derives step times from **stream arrival deltas it measures itself**, so a pause dispatched before step N is silently added to step N's displayed duration. The app's discipline is that its clock is "OBSERVED, not reported" — and none of that exists at HEAD (verified above). So a paced turn landing on the in-flight step clock would produce honest-looking numbers that are wrong.

**Fix.** Emit an explicit **non-step** stream event for an inserted pause, carrying `paused_ms`, consumed by the GUI as a beat and excluded from step durations. It is a new event name on a published stream, so it needs the same default-OFF arming rule as any additive wire change — the cross-SDK guard already covers the transcript stream (`apps/server/tests/unit/a-new-field-on-an-ai-answer-reaches-every-sdk-or-none.test.ts:340`).

#### C8 — MEDIUM. Pace can degrade the one metric the repo names as a customer complaint.

`agentTurnTimeToFirstProgressSeconds` — "It never shows thinking progress is this number" (`apps/server/src/services/metrics-registry.ts:469-470`). §3's beat 6 (the `{duration_ms}` fallback "anywhere no page size is known — segment 1") fires exactly where no progress has been shown yet.

**Fix.** **Never insert before the first emitted step of a turn.** An invariant with a test, not a tuning choice.

#### C9 — MEDIUM. Two naming problems: one over-claim, one collision.

The §2 copy says slow reads and pauses "the way a person does". That is the one kind of claim the rules forbid, and nothing in this repo supports it — the prompt only ever claims the negative direction, that a burst of navigations "is the single most obvious tell" (`apps/server/src/services/agent-planner-contract.ts:291-292`), which says what is conspicuous, never that pausing is invisible. Separately, `pace: fast` collides head-on with the device's own `fast|balanced|careful` speed axis (`docs/internal/cross-agent-control-plane-contract.md:203-206`): one word, two meanings, in the same conversations where we are asking that team questions.

**Fix.** Keep `slow`/`medium`/`fast` as the API values — the owner's words, and a direct mapping to the device axis is a feature, not an accident — but ban "human", "like a person", "natural", "undetectable" from every customer-facing sentence. Say what it does: _reads pages before acting, and pauses between steps_. Add the ban as an arm on `the-run-ai-tasks-guide-teaches-only-what-the-api-and-sdks-do.test.ts`, which already forbids internal machinery. In team conversation, always write "our `pace`" vs "your speed modifier".

#### C10 — MEDIUM. The randomness has no injection seam, so §7's tests cannot be written; replay is separately fine and should be stated.

The executor injects `now` (`:690`) and `genIntentId`, but there is **no RNG seam**. Every non-uniformity property in §7 — "no two runs share an interval sequence", "no spike at any single value", "two sessions differ, one session is stable" — needs one.

**Fix.** Inject `opts.random` the same way, seeded per session from the session id hashed with a server secret (stable within a session, distinct across sessions, and not derivable by a site from a public id), and pin the seam in the constructor test.

**Replay, asked for explicitly and verified clean:** an idempotent replay never re-runs a pause because it never re-runs the turn. `POST /:id/message` reserves a durable receipt and replays the stored terminal response — "Reusing the same Idempotency-Key must replay that terminal result, never execute the natural-language task again" (`apps/server/src/services/agent-turn-receipts.ts:1-4`; route at `apps/server/src/routes/agent-sessions.ts:6582-6690`). One edge worth writing down: `requestHash` covers the message body, so a `POST /:id/pace` between turns does not invalidate a key — the replayed answer is the one computed at the old pace. That is correct, and it should be in the docs rather than discovered.

#### C11 — MEDIUM. "Fast is byte-identical" needs to be enforced, not asserted.

Define fast as a single early return at the very top of the policy: no stream event, no telemetry write path that can fail, no RNG draw, no extra clock read inside the step loop. Pin it with `fast-dispatches-exactly-what-it-dispatches-today.test.ts` comparing the dispatch sequence byte-for-byte against the pre-pace baseline, and assert `paused_ms === 0` on every fast turn as an alarm rather than a metric.

#### C12 — LOW-MEDIUM. Citation drift: several cited files are dirty and their line numbers are not HEAD's.

`agent-executor-control-plane.ts` is modified; the `durationMs` look consumers are at **`:1543,:1548`** at HEAD, not the `:1394,:1399` the plan cites. Also modified and cited: `agent-turn-telemetry.ts`, `metrics-registry.ts`, `db/schema.ts`, `lib/bootstrap.ts`, `MissionBar.tsx`, `use-agent-chat.ts`, `assistant-templates.ts`, `AgentChatView.tsx`, `PlanTimeline.tsx`, `Turn.tsx`. **Pin by symbol name, not line number**, or the first implementer edits the wrong place.

#### C13 — LOW. Three pace scenes as `AgentChatSceneKind` values conflate a pace with a state.

`slow`/`medium`/`fast` are not states a customer can be in; they are three renderings of `done`. Adding them to the roster makes "every AI-view state has a scene" (`the-gallery-seam-drives-the-real-ai-view.test.tsx:246-259`) stop meaning what it says. Name them `audit-agent-chat-done-slow` / `-medium` / `-fast`, or give them a second roster.

#### C14 — LOW. A `wall_clock` stop on a re-plan gets no sentence.

`stopFor` records a reason only when `cause === 'continue'` (`agent-runtime.ts:3305-3307`). Pace makes `wall_clock`-on-replan more likely, and that path shows the customer nothing.

#### C15 — LOW. S6 is not shippable alone if it uses device-drawn reading pauses.

Ask #3 (pre-empt an in-flight pause) and the `max_ms` ceiling from C1 are both **wire changes**, and the contract's abort section is an unbuilt proposal whose own semantics are "cooperative cancel — never mid-intent" (`docs/internal/cross-agent-control-plane-contract.md:174-181`). Also: §1's finding rests on a persona paragraph dated **2026-06-05** that itself says the control-plane→device wiring was a stub at the time (`:208-212`). Ask #1 stands; it must not be reported to the owner as established fact.
