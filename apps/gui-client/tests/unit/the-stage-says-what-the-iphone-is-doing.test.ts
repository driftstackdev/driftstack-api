// The stage's words and its arithmetic, with no DOM in sight.
//
// Stage 4 of the AI-view rebuild (spec §3.4, §1). The stage answers "what is
// the iPhone doing" from FOUR independent sources — the chat, the session
// lifecycle, whether we are watching a stream, and whether this deployment can
// carry out browser actions at all — and those overlap: a paused chat on a live
// stream in a preview deployment matches three rows of the spec's table at
// once. Precedence is therefore a design decision and not an implementation
// detail, which is why it lives in a pure function and is pinned here.
//
// The same goes for the two numbers: the tier boundaries the whole reflow hangs
// on, and the phone's width, which is the one piece of layout arithmetic two
// shipping WebViews cannot do in CSS.

import { describe, expect, it } from 'vitest';
import type { AgentIntent, AgentIntentResult, AgentSession } from '@driftstack/sdk';
import type { ChatTurn } from '../../src/lib/use-agent-chat';
import {
  browsingFrom,
  stageCaption,
  stageHud,
  stageIsStarting,
  startupBeats,
  stepsThatRan,
} from '../../src/views/agent-chat/stage-copy';
import {
  LARGE_VIEW_MIN_PX,
  NARROW_VIEW_MAX_PX,
  SHORT_VIEW_MAX_PX,
  TALL_VIEW_MIN_PX,
  WIDE_VIEW_MIN_PX,
  viewTierFor,
} from '../../src/views/agent-chat/use-view-width';
import { DEVICE_ASPECT, deviceWidthFor } from '../../src/views/agent-chat/use-device-fit';

const SESSION: AgentSession = {
  id: 'agt_stage_copy',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  closed_at: null,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 2,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-sonnet-5',
  stop_on_exit_ip_change: false,
  pair_mode_state: null,
  created_at: '2026-06-15T06:00:00.000Z',
  updated_at: '2026-06-15T06:40:00.000Z',
};

/** A navigate intent, fully typed so this file adds nothing to the type census. */
function navigate(url: string): AgentIntent {
  return { kind: 'navigate', url };
}

function success(summary: string): AgentIntentResult {
  return { kind: 'success', intent: navigate('https://shop.example.com/'), summary };
}

function agentTurn(id: number, results: ReadonlyArray<AgentIntentResult>): ChatTurn {
  return {
    id,
    role: 'agent',
    response: {
      kind: 'plan-executed',
      session: SESSION,
      intents: results.map((r) => r.intent),
      results: [...results],
      ok: true,
    },
  };
}

describe('the stage chip says the one thing that matters most', () => {
  it('STANDBY when nothing is happening', () => {
    expect(stageHud({})).toEqual({
      chip: 'STANDBY',
      tone: 'quiet',
      mark: 'pip',
      note: 'Live view',
    });
  });

  it('LIVE — and only the LIVE pip beats', () => {
    const hud = stageHud({ watch: 'live', sending: true });
    expect(hud.chip).toBe('LIVE');
    expect(hud.mark).toBe('pip-beat');
    expect(hud.note).toBe('Read-only — the AI is driving');
    // Every other state's mark is still, because a room with an approval in it
    // has nothing moving in it at all (spec §3.6).
    expect(stageHud({ gated: true }).mark).toBe('pause');
    expect(stageHud({ watch: 'live' }).mark).toBe('pip-ready');
  });

  it('STARTING while a device is being found, whichever source says so', () => {
    expect(stageHud({ sending: true }).chip).toBe('STARTING');
    expect(stageHud({ session: 'provisioning' }).chip).toBe('STARTING');
    expect(stageHud({ watch: 'loading' }).chip).toBe('STARTING');
    expect(stageIsStarting(stageHud({ sending: true }))).toBe(true);
    expect(stageIsStarting(stageHud({ watch: 'live', sending: true }))).toBe(false);
  });

  it('SESSION OPEN keeps its green pip for a task that WORKED, and drops it otherwise', () => {
    expect(stageHud({ watch: 'live' }).mark).toBe('pip-ready');
    expect(stageHud({ watch: 'live', trouble: true }).mark).toBe('pip');
    // …and both still say the same words, so colour is never the only signal.
    expect(stageHud({ watch: 'live', trouble: true }).chip).toBe('SESSION OPEN');
  });

  it('⛔ PAUSED outranks the stream: a decision waiting is the thing not to miss', () => {
    // A live stream AND a pending decision: the customer needs the second.
    expect(stageHud({ watch: 'live', sending: true, gated: true }).chip).toBe('PAUSED');
    // CONTROL — without the gate the same input is LIVE, so the arm above is
    // measuring precedence and not just "gated produces PAUSED".
    expect(stageHud({ watch: 'live', sending: true }).chip).toBe('LIVE');
  });

  it('⛔ PREVIEW outranks everything: there is no iPhone here to promise', () => {
    expect(stageHud({ preview: true, watch: 'live', sending: true, gated: true }).chip).toBe(
      'PREVIEW',
    );
    // The panel's own "this deployment has no driver" steady state says it too.
    expect(stageHud({ watch: 'simulated' }).chip).toBe('PREVIEW');
  });

  it('ENDED beats a stream that is nominally still up, and UNAVAILABLE never says LIVE', () => {
    expect(stageHud({ watch: 'ended' }).chip).toBe('ENDED');
    expect(stageHud({ session: 'ended' }).chip).toBe('ENDED');
    // A stream we cannot show must not be advertised as one we can.
    expect(stageHud({ watch: 'error', sending: true }).chip).toBe('UNAVAILABLE');
  });
});

describe('the caption under the phone mirrors the timeline', () => {
  it('idle reads as an invitation, not an empty room', () => {
    const c = stageCaption({});
    expect(c.idle).toBe(true);
    expect(c.subject).toBe('Nothing running yet');
    expect(c.body).toBe('Send a task and a real iPhone appears here, live.');
  });

  it('acting names the STEP, from the plan the server wrote', () => {
    const c = stageCaption({
      phase: 'acting',
      livePlan: { labels: ['Opened the store', 'Open the best-rated pair'], total: 2 },
      liveStepIndex: 1,
      livePhase: 'Looking at the page…',
    });
    expect(c.lead).toBe('Now');
    expect(c.subject).toBe('Open the best-rated pair');
  });

  it('…and falls back to the phase, then to one honest word, never to a guess', () => {
    expect(stageCaption({ phase: 'acting', livePhase: 'Looking at the page…' }).subject).toBe(
      'Looking at the page…',
    );
    expect(stageCaption({ phase: 'acting' }).subject).toBe('Working…');
    // An index the plan does not reach is an absence, not labels[-1].
    expect(
      stageCaption({
        phase: 'acting',
        livePlan: { labels: ['one'], total: 1 },
        liveStepIndex: 7,
        livePhase: 'Looking at the page…',
      }).subject,
    ).toBe('Looking at the page…');
  });

  it('paused names the step it is HOLDING BEFORE', () => {
    const c = stageCaption({ phase: 'paused', gatedLabel: 'Place the order' });
    expect(c.lead).toBe('Holding before');
    expect(c.subject).toBe('Place the order');
    expect(c.icon).toBe('pause');
  });

  it('⛔ "the iPhone is still on this page" is claimed ONLY while a session is open', () => {
    expect(stageCaption({ phase: 'done', sessionActive: true }).subject).toBe(
      'the iPhone is still on this page',
    );
    // Session closed: the lead stands alone rather than claiming a page that is
    // no longer on any screen.
    expect(stageCaption({ phase: 'done', sessionActive: false }).subject).toBe('');
    expect(stageCaption({ phase: 'done', sessionActive: false }).lead).toBe('Finished');
  });

  it('trouble counts the steps that ran, and says "Stopped" when it cannot', () => {
    expect(stageCaption({ phase: 'trouble', stoppedAfter: 3 }).lead).toBe('Stopped at step 3');
    expect(stageCaption({ phase: 'trouble', stoppedAfter: null }).lead).toBe('Stopped');
    expect(stageCaption({ phase: 'trouble', stoppedAfter: 0 }).lead).toBe('Stopped');
  });

  it('preview says why there is nothing to watch, whatever the phase is', () => {
    const c = stageCaption({ phase: 'acting', preview: true });
    expect(c.subject).toBe('Live view unavailable');
    expect(c.body).toBe('Browser actions run in preview mode, so there is no live view.');
  });

  it('stepsThatRan reads the LAST agent turn, and nothing else', () => {
    const turns: ReadonlyArray<ChatTurn> = [
      agentTurn(1, [success('a'), success('b')]),
      { id: 2, role: 'user', text: 'and again' },
      agentTurn(3, [success('c')]),
    ];
    expect(stepsThatRan(turns)).toBe(1);
    expect(stepsThatRan([])).toBeNull();
    expect(stepsThatRan(undefined)).toBeNull();
  });

  it('⛔ counts an INTERRUPTED turn too — it is the commonest trouble state', () => {
    // A turn whose connection dropped never settles into a `response`; what ran
    // lives under `interrupted.steps`. Reading only the settled shape made the
    // caption say "Stopped" with no number, beside a timeline plainly showing
    // one.
    const interrupted: ChatTurn = {
      id: 4,
      role: 'agent',
      interrupted: { reason: 'The connection to the browser dropped.', steps: [success('a')] },
    };
    expect(stepsThatRan([interrupted])).toBe(1);
    expect(stageCaption({ phase: 'trouble', stoppedAfter: stepsThatRan([interrupted]) }).lead).toBe(
      'Stopped at step 1',
    );
    // CONTROL: a turn that stopped before ANY step still says "Stopped", not
    // "Stopped at step 0".
    const nothingRan: ChatTurn = {
      id: 5,
      role: 'agent',
      interrupted: { reason: 'The connection to the browser dropped.', steps: [] },
    };
    expect(stepsThatRan([nothingRan])).toBe(0);
    expect(stageCaption({ phase: 'trouble', stoppedAfter: 0 }).lead).toBe('Stopped');
  });
});

describe('the start-up strip walks three beats', () => {
  it('reserves the iPhone, starts the browser, then opens the live view', () => {
    expect(startupBeats({}).map((b) => b.state)).toEqual(['active', 'waiting', 'waiting']);
    expect(startupBeats({ hasSession: true }).map((b) => b.state)).toEqual([
      'done',
      'active',
      'waiting',
    ]);
    expect(startupBeats({ hasSession: true, watch: 'live' }).map((b) => b.state)).toEqual([
      'done',
      'done',
      'active',
    ]);
  });

  it('carries the words a customer can read, in order', () => {
    expect(startupBeats({}).map((b) => b.label)).toEqual([
      'iPhone reserved',
      'Starting the browser',
      'Live view',
    ]);
  });
});

describe('where the phone is browsing from is derived, never invented', () => {
  it('names the timezone’s own city beside the country', () => {
    const p = browsingFrom({
      exit_ip: '203.0.113.24',
      exit_country: 'DE',
      exit_timezone: 'Europe/Berlin',
    });
    expect(p?.label).toBe('Browsing from Berlin, DE');
    // The narrow tier has no facts row, so the place rides up beside the state
    // chip in a 252px stage — where the preposition is what gets cut off.
    expect(p?.short).toBe('Berlin, DE');
    expect(p?.detail).toBe('Browsing from Berlin, DE · 203.0.113.24 · Europe/Berlin');
    expect(p?.ip).toBe('203.0.113.24');
  });

  it('underscores are spaces in a zone name, because that is what they stand for', () => {
    expect(browsingFrom({ exit_country: 'US', exit_timezone: 'America/New_York' })?.label).toBe(
      'Browsing from New York, US',
    );
  });

  it('⛔ an absence is an ABSENCE — nothing is guessed from a partial report', () => {
    // No zone: the country alone, not a city picked from somewhere.
    expect(browsingFrom({ exit_country: 'DE' })?.label).toBe('Browsing from DE');
    // No country and an unusable zone: NOTHING. An empty facts row is honest;
    // "Browsing from —" is not.
    expect(browsingFrom({ exit_timezone: 'UTC' })).toBeNull();
    expect(browsingFrom({ exit_ip: '203.0.113.24' })).toBeNull();
    expect(browsingFrom(null)).toBeNull();
    expect(browsingFrom({ exit_country: null, exit_timezone: null })).toBeNull();
    // An empty string is not a place either.
    expect(browsingFrom({ exit_country: '  ' })).toBeNull();
  });

  it('the address is in the detail line only when it was observed', () => {
    const p = browsingFrom({ exit_country: 'DE', exit_timezone: 'Europe/Berlin' });
    expect(p?.detail).toBe('Browsing from Berlin, DE · Europe/Berlin');
    expect(p?.ip).toBeNull();
  });
});

describe('the five reflow tiers, at their boundaries', () => {
  it('every tier switches exactly where spec §1 says', () => {
    expect(viewTierFor(NARROW_VIEW_MAX_PX, 800).narrow).toBe(true);
    expect(viewTierFor(NARROW_VIEW_MAX_PX + 1, 800).narrow).toBe(false);
    expect(viewTierFor(WIDE_VIEW_MIN_PX, 800).wide).toBe(true);
    expect(viewTierFor(WIDE_VIEW_MIN_PX - 1, 800).wide).toBe(false);
    expect(viewTierFor(1000, SHORT_VIEW_MAX_PX).short).toBe(true);
    expect(viewTierFor(1000, SHORT_VIEW_MAX_PX + 1).short).toBe(false);
    expect(viewTierFor(1000, TALL_VIEW_MIN_PX).tall).toBe(true);
    expect(viewTierFor(1000, TALL_VIEW_MIN_PX - 1).tall).toBe(false);
  });

  it('`large` needs BOTH axes — a tall narrow window is not a large one', () => {
    expect(viewTierFor(WIDE_VIEW_MIN_PX, LARGE_VIEW_MIN_PX).large).toBe(true);
    expect(viewTierFor(WIDE_VIEW_MIN_PX - 1, LARGE_VIEW_MIN_PX).large).toBe(false);
    expect(viewTierFor(WIDE_VIEW_MIN_PX, LARGE_VIEW_MIN_PX - 1).large).toBe(false);
  });

  it('⛔ AN UNMEASURED BOX IS IN NO TIER — 0 is "not laid out", not "as small as can be"', () => {
    // jsdom measures 0x0. Read as a size, that is ≤ 900 AND ≤ 620, and every
    // view test would render the 44px-strip short-window layout.
    expect(viewTierFor(0, 0)).toEqual({
      narrow: false,
      wide: false,
      short: false,
      tall: false,
      large: false,
    });
    // One axis unmeasured does not poison the other.
    expect(viewTierFor(736, 0).narrow).toBe(true);
    expect(viewTierFor(736, 0).short).toBe(false);
  });

  it('the window sizes spec §1 tabulates land in the tiers it names', () => {
    // 960x600 → view 736x564; 1024x640 → 800x604; 1280x800 → 1056x764;
    // 1600x1000 → 1376x964.
    expect(viewTierFor(736, 564)).toMatchObject({ narrow: true, short: true, tall: false });
    expect(viewTierFor(800, 604)).toMatchObject({ narrow: true, short: true });
    expect(viewTierFor(1056, 764)).toMatchObject({ narrow: false, wide: false, tall: true });
    expect(viewTierFor(1376, 964)).toMatchObject({ wide: true, tall: true, large: true });
  });
});

describe('the phone is as big as the room allows, and never letterboxes', () => {
  it('takes the SMALLER of what the width and the height allow', () => {
    // Width-bound: a wide, short box.
    expect(deviceWidthFor(400, 300, 36, 8)).toBeCloseTo((300 - 8) / DEVICE_ASPECT, 5);
    // Height-bound: a narrow, tall box.
    expect(deviceWidthFor(200, 2000, 36, 8)).toBe(164);
  });

  it('reproduces spec §1’s measured device widths at the four window sizes', () => {
    // The `.ai-fit` box at each tier, from the stage width and padding the
    // stylesheet declares. Within a pixel of the table, which is what a
    // measured layout and a formula can agree on.
    expect(deviceWidthFor(236, 470, 8, 4)).toBeCloseTo(222.5, 0); // 960x600, narrow
    expect(deviceWidthFor(348, 600, 36, 8)).toBeCloseTo(282.6, 0); // 1280x800
    expect(deviceWidthFor(452, 800, 36, 8)).toBeCloseTo(378.2, 0); // 1600x1000, wide
  });

  it('⛔ a box too small for any phone yields 0, never a negative width', () => {
    // A negative `--w` would paint every `calc(var(--w) * …)` inside out.
    expect(deviceWidthFor(10, 10, 36, 8)).toBe(0);
    expect(deviceWidthFor(0, 0, 36, 8)).toBe(0);
  });
});
