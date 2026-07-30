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
      ['/security/', 'Architecture + posture →'],
      ['/trust/sub-processors/', 'Live list + regions →'],
      ['/trust/incidents/', 'Past events + post-mortems →'],
      ['/legal/dpa/', 'DPA · Privacy · Terms · AUP →'],
      ['/trust/compliance/', 'Compliance + disclosure →'],
      ['/trust/security-overview/', "Evaluator's checklist →"],
      ['/trust/cumulative-rig/', 'Signal-by-signal methodology →'],
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

  it('residency claim pinned: Hetzner Nuremberg / Neon Frankfurt / Cloudflare R2 EU + US replication — S30 2026-07-07 (founder decision: soften): "EU only" → "EU by default" and the false "R2 EU jurisdiction" → "EU + US replication" (R2 uses the default jurisdiction; only DB-resident data is EU-guaranteed)', () => {
    expect(body).toMatch(
      /EU by default\. Compute \(Hetzner Nuremberg\), database \(Neon Frankfurt\);\s+object storage \(Cloudflare R2, EU \+ US replication\)\./,
    );
    // S30 negative pins — the absolutist claims must not silently return.
    expect(body).not.toMatch(/EU only\./);
    expect(body).not.toMatch(/Cloudflare R2 EU jurisdiction/);
  });

  it('scrypt-hashed-at-rest + 24-hour rotation grace claim pinned (aligned with /security)', () => {
    // S20c 2026-07-06 plain-language pass: same scrypt + breach +
    // 24-hour-grace facts, plain words lead.
    expect(body).toMatch(/Keys are stored only as one-way scrypt hashes/);
    expect(body).toMatch(/staff,\s+and even a database thief, see scrambled values, not keys/);
    expect(body).toMatch(
      /rotate it in the dashboard; the old key\s+keeps working for 24 hours \(the grace window\) so nothing\s+breaks mid-switch/,
    );
  });

  it('destination-URL answer pinned: control-plane URL processing + navigation-event recording, then SOCKS5-or-managed-egress browser traffic', () => {
    // e36e5b4e2 2026-07-17 "docs: align public security claims with
    // runtime truth". The retired copy answered "No. … so the
    // addresses you visit don't pass through us" — FALSE against
    // runtime: POST /sessions/:id/navigate carries body.url through
    // the control plane, and SessionsService.navigate persists a
    // `navigated` session event (requested_origin / final_origin) for
    // the account — see apps/server/src/services/sessions.ts and
    // apps/server/src/lib/session-event-metadata.ts. The page now
    // discloses more, not less (it also names the managed-egress
    // fallback the old copy hid), so the retired false privacy claim
    // is negatively pinned and cannot silently return.
    //
    // Deliberately NOT negatively pinned: "OpenVPN / WireGuard".
    // Customer-attached VPN egress IS shipped — account_proxies rows
    // carry scheme openvpn|wireguard (apps/server/src/db/schema.ts,
    // migration 0082), the /v1/account/me/proxies CRUD is live
    // (apps/server/src/routes/account-me.ts) and a proxy_id resolves
    // into the dispatch's inlineProxyConfig (apps/server/src/lib/
    // app.ts). It is customer-documented at
    // apps/docs/src/pages/api/proxies.md and named on /, /comparison,
    // /about and /trust/security-overview. Only the E1
    // /v1/sessions/:id/proxy route is a 503 scaffold. This guard must
    // not forbid the page from naming a real capability.
    expect(body).toMatch(
      /Yes, when you send a navigate request or an agent plans one,\s+Driftstack's control plane processes the destination URL and\s+records the navigation event for your account\. The browser's\s+destination traffic then leaves through your configured public\s+SOCKS5 proxy, or through Driftstack-managed infrastructure when\s+the profile has no attached exit\./,
    );
    expect(body).not.toMatch(/addresses you visit don't pass through us/);
  });

  it('DPA pre-signed-by-Driftstack + Article 28(2) SCC framing pinned', () => {
    // Astro wraps the <a> tag awkwardly; check the substantive
    // copy fragments separately.
    expect(body).toMatch(/The DPA at <a href="\/legal\/dpa\/"/);
    // S20c 2026-07-06 plain-language pass: pre-signed + SCC facts,
    // plain words lead.
    expect(body).toMatch(/is already signed by Driftstack — sign your side and it's\s+in force/);
    expect(body).toMatch(
      /The EU's Standard Contractual Clauses \(SCCs\) cover\s+any transfer of data outside the EU listed in Annex 3 \(the\s+vendor list attached to the DPA\)/,
    );
  });

  it('F-5 SLA honesty pinned to ToS §9 (S43 2026-07-07): most plans no contractual SLA; API Scale + Enterprise carry the contractual SLA', () => {
    // Load-bearing honesty claim, aligned to the binding ToS §9
    // (S43 2026-07-07, founder-approved). The prior copy said
    // "Self-serve plans come without a contractual uptime guarantee"
    // and attributed contractual SLA terms to "Self-hosted SKUs and
    // Enterprise" — both wrong against ToS §9.2, which grants the
    // contractual SLA to API Scale (a self-serve tier) and
    // Enterprise; the self-hosted-SLA claim had no contractual basis.
    // S20c plain-language glosses retained.
    expect(body).toMatch(
      /Most plans come without a contractual uptime guarantee\s+\(an SLA\) —\s+we publish incidents at/,
    );
    expect(body).toMatch(
      /The API Scale and Enterprise\s+tiers carry a contractual SLA \(99\.9% monthly availability \+\s+a Severity-1 first-response commitment/,
    );
    expect(body).not.toMatch(/Pre-launch we don't publish a contractual SLA/);
    expect(body).not.toMatch(
      /Self-hosted packages \(SKUs\) and\s+Enterprise\s+tiers carry contractual SLA terms/,
    );
  });

  it('CAIQ / VSAQ / vendor-portal questionnaire-welcome claim pinned', () => {
    // S20c 2026-07-06 plain-language pass: CAIQ/VSAQ named as what
    // they are (standard security-questionnaire formats).
    expect(body).toMatch(
      /Standard\s+security-questionnaire formats \(CAIQ \/ VSAQ\), custom\s+spreadsheets, and vendor portals all welcome/,
    );
    expect(body).toMatch(
      /Standard security-questionnaire formats \(CAIQ, VSAQ\) and custom enterprise vendor questionnaires/,
    );
  });

  it('mailto:support@driftstack.dev escape hatch pinned (questionnaire fill-out, no unbacked turnaround clock)', () => {
    expect(body).toMatch(/mailto:support@driftstack\.dev/);
    expect(body).toMatch(/Bring the questionnaire\. We'll fill it\./);
    // e36e5b4e2 2026-07-17 — "the rest we write line-by-line within a
    // working day" was an implicit response-time SLA with no
    // contractual or operational backing: the only first-response
    // commitment that exists is ToS §9 Severity-1 on API Scale /
    // Enterprise (docs/legal/terms-of-service.md), which says nothing
    // about questionnaires. The commitment to answer every remaining
    // item survives and is pinned; the unbacked clock is negatively
    // pinned so it cannot return.
    expect(body).toMatch(/we answer the remaining items in writing/);
    expect(body).not.toMatch(/within a working day/);
  });

  it('hero title pinned: "One bookmark for everything compliance-relevant."', () => {
    expect(body).toMatch(/One bookmark for everything compliance-relevant\./);
    expect(body).toMatch(
      /Security architecture, sub-processor list, legal agreements,\s+and incident history/,
    );
  });
});
