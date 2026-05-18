// W780 — apps/docs guides/index.astro content parity. One-hundred-
// sixth in the cross-SDK drift-guard series. Opens the apps/docs/
// guides/ subtree sweep.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/guides/index.astro');

describe('W780 docs /guides index content parity', () => {
  it('guides/index.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it("CRITICAL 'concept-first writing' framing pinned. The 'Onboarding tutorials, common workflows, integration patterns. Concept-first writing for the parts of Driftstack that aren\\'t obvious from a single endpoint reading' wording is the load-bearing guide-vs-reference scope-discrimination.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Onboarding tutorials, common workflows, integration patterns\. Concept-first writing for/,
    );
    expect(p).toMatch(
      /the parts of Driftstack that aren't obvious from a single endpoint reading\./,
    );
  });

  it('CRITICAL 4-concept-guide TOC pinned — profile-management + session-lifecycle + team-rbac + live-video. Drift would lose a canonical workflow guide from the surface.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/<a href="\/guides\/profile-management\/">Profile management<\/a>/);
    expect(p).toMatch(/<a href="\/guides\/session-lifecycle\/">Session lifecycle<\/a>/);
    expect(p).toMatch(/<a href="\/guides\/team-rbac\/">Team RBAC — invite, accept, act-as<\/a>/);
    expect(p).toMatch(/<a href="\/guides\/live-video\/">Live video for agent sessions<\/a>/);
  });

  it('CRITICAL live-video framing pinned. The "subscribe to a running agent session\'s video stream over LiveKit WebRTC; covers token mint, connect, render, input forwarding, and reconnect" wording threads the LK arc cross-references.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /subscribe to a\s*\n\s+running agent session's video stream over LiveKit WebRTC; covers token mint,\s*\n\s+connect, render, input forwarding, and reconnect\./,
    );
  });

  it("CRITICAL team-rbac framing pinned. The 'end-to-end tutorial for setting up a multi-user team; invite + accept + X-Driftstack-Account header + audit-log review' wording threads the W757 + W766 + W768 cross-references.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /end-to-end\s*\n\s+tutorial for setting up a multi-user team; invite \+ accept \+ X-Driftstack-Account\s*\n\s+header \+ audit-log review\./,
    );
  });

  it('CRITICAL Get-started 3-link set pinned — /quickstart/ + /sdk/installation/ + /license-activation/. The license-activation link surfaces the GUI-desktop-client activation flow (V-266+V-267).', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /<a href="\/quickstart\/">Quickstart<\/a> — signup to first session in five minutes\./,
    );
    expect(p).toMatch(
      /<a href="\/sdk\/installation\/">SDK installation<\/a> — install \+ configure each SDK\./,
    );
    expect(p).toMatch(
      /<a href="\/license-activation\/">License activation<\/a> — activate the desktop GUI client\./,
    );
  });

  it('CRITICAL Architecture + reference 3-link set pinned — /api/versioning/ + /webhooks/events/ + /sdk/versioning/. Matches W772 + W777 versioning cross-page nav.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/<a href="\/api\/versioning\/">API versioning policy<\/a>/);
    expect(p).toMatch(/<a href="\/webhooks\/events\/">Webhook events catalog<\/a>/);
    expect(p).toMatch(/<a href="\/sdk\/versioning\/">SDK versioning policy<\/a>/);
  });

  it('CRITICAL pre-launch in-repo links pinned — github.com/driftstackdev/driftstack-api/tree/main/docs/architecture + team-roles-taxonomy.md. Drift to a different repo path would 404.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /href="https:\/\/github\.com\/driftstackdev\/driftstack-api\/tree\/main\/docs\/architecture"/,
    );
    expect(p).toMatch(
      /href="https:\/\/github\.com\/driftstackdev\/driftstack-api\/blob\/main\/docs\/architecture\/team-roles-taxonomy\.md"/,
    );
  });

  it('CRITICAL team-roles-taxonomy 4-role enum pinned in TOC description — owner/admin/member/viewer. Drift to dropping any role would mismatch V-326e team-RBAC catalog (even though docs surface uses 4-role taxonomy where W757 server uses 2: member+admin).', () => {
    const p = read(PAGE);

    expect(p).toMatch(/owner \/ admin \/ member \/ viewer/);
  });

  it("CRITICAL support email + 'prioritized' framing pinned. The 'Email support@driftstack.dev if you need a specific guide prioritized' wording is the canonical content-request channel.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/<a href="mailto:support@driftstack\.dev">support@driftstack\.dev<\/a>/);
    expect(p).toMatch(/if you need a\s*\n\s+specific guide prioritized\./);
  });

  it('CRITICAL DocLayout used with title="Guides".', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import DocLayout from '\.\.\/\.\.\/layouts\/DocLayout\.astro'/);
    expect(p).toMatch(/<DocLayout title="Guides">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/docs-pages-guides-index-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
