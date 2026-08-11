// V-757 — the pair-mode state machine declares transitions nothing emits, and the
// customer docs described the resulting states as observable.
//
// `agent-pair-mode-state.ts` reduces 10 transition kinds. Only TWO are ever constructed
// outside the reducer — `takeover-request` and `handback-request` (plus `heartbeat-timeout`
// from the sweep). In particular nothing emits `takeover-grant`, and `human-driving` is
// produced ONLY by `takeover-grant`, while `handback-request` is accepted ONLY from
// `human-driving`. So:
//
//   takeover()  → parks in `takeover-pending`  ✅ works
//   handback()  → 409 pair-mode-conflict       ❌ always, on every deployment
//   `human-driving` / `handback-pending` / `handback-queued` → unreachable
//   after 30s without a heartbeat the sweep silently returns it to `ai-driving`
//
// This is a KNOWN cross-agent gap, not a plain bug: the harness has no control-plane
// surface to fire the missing transitions, and the future contract is already specified in
// `docs/internal/cross-agent-control-plane-contract.md`. So the fix was documentation —
// caveats on the three SDK quickstarts and the API reference, which all promised the
// handback half as ordinary behaviour.
//
// This guard is BIDIRECTIONAL on purpose. It fails if the caveats disappear, AND it fails
// if the emitter ships while the caveats remain — because a doc that warns about a
// limitation that no longer exists is its own defect, and nothing else would catch it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const REDUCER = resolve(REPO_ROOT, 'apps/server/src/services/agent-pair-mode-state.ts');

/** Files that could plausibly construct a transition to feed the reducer. */
const PRODUCER_GLOBS = [
  'apps/server/src/routes/agent-sessions.ts',
  'apps/server/src/services/agent-pair-mode-heartbeat-sweep.ts',
  'apps/server/src/services/agent-runtime.ts',
];

/** Customer surfaces that describe the takeover/handback loop. */
const CAVEATED_DOCS = [
  'apps/docs/src/pages/sdk/typescript-quickstart.md',
  'apps/docs/src/pages/sdk/python-quickstart.md',
  'apps/docs/src/pages/sdk/go-quickstart.md',
  'apps/docs/src/pages/api/agent-sessions.md',
];

/**
 * The transition kinds the reducer declares. Scoped to the `PairModeTransition` union
 * ONLY: the file also declares `PairModeState` with the same `| { kind: '...' }` shape, and
 * sweeping both in wrongly reported five STATE kinds as un-emitted — states are produced BY
 * the reducer, never constructed by a caller, so they can never appear as "produced".
 */
function declaredTransitions(): Set<string> {
  const src = readFileSync(REDUCER, 'utf8');
  const start = src.indexOf('export type PairModeTransition =');
  expect(start, 'PairModeTransition union not found — did the type get renamed?').toBeGreaterThan(
    0,
  );
  // NOT indexOf(';') — each union member contains its own semicolons
  // (`{ kind: 'takeover-grant'; at: string }`), so that truncates after member one. The
  // vacuity floor below caught exactly that. Bound by the next top-level declaration.
  const rest = src.slice(start + 1);
  const nextDecl = rest.search(/\n(?:export |type |const |function |\/\*\*)/);
  const block = nextDecl === -1 ? rest : rest.slice(0, nextDecl);
  const members = block.match(/\|\s*\{\s*kind:\s*'([a-z-]+)'/g) ?? [];
  return new Set(members.map((m) => (m.match(/'([a-z-]+)'/) as RegExpMatchArray)[1] as string));
}

/** Transition kinds actually constructed by a caller, i.e. reachable. */
function producedTransitions(): Set<string> {
  const out = new Set<string>();
  for (const rel of PRODUCER_GLOBS) {
    let src: string;
    try {
      src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/kind:\s*'([a-z-]+)'/g)) out.add(m[1] as string);
  }
  return out;
}

/**
 * Transitions with no producer as of V-757. If this set SHRINKS, someone shipped an
 * emitter — good news, and the doc caveats must come off in the same change.
 */
const KNOWN_UNEMITTED = [
  'decompose-settled',
  'handback-cancel',
  'handback-complete',
  'handback-request-queued',
  'takeover-decline',
  'takeover-grant',
  'takeover-request-queued',
];

describe('pair-mode unreachable states stay caveated (V-757)', () => {
  it('CRITICAL the set of un-emitted transitions has not changed — if it shrank, remove the doc caveats', () => {
    const declared = declaredTransitions();
    const produced = producedTransitions();

    // Vacuity guards: a broken extraction on either side makes the diff meaningless.
    expect(declared.size, 'transition kinds parsed from PairModeTransition').toBeGreaterThan(8);
    expect(produced.has('takeover-request'), 'takeover-request must parse as produced').toBe(true);
    expect(produced.has('handback-request'), 'handback-request must parse as produced').toBe(true);

    const unemitted = [...declared].filter((k) => !produced.has(k)).sort();

    expect(
      unemitted,
      'transitions the reducer accepts but nothing emits. If this list SHRANK, an emitter ' +
        'shipped — delete the corresponding caveat from the SDK quickstarts and ' +
        'api/agent-sessions.md in the same commit, and update this expectation. If it GREW, ' +
        'a new transition was declared with no producer and its states are unreachable.',
    ).toEqual(KNOWN_UNEMITTED);
  });

  it('CRITICAL human-driving is reachable only via takeover-grant, which is un-emitted — so handback always 409s', () => {
    const src = readFileSync(REDUCER, 'utf8');
    // The two structural facts that make the whole handback half unreachable. If either
    // changes, the caveats' reasoning no longer holds and must be re-derived.
    expect(src).toMatch(/transition\.kind === 'takeover-grant'[\s\S]{0,200}kind: 'human-driving'/);
    expect(src).toMatch(
      /case 'human-driving':[\s\S]{0,120}transition\.kind === 'handback-request'/,
    );
    expect(KNOWN_UNEMITTED).toContain('takeover-grant');
  });

  it('every customer surface describing the loop carries the unreachable caveat', () => {
    for (const rel of CAVEATED_DOCS) {
      const body = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      expect(body, `${rel} must state the handback half cannot complete`).toMatch(
        /cannot complete on any deployment today|transition is unreachable today/,
      );
      // The specific consequence a customer needs, not just a vague warning.
      expect(body, `${rel} must name the 409`).toMatch(/pair-mode-conflict/);
    }
  });
});
