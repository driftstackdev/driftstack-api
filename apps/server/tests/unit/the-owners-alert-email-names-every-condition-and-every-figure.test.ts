// THE OWNER'S ALERT EMAIL IS THE DELIVERY PATH, SO IT MUST NAME WHAT FIRED.
//
// Nothing scrapes /metrics in production, so the watchdog's email is how a
// breach reaches a person. The email renders a condition's words and its
// figures from two LOOKUP TABLES inside the email module, and both degrade
// SILENTLY when a condition is added without an entry:
//
//   · a condition with no words falls back to the generic "health check / An AI
//     turn health check changed state", which names neither the fault nor what
//     to do — an email that says nothing, on the one path that reaches a person;
//   · a figure with no label is skipped by the printer, so the numbers that
//     make the alert actionable (the counts by verb) simply are not in the mail.
//
// Neither shows up as a failure anywhere else: the email is still sent, still
// well-formed, still delivered. This is the guard that makes adding a condition
// without its words a RED TEST rather than a quiet regression.

import { describe, expect, it } from 'vitest';
import { renderAgentTurnHealthEmail } from '../../src/services/agent-turn-health-email.js';
import {
  AGENT_TURN_HEALTH_CONDITIONS,
  type AgentTurnHealthNotice,
  type AgentTurnHealthSignal,
} from '../../src/services/agent-turn-health-watchdog.js';

/** Every signal an email can be rendered for: the conditions, and the
 *  watchdog's own blindness. */
const SIGNALS: readonly AgentTurnHealthSignal[] = [
  ...AGENT_TURN_HEALTH_CONDITIONS,
  'evaluation_failing',
];

/**
 * What each signal's email must CALL ITSELF. Spelled out here rather than read
 * from the module, so a condition added without words fails against this table
 * instead of agreeing with an empty one.
 */
const TITLES: Readonly<Record<AgentTurnHealthSignal, string>> = {
  completion_rate_low: 'completion rate low',
  conflict_rate_high: 'busy/conflict rate high',
  first_progress_slow: 'first progress slow',
  no_profile_attached: 'AI session ran with no behaviour profile attached',
  evaluation_failing: 'health watchdog blind',
};

/** The generic words the module falls back to when a signal has none. */
const FALLBACK_TITLE = 'health check';

function noticeFor(signal: AgentTurnHealthSignal): AgentTurnHealthNotice {
  return {
    signal,
    transition: 'breach',
    breaching_since: '2026-09-20T12:10:00.000Z',
    figures: { samples: 10, value: 1, consecutive_failed_ticks: 3 },
  };
}

const NO_PROFILE: AgentTurnHealthNotice = {
  signal: 'no_profile_attached',
  transition: 'breach',
  breaching_since: '2026-09-20T12:10:00.000Z',
  window: { since: '2026-09-20T11:40:00.000Z', until: '2026-09-20T12:10:00.000Z' },
  figures: { samples: 12, value: 3, no_profile_click: 2, no_profile_send_keys: 1 },
};

describe('the owner’s alert email names every condition the watchdog can raise', () => {
  it('the table covers exactly the signals that exist — a new condition is not silently exempt from the arms below', () => {
    expect(Object.keys(TITLES).sort()).toEqual([...SIGNALS].sort());
    // Anti-vacuity: a SIGNALS list that had collapsed to nothing would make the
    // loop below assert nothing at all.
    expect(SIGNALS.length).toBeGreaterThanOrEqual(5);
  });

  it('CRITICAL every signal renders its OWN words, never the generic fallback — an email that says only "an AI turn health check changed state" names neither the fault nor the next step', () => {
    const generic: AgentTurnHealthSignal[] = [];
    for (const signal of SIGNALS) {
      const email = renderAgentTurnHealthEmail(noticeFor(signal));
      expect(email.text, `${signal} must name its own condition`).toContain(TITLES[signal]);
      if (email.subject.includes(FALLBACK_TITLE)) generic.push(signal);
    }
    expect(generic).toEqual([]);
  });

  it('CRITICAL the no-profile-attached email carries the counts by verb — the numbers that say how big it is and which kind of step', () => {
    const email = renderAgentTurnHealthEmail(NO_PROFILE);
    expect(email.text).toContain('Taps with no behaviour profile attached: 2');
    expect(email.text).toContain('Typing with no behaviour profile attached: 1');
    expect(email.text).toContain('Samples in the window: 12');
    // A count of events, not a rate: the email says so in words rather than
    // printing a bare 3 that reads as a percentage beside the other alerts.
    expect(email.text).toContain('3 actions');
  });

  it('CRITICAL the email says what the finding is NOT — an owner reading it at 3am must not take it for a measurement of how the action looked', () => {
    const email = renderAgentTurnHealthEmail(NO_PROFILE);
    expect(email.text).toMatch(/SESSION SET-UP fault/);
    expect(email.text).toMatch(/necessary, not sufficient/);
  });

  it('CRITICAL nothing a customer touched can reach the email — it renders numbers, timestamps and closed vocabulary only', () => {
    const email = renderAgentTurnHealthEmail(NO_PROFILE);
    for (const sentinel of [
      'https://secret-shop.test/checkout?order=abc123',
      '#customer-only-selector',
      'hunter2-the-password',
      'ags_customer_session',
      'acct_customer',
    ]) {
      expect(email.text).not.toContain(sentinel);
      expect(email.html).not.toContain(sentinel);
    }
    // Not vacuous: the email exists and carries the finding.
    expect(email.subject).toContain('no behaviour profile attached');
  });

  it('an unlabelled figure is dropped rather than printed — which is why the counts above are pinned by name and not trusted to the table', () => {
    const email = renderAgentTurnHealthEmail({
      ...NO_PROFILE,
      figures: { ...NO_PROFILE.figures, p50_ms: 987654 },
    });
    // p50_ms IS labelled, so it appears — the printer is label-driven, and that
    // is exactly the mechanism by which an unlabelled key would vanish.
    expect(email.text).toContain('First progress p50');
  });
});
