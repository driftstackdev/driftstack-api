// W229.A — drift-guard for /docs/security-overview. The previous
// revision misstated several controls:
//   - API keys "stored as SHA-256 hashes" — actual is scrypt logN=15.
//   - MFA seeds "stored as SHA-256 hashes" — actual is AES-256 encrypted.
//   - "Stateless API services in three regions (EU / US-East / AP-South)"
//     with "GeoDNS-routed" + "automatic cross-region failover" — none of
//     this is true today (single EU region, multi-region on roadmap).
//   - "Recordings WebM files land in R2" — recordings aren't shipped.
//   - "Customer-supplied script bodies run in a sandboxed Node context"
//     — no script-eval surface exists; the API is action-based.
//
// This guard pins the corrected page to the source-of-truth files.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'security-overview.astro',
);
// S47 2026-07-07 (founder-approved: mirror deprecation): the
// /docs/data-residency mirror is deleted (301 →
// docs.driftstack.io/reference/data-residency/); the cross-check
// reads the docs successor source.
const RESIDENCY_DOC = join(REPO, 'apps', 'docs', 'src', 'pages', 'reference', 'data-residency.md');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W229.A security-overview doc parity', () => {
  const doc = read(DOC_PATH);

  it('API key hashing claim is scrypt, not SHA-256', () => {
    expect(doc).toMatch(/scrypt/);
    expect(doc).not.toMatch(/API keys.*SHA-256 hashes/);
  });

  it('MFA seed claim is AES-256 encryption, not SHA-256 hashing', () => {
    expect(doc).toMatch(/MFA[\s\S]{0,60}AES-256 encrypted/);
    expect(doc).not.toMatch(/MFA[\s\S]{0,80}SHA-256 hashes/);
  });

  it('region claim matches the current data-residency contract without rollout promises', () => {
    const residency = read(RESIDENCY_DOC);
    // S47 re-pin: the docs successor states the same EU-control-plane
    // posture in its own (deliberately softened) canonical wording.
    expect(residency).toMatch(/customer data in our\s*databases is EU-resident/);
    expect(doc).toMatch(/primarily in the EU/);
    // Rule out the fictional 3-region claim:
    expect(doc).not.toMatch(/three regions \(EU, US-East/);
    expect(doc).not.toMatch(/GeoDNS-routed/);
    expect(doc).not.toMatch(/cross-region failover is automatic/);
    expect(residency).toMatch(/Setting it does not route execution or move stored data\./);
    expect(residency).toMatch(/the authoritative physical-location\s*contract\./i);
    expect(residency).not.toMatch(/multi-region rollout|once .* lands/i);
  });

  it('does not claim session recordings are live', () => {
    expect(doc).not.toMatch(/Recordings:.*WebM files land in Cloudflare R2/);
    // The section that mentions recordings must flag them as roadmap.
    expect(doc).toMatch(/recordings/i);
    expect(doc).toMatch(/\/docs\/recordings/);
  });

  it('does not claim a script-execution sandbox that does not exist', () => {
    expect(doc).not.toMatch(/Customer-supplied <code>script<\/code> bodies/);
    // Doc should explicitly state the action-based posture.
    expect(doc).toMatch(/action-based/);
  });
});
