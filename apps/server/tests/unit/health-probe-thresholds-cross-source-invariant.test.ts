// W907 — V-295b health-probe poller threshold cross-source
// invariant. Two-hundred-thirty-third in the drift-guard series.
// Pins the V-295b auto-incident health-probe contract:
//
//   processTick: 60s in production (bootstrap setInterval).
//
//   4-step probe-tick contract:
//     1. Probe target via injected Prober (HTTP HEAD/GET).
//     2. Insert system_health_probes row (ok/latency/status/error).
//     3. Last failureThreshold probes ALL failed AND no open auto-
//        incident → auto-create incident (severity='major',
//        public=true, auto_probe_target=target).
//     4. Last recoveryThreshold probes ALL ok AND open auto-incident
//        → auto-resolve (final 'resolved' update + resolved_at).
//
//   HealthProbeServiceConfig defaults:
//     - failureThreshold: 3 consecutive failures.
//     - recoveryThreshold: 3 consecutive successes.
//     - retentionMs: 30 days.
//     - per-probe timeoutMs default: 5_000.
//
//   V-295e — countByTargetSince repo method for SLA endpoint.
//
//   Auto-actions have NO admin actor; the probe table IS the audit
//   trail (every probe + threshold trigger is recoverable from rows).
//
// stays in lockstep across apps/server/src/services/health-probe.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W907 V-295b health-probe thresholds cross-source invariant', () => {
  // ─── V-295b anchor + 4-step contract ─────────────────────────

  it("CRITICAL apps/server/src/services/health-probe.ts pins V-295b anchor — 'V-295b — system health probe poller'. The poller is the source of auto-created status-page incidents.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(/V-295b — system health probe poller/);
  });

  it("CRITICAL 60s production tick framing — 'Runs once per processTick (60s in production, driven by bootstrap setInterval)'. The 60s cadence matches V-218 ValidationSchedule minimum cadence; consistent with admin-panel SLA refresh.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(
      /Runs once per `processTick` \(60s in production, driven by bootstrap\s*\n\/\/ setInterval\)/,
    );
  });

  it('CRITICAL 4-step probe-tick contract pinned — probe → record row → check failureThreshold → check recoveryThreshold. The 4-step pattern is the auto-incident state machine.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(/1\. Probes the target via the injected `Prober`/);
    expect(p).toMatch(/2\. Inserts a `system_health_probes` row/);
    expect(p).toMatch(/3\. Inspects the last `failureThreshold` probes/);
    expect(p).toMatch(/4\. Inspects the last `recoveryThreshold` probes/);
  });

  // ─── failureThreshold + recoveryThreshold = 3 ────────────────

  it('CRITICAL HealthProbeServiceConfig defaults — failureThreshold = 3 consecutive failures + recoveryThreshold = 3 consecutive successes. The symmetric 3/3 threshold is the V-295b auto-action policy.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(/Number of consecutive failures before auto-create\. Default 3/);
    expect(p).toMatch(/Number of consecutive successes before auto-resolve\. Default 3/);
  });

  // ─── 30-day retention default ────────────────────────────────

  it("CRITICAL HealthProbeServiceConfig.retentionMs default = 30 days — 'Probe history retention. Default 30 days'. The 30-day retention matches V-297 GDPR audit-log retention; SLA queries (V-295e) use this window.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(/Probe history retention\. Default 30 days/);
  });

  // ─── HealthProbeTarget 4-field + 5s timeout default ──────────

  it('CRITICAL HealthProbeTarget has 4 fields — id (stable slug stored in system_health_probes.target + incidents.auto_probe_target) + label (human-readable) + url + timeoutMs (default 5_000). The 5s timeout cap bounds per-probe latency.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(
      /Stable slug stored in `system_health_probes\.target` and\s*\n\s*\*\s*`incidents\.auto_probe_target`/,
    );
    expect(p).toMatch(/Per-probe timeout in ms; default 5_000/);
  });

  // ─── Auto-incident severity = 'major' + public ───────────────

  it("CRITICAL auto-created incident framing pins 'severity = major, public = true, auto_probe_target = target'. The 'major' severity ensures status-page surfacing; 'public=true' makes the incident visible to all customers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(/severity = 'major', public = true,\s*\n\/\/\s+auto_probe_target = target/);
  });

  // ─── Auto-actions have NO admin actor ───────────────────────

  it("CRITICAL framing pins 'This service does NOT write admin_audit_log rows — auto-actions have no admin actor. The probe table itself is the audit trail'. The probe-table-as-audit-trail contract makes auto-actions distinguishable from staff actions.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(/This service does NOT write admin_audit_log rows — auto-actions/);
    expect(p).toMatch(
      /have no admin actor\. The probe table itself is the audit trail\s*\n\/\/ \(every probe \+ every threshold trigger is recoverable from rows\)/,
    );
  });

  // ─── V-295e SLA aggregation ─────────────────────────────────

  it("CRITICAL ProbesRepo.countByTargetSince has V-295e anchor + 'counts of ok/not-ok probes per target since since. Used by the SLA endpoint'. The 5-field aggregate (target + okCount + failCount + lastProbeAt + lastFailureAt) is the SLA-page data shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(/V-295e — counts of ok\/not-ok probes per target since/);
    expect(p).toMatch(/Used by the SLA endpoint/);
    expect(p).toMatch(
      /\{\s*\n\s*target: string;\s*\n\s*okCount: number;\s*\n\s*failCount: number;\s*\n\s*lastProbeAt: Date;\s*\n\s*lastFailureAt: Date \| null;/,
    );
  });

  // ─── Dependency injection framing ────────────────────────────

  it("CRITICAL 'Dependencies are intentionally injected (no fetch / no Date.now calls) so tests can drive the service deterministically' framing pinned. The DI-everywhere pattern is the testability contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(
      /Dependencies are intentionally injected \(no fetch \/ no Date\.now\s*\n\/\/ calls\) so tests can drive the service deterministically/,
    );
  });

  // ─── ProbeRecordRow 7-field shape ────────────────────────────

  it('CRITICAL ProbeRecordRow has 7 fields — id + target + probedAt + ok + latencyMs (nullable) + httpStatus (nullable) + errorMessage (nullable). The 3 nullables let timed-out / connection-refused probes record errorMessage without forcing fake latency/status numbers.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts'));
    expect(p).toMatch(/export interface ProbeRecordRow \{/);
    expect(p).toMatch(/id: string;/);
    expect(p).toMatch(/target: string;/);
    expect(p).toMatch(/probedAt: Date;/);
    expect(p).toMatch(/ok: boolean;/);
    expect(p).toMatch(/latencyMs: number \| null;/);
    expect(p).toMatch(/httpStatus: number \| null;/);
    expect(p).toMatch(/errorMessage: string \| null;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/health-probe-thresholds-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
