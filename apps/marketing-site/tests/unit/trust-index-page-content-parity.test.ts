// W374.A — drift guard for marketing-site /trust (trust center
// landing) page content. V-477. Existing trust-index-landing-
// baseline + trust-page-data-source-parity tests cover route
// shape. This guard pins the load-bearing trust-evaluation
// claims a procurement / compliance reader anchors on:
//
//   • 6 trust-hub cards in canonical order: Security /
//     Sub-processors / Incidents / Legal (DPA·Privacy·Terms·AUP)
//     / Compliance / Security overview. Each cross-links to its
//     companion page on this same domain.
//   • Live <StatusBadge /> component rendered in hero (real-
//     time platform-health surfacing without re-implementing).
//   • 6 "quick reference" dl entries pinned (questions buyer
//     evaluations always ask): data residency, destination URL
//     visibility, API-key staff-recoverability, DPA shape,
//     incident-response SLA, security-questionnaire path.
//   • Hetzner Nuremberg + Neon Frankfurt + R2 EU residency
//     verbatim claim pinned.
//   • Scrypt-hashed-at-rest + 24-hour rotation grace claim
//     pinned (aligned with /security V-503 + /changelog).
//   • CAIQ / VSAQ / vendor portals questionnaire-welcome claim.
//   • mailto:support@driftstack.dev escape hatch pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/trust/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W374.A marketing-site /trust (trust center landing) page content parity', () => {
  const body = read(PAGE);

  it('V-477 framing comment pinned (one-bookmark trust-hub for buyer evaluations)', () => {
    expect(body).toMatch(/V-477 — trust center landing/);
    expect(body).toMatch(
      /Aggregates the customer-trust\s*\n?\s*\/\/\s*surfaces \(security, sub-processors, legal documents, incident\s*\n?\s*\/\/\s*history\) on a single page/,
    );
  });

  it('7 canonical trust-hub cards pinned with cross-links to companion pages (Cumulative rig card added 2026-05-16 when /trust/cumulative-rig methodology page shipped)', () => {
    for (const [href, heading] of [
      ['/security', 'Architecture + posture →'],
      ['/trust/sub-processors', 'Live list + regions →'],
      ['/trust/incidents', 'Past events + post-mortems →'],
      ['/legal/dpa', 'DPA · Privacy · Terms · AUP →'],
      ['/trust/compliance', 'Certifications + pen-test + disclosure →'],
      ['/trust/security-overview', "Evaluator's checklist →"],
      ['/trust/cumulative-rig', 'Signal-by-signal methodology →'],
    ] as const) {
      expect(body, `card cross-link missing: ${href}`).toMatch(
        new RegExp(`href="${href.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"`),
      );
      expect(body, `card heading missing: ${heading}`).toContain(heading);
    }
  });

  it('companion pages exist for each card cross-link (no dangling refs)', () => {
    for (const path of [
      'apps/marketing-site/src/pages/security.astro',
      'apps/marketing-site/src/pages/trust/sub-processors.astro',
      'apps/marketing-site/src/pages/trust/incidents.astro',
      'apps/marketing-site/src/pages/legal/dpa.md',
      'apps/marketing-site/src/pages/trust/compliance.astro',
      'apps/marketing-site/src/pages/trust/cumulative-rig.astro',
      'apps/marketing-site/src/pages/trust/security-overview.astro',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, path)), `companion page missing: ${path}`).toBe(true);
    }
  });

  it('<StatusBadge /> component rendered in hero (live platform-health surfacing)', () => {
    expect(body).toMatch(/<StatusBadge \/>/);
    expect(body).toMatch(/import StatusBadge from '\.\.\/\.\.\/components\/StatusBadge\.astro';/);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/components/StatusBadge.astro')),
    ).toBe(true);
  });

  it('6 quick-reference dl entries pinned (questions buyer evaluations always ask)', () => {
    for (const dt of [
      'Where is data hosted?',
      'Do you see our destination URLs?',
      'Are API keys recoverable by staff?',
      'How do we get a DPA on file?',
      "What's the incident-response SLA?",
      'How do we get a security questionnaire answered?',
    ]) {
      expect(body, `quick-ref question missing: ${dt}`).toContain(dt);
    }
  });

  it('residency claim pinned: Hetzner Nuremberg / Neon Frankfurt / Cloudflare R2 EU', () => {
    expect(body).toMatch(
      /EU only\. Compute \(Hetzner Nuremberg\), database \(Neon Frankfurt\),\s+object storage \(Cloudflare R2 EU jurisdiction\)\./,
    );
  });

  it('scrypt-hashed-at-rest + 24-hour rotation grace claim pinned (aligned with /security)', () => {
    expect(body).toMatch(/Keys are scrypt-hashed at rest\./);
    expect(body).toMatch(/A database breach surfaces\s+hashes, not keys/);
    expect(body).toMatch(/rotate via the dashboard's\s+24-hour grace flow/);
  });

  it('"session traffic exits through your egress" + "Driftstack orchestrates; proxy carries the bytes" framing pinned', () => {
    expect(body).toMatch(
      /Session traffic exits through your egress \(the SOCKS5 \/\s+WireGuard \/ OpenVPN proxies you configure\)\. Driftstack\s+orchestrates the session; the proxy carries the bytes\./,
    );
  });

  it('DPA pre-signed-by-Driftstack + Article 28(2) SCC framing pinned', () => {
    // Astro wraps the <a> tag awkwardly; check the substantive
    // copy fragments separately.
    expect(body).toMatch(/The DPA at <a href="\/legal\/dpa"/);
    expect(body).toMatch(/is pre-signed by Driftstack; counter-signing acceptance closes/);
    expect(body).toMatch(/Standard SCCs apply for any non-EU\s+transfer named in Annex 3/);
  });

  it('F-5 (Issue 5) self-serve-tier SLA honesty pinned: "Self-serve tiers operate without a contractual uptime SLA" (was "Pre-launch we don\'t publish a contractual SLA" — reframed per Issue 5 to drop the launch-window label; same scope-limit on the SLA promise)', () => {
    // Load-bearing honesty claim — contractual SLAs only on Self-
    // hosted SKUs + Enterprise. A future "we have an SLA"
    // softening must update this copy first.
    expect(body).toMatch(
      /Self-serve tiers operate without a contractual uptime SLA —\s+we publish incidents at/,
    );
    expect(body).toMatch(/Self-hosted SKUs and Enterprise\s+tiers carry contractual SLA terms/);
    expect(body).not.toMatch(/Pre-launch we don't publish a contractual SLA/);
  });

  it('CAIQ / VSAQ / vendor-portal questionnaire-welcome claim pinned', () => {
    expect(body).toMatch(/CAIQ \/\s+VSAQ \/ vendor portals all welcome/);
    expect(body).toMatch(/CAIQ, VSAQ, custom enterprise vendor questionnaires/);
  });

  it('mailto:support@driftstack.dev escape hatch pinned (questionnaire fill-out)', () => {
    expect(body).toMatch(/mailto:support@driftstack\.dev/);
    expect(body).toMatch(/Bring the questionnaire\. We'll fill it\./);
    expect(body).toMatch(/we write line-by-line within a working day/);
  });

  it('hero title pinned: "One bookmark for everything compliance-relevant."', () => {
    expect(body).toMatch(/One bookmark for everything compliance-relevant\./);
    expect(body).toMatch(
      /Security architecture, sub-processor list, legal agreements,\s+and incident history/,
    );
  });
});
