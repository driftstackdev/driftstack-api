// Drift guard for apps/server/src/services/agent-executor.ts. Pins the
// AI-B2 intent executor interface — discriminated IntentResult, halt-
// on-first-failure semantic, stub variant for pre-launch demos, and
// the runResultToTranscriptEntry serialization helper.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/agent-executor.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('services/agent-executor content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("AI-B2 module-level framing pinned: 'intent executor. Maps a DecomposeResult plan onto calls against the existing /v1/sessions/:id/{navigate,interact,wait,capture} surface so the dashboard chat UI can run an end-to-end turn (decompose → execute → append transcript → debit tokens → repeat) without hand-wiring the dispatch.' — pinned so the AI-B2 anchor + 4-action-surface + end-to-end turn pipeline all stay documented", () => {
    expect(body).toMatch(
      /\/\/ AI-B2 — intent executor\. Maps a DecomposeResult `plan` onto calls\s*\n?\s*\/\/ against the existing \/v1\/sessions\/:id\/\{navigate,interact,wait,\s*\n?\s*\/\/ capture\} surface so the dashboard chat UI can run an end-to-end\s*\n?\s*\/\/ turn \(decompose → execute → append transcript → debit tokens →\s*\n?\s*\/\/ repeat\) without hand-wiring the dispatch\./,
    );
  });

  it("V-808 corrected the stub-then-real framing: BOTH StubAgentExecutor and RealAgentExecutor are exported from this file, and ControlPlaneAgentExecutor is a third, so the promised follow-up had already landed. The halt-on-first-failure behaviour the header describes is real and is now asserted against the code. Old text pinned against it now.' — pinned so the deterministic-stub-for-now + AI-B2.b SessionsService-real-follow-up + stable-interface contract all stay documented", () => {
    expect(body).toMatch(/\/\/ Two executors live here and BOTH are shipped: `StubAgentExecutor`/);

    // V-840 — the SAME staleness lived twice in this file. V-808 fixed the
    // header above and left it on the RealAgentExecutor declaration, which
    // claimed the runtime still used the stub. bootstrap picks
    // ControlPlaneAgentExecutor when fleetControlPlaneEnabled is set.
    expect(body).toMatch(/NOT wired into bootstrap — nothing in `lib\/` imports this class/);
    expect(body, 'the runtime is not unconditionally the stub').not.toMatch(
      /the runtime still uses StubAgentExecutor/,
    );
    expect(body).toMatch(/\/\/ `RealAgentExecutor`, which dispatches against the in-process/);
    // V-808 — RealAgentExecutor is exported from this same file, so the
    // "a later follow-up replaces the stub" promise had already been kept.
    expect(body, 'the stub-only framing must not return').not.toMatch(
      /This slice ships the deterministic stub variant/,
    );
    // The halt-on-first-failure claim was TRUE and is kept, now derived from the
    // code rather than only asserted in prose.
    expect(body).toMatch(/if \(result\.kind === 'failure'\) return \{ results, ok: false \};/);
  });

  it("Why-not-HTTP-fetch framing pinned: 'the agent layer runs in the same process as the routes; round-tripping through HTTP would double the latency budget + lose typed-error context. AI-B2.b dispatches against the in-process SessionsService instead.' — pinned so the same-process + double-latency-bad + lose-typed-errors rationale + AI-B2.b-uses-in-process-SessionsService dispatch contract stay documented", () => {
    expect(body).toMatch(
      /\/\/ Why not call the HTTP routes directly via fetch: the agent layer\s*\n?\s*\/\/ runs in the same process as the routes; round-tripping through\s*\n?\s*\/\/ HTTP would double the latency budget \+ lose typed-error context\.\s*\n?\s*\/\/ AI-B2\.b dispatches against the in-process SessionsService instead\./,
    );
  });

  it('IntentResult 3-variant discriminated union pinned: success (intent + summary + optional captureId) + failure (intent + reason) + confirmation_required (intent + category + matchedText, W443/W445). Drift to dropping a variant would force callers to wrap execute() in try/catch instead of branching on the discriminator', () => {
    expect(body).toMatch(/export type IntentResult =/);
    expect(body).toMatch(
      /\| \{\s*\n?\s*kind: 'success';\s*\n?\s*intent: AgentIntent;\s*\n?\s*\/\*\* Free-form summary string for the transcript log\./,
    );
    expect(body).toMatch(/captureId\?: string;/);
    expect(body).toMatch(
      /\| \{\s*\n?\s*kind: 'failure';\s*\n?\s*intent: AgentIntent;\s*\n?\s*\/\*\* Customer-facing failure reason\./,
    );
    expect(body).toMatch(/kind: 'confirmation_required';/);
    expect(body).toMatch(/category: ConsequentialActionCategory;/);
  });

  it('ExecutorRunResult retains settled partial results and explicitly reports authority loss', () => {
    expect(body).toMatch(/export interface ExecutorRunResult \{/);
    expect(body).toMatch(/results: ReadonlyArray<IntentResult>;/);
    expect(body).toMatch(/ok: boolean;/);
    expect(body).toMatch(/awaitingConfirmation\?: boolean;/);
    expect(body).toMatch(/authorityLost\?: boolean;/);
  });

  it("ExecuteArgs sessionId + plan narrowing pinned: 'Refuse + clarify results are no-ops here — the caller (agent runtime) handles those before reaching the executor. The narrowing happens at the type level.' — pinned so the plan-only-narrowing (Extract<DecomposeResult, { kind: 'plan' }>) contract + caller-handles-refuse-clarify rationale stay documented", () => {
    expect(body).toMatch(
      /\* The plan to execute\. Refuse \+ clarify results are no-ops here —\s*\n?\s*\*\s+the caller \(agent runtime\) handles those before reaching the\s*\n?\s*\*\s+executor\. The narrowing happens at the type level\. \*\//,
    );
    expect(body).toMatch(/plan: Extract<DecomposeResult, \{ kind: 'plan' \}>;/);
  });

  it("AgentExecutor interface contract pinned: 'Run a plan's intents in order. Halts on first failure (returns partial results). Never throws — failures surface as IntentResult discriminants instead. AI-B2.b will accept an optional cancellation signal and propagate it to the underlying SessionsService dispatch.' — pinned so the in-order + halt-on-failure + never-throws + AI-B2.b-cancellation-signal-future-feature all stay documented", () => {
    expect(body).toMatch(/export interface AgentExecutor \{/);
    expect(body).toMatch(
      /\* Run a plan's intents in order\. Halts on first failure \(returns\s*\n?\s*\*\s+partial results\)\. Never throws — failures surface as\s*\n?\s*\*\s+IntentResult discriminants instead\./,
    );
    expect(body).toMatch(
      /\* AI-B2\.b will accept an optional cancellation signal and\s*\n?\s*\*\s+propagate it to the underlying SessionsService dispatch\./,
    );
    expect(body).toMatch(/execute\(args: ExecuteArgs\): Promise<ExecutorRunResult>;/);
  });

  it("StubAgentExecutor returns ok=true + synthetic success for every intent + cap_stub_<sessionId>_<n> captureId pattern. + 'Useful for end-to-end tests of the decompose → execute → append-transcript loop, and for the dashboard chat-UI to render a believable turn-by-turn flow during pre-launch demos.' framing — pinned so the dev/demo-only stub purpose stays documented (drift to a real-HTTP stub would defeat the purpose)", () => {
    expect(body).toMatch(/export class StubAgentExecutor implements AgentExecutor \{/);
    expect(body).toMatch(/return Promise\.resolve\(\{ results, ok: true \}\);/);
    expect(body).toMatch(
      /\.\.\.\(intent\.kind === 'capture'\s*\n?\s*\? \{ captureId: `cap_stub_\$\{args\.sessionId\}_\$\{results\.length \+ 1\}` \}\s*\n?\s*: \{\}\),/,
    );
  });

  it('stubSummary() switch keeps deterministic summaries and sends navigate URLs through the credential-safe diagnostic boundary', () => {
    expect(body).toMatch(
      /function stubSummary\(intent: AgentIntent\): string \{\s*\n?\s*switch \(intent\.kind\) \{/,
    );
    expect(body).toMatch(
      /case 'navigate':\s*\n?\s*return safeExecutorDiagnostic\(\s*`stub navigate → \$\{intent\.url\} \(returns 200; no real fetch\)`,\s*'stub navigate completed',\s*\);/,
    );
    expect(body).toMatch(/case 'interact':/);
    expect(body).toMatch(/if \(intent\.action === 'type'\) \{/);
    expect(body).toMatch(
      /return `stub type\$\{intent\.selector \? ' on ' \+ intent\.selector : ''\}`;/,
    );
    expect(body).toMatch(/case 'wait':/);
    expect(body).toMatch(/case 'capture':\s*\n?\s*return `stub captured \$\{intent\.capture\}`;/);
  });

  it("runResultToTranscriptEntry serialization helper framing pinned: 'render an ExecutorRunResult as a TranscriptEntry the agent's next turn can read. Keeps the serialization rule in one place — every consumer that wants to append executor results to a transcript must use this so the decomposer sees consistent output formatting in history.' + ✓/✗ glyph + '(plan halted on failure)' suffix ONLY on a NON-wait failure (#139: a best-effort wait failure no longer halts, so the suffix must NOT key on !ok) — pinned so the single-source-of-truth-serialization contract + the consistent-history-format-for-decomposer rationale + the glyph-encoding (✓ success / ✗ failure) survive", () => {
    expect(body).toMatch(
      /\* Helper for the dashboard chat-UI: render an ExecutorRunResult as a\s*\n?\s*\*\s+TranscriptEntry the agent's next turn can read\. Keeps the\s*\n?\s*\*\s+serialization rule in one place — every consumer that wants to\s*\n?\s*\*\s+append executor results to a transcript must use this so the\s*\n?\s*\*\s+decomposer sees consistent output formatting in `history`\./,
    );
    // #139 — the free-text fields (summary carries the navigate result URL,
    // reason the harness message, matchedText the matched phrase) are
    // page-influenced now the real executor is live, so they are sanitized
    // before joining the body the decomposer replays; the ✓/✗ glyph encoding +
    // interpolation shape are still pinned.
    expect(body).toMatch(/lines\.push\(`✓ \$\{sanitizeTranscriptText\(r\.summary\)\}`\);/);
    expect(body).toMatch(
      /lines\.push\(`✗ \$\{r\.intent\.kind\} — \$\{sanitizeTranscriptText\(r\.reason\)\}`\);/,
    );
    // The sanitizer redacts credential-shaped material first, strips C0/C1
    // controls (transcript line-forging defense), then caps length. Pinned so
    // this prompt-injection + secret-retention boundary cannot regress to raw
    // interpolation.
    expect(body).toMatch(/export function sanitizeTranscriptText\(s: string\): string \{/);
    // The input bound goes through sliceWithoutSplittingSurrogate, not a raw
    // slice: a plain UTF-16 cut landing between the halves of an astral
    // character left a lone surrogate, which reached the customer's durable
    // transcript as U+FFFD. Pinned so the cut cannot regress to `s.slice(...)`.
    expect(body).toMatch(
      /const redacted = redactText\(\s*sliceWithoutSplittingSurrogate\(s, EXECUTOR_DIAGNOSTIC_INPUT_MAX_LENGTH\),\s*\);/,
    );
    // The helper itself now lives in lib/bounded-text.ts — it is needed by a lib
    // module too (unknown-request-fields), and lib may not import from services.
    // What this file must keep is the IMPORT and the re-export, because the
    // transcript sanitiser's bound is only correct through it.
    expect(body).toMatch(
      /import \{ sliceWithoutSplittingSurrogate \} from '\.\.\/lib\/bounded-text\.js';/,
    );
    expect(body).toMatch(/export \{ sliceWithoutSplittingSurrogate \};/);
    expect(body).toMatch(
      /redacted\.replace\(\/\[\\u0000-\\u001f\\u007f-\\u009f\]\/g, ' '\)\.trim\(\)/,
    );
    expect(body).toMatch(/export const MAX_TRANSCRIPT_FIELD_LEN = 512;/);
    // #139 — the "(plan halted on failure)" suffix keys on a NON-wait failure
    // (an actual halt), NOT on !ok (which is true even when a best-effort wait
    // failed but later steps completed). Guard against a regression back to !ok.
    expect(body).toMatch(
      /runResult\.results\.some\(\(r\) => r\.kind === 'failure' && r\.intent\.kind !== 'wait'\)/,
    );
    expect(body).toMatch(/lines\.push\('\(plan halted on failure\)'\);/);
    expect(body).not.toMatch(
      /if \(!runResult\.ok\) \{\s*\n?\s*lines\.push\('\(plan halted on failure\)'\)/,
    );
    expect(body).toMatch(/role: 'agent',/);
  });

  it('AI-B2.b/c RealAgentExecutor pinned: ExecuteArgs.account?, ExecutorSessionsPort (incl wait), real dispatch of navigate/tap/type/scroll/wait/capture with the AgentIntent→driver vocab reconciliation, swipe → typed failure — pinned so the dispatch surface + the honest swipe-unsupported decision + never-throw contract survive', () => {
    expect(body).toMatch(/account\?: AccountContext;/);
    expect(body).toMatch(/export interface ExecutorSessionsPort \{/);
    expect(body).toMatch(/export class RealAgentExecutor implements AgentExecutor \{/);
    expect(body).toMatch(
      /this\.deps\.sessions\.navigate\(account, sessionId, \{ url: intent\.url \}\)/,
    );
    expect(body).toMatch(/action: \{ kind: 'tap', selector: intent\.selector \}/);
    expect(body).toMatch(
      /action: \{ kind: 'type', selector: intent\.selector, text: intent\.value \}/,
    );
    expect(body).toMatch(
      /this\.deps\.sessions\.capture\(account, sessionId, \{ kind: intent\.capture \}\)/,
    );
    // AI-B2.c wait reconciliation: selector_visible→{kind:selector}, idle→{kind:time}.
    expect(body).toMatch(/condition = \{ kind: 'selector', selector: intent\.selector \};/);
    expect(body).toMatch(/condition = \{ kind: 'time', ms \};/);
    expect(body).toMatch(/this\.deps\.sessions\.wait\(account, sessionId, \{ condition \}\)/);
    // AI-B2.c scroll reconciliation: one-viewport vertical, direction/magnitude from value.
    expect(body).toMatch(/delta_y: direction \* magnitude,/);
    // swipe stays a typed failure (no driver gesture); never-throw account guard.
    expect(body).toMatch(/swipe is not supported — use scroll \(no driver swipe gesture\)/);
    expect(body).toMatch(/executor missing account context/);
  });

  it('stub and real executors fence every intent before dispatch and retain settled work on post-dispatch revocation', () => {
    expect(body).toMatch(/shouldContinue\?: \(\) => boolean \| Promise<boolean>;/);
    expect(body).toMatch(/export async function executionMayContinue\(/);
    expect(
      (body.match(/await executionMayContinue\(args\.shouldContinue\)/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
    expect(body).toMatch(/return \{ results, ok: false, authorityLost: true \};/);
  });
});
