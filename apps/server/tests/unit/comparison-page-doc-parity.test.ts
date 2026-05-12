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

  it('does not claim BYO SOCKS5 / WireGuard / OpenVPN while no egress impl exists', () => {
    const hasEgressImpl = serverSourceMatches(/customerEgress|egress_config|proxyUrl|SOCKS5/i);
    if (!hasEgressImpl) {
      // Forbid the shipped-feature framing.
      expect(doc).not.toMatch(/BYO SOCKS5 \/ WireGuard \/ OpenVPN/);
      // Comparison cell should flag as roadmap.
      expect(doc).toMatch(/Roadmap — see \/trust\/security-overview/);
    }
  });

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
