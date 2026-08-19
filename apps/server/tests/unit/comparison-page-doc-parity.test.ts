// W246.C — drift-guard for /comparison. Previous revision claimed
// Driftstack supports "BYO SOCKS5 / WireGuard / OpenVPN" as a
// customer-controlled-proxies feature; no server-side impl exists.
// Aligned with W238 + W245.D + W246.A — egress is roadmap.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'comparison.astro');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function read(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function serverSourceMatches(re: RegExp): boolean {
  function walk(dir: string): boolean {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(p)) return true;
      } else if (entry.name.endsWith('.ts')) {
        if (re.test(readFileSync(p, 'utf8'))) return true;
      }
    }
    return false;
  }
  return walk(SERVER_SRC);
}

describe('W246.C /comparison doc parity', () => {
  const doc = read();

  // V-917: the CONCRETE wire, per V-540.E. This file previously matched
  // /customerEgress|egress_config|proxyUrl|SOCKS5/i, which flips on any server
  // file that merely mentions SOCKS5 — including webhook-target-guard.ts,
  // which blocks proxy schemes as SSRF targets and has nothing to do with
  // customer egress. V-540.E tightened this in two of the five files that
  // compute the gate; this was one of the three it missed.
  const hasEgressImpl =
    serverSourceMatches(/sessionEgressService:\s*sessionEgressService/) &&
    serverSourceMatches(/implements SessionEgressService\b/);

  it('CRITICAL the egress gate was computed and has RETIRED. Stated out loud because it is invisible otherwise: the arm below used to be an `if (!hasEgressImpl)` body inside a passing test, so once egress shipped it asserted nothing while still reporting as a pass. A conditional skip shows up in the skip count; a silent no-op is indistinguishable from a real check.', () => {
    expect(typeof hasEgressImpl, 'the gate is derived from source, not assumed').toBe('boolean');
    expect(hasEgressImpl, 'egress is wired, so the claim gate has retired').toBe(true);
  });

  it.skipIf(hasEgressImpl)(
    'does not claim BYO SOCKS5 / WireGuard / OpenVPN while no egress impl exists',
    () => {
      // Forbid the shipped-feature framing.
      expect(doc).not.toMatch(/BYO SOCKS5 \/ WireGuard \/ OpenVPN/);
      // Comparison cell should flag as roadmap.
      expect(doc).toMatch(/Roadmap — see \/trust\/security-overview/);
    },
  );

  it('keeps the Apple WebKit engine differentiator', () => {
    expect(doc).toMatch(/Apple WebKit/);
  });

  it('keeps the per-concurrent-session pricing-model row', () => {
    expect(doc).toMatch(/Per concurrent session/);
  });

  it('lists the four primary competitors', () => {
    for (const c of ['Browserless', 'Bright', 'ScrapingBee', 'Browserbase']) {
      expect(doc.toLowerCase()).toContain(c.toLowerCase());
    }
  });
});
