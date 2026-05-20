// W600 — drift guard for apps/docs/src/pages root pages.
// 3 modules in one suite: index.astro + quickstart.md + license-activation.md.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const INDEX = resolve(REPO_ROOT, 'apps/docs/src/pages/index.astro');
const QUICK = resolve(REPO_ROOT, 'apps/docs/src/pages/quickstart.md');
const LICENSE = resolve(REPO_ROOT, 'apps/docs/src/pages/license-activation.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W600 apps/docs root pages content parity', () => {
  it('index.astro: V-254/V-257 framing + 3 onboarding cards (Quickstart + SDK installation + License activation) + 2 concept guides (Profile management + Session lifecycle) + 6 reference cards + GitHub docs/ + marketing cross-links pinned', () => {
    const body = read(INDEX);
    expect(body).toMatch(/\/\/ V-254 \/ V-257 — docs site landing page\./);
    expect(body).toMatch(
      /\/\/ V-254 replaced the V-250 scaffold-era "site is being built out" copy/,
    );
    expect(body).toMatch(/\/\/ with a real intro that surfaces the doc-tree categories\./);
    expect(body).toMatch(/\/\/ V-257 reorganises around the customer's onboarding path:/);
    expect(body).toMatch(
      /\/\/ "Quickstart" leads, then per-topic deep dives, then reference at the/,
    );
    expect(body).toMatch(/\/\/ bottom\./);
    expect(body).toMatch(/^const onboarding = \[/m);
    expect(body).toMatch(/label: 'Quickstart',/);
    expect(body).toMatch(/href: '\/quickstart\/',/);
    expect(body).toMatch(/label: 'SDK installation',/);
    expect(body).toMatch(/href: '\/sdk\/installation\/',/);
    expect(body).toMatch(/label: 'License activation',/);
    expect(body).toMatch(/href: '\/license-activation\/',/);
    expect(body).toMatch(/^const guides = \[/m);
    expect(body).toMatch(/label: 'Profile management',/);
    expect(body).toMatch(/href: '\/guides\/profile-management\/',/);
    expect(body).toMatch(/label: 'Session lifecycle',/);
    expect(body).toMatch(/^const reference = \[/m);
    expect(body).toMatch(/label: 'API versioning',/);
    expect(body).toMatch(/label: 'Webhook events',/);
    expect(body).toMatch(/label: 'SDK versioning',/);
    expect(body).toMatch(/label: 'API keys',/);
    expect(body).toMatch(/Mint, list, rotate, revoke\. 24h grace period on rotation\./);
    expect(body).toMatch(/label: 'Webhook replay',/);
    expect(body).toMatch(/label: 'Team RBAC',/);
    expect(body).toMatch(/Invite, accept, list, remove\. Owner \/ admin \/ member roles\./);
    expect(body).toMatch(/<DocLayout title="Driftstack docs">/);
    expect(body).toMatch(/<h1>Driftstack docs<\/h1>/);
    expect(body).toMatch(
      /href="https:\/\/github\.com\/driftstackdev\/driftstack-api\/tree\/main\/docs"/,
    );
    expect(body).toMatch(/href="https:\/\/driftstack\.dev\/pricing"/);
    expect(body).toMatch(/href="https:\/\/driftstack\.dev\/security"/);
    expect(body).toMatch(/href="https:\/\/driftstack\.dev\/self-hosted"/);
    expect(body).toMatch(/href="mailto:support@driftstack\.dev"/);
    expect(existsSync(INDEX)).toBe(true);
  });

  it('quickstart.md: signup-to-first-session-in-5-min + 3-language coverage (TS/Python/Go) + API key DRIFTSTACK_API_KEY env + ds_live_ prefix + per-tier concurrent caps (1/2/8/24) + 5-section structure pinned', () => {
    const body = read(QUICK);
    expect(body).toMatch(
      /^---\nlayout: \.\.\/layouts\/DocLayout\.astro\ntitle: Quickstart\ndescription: Get from signup to your first Driftstack session in under five minutes — TypeScript, Python, or Go\.\n---$/m,
    );
    expect(body).toMatch(/^# Quickstart$/m);
    expect(body).toMatch(
      /This guide takes you from a fresh signup to your first iPhone Safari session\./,
    );
    expect(body).toMatch(/Allow about five minutes\./);
    expect(body).toMatch(/- Node\.js 18\+, Python 3\.10\+, or Go 1\.21\+/);
    expect(body).toMatch(/^## 1\. Get an API key$/m);
    expect(body).toMatch(/^## 2\. Install the SDK$/m);
    expect(body).toMatch(/^## 3\. Run your first session$/m);
    expect(body).toMatch(/^## 4\. What happened$/m);
    expect(body).toMatch(/^## 5\. Next steps$/m);
    expect(body).toMatch(/export DRIFTSTACK_API_KEY="ds_live_…"/);
    expect(body).toMatch(/The key prefix \(`ds_live_`\) tells you it's a production key\./);
    expect(body).toMatch(/npm install @driftstack\/sdk/);
    expect(body).toMatch(/pip install driftstack-sdk/);
    expect(body).toMatch(/go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/);
    expect(body).toMatch(
      /> The TypeScript SDK is published on npm today\. The Python and Go SDKs are alpha and may install from a checkout until the first registry tag\./,
    );
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk';/);
    expect(body).toMatch(/from driftstack import Driftstack/);
    expect(body).toMatch(
      /driftstack "github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go"/,
    );
    expect(body).toMatch(/Trial pack: 1, API Starter: 2, API Builder: 8, API Scale: 24/);
    expect(body).toMatch(/Exceeding the cap returns 429\./);
    expect(body).toMatch(/\(returned in the `x-request-id` header\)/);
    expect(existsSync(QUICK)).toBe(true);
  });

  it('license-activation.md: GUI client (Tauri 2.x macOS/Windows/Linux) + same-API-key-as-SDK + 5-step wizard (Welcome / Deployment mode / API key + GET /v1/account/me validation / First profile / Done) + keyring-rs OS keychain + cross-platform signing notes + Tauri Updater + troubleshooting pinned', () => {
    const body = read(LICENSE);
    expect(body).toMatch(/^title: License activation \(GUI client\)$/m);
    expect(body).toMatch(/^# License activation \(GUI client\)$/m);
    expect(body).toMatch(
      /The Driftstack desktop GUI client \(Tauri 2\.x — macOS, Windows, Linux\) doesn't use a separate license-key system\./,
    );
    expect(body).toMatch(/^## What you need$/m);
    expect(body).toMatch(/Same shape as the API key your SDK calls use\./);
    expect(body).toMatch(/Your tier supports GUI client access\./);
    expect(body).toMatch(/^## First-run flow$/m);
    expect(body).toMatch(/On first launch, the GUI client opens a five-step wizard:/);
    expect(body).toMatch(/1\. \*\*Welcome\*\*/);
    expect(body).toMatch(
      /2\. \*\*Deployment mode\*\* — radio: \*\*Cloud\*\* \(`https:\/\/api\.driftstack\.dev`\) or \*\*Self-hosted\*\*/,
    );
    // 2026-05-20 — port 7780→3000 (DEFAULT_SETTINGS.baseUrl shift per
    // 6d117edb / beed59db; matches the port apps/server binds to in dev).
    expect(body).toMatch(/defaults to `http:\/\/localhost:3000`/);
    expect(body).toMatch(/3\. \*\*API key\*\*/);
    expect(body).toMatch(/The wizard immediately calls `GET \/v1\/account\/me` to validate\./);
    expect(body).toMatch(/4\. \*\*First profile\*\* \(skippable\)/);
    expect(body).toMatch(/The wizard calls `POST \/v1\/profiles`/);
    expect(body).toMatch(/5\. \*\*Done\*\* — flag flipped; main app shell takes over\./);
    expect(body).toMatch(/^## Where credentials live$/m);
    expect(body).toMatch(
      /\*\*API key\*\* — stored in the OS keychain \(`keyring-rs`\): macOS Keychain, Windows Credential Manager, Linux Secret Service \/ kwallet\./,
    );
    expect(body).toMatch(/The key never lands in `settings\.json` on disk\./);
    expect(body).toMatch(/^## Switching deployments$/m);
    expect(body).toMatch(/^## Self-hosted activation$/m);
    expect(body).toMatch(/^## Cross-platform notes$/m);
    expect(body).toMatch(/\*\*macOS\*\* — primary build target/);
    expect(body).toMatch(/Apple Developer ID program/);
    expect(body).toMatch(/\*\*Windows\*\* — EV cert \+ Tauri Updater pending pre-launch/);
    expect(body).toMatch(/SmartScreen may flag the binary on first launch\./);
    expect(body).toMatch(/\*\*Linux\*\* — `\.AppImage` and `\.deb` artifacts unsigned/);
    expect(body).toMatch(/^## Updates$/m);
    expect(body).toMatch(/Tauri Updater \+ GitHub Releases ship updates automatically\./);
    expect(body).toMatch(/^## Troubleshooting$/m);
    expect(body).toMatch(/\*\*"Authentication failed"\*\*/);
    expect(body).toMatch(/\*\*"Couldn't reach control plane"\*\*/);
    expect(body).toMatch(/check \[status\.driftstack\.dev\]\(https:\/\/status\.driftstack\.dev\)/);
    expect(body).toMatch(/\*\*Wizard re-fires on every launch\*\*/);
    expect(body).toMatch(/^## Next steps$/m);
    expect(existsSync(LICENSE)).toBe(true);
  });
});
