// W609 — drift guard for apps/gui-client/src/components/SessionTabStrip.tsx.
// Browser-style tabs for the GUI live view: v1 tabs = the account's
// CONCURRENT SESSIONS (each tab its own iPhone), per the gui-browser-ux
// plan (true multi-page-per-session tabs are Phase-4 cross-agent).
// Drift here either breaks the tab data source (list poll), the
// active-tab-always-renders invariant, or quietly turns the strip into
// a per-app-run open-tabs list that hides dashboard/API-launched
// sessions.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/components/SessionTabStrip.tsx');

describe('W609 apps/gui-client/src/components/SessionTabStrip.tsx content parity', () => {
  const body = readFileSync(LIB, 'utf8');

  it("Framing pinned: v1 tabs = concurrent sessions ('Each tab is its own iPhone'), honest about what a session is + matches how the product scales — pinned so a refactor doesn't silently re-scope tabs to per-app-run state that hides dashboard/API-launched sessions", () => {
    expect(body).toMatch(/v1 tabs = the account's/);
    expect(body).toMatch(/CONCURRENT SESSIONS\. Each tab is its own iPhone/);
  });

  it('Data source: client.sessions.list() polled every LIST_POLL_INTERVAL_MS = 10_000 + immediate fetch on mount; destroyed sessions filtered out; list failures tolerated (strip is navigation sugar — keep last-known tabs); the poll is visibility-gated (skips a tick while the window is hidden, audit 2026-07-08)', () => {
    expect(body).toMatch(/const LIST_POLL_INTERVAL_MS = 10_000;/);
    expect(body).toMatch(/const page = await client\.sessions\.list\(\);/);
    expect(body).toMatch(/\.filter\(\(s\) => s\.status !== 'destroyed'\)/);
    // The interval body now skips the poll while the window is hidden, then
    // still calls refresh() at LIST_POLL_INTERVAL_MS; cleaned up on unmount.
    expect(body).toMatch(
      /const id = window\.setInterval\(\(\) => \{\s*\n?\s*if \(typeof document !== 'undefined' && document\.visibilityState === 'hidden'\) return;\s*\n?\s*void refresh\(\);\s*\n?\s*\}, LIST_POLL_INTERVAL_MS\);/,
    );
    expect(body).toMatch(/return \(\) => window\.clearInterval\(id\);/);
  });

  it("Active tab ALWAYS renders, even before the first list response — the strip must never look like 'no tabs' while inside a session. Errored sessions render with a status dot (still switchable)", () => {
    expect(body).toMatch(/known\.some\(\(s\) => s\.id === activeSessionId\)/);
    expect(body).toMatch(/\{ id: activeSessionId, status: 'ready', archetype: '' \}/);
    expect(body).toMatch(/s\.status === 'errored' && \(/);
  });

  it("tabLabel: device segment of the archetype slug + 4-char id tail (two same-archetype phones stay tellable-apart); a11y: nav aria-label='Open sessions', active tab aria-current='page', + button labelled 'New tab — launch another phone'", () => {
    expect(body).toMatch(
      /const device = s\.archetype\.split\('_'\)\[0\] \?\? s\.archetype;\s*\n?\s*return `\$\{device\} · \$\{s\.id\.slice\(-4\)\}`;/,
    );
    expect(body).toMatch(/aria-label="Open sessions"/);
    expect(body).toMatch(/aria-current=\{active \? 'page' : undefined\}/);
    expect(body).toMatch(/aria-label="New tab — launch another phone"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
