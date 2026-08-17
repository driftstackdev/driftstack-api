// W1033 — routes/status V-176 cross-source invariant. Three-hundred-
// fifty-ninth in the drift-guard series. Pins the apps/server/src/
// routes/status.ts customer-facing status route:
//
//   V-176 anchor — 'V-176 — public-facing status endpoint'.
//
//   Distinction framing — 'Distinct from /ready (which is the k8s /
//   liveness probe consumed by orchestration infrastructure). /v1/
//   status is the CUSTOMER-FACING status surface — what the public
//   status page (marketing-site /status, future) consumes'.
//
//   Constants — CACHE_MAX_AGE_SEC 30 + COMPONENT_TIMEOUT_MS 1500.
//
//   ComponentStatus 3-value — 'operational' | 'degraded' |
//     'major_outage'.
//
//   runComponentCheck framing — Promise.race between check.fn() and
//     timeoutMs reject. ok → 'operational', failed → 'degraded'.
//
//   aggregateOverall framing — 'any major_outage → major_outage; any
//   degraded → degraded; else operational'.
//
//   Major-outage-reserved framing — 'major_outage isn't reachable
//   from the readiness probes today (single-failure → degraded);
//   reserved for future incidents service to mark wide-blast-radius
//   outages'.
//
//   No-auth + 30s-cache framing — 'No auth required — status pages
//   are public. Caching: caller (Cloudflare Pages, future) caches
//   the response for ~30s. Response includes Cache-Control: public,
//   max-age=30'.
//
//   Response shape — { overall_status (aggregateOverall(components)
//     escalated by open-incident truth), components,
//     recent_incidents, open_incidents, incident_data_complete }.
//
// stays in lockstep across apps/server/src/routes/status.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1033 routes/status V-176 cross-source invariant', () => {
  it('CRITICAL V-176 anchor + customer-facing distinction from /ready.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(/V-176 — public-facing status endpoint\./);
    expect(p).toMatch(/Distinct from \/ready \(which is the k8s \/ liveness probe consumed by/);
    expect(p).toMatch(/orchestration infrastructure\)\. \/v1\/status is the CUSTOMER-FACING/);
    expect(p).toMatch(/status surface — what the public status page \(marketing-site/);
    expect(p).toMatch(/\/status, future\) consumes\./);
  });

  it('CRITICAL constants — CACHE_MAX_AGE_SEC 30 + COMPONENT_TIMEOUT_MS 1500.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(/const CACHE_MAX_AGE_SEC = 30;/);
    expect(p).toMatch(/const COMPONENT_TIMEOUT_MS = 1500;/);
  });

  it("CRITICAL ComponentStatus 3-value union — 'operational' | 'degraded' | 'major_outage'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(/type ComponentStatus = 'operational' \| 'degraded' \| 'major_outage';/);
  });

  it("CRITICAL runComponentCheck — Promise.race(check.fn(), setTimeout-reject(timeoutMs)) + ok → 'operational' + catch → 'degraded'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(/const timeoutMs = check\.timeoutMs \?\? COMPONENT_TIMEOUT_MS;/);
    expect(p).toMatch(/await Promise\.race\(\[/);
    expect(p).toMatch(/check\.fn\(\),/);
    expect(p).toMatch(/timer = setTimeout\(\(\) => reject\(new Error\('timeout'\)\), timeoutMs\);/);
    // The race's losing timer must be cancelled, matching the /ready twin
    // (runWithTimeout in lib/app.ts). Without it each request leaks a timer.
    expect(p).toMatch(/\} finally \{\s*\n?\s*if \(timer !== undefined\) clearTimeout\(timer\);/);
    expect(p).toMatch(/status: 'operational',/);
    expect(p).toMatch(/status: 'degraded',/);
  });

  it('CRITICAL aggregateOverall — any major_outage → major_outage; any degraded → degraded; else operational.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(
      /if \(components\.some\(\(c\) => c\.status === 'major_outage'\)\) return 'major_outage';/,
    );
    expect(p).toMatch(
      /if \(components\.some\(\(c\) => c\.status === 'degraded'\)\) return 'degraded';/,
    );
    expect(p).toMatch(/return 'operational';/);
  });

  it("CRITICAL major-outage-reserved framing — 'major_outage isn't reachable from the readiness probes today (single-failure → degraded); reserved for future incidents service to mark wide-blast-radius outages'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(/'major_outage' isn't reachable from the readiness probes today/);
    expect(p).toMatch(/\(single-failure → 'degraded'\); reserved for future incidents/);
    expect(p).toMatch(/service to mark wide-blast-radius outages\./);
  });

  it("CRITICAL no-auth + 30s-cache framing — 'No auth required — status pages are public. Caching: caller (Cloudflare Pages, future) caches the response for ~30s. Response includes Cache-Control: public, max-age=30'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(/\/\/ No auth required — status pages are public\./);
    expect(p).toMatch(/\/\/ Caching: caller \(Cloudflare Pages, future\) caches the response for/);
    expect(p).toMatch(/\/\/ ~30s\. Response includes Cache-Control: public, max-age=30\./);
    expect(p).toMatch(
      /reply\.header\('cache-control', `public, max-age=\$\{CACHE_MAX_AGE_SEC\.toString\(\)\}`\);/,
    );
  });

  it('CRITICAL response shape — { overall_status: overallStatus (aggregateOverall(components) escalated by open-incident truth), components, recent_incidents: PublicIncidentSummary[], open_incidents, incident_data_complete (f66e8a02c — fail closed) }.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(/let overallStatus = aggregateOverall\(components\);/);
    expect(p).toMatch(/if \(hasOpenOutage\) overallStatus = 'major_outage';/);
    expect(p).toMatch(
      /else if \(\(!incidentDataComplete \|\| openIncidentCount > 0\) && overallStatus === 'operational'\) \{/,
    );
    expect(p).toMatch(/overall_status: overallStatus,/);
    expect(p).toMatch(/components,/);
    expect(p).toMatch(/recent_incidents: recentIncidents,/);
    expect(p).toMatch(/recent_incidents: readonly PublicIncidentSummary\[\];/);
    expect(p).toMatch(/open_incidents: incidentDataComplete \? openIncidentCount : null,/);
    expect(p).toMatch(/incident_data_complete: incidentDataComplete,/);
  });

  it('CRITICAL endpoint runs Promise.all(opts.readinessChecks.map(runComponentCheck)) — parallel per-check execution.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status.ts'));
    expect(p).toMatch(
      /const components = await Promise\.all\(opts\.readinessChecks\.map\(runComponentCheck\)\);/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-status-v176-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
