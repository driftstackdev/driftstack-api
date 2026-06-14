// W486.A — drift guard for apps/gui-client/src/App.tsx.
// App shell — outer chrome + state-based view routing + V-244
// first-run gate + V-263 Cmd+, shortcut + V-318 tier/cap footer.
// Drift here either breaks the V-263 hook-order invariant (Cmd+,
// effect must live above the conditional early-return — see the
// black-screen incident pinned in the source comment) or drops the
// V-244 first-run gate logic (apiKey === null + !wizardDismissed
// → wizard) so customers without creds land on the empty shell.
//
//   • Framing pinned: 'App shell — outer chrome + view routing.' +
//     'GUI1 landed the static shell; GUI2 wires the SettingsProvider
//     and adds two real views (Sessions, Settings). The routing
//     model is state-based, not URL-based — no need for react-router
//     in a single-window desktop app, and Tauri's window doesn't
//     have a real history stack to integrate with.'
//   • View 10-variant union (sessions / live-session{sessionId} /
//     sessions-history / profiles / recordings / recording-player
//     {recordingId} / proxies / connectivity / fleet / settings).
//   • SettingsProvider → RecordingsProvider → Shell nesting.
//   • V-263 hook-order framing pinned + Cmd+, handler.
//   • V-244 first-run gate: apiKey === null && !wizardDismissed.
//   • V-318 atCap = concurrent_session_active >= concurrent_session_cap.
//   • V-240 deploymentLabel: driftstack.dev / *.driftstack.dev →
//     'cloud' else 'self-hosted'; malformed URL → 'self-hosted'
//     (safer assumption).
//   • redactBaseUrl strips https?:// prefix.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/App.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W486.A apps/gui-client/src/App.tsx content parity', () => {
  const body = read(LIB);

  it("Framing pinned: 'App shell — outer chrome + view routing.' + 'GUI1 landed the static shell; GUI2 wires the SettingsProvider and adds two real views (Sessions, Settings). The routing model is state-based, not URL-based — no need for react-router in a single-window desktop app, and Tauri's window doesn't have a real history stack to integrate with.'", () => {
    expect(body).toMatch(/\/\/ App shell — outer chrome \+ view routing\./);
    expect(body).toMatch(
      /\/\/ GUI1 landed the static shell; GUI2 wires the SettingsProvider and\s*\n?\s*\/\/ adds two real views \(Sessions, Settings\)\. The routing model is\s*\n?\s*\/\/ state-based, not URL-based — no need for react-router in a\s*\n?\s*\/\/ single-window desktop app, and Tauri's window doesn't have a real\s*\n?\s*\/\/ history stack to integrate with\./,
    );
  });

  it("View 13-variant union: ai / recipes / logs / sessions / live-session{sessionId} / sessions-history / profiles / recordings / recording-player{recordingId} / proxies / connectivity / fleet / settings — pinned so the kind-tag taxonomy doesn't drift (e.g. a removed variant + a switch fall-through silently routes to the wrong view). 'ai' added by S7; 'recipes'/'logs' by the P3 feature-views slice.", () => {
    expect(body).toMatch(
      /type View =\s*\n?\s*\| \{ kind: 'ai' \}\s*\n?\s*\| \{ kind: 'recipes' \}\s*\n?\s*\| \{ kind: 'logs' \}\s*\n?\s*\| \{ kind: 'sessions' \}\s*\n?\s*\| \{ kind: 'live-session'; sessionId: string \}\s*\n?\s*\| \{ kind: 'sessions-history' \}\s*\n?\s*\| \{ kind: 'profiles' \}\s*\n?\s*\| \{ kind: 'recordings' \}\s*\n?\s*\| \{ kind: 'recording-player'; recordingId: string \}\s*\n?\s*\| \{ kind: 'proxies' \}\s*\n?\s*\| \{ kind: 'connectivity' \}\s*\n?\s*\| \{ kind: 'fleet' \}\s*\n?\s*\| \{ kind: 'settings' \};/,
    );
  });

  it('Provider nesting: SettingsProvider → RecordingsProvider → Shell — pinned so RecordingsProvider stays inside SettingsProvider (RecordingsProvider depends on the client from SettingsContext; flipping the order breaks recording persistence)', () => {
    expect(body).toMatch(
      /<SettingsProvider>\s*\n?\s*<RecordingsProvider>\s*\n?\s*<Shell \/>\s*\n?\s*<\/RecordingsProvider>\s*\n?\s*<\/SettingsProvider>/,
    );
  });

  it("V-263 hook-order framing pinned: 'Cmd+, shortcut. MUST live above any conditional returns below; React hooks order is positional, so registering the effect after an early-return pulls the hooks count out of sync between the wizard render (early return) and the post-wizard render (full shell), which unmounts the entire tree and shows a black screen.' — pinned so the useEffect placement above the loading + wizard early-returns doesn't get reordered (the black-screen incident framing must survive)", () => {
    expect(body).toMatch(
      /\/\/ V-263 — Cmd\+, shortcut\. MUST live above any conditional returns\s*\n?\s*\/\/ below; React hooks order is positional, so registering the effect\s*\n?\s*\/\/ after an early-return pulls the hooks count out of sync between\s*\n?\s*\/\/ the wizard render \(early return\) and the post-wizard render \(full\s*\n?\s*\/\/ shell\), which unmounts the entire tree and shows a black screen\./,
    );
    expect(body).toMatch(
      // 2026-05-20 7291ee25 — Cmd+Shift+L sign-out shortcut added alongside
      // the existing Cmd+, settings shortcut; the early-return after
      // setView() became load-bearing so the next handler check doesn't
      // also fire. Pin the explicit return.
      /if \(e\.metaKey && e\.key === ','\) \{\s*\n?\s*e\.preventDefault\(\);\s*\n?\s*setView\(\{ kind: 'settings' \}\);\s*\n?\s*return;\s*\n?\s*\}/,
    );
  });

  it('V-244 first-run gate: settings.apiKey === null && !wizardDismissed → FirstRunWizard with onComplete that flips wizardDismissed — pinned so customers without creds land on the wizard (not the empty shell) and the wizard-skip path still gives them the regular shell + Settings access', () => {
    expect(body).toMatch(
      /\/\/ V-244 — first-run gate\. No apiKey \+ not dismissed → wizard\.\s*\n?\s*if \(settings\.apiKey === null && !wizardDismissed\) \{\s*\n?\s*return <FirstRunWizard onComplete=\{\(\) => setWizardDismissed\(true\)\} \/>;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ V-244 — track wizard state\. Customer with no apiKey on boot\s*\n?\s*\/\/ sees the wizard; once apiKey is set \(via wizard or any other\s*\n?\s*\/\/ path\) the regular shell takes over\. `wizardDismissed` lets the\s*\n?\s*\/\/ customer skip the wizard mid-flow without leaving them stuck on\s*\n?\s*\/\/ it forever; once true, they get the normal shell \+ can still\s*\n?\s*\/\/ configure via Settings\./,
    );
  });

  it("V-240 deploymentLabel hostname match: 'driftstack.dev' or endsWith '.driftstack.dev' → 'cloud' else 'self-hosted'; malformed URL try/catch → 'self-hosted' fallback (safer assumption since cloud customers wouldn't typo their base URL) — pinned so the titlebar mode indicator stays consistent with the V-244 wizard's cloud/self-hosted radio", () => {
    expect(body).toMatch(
      /function deploymentLabel\(baseUrl: string\): 'cloud' \| 'self-hosted' \{\s*\n?\s*try \{\s*\n?\s*const host = new URL\(baseUrl\)\.hostname;\s*\n?\s*if \(host === 'driftstack\.dev' \|\| host\.endsWith\('\.driftstack\.dev'\)\) \{\s*\n?\s*return 'cloud';\s*\n?\s*\}\s*\n?\s*return 'self-hosted';\s*\n?\s*\} catch \{/,
    );
    expect(body).toMatch(
      /\/\/ Malformed URL — default to self-hosted \(the safer assumption\s*\n?\s*\/\/ since cloud customers wouldn't typo their base URL\)\./,
    );
  });

  it("V-318 StatusFooter framing pinned: 'surface tier + concurrent usage in the footer so the customer sees starter · 2 / 4 sessions at-a-glance, matching the file-127 enforcement-aware UX intent. accountMe comes from the SettingsContext (V-239 pre-fetch); when it's null we fall back to the prior connection-only chrome rather than blocking.' + atCap calc — pinned so the cap visibility stays present on every screen, not just SessionsView", () => {
    expect(body).toMatch(
      /\/\/ V-318 — surface tier \+ concurrent usage in the footer so the\s*\n?\s*\/\/ customer sees "starter · 2 \/ 4 sessions" at-a-glance, matching the\s*\n?\s*\/\/ file-127 enforcement-aware UX intent\. accountMe comes from the\s*\n?\s*\/\/ SettingsContext \(V-239 pre-fetch\); when it's null we fall back to\s*\n?\s*\/\/ the prior connection-only chrome rather than blocking\./,
    );
    expect(body).toMatch(
      /const atCap =\s*\n?\s*accountMe !== null && accountMe\.concurrent_session_active >= accountMe\.concurrent_session_cap;/,
    );
    // 2026-05-21 Slice E — same shape for profile cap so the footer
    // mirrors the Sidebar's per-item count badges on every view.
    expect(body).toMatch(
      /const atProfileCap =\s*\n?\s*accountMe !== null &&\s*\n?\s*accountMe\.profile_cap !== null &&\s*\n?\s*accountMe\.profile_count >= accountMe\.profile_cap;/,
    );
  });

  it('API-key masking in footer: slice(0,8) + … + slice(-4) — pinned so the full secret never lands in the chrome (visible while screen-sharing / screenshotting); redactBaseUrl strips https?:// prefix so the URL bar shows host+path only', () => {
    expect(body).toMatch(/\{settings\.apiKey\.slice\(0, 8\)\}…\{settings\.apiKey\.slice\(-4\)\}/);
    expect(body).toMatch(
      /function redactBaseUrl\(url: string\): string \{\s*\n?\s*return url\.replace\(\/\^https\?:\\\/\\\/\/, ''\);\s*\n?\s*\}/,
    );
  });

  it('Sidebar mount pinned: imports { Sidebar, type SidebarViewKind } and renders <Sidebar current=… /> in the shell — the 4-section taxonomy itself moved to apps/gui-client/src/components/Sidebar.tsx (covered by W486.S parity), so App.tsx now only proves the mount wires up correctly + the kind cast bridges the View discriminated union', () => {
    expect(body).toMatch(
      /import \{ Sidebar, type SidebarViewKind \} from '\.\/components\/Sidebar';/,
    );
    expect(body).toMatch(/<Sidebar\s*\n?\s*current=\{view\.kind as SidebarViewKind\}/);
  });

  it("loading branch: while settings load, render nothing rather than flashing the wizard — pinned so customers don't see a flash-of-wizard before settings hydrate (which would happen if apiKey===null is evaluated against the pre-hydration default state); Loading… section-label rendered in a centered surface-base wrapper", () => {
    expect(body).toMatch(
      /\/\/ While settings load, render nothing rather than flashing the wizard\.\s*\n?\s*if \(loading\) \{/,
    );
    expect(body).toMatch(/<span className="section-label text-ink-muted">Loading…<\/span>/);
  });

  it("CurrentView switch covers all 10 View variants — pinned so a removed View variant + a missing case doesn't fall through to an exhaustiveness error (and so adding a new variant to the View union forces matching the new case here)", () => {
    expect(body).toMatch(/case 'sessions':/);
    expect(body).toMatch(/case 'live-session':/);
    expect(body).toMatch(/case 'sessions-history':/);
    expect(body).toMatch(/case 'profiles':/);
    expect(body).toMatch(/case 'recordings':/);
    expect(body).toMatch(/case 'recording-player':/);
    expect(body).toMatch(/case 'proxies':/);
    expect(body).toMatch(/case 'connectivity':/);
    expect(body).toMatch(/case 'fleet':/);
    expect(body).toMatch(/case 'settings':/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
