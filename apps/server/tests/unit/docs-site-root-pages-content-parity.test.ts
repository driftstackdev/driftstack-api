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
  // S22.5 (2026-07-06, Stoplight redesign final slice) — the landing's
  // hand-kept onboarding/guides/reference card grids are superseded by
  // a "pick your path" band + DOC_NAV-derived section cards (labels /
  // hrefs / page counts come from src/data/nav.ts, the tree source).
  // The superseded per-card facts stay pinned with their own pages:
  // 24h key-rotation grace → /api/api-keys/ pins
  // (api-keys-rotation-grace-parity + docs-api-api-keys-parity); team
  // invite/accept/list/remove + roles → /api/team/ pins.
  it('index.astro: V-254/V-257 + S22.5 framing, plain-words hero + CTA/search pair, 3-path band (by hand / from code / look up), DOC_NAV-derived section cards + GitHub docs/ + marketing cross-links pinned', () => {
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
    expect(body).toMatch(/\/\/ S22\.5 \(2026-07-06, Stoplight redesign final slice\)/);
    expect(body).toMatch(/import \{ DOC_NAV \} from '\.\.\/data\/nav';/);
    expect(body).toMatch(/^const paths = \[/m);
    expect(body).toMatch(/label: 'Drive it by hand',/);
    expect(body).toMatch(/href: '\/license-activation\/',/);
    expect(body).toMatch(/label: 'Drive it from code',/);
    expect(body).toMatch(/href: '\/quickstart\/',/);
    expect(body).toMatch(/label: 'Look something up',/);
    expect(body).toMatch(/href: '\/api\/',/);
    expect(body).toMatch(/^const sectionIntros: Record<string, string> = \{/m);
    expect(body).toMatch(/const sections = DOC_NAV\.map\(\(s\) => \(\{/);
    expect(body).toMatch(/count: s\.items\.length,/);
    expect(body).toMatch(/Driftstack gives you real iPhones in the cloud\./);
    expect(body).toMatch(/class="btn-primary"/);
    expect(body).toMatch(/data-search-open/);
    expect(body).toMatch(/<DocLayout title="Driftstack docs">/);
    expect(body).toMatch(/<h1>Driftstack docs<\/h1>/);
    expect(body).toMatch(
      /href="https:\/\/github\.com\/driftstackdev\/driftstack-api\/tree\/main\/docs"/,
    );
    expect(body).toMatch(/href="https:\/\/driftstack\.dev\/pricing\/"/);
    expect(body).toMatch(/href="https:\/\/driftstack\.dev\/security\/"/);
    expect(body).toMatch(/href="https:\/\/driftstack\.dev\/self-hosted\/"/);
    expect(body).not.toMatch(/href="https:\/\/driftstack\.dev\/(?:pricing|security|self-hosted)"/);
    expect(body).toMatch(/href="mailto:support@driftstack\.dev"/);
    expect(existsSync(INDEX)).toBe(true);
  });

  it('quickstart.md: signup-to-first-session-in-5-min + 3-language coverage (TS/Python/Go) + API key DRIFTSTACK_API_KEY env + ds_live_ prefix + per-tier concurrent caps (1/2/8/24) + 5-section structure pinned', () => {
    const body = read(QUICK);
    // S22.5 (2026-07-06) — description re-worded plain-words-first
    // (names the concrete thing: an iPhone Safari session; "about five
    // minutes" now matches the body's "Allow about five minutes").
    // layout/title stay lines 2–3 in that order (anchored).
    expect(body).toMatch(
      /^---\nlayout: \.\.\/layouts\/DocLayout\.astro\ntitle: Quickstart\ndescription: From signup to your first iPhone Safari session in about five minutes — working examples in TypeScript, Python, or Go\.\n---$/m,
    );
    expect(body).toMatch(/^# Quickstart$/m);
    expect(body).toMatch(
      /This guide takes you from a fresh signup to your first iPhone Safari session from code\./,
    );
    expect(body).toMatch(/Allow about five minutes\./);
    // 2026-06-24: go.mod declares `go 1.22`, so the Go floor is 1.22+ (was a stale 1.21+).
    expect(body).toMatch(/- Node\.js 18\+, Python 3\.10\+, or Go 1\.22\+/);
    expect(body).not.toMatch(/Go 1\.21\+/);
    expect(body).toMatch(/^## 1\. Get an API key$/m);
    expect(body).toMatch(/^## 2\. Install the SDK$/m);
    expect(body).toMatch(/^## 3\. Run your first session$/m);
    expect(body).toMatch(/^## 4\. What happened$/m);
    expect(body).toMatch(/^## 5\. Next steps$/m);
    expect(body).toMatch(/export DRIFTSTACK_API_KEY="ds_live_…"/);
    expect(body).toMatch(/This code quickstart requires a paid tier with API access/);
    expect(body).toMatch(/`ds_live_` prefix on every paid tier, including Manual/);
    expect(body).toMatch(
      /restricted device credential\s*\n?the desktop app obtains and stores automatically/,
    );
    expect(body).not.toMatch(/same shape, test environment/);
    expect(body).toMatch(/npm install @driftstack\/sdk/);
    expect(body).toMatch(/pip install driftstack-sdk/);
    expect(body).toMatch(/go get github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go/);
    expect(body).toMatch(
      /> All three SDKs are published pre-1\.0: TypeScript on npm, Python on PyPI, and Go as a tagged module\. Keep your package-manager lockfile, Python constraints, or `go\.sum` under version control for reproducible installs\./,
    );
    expect(body).not.toMatch(/may install from a checkout|first registry tag|tag pending/i);
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk';/);
    expect(body).toMatch(/from driftstack import Driftstack/);
    expect(body).toMatch(
      /driftstack "github\.com\/driftstackdev\/driftstack-api\/packages\/sdk-go"/,
    );
    expect(body).toMatch(/Free: 1, API Starter: 2, API Builder: 8, API Scale: 24/);
    expect(body).toMatch(/Exceeding the cap returns 429\./);
    expect(body).toMatch(/\(returned in the `x-request-id` header\)/);
    expect(existsSync(QUICK)).toBe(true);
  });

  it('license-activation.md: supported macOS GUI + same-API-key-as-SDK + 5-step wizard + macOS Keychain + signing notes + updater + troubleshooting pinned', () => {
    const body = read(LICENSE);
    expect(body).toMatch(/^title: License activation \(GUI client\)$/m);
    expect(body).toMatch(/^# License activation \(GUI client\)$/m);
    expect(body).toMatch(/client defaults to secure browser sign-in/);
    expect(body).toMatch(/Free users do not create or paste a customer API key/);
    expect(body).toMatch(/^## What you need$/m);
    expect(body).toMatch(/A Driftstack dashboard account for the default browser sign-in flow/);
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
    expect(body).toMatch(/3\. \*\*Sign in\*\* — use \*\*Sign in with browser\*\* by default/);
    expect(body).toMatch(/calls `GET \/v1\/account\/me` to validate it/);
    expect(body).toMatch(/4\. \*\*First profile\*\* \(skippable\)/);
    expect(body).toMatch(/The wizard calls `POST \/v1\/profiles`/);
    expect(body).toMatch(/5\. \*\*Done\*\* — flag flipped; main app shell takes over\./);
    expect(body).toMatch(/^## Where credentials live$/m);
    expect(body).toMatch(
      /\*\*Device credential or fallback API key\*\* — stored in macOS Keychain/,
    );
    expect(body).toMatch(/It never lands in `settings\.json` on disk\./);
    expect(body).toMatch(/^## Switching deployments$/m);
    expect(body).toMatch(/^## Self-hosted activation$/m);
    expect(body).toMatch(/^## Platform support$/m);
    expect(body).toMatch(
      /\*\*macOS on Apple silicon\*\* is the current supported distribution target\./,
    );
    // V-796 — both lines retracted. gui-release.yml has no Apple signing
    // credentials and tauri.conf.json no signingIdentity/hardenedRuntime/notarize,
    // so the verification chain never ran; and the pipeline DOES build Windows and
    // Linux bundles, with no gui-v* tag published on any platform.
    expect(body).toMatch(/Builds are \*\*not\*\* Apple Developer ID code-signed/);
    expect(body).toMatch(/macOS on Apple silicon is the only platform/);
    expect(body).not.toMatch(
      /Developer ID signature, hardened-runtime, notarisation, and Gatekeeper/,
    );
    expect(body).not.toMatch(/does not publish Windows or Linux installers/);
    expect(body).not.toMatch(/pending pre-launch|once the first ones ship|page is not live yet/i);
    expect(body).toMatch(/^## Updates$/m);
    expect(body).toMatch(
      /Tauri Updater checks the signed GitHub Releases manifest once at startup/,
    );
    expect(body).toMatch(/does not\s*\n?download anything until you choose \*\*Install\*\*/);
    expect(body).toMatch(/installs it,\s*\n?and relaunches the app/);
    expect(body).toMatch(/^## Troubleshooting$/m);
    expect(body).toMatch(/\*\*"Authentication failed"\*\*/);
    expect(body).toMatch(/\*\*"Couldn't reach control plane"\*\*/);
    expect(body).toMatch(/check \[status\.driftstack\.dev\]\(https:\/\/status\.driftstack\.dev\)/);
    expect(body).toMatch(/\*\*Wizard re-fires on every launch\*\*/);
    expect(body).toMatch(/\*\*"You do not have permission" on activation\*\*/);
    expect(body).toMatch(/^## Next steps$/m);
    expect(existsSync(LICENSE)).toBe(true);
  });
});
