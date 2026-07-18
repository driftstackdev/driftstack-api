import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ACCESS_MAILTO = 'mailto:support@driftstack.dev?subject=Driftstack%20desktop%20app%20access';

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

const overview = read('apps/customer-dashboard/src/pages/index.astro');
const layout = read('apps/customer-dashboard/src/layouts/DashboardLayout.astro');
const welcome = read('apps/customer-dashboard/src/pages/welcome.astro');
const pricing = read('apps/marketing-site/src/pages/pricing.astro');

describe('desktop app access public truth', () => {
  it('every customer-facing app-access action uses one actionable support request', () => {
    for (const [name, body] of [
      ['overview', overview],
      ['layout', layout],
      ['welcome', welcome],
      ['pricing', pricing],
    ] as const) {
      expect(body, name).toContain(ACCESS_MAILTO);
    }
    expect(overview).toContain('Request desktop app access');
    expect(layout).toContain("label: 'Request desktop app access'");
    expect(welcome).toContain('Request desktop app access');
    expect(pricing).toContain('Request desktop app access');
  });

  it('states the current signed macOS distribution truth without inventing public installers', () => {
    expect(overview).toMatch(/Signed Apple-silicon macOS app, supplied directly by Driftstack/);
    expect(welcome).toMatch(
      /signed Apple-silicon macOS app is\s+supplied directly by Driftstack support/,
    );
    expect(welcome).toContain('There is no public installer link.');
    expect(pricing).toMatch(
      /signed Apple-silicon macOS app is supplied directly by\s+Driftstack support after signup/,
    );
    expect(pricing).toContain('there is no public installer link');
    expect(welcome).not.toMatch(/Download the Driftstack desktop app/);
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
    expect(overview).toContain('https://docs.driftstack.dev/quickstart/');
    expect(overview).not.toMatch(/Get the app[\s\S]{0,240}docs\.driftstack\.dev\/quickstart/);
  });
});
