import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
// Retired 2026-08-22. gui-v0.1.2 is a PUBLIC release, so routing customers to
// support for a copy of the app was not stale wording -- it was a false claim.
// Kept here only so the ban below can name the exact string.
const RETIRED_ACCESS_MAILTO =
  'mailto:support@driftstack.dev?subject=Driftstack%20desktop%20app%20access';
// /releases/latest redirects to the newest published tag, so this link cannot
// go stale the way a pinned gui-vX.Y.Z would on the next cut.
const DOWNLOAD_URL = 'https://github.com/driftstackdev/driftstack-api/releases/latest';

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

const overview = read('apps/customer-dashboard/src/pages/index.astro');
const layout = read('apps/customer-dashboard/src/layouts/DashboardLayout.astro');
const welcome = read('apps/customer-dashboard/src/pages/welcome.astro');
const pricing = read('apps/marketing-site/src/pages/pricing.astro');
// V-2171 — the SITE-WIDE header carries the same download CTA TWICE (desktop nav
// + mobile menu) and was ungated: this invariant read four surfaces and the two
// most-seen links on the marketing site were not among them. Every page inherits
// this component, so a wrong URL here is wrong everywhere at once.
const header = read('apps/marketing-site/src/components/Header.astro');

describe('desktop app access public truth', () => {
  it('every customer-facing app-access action points at the ONE public release download', () => {
    for (const [name, body] of [
      ['overview', overview],
      ['layout', layout],
      ['welcome', welcome],
      ['pricing', pricing],
      ['header', header],
    ] as const) {
      expect(body, name).toContain(DOWNLOAD_URL);
      // Ban the retired route outright. While an installer existed and these
      // pages still said "ask support", every one of these four surfaces was
      // telling customers something untrue.
      expect(body, name).not.toContain(RETIRED_ACCESS_MAILTO);
    }
    expect(overview).toContain('Download the desktop app');
    expect(layout).toContain("label: 'Download desktop app'");
    expect(welcome).toContain('Download the desktop app');
    expect(pricing).toContain('Download the desktop app');
    // BOTH header entries, not just one: the desktop nav and the mobile menu are
    // separate markup, so a fix applied to one reads as done while the other
    // still points somewhere else.
    expect(
      header.split(DOWNLOAD_URL).length - 1,
      'the desktop-nav AND mobile-menu download links must both point at the public release',
    ).toBeGreaterThanOrEqual(2);
  });

  it('states the real distribution truth: public, cross-platform, and NOT OS-code-signed', () => {
    // Three separate falsehoods came out of these pages together, so all three
    // are banned together across every surface that carried any of them:
    //   1. "there is no public installer link" -- gui-v0.1.2 is a public,
    //      non-draft, non-prerelease GitHub release.
    //   2. "signed" -- gui-release.yml states the pre-launch posture is
    //      "NO OS-level binary signing"; only UPDATE bundles are key-signed.
    //   3. "Apple-silicon" -- the macOS artefact is Driftstack_universal.dmg,
    //      and .exe / .AppImage / .deb ship alongside it.
    for (const [name, body] of [
      ['overview', overview],
      ['layout', layout],
      ['welcome', welcome],
      ['pricing', pricing],
      ['header', header],
    ] as const) {
      expect(body, name).not.toMatch(/Apple-silicon macOS app/);
      expect(body, name).not.toMatch(/no public installer link/i);
      expect(body, name).not.toMatch(/supplied directly by Driftstack/);
      // The retired CALL TO ACTION, not only the retired claims. This one
      // outlived the first sweep because it sits in a banner STRING with no
      // mailto beside it, so neither the link grep nor the claim grep saw it.
      expect(body, name).not.toMatch(/Request desktop app/);
    }
    // Say the unsigned posture out loud rather than letting a first-launch
    // Gatekeeper/SmartScreen block read as a broken download.
    expect(overview).toMatch(/Not OS-code-signed yet/);
    expect(welcome).toMatch(/not OS-code-signed yet/);
    expect(pricing).toMatch(/not OS-code-signed yet/);
    expect(welcome).toMatch(/macOS, Windows (and|or) Linux/);
    expect(pricing).toMatch(/macOS, Windows and Linux/);
    expect(overview).toMatch(/macOS, Windows and Linux/);
  });

  it('never treats opening an access link as proof of installation', () => {
    expect(overview).toContain("localStorage.removeItem('ds_onboarding_app_clicked')");
    expect(overview).not.toContain("localStorage.setItem('ds_onboarding_app_clicked'");
    expect(overview).toContain('onboarding.app = onboarding.session === true');
    expect(overview).toMatch(/onboarding\.session = true;\s*onboarding\.app = true;/);
    expect(overview).not.toMatch(/onboardingAppLink\.addEventListener/);
  });

  it('keeps browser device credentialing separate from paid-tier API guidance', () => {
    expect(welcome).toMatch(/restricted device credential for the\s+app, not a customer API key/);
    expect(overview).toContain('<p class="font-medium text-tk-ink">API quickstart</p>');
    expect(overview).toContain('Paid-tier code walkthrough on docs.');
    expect(overview).toContain('https://docs.driftstack.io/quickstart/');
    expect(overview).not.toMatch(/Get the app[\s\S]{0,240}docs\.driftstack\.io\/quickstart/);
  });
});
