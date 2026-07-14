// W316.B — drift guard for /trust/incidents page. Pins the
// post-mortem framework the page promises:
//   • 24-hour customer-impact summary
//   • 7-day root-cause + remediation publish window
//   • severity taxonomy: major_outage / degraded / security
//   • acknowledges short outages still get published

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/incidents.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W316.B /trust/incidents narrative baseline', () => {
  const body = read(PAGE);

  it('declares the three-tier severity taxonomy', () => {
    expect(body).toMatch(/'major_outage'/);
    expect(body).toMatch(/'degraded'/);
    expect(body).toMatch(/'security'/);
  });

  it('promises root cause + remediation within 7 days', () => {
    expect(body).toMatch(/seven\s+days|7\s+days/i);
    expect(body).toMatch(/[Rr]oot cause/);
    expect(body).toMatch(/remediation/i);
  });

  it('SLA-comment captures 24h impact summary + 7d post-mortem window', () => {
    expect(body).toMatch(/customer-impact summary within 24h/i);
    expect(body).toMatch(/root-cause and\s+\/\/ remediation within 7 days/i);
  });

  it('acknowledges short outages still get published (no silent fixes)', () => {
    expect(body).toMatch(/short enough that customers might\s+not notice/i);
  });
});
