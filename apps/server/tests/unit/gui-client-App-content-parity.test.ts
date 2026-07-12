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
//   • View union (sessions / sessions-history / profiles /
//     recordings / recording-player{recordingId} / proxies /
//     connectivity / fleet / settings).
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

  it("View 14-variant union: home / ai / recipes / sessions / sessions-history / profiles / recordings / recording-player{recordingId} / proxies / connectivity / fleet / team / billing / settings — pinned so the kind-tag taxonomy doesn't drift (e.g. a removed variant + a switch fall-through silently routes to the wrong view). 'ai' added by S7; 'recipes'/'logs' by the P3 feature-views slice; 'home' (Command Center) by the 5→10 G4 slice; 'team' by the Teams-management slice (2026-06-16); 'logs' removed when the client-buffer nav surface was retired (2026-06-19); 'billing' added when the customer billing/crypto-checkout cluster was wired into nav (revenue path, 2026-06-19); 'live-session' removed when the legacy in-app polling session viewer was retired — the floating Simulator window is the only live-session UI now (2026-06-26); the speculative profile Marketplace preview was removed before backend work (2026-07-12).", () => {
    expect(body).toMatch(
      /type View =\s*\n?\s*\| \{ kind: 'home' \}\s*\n?\s*\| \{ kind: 'ai'; profileId\?: string \}\s*\n?\s*\| \{ kind: 'recipes' \}\s*\n?\s*\| \{ kind: 'sessions' \}\s*\n?\s*\| \{ kind: 'sessions-history' \}\s*\n?\s*\| \{ kind: 'profiles'; profileId\?: string \}\s*\n?\s*\| \{ kind: 'recordings' \}\s*\n?\s*\| \{ kind: 'recording-player'; recordingId: string \}\s*\n?\s*\| \{ kind: 'proxies' \}\s*\n?\s*\| \{ kind: 'connectivity' \}\s*\n?\s*\| \{ kind: 'fleet' \}\s*\n?\s*\| \{ kind: 'team' \}\s*\n?\s*\| \{ kind: 'billing' \}\s*\n?\s*\| \{ kind: 'settings' \};/,
    );
    expect(body).not.toMatch(/marketplace/i);
    expect(body).not.toMatch(/\| \{ kind: 'logs' \}/);
    expect(body).not.toMatch(/case 'logs':/);
    expect(body).not.toMatch(/LogsView/);
    // The legacy in-app session viewer is fully removed — no view variant,
    // no render case, no import, no sidebar fold-in.
    expect(body).not.toMatch(/\| \{ kind: 'live-session'; sessionId: string \}/);
    expect(body).not.toMatch(/case 'live-session':/);
    expect(body).not.toMatch(/LiveSessionView/);
  });

  it('Provider nesting: SettingsProvider → RecordingsProvider → (ToastProvider →) Shell — pinned so RecordingsProvider stays inside SettingsProvider (RecordingsProvider depends on the client from SettingsContext; flipping the order breaks recording persistence)', () => {
    // 2026-06-30 — ToastProvider lifted to wrap Shell (the app-boot deep-link
    // handler surfaces a failure as a toast) — it nests INSIDE RecordingsProvider,
    // so the load-bearing invariant (RecordingsProvider stays inside
    // SettingsProvider, wraps all the way down to Shell) still holds; the regex
    // now tolerates that extra layer between RecordingsProvider and Shell.
    expect(body).toMatch(
      /<SettingsProvider>\s*\n?\s*<RecordingsProvider>\s*\n?[\s\S]{0,400}?<Shell \/>\s*\n?[\s\S]{0,200}?<\/RecordingsProvider>\s*\n?\s*<\/SettingsProvider>/,
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
    // round-3 — the gate now also stays mounted while the wizard is mid-flow
    // (`wizardActive` latched true). Without that latch, the wizard's own
    // BEFORE-the-First-profile-step key save flipped `apiKey === null` false
    // and unmounted the wizard, so the "First profile" step the stepper
    // advertises was unreachable. Pin the latch + the onComplete that clears
    // BOTH flags so the fix can't silently regress.
    expect(body).toMatch(/\/\/ V-244 — first-run gate\. Show the wizard when there's no key/);
    expect(body).toMatch(
      /if \(\(settings\.apiKey === null \|\| wizardActive\) && !wizardDismissed\) \{\s*\n?\s*return \(\s*\n?\s*<FirstRunWizard\s*\n?\s*onComplete=\{\(\) => \{\s*\n?\s*setWizardActive\(false\);\s*\n?\s*setWizardDismissed\(true\);\s*\n?\s*\}\}\s*\n?\s*\/>\s*\n?\s*\);\s*\n?\s*\}/,
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

  it('the bottom status footer is REMOVED (founder 2026-06-16: redundant + overlapping — connection state lives in the TitleBar pill, the tier/session/profile caps live in the Sidebar). No StatusFooter component, no footer mount, no masked key / base URL in the chrome', () => {
    expect(body).not.toMatch(/function StatusFooter/);
    expect(body).not.toMatch(/<StatusFooter\s*\/>/);
    expect(body).not.toMatch(/settings\.apiKey\.slice\(0, 8\)/);
    expect(body).not.toMatch(/redactBaseUrl/);
  });

  it("Sidebar mount pinned: imports { Sidebar, type SidebarViewKind } and renders <Sidebar current={sidebarSectionFor(view)} /> in the shell — the 4-section taxonomy itself moved to apps/gui-client/src/components/Sidebar.tsx (covered by W486.S parity), so App.tsx now only proves the mount wires up correctly + the sidebarSectionFor() helper folds the DRILLED-IN sub-view ('recording-player'→'recordings') AND the item-less live-Sessions view ('sessions'→'sessions-history') onto their parent section so the nav stays lit (replacing the old `view.kind as SidebarViewKind` cast that matched nothing for those views); the 'live-session'→'sessions' fold was dropped with the in-app session viewer (2026-06-26)", () => {
    expect(body).toMatch(
      /import \{ Sidebar, type SidebarViewKind \} from '\.\/components\/Sidebar';/,
    );
    expect(body).toMatch(/<Sidebar\s*\n?\s*current=\{sidebarSectionFor\(view\)\}/);
    expect(body).toMatch(
      /export function sidebarSectionFor\(view: View\): SidebarViewKind \{\s*\n?\s*switch \(view\.kind\) \{\s*\n?\s*case 'recording-player':\s*\n?\s*return 'recordings';/,
    );
    // 'sessions' (the live SessionsView, which has no sidebar item of its own)
    // folds onto the Session-log item so the nav keeps an active highlight.
    expect(body).toMatch(/case 'sessions':\s*\n?\s*return 'sessions-history';/);
    expect(body).not.toMatch(/<Sidebar\s*\n?\s*current=\{view\.kind as SidebarViewKind\}/);
    expect(body).not.toMatch(/case 'live-session':\s*\n?\s*return 'sessions';/);
  });

  it("loading branch: while settings load, show a calm spinner rather than flashing the wizard — pinned so customers don't see a flash-of-wizard before settings hydrate (which would happen if apiKey===null is evaluated against the pre-hydration default state); Loading… section-label rendered in a centered surface-base wrapper", () => {
    expect(body).toMatch(
      /\/\/ While settings load, show a calm spinner[\s\S]{0,260}?if \(loading\) \{/,
    );
    expect(body).toMatch(/role="status"\s*\n?\s*aria-label="Loading"/);
    expect(body).toMatch(/<span className="section-label text-ink-muted">Loading…<\/span>/);
  });

  it("CurrentView switch covers all 14 View variants — pinned so a removed View variant + a missing case doesn't fall through to an exhaustiveness error (and so adding a new variant to the View union forces matching the new case here); 'live-session' removed with the in-app session viewer (2026-06-26), Marketplace removed before backend work (2026-07-12)", () => {
    expect(body).toMatch(/case 'home':/);
    expect(body).toMatch(/case 'ai':/);
    expect(body).toMatch(/case 'recipes':/);
    expect(body).toMatch(/case 'sessions':/);
    expect(body).not.toMatch(/case 'live-session':/);
    expect(body).not.toMatch(/case 'marketplace':/);
    expect(body).toMatch(/case 'sessions-history':/);
    expect(body).toMatch(/case 'profiles':/);
    expect(body).toMatch(/case 'recordings':/);
    expect(body).toMatch(/case 'recording-player':/);
    expect(body).toMatch(/case 'proxies':/);
    expect(body).toMatch(/case 'connectivity':/);
    expect(body).toMatch(/case 'fleet':/);
    expect(body).toMatch(/case 'team':/);
    expect(body).toMatch(/case 'billing':/);
    expect(body).toMatch(/case 'settings':/);
  });

  it("Billing route wired: BillingView imported, the 'billing' case returns <BillingView />, and the nav-billing command-palette action exists (revenue path — the customer crypto-checkout cluster was previously built but unreachable, 2026-06-19)", () => {
    expect(body).toMatch(/import \{ BillingView \} from '\.\/views\/BillingView';/);
    expect(body).toMatch(/case 'billing':\s*\n?\s*return <BillingView \/>;/);
    expect(body).toMatch(/id: 'nav-billing'/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
