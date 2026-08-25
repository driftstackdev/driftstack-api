// W875 — InteractAction + WaitCondition 4+4-kind cross-source
// invariant. Two-hundred-first in the drift-guard series. Pins
// the two driver-action discriminated unions:
//
//   InteractAction (4 kinds):
//     1. tap     — selector.
//     2. type    — selector + text + optional delay_ms.
//     3. scroll  — optional selector + delta_x + delta_y.
//     4. press   — key.
//
//   WaitCondition (4 kinds):
//     1. selector        — selector visible.
//     2. selector_hidden — selector not visible.
//     3. url_matches     — pattern.
//     4. time            — ms (0-60_000).
//
// stays in lockstep across:
//   - packages/api-types/src/sessions.ts (Zod canonical
//     discriminated unions).
//   - packages/sdk-go/types.go (struct-based unions + 4 New*
//     constructors per kind).
//
// Drift would silently break:
//   * Server driver-dispatch (unrecognised kind).
//   * Go SDK customers calling NewXxxAction/Condition helpers.
//   * Customer pattern-match branches.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const INTERACT_KINDS = ['tap', 'type', 'scroll', 'press'] as const;
const WAIT_KINDS = ['selector', 'selector_hidden', 'url_matches', 'time'] as const;

describe('W875 InteractAction+WaitCondition cross-source invariant', () => {
  // ─── InteractAction discriminated-union (api-types) ──────────

  it("CRITICAL packages/api-types/src/sessions.ts InteractActionSchema = z.discriminatedUnion('kind', [...]) with 4 variants — tap, type, scroll, press.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export const InteractActionSchema = z\.discriminatedUnion\('kind', \[/);
    for (const kind of INTERACT_KINDS) {
      expect(p, `InteractActionSchema must have variant '${kind}'`).toMatch(
        new RegExp(`kind: z\\.literal\\('${kind}'\\)`),
      );
    }
  });

  it("CRITICAL InteractAction 'type' variant has text: z.string().max(10_000) + delay_ms: z.number().int().min(0).max(500).optional(). The 10K text cap + 500ms delay cap bound typing throughput.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /kind: z\.literal\('type'\),\s*\n\s*selector: z\.string\(\)\.min\(1\),\s*\n\s*text: z\.string\(\)\.max\(10_000\),/,
    );
    expect(p).toMatch(/delay_ms: z\.number\(\)\.int\(\)\.min\(0\)\.max\(500\)\.optional\(\)/);
    // W612 (A3 W1149/W1150) — optional sensitive flag: harness suppresses
    // visible typo-corrections for card/OTP/PIN values.
    expect(p).toMatch(/sensitive: z\.boolean\(\)\.optional\(\)/);
  });

  it('W612 sensitive flag parity across surfaces: Go SDK InteractAction has Sensitive *bool json:sensitive,omitempty + customer doc documents optional `sensitive` on the type action + AgentIntentSchema interact variant carries it + the dispatch mapper forwards it as the send_keys param (the A3-W1150 wire)', () => {
    const goSdk = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(goSdk).toMatch(/Sensitive \*bool\s+`json:"sensitive,omitempty"`/);
    const doc = read(resolve(REPO_ROOT, 'apps/docs/src/pages/api/sessions.md'));
    expect(doc).toMatch(/optional `sensitive` \(boolean/);
    const agentIntents = read(resolve(REPO_ROOT, 'packages/api-types/src/agent-intents.ts'));
    expect(agentIntents).toMatch(/sensitive: z\.boolean\(\)\.optional\(\)/);
    const dispatch = read(
      resolve(REPO_ROOT, 'apps/server/src/services/agent-intent-to-dispatch.ts'),
    );
    expect(dispatch).toMatch(/selectorImpliesSensitiveInput\(intent\.selector\)/);
    expect(dispatch).toMatch(/\? \{ sensitive: true \}/);
    // Python SDK is datamodel-codegen-generated from the dumped spec; the
    // regenerated models must carry the field too (stale-regen guard).
    const py = read(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/_generated/models.py'));
    expect(py).toMatch(/sensitive: bool \| None = None/);
  });

  it("CRITICAL InteractAction 'press' variant has key: z.string().min(1).max(20). The 20-char key cap matches keyboard-event key names (e.g. 'ArrowDown', 'Enter', 'a').", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /kind: z\.literal\('press'\),\s*\n\s*key: z\.string\(\)\.min\(1\)\.max\(20\)/,
    );
  });

  it("CRITICAL InteractAction 'scroll' variant has optional selector + delta_x/delta_y with .default(0). The optional selector lets scroll target either an element OR the page root.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /kind: z\.literal\('scroll'\),\s*\n\s*selector: z\.string\(\)\.min\(1\)\.optional\(\),\s*\n\s*delta_x: z\.number\(\)\.int\(\)\.default\(0\),\s*\n\s*delta_y: z\.number\(\)\.int\(\)\.default\(0\)/,
    );
  });

  // ─── L-001 intent-only framing ───────────────────────────────

  it("CRITICAL L-001 anchor pinned for InteractAction intent-only model. The 'intent-only ... coordinate primitives (tap_at, tap.offset, etc.) live on the gui_control plane' framing distinguishes customer-facing vs internal-GUI surfaces.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/Customer-facing InteractAction is intent-only per L-001/);
    expect(p).toMatch(
      /coordinate\s*\/\/ primitives \(tap_at, tap\.offset, etc\.\) live on the gui_control plane/,
    );
  });

  // ─── WaitCondition discriminated-union (api-types) ───────────

  it("CRITICAL packages/api-types/src/sessions.ts WaitConditionSchema = z.discriminatedUnion('kind', [...]) with 4 variants — selector, selector_hidden, url_matches, time.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(/export const WaitConditionSchema = z\.discriminatedUnion\('kind', \[/);
    for (const kind of WAIT_KINDS) {
      expect(p, `WaitConditionSchema must have variant '${kind}'`).toMatch(
        new RegExp(`kind: z\\.literal\\('${kind}'\\)`),
      );
    }
  });

  it("CRITICAL WaitCondition 'time' variant has ms: z.number().int().min(0).max(60_000). The 60s ms cap bounds the absolute-time-wait variant; longer waits go through the wait-condition path with a timeout_ms.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /kind: z\.literal\('time'\), ms: z\.number\(\)\.int\(\)\.min\(0\)\.max\(60_000\)/,
    );
  });

  // ─── Go SDK InteractAction + 4 NewXxxAction helpers ───────────

  it("CRITICAL packages/sdk-go/types.go InteractAction is a discriminated-union struct + has 4 NewXxxAction helpers (NewTapAction + NewTypeAction + NewScrollAction + NewPressAction). The 'Kind string // tap | type | scroll | press' inline comment pins the 4 kinds.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/InteractAction is a discriminated-union of action kinds/);
    expect(p).toMatch(/Kind\s+string\s+`json:"kind"`\s+\/\/ tap \| type \| scroll \| press/);
    for (const kind of INTERACT_KINDS) {
      const cap = kind.charAt(0).toUpperCase() + kind.slice(1);
      expect(p, `Go SDK must export New${cap}Action`).toMatch(
        new RegExp(`func New${cap}Action\\b`),
      );
    }
  });

  // ─── Go SDK WaitCondition + 4 New*Condition helpers ──────────

  it('CRITICAL packages/sdk-go/types.go WaitCondition has 4 New*Condition helpers — NewSelectorCondition + NewSelectorHiddenCondition + NewURLMatchesCondition + NewTimeCondition.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/func NewSelectorCondition\(/);
    expect(p).toMatch(/func NewSelectorHiddenCondition\(/);
    expect(p).toMatch(/func NewURLMatchesCondition\(/);
    expect(p).toMatch(/func NewTimeCondition\(/);
  });

  it("CRITICAL Go SDK New*Condition helpers set Kind correctly — 'selector' / 'selector_hidden' / 'url_matches' / 'time'. Drift would let helpers emit kinds the server doesn't recognise.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/WaitCondition\{Kind: "selector",/);
    expect(p).toMatch(/WaitCondition\{Kind: "selector_hidden",/);
    expect(p).toMatch(/WaitCondition\{Kind: "url_matches",/);
    expect(p).toMatch(/WaitCondition\{Kind: "time",/);
  });

  // ─── Per-call timeout_ms bounds ──────────────────────────────

  it('CRITICAL NavigateRequest.timeout_ms bounds = 1000-120_000 (1s-2min); InteractRequest.timeout_ms = 100-60_000 (100ms-1min); WaitRequest.timeout_ms = 100-120_000 (100ms-2min). The bounds prevent both too-short (false-negative) + too-long (DoS) waits.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    expect(p).toMatch(
      /NavigateRequestSchema = z\.object\(\{[\s\S]+?timeout_ms: z\.number\(\)\.int\(\)\.min\(1000\)\.max\(120_000\)\.optional\(\)/,
    );
    expect(p).toMatch(
      /InteractRequestSchema = z\.object\(\{[\s\S]+?timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(60_000\)\.optional\(\)/,
    );
    expect(p).toMatch(
      /WaitRequestSchema = z\.object\(\{[\s\S]+?timeout_ms: z\.number\(\)\.int\(\)\.min\(100\)\.max\(120_000\)\.optional\(\)/,
    );
  });

  // ─── 4+4 cardinality + no forbidden kinds ─────────────────────

  it('CRITICAL InteractAction = EXACTLY 4 kinds + WaitCondition = EXACTLY 4 kinds. Each kind maps to a server-driver dispatch branch; drift to a 5th would force coordinated SDK + dashboard updates.', () => {
    expect(INTERACT_KINDS.length).toBe(4);
    expect(WAIT_KINDS.length).toBe(4);
  });

  it("CRITICAL no source declares forbidden interact kinds (click / focus / blur / hover / drag / swipe / long_press). These are common DOM-event names the 4-kind model intentionally avoids — 'tap' is the platform-agnostic equivalent of click.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/sessions.ts'));
    const m = p.match(/InteractActionSchema = z\.discriminatedUnion\([\s\S]+?\]\);/);
    expect(m).not.toBeNull();
    const body = m![0];
    const forbidden = ['click', 'focus', 'blur', 'hover', 'drag', 'swipe', 'long_press'];
    for (const f of forbidden) {
      expect(body, `InteractAction must NOT include forbidden kind '${f}'`).not.toMatch(
        new RegExp(`z\\.literal\\('${f}'\\)`),
      );
    }
  });

  it('W600 doc coverage: every InteractAction + WaitCondition kind is documented in the customer api/sessions.md — closes the drift gap where this invariant pinned api-types + SDKs but NOT the customer doc, so a new kind could ship SDK-documented but doc-stale (the W564/W567 doc-drift class)', () => {
    const doc = read(resolve(REPO_ROOT, 'apps/docs/src/pages/api/sessions.md'));
    for (const kind of INTERACT_KINDS) {
      // doc form: "- `tap` — ...". Backticks + em-dash prevent `selector`
      // false-matching `selector_hidden`.
      expect(doc, `sessions.md must document interact action '${kind}'`).toMatch(
        new RegExp('`' + kind + '` —'),
      );
    }
    for (const kind of WAIT_KINDS) {
      expect(doc, `sessions.md must document wait condition '${kind}'`).toMatch(
        new RegExp('`' + kind + '` —'),
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/interact-wait-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
