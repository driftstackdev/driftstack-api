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

  it("REFRESH_MS = 15_000 module constant pinned (2026-05-20 d15460c7 — bumped 5s→15s after customer feedback that 'the page keeps refreshing'; background ticks no longer flip the visible loading state either) — pinned so the auto-poll cadence isn't reverted to a hard-coded inline literal that drifts apart from the footer 'auto-refresh every Ns' display", () => {
    expect(body).toMatch(/const REFRESH_MS = 15_000;/);
  });

  it("V-239 + V-073 cap-gate framing pinned: 'gate the New session button when the customer is at the concurrent cap. Server enforces (V-073 returns 402); the GUI's job is to surface the cap proactively so the customer never sees the 402 in normal flow. accountMe === null (not loaded) → don't gate.'", () => {
    expect(body).toMatch(
      /\/\/ V-239 — gate the New session button when the customer is at the\s*\n?\s*\/\/ concurrent cap\. Server enforces \(V-073 returns 402\); the GUI's job\s*\n?\s*\/\/ is to surface the cap proactively so the customer never sees the\s*\n?\s*\/\/ 402 in normal flow\. accountMe === null \(not loaded\) → don't gate\./,
    );
  });

  it("atConcurrentCap = concurrentCap !== null && concurrentActive !== null && concurrentActive >= concurrentCap — pinned so a null (unloaded accountMe) doesn't accidentally gate the button (false positive that disables Spawn for legitimate accounts)", () => {
    // 2026-06-30 — #5/#13 (2nd proactive audit) folds the active AGENT-session count
    // into concurrentActive (the server's concurrent_session_active counts only the
    // driver-table sessions; a launched profile session has none), so a launched
    // profile session shows up in this same cap math instead of being invisible.
    // concurrentActive's null-safety is preserved: still null whenever accountMe (or
    // its concurrent_session_active) hasn't loaded — the load-bearing invariant this
    // test protects — only the SOURCE of the non-null value changed.
    expect(body).toMatch(
      /const concurrentCap = accountMe\?\.concurrent_session_cap \?\? null;\s*\n?\s*const concurrentActive =\s*\n?\s*accountMe\?\.concurrent_session_active !== undefined\s*\n?\s*\? accountMe\.concurrent_session_active \+ activeAgentCount\s*\n?\s*: null;\s*\n?\s*const atConcurrentCap =\s*\n?\s*concurrentCap !== null && concurrentActive !== null && concurrentActive >= concurrentCap;/,
    );
  });

  it("Auto-poll lifecycle: useEffect first-fetch with showLoading=true + setInterval background refresh(false) at REFRESH_MS + cleanup clearInterval — pinned so poll stops on unmount and doesn't chew API quota in background; 2026-05-20 d15460c7 — refresh accepts a showLoading param so the loading hint only flashes on the initial fetch, not every 15s background tick (customer reported 'the page keeps refreshing')", () => {
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*\n?\s*void refresh\(true\);[\s\S]*?const id = window\.setInterval\(\(\) => \{[\s\S]*?void refresh\(false\);\s*\n?\s*\}, REFRESH_MS\);\s*\n?\s*return \(\) => window\.clearInterval\(id\);\s*\n?\s*\}, \[refresh\]\);/,
    );
  });

  it('handleCreate + handleDestroy both call refreshAccountMe() after successful operation — pinned so the cap counter unlocks Spawn button on destroy and flips disabled on create (V-239 invariant); 2026-05-20 d15460c7 — refresh(false) avoids the loading-flicker on the post-op refresh + handleCreate auto-attaches the first saved proxy as a SOCKS5 envelope (customer reported "2 proxies set, still get proxy-required error")', () => {
    expect(body).toMatch(/await client\.sessions\.create\(/);
    expect(body).toMatch(/await refresh\(false\);\s*\n?\s*await refreshAccountMe\(\);/);
    expect(body).toMatch(/await client\.sessions\.destroy\(id\);/);
  });

  it('quick-create, driver stop, and agent stop share a synchronous pre-await mutation gate', () => {
    expect(body).toContain('const mutationInFlightRef = useRef(false);');
    expect(body.match(/if \(!client \|\| mutationInFlightRef\.current\) return;/g)).toHaveLength(3);
    expect(body.match(/mutationInFlightRef\.current = true;/g)).toHaveLength(3);
    expect(body.match(/mutationInFlightRef\.current = false;/g)).toHaveLength(3);
    expect(body).toMatch(
      /async function handleDestroy[\s\S]*?mutationInFlightRef\.current = true;[\s\S]*?await confirm\(/,
    );
    expect(body).toMatch(
      /async function handleCloseAgent[\s\S]*?mutationInFlightRef\.current = true;[\s\S]*?await confirm\(/,
    );
  });

  it("New session button: disabled + aria-disabled both gated on busyId === '__create__' || atConcurrentCap; title tooltip for cap surface: 'Concurrent session cap reached ({cap} for {tier}). Destroy a session or upgrade to spawn more.' fallback when atConcurrentCap, undefined otherwise (so screen readers + hover both surface the explanation) — 2026-06-24 GUI restyle: the tooltip string was hoisted into a `capTitle` const (shared verbatim by the hero button + the empty-state's create button so the cap surface is identical wherever New session appears); pin BOTH the const's exact gating/copy AND that the button still wires disabled + aria-disabled + title={capTitle}", () => {
    // The cap tooltip + its cap/tier interpolation, hoisted into a shared const
    // so the hero + empty-state create buttons surface an identical explanation.
    expect(body).toMatch(
      /const capTitle = atConcurrentCap\s*\n?\s*\? `Concurrent session cap reached \(\$\{\(concurrentCap \?\? 0\)\.toString\(\)\} for \$\{\s*\n?\s*accountMe\?\.tier \?\? 'this tier'\s*\n?\s*\}\)\. Destroy a session or upgrade to spawn more\.`\s*\n?\s*: undefined;/,
    );
    // The hero's New session button still gates disabled + aria-disabled on the
    // busy/cap predicate and surfaces the cap tooltip via the shared const.
    expect(body).toMatch(
      /disabled=\{busyId === '__create__' \|\| atConcurrentCap\}\s*\n?\s*aria-disabled=\{busyId === '__create__' \|\| atConcurrentCap\}\s*\n?\s*title=\{capTitle\}/,
    );
  });

  it("EmptyConnect subcomponent: 'Not connected' section-label + 'Add an API key to connect to <mono>{baseUrl}</mono>.' + 'Open settings' button + '⌘ ,' keyboard hint — pinned so unauthenticated customer sees a clear path; 2026-06-24 GUI restyle: the section-label is now accent-tinted (section-label text-accent) and the copy moved into a hero-style raised card so the <p> is centered (mx-auto max-w-md) — copy + Open-settings/⌘, path unchanged", () => {
    expect(body).toMatch(/<span className="section-label text-accent">Not connected<\/span>/);
    expect(body).toMatch(
      /<p className="mx-auto max-w-md text-sm text-ink-secondary">\s*\n?\s*Add an API key to connect to <span className="mono">\{baseUrl\}<\/span>\./,
    );
    expect(body).toMatch(/or press <span className="mono">⌘ ,<\/span>/);
  });

  it("EmptyList no-sessions branch framing pinned: 'A session is one running iPhone Safari instance. Click New session above to spin one up — sessions show up here with a live status while they run.' + 'Each one uses a concurrent slot until you destroy it or it idle-times-out.' — pinned so customer understands what they're spawning + how it interacts with the cap; 2026-06-24 GUI restyle: the shared <EmptyState title/description> became a bespoke <SessionsEmptyState> raised card whose heading lives in an <h3>No active sessions yet</h3> (title prop gone) + whose create button carries the same cap-gating so the no-sessions screen still surfaces a (gated) New session affordance — same copy + intent", () => {
    // The heading copy now lives in the SessionsEmptyState card's <h3>.
    expect(body).toMatch(/<h3 className="[^"]*">\s*\n?\s*No active sessions yet\s*\n?\s*<\/h3>/);
    // The empty state is rendered for the no-sessions branch and its create
    // button stays cap-gated (busy/cap predicate) so a customer at the cap can't
    // click straight into a 402 from the empty screen.
    expect(body).toMatch(/<SessionsEmptyState/);
    expect(body).toMatch(
      /disabled=\{busyId === '__create__' \|\| atConcurrentCap\}\s*\n?\s*creating=\{busyId === '__create__'\}\s*\n?\s*title=\{capTitle\}/,
    );
    // \s+ between words: the copy is verbatim, but it now lives as wrapped JSX
    // text (not a one-line string prop) so word boundaries can fall on a newline
    // + indentation. Tolerating whitespace pins the exact copy without pinning
    // the source line-wrapping.
    expect(body).toMatch(
      /A\s+session\s+is\s+one\s+running\s+iPhone\s+Safari\s+instance\.\s+Click\s+New\s+session\s+above\s+to\s+spin\s+one\s+up\s+—\s+sessions\s+show\s+up\s+here\s+with\s+a\s+live\s+status\s+while\s+they\s+run\./,
    );
    expect(body).toMatch(
      /Each\s+one\s+uses\s+a\s+concurrent\s+slot\s+until\s+you\s+destroy\s+it\s+or\s+it\s+idle-times-out\./,
    );
  });

  it("StatusPill 4-tone: ready → status-ready / busy → status-busy / errored → status-error / else status-idle fallback (creating/destroyed map to idle dot) — pinned so the live-status colour vocabulary stays consistent across the cards; SessionCard has a single Stop button (disabled while that card is busy with a 'Stopping…' label) driven by the SessionCard `busy` prop — the in-app 'View' affordance was removed with the legacy live-session viewer (2026-06-26): live viewing is the floating Simulator window launched from Profiles, and the card no longer takes an onView prop", () => {
    expect(body).toMatch(
      /const dotColor =\s*\n?\s*status === 'ready'\s*\n?\s*\? 'bg-status-ready'\s*\n?\s*: status === 'busy'\s*\n?\s*\? 'bg-status-busy'\s*\n?\s*: status === 'errored'\s*\n?\s*\? 'bg-status-error'\s*\n?\s*: 'bg-status-idle';/,
    );
    // SessionCard wires per-session destroy gating through its `busy` prop
    // (busy === busyId === s.id at the call site).
    expect(body).toMatch(/busy=\{busyId === s\.id\}/);
    expect(body).toMatch(
      /onClick=\{onDestroy\}\s*\n?\s*disabled=\{busy\}\s*\n?\s*>\s*\n?\s*\{busy \? 'Stopping…' : 'Stop'\}/,
    );
    // The in-app View affordance + its onView prop are fully removed — no path
    // to the deleted live-session viewer remains.
    expect(body).not.toMatch(/onView/);
    expect(body).not.toMatch(/>\s*\n?\s*View\s*\n?\s*<\/button>/);
  });

  it('friendlyError preserves connection diagnostics and otherwise uses shared safe actionable copy', () => {
    expect(body).toMatch(
      /import \{ diagnosticFetchError \} from '\.\.\/lib\/diagnostic-fetch-error';/,
    );
    expect(body).toMatch(/import \{ humanizeError \} from '\.\.\/lib\/humanize-error';/);
    expect(body).toMatch(/function friendlyError\(err: unknown, baseUrl\?: string\): string/);
    expect(body).toMatch(
      /if \(baseUrl !== undefined\) \{\s*const diag = diagnosticFetchError\(err, baseUrl\);\s*if \(diag !== null\) return diag;\s*\}/,
    );
    expect(body).toMatch(
      /return humanizeError\(err, "Couldn't complete the session request\. Try again\."\);/,
    );
    const bypassMutation = body.replace('return humanizeError(err,', 'return String(err) || (');
    expect(bypassMutation).not.toMatch(/return humanizeError\(err,/);
  });

  it("Header session count: concurrentCap !== null && concurrentActive !== null → `${active} / ${cap}` cap-display else state.sessions.length (no cap data yet); the live-refresh footer 'Refreshed <mono>{formatTime(refreshedAt)}</mono> · auto-refresh {REFRESH_MS/1000}s' (with an auto-refresh-only fallback before the first refresh) — pinned so the displayed cadence stays in sync with the REFRESH_MS constant (Console restyle: 'Last refreshed' → 'Refreshed' + the live ping pill, 'auto-refresh every Ns' → 'auto-refresh Ns')", () => {
    expect(body).toMatch(
      /\{concurrentCap !== null && concurrentActive !== null\s*\n?\s*\? `\$\{concurrentActive\.toString\(\)\} \/ \$\{concurrentCap\.toString\(\)\}`\s*\n?\s*: state\.sessions\.length\.toString\(\)\}/,
    );
    expect(body).toMatch(
      /Refreshed <span className="mono">\{formatTime\(state\.refreshedAt\)\}<\/span> ·\s*\n?\s*auto-refresh \{REFRESH_MS \/ 1000\}s/,
    );
    // Cadence must still be driven by the constant, never a hard-coded
    // literal — the pre-first-refresh fallback also derives from REFRESH_MS.
    expect(body).toMatch(/<>auto-refresh \{REFRESH_MS \/ 1000\}s<\/>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
