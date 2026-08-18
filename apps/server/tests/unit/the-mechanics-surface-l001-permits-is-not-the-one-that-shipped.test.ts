// V-825 — L-001 confines coordinate-level mechanics to one gated, unexported
// surface. A second surface shipped that meets none of its three conditions.
//
// L-001 ("The customer-facing API is intent-only") allows mechanics primitives
// in exactly one place — the GUI's manual-control mode, where a human is
// literally clicking pixels — and only on a surface that is:
//
//   1. server-internal: schemas NOT in `@driftstack/api-types`;
//   2. gated behind the `gui_control` API-key scope;
//   3. absent from the customer SDKs.
//
// `POST /v1/sessions/:id/gui-input` was built to all three, and
// `gui-input-l001-cross-source-invariant.test.ts` guards it. That guard reads
// `apps/server/src/schemas/gui-input.ts` and nothing else — so it watches the
// surface that COMPLIES and is structurally blind to the one that does not.
// This is the third guard in this sweep found watching only one side of its own
// invariant (see V-813's doc-subset-of-enforced, V-820's mutations-only).
//
// `POST /v1/agent-sessions/:id/input-event` meets none of the three:
//
//   1. `InputEventSchema` is in `packages/api-types/src/agent-input-event.ts`,
//      re-exported through the barrel. `mouseMove` and `tap` carry raw integer
//      x/y; `keyDown`/`keyUp` carry key + modifiers. L-001's own ❌ list names
//      `tap_at(x, y)` and `key_down('a'); key_up('a')`.
//   2. The preHandler is `controlKeyOrAccountAuth('write')` — a per-session
//      control key OR an ordinary customer key with `write`. No `gui_control`.
//   3. `sendInputEvent` ships in all three SDKs and the endpoint is in the spec.
//
// WHAT THIS FILE DOES NOT DO. It does not assert the violation away, and it
// does not assert that the surface should be withdrawn.
//
// V-864 resolved the framing this file originally recorded. It presented the
// choice as amend L-001 or withdraw a surface shipping in three SDKs, and that
// was a false binary. The exception rests on there being no automation to
// bypass, which is a claim about the CALLER; an ordinary `write` key evidences
// nothing about who is calling, so the operative condition is the credential
// rather than the use case. L-001 now says so. The gate itself is unchanged —
// the route still accepts a `write` key — which is why every arm below still
// describes a live divergence rather than a closed one.
//
// What this file does: pin the CURRENT state so the divergence cannot widen
// quietly, and fail if either side moves — so whoever applies the amendment
// does it on purpose and meets the note while doing so.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const INPUT_EVENT = resolve(REPO_ROOT, 'packages/api-types/src/agent-input-event.ts');
const BARREL = resolve(REPO_ROOT, 'packages/api-types/src/index.ts');
const AGENT_ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes/agent-sessions.ts');
const SESSIONS_ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes/sessions.ts');
const LOCKED = resolve(REPO_ROOT, 'docs/locked-decisions.md');

/**
 * The mechanics vocabulary on the customer surface today. Recorded, not
 * approved — every entry is a primitive L-001 says does not belong there.
 */
const INPUT_EVENT_VARIANTS: readonly string[] = [
  'keyDown',
  'keyUp',
  'mouseDown',
  'mouseMove',
  'mouseUp',
  'ping',
  'swipe',
  'tap',
  'touchEnd',
  'touchMove',
  'touchStart',
  'wheel',
];

function variants(): string[] {
  const src = readFileSync(INPUT_EVENT, 'utf8');
  const start = src.indexOf('export const InputEventSchema');
  const end = src.indexOf('export type InputEvent', start);
  const union = src.slice(start, end).replace(/\/\/[^\n]*/g, '');
  return [
    ...new Set([...union.matchAll(/type:\s*z\.literal\('([^']+)'\)/g)].map((m) => m[1] as string)),
  ].sort();
}

describe('V-825 the mechanics surface L-001 permits is not the one that shipped', () => {
  it('CRITICAL the union is really parsed. Every arm below compares against it, so an empty parse would agree with an empty expectation and report the decision as honoured when it is not — which is the exact failure mode of the guard this one exists beside.', () => {
    expect(variants().length, 'InputEventSchema variants parsed').toBeGreaterThan(8);
  });

  it('CRITICAL the customer-facing mechanics vocabulary has not widened. Each of these is a primitive L-001 confines to the gated GUI surface, and every one of them is reachable from the customer SDKs today. A NEW variant here extends an already-violated decision further — decide first, then update this list.', () => {
    expect(variants()).toEqual([...INPUT_EVENT_VARIANTS].sort());
  });

  it('CRITICAL the schema is still reachable from the api-types barrel, which is condition 1 of L-001 and is not met. Asserted rather than assumed: the re-export is a wildcard, so grepping the barrel for the symbol name finds nothing and reads as compliance — that is how this was nearly refuted while being verified.', () => {
    const barrel = readFileSync(BARREL, 'utf8');
    expect(barrel, 'the wildcard re-export that puts mechanics on the customer surface').toMatch(
      /export \* from '\.\/agent-input-event\.js';/,
    );
  });

  it('CRITICAL the two surfaces still differ in exactly the way L-001 cares about — one requires gui_control, the other does not. If the agent-sessions route ever gains a gui_control gate, condition 2 is met and the note in locked-decisions.md needs revisiting; if the gui-input route loses it, the compliant surface has stopped complying.', () => {
    const sessions = readFileSync(SESSIONS_ROUTES, 'utf8');
    const agent = readFileSync(AGENT_ROUTES, 'utf8');

    const guiInputIdx = sessions.indexOf("'/v1/sessions/:id/gui-input'");
    expect(guiInputIdx, 'the gui-input route').toBeGreaterThan(-1);
    expect(
      sessions.slice(guiInputIdx, guiInputIdx + 400),
      'the compliant surface must keep its gui_control gate',
    ).toMatch(/requireScope\('gui_control'\)/);

    const inputEventIdx = agent.indexOf("'/v1/agent-sessions/:id/input-event'");
    expect(inputEventIdx, 'the input-event route').toBeGreaterThan(-1);
    const gate = agent.slice(inputEventIdx, inputEventIdx + 900);
    expect(gate, 'the second surface takes an ordinary write key').toMatch(
      /controlKeyOrAccountAuth\('write'\)/,
    );
    expect(
      gate,
      'no gui_control gate on the second surface — the state this file records',
    ).not.toMatch(/requireScope\('gui_control'\)/);
  });

  it('CRITICAL locked-decisions.md carries the divergence note. Without it a reader meets three conditions stated as fact and has no way to learn that one of the two mechanics surfaces meets none of them. If the divergence is ever resolved, delete the note and this arm together.', () => {
    const locked = readFileSync(LOCKED, 'utf8');
    expect(locked).toMatch(/⚠ V-825 — a SECOND mechanics surface shipped, and it meets none of/);
    expect(locked, 'the note must name the route, not gesture at it').toMatch(
      /`POST \/v1\/agent-sessions\/:id\/input-event` is a different surface/,
    );
  });

  it('V-864 CRITICAL the amendment naming the CREDENTIAL as the operative condition is recorded. V-825 left this as amend-or-withdraw, which is a false choice: the exception rests on there being no automation to bypass, that is a claim about the caller, and an ordinary write key evidences nothing about who is calling. Without this paragraph a reader still meets the original binary and cannot see that the remedy is narrower than withdrawing a surface from three shipped SDKs.', () => {
    const locked = readFileSync(LOCKED, 'utf8');
    expect(locked, 'the amendment itself').toMatch(
      /V-864 — amend-or-withdraw was a false choice, and the answer is neither/,
    );
    expect(locked, 'and it must state the rule in terms of the credential').toMatch(
      /mechanics-level primitives may live on a surface\s*>?\s*whose credential establishes a human-driven session/,
    );
    expect(
      locked,
      'and record that it is not yet applied, so the note cannot read as done',
    ).toMatch(/\*\*Not yet\s*>?\s*applied\.\*\*/);
  });
});
