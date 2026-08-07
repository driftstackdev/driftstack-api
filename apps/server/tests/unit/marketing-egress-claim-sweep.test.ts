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
  // V-540.E (2026-05-16): gate now requires the CONCRETE wire — the
  // SessionEgressService must be wired in AppDeps via bootstrap, AND
  // at least one backend impl class must exist. The interface-alone
  // scaffolding (E1) is intentionally NOT a gate trip; only the full
  // E2/E3/E4 backend + E8 bootstrap wire flips the gate.
  const hasEgressImpl =
    serverSourceMatches(/sessionEgressService:\s*sessionEgressService/) &&
    serverSourceMatches(/implements SessionEgressService\b/);
  const pages = walk(PAGES, ['.astro', '.md']);

  it('CRITICAL the sweep reached the marketing pages, and the gate below has RETIRED — both facts stated out loud because neither is visible otherwise', () => {
    // Without this the file reports two passing tests having checked nothing.
    // `if (hasEgressImpl) return;` returned silently from both arms, and a
    // silent no-op is indistinguishable in the summary from a real check. The
    // arms are now conditional SKIPS, which the repo sanctions and which show
    // up in the skip count; this arm records why.
    expect(pages.length, 'marketing pages scanned').toBeGreaterThan(40);

    // The retirement condition, asserted rather than assumed. When this is
    // true the two arms below DO NOT RUN: the egress backend is wired, so the
    // marketing site is allowed to describe it. Measured 2026-08-07 with the
    // gate forced open, four pages would fail the disclosure rule —
    // changelog, comparison, self-hosted, and /trust/security-overview itself,
    // which cannot cross-link to itself and would have been a false positive
    // even while the gate was live.
    expect(typeof hasEgressImpl, 'the gate condition is derived, not assumed').toBe('boolean');
    expect(hasEgressImpl, 'egress is wired, so the claim gate has retired').toBe(true);

    // If the wire is ever removed the gate reactivates — so prove here that it
    // would not come back BLIND. A guard that hunts a violation cannot be
    // floored by counting subjects, and this one had no synthetic control.
    const knownBad = 'We ship customer-controlled egress today.';
    expect(/customer-controlled egress/i.test(knownBad), 'arm-1 detector still fires').toBe(true);
    const proxyClaim = 'Bring your own SOCKS5 proxy.';
    expect(
      /SOCKS5|WireGuard|OpenVPN/.test(proxyClaim) &&
        !/roadmap/i.test(proxyClaim) &&
        !/\/trust\/security-overview/.test(proxyClaim),
      'arm-2 detector still fires on an undisclosed proxy claim',
    ).toBe(true);
  });

  it.skipIf(hasEgressImpl)(
    'no page asserts "customer-controlled egress" as a shipped feature',
    () => {
      const offenders: string[] = [];
      for (const p of pages) {
        const body = readFileSync(p, 'utf8').replace(/^---[\s\S]*?---/, '');
        if (/customer-controlled egress/i.test(body)) {
          offenders.push(p.replace(REPO + '/', ''));
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it.skipIf(hasEgressImpl)(
    'SOCKS5 / WireGuard / OpenVPN only appear in honest-disclosure context (roadmap label OR cross-link to /trust/security-overview)',
    () => {
      const offenders: string[] = [];
      for (const p of pages) {
        // Legal/ pages reference third-party HTTP/SOCKS5 proxy providers
        // as Customer-Connected Services in the DPA/privacy text — that
        // is a CUSTOMER responsibility, not a Driftstack capability, so
        // exempt that subtree from this check.
        if (p.includes('/pages/legal/')) continue;
        // The disclosure surface itself cannot cross-link to itself, and it
        // carries no inline "roadmap" label, so it would be reported as an
        // offender by its own rule. Measured 2026-08-07 while proving the
        // reactivation path: it was one of four hits, and the only false one.
        // Its CONTENT is gated separately by W499.D against real server source,
        // which is the check that actually belongs to it.
        if (p.includes('/pages/trust/security-overview.')) continue;
        const body = readFileSync(p, 'utf8');
        const hasProxyMention = /SOCKS5|WireGuard|OpenVPN/.test(body);
        if (!hasProxyMention) continue;
        // Allow the mention if EITHER the doc still flags "roadmap" inline
        // OR the doc cross-links to /trust/security-overview (the canonical
        // honest-disclosure surface for the egress impl state; F-5 Issue 5
        // reframe — pages no longer label features "on the roadmap" inline
        // but they DO point at the surface that holds the impl-state
        // disclosure, which is gated by W499.D against actual server source).
        const hasRoadmap = /roadmap/i.test(body);
        const hasSecOverviewLink = /\/trust\/security-overview/.test(body);
        if (!hasRoadmap && !hasSecOverviewLink) {
          offenders.push(p.replace(REPO + '/', ''));
        }
      }
      expect(offenders).toEqual([]);
    },
  );
});
