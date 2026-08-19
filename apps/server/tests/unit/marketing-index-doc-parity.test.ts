// W246.D — drift-guard for the marketing-site homepage (/). Previous
// revision asserted "customer-controlled egress" + a SOCKS5 /
// WireGuard / OpenVPN proxy.config block as a live differentiator;
// the server has no egress config impl. Aligned with W238 / W245.D /
// W246.A / W246.C.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(REPO, 'apps', 'marketing-site', 'src', 'pages', 'index.astro');
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

describe('W246.D marketing-site /index doc parity', () => {
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
    'does not assert customer-controlled egress as a current differentiator',
    () => {
      // Forbidden headline / claim.
      expect(doc).not.toMatch(/EU-resident, customer-controlled egress/);
      // The fake "proxy.config — your egress, your routes" code block must be gone.
      expect(doc).not.toMatch(/proxy\.config — your egress, your routes/);
      // Roadmap framing must be present.
      expect(doc).toMatch(/Customer-configurable egress[\s\S]*?roadmap/i);
    },
  );

  it('S30 2026-07-07 (founder decision: soften) EU residency softened: "EU-hosted by default." headline (supersedes M.3\'s "EU-only by default." — DB-resident data is EU-Hetzner-true, but file objects live on Cloudflare R2 default jurisdiction with EU + US replication) + "Your account data lives on EU servers." plain-English body + "operational metadata we need to bill" framing. Infra-tier readers get the detail via the /trust/sub-processors cross-link.', () => {
    expect(doc).toMatch(/EU-hosted by default/);
    expect(doc).toMatch(/Your account data lives on EU servers/);
    expect(doc).toMatch(/operational metadata we need to bill/);
    expect(doc).not.toMatch(/Hetzner\s*\n?\s*Falkenstein, Neon EU, and Cloudflare R2/);
    // Prior infra-tier wording must NOT return.
    expect(doc).not.toMatch(/Customer data stays in the EU/);
    expect(doc).not.toMatch(
      /Database, object storage, and compute all run in the EU,\s*\n?\s*single-region/,
    );
    // S30 negative pins — the absolutist residency claims must not
    // silently return (founder decision 2026-07-07: soften).
    expect(doc).not.toMatch(/EU-only by default/);
    expect(doc).not.toMatch(/Your data stays in the EU/);
  });

  it('does not claim "never sees destination URL" as a control-plane property', () => {
    // We do log session events (navigated, interacted) with URL metadata,
    // so the absolute "never sees destination URL" overclaim was inaccurate.
    expect(doc).not.toMatch(/never sees destination URL/);
  });

  it('still links to the trust + sub-processors surface', () => {
    expect(doc).toMatch(/\/trust\/sub-processors/);
    expect(doc).toMatch(/\/trust\/security-overview/);
  });
});
