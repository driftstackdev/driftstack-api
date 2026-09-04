// W245.B — drift-guard for /trust/incidents. Pre-launch the public
// list is empty; this guard fails if anyone removes the "what we
// publish" guarantee bullets (those are the customer-visible
// commitments), or if the Incident interface drifts from the
// severity-enum shape the page renders.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'trust', 'incidents.astro');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('W245.B trust/incidents doc parity', () => {
  const doc = read();

  it('keeps the four publish-bar commitments', () => {
    expect(doc).toMatch(/Customer-impacting downtime/);
    expect(doc).toMatch(/Security events/);
    expect(doc).toMatch(/Sub-processor incidents/);
    expect(doc).toMatch(/Maintenance windows/);
  });

  it('pre-launch state shows the no-incidents-to-date marker', () => {
    expect(doc).toMatch(/No customer-impacting incidents to date/);
  });

  it('severity enum is bounded to major_outage / degraded / security', () => {
    expect(doc).toMatch(/'major_outage'\s*\|\s*'degraded'\s*\|\s*'security'/);
  });

  it('post-incident SLA is "within seven days"', () => {
    expect(doc).toMatch(/within seven\s+days/);
  });

  it('maintenance window notice is 72h advance', () => {
    expect(doc).toMatch(/72 hours in advance/);
  });

  it('cross-links to the live status badge + sub-processors list', () => {
    expect(doc).toMatch(/StatusBadge/);
    expect(doc).toMatch(/\/trust|\/legal\/sub-processors|status\.driftstack\.io/);
  });
});
