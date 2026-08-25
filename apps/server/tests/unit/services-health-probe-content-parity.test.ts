// W408.A — drift guard for apps/server/src/services/health-probe.ts.
// V-295b auto-incident poller. Probes targets every tick + auto-
// creates/resolves public incidents on threshold cross. Drift here
// either lets a single failure auto-create an incident (false-
// positive spam) or breaks the open-incident dedup (concurrent
// auto-creates).
//
//   • V-295b framing pinned: per-tick probe + record + threshold-
//     evaluate; no admin_audit_log writes (auto-actions have no
//     admin actor — probe table itself is audit trail).
//   • Dependencies injected (no fetch / no Date.now calls) for
//     deterministic tests.
//   • 4-step processTick framing (probe → record → threshold-eval
//     → auto-create/resolve).
//   • Defaults: failureThreshold=3 + recoveryThreshold=3 +
//     retentionMs=30 days.
//   • Auto-create: ALL last `failureThreshold` failed AND NO open
//     auto-incident; severity='major', public=true, autoProbe
//     Target=target.id, createdByAdminId=null.
//   • Auto-resolve: ALL last `recoveryThreshold` succeeded AND
//     open auto-incident exists; postedByAdmin* null.
//   • Hourly prune: pruneOlderThan(now - retentionMs); throttled
//     by lastPruneAt > 60min ago check.
//   • try/catch around probe-record: warn-log + don't throw (don't
//     let bootstrap interval see it as poller error).
//   • FetchProber: AbortController timeout (default 5_000ms);
//     errorMessage truncated to 500 chars; latency measured even
//     on error path.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/health-probe.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W408.A apps/server/src/services/health-probe.ts content parity', () => {
  const body = read(LIB);

  it('V-295b framing pinned: 60s processTick + 4-step probe/record/threshold-eval/auto-create flow', () => {
    expect(body).toMatch(/V-295b — system health probe poller\./);
    expect(body).toMatch(
      /Runs once per `processTick` \(60s in production, driven by bootstrap\s*\/\/\s*setInterval\)\./,
    );
    expect(body).toMatch(/1\. Probes the target via the injected `Prober` \(HTTP HEAD\/GET\)\./);
    expect(body).toMatch(
      /3\. Inspects the last `failureThreshold` probes for that target\. If\s*\/\/\s*ALL failed AND no open auto-incident exists for that target,\s*\/\/\s*auto-creates an incident \(severity = 'major', public = true,\s*\/\/\s*auto_probe_target = target\)\./,
    );
    expect(body).toMatch(
      /4\. Inspects the last `recoveryThreshold` probes\. If ALL succeeded\s*\/\/\s*AND there IS an open auto-incident for that target, auto-resolves\s*\/\/\s*it/,
    );
  });

  it('Injected-deps framing pinned (deterministic tests) + probe table = audit trail (no admin_audit_log writes)', () => {
    expect(body).toMatch(
      /Dependencies are intentionally injected \(no fetch \/ no Date\.now\s*\/\/\s*calls\) so tests can drive the service deterministically\./,
    );
    expect(body).toMatch(
      /This service does NOT write admin_audit_log rows — auto-actions\s*\/\/\s*have no admin actor\. The probe table itself is the audit trail\s*\/\/\s*\(every probe \+ every threshold trigger is recoverable from rows\)\./,
    );
  });

  it('Defaults: failureThreshold=3 + recoveryThreshold=3 + retentionMs=30 days', () => {
    expect(body).toMatch(/this\.failureThreshold = config\.failureThreshold \?\? 3;/);
    expect(body).toMatch(/this\.recoveryThreshold = config\.recoveryThreshold \?\? 3;/);
    expect(body).toMatch(
      /this\.retentionMs = config\.retentionMs \?\? 30 \* 24 \* 60 \* 60 \* 1000;/,
    );
  });

  it('HealthProbeTarget: id (stable slug) + label + url + timeoutMs? default 5_000', () => {
    expect(body).toMatch(/export interface HealthProbeTarget \{/);
    expect(body).toMatch(
      /\/\*\* Stable slug stored in `system_health_probes\.target` and\s*\*\s*`incidents\.auto_probe_target`\. \*\/\s*id: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Per-probe timeout in ms; default 5_000\. \*\/\s*timeoutMs\?: number;/,
    );
  });

  it('ProbesRepo: 4 methods (recordProbe + recentForTarget newest-first + pruneOlderThan + V-295e countByTargetSince)', () => {
    expect(body).toMatch(/export interface ProbesRepo \{/);
    expect(body).toMatch(
      /\/\*\* Last N probes for a target, newest first\. \*\/\s*recentForTarget\(target: string, n: number\): Promise<ProbeRecordRow\[\]>;/,
    );
    expect(body).toMatch(
      /\/\*\* Delete probes older than `before`\. Returns count pruned\. \*\/\s*pruneOlderThan\(before: Date\): Promise<number>;/,
    );
    expect(body).toMatch(
      /V-295e — counts of ok\/not-ok probes per target since `since`\.\s*\*\s*Used by the SLA endpoint\. Returns one row per target that has\s*\*\s*at least one probe in the window\./,
    );
  });

  it('processTick: try/catch per target warn-log + DO NOT throw (avoid poller-loop bootstrap error treatment)', () => {
    expect(body).toMatch(
      /\/\/ The probe \+ record path itself failed \(DB outage, etc\)\.\s*\/\/ Log warn — we will retry next tick\. Do NOT throw, or the\s*\/\/ bootstrap interval treats it as a poller-loop error\./,
    );
    expect(body).toMatch(/'health probe tick failed for target',/);
  });

  it('Hourly prune: throttled by lastPruneAt > 60min check; pruneOlderThan(now - retentionMs); warn-only on failure (will retry next hour)', () => {
    expect(body).toMatch(
      /\/\/ Hourly prune to keep table small\. Only prunes if last prune was\s*\/\/ more than an hour ago — cheap idempotent op\./,
    );
    expect(body).toMatch(
      /if \(!this\.lastPruneAt \|\| now\.getTime\(\) - this\.lastPruneAt\.getTime\(\) > 60 \* 60 \* 1000\) \{/,
    );
    expect(body).toMatch(/const before = new Date\(now\.getTime\(\) - this\.retentionMs\);/);
    expect(body).toMatch(/'probe prune failed \(will retry next hour\)',/);
  });

  it('Auto-create: !open && recent.length>=failureThreshold && first N all failed; severity=major + public=true + autoProbeTarget=target.id + createdByAdminId=null', () => {
    expect(body).toMatch(
      /\/\/ Auto-create: last `failureThreshold` probes all failed AND no\s*\/\/ open auto-incident exists\./,
    );
    expect(body).toMatch(
      /if \(\s*!open &&\s*recent\.length >= this\.failureThreshold &&\s*recent\.slice\(0, this\.failureThreshold\)\.every\(\(p\) => !p\.ok\)\s*\) \{/,
    );
    expect(body).toMatch(
      /const created = await this\.incidents\.create\(\{\s*title: `\$\{target\.label\} health check failing`,\s*description: `Auto-detected: \$\{this\.failureThreshold\} consecutive health checks failed\. Latest error: \$\{sanitizePublicProbeError\(lastErr\)\}\.`,\s*severity: 'major',\s*affectedComponents: \[target\.id\],\s*public: true,\s*startedAt: now,\s*createdByAdminId: null,\s*createdByAdminKeyId: null,\s*autoProbeTarget: target\.id,/,
    );
    expect(body).not.toMatch(/description:.*target\.url/);
    expect(body).toMatch(/'auto-created incident on health probe failure threshold',/);
  });

  it('Auto-resolve: open && recent.length>=recoveryThreshold && first N all ok; final update postedByAdminId=null', () => {
    expect(body).toMatch(
      /\/\/ Auto-resolve: last `recoveryThreshold` probes all succeeded AND\s*\/\/ an open auto-incident exists\./,
    );
    expect(body).toMatch(
      /if \(\s*open &&\s*recent\.length >= this\.recoveryThreshold &&\s*recent\.slice\(0, this\.recoveryThreshold\)\.every\(\(p\) => p\.ok\)\s*\) \{/,
    );
    expect(body).toMatch(/'auto-resolved incident on health probe recovery threshold',/);
    expect(body).toMatch(
      /await this\.incidents\.resolve\(\{\s*incidentId: open\.id,\s*message: `Auto-resolved: \$\{this\.recoveryThreshold\} consecutive successful probes\. Service recovered\.`,\s*postedByAdminId: null,\s*postedByAdminKeyId: null,\s*\}\);/,
    );
  });

  it('evaluateThresholds: window = Math.max(failureThreshold, recoveryThreshold); findOpenAutoIncident dedup; returns "created"|"resolved"|"noop"', () => {
    expect(body).toMatch(
      /private async evaluateThresholds\(\s*target: HealthProbeTarget,\s*now: Date,\s*\): Promise<'created' \| 'resolved' \| 'noop'> \{\s*const window = Math\.max\(this\.failureThreshold, this\.recoveryThreshold\);/,
    );
    expect(body).toMatch(/const open = await this\.incidents\.findOpenAutoIncident\(target\.id\);/);
  });

  it("FetchProber: AbortController timeout default 5_000ms; GET method; accept:'application/json' header; no Authorization (/health public by design)", () => {
    expect(body).toMatch(/export class FetchProber implements Prober \{/);
    expect(body).toMatch(/const timeoutMs = target\.timeoutMs \?\? 5_000;/);
    expect(body).toMatch(
      /const res = await fetch\(target\.url, \{\s*method: 'GET',\s*redirect: 'error',\s*signal: controller\.signal,\s*\/\/ No Authorization header — \/health is public by design\.\s*headers: \{ accept: 'application\/json' \},\s*\}\);/,
    );
  });

  it('FetchProber catch: errorMessage truncated to 500 chars; latencyMs measured even on error path', () => {
    expect(body).toMatch(
      /\} catch \(err\) \{\s*const latencyMs = Date\.now\(\) - start;\s*const message = err instanceof Error \? err\.message : String\(err\);\s*return \{\s*ok: false,\s*latencyMs,\s*httpStatus: null,\s*errorMessage: message\.slice\(0, 500\),/,
    );
  });

  it('ProbeRecordRow: 7 fields with latencyMs + httpStatus + errorMessage nullable', () => {
    expect(body).toMatch(/export interface ProbeRecordRow \{/);
    expect(body).toMatch(/latencyMs: number \| null;/);
    expect(body).toMatch(/httpStatus: number \| null;/);
    expect(body).toMatch(/errorMessage: string \| null;/);
    expect(body).toMatch(/probedAt: Date;/);
  });

  it('imports: Logger + IncidentRow + IncidentsService types', () => {
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(
      /import type \{ IncidentRow, IncidentsService \} from '\.\/incidents\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
