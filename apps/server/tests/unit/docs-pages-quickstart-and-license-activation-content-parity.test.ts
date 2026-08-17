// W785 — apps/docs quickstart.md + license-activation.md content
// parity. One-hundred-eleventh in the cross-SDK drift-guard series.
// Pins the top-level onboarding entry-points.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const QS = resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart.md');
const LIC = resolve(REPO_ROOT, 'apps/docs/src/pages/license-activation.md');
const FIRST_RUN = resolve(REPO_ROOT, 'apps/gui-client/src/views/FirstRunWizard.tsx');
const SETTINGS_VIEW = resolve(REPO_ROOT, 'apps/gui-client/src/views/SettingsView.tsx');
const UPDATER = resolve(REPO_ROOT, 'apps/gui-client/src/lib/updater.ts');

describe('W785 docs quickstart + license-activation content parity', () => {
  it('both files exist', () => {
    expect(existsSync(QS)).toBe(true);
    expect(existsSync(LIC)).toBe(true);
  });

  // ─── quickstart.md ────────────────────────────────────────────

  it('CRITICAL quickstart frontmatter title + description pinned.', () => {
    const p = read(QS);

    expect(p).toMatch(/^---\nlayout: \.\.\/layouts\/DocLayout\.astro\ntitle: Quickstart\n/);
    // S22.5 (2026-07-06) — plain-words-first description: names the
    // concrete thing (an iPhone Safari session) and matches the body's
    // "about five minutes"; the signup→first-session-in-~5-min +
    // 3-language facts all survive.
    expect(p).toMatch(
      /description: From signup to your first iPhone Safari session in about five minutes — working examples in TypeScript, Python, or Go\./,
    );
  });

  it('CRITICAL paid code quickstart 5-min framing pinned.', () => {
    const p = read(QS);

    expect(p).toMatch(
      /This guide takes you from a fresh signup to your first iPhone Safari session from code\. Allow about five minutes\./,
    );
  });

  it('CRITICAL quickstart prerequisites pin paid tier, ds_live customer key, and language floors.', () => {
    const p = read(QS);

    expect(p).toMatch(
      /A Driftstack account \(\[sign up\]\(https:\/\/app\.driftstack\.dev\/signup\/\) or \[sign in\]\(https:\/\/app\.driftstack\.dev\/login\/\)\)/,
    );
    expect(p).toMatch(
      /Open \[app\.driftstack\.dev\/api-keys\]\(https:\/\/app\.driftstack\.dev\/api-keys\/\)\./,
    );
    expect(p).not.toMatch(
      /\(https:\/\/(?:app\.driftstack\.dev\/(?:signup|login|api-keys)|driftstack\.dev\/pricing)\)/,
    );
    expect(p).toMatch(/Any paid Driftstack tier \(Manual, API, or Enterprise\)/);
    expect(p).toMatch(
      /A `ds_live_…` customer API key \(created in the dashboard under \*\*API keys\*\*\)/,
    );
    expect(p).toMatch(/Node\.js 18\+, Python 3\.10\+, or Go 1\.22\+/);
    // The stale Go 1.21+ floor must NOT return.
    expect(p).not.toMatch(/Go 1\.21\+/);
  });

  it('CRITICAL quickstart pins paid ds_live keys, restricted Free desktop credentials, downgrade 403 and upgrade recovery.', () => {
    const p = read(QS);

    expect(p).toMatch(/This code quickstart requires a paid tier with API access/);
    expect(p).toMatch(/`ds_live_` prefix on every paid tier, including Manual/);
    expect(p).toMatch(/Free does not mint\s*\n?customer API keys/);
    expect(p).toMatch(
      /restricted device credential\s*\n?the desktop app obtains and stores automatically/,
    );
    expect(p).toMatch(
      /They become usable again after an\s*\n?upgrade unless they were revoked or expired/,
    );
    expect(p).toMatch(/The "apiAccess" feature is not available on the "free" tier/);
    expect(p).not.toMatch(/same shape, test environment|feature_not_available/);
  });

  it('CRITICAL quickstart 3-language install commands pinned — npm/pip/go-get matching W778 SDK installation. Drift would let SDK adopters drift between install pages.', () => {
    const p = read(QS);

    expect(p).toMatch(/npm install @driftstack\/sdk/);
    expect(p).toMatch(/pip install driftstack-sdk/);
    expect(p).toMatch(/go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/);
  });

  it('CRITICAL quickstart 4-action TS workflow pinned — create + navigate + capture + destroy. Matches W761 /api/sessions + W779 quickstart triplet idiomatic flow.', () => {
    const p = read(QS);

    expect(p).toMatch(
      /const session = await client\.sessions\.create\(\{ label: 'quickstart' \}\);/,
    );
    expect(p).toMatch(
      /await client\.sessions\.navigate\(session\.id, \{ url: 'https:\/\/example\.com' \}\);/,
    );
    expect(p).toMatch(
      /const shot = await client\.sessions\.capture\(session\.id, \{ kind: 'screenshot' \}\);/,
    );
    expect(p).toMatch(/await client\.sessions\.destroy\(session\.id\);/);
  });

  it("CRITICAL quickstart 'What happened' 4-bullet annotated walkthrough pinned. The bullets explain what each method does — the concurrent slot/iPhone-Safari-on-real-iOS/screenshot/destroy-releases-slot framing matches W761 + W781 session-lifecycle.", () => {
    const p = read(QS);

    expect(p).toMatch(
      /`client\.sessions\.create\(\)` reserved one of your account's concurrent session slots\./,
    );
    expect(p).toMatch(
      /Each tier has a concurrent cap \(Free: 1, API Starter: 2, API Builder: 8, API Scale: 24 — see \[pricing\]\(https:\/\/driftstack\.dev\/pricing\/\)\)\. Exceeding the cap returns 429\./,
    );
    expect(p).toMatch(
      /`client\.sessions\.navigate\(\)` drove the iPhone Safari runtime to the URL on Driftstack's WebKit build\. The runtime is built from Apple's WebKit source directly — not a Chromium-stealth shim pretending to be Safari\./,
    );
    expect(p).not.toMatch(/The runtime is real Safari on real iOS/);
    expect(p).toMatch(
      /`client\.sessions\.capture\(\)` returned a `\{ kind, data, encoding, byte_size, duration_ms \}` object\./,
    );
    // W564 — capture-response shape + the base64-decode gotcha are spelled out.
    expect(p).toMatch(/`data` is the PNG \*\*base64-encoded\*\*/);
    expect(p).toMatch(/Buffer\.from\(shot\.data, 'base64'\)/);
    expect(p).toMatch(
      // S31 2026-07-07 (fable-truth-audit) — no idle timeout exists on any tier; only the
      // free-tier 20-minute duration cap auto-stops sessions.
      /`client\.sessions\.destroy\(\)` released the concurrent slot\. Only free-tier sessions stop on their own \(at the 20-minute cap\)/,
    );
  });

  it('CRITICAL quickstart Next-steps 4-link set pinned — profile-management + session-lifecycle + webhooks/events + api/versioning.', () => {
    const p = read(QS);

    expect(p).toMatch(/\*\*\[Profile management\]\(\/guides\/profile-management\/\)\*\*/);
    expect(p).toMatch(/\*\*\[Session lifecycle\]\(\/guides\/session-lifecycle\/\)\*\*/);
    expect(p).toMatch(/\*\*\[Webhook event catalog\]\(\/webhooks\/events\/\)\*\*/);
    expect(p).toMatch(/\*\*\[API versioning policy\]\(\/api\/versioning\/\)\*\*/);
  });

  it('CRITICAL quickstart support footer pinned. Matches W779 quickstart triplet shared contact framing.', () => {
    const p = read(QS);

    expect(p).toMatch(
      /Stuck\? Email \[support@driftstack\.dev\]\(mailto:support@driftstack\.dev\)\./,
    );
    expect(p).toMatch(
      /Include your account ID \(`acc_…`\) \+ the request ID from any error response \(returned in the `x-request-id` header\) so we can trace it\./,
    );
  });

  // ─── license-activation.md ────────────────────────────────────

  it('CRITICAL license-activation frontmatter title + description pinned.', () => {
    const p = read(LIC);

    expect(p).toMatch(
      /^---\nlayout: \.\.\/layouts\/DocLayout\.astro\ntitle: License activation \(GUI client\)\n/,
    );
    expect(p).toMatch(
      /description: Activate the Driftstack macOS desktop app through browser sign-in, with a paid customer key or self-hosted key as an explicit fallback\./,
    );
  });

  it('CRITICAL supported macOS desktop defaults to browser sign-in; Free has no customer-key paste; paid/self-hosted paste is fallback.', () => {
    const p = read(LIC);

    expect(p).toMatch(/client defaults to secure browser sign-in/);
    expect(p).toMatch(/app automatically stores its restricted device credential/);
    expect(p).toMatch(/Free users do not create or paste a customer API key/);
    expect(p).toMatch(
      /paid cloud customer\s*\n?key or a key minted by your self-hosted control plane remains available as an\s*\n?explicit fallback/,
    );
  });

  it('CRITICAL 5-step first-run wizard pinned — Welcome + Deployment mode + browser sign-in + First profile + Done.', () => {
    const p = read(LIC);
    const wizard = read(FIRST_RUN);

    expect(p).toMatch(/1\. \*\*Welcome\*\* — brand intro and a one-line value prop\./);
    expect(p).toMatch(/2\. \*\*Deployment mode\*\* — radio: \*\*Cloud\*\*/);
    expect(p).toMatch(/3\. \*\*Sign in\*\* — use \*\*Sign in with browser\*\* by default/);
    expect(p).toMatch(/\*\*Have an API key\? Paste it instead\*\* is the/);
    expect(p).toMatch(/4\. \*\*First profile\*\* \(skippable\)/);
    expect(p).toMatch(/5\. \*\*Done\*\*/);
    expect(wizard).toMatch(/>\s*Sign in with browser\s*<\/button>/);
  });

  it('CRITICAL browser/default and privacy-safe fallback validation states match the live wizard.', () => {
    const p = read(LIC);

    expect(p).toMatch(/✅ valid — wizard advances\./);
    expect(p).toMatch(/❌ wrong fallback key — the message is deployment-aware/);
    expect(p).toMatch(/Authentication failed \(401\)\. Double-check the key/);
    expect(p).toMatch(/cloud key will not\s*\n?\s*authenticate against a self-hosted server/);
    expect(p).toMatch(/❌ unreachable — the message starts with "Couldn't reach `<url>`\."/);
    expect(p).toMatch(/URL, connection, firewall, VPN, and self-hosted-server guidance/);
    expect(p).toMatch(/❌ not permitted — the privacy-safe fixed message is "You do not have/);
    expect(p).toMatch(/permission to perform this action\."/);
  });

  it('CRITICAL credentials-in-macOS-Keychain framing pinned.', () => {
    const p = read(LIC);

    expect(p).toMatch(
      /\*\*Device credential or fallback API key\*\* — stored in macOS Keychain through\s*\n?\s*`keyring-rs`\. It never lands in `settings\.json` on disk\./,
    );
    expect(p).toMatch(
      /\*\*Base URL\*\* — stored in the Tauri settings store \(`settings\.json`\)\. Plaintext is fine here; the URL alone confers no access\./,
    );
  });

  it('CRITICAL same-binary-cross-deployment framing pinned. The \'The same GUI binary works against any control plane — there is no "self-hosted edition" of the desktop app. The deployment-mode toggle is the only switch\' wording is the load-bearing distribution-model contract.', () => {
    const p = read(LIC);

    expect(p).toMatch(
      /The same GUI binary works against any control plane — there is no "self-hosted edition" of the desktop app\. The deployment-mode toggle is the only switch\./,
    );
  });

  it('CRITICAL current platform support and signing posture are explicit without future distribution promises. V-796 RETRACTED the signing claim: gui-release.yml carries no Apple credentials at all (no APPLE_*/CSC_* secrets, no notarytool, no codesign) and tauri.conf.json sets no signingIdentity, hardenedRuntime or notarize, so a customer was told distributed builds pass a verification chain that never runs. The updater signature IS real and separate, which is why the copy distinguishes them rather than saying builds are unsigned.', () => {
    const p = read(LIC);

    expect(p).toMatch(
      /\*\*macOS on Apple silicon\*\* is the current supported distribution target\./,
    );
    expect(p).toMatch(
      /Builds are \*\*not\*\* Apple Developer ID code-signed, hardened-runtime, or\s*\n?\s*notarised\./,
    );
    expect(p, 'the first-launch workaround must be actionable, not just a warning').toMatch(
      /right-click it in Applications, choose \*\*Open\*\*, and\s*\n?\s*confirm\./,
    );
    expect(p, 'updater signing is real and must stay distinguished from Apple signing').toMatch(
      /signed with our Tauri updater key/,
    );
    expect(p, 'the retracted verification chain must not return').not.toMatch(
      /must pass Developer ID signature/,
    );
    expect(p).toMatch(
      /The release pipeline also builds Windows \(`\.exe`, NSIS\) and Linux\s*\n?\s*\(`\.AppImage`, `\.deb`\) bundles, but macOS on Apple silicon is the only platform\s*\n?\s*we support\./,
    );
    // V-796 — the old line said the channel "does not publish Windows or Linux
    // installers", which read as though macOS IS published. The matrix in
    // gui-release.yml includes ubuntu-22.04 and windows-latest, and no gui-v* tag
    // exists at all, so the sentence was true only in the sense that nothing is
    // published anywhere. The replacement describes the mechanism instead.
    expect(p).not.toMatch(/does not publish Windows or Linux installers/);
    expect(p).not.toMatch(/pending|coming soon|once the first ones ship|page is not live yet/i);
  });

  it('CRITICAL updater checks once, waits for consent, then verifies, installs, and relaunches.', () => {
    const p = read(LIC);
    const updater = read(UPDATER);

    expect(p).toMatch(/Tauri Updater checks the signed GitHub Releases manifest once at startup/);
    expect(p).toMatch(/shows a non-blocking in-app banner/);
    expect(p).toMatch(/does not\s*\n?download anything until you choose \*\*Install\*\*/);
    expect(p).toMatch(/verifies its signature against the embedded public key/);
    expect(p).toMatch(/installs it,\s*\n?and relaunches the app/);
    expect(p).not.toMatch(/downloads \+ signature-verifies new versions in the background/);
    expect(updater).toMatch(/await offered\.downloadAndInstall\(/);
    expect(updater).toMatch(/await deps\.relaunch\(\)/);
  });

  it("CRITICAL 4-troubleshooting bullet set pinned — Authentication failed + Couldn't reach + Wizard re-fires + privacy-safe permission denial.", () => {
    const p = read(LIC);

    expect(p).toMatch(/\*\*"Authentication failed"\*\* — retry cloud browser sign-in first/);
    expect(p).toMatch(/a cloud key never works against your own server/);
    expect(p).toMatch(/Settings re-validates credentials and shows the same guidance/);
    expect(p).toMatch(/\*\*"Couldn't reach control plane"\*\* — for cloud, check/);
    expect(p).toMatch(
      /\*\*Wizard re-fires on every launch\*\* — macOS Keychain may be unavailable to the app/,
    );
    expect(p).toMatch(/\*\*"You do not have permission" on activation\*\*/);
    expect(p).toMatch(/check the account status and selected team/);
  });

  it('CRITICAL sign-out deletes only the scoped credential and immediately re-arms deployment selection.', () => {
    const p = read(LIC);
    const settingsView = read(SETTINGS_VIEW);

    expect(p).toMatch(/Removes the current deployment's\s*\n?\s*credential from Keychain/);
    expect(p).toMatch(/without revoking it on the server/);
    expect(p).toMatch(/base URL and other preferences remain in `settings\.json`/);
    expect(p).toMatch(/The first-run wizard reappears immediately/);
    expect(p).not.toMatch(/Wipes the keychain entry and `settings\.json` baseUrl/);
    expect(settingsView).toMatch(
      /await update\(\{\s*apiKey: null,\s*baseUrl: settings\.baseUrl,\s*telemetryOptIn: settings\.telemetryOptIn,/,
    );
  });

  it('CRITICAL self-hosted activation 3-step framing pinned. (1) Stand up control plane + (2) Create API key + (3) Wizard choose Self-hosted + paste URL. Matches the SH-runbook + W762 /api/api-keys + V-NNN cross-references.', () => {
    const p = read(LIC);

    expect(p).toMatch(/1\. Stand up the control plane on your own hardware with the/);
    expect(p).toMatch(
      /2\. Create an API key against your local control plane \(same `\/v1\/api-keys` flow — requires the `account_owner` scope\)\./,
    );
    expect(p).toMatch(
      /3\. In the GUI client wizard, choose \*\*Self-hosted\*\*, paste the URL of your control plane/,
    );
  });

  it('CRITICAL license-activation Next-steps 3-link set pinned — profile-management + session-lifecycle + quickstart.', () => {
    const p = read(LIC);

    expect(p).toMatch(/\*\*\[Profile management\]\(\/guides\/profile-management\/\)\*\*/);
    expect(p).toMatch(/\*\*\[Session lifecycle\]\(\/guides\/session-lifecycle\/\)\*\*/);
    expect(p).toMatch(/\*\*\[Quickstart\]\(\/quickstart\/\)\*\*/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/docs-pages-quickstart-and-license-activation-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
