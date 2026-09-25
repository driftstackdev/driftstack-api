// W365.A — drift guard for marketing-site /security page (the
// public-facing security landing). V-503. The docs/security-
// overview parity test pins the deeper /docs surface; this
// guard pins the marketing-tier claims a prospective customer's
// security team reads before signing.
//
// Pinned:
//   • 6 numbered pillar slots present (transport / egress /
//     api-keys / webhooks / team-rbac / live-media-handling).
//   • Egress is framed as the SHIPPED per-profile SOCKS5 exit, with
//     UDP/QUIC routing + remote DNS stated as PROXY-DEPENDENT (the
//     only egress backend wired server-side is SocksProxyBackend)
//     — load-bearing honesty claim.
//   • Scrypt logN=15 + 30s sha256-keyed auth cache claims pinned
//     (specific, falsifiable security parameters).
//   • Webhook signature shape t=<timestamp>,v1=<hex> + 5-minute
//     replay window pinned ↔ V-359 contract.
//   • "What we don't claim" honesty block: no SOC 2 + no ISO
//     27001 + EU-default residency pinned.
//   • Sub-processor disclosure: the page cross-links the live
//     register at /trust/sub-processors, and the register data
//     module itself carries every vendor (Hetzner, Neon, Upstash,
//     Cloudflare, Postmark, Sentry, Stripe, Anthropic, Moneybird,
//     MacStadium, LiveKit, NowPayments).
//   • Threat-model in/out scope structure pinned (5 in-scope +
//     4 out-of-scope buckets).
//   • Cross-link to /v1/account/audit-log/export (GDPR Article
//     20) for audit-trail self-service.
//   • mailto:security@driftstack.dev "no NDAs" commitment pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/security.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W365.A marketing-site /security page parity', () => {
  const body = read(PAGE);

  it('6 numbered pillar slots present (transport / egress / api-keys / webhooks / rbac / live-media). 2026-07-17 (e36e5b4e2) — pillar 06 renamed from "No-customer-data-access posture" to "Live-media handling": the old pillar claimed screenshots / DOM snapshots / cookies "never reach our servers", which the Capture endpoint contradicts (they pass through the API inline and are simply not retained). The narrower implemented boundary is pinned here; the overclaimed label is negatively pinned so it cannot return.', () => {
    expect(body).toMatch(/01 · Transport/);
    expect(body).toMatch(/02 · Proxies/); // 2026-09-15: plain label; glossary "egress" linked in the body
    expect(body).toMatch(/03 · API keys/);
    expect(body).toMatch(/04 · Webhooks/);
    expect(body).toMatch(/05 · Team roles \(RBAC\)/); // S20c 2026-07-06: plain words lead, RBAC kept in parens
    expect(body).toMatch(/06 · Live-media handling/);
    expect(body).toMatch(/Live-session media is not retained by default\./);
    expect(body).not.toMatch(/06 · No-customer-data-access posture/);
    expect(body).not.toMatch(/none of it ever reaches our servers/);
  });

  it('egress framed as the SHIPPED per-profile SOCKS5 exit, with UDP/QUIC + remote DNS stated as proxy-dependent. 2026-07-17 (e36e5b4e2) — OpenVPN / WireGuard pins retired: no server-side egress backend exists (only SocksProxyBackend implements SessionEgressService), the pre-launch proxy gate skips VPN schemes, and the green sibling guard apps/server/tests/unit/security-page-doc-parity.test.ts (W246.A) forbids both words on this page. The unconditional "UDP/WebRTC/QUIC tunnelling" + "DNS leaks blocked" absolutes are negatively pinned — the impl makes both proxy-capability-dependent.', () => {
    // 2026-09-15 plain-language pass: same facts, customer words.
    expect(body).toMatch(/02 · Proxies/);
    expect(body).toMatch(/A profile can attach a SOCKS5 proxy at a public address as its\s+exit/);
    // 2026-09-15 refuter: the Test cannot MEASURE HTTP/3 before launch — the
    // native probe has no QUIC signal and apps/gui-client/src/components/
    // ProxyCapabilities.tsx renders it as an inference ("~", never green) until
    // a session or relay check measured it — so the small print says what to
    // expect, not what the proxy "carries".
    expect(body).toMatch(
      /Per-profile SOCKS5, OpenVPN or WireGuard; the Test button shows what to expect from a proxy before you launch\./,
    );
    expect(body).not.toMatch(/shows what your proxy carries/);
    // Fail-closed limitation disclosures — load-bearing.
    expect(body).toMatch(/website address lookups go through the proxy\s+too/);
    expect(body).toMatch(/Proxies on\s+private or local addresses[\s\S]{0,90}are not accepted/);
    expect(body).toMatch(
      /whether WebRTC and HTTP\/3 traffic can use the\s+proxy depends on your proxy's UDP support/,
    );
    // 2026-09-15 truth pass — the OpenVPN / WireGuard word-bans flipped to
    // positive pins. Customer-attached VPN egress IS shipped: account_proxies
    // rows carry scheme openvpn|wireguard (apps/server/src/db/schema.ts,
    // migration 0082) with AES-256-GCM secrets (apps/server/src/lib/
    // account-proxy-secret-encryption.ts), /v1/account/me/proxies CRUD is
    // live, a proxy_id resolves into the dispatch's inlineProxyConfig, the
    // .ovpn directive sweep refuses program-running lines (packages/api-types/
    // src/openvpn-directives.ts), and the public API docs (apps/docs/src/pages/
    // api/proxies.md) document all three schemes. What the old ban actually
    // guarded — claiming the SOCKS5 live connection check covers a VPN tunnel
    // — is pinned directly instead: the check is scoped to SOCKS5 and the VPN
    // check is described as what it is. The desktop app never builds a
    // proxy-less create body (apps/gui-client/src/views/ProfilesView.tsx,
    // "Every session needs a proxy").
    // 2026-09-15 refuter: the "managed exit" fallback was an INVENTED feature —
    // no Driftstack-run exit is configured for production (infra/env-templates/
    // production.env.template leaves DEFAULT_EGRESS_HOST/PORT empty on purpose:
    // "UNSET IS VALID AND DELIBERATE"; production.env carries no DEFAULT_EGRESS_*
    // line; apps/server/src/routes/agent-sessions.ts dispatches NO proxy when
    // proxy_id is omitted and a REQUIRE_PROXY=1 node refuses by name). The page
    // now says an API session names a saved proxy and that no shared Driftstack
    // exit exists; the old clause is negatively pinned so it cannot return.
    // 2026-09-15 refuter: VPN exits are tier-gated (TIER_FEATURES.free.vpnEgress
    // = false; routes/account-me.ts requireTierFeature('vpnEgress')), and the
    // line-naming refusal is OpenVPN-only (packages/api-types/src/
    // openvpn-directives.ts); a WireGuard .conf is parsed GUI-side into
    // structured fields and its PostUp/PreUp hooks are read but never consulted
    // (apps/gui-client/src/lib/parse-wireguard.ts). Both are now stated.
    expect(body).toMatch(/or an OpenVPN file \(\.ovpn\) or WireGuard file \(\.conf\)/);
    expect(body).toMatch(/VPN exits\s+are on paid plans/);
    expect(body).toMatch(/a SOCKS5 proxy can be reached\s+with a real connection through it/);
    expect(body).toMatch(/Driftstack does not run scripts\s+from VPN configs/);
    expect(body).toMatch(
      /An OpenVPN file that carries a script directive\s+is refused with the line named; from a WireGuard file only the\s+keys, addresses, endpoint, allowed IPs, DNS and MTU are read — its\s+PostUp\/PreUp hooks are never used\./,
    );
    expect(body).not.toMatch(/a file that asks it to is refused with the\s+line named/);
    expect(body).toMatch(
      /desktop app launches a profile only through a proxy or VPN you\s+attach, and a session created through the API names one of your\s+saved proxies when it is created\. Driftstack does not route your\s+traffic through a shared exit of its own\./,
    );
    expect(body).not.toMatch(/managed exit/);
    expect(body).toMatch(/We never store the pages your sessions visit/);
    // The two claims the implementation contradicts must stay gone.
    expect(body).not.toMatch(/DNS\s+leaks blocked/);
    expect(body).not.toMatch(/that many proxies drop/);
  });

  it('scrypt + 30s auth cache claims pinned (falsifiable claims; the logN=15 parameter lives on docs/security-overview)', () => {
    // 2026-09-15 plain-language pass: the tuning parameter and the
    // cache-key hash moved off the plain-terms page (see
    // security-scrypt-claim-parity for the logN pin); the algorithm
    // name, the 30-second window and the no-recovery-path claim stay.
    expect(body).toMatch(/API keys are scrambled one-way with scrypt/);
    expect(body).toMatch(
      /a key that was just checked is remembered in\s+protected short-term memory for 30 seconds/,
    );
    // The "Plaintext is returned exactly once" claim is the same
    // promise customer-dashboard /api-keys makes — load-bearing.
    expect(body).toMatch(/The readable key is shown exactly\s+once, when you create it/);
  });

  it('webhook signature shape t=<timestamp>,v1=<hex> + 5-min replay window pinned (V-359)', () => {
    expect(body).toMatch(
      /Driftstack-Signature header[\s\S]{0,80}t=&lt;timestamp&gt;,v1=&lt;hex&gt;/,
    );
    // S20c 2026-07-06: same 5-minute replay window, plain words lead.
    expect(body).toMatch(
      /Messages older than the default 5-minute timestamp\s+tolerance are rejected, so an intercepted copy can't be\s+re-sent later \("replay"\)/,
    );
    expect(body).toMatch(/verifyWebhookSignature/);
  });

  it('"What we don\'t claim" honesty block pinned (no SOC 2 / no ISO 27001 / EU-default)', () => {
    expect(body).toMatch(/<strong class="block text-tk-ink">No SOC 2\.<\/strong>/);
    expect(body).toMatch(/<strong class="block text-tk-ink">No ISO 27001\.<\/strong>/);
    expect(body).toMatch(
      /<strong class="block text-tk-ink">Data residency is EU-default\.<\/strong>/,
    );
    // EU-default stack disclosed.
    // S20c 2026-07-06: FSN datacenter code spelled out for non-engineers.
    // S30 2026-07-07 (founder decision: soften): "Cloudflare R2 EU"
    // dropped from the in-the-EU parenthetical — R2 file objects live
    // in the default jurisdiction and can replicate outside the EU.
    // 2026-09-15 plain-language pass: "Compute" -> "Servers", the
    // city dropped (this page said Falkenstein while /trust said
    // Nuremberg; the country is what the customer needs).
    expect(body).toMatch(
      /Servers and database are in the EU \(Hetzner, Germany; Neon EU;\s+Upstash EU\)\./,
    );
    expect(body).toMatch(
      /Uploaded files \(avatars, for example\) are on\s+Cloudflare R2, which can keep copies outside the EU\./,
    );
    // S30 negative pin — the blanket claim must not silently return.
    expect(body).not.toMatch(/Compute, database, object storage all in the EU/);
  });

  it('sub-processor disclosure resolves to the canonical live register (page links it; the register carries every vendor)', () => {
    // 2026-07-17 (e36e5b4e2): the page stopped duplicating a 10-name
    // inline list. That list had gone STALE and UNDER-disclosed — the
    // register also carries LiveKit (live-session media relay) and
    // NowPayments (crypto checkout). The vendor pins therefore move to
    // the register the Article 28(2) notices are cut from; the page
    // keeps the pointer + the completeness claim + a negative pin so a
    // partial inline list cannot come back.
    const register = read(resolve(REPO_ROOT, 'apps/marketing-site/src/data/sub-processors.ts'));
    for (const sp of [
      'Hetzner',
      'Neon',
      'Upstash',
      'Cloudflare',
      'Postmark',
      'Sentry',
      'Stripe',
      'Anthropic',
      'Moneybird',
      'MacStadium',
      'LiveKit',
      'NowPayments',
    ]) {
      expect(register).toContain(sp);
    }
    expect(body).toMatch(
      /live register lists every provider with its purpose, region,\s+and transfer mechanism/,
    );
    expect(body).toMatch(/including conditional services/);
    expect(body).toContain('/trust/sub-processors');
    expect(body).not.toMatch(/Hetzner, Neon, Upstash, Cloudflare, Postmark/);
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/sub-processors.md')),
    ).toBe(true);
  });

  it('threat-model structure: in-scope (5) + explicitly-out (4) buckets pinned', () => {
    expect(body).toMatch(/<h3 class="text-lg font-medium text-tk-ink">In scope<\/h3>/);
    expect(body).toMatch(/Explicitly out of scope/);
    // In-scope categories.
    expect(body).toMatch(/<strong>API key compromise<\/strong>/);
    expect(body).toMatch(/<strong>Webhook signature forgery<\/strong>/);
    expect(body).toMatch(/<strong>Session hijacking<\/strong>/);
    expect(body).toMatch(/<strong>Brute-force auth attempts<\/strong>/);
    expect(body).toMatch(/<strong>Stolen browser session token<\/strong>/);
    // Explicitly out-of-scope categories.
    expect(body).toMatch(/<strong>Customer's destination response content\.<\/strong>/);
    expect(body).toMatch(/<strong>Detection-vendor cat-and-mouse evolution\.<\/strong>/);
    expect(body).toMatch(/<strong>Customer's keyboard \/ network at the endpoint\.<\/strong>/);
    expect(body).toMatch(/<strong>Nation-state actors with sub-processor access\.<\/strong>/);
  });

  it('audit-log export pinned ↔ /v1/account/audit-log/export (GDPR Article 20)', () => {
    expect(body).toMatch(/<code class="font-mono">\/v1\/account\/audit-log\/export<\/code>/);
    expect(body).toMatch(/your data-portability right under GDPR Article 20\)/); // S20c 2026-07-06
  });

  it('cross-account-lookup-404-never-403 design constraint pinned', () => {
    // Load-bearing security invariant — the page calls this out
    // as the mitigation against cross-account enumeration.
    expect(body).toMatch(/cross-account\s+lookups return 404, never 403/);
  });

  it('mailto:security@driftstack.dev "no NDAs" commitment pinned', () => {
    expect(body).toContain('mailto:security@driftstack.dev');
    expect(body).toMatch(/no NDAs to read a one-paragraph\s+answer/);
  });

  // S26 2026-07-06 (#132) — re-pinned after the accuracy correction.
  // The old pin locked FALSE controls: "Dependabot + Renovate" (no
  // Renovate config exists) and the CycloneDX-SBOM + signed-image +
  // signature-verifying-deploy claim (no cosign/syft anywhere; the
  // deploy is a plain image build + pull). The pin now locks the
  // honest replacements: Dependabot-only (weekly, CI-gated,
  // patch-only auto-merge per .github/dependabot.yml +
  // dependabot-auto-merge.yml) and the real deploy controls
  // (lockfile-pinned installs, staging-first + CI-gated production,
  // post-deploy health-check with automatic rollback, public
  // /version SHA endpoint — deploy.yml / server-deploy.yml
  // V-549.A/B / app.ts V-195).
  // 2026-09-15 plain-language pass: the framework list, the tool name
  // (Dependabot) and the deploy-pipeline vocabulary left the customer
  // page; the same controls are pinned in customer words.
  it('supply-chain section pinned: stable stack / automatic dependency updates (no Renovate) / tested, reversible API releases that claim no approval step and no CI gate the web apps lack', () => {
    expect(body).toMatch(
      /small, stable set of well-known components\s+\(Node\.js, TypeScript, Postgres, Redis\) that rarely changes/,
    );
    expect(body).toMatch(
      /<h3 class="text-base font-medium text-tk-ink">Automatic dependency updates<\/h3>/,
    );
    expect(body).toMatch(
      /only\s+small bug-fix updates go in automatically, and anything\s+bigger waits for human review/,
    );
    // The false SBOM/signed-image claims must stay gone. (The word
    // "Renovate" may only appear inside the S26 explanatory comment;
    // "cryptographically signed" legitimately remains for webhooks.)
    expect(body).not.toMatch(/Dependabot \+ Renovate/);
    expect(body).not.toMatch(/CycloneDX format/);
    expect(body).not.toMatch(/container image\) is cryptographically signed/);
    expect(body).not.toMatch(/SBOM, in the standard/);
    // The honest deploy controls pinned.
    expect(body).toMatch(/Every software component is fixed to an exact version/);
    // 2026-09-25: a release does NOT wait for anyone's approval. The API
    // server's production deploys only after CI passes on the same commit and
    // staging has taken that commit (.github/workflows/deploy.yml), so that is
    // what the card says. The earlier "being explicitly approved" described a
    // gate that never existed.
    //
    // And the card names the API server: only deploy.yml waits for CI. The web
    // apps (dashboard, this site, docs, status, errors, admin) each deploy on a
    // push to main through their own deploy-*.yml, with no CI gate and no test
    // copy, so an unscoped "a release reaches production only after..." would
    // claim a control they do not have.
    expect(body).toMatch(
      /<h3 class="text-base font-medium text-tk-ink">API releases are tested and reversible<\/h3>/,
    );
    expect(body).toMatch(
      /A\s+release of our API server reaches production only after the\s+full automated test suite passes on it and it has run on a\s+test copy first\./,
    );
    expect(body).not.toMatch(/A\s+release reaches production only after/);
    expect(body).not.toMatch(/>Releases are tested/);
    expect(body).not.toMatch(/explicitly approved/i);
    expect(body).not.toMatch(/tested, approved, and reversible/i);
    expect(body).toMatch(/automatically rolled back if\s+that check fails/);
    expect(body).toMatch(
      /anyone can see exactly which version\s+is running at <code class="font-mono">api\.driftstack\.dev\/version<\/code>/,
    );
  });
});
