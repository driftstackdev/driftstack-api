// W483.C — drift guard for apps/gui-client/src/views/SessionsView.tsx.
// Sessions view: list/create/destroy active sessions with V-239
// concurrent-cap gate. Drift here either drops the cap-gating
// proactive surface (customer sees a 402 from V-073 in normal
// flow instead of a disabled button + tooltip explaining the
// situation) or breaks the 5-second auto-poll cleanup (poll
// continues after unmount and chews API quota when the customer
// has navigated away).
//
//   • Framing pinned: 'Sessions view — list active sessions,
//     create new, destroy individual.' + 'Auto-refreshes every
//     5 seconds so the list reflects fleet state without
//     requiring the user to click. Stops polling when the view
//     unmounts. Failures surface inline rather than via toasts
//     so the founder can debug API issues without losing
//     context.'
//   • REFRESH_MS = 5000 module constant.
//   • V-239 + V-073 cap-gate framing pinned: 'gate the New
//     session button when the customer is at the concurrent
//     cap. Server enforces (V-073 returns 402); the GUI's job
//     is to surface the cap proactively so the customer never
//     sees the 402 in normal flow.'
//   • atConcurrentCap = cap !== null && active !== null &&
//     active >= cap.
//   • Polling: setInterval REFRESH_MS + cleanup
//     clearInterval.
//   • refreshAccountMe after create + destroy.
//   • !client → EmptyConnect with ⌘ , hint.
//   • StatusPill 4-tone (ready/busy/errored/idle fallback).
//   • friendlyError: DriftstackError | Error | 'unknown error'
//     fallback.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/SessionsView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W483.C apps/gui-client/src/views/SessionsView.tsx content parity', () => {
  const body = read(LIB);

  it("Framing pinned: 'Sessions view — list active sessions, create new, destroy individual.' + 'Auto-refreshes every 5 seconds so the list reflects fleet state without requiring the user to click. Stops polling when the view unmounts. Failures surface inline rather than via toasts so the founder can debug API issues without losing context.'", () => {
    expect(body).toMatch(
      /\/\/ Sessions view — list active sessions, create new, destroy individual\./,
    );
    expect(body).toMatch(
      /\/\/ Auto-refreshes every 5 seconds so the list reflects fleet state\s*\n?\s*\/\/ without requiring the user to click\. Stops polling when the view\s*\n?\s*\/\/ unmounts\. Failures surface inline rather than via toasts so the\s*\n?\s*\/\/ founder can debug API issues without losing context\./,
    );
  });

  it("REFRESH_MS = 5000 module constant pinned — pinned so the auto-poll cadence isn't reverted to a hard-coded inline literal that drifts apart from the footer 'auto-refresh every Ns' display", () => {
    expect(body).toMatch(/const REFRESH_MS = 5000;/);
  });

  it("V-239 + V-073 cap-gate framing pinned: 'gate the New session button when the customer is at the concurrent cap. Server enforces (V-073 returns 402); the GUI's job is to surface the cap proactively so the customer never sees the 402 in normal flow. accountMe === null (not loaded) → don't gate.'", () => {
    expect(body).toMatch(
      /\/\/ V-239 — gate the New session button when the customer is at the\s*\n?\s*\/\/ concurrent cap\. Server enforces \(V-073 returns 402\); the GUI's job\s*\n?\s*\/\/ is to surface the cap proactively so the customer never sees the\s*\n?\s*\/\/ 402 in normal flow\. accountMe === null \(not loaded\) → don't gate\./,
    );
  });

  it("atConcurrentCap = concurrentCap !== null && concurrentActive !== null && concurrentActive >= concurrentCap — pinned so a null (unloaded accountMe) doesn't accidentally gate the button (false positive that disables Spawn for legitimate accounts)", () => {
    expect(body).toMatch(
      /const concurrentCap = accountMe\?\.concurrent_session_cap \?\? null;\s*\n?\s*const concurrentActive = accountMe\?\.concurrent_session_active \?\? null;\s*\n?\s*const atConcurrentCap =\s*\n?\s*concurrentCap !== null && concurrentActive !== null && concurrentActive >= concurrentCap;/,
    );
  });

  it("Auto-poll lifecycle: useEffect initial fetch + setInterval REFRESH_MS + cleanup clearInterval — pinned so poll stops on unmount and doesn't chew API quota in background; refresh deps [client]", () => {
    expect(body).toMatch(
      /\/\/ Initial fetch \+ 5-second poll\.\s*\n?\s*useEffect\(\(\) => \{\s*\n?\s*void refresh\(\);\s*\n?\s*const id = window\.setInterval\(\(\) => void refresh\(\), REFRESH_MS\);\s*\n?\s*return \(\) => window\.clearInterval\(id\);\s*\n?\s*\}, \[refresh\]\);/,
    );
  });

  it('handleCreate + handleDestroy both call refreshAccountMe() after successful operation — pinned so the cap counter unlocks Spawn button on destroy and flips disabled on create (V-239 invariant)', () => {
    expect(body).toMatch(
      /await client\.sessions\.create\(\);\s*\n?\s*await refresh\(\);\s*\n?\s*\/\/ V-239 — refresh the cap counter after a successful spawn so\s*\n?\s*\/\/ the gate flips to disabled if this brought us to the cap\.\s*\n?\s*await refreshAccountMe\(\);/,
    );
    expect(body).toMatch(
      /await client\.sessions\.destroy\(id\);\s*\n?\s*await refresh\(\);\s*\n?\s*\/\/ V-239 — refresh after destroy so the cap counter unlocks the\s*\n?\s*\/\/ Spawn button when we drop below cap\.\s*\n?\s*await refreshAccountMe\(\);/,
    );
  });

  it("New session button: disabled + aria-disabled both gated on busyId === '__create__' || atConcurrentCap; title tooltip for cap surface: 'Concurrent session cap reached ({cap} for {tier}). Destroy a session or upgrade to spawn more.' fallback when atConcurrentCap, undefined otherwise (so screen readers + hover both surface the explanation)", () => {
    expect(body).toMatch(
      /disabled=\{busyId === '__create__' \|\| atConcurrentCap\}\s*\n?\s*aria-disabled=\{busyId === '__create__' \|\| atConcurrentCap\}\s*\n?\s*title=\{\s*\n?\s*atConcurrentCap\s*\n?\s*\? `Concurrent session cap reached \(\$\{\(concurrentCap \?\? 0\)\.toString\(\)\} for \$\{\s*\n?\s*accountMe\?\.tier \?\? 'this tier'\s*\n?\s*\}\)\. Destroy a session or upgrade to spawn more\.`\s*\n?\s*: undefined\s*\n?\s*\}/,
    );
  });

  it("EmptyConnect subcomponent: 'Not connected' section-label + 'Add an API key to connect to <mono>{baseUrl}</mono>.' + 'Open settings' button + '⌘ ,' keyboard hint — pinned so unauthenticated customer sees a clear path", () => {
    expect(body).toMatch(
      /<span className="section-label">Not connected<\/span>\s*\n?\s*<p className="max-w-md text-sm text-ink-secondary">\s*\n?\s*Add an API key to connect to <span className="mono">\{baseUrl\}<\/span>\./,
    );
    expect(body).toMatch(/or press <span className="mono">⌘ ,<\/span>/);
  });

  it("EmptyList no-sessions branch framing pinned: 'A session is one running iPhone Safari instance. Click <New session> above to spin one up — sessions show up here with a live status while they run.' + 'Each session uses one of your account's concurrent slots until you destroy it or it idle-times-out.' — pinned so customer understands what they're spawning + how it interacts with the cap", () => {
    expect(body).toMatch(
      /<h3 className="text-base font-medium text-ink-primary">No active sessions yet<\/h3>\s*\n?\s*<p className="max-w-md text-sm text-ink-secondary">\s*\n?\s*A session is one running iPhone Safari instance\. Click <strong>New session<\/strong> above\s*\n?\s*to spin one up — sessions show up here with a live status while they run\./,
    );
    expect(body).toMatch(
      /Each session uses one of your account's concurrent slots until you destroy it or it\s*\n?\s*idle-times-out\./,
    );
  });

  it('StatusPill 4-tone: ready → status-ready / busy → status-busy / errored → status-error / else status-idle fallback (creating/destroyed map to idle dot) — pinned so the live-status colour vocabulary stays consistent across the table; SessionsTable 6-col (ID/Status/Archetype/Label/Created/actions) with View + Destroy buttons (Destroy disabled when busyId===s.id)', () => {
    expect(body).toMatch(
      /const dotColor =\s*\n?\s*status === 'ready'\s*\n?\s*\? 'bg-status-ready'\s*\n?\s*: status === 'busy'\s*\n?\s*\? 'bg-status-busy'\s*\n?\s*: status === 'errored'\s*\n?\s*\? 'bg-status-error'\s*\n?\s*: 'bg-status-idle';/,
    );
    expect(body).toMatch(
      /disabled=\{busyId === s\.id\}\s*\n?\s*>\s*\n?\s*\{busyId === s\.id \? 'Destroying…' : 'Destroy'\}/,
    );
  });

  it("friendlyError: DriftstackError instanceof → .message / Error instanceof → .message / fallback 'unknown error' — pinned so client-thrown DriftstackErrors surface their server-friendly message and unrecognized throws don't render as '[object Object]'", () => {
    expect(body).toMatch(
      /function friendlyError\(err: unknown\): string \{\s*\n?\s*if \(err instanceof DriftstackError\) \{\s*\n?\s*return err\.message;\s*\n?\s*\}\s*\n?\s*if \(err instanceof Error\) \{\s*\n?\s*return err\.message;\s*\n?\s*\}\s*\n?\s*return 'unknown error';\s*\n?\s*\}/,
    );
  });

  it("Header session count: concurrentCap !== null && concurrentActive !== null → `${active} / ${cap}` cap-display else state.sessions.length (no cap data yet); footer 'Last refreshed <mono>{formatTime(refreshedAt)}</mono> · auto-refresh every {REFRESH_MS/1000}s' template literal — pinned so refresh cadence stays in sync with REFRESH_MS constant", () => {
    expect(body).toMatch(
      /\{concurrentCap !== null && concurrentActive !== null\s*\n?\s*\? `\$\{concurrentActive\.toString\(\)\} \/ \$\{concurrentCap\.toString\(\)\}`\s*\n?\s*: state\.sessions\.length\.toString\(\)\}/,
    );
    expect(body).toMatch(
      /Last refreshed <span className="mono">\{formatTime\(state\.refreshedAt\)\}<\/span> ·\s*\n?\s*auto-refresh every \{REFRESH_MS \/ 1000\}s/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
