// docs/runbooks/agent-turn-monitoring.md ↔ ops/alerts/driftstack.yml ↔ the
// metrics registry.
//
// A runbook is read at the worst possible moment, by someone pasting its
// expressions into a query box. An expression that has drifted from the rule
// that actually fired sends them looking at a different number from the one
// that paged them — so the four documented expressions are compared with the
// four live ones, not merely checked for existing.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';
import { AGENT_TURN_TELEMETRY_RETENTION_DAYS } from '../../src/services/agent-turn-telemetry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const runbook = readFileSync(resolve(REPO_ROOT, 'docs/runbooks/agent-turn-monitoring.md'), 'utf8');
const alerts = readFileSync(resolve(REPO_ROOT, 'ops/alerts/driftstack.yml'), 'utf8');

const ALERTS = [
  'AgentTurnCompletionRateLow',
  'AgentTurnConflictRateHigh',
  'AgentTurnFirstProgressSlow',
  'AgentTurnTelemetryWriteFailing',
] as const;

const squash = (s: string): string => s.replace(/\s+/g, '');

function liveExpr(alert: string): string {
  const match = new RegExp(
    `- alert: ${alert}\\n[\\s\\S]*?expr: \\|\\n([\\s\\S]*?)\\n\\s*for:`,
  ).exec(alerts);
  if (match?.[1] === undefined) throw new Error(`alert ${alert} not found in the rules file`);
  return match[1];
}

function documentedExpr(alert: string): string {
  const heading = runbook.indexOf(`\`${alert}\``);
  if (heading === -1) throw new Error(`alert ${alert} not documented in the runbook`);
  const match = /```promql\n([\s\S]*?)```/.exec(runbook.slice(heading));
  if (match?.[1] === undefined) throw new Error(`no promql block under ${alert}`);
  return match[1];
}

describe('AI turn monitoring runbook', () => {
  it.each(ALERTS)('%s: the documented expression IS the live rule', (alert) => {
    expect(squash(documentedExpr(alert))).toBe(squash(liveExpr(alert)));
  });

  it('the rules file defines exactly these agent-turn alerts — a fifth needs a runbook section, a removed one needs its section gone', () => {
    const group = alerts.slice(alerts.indexOf('- name: driftstack-agent-turns'));
    const defined = [...group.matchAll(/- alert: (\w+)/g)].map((m) => m[1]);
    expect(defined).toEqual([...ALERTS]);
  });

  it('every series the runbook names exists (histograms by their exposed _bucket/_sum/_count names)', () => {
    const known = new Set<string>(Object.values(METRIC_NAMES));
    const named = new Set(
      [...runbook.matchAll(/driftstack_agent_turn_[a-z_]+/g)].map((m) =>
        m[0].replace(/_(?:bucket|sum|count)$/, ''),
      ),
    );
    expect(named.size).toBeGreaterThan(5);
    expect([...named].filter((n) => !known.has(n)).sort()).toEqual([]);
  });

  it('states the retention the code enforces, and the precondition that makes half of it inert', () => {
    expect(runbook).toContain(`**${AGENT_TURN_TELEMETRY_RETENTION_DAYS.toString()} days**`);
    expect(runbook).toContain('METRICS_SCRAPE_TOKEN');
    expect(runbook).toContain('agent_turn_telemetry.prune');
  });
});
