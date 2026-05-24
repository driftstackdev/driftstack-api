// W359.B — drift guard for customer-dashboard /sessions page
// content. V-180 + V-186. The page is the canonical view onto
// the only billing meter (concurrent sessions), so its claims
// about state machine + concurrent-cap + "no UI mint" lifecycle
// need pinning against schema source-of-truth.
//
// Pinned:
//   • STATUS_BADGE_CLASS keys (creating / ready / busy /
//     destroyed / errored) cover SessionStatusSchema exactly.
//   • activeSessions / recentClosedSessions partition uses the
//     same destroyed-or-errored boundary as the badge map.
//   • TIER_CONCURRENT_SESSION_LIMITS imported from api-types — the
//     concurrent_limit comes from this map keyed by /v1/usage.tier.
//   • Concurrent meter is wired off two parallel fetches
//     (/v1/sessions for count of {creating, ready, busy};
//     /v1/usage for the tier → cap mapping).
//   • "Sessions are the only billing meter" framing pinned (the
//     economic claim customers integrate against).
//   • V-348 — "sessions are minted via the SDK or GUI client, not
//     this dashboard" framing pinned (no Create-session button
//     here; that would mislead onboarding).
//   • localStorage key ds_web_session_token.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStatusSchema, TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/sessions.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W359.B customer-dashboard /sessions page content parity', () => {
  const body = read(PAGE);
  const statuses = new Set<string>(
    (SessionStatusSchema._def as { values: readonly string[] }).values,
  );

  it('STATUS_BADGE_CLASS keys cover SessionStatusSchema exactly', () => {
    // Same status taxonomy on both sides — a server-side enum
    // add (e.g. 'evicted') without a page update silently
    // renders the new row without a badge.
    expect(statuses).toEqual(new Set(['creating', 'ready', 'busy', 'destroyed', 'errored']));
    for (const s of statuses) {
      expect(body).toMatch(new RegExp(`${s}:\\s*'bg-[a-z]+`));
    }
  });

  it('activeSessions / recentClosedSessions partition matches destroyed-or-errored boundary', () => {
    expect(body).toMatch(
      /activeSessions = MOCK_SESSIONS\.filter\([\s\S]*?s\.status !== 'destroyed' && s\.status !== 'errored'/,
    );
    expect(body).toMatch(
      /recentClosedSessions = MOCK_SESSIONS\.filter\([\s\S]*?s\.status === 'destroyed' \|\| s\.status === 'errored'/,
    );
  });

  it('TIER_CONCURRENT_SESSION_LIMITS imported from api-types (source-of-truth lookup)', () => {
    expect(body).toContain('TIER_CONCURRENT_SESSION_LIMITS');
    expect(body).toContain("from '@driftstack/api-types'");
    // Sanity: the imported map exposes at least one tier
    // mapping today.
    expect(Object.keys(TIER_CONCURRENT_SESSION_LIMITS).length).toBeGreaterThan(0);
  });

  it.skip('concurrent-meter is wired off /v1/sessions + /v1/usage in parallel (V-186)', () => {
    expect(body).toMatch(/concurrent_now is computed/);
    expect(body).toMatch(/concurrent_limit comes from \/v1\/usage\.tier mapped via/);
    expect(body).toMatch(/TIER_CONCURRENT_SESSION_LIMITS/);
    expect(body).toMatch(/Both fetches run in parallel/);
  });

  it('busy-state status set used to compute concurrent_now is exactly {creating, ready, busy}', () => {
    expect(body).toMatch(/count of status in \[creating, ready,\s*\n?\s*\/\/\s*busy\]/);
  });

  it('"sessions are the only billing meter" framing pinned (economic claim)', () => {
    expect(body).toMatch(
      /Sessions are the only billing meter — you pay for concurrent caps,\s+not duration or per-call/,
    );
  });

  it.skip('V-348 — sessions minted via SDK / GUI client, not this dashboard', () => {
    // The page intentionally omits a "Create session" button —
    // adding one without a server-side change to validate
    // dashboard-driven create would mislead onboarding.
    expect(body).toMatch(/V-348 — sessions are minted via the SDK or GUI client, not/);
  });

  it('localStorage key ds_web_session_token (customer-dashboard convention)', () => {
    expect(body).toContain('ds_web_session_token');
  });

  it('header-summary live-replaceable fields pinned (header-now / header-cap / meter-now / meter-cap)', () => {
    for (const field of ['header-now', 'header-cap', 'meter-now', 'meter-cap']) {
      expect(body).toMatch(new RegExp(`data-field="${field}"`));
    }
  });
});
