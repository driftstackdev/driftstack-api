// The watchdog and the runbook state ONE set of thresholds.
//
// docs/runbooks/agent-turn-monitoring.md gives each alert as PromQL, and
// ops/alerts/driftstack.yml carries the same expressions (pinned to each other
// by docs-runbooks-agent-turn-monitoring-parity). In production nothing runs
// that PromQL; the health watchdog evaluates the conditions from the database
// using AGENT_TURN_ALERT_RULES. If the constant and the documented expression
// disagree, the runbook tells an operator one threshold while production pages
// on another — so every number is READ OUT of the runbook text here and
// compared, never restated.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TURN_ALERT_RULES,
  AGENT_TURN_HEALTH_BLIND_AFTER_TICKS,
  AGENT_TURN_HEALTH_EMAIL_DEADLINE_MS,
  AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR,
  AGENT_TURN_HEALTH_RENOTIFY_MS,
  AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS,
  AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE,
  agentTurnHealthFingerprint,
  type AgentTurnHealthCondition,
} from '../../src/services/agent-turn-health-watchdog.js';
import {
  AGENT_TURN_HEALTH_ADMIN_URL,
  AGENT_TURN_HEALTH_EMAIL_DISABLE_ENV,
  AGENT_TURN_HEALTH_RUNBOOK_REF,
} from '../../src/services/agent-turn-health-email.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const runbook = readFileSync(resolve(REPO_ROOT, 'docs/runbooks/agent-turn-monitoring.md'), 'utf8');
const alerts = readFileSync(resolve(REPO_ROOT, 'ops/alerts/driftstack.yml'), 'utf8');

/** The PromQL block under the alert's heading — the same lookup the runbook's
 *  own parity test uses, so both read the block an operator would paste. */
function documentedExpr(alert: string): string {
  const heading = runbook.indexOf(`\`${alert}\``);
  if (heading === -1) throw new Error(`alert ${alert} not documented in the runbook`);
  const match = /```promql\n([\s\S]*?)```/.exec(runbook.slice(heading));
  if (match?.[1] === undefined) throw new Error(`no promql block under ${alert}`);
  return match[1];
}

function documented(alert: string): {
  windowMinutes: number;
  comparator: '<' | '>';
  threshold: number;
  floor: number;
  quantile: number | null;
} {
  const expr = documentedExpr(alert);
  const windows = new Set(
    [...expr.matchAll(/\[(\d+)([mh])\]/g)].map((m) => Number(m[1]) * (m[2] === 'h' ? 60 : 1)),
  );
  if (windows.size !== 1)
    throw new Error(`${alert}: expected one window, got ${[...windows].join(',')}`);
  // The comparison that closes the ratio or quantile, right before the floor's `and`.
  const cmp = /\)\s*([<>])\s*([\d.]+)\s*\nand\n/.exec(expr);
  if (cmp === null) throw new Error(`${alert}: threshold comparison not found`);
  const floor = /\)\s*>=\s*(\d+)\s*$/.exec(expr.trim());
  if (floor === null) throw new Error(`${alert}: volume floor not found`);
  const q = /histogram_quantile\(\s*([\d.]+)/.exec(expr);
  return {
    windowMinutes: [...windows][0]!,
    comparator: cmp[1] as '<' | '>',
    threshold: Number(cmp[2]),
    floor: Number(floor[1]),
    quantile: q === null ? null : Number(q[1]),
  };
}

function forMinutes(alert: string): number {
  const m = new RegExp(`- alert: ${alert}\\n[\\s\\S]*?\\n\\s*for: (\\d+)([mh])`).exec(alerts);
  if (m === null) throw new Error(`alert ${alert}: no for: clause in the rules file`);
  return Number(m[1]) * (m[2] === 'h' ? 60 : 1);
}

const CONDITIONS = Object.keys(AGENT_TURN_ALERT_RULES) as AgentTurnHealthCondition[];

describe('AGENT_TURN_ALERT_RULES ↔ the runbook PromQL', () => {
  it('the parser reads real numbers (vacuity guard: a regex that silently matched nothing would make every comparison below trivially wrong or trivially right)', () => {
    expect(CONDITIONS.length).toBe(3);
    for (const c of CONDITIONS) {
      const d = documented(AGENT_TURN_ALERT_RULES[c].alert);
      expect(d.windowMinutes).toBeGreaterThan(0);
      expect(d.threshold).toBeGreaterThan(0);
      expect(d.floor).toBeGreaterThan(0);
    }
  });

  it.each(CONDITIONS)(
    'CRITICAL %s: window, direction, threshold and volume floor match the documented expression',
    (c) => {
      const rule = AGENT_TURN_ALERT_RULES[c];
      const d = documented(rule.alert);
      expect(rule.windowMinutes, 'window').toBe(d.windowMinutes);
      expect(rule.breachWhen, 'direction').toBe(d.comparator === '<' ? 'below' : 'above');
      // The runbook states time in seconds; the watchdog compares milliseconds.
      expect(rule.threshold, 'threshold').toBe(
        rule.unit === 'ms' ? d.threshold * 1000 : d.threshold,
      );
      expect(rule.minSamples, 'volume floor').toBe(d.floor);
    },
  );

  it.each(CONDITIONS)('%s: the `for:` hold matches the rule that would page', (c) => {
    const rule = AGENT_TURN_ALERT_RULES[c];
    expect(rule.forMinutes).toBe(forMinutes(rule.alert));
  });

  it('first progress is judged at the quantile the PromQL uses (the watchdog reads p95)', () => {
    expect(documented(AGENT_TURN_ALERT_RULES.first_progress_slow.alert).quantile).toBe(0.95);
  });

  it('the telemetry-write alert has no watchdog rule — and the runbook says so, plainly', () => {
    expect(Object.values(AGENT_TURN_ALERT_RULES).map((r) => r.alert)).not.toContain(
      'AgentTurnTelemetryWriteFailing',
    );
    expect(runbook).toMatch(/\*\*Alert 4 \(telemetry writes failing\) is NOT evaluated\.\*\*/);
  });
});

describe('the runbook describes the watchdog that actually runs', () => {
  const section = runbook.slice(runbook.indexOf('## In production today: the health watchdog'));

  it('has the section, after the PromQL it refers to', () => {
    expect(runbook.indexOf('## In production today: the health watchdog')).toBeGreaterThan(
      runbook.indexOf('## The four alerts'),
    );
  });

  it('names the job, the constant, the switch, and the cadence / reminder / blindness numbers the code uses', () => {
    expect(section).toContain(`\`${AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE}\``);
    expect(section).toContain('`AGENT_TURN_ALERT_RULES`');
    expect(section).toContain('`DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_WATCHDOG=true`');
    expect(section).toContain(
      `every **${String(AGENT_TURN_HEALTH_WATCHDOG_INTERVAL_MS / 60_000)} minutes**`,
    );
    expect(section).toContain(
      `every **${String(AGENT_TURN_HEALTH_RENOTIFY_MS / 3_600_000)} hours**`,
    );
    expect(section).toContain(`for ${String(AGENT_TURN_HEALTH_BLIND_AFTER_TICKS)} ticks in a row`);
  });

  it('does not restate the floors or `for:` holds in prose, where no parity check could reach them', () => {
    for (const rule of Object.values(AGENT_TURN_ALERT_RULES)) {
      expect(section).not.toMatch(new RegExp(`\\b${String(rule.forMinutes)}[ -]?min`));
      expect(section).not.toMatch(new RegExp(`fewer than ${String(rule.minSamples)}\\b`));
    }
  });

  it('CRITICAL says email to the owner is automatic, with the bound, the switch and the page the code uses — and that the Sentry rule is optional', () => {
    // The owner asked for alerts that need no configuring. The runbook used to
    // make a Sentry per-event rule REQUIRED; it must now say email is automatic
    // and state the numbers the code really enforces.
    expect(section).toMatch(/\*\*Getting notified — automatic, by email\.\*\*/);
    expect(section).not.toMatch(/a Sentry alert rule is REQUIRED/);
    expect(section).toContain(
      `**At most ${String(AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR)} emails in any rolling hour**`,
    );
    expect(section).toContain('`AGENT_TURN_HEALTH_EMAIL_MAX_PER_HOUR`');
    expect(section).toContain(
      `under a ${String(AGENT_TURN_HEALTH_EMAIL_DEADLINE_MS / 1000)}-second deadline`,
    );
    expect(section).toContain(`\`${AGENT_TURN_HEALTH_EMAIL_DISABLE_ENV}=true\``);
    expect(section).toContain(`\`${AGENT_TURN_HEALTH_ADMIN_URL}\``);
    for (const reason of ['postmark_not_configured', 'no_owner_address', 'switched_off']) {
      expect(section).toContain(`\`${reason}\``);
    }
    // The email points at a heading that exists, under the section it names.
    const heading = /section "([^"]+)" \(under "([^"]+)"\)/.exec(AGENT_TURN_HEALTH_RUNBOOK_REF);
    expect(heading).not.toBeNull();
    expect(section).toContain(`**${heading![1]!}`);
    expect(runbook).toContain(`## ${heading![2]!}`);
  });

  it('still tells anyone who wants Sentry to notify which per-event rule does it, and that silencing takes both issues', () => {
    // Breaches of one condition share an issue that a recovery never
    // resolves, so "new issue" / "regression" rules page on the first breach
    // only. The runbook must name a per-event rule filtered on the tags the
    // payload really carries.
    expect(section).toMatch(/\*\*Optional: a per-event Sentry alert rule\.\*\*/);
    expect(section).toMatch(/fires\s+per event/);
    expect(section).toMatch(/number of events in an issue is more than 0 in 1 minute/);
    expect(section).toContain('tag `component` equals `agent-turn-health`');
    expect(section).toMatch(/tag\s+`transition` is `breach` or `still_breaching`/);
    expect(section).toMatch(/\*\*both\*\* its\s+breach issue and its `… \/ recovered` issue/);
    expect(section).toMatch(/\*\*Delivery is at most once\.\*\*/);
  });

  it('shows the fingerprints an operator will search Sentry for, as the code builds them', () => {
    expect(section).toContain(
      `\`${agentTurnHealthFingerprint('completion_rate_low', 'breach')
        .map((p) => (p === 'completion_rate_low' ? '<condition>' : p))
        .join(' / ')}\``,
    );
    expect(section).toContain(
      `\`${agentTurnHealthFingerprint('completion_rate_low', 'recovered')
        .map((p) => (p === 'completion_rate_low' ? '<condition>' : p))
        .join(' / ')}\``,
    );
  });
});
