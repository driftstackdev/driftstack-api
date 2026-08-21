// W549.B — drift guard for /docs/verification-log.md.
// Append-only V-NNN ticket log. Drift here either deletes a
// load-bearing V-NNN that the decisions log links to (would
// orphan a D-NNN), weakens the append-only / reality-wins charter
// (would let intent-vs-reality drift go undocumented), or
// re-numbers a V-NNN (would break every cross-reference across
// docs/decisions.md + docs/adr/* + agent commit messages).
//
//   • Append-only, dated, "reality wins" charter.
//   • V-001 Phase 1 baseline (repo + tooling green).
//   • V-051 Workstream A foundational (Dockerfile + /ready +
//     deploy pipeline + network architecture doc).
//   • V-052 sub-processor lock (Coinbase Commerce drop).
//   • V-087 architecture.md sync (Routine — documentation).
//   • V-109 architecture.md V-099 + V-100 catch-up.
//   • V-202c AccountLifecycleService + first-failure email dedup.
//   • V-202d generic scheduled_jobs + trial-pack expiry.
//   • V-243 Tauri Updater + GitHub Releases.
//   • V-246 pre-launch security audit.
//   • V-258 / V-259 Cloudflare Pages deploy + consolidated runbook.
//   • V-278 Hetzner deployment automation.
//   • V-328 Tauri driftstack:// custom URL scheme.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/verification-log.md');
/**
 * V-1215 — the log was split on 2026-08-20 and the historical V-anchors this file pins now live in
 * the frozen archive. The pins describe the whole log, not its live tail, so the body below is both
 * halves concatenated. Repointing them at the live file alone would have quietly dropped every
 * anchor from V-001 to V-1200 while still reporting green.
 */
const ARCHIVE = resolve(REPO_ROOT, 'docs/verification-log-archive-through-v1200.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W549.B /docs/verification-log.md content parity', () => {
  const body = `${read(LIB)}\n${read(ARCHIVE)}`;

  it("Header + append-only + reality-wins charter framing pinned: '# Driftstack API — Verification Log' + 'This log records every verification of empirical reality (build cycles, test runs, infrastructure assumptions) and every discrepancy between intent and behaviour. Entries are append-only and dated.' + 'When intent and reality disagree: reality wins, code reflects reality, planning is updated, the change is recorded here.' + 'Format: `V-NNN — title`. Date in body.' — pinned so the empirical-reality-verification + append-only-dated + reality-wins-not-intent + V-NNN-format commitment survives", () => {
    expect(body).toMatch(/^# Driftstack API — Verification Log$/m);
    expect(body).toMatch(
      /This log records every verification of empirical reality \(build cycles, test runs, infrastructure assumptions\)/,
    );
    expect(body).toMatch(/and every discrepancy between intent and behaviour\./);
    expect(body).toMatch(/Entries are append-only and dated\./);
    expect(body).toMatch(
      /When intent and reality disagree: reality wins, code reflects reality, planning is updated, the change is recorded here\./,
    );
    expect(body).toMatch(/Format: `V-NNN — title`\. Date in body\./);
  });

  it("V-001 + V-051 + V-052 foundational V-anchors pinned: '## V-001 — Phase 1 baseline: repo, monorepo scaffolding, tooling green' + '## V-051 — Workstream A foundational: Dockerfile, /ready, deploy pipeline, network architecture doc' + '## V-052 — Drop Coinbase Commerce from legal docs + sub-processor lock; bump to v0.1.2-draft' — pinned so the Phase-1-baseline + Workstream-A-Dockerfile-deploy-pipeline + sub-processor-lock-Coinbase-Commerce-drop commitment survives", () => {
    expect(body).toMatch(/## V-001 — Phase 1 baseline: repo, monorepo scaffolding, tooling green/);
    expect(body).toMatch(
      /## V-051 — Workstream A foundational: Dockerfile, \/ready, deploy pipeline, network architecture doc/,
    );
    expect(body).toMatch(
      /## V-052 — Drop Coinbase Commerce from legal docs \+ sub-processor lock; bump to v0\.1\.2-draft/,
    );
  });

  it("V-087 + V-109 architecture-sync V-anchors pinned: '## V-087 — docs/architecture.md sync (Routine — documentation)' + '## V-109 — docs/architecture.md V-099 + V-100 catch-up (Routine — documentation)' — pinned so the architecture-doc-sync-Routine + V-099-customer-dashboard + V-100-admin-force-actions-catch-up commitment survives", () => {
    expect(body).toMatch(/## V-087 — docs\/architecture\.md sync \(Routine — documentation\)/);
    expect(body).toMatch(
      /## V-109 — docs\/architecture\.md V-099 \+ V-100 catch-up \(Routine — documentation\)/,
    );
  });

  it("V-202c + V-202d AccountLifecycleService + scheduled_jobs V-anchors pinned: '## V-202c — first-failure email dedup + AccountLifecycleService introduction' + '## V-202d — generic scheduled_jobs + trial-pack expiry job' — pinned so the AccountLifecycleService-introduction + first-failure-email-dedup + generic-scheduled_jobs + trial-pack-expiry commitment survives", () => {
    expect(body).toMatch(
      /## V-202c — first-failure email dedup \+ AccountLifecycleService introduction/,
    );
    expect(body).toMatch(/## V-202d — generic scheduled_jobs \+ trial-pack expiry job/);
  });

  it("V-243 + V-246 + V-258 + V-259 + V-278 + V-328 launch-prep V-anchors pinned: '## V-243 — GUI T3 #3: Tauri Updater + GitHub Releases (cross-platform distribution)' + '## V-246 — Pre-launch security audit' + '## V-258 — Cloudflare Pages deploy workflow for apps/docs + founder runbook' + '## V-259 — Cloudflare Pages consolidated founder runbook + queue update' + '## V-278 — Hetzner deployment automation (skip-on-missing-secret + tag-triggered + founder runbook)' + '## V-328 — Tauri custom URL scheme deep-link (TS-side wired, native pending)' — pinned so the Tauri-Updater + pre-launch-audit + CF-Pages-apps/docs-deploy + Hetzner-automation-skip-on-missing-secret + driftstack-deep-link-TS-side-wired commitment survives", () => {
    expect(body).toMatch(
      /## V-243 — GUI T3 #3: Tauri Updater \+ GitHub Releases \(cross-platform distribution\)/,
    );
    expect(body).toMatch(/## V-246 — Pre-launch security audit/);
    expect(body).toMatch(
      /## V-258 — Cloudflare Pages deploy workflow for apps\/docs \+ founder runbook/,
    );
    expect(body).toMatch(
      /## V-259 — Cloudflare Pages consolidated founder runbook \+ queue update/,
    );
    expect(body).toMatch(
      /## V-278 — Hetzner deployment automation \(skip-on-missing-secret \+ tag-triggered \+ founder runbook\)/,
    );
    expect(body).toMatch(
      /## V-328 — Tauri custom URL scheme deep-link \(TS-side wired, native pending\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
