// ONE LINE PER TURN, AND THE CONFIGURATION ALERT THAT READS IT.
//
// Production has no metrics scraper, so the counters in the registry are read
// by nothing there. The durable record of which path each of a turn's actions
// took is a structured log line in the journal — `event:
// agent_turn_action_paths`, counts only — and the health watchdog's fourth
// condition reads the same numbers from the same place, one tick later.
//
// ⛔ THE FOURTH CONDITION IS A CONFIGURATION CHECK, NOT A DETECTABILITY
// VERDICT. The device reports whether a BEHAVIOUR PROFILE WAS ATTACHED to the
// session that acted. A session acting with none is misconfigured; a profile
// being attached is necessary and not sufficient for the human-like path to
// have run, and nothing here measures what the device then did.
//
// What each block holds:
//
//   1. THE LINE. Written once per turn, from the executor's own counts, with a
//      FIXED list of numeric keys and nothing else. Warn when an action ran with
//      no profile attached, info otherwise, and nothing at all for a turn with
//      no action to report.
//   2. CONTENT-FREE. A turn built entirely out of sentinels leaves a line in
//      which none of them appears.
//   3. THE CONDITION. It fires on an unprofiled action and recovers when that
//      action ages out — and a window with no AI action in it is "not enough
//      data", never a clean bill of health.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import type { AgentSessionRecord } from '../../src/services/agent-sessions.js';
import type { IntentResult } from '../../src/services/agent-executor.js';
import type { RunTurnResult } from '../../src/services/agent-runtime.js';
import {
  AGENT_TURN_ACTION_PATHS_EVENT,
  AGENT_TURN_ACTION_PATH_LOG_KEYS,
  AgentTurnTelemetry,
  InProcessProfileAttachmentWindow,
  addAgentActionPathCounts,
  emptyAgentActionPathCounts,
  type AgentActionPathCounts,
  type AgentTurnTelemetryRow,
  type AgentTurnTelemetryWriter,
} from '../../src/services/agent-turn-telemetry.js';
import {
  AGENT_TURN_ALERT_RULES,
  advanceAgentTurnHealth,
  evaluateAgentTurnHealth,
  readNoProfileAttachedCondition,
  INITIAL_AGENT_TURN_HEALTH_STATE,
  agentTurnHealthPayload,
  type AgentTurnHealthState,
} from '../../src/services/agent-turn-health-watchdog.js';
import { AgentTurnSummaryService } from '../../src/services/agent-turn-summary.js';
import { InMemoryAgentTurnTelemetryRepo } from '../../src/db/agent-turn-telemetry-repo.js';

const SESSION = { id: 'ags_1', status: 'active' } as unknown as AgentSessionRecord;
const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#go' };

class NullWriter implements AgentTurnTelemetryWriter {
  rows: AgentTurnTelemetryRow[] = [];
  insert(row: AgentTurnTelemetryRow): Promise<void> {
    this.rows.push(row);
    return Promise.resolve();
  }
}

type Line = [Record<string, unknown>, string];

interface Harness {
  telemetry: AgentTurnTelemetry;
  warns: Line[];
  infos: Line[];
  window: InProcessProfileAttachmentWindow;
  actionPathLines: () => Line[];
}

function harness(nowMs = (): number => 1000): Harness {
  const warns: Line[] = [];
  const infos: Line[] = [];
  const window = new InProcessProfileAttachmentWindow(nowMs);
  const telemetry = new AgentTurnTelemetry({
    writer: new NullWriter(),
    profileAttachmentWindow: window,
    logger: {
      warn: (obj, msg) => warns.push([obj, msg]),
      info: (obj, msg) => infos.push([obj, msg]),
    },
    wallClock: () => new Date('2026-09-20T00:00:00Z'),
  });
  return {
    telemetry,
    warns,
    infos,
    window,
    actionPathLines: () =>
      [...warns, ...infos].filter(([obj]) => obj.event === AGENT_TURN_ACTION_PATHS_EVENT),
  };
}

function counts(patch: (c: AgentActionPathCounts) => void): AgentActionPathCounts {
  const c = emptyAgentActionPathCounts();
  patch(c);
  return c;
}

/** Run one turn whose executor reported `actionPaths`, and settle the deferred
 *  work the route never waits for. */
async function turnWith(
  h: Harness,
  actionPaths: AgentActionPathCounts | undefined,
  results: IntentResult[] = [{ kind: 'success', intent: TAP, summary: 'tapped' }],
): Promise<void> {
  const collector = h.telemetry.begin({ agentSessionId: 'ags_1', transport: 'stream' });
  const result: RunTurnResult = {
    kind: 'plan-executed',
    decomposer: { kind: 'plan', intents: [TAP], tokensConsumed: 1 },
    executor: {
      results,
      ok: results.every((r) => r.kind === 'success'),
      ...(actionPaths === undefined ? {} : { actionPaths }),
    },
    session: SESSION,
  };
  collector.observeResult(result);
  collector.finish({ status: 200, body: { kind: 'plan-executed' } });
  await h.telemetry.flush();
}

// ── 1. the line ────────────────────────────────────────────────────────────

describe('one line per turn says which paths the turn’s actions took', () => {
  it('CRITICAL writes the turn’s counts under the event an operator greps for', async () => {
    const h = harness();
    await turnWith(
      h,
      counts((c) => {
        c.actions = 2;
        c.profileAttached.true = 2;
        c.outcomes.ok = 2;
        c.looks = 1;
        c.resolvers.native = 1;
        c.verdicts.clear = 1;
        c.nextActions.tapped = 1;
      }),
    );
    const lines = h.actionPathLines();
    expect(lines).toHaveLength(1);
    const [obj] = lines[0]!;
    expect(obj.event).toBe('agent_turn_action_paths');
    expect(obj.actions_total).toBe(2);
    expect(obj.profile_attached_true).toBe(2);
    expect(obj.resolved_by_native).toBe(1);
    expect(obj.then_tapped).toBe(1);
    // A turn in which every action had a profile attached is ordinary news.
    expect(h.warns.filter(([o]) => o.event === AGENT_TURN_ACTION_PATHS_EVENT)).toHaveLength(0);
  });

  it('CRITICAL an action by a session with NO behaviour profile attached is a WARNING, even though the step succeeded — the step succeeding is precisely why nothing else reports the misconfiguration', async () => {
    const h = harness();
    await turnWith(
      h,
      counts((c) => {
        c.actions = 1;
        c.profileAttached.false = 1;
        c.unprofiledByVerb.click = 1;
        c.outcomes.ok = 1;
      }),
    );
    const warned = h.warns.filter(([o]) => o.event === AGENT_TURN_ACTION_PATHS_EVENT);
    expect(warned).toHaveLength(1);
    expect(warned[0]![0].profile_attached_false).toBe(1);
    expect(warned[0]![0].no_profile_click).toBe(1);
    expect(warned[0]![1]).toMatch(/NO behaviour profile attached to the session/);
    // ⛔ AND IT SAYS WHAT IT IS NOT. An operator reading this line at 3am must
    // not take it for a measurement of how the action looked.
    expect(warned[0]![1]).toMatch(/configuration fault, not a detectability verdict/);
    expect(h.infos.filter(([o]) => o.event === AGENT_TURN_ACTION_PATHS_EVENT)).toHaveLength(0);
  });

  it('writes nothing for a turn that dispatched no action and looked at nothing — a line of zeroes would read as "every action was fine"', async () => {
    const h = harness();
    await turnWith(h, undefined);
    expect(h.actionPathLines()).toEqual([]);
    await turnWith(h, emptyAgentActionPathCounts());
    expect(h.actionPathLines()).toEqual([]);
  });

  it('CRITICAL the line’s keys are exactly the fixed list, plus the event and the component — no id, no selector, no text', async () => {
    const h = harness();
    await turnWith(
      h,
      counts((c) => {
        c.actions = 1;
        c.profileAttached.unreported = 1;
        c.outcomes.failed = 1;
      }),
    );
    const [obj] = h.actionPathLines()[0]!;
    expect(Object.keys(obj).sort()).toEqual(
      ['component', 'event', ...AGENT_TURN_ACTION_PATH_LOG_KEYS].sort(),
    );
    for (const key of AGENT_TURN_ACTION_PATH_LOG_KEYS) {
      expect(typeof obj[key], `${key} must be a number`).toBe('number');
    }
  });

  it('CRITICAL a turn whose every string is a sentinel leaves a line carrying none of them', async () => {
    const sentinels = [
      'https://secret-shop.test/checkout?order=abc123',
      '#customer-only-selector',
      'hunter2-the-password',
      'ags_customer_session',
    ];
    const h = harness();
    await turnWith(
      h,
      counts((c) => {
        c.actions = 1;
        c.profileAttached.false = 1;
        c.unprofiledByVerb.send_keys = 1;
        c.outcomes.ok = 1;
      }),
      [
        {
          kind: 'success',
          intent: {
            kind: 'interact',
            action: 'type',
            selector: sentinels[1],
            value: sentinels[2],
          } as AgentIntent,
          summary: sentinels[0]!,
        },
      ],
    );
    const line = JSON.stringify(h.actionPathLines()[0]);
    for (const sentinel of sentinels) expect(line).not.toContain(sentinel);
    // Not vacuous: the line exists and carries the finding.
    expect(line).toContain('"profile_attached_false":1');
  });

  it('the counts of every plan segment of a turn are summed, not replaced — a turn that failed a step and re-planned performed the actions of both', () => {
    const first = counts((c) => {
      c.actions = 1;
      c.profileAttached.false = 1;
      c.unprofiledByVerb.click = 1;
      c.outcomes.failed = 1;
    });
    const second = counts((c) => {
      c.actions = 2;
      c.profileAttached.true = 2;
      c.outcomes.ok = 2;
    });
    const merged = addAgentActionPathCounts(
      addAgentActionPathCounts(emptyAgentActionPathCounts(), first),
      second,
    );
    expect(merged.actions).toBe(3);
    expect(merged.profileAttached.false).toBe(1);
    expect(merged.unprofiledByVerb.click).toBe(1);
    // The segment that went wrong is the one an audit is about, and taking the
    // last run's counts alone would have dropped it.
    expect(merged.outcomes).toEqual({ ok: 2, failed: 1, unknown: 0 });
  });
});

// ── 2. the condition ───────────────────────────────────────────────────────

const EMPTY_WINDOW = { since: null, until: null };

describe('the health watchdog raises a fourth condition on an action with no behaviour profile attached', () => {
  it('breaches on the first one, with the counts by verb and nothing else', () => {
    const reading = readNoProfileAttachedCondition(
      { samples: 12, unprofiled: 2, byVerb: { click: 1, send_keys: 1 } },
      EMPTY_WINDOW,
    );
    expect(reading.status).toBe('breach');
    expect(reading.figures).toEqual({
      samples: 12,
      value: 2,
      no_profile_click: 1,
      no_profile_send_keys: 1,
    });
  });

  it('CRITICAL a window with AI actions and all of them profile-attached is ok, and a window with NO AI action is "not enough data" — never a clean bill of health', () => {
    expect(
      readNoProfileAttachedCondition(
        { samples: 40, unprofiled: 0, byVerb: { click: 0, send_keys: 0 } },
        EMPTY_WINDOW,
      ).status,
    ).toBe('ok');
    expect(
      readNoProfileAttachedCondition(
        { samples: 0, unprofiled: 0, byVerb: { click: 0, send_keys: 0 } },
        EMPTY_WINDOW,
      ).status,
    ).toBe('insufficient_data');
  });

  it('there is no acceptable share: the threshold is zero and strict, and the rule has no hold', () => {
    const rule = AGENT_TURN_ALERT_RULES.no_profile_attached;
    expect(rule.threshold).toBe(0);
    expect(rule.breachWhen).toBe('above');
    expect(rule.unit).toBe('count');
    expect(rule.forMinutes).toBe(0);
    expect(rule.minSamples).toBe(1);
  });

  it('CRITICAL the alert that reaches Sentry and the owner names the counts by verb and carries nothing else', () => {
    const { notices } = advanceAgentTurnHealth(
      INITIAL_AGENT_TURN_HEALTH_STATE,
      [
        readNoProfileAttachedCondition(
          { samples: 5, unprofiled: 3, byVerb: { click: 2, send_keys: 1 } },
          { since: '2026-09-20T00:00:00.000Z', until: '2026-09-20T00:30:00.000Z' },
        ),
      ],
      new Date('2026-09-20T00:30:00Z'),
    );
    const notice = notices.find((n) => n.signal === 'no_profile_attached');
    expect(notice?.transition).toBe('breach');
    const payload = agentTurnHealthPayload(notice!);
    expect(payload.message).toBe('AI turns: AgentActionNoProfileAttached breach');
    expect(payload.extra).toMatchObject({
      condition: 'no_profile_attached',
      value: 3,
      no_profile_click: 2,
      no_profile_send_keys: 1,
      unit: 'count',
    });
    // Every value that leaves is a number, a timestamp or a member of a closed
    // vocabulary. Nothing here can name a page, a selector or a customer.
    for (const [key, value] of Object.entries(payload.extra)) {
      if (typeof value === 'number' || value === null) continue;
      expect(
        [
          'no_profile_attached',
          'breach',
          'above',
          'count',
          '2026-09-20T00:00:00.000Z',
          '2026-09-20T00:30:00.000Z',
        ],
        `${key} carried an unexpected string`,
      ).toContain(value);
    }
  });

  it('CRITICAL fires once and then recovers when the last such action ages out of the window, on the same clocks as every other condition', () => {
    let state: AgentTurnHealthState = INITIAL_AGENT_TURN_HEALTH_STATE;
    const tick = (unprofiled: number, at: string) => {
      const advanced = advanceAgentTurnHealth(
        state,
        [
          readNoProfileAttachedCondition(
            {
              samples: 10,
              unprofiled,
              byVerb: { click: unprofiled, send_keys: 0 },
            },
            EMPTY_WINDOW,
          ),
        ],
        new Date(at),
      );
      state = advanced.next;
      return advanced.notices
        .filter((n) => n.signal === 'no_profile_attached')
        .map((n) => n.transition);
    };
    expect(tick(1, '2026-09-20T00:00:00Z')).toEqual(['breach']);
    // Still breaching is a reminder, not a second breach — and not every tick.
    expect(tick(1, '2026-09-20T00:05:00Z')).toEqual([]);
    expect(tick(0, '2026-09-20T00:40:00Z')).toEqual(['recovered']);
    expect(tick(0, '2026-09-20T00:45:00Z')).toEqual([]);
  });

  it('CRITICAL a segmented scroll NEVER raises the configuration alert — the device picks the scroll path with the same predicate, so counting it would page twice for one misconfiguration', async () => {
    const clock = Date.UTC(2026, 8, 20, 12, 0, 0);
    const h = harness(() => clock);
    await turnWith(
      h,
      counts((c) => {
        // Every click and typed step HAD a profile attached; the scroll took
        // the segmented path anyway (which cannot happen on today's device, and
        // is exactly why it must not be a second finding if it ever does).
        c.actions = 2;
        c.profileAttached.true = 2;
        c.scrolls = 3;
        c.scrollPaths.segmented = 3;
        c.outcomes.ok = 5;
      }),
    );
    const minutes = AGENT_TURN_ALERT_RULES.no_profile_attached.windowMinutes;
    const reading = h.window.since(minutes, clock);
    expect(reading).toEqual({ samples: 2, unprofiled: 0, byVerb: { click: 0, send_keys: 0 } });
    expect(readNoProfileAttachedCondition(reading, EMPTY_WINDOW).status).toBe('ok');
    // And the line still REPORTS the path, so the device team can read it.
    expect(h.actionPathLines()[0]![0].scroll_path_segmented).toBe(3);
    // Reported, not alerted: it is written at info, not warn.
    expect(h.warns.filter(([o]) => o.event === AGENT_TURN_ACTION_PATHS_EVENT)).toHaveLength(0);
  });

  it('CRITICAL with no source wired the condition is `unavailable`, which holds its clocks — and does NOT make the watchdog report itself blind', async () => {
    // A real summary service over no rows: the three table conditions read
    // "not enough data", so any blindness below is the fourth condition's.
    const readings = await evaluateAgentTurnHealth({
      summary: new AgentTurnSummaryService({ repo: new InMemoryAgentTurnTelemetryRepo() }),
    });
    expect(
      readings.filter((r) => r.condition !== 'no_profile_attached').map((r) => r.status),
    ).toEqual(['insufficient_data', 'insufficient_data', 'insufficient_data']);
    const fourth = readings.find((r) => r.condition === 'no_profile_attached');
    expect(fourth?.status).toBe('unavailable');
    // `evaluation_failing` says the watchdog cannot read the AI turn RECORDS.
    // The fourth condition reads somewhere else, so three ticks of a missing
    // source must not page that the watchdog can see nothing.
    let state: AgentTurnHealthState = INITIAL_AGENT_TURN_HEALTH_STATE;
    for (let i = 0; i < 5; i += 1) {
      const advanced = advanceAgentTurnHealth(
        state,
        readings,
        new Date(Date.UTC(2026, 8, 20, 0, i * 5)),
      );
      state = advanced.next;
      expect(advanced.notices.map((n) => n.signal)).not.toContain('evaluation_failing');
    }
    expect(state.failedTicks).toBe(0);
  });

  it('CRITICAL end to end: a turn whose action ran with no behaviour profile attached reaches the condition through the same window the log line is written from', async () => {
    let clock = Date.UTC(2026, 8, 20, 12, 0, 0);
    const h = harness(() => clock);
    await turnWith(
      h,
      counts((c) => {
        c.actions = 4;
        c.profileAttached.true = 3;
        c.profileAttached.false = 1;
        c.unprofiledByVerb.click = 1;
        c.outcomes.ok = 4;
      }),
    );
    const minutes = AGENT_TURN_ALERT_RULES.no_profile_attached.windowMinutes;
    const now = h.window.since(minutes, clock);
    expect(now).toEqual({ samples: 4, unprofiled: 1, byVerb: { click: 1, send_keys: 0 } });
    expect(readNoProfileAttachedCondition(now, EMPTY_WINDOW).status).toBe('breach');

    // And it ages out: the window is a window, not a latch.
    clock += (minutes + 1) * 60_000;
    const later = h.window.since(minutes, clock);
    expect(later.samples).toBe(0);
    expect(readNoProfileAttachedCondition(later, EMPTY_WINDOW).status).toBe('insufficient_data');
  });
});
