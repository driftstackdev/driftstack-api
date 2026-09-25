// A step that SUCCEEDED with something to report shows a warning, not a tick.
//
// A navigation the site answered with 400 or above is a success — the page may
// be a verification step the customer can complete, or a whole app served
// under an error status — and the result carries `warning` to say so. A plain
// green ✓ on that row would tell the customer everything went as planned when
// the site said otherwise; a red ✗ would claim a failure nobody knows about.
// So the row is drawn in the warning state: the ⚠ drawing and the warning
// colour, with the summary's own words saying what the site answered.
//
// Every arm is a PAIR — the same shape of step with and without the warning —
// because a render that drew every row as a warning would pass the half that
// looks for one.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { AgentIntentResult, AgentMessageResponse, AgentSession } from '@driftstack/sdk';
import { PlanStepList, describeResult } from '../../src/views/agent-chat/PlanTimeline';
import { AgentResponseBody } from '../../src/views/agent-chat/Turn';
import { IconCheck } from '../../src/views/agent-chat/icons';
import { IconWarn, stepMark } from '../../src/views/agent-chat/step-mark';

const WARNED: AgentIntentResult = {
  kind: 'success',
  intent: { kind: 'navigate', url: 'https://shop.example.com/p/ridgeline' },
  summary:
    'navigated to https://shop.example.com/p/ridgeline — the site answered 403 (it may want a sign-in or a verification step first)',
  warning: { kind: 'http_error_status', status: 403 },
};

const CLEAN: AgentIntentResult = {
  kind: 'success',
  intent: { kind: 'navigate', url: 'https://shop.example.com/' },
  summary: 'navigated to https://shop.example.com/',
};

const SESSION: AgentSession = {
  id: 'agt_warned',
  account_id: 'acc_1',
  driftstack_session_id: null,
  status: 'active',
  closed_reason: null,
  stop_on_exit_ip_change: false,
  token_budget_total: 100_000,
  token_budget_remaining: 90_000,
  transcript_length: 2,
  closed_at: null,
  created_by_user_id: null,
  mode: 'ai',
  model: 'claude-sonnet-5',
  pair_mode_state: null,
  created_at: '2026-06-14T00:00:00Z',
  updated_at: '2026-06-14T00:00:01Z',
};

function markup(el: JSX.Element): string {
  return render(el).container.innerHTML;
}

describe('a warned step shows a warning, not a tick', () => {
  it('the mark: ⚠ in the warning tone for a warned step, ✓ for a clean one', () => {
    expect(stepMark(WARNED)).toEqual({ glyph: '⚠', tone: 'warn' });
    expect(stepMark(CLEAN)).toEqual({ glyph: '✓', tone: 'done' });
  });

  it('a warning kind this build has never heard of is still a warning, never a tick', () => {
    const newer = {
      ...CLEAN,
      warning: { kind: 'a_warning_added_after_this_build' },
    } as AgentIntentResult;
    expect(stepMark(newer)).toEqual({ glyph: '⚠', tone: 'warn' });
  });

  it('the step line: ⚠ in the warning colour, ✓ in the ready colour, the summary unchanged', () => {
    expect(describeResult(WARNED, false, false)).toEqual({
      glyph: '⚠',
      cls: 'text-status-busy',
      text: (WARNED as { summary: string }).summary,
    });
    expect(describeResult(CLEAN, false, false)).toEqual({
      glyph: '✓',
      cls: 'text-status-ready',
      text: 'navigated to https://shop.example.com/',
    });
  });

  it('the timeline row: the warned row is drawn in the warning state with the ⚠ drawing; the clean row keeps its tick', () => {
    const { container } = render(
      <PlanStepList
        results={[WARNED, CLEAN]}
        denied={false}
        approved={false}
        sessionId="agt_warned"
        baseUrl="https://api.example.test"
        apiKey={null}
      />,
    );
    const rows = [...container.querySelectorAll('li.ai-step')];
    expect(rows).toHaveLength(2);
    const [warned, clean] = rows;
    expect(warned?.classList.contains('is-warn')).toBe(true);
    expect(warned?.classList.contains('is-done')).toBe(false);
    expect(clean?.classList.contains('is-done')).toBe(true);
    expect(clean?.classList.contains('is-warn')).toBe(false);
    expect(warned?.querySelector('.ai-node')?.innerHTML).toBe(markup(<IconWarn />));
    expect(clean?.querySelector('.ai-node')?.innerHTML).toBe(markup(<IconCheck />));
    // Colour is never the only signal: the row's own words say what the site answered.
    expect(warned?.textContent).toContain('the site answered 403');
  });

  it('the turn’s step bars: the warned step’s bar is a warning, the clean one’s is a tick', () => {
    const response: AgentMessageResponse = {
      kind: 'plan-executed',
      session: SESSION,
      intents: [WARNED.intent, CLEAN.intent],
      results: [WARNED, CLEAN],
      ok: true,
    };
    const { container } = render(
      <AgentResponseBody
        response={response}
        denied={false}
        approved={false}
        sessionId="agt_warned"
        baseUrl="https://api.example.test"
        apiKey={null}
      />,
    );
    const bars = [...container.querySelectorAll('.ai-segs > i')].map((i) => i.className);
    expect(bars).toEqual(['is-warn', 'is-ok']);
  });

  it('the warning state has its own drawing in the stylesheet, in the warning colour — a class with no rule would render as nothing', () => {
    const css = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8');
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(rule('.ai-step.is-warn .ai-node')).toContain('--status-busy-rgb');
    expect(rule('.ai-segs > i.is-warn')).toContain('--status-busy-rgb');
  });
});
