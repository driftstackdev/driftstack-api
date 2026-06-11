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

describe('W785 docs quickstart + license-activation content parity', () => {
  it('both files exist', () => {
    expect(existsSync(QS)).toBe(true);
    expect(existsSync(LIC)).toBe(true);
  });

  // ─── quickstart.md ────────────────────────────────────────────

  it('CRITICAL quickstart frontmatter title + description pinned.', () => {
    const p = read(QS);

    expect(p).toMatch(/^---\nlayout: \.\.\/layouts\/DocLayout\.astro\ntitle: Quickstart\n/);
    expect(p).toMatch(
      /description: Get from signup to your first Driftstack session in under five minutes — TypeScript, Python, or Go\./,
    );
  });

  it("CRITICAL quickstart 5-min framing pinned. The 'This guide takes you from a fresh signup to your first iPhone Safari session. Allow about five minutes' wording matches W775 SDK index quickstart promise.", () => {
    const p = read(QS);

    expect(p).toMatch(
      /This guide takes you from a fresh signup to your first iPhone Safari session\. Allow about five minutes\./,
    );
  });

  it('CRITICAL quickstart 3-prerequisite list pinned — Driftstack account + API key + Node 18+/Python 3.10+/Go 1.21+. Drift to a different toolchain floor would mismatch W779 quickstart triplet.', () => {
    const p = read(QS);

    expect(p).toMatch(
      /A Driftstack account \(\[sign up\]\(https:\/\/app\.driftstack\.dev\/signup\) or \[sign in\]\(https:\/\/app\.driftstack\.dev\/login\)\)/,
    );
    expect(p).toMatch(/An API key \(created in the dashboard under \*\*API keys\*\*\)/);
    expect(p).toMatch(/Node\.js 18\+, Python 3\.10\+, or Go 1\.21\+/);
  });

  it("CRITICAL quickstart ds_live_ key-prefix framing pinned. The 'API keys are scoped to the account that created them. The key prefix (ds_live_) tells you it\\'s a production key. Trial-pack and pre-billing accounts get the same key shape' wording matches W760 + W762 + W764 ds_live_/ds_test_ prefix contract.", () => {
    const p = read(QS);

    expect(p).toMatch(
      /API keys are scoped to the account that created them\. The key prefix \(`ds_live_`\) tells you it's a production key\./,
    );
    expect(p).toMatch(/Free and pre-billing accounts get the same key shape\./);
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
      /Each tier has a concurrent cap \(Free: 1, API Starter: 2, API Builder: 8, API Scale: 24 — see \[pricing\]\(https:\/\/driftstack\.dev\/pricing\)\)\. Exceeding the cap returns 429\./,
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
      /`client\.sessions\.destroy\(\)` released the concurrent slot\. Sessions also auto-expire after the per-tier idle timeout if you forget to destroy them\./,
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
      /description: Activate the Driftstack desktop GUI client by pasting your API key — works for both cloud and self-hosted deployments\./,
    );
  });

  it("CRITICAL Tauri 2.x desktop framing pinned. The 'The Driftstack desktop GUI client (Tauri 2.x — macOS, Windows, Linux) doesn\\'t use a separate license-key system. It activates against the same API key you use for SDK calls, and points at either the cloud control plane or your own self-hosted instance' wording matches W780 guides index license-activation cross-reference.", () => {
    const p = read(LIC);

    expect(p).toMatch(
      /The Driftstack desktop GUI client \(Tauri 2\.x — macOS, Windows, Linux\) doesn't use a separate license-key system\./,
    );
    expect(p).toMatch(
      /It activates against the same API key you use for SDK calls, and points at either the cloud control plane or your own self-hosted instance\./,
    );
  });

  it('CRITICAL 5-step first-run wizard pinned — Welcome + Deployment mode + API key + First profile + Done. Drift to dropping a step would break the onboarding sequence.', () => {
    const p = read(LIC);

    expect(p).toMatch(/1\. \*\*Welcome\*\* — brand intro and a one-line value prop\./);
    expect(p).toMatch(/2\. \*\*Deployment mode\*\* — radio: \*\*Cloud\*\*/);
    expect(p).toMatch(/3\. \*\*API key\*\* — paste the key/);
    expect(p).toMatch(/4\. \*\*First profile\*\* \(skippable\)/);
    expect(p).toMatch(/5\. \*\*Done\*\*/);
  });

  it('CRITICAL 4-validation-state framing pinned on API-key wizard step. valid / wrong-key / unreachable / tier-suspended. The wording maps to W764 /api/auth + V-323 wizard validation states.', () => {
    const p = read(LIC);

    expect(p).toMatch(/✅ valid — wizard advances\./);
    expect(p).toMatch(
      /❌ wrong key — "Authentication failed\. Check the value at app\.driftstack\.dev\/api-keys\."/,
    );
    expect(p).toMatch(
      /❌ unreachable — "Couldn't reach the control plane at `<url>`\. Check the URL and your network\."/,
    );
    expect(p).toMatch(
      /❌ tier-suspended — "This account is suspended\. Email support@driftstack\.dev\."/,
    );
  });

  it("CRITICAL credentials-in-OS-keychain framing pinned. The 'API key — stored in the OS keychain (keyring-rs): macOS Keychain, Windows Credential Manager, Linux Secret Service / kwallet. The key never lands in settings.json on disk' wording is the load-bearing security framing.", () => {
    const p = read(LIC);

    expect(p).toMatch(
      /\*\*API key\*\* — stored in the OS keychain \(`keyring-rs`\): macOS Keychain, Windows Credential Manager, Linux Secret Service \/ kwallet\. The key never lands in `settings\.json` on disk\./,
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

  it('CRITICAL 3-platform notes pinned — macOS Apple Developer ID + Windows EV cert + Linux unsigned AppImage/deb. Drift to claiming a different signing posture would mismatch security/trust expectations.', () => {
    const p = read(LIC);

    expect(p).toMatch(
      /\*\*macOS\*\* — primary build target\. Signed and notarised under the Apple Developer ID program/,
    );
    expect(p).toMatch(/\*\*Windows\*\* — EV cert \+ Tauri Updater pending pre-launch/);
    expect(p).toMatch(/Until cert lands, SmartScreen may flag the binary on first launch\./);
    expect(p).toMatch(
      /\*\*Linux\*\* — `\.AppImage` and `\.deb` artifacts unsigned; technical operators run them as-is\./,
    );
  });

  it("CRITICAL Tauri Updater + GitHub Releases framing pinned. The 'Tauri Updater + GitHub Releases ship updates automatically. The app polls the manifest URL on startup, downloads + signature-verifies new versions in the background, and prompts you on next launch' wording is the canonical update-protocol contract.", () => {
    const p = read(LIC);

    expect(p).toMatch(
      /Tauri Updater \+ GitHub Releases ship updates automatically\. The app polls the manifest URL on startup, downloads \+ signature-verifies new versions in the background, and prompts you on next launch\./,
    );
  });

  it("CRITICAL 4-troubleshooting bullet set pinned — Authentication failed + Couldn't reach + Wizard re-fires + Tier-suspended. Drift to dropping a row would force customers to file a support ticket for self-recoverable issues.", () => {
    const p = read(LIC);

    expect(p).toMatch(/\*\*"Authentication failed"\*\* — verify the key in/);
    expect(p).toMatch(/\*\*"Couldn't reach control plane"\*\* — for cloud, check/);
    expect(p).toMatch(
      /\*\*Wizard re-fires on every launch\*\* — the keychain backend may be unavailable/,
    );
    expect(p).toMatch(
      /\*\*Tier-suspended on activation\*\* — the account is in a suspended state in billing/,
    );
  });

  it('CRITICAL self-hosted activation 3-step framing pinned. (1) Stand up control plane + (2) Create API key + (3) Wizard choose Self-hosted + paste URL. Matches the SH-runbook + W762 /api/api-keys + V-NNN cross-references.', () => {
    const p = read(LIC);

    expect(p).toMatch(/1\. Stand up the control plane on your own hardware per the/);
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
