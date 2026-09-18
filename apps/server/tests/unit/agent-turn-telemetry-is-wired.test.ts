// AI turn telemetry is wired in production, not just in fixtures.
//
// Every behavioural test of the telemetry builds its own graph, so none of them
// can see whether bootstrap does. The failure that leaves behind is the quiet
// one: the route runs with `turnTelemetry` undefined, every `turnObserver?.`
// is a no-op, the admin page shows an empty deployment, and nothing is red.
// These are the five joints, read from source.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const bootstrap = readFileSync(resolve(SRC, 'lib', 'bootstrap.ts'), 'utf8');
const app = readFileSync(resolve(SRC, 'lib', 'app.ts'), 'utf8');

describe('AI turn telemetry wiring', () => {
  it('CRITICAL bootstrap builds it with the DATABASE writer, and OUTSIDE the metrics gate. Production runs with no metrics registry today; telemetry constructed only when one exists would write no rows exactly where they are needed.', () => {
    expect(bootstrap).toMatch(
      /const agentTurnTelemetryRepo = new DrizzleAgentTurnTelemetryRepo\(dbHandle\);/,
    );
    expect(bootstrap).toMatch(
      /const agentTurnTelemetry = new AgentTurnTelemetry\(\{\s*writer: agentTurnTelemetryRepo,/,
    );
    const gateStart = bootstrap.indexOf('if (metricsRegistry !== undefined) {');
    const constructed = bootstrap.indexOf('const agentTurnTelemetry = new AgentTurnTelemetry(');
    expect(gateStart).toBeGreaterThan(-1);
    // Constructed at top level of the bootstrap function: two-space indent.
    expect(bootstrap.slice(bootstrap.lastIndexOf('\n', constructed) + 1, constructed)).toBe('  ');
    // …and the metrics half switches on by itself when the registry exists.
    expect(bootstrap).toMatch(
      /new AgentTurnTelemetry\(\{[^}]*\.\.\.\(metricsRegistry !== undefined \? \{ metrics: metricsRegistry \} : \{\}\),/,
    );
  });

  it('CRITICAL the runtime’s usage recorder is the WRAPPED one. Unwrapped, every turn still leaves a row — with zero tokens, no model and no cost, which reads as "free" rather than as "unmeasured".', () => {
    expect(bootstrap).toMatch(
      /usageRecorder: agentTurnTelemetry\.wrapUsageRecorder\(agentDecomposerUsageRecorder\),/,
    );
    expect(bootstrap).not.toMatch(/usageRecorder: agentDecomposerUsageRecorder,/);
  });

  it('bootstrap hands both halves to the app, and the app hands them on', () => {
    expect(bootstrap).toMatch(/\n {4}agentTurnTelemetry,\n {4}agentTurnSummaryService,\n/);
    expect(app).toMatch(
      /\.\.\.\(deps\.agentTurnTelemetry !== undefined\s*\? \{ turnTelemetry: deps\.agentTurnTelemetry \}\s*: \{\}\),/,
    );
    expect(app).toMatch(
      /if \(deps\.agentTurnSummaryService !== undefined\) \{\s*registerAdminAgentTurnsRoutes\(app, \{ summary: deps\.agentTurnSummaryService \}\);/,
    );
  });

  it('teardown FLUSHES pending rows, under a deadline, BEFORE the database closes. The write is deferred off the response path, so at SIGTERM the last turns’ rows are still pending — and every deploy is a SIGTERM. Flushed after the pool closed, or not at all, they are lost without even being counted.', () => {
    const flush = bootstrap.indexOf(
      'await withTeardownDeadline(AGENT_TURN_TELEMETRY_FLUSH_DEADLINE_MS, () =>\n      agentTurnTelemetry.flush(),',
    );
    const dbClose = bootstrap.indexOf('dbHandle.close(),');
    expect(flush).toBeGreaterThan(-1);
    expect(dbClose).toBeGreaterThan(flush);
    expect(bootstrap.indexOf('const teardown = shareFirstAsyncCall(')).toBeLessThan(flush);
  });

  it('the retention job is REGISTERED and ENQUEUED. A handler nobody enqueues has no pending row and never runs; the table then grows by one row per request forever.', () => {
    expect(bootstrap).toMatch(
      /registerAgentTurnTelemetryPruneJob\(\{\s*scheduledJobs: scheduledJobsService,\s*repo: agentTurnTelemetryRepo,/,
    );
    expect(bootstrap).toMatch(
      /await enqueueNextAgentTurnTelemetryPrune\(\{ scheduledJobs: scheduledJobsService \}\);/,
    );
  });
});
