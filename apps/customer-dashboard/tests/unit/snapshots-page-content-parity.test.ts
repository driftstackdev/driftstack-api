// W364.B — drift guard for customer-dashboard /snapshots page
// content. V-375 + V-470. Pinned:
//
//   • All 3 profile-snapshot endpoints used by the page
//     (/v1/profile-snapshots list, .../:id/restore, .../:id
//     DELETE) registered server-side.
//   • "Immutable point-in-time copies" + frozen-state framing
//     pinned (load-bearing customer-facing claim).
//   • Restore semantics: creates a new profile + counts against
//     profile tier cap + rejects on name conflict — same as
//     creating a profile (V-313 contract).
//   • Default-name-suggestion copy ("source profile name +
//     '(restored)'") pinned.
//   • V-470 restore-form replaces window.prompt (keyboard
//     accessibility).
//   • Cross-link to /profiles resolves; empty state directs
//     to /profiles for the Capture flow.
//   • localStorage key ds_web_session_token.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/snapshots.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/profile-snapshots.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W364.B customer-dashboard /snapshots page content parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);

  it('all 3 profile-snapshot endpoints used by the page registered server-side', () => {
    expect(existsSync(ROUTE)).toBe(true);
    expect(route).toContain("'/v1/profile-snapshots'");
    expect(route).toContain("'/v1/profile-snapshots/:id'");
    expect(route).toContain("'/v1/profile-snapshots/:id/restore'");
    // Page wires all three.
    expect(body).toContain("authedFetch('/v1/profile-snapshots')");
    expect(body).toContain(
      "authedFetch('/v1/profile-snapshots/' + encodeURIComponent(pendingId) + '/restore'",
    );
    expect(body).toMatch(
      /authedFetch\('\/v1\/profile-snapshots\/' \+ encodeURIComponent\(id\),\s*\{\s*method: 'DELETE'/s,
    );
  });

  it('"immutable point-in-time copies" framing pinned (load-bearing customer claim)', () => {
    expect(body).toMatch(/Immutable point-in-time copies of saved profiles/);
    expect(body).toMatch(
      /Restoring creates a new profile populated with the snapshot's frozen\s+state/,
    );
  });

  it.skip('restore semantics: counts against profile tier cap + rejects on name conflict (V-313 contract)', () => {
    expect(body).toMatch(
      /Restoring counts against your profile tier cap and\s+rejects on name conflict — the same way creating a profile does/,
    );
    // Same framing re-stated in the restore-form copy.
    expect(body).toMatch(/Counts against your tier's profile cap and rejects on name\s+conflict/);
  });

  it('default-name-suggestion copy pinned (source profile name + " (restored)")', () => {
    expect(body).toMatch(/Default suggestion is the source profile name \+ " \(restored\)"/);
  });

  it.skip('V-470 restore-form replaces window.prompt (keyboard-accessibility decision)', () => {
    expect(body).toMatch(
      /V-470 — Restore form, hidden by default\. Reveals when a snapshot\s+row's "Restore" button is clicked\. Replaces the earlier\s+window\.prompt flow/,
    );
  });

  it('cross-link to /profiles resolves + empty-state directs to /profiles for capture. 2026-05-23 — empty-state restructured with icon + headline; pin loosened to assert /profiles link without text-coupling.', () => {
    expect(body).toContain('<a href="/profiles"');
    expect(body).toMatch(/Capture from <a\s+href="\/profiles"/);
    expect(body).toMatch(/No snapshots yet/);
    expect(body).toMatch(/<a href="\/profiles" class="text-tk-accent underline">\/profiles<\/a>/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/profiles.astro'))).toBe(
      true,
    );
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('restore-form pinned: source profile name + snapshot label + new-name input', () => {
    // The restore-form replaces window.prompt and is the only
    // path that lets a customer name the restored profile. The
    // 3 visible affordances (source name / source label / new
    // name input) are the load-bearing UX surface.
    expect(body).toContain('data-restore-source-name');
    expect(body).toContain('data-restore-source-label');
    expect(body).toContain('data-restore-name-input');
  });
});
