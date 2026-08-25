// W504.A — drift guard for the current compliance and disclosure surface.
// The page lists only controls in place and must not publish certification
// schedules, speculative evidence, or unavailable secure-contact methods.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/compliance.astro');

describe('W504.A apps/marketing-site/src/pages/trust/compliance.astro content parity', () => {
  const body = readFileSync(LIB, 'utf8');

  it('lists the current GDPR DPA evidence without certification timelines', () => {
    expect(body).toMatch(/This table lists only attestations currently in place/);
    expect(body).toMatch(/not currently SOC 2 or ISO 27001 certified/);
    expect(body).toMatch(/GDPR Article 28/);
    expect(body).toMatch(/DPA with SCCs available/);
    expect(body).toMatch(/href="\/legal\/dpa\/"/);
    expect(body).not.toMatch(/Q[1-4] 20\d\d|scheduled|in progress|roadmap/i);
  });

  it('pins the private vulnerability-reporting channel and response commitments', () => {
    expect(body).toMatch(/mailto:security@driftstack\.dev/);
    expect(body).toMatch(/arrange an encrypted transfer channel/);
    expect(body).toMatch(/Acknowledge receipt within 2 business days/);
    expect(body).toMatch(/initial severity assessment within 5 business days/);
    expect(body).toMatch(/status updates at least every 14 days until resolution/i);
    expect(body).toMatch(/Credit the reporter publicly after remediation, with consent/);
  });

  it('pins practical safe-harbour boundaries', () => {
    expect(body).toMatch(/will not pursue legal action against good-faith research/);
    expect(body).toMatch(
      /avoids customer data,\s*service disruption, and public disclosure before remediation/,
    );
  });

  it('pins the Article 28 sub-processor notice and objection route', () => {
    expect(body).toMatch(/GDPR Article 28\(2\) and Annex 3 of our DPA/);
    expect(body).toMatch(/30\s*calendar days' notice/);
    expect(body).toMatch(/href="\/trust\/sub-processors\/"/);
    expect(body).toMatch(/mailto:support@driftstack\.dev/);
  });

  it('pins customer, privileged-action, and access-log retention', () => {
    expect(body).toMatch(/GET \/v1\/account\/audit-log/);
    expect(body).toMatch(/Privileged admin-action records are retained internally for 365 days/);
    expect(body).toMatch(
      /Access logs stay in quick-access storage for 90 days, then in archive for one year/,
    );
  });

  it('exists at its canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
