// W247.A — workspace-wide sweep guard. After W238 / W245.D / W246.A /
// W246.C / W246.D / this slice, no customer-facing page in the
// marketing site should assert "customer-controlled egress" /
// "SOCKS5 / WireGuard / OpenVPN" as a shipped capability. This
// guard scans every .astro and .md under marketing-site/src/pages
// and fails if any survives the cleanup.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const PAGES = join(REPO, 'apps', 'marketing-site', 'src', 'pages');
const SERVER_SRC = join(REPO, 'apps', 'server', 'src');

function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p, exts));
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

function serverSourceMatches(re: RegExp): boolean {
  function w(dir: string): boolean {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (w(p)) return true;
      } else if (entry.name.endsWith('.ts')) {
        if (re.test(readFileSync(p, 'utf8'))) return true;
      }
    }
    return false;
  }
  return w(SERVER_SRC);
}

describe('W247.A marketing-site egress-claim drift sweep', () => {
  const hasEgressImpl = serverSourceMatches(/customerEgress|egress_config|proxyUrl|SOCKS5/i);
  const pages = walk(PAGES, ['.astro', '.md']);

  it('no page asserts "customer-controlled egress" as a shipped feature', () => {
    if (hasEgressImpl) return;
    const offenders: string[] = [];
    for (const p of pages) {
      const body = readFileSync(p, 'utf8').replace(/^---[\s\S]*?---/, '');
      if (/customer-controlled egress/i.test(body)) {
        offenders.push(p.replace(REPO + '/', ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('SOCKS5 / WireGuard / OpenVPN only appear in roadmap or third-party-proxy context', () => {
    if (hasEgressImpl) return;
    const offenders: string[] = [];
    for (const p of pages) {
      // Legal/ pages reference third-party HTTP/SOCKS5 proxy providers
      // as Customer-Connected Services in the DPA/privacy text — that
      // is a CUSTOMER responsibility, not a Driftstack capability, so
      // exempt that subtree from this check.
      if (p.includes('/pages/legal/')) continue;
      const body = readFileSync(p, 'utf8');
      const hasProxyMention = /SOCKS5|WireGuard|OpenVPN/.test(body);
      if (!hasProxyMention) continue;
      // Allow the mention as long as the surrounding doc flags "roadmap"
      // somewhere (case-insensitive).
      if (!/roadmap/i.test(body)) {
        offenders.push(p.replace(REPO + '/', ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});
