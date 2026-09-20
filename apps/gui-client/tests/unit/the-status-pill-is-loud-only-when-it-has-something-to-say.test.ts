// `missionPill` — what the one word at the top of the AI view is allowed to
// shout about.
//
// The failure this replaces is not a colour preference. `describeAgentSessionState`
// has NINE labels and FIVE tones, and the collisions were the bar making claims
// that were not true:
//   • `Session open`, `Idle` and `Paused` all carried `starting` (amber), so a
//     session merely open wore the same colour as one coming up — the green
//     "Session open" that sat beside a red "Stopped at step 3";
//   • `Ended` carried `ready` (green), so a session that had FINISHED wore the
//     colour of one that was ready to go;
//   • `Stopping` carried `stopping`, which is the grey status token used as
//     TEXT on its own 15% wash: 3.18:1 in dark and 2.47:1 in light. Both are
//     under the 4.5 a 10px label needs, and neither had ever been rendered by a
//     harness scene, so it shipped for months.
//
// Spec §3.3 re-cuts the axis: LOUD (ready / busy / run / bad) only when the pill
// is reporting something the customer should act on; NEUTRAL — the quiet ink on
// an elevated surface — for every "a session exists and nothing is happening"
// label. The cut does not follow `tone`, so it cannot be a remapping of it, and
// `session-liveness.ts` is untouched: its `tone` is the session's own liveness
// and another surface may want it.
//
// The arm that matters most is the LAST one. Keying a table on a display string
// means a label added upstream falls through to the default, and the default is
// quiet — the one tone that would never look wrong enough to notice. So the
// labels are read out of the session-liveness SOURCE and every one of them must
// have been decided here on purpose.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@driftstack/sdk';
import { describeAgentSessionState } from '../../src/lib/session-liveness';
import {
  missionPill,
  missionPillToneLabels,
  NEEDS_APPROVAL_LABEL,
  type MissionStatusChat,
} from '../../src/views/agent-chat/mission-status';

const SESSION_LIVENESS_SRC = fileURLToPath(
  new URL('../../src/lib/session-liveness.ts', import.meta.url),
);

/** A complete AgentSession, so no fixture here adds to the test-type backlog. */
function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'agt_pill',
    account_id: 'acc_1',
    driftstack_session_id: null,
    status: 'active',
    closed_reason: null,
    closed_at: null,
    token_budget_total: 100_000,
    token_budget_remaining: 82_000,
    transcript_length: 2,
    created_by_user_id: null,
    mode: 'ai',
    model: 'claude-sonnet-5',
    pair_mode_state: null,
    stop_on_exit_ip_change: false,
    created_at: '2026-06-15T06:00:00.000Z',
    updated_at: '2026-06-15T06:40:00.000Z',
    ...over,
  };
}

/** A session whose worker beat is fresh and says `state`. */
function beating(state: 'active' | 'provisioning' | 'idle' | 'terminating'): AgentSession {
  return session({
    liveness: { state, fresh: true },
  });
}

/** The pill for a session, with no confirmation pending. */
function pillFor(s: AgentSession | null, aiReady = true): ReturnType<typeof missionPill> {
  return missionPill({}, describeAgentSessionState(s, aiReady));
}

const GATED: MissionStatusChat = {
  pendingConfirmation: { category: 'purchase', matchedText: 'Place order · $104.00' },
};

describe('the status pill is loud only when it has something to say', () => {
  it('shouts for the four states the customer can act on', () => {
    expect(pillFor(null, true)).toMatchObject({ label: 'AI ready', tone: 'ready' });
    expect(pillFor(null, false)).toMatchObject({ label: 'Not connected', tone: 'bad' });
    expect(pillFor(beating('provisioning'))).toMatchObject({ label: 'Starting', tone: 'busy' });
    expect(pillFor(beating('active'))).toMatchObject({ label: 'Running', tone: 'run' });
  });

  it('goes quiet for every "a session exists and nothing is happening" label', () => {
    // ⛔ THE FIX. Each of these was a colour that meant something else.
    expect(pillFor(beating('idle'))).toMatchObject({ label: 'Idle', tone: 'neutral' });
    expect(pillFor(beating('terminating'))).toMatchObject({ label: 'Stopping', tone: 'neutral' });
    expect(pillFor(session({ status: 'paused' }))).toMatchObject({
      label: 'Paused',
      tone: 'neutral',
    });
    expect(pillFor(session())).toMatchObject({ label: 'Session open', tone: 'neutral' });
    expect(pillFor(session({ status: 'closed' }))).toMatchObject({
      label: 'Ended',
      tone: 'neutral',
    });
  });

  it('CONTROL — the table is not simply quiet about everything', () => {
    // An all-neutral map would pass every arm above except the first. This says
    // so out loud: the two halves are decided separately, and both exist.
    const tones = new Set(
      ['AI ready', 'Not connected', 'Starting', 'Running', 'Idle', 'Stopping'].map(
        (label) => missionPill({}, { label, tone: 'ready', title: 't' }).tone,
      ),
    );
    expect(tones).toEqual(new Set(['ready', 'bad', 'busy', 'run', 'neutral']));
  });

  it('a pending decision outranks whatever the session is doing', () => {
    // The gate is the one state in the view that will not move on its own.
    const running = describeAgentSessionState(beating('active'), true);
    expect(missionPill(GATED, running)).toMatchObject({
      label: NEEDS_APPROVAL_LABEL,
      tone: 'busy',
    });
    // …and it says why on hover, rather than inheriting the session's sentence.
    expect(missionPill(GATED, running).title).not.toBe(running.title);
    expect(missionPill(GATED, running).title).toMatch(/approve or deny/i);
    // CONTROL: without the gate, the same session is `Running` again — so the
    // arm above measures the override and not the fixture.
    expect(missionPill({}, running)).toMatchObject({ label: 'Running', tone: 'run' });
  });

  it('survives a hook double that has none of the fields', () => {
    // About a dozen view tests mock `useAgentChat` with a partial object.
    const ready = describeAgentSessionState(null, true);
    expect(() => missionPill({}, ready)).not.toThrow();
    expect(missionPill({ pendingConfirmation: null }, ready).label).toBe('AI ready');
  });

  it('keeps the session’s own hover sentence, which is where the WHY lives', () => {
    const ended = describeAgentSessionState(session({ status: 'closed' }), true);
    expect(missionPill({}, ended).title).toBe(ended.title);
    expect(missionPill({}, ended).title).toBe('This session has ended.');
  });

  it('⛔ every label session-liveness can produce was given a tone on purpose', () => {
    // ⛔ THE ARM THAT KEEPS THE TABLE HONEST. `missionPill` keys on a DISPLAY
    // STRING, so a label added to session-liveness.ts without an entry here
    // falls to `neutral` — quiet, readable, and wrong for anything the customer
    // needs to act on. The population is DERIVED from the other file rather
    // than typed out here: a list typed here would go stale in exactly the way
    // this arm exists to catch.
    const src = readFileSync(SESSION_LIVENESS_SRC, 'utf8');
    const labels = [...src.matchAll(/\blabel: '([^']+)'/g)].map((m) => m[1]);
    // The sweep must have found something — a regex that stopped matching would
    // report a clean run over an empty population.
    expect(labels.length, 'no labels found in session-liveness.ts').toBeGreaterThanOrEqual(9);
    const known = new Set(missionPillToneLabels());
    for (const label of labels) {
      expect(
        known.has(label as string),
        `session-liveness label "${String(label)}" has no tone`,
      ).toBe(true);
    }
    // CONTROL: the check can fail. A label that is not in the file is not in
    // the table either, and the membership test says so.
    expect(known.has('Reticulating splines')).toBe(false);
  });
});
