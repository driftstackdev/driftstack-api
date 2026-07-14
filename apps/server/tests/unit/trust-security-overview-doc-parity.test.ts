// W238.A — drift-guard for /trust/security-overview. The page is
// procurement-facing marketing copy; the previous revision asserted
// customer-controlled SOCKS5 / WireGuard / OpenVPN egress and
// customer-configurable capture retention before those boundaries
// existed. This guard pins current implementation truth.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'trust',
  'security-overview.astro',
);
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function read(path: string): string {
  return readFileSync(path, 'utf8');
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

describe('W238.A trust/security-overview doc parity', () => {
  const doc = read(DOC_PATH);

  it('does not claim customer-configurable egress as a shipped feature when no impl exists', () => {
    const hasEgressImpl = serverSourceMatches(/customerEgress|egress_config|proxyUrl|SOCKS5/i);
    if (!hasEgressImpl) {
      // Doc must flag this as roadmap.
      expect(doc).toMatch(/Customer-configurable egress \(roadmap\)/i);
      // The previous "✓ Customer-controlled session egress" tick.
      expect(doc).not.toMatch(
        /<p class="font-medium text-slate-900">Customer-controlled session egress<\/p>/,
      );
    }
  });

  it('states the direct-capture and desktop-local recording boundary', () => {
    expect(doc).not.toMatch(/Default 30 days for screenshots/);
    expect(doc).toMatch(/Direct captures and local recordings/);
    expect(doc).toMatch(/returned directly inside the API\s+response as inline bytes/);
    expect(doc).toMatch(/not retained by the capture\s+endpoint/);
    expect(doc).toMatch(/desktop recorder stores streamed frames on the\s+operator's machine/);
    expect(doc).not.toMatch(/capture retention \(roadmap\)/i);
  });
});
