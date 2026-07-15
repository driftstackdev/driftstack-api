// W499.C — drift guard for apps/marketing-site/src/pages/about.astro.
// /about company page. Drift here either drops the WebKit C++ source
// modification framing (would let customers think Driftstack patches
// JS at runtime like every other stealth browser) or breaks the
// V-506 transparency commitments grid (would orphan customers from
// the canonical trust-promise references).
//
//   • 'A small Dutch company building one product well.' positioning.
//   • WebKit C++ source-level vs. JS runtime-patching framing.
//   • 3-card Posture: EU-resident-by-default sub-processors + no
//     behavioural data + Honest scope without certification promises.
//   • V-506 4-card Operating commitments: security audit cadence /
//     DR rehearsed / sub-processor change-log Article 28(2) /
//     source escrow.
//   • Company facts 6-entry dl: Entity Dutch BV / HQ Netherlands /
//     Focus one-product-narrow / Funding independent customer-funded /
//     Sub-processors link / Contact hello@driftstack.dev.
//   • Free-tier bottom CTA: one profile / 20-minute sessions /
//     no card / perpetual.
//
// 2026-07-03 Fleet v2 re-skin: shared PageHero/Section/IconTile/
// CtaBand recipes + AA-safe accent-text links. All pinned claims
// byte-identical; only the sub-processors-anchor class and the CTA
// pin (CtaBand props) changed shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/about.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W499.C apps/marketing-site/src/pages/about.astro content parity', () => {
  const body = read(LIB);

  it("R9 hero framing (capability-led, no solo-founder identity) + 2026-05-16 honesty pass: 'One engine. One product. Engineered for fidelity.' + 'iPhone Safari sessions on demand, built on real WebKit — the same engine on every physical iPhone, with nothing patched at runtime' positioning (was 'real iPhone Safari sessions' — reframed to 'real WebKit' since we build the WebKit engine, not the literal Safari binary) + 'EU-resident infrastructure, deliberately narrow scope' framing.", () => {
    // S20c 2026-07-06 plain-language pass: same facts, plain words
    // lead; "patched at runtime" kept as the precise term in parens,
    // EU-residency stated plainly with the term in parens.
    // S30 2026-07-07 (founder decision: soften): hero scoped to "your
    // account data" + "(EU-resident control plane)" — blanket "your
    // data" / "EU-resident infrastructure" over-reached since R2-held
    // file objects replicate EU + US.
    expect(body).toMatch(/One engine\. One product\. Engineered for fidelity\./);
    expect(body).toMatch(
      /Driftstack ships iPhone Safari sessions on demand, built on\s+real <a href="\/glossary\/#webkit"[^>]*>WebKit<\/a>\s+— the same engine every physical iPhone runs — with nothing\s+quietly modified while the browser is running \("patched at\s+runtime"\), so there's nothing for detection systems to spot\./,
    );
    expect(body).toMatch(
      /Our servers and your account data live in the EU \(EU-resident\s+control plane\), and the scope stays deliberately narrow: one\s+product, two ways to use it, no land-grab\./,
    );
    expect(body).not.toMatch(/Driftstack ships real iPhone Safari sessions/);
    // S30 negative pin — the blanket form must not silently return.
    expect(body).not.toMatch(/your data live in the EU \(EU-resident\s+infrastructure\)/);
  });

  it("WebKit source-code framing pinned (R6 plain-English rewrite + 2026-05-16 unique-per-session contrast): 'we run Apple's WebKit source code, the same engine that ships on every real iPhone' kept; the contrast paragraph now names the 100% unique canvas/WebGL hashes competitors leak as the literal opposite of a real iPhone returning the same hash as millions of others", () => {
    // S20c 2026-07-06 plain-language pass: plain words lead
    // ("patching the browser's behaviour on the fly"), the precise
    // terms (rewriting JavaScript at runtime, canvas + WebGL hashes)
    // kept with inline glosses; canvas links to the glossary.
    expect(body).toMatch(
      /Most stealth browsers fake an iPhone by patching the\s+browser's behaviour on the fly \(rewriting JavaScript at\s+runtime\)\. Detection systems are built to catch exactly that —\s+the fingerprint values those tools return, like the\s+<a href="\/glossary\/#canvas-hash"[^>]*>canvas<\/a>\s+and WebGL hashes \(values derived from how the browser draws\s+an invisible test image\), come out 100% unique per session:\s+the literal opposite of a real iPhone, which returns\s+the same hash as millions of other iPhones\. Driftstack takes\s+a different approach: we run Apple's WebKit source code, the\s+same engine that ships on every real iPhone\./,
    );
  });

  it('EU-resident card states the accurate residency posture: compute + database are EU-resident, uploaded files sit on Cloudflare R2 (default jurisdiction, can replicate outside the EU — S30 2026-07-07 founder decision: soften), and session execution + a few processors transfer to the US under SCCs + EU-US DPF (matches the real /trust/sub-processors list — Anthropic/MacStadium/LiveKit are US). No vendor names on the about page (moved to /trust/sub-processors); a link to the dedicated page replaces the vendor enumeration.', () => {
    expect(body).toMatch(/Compute and database run in the EU\./);
    expect(body).toMatch(
      /Uploaded files \(avatars,\s+for example\) sit on Cloudflare's R2 storage, which can\s+replicate outside the EU\./,
    );
    // S30 negative pin — the blanket object-storage-in-EU claim must
    // not silently return.
    expect(body).not.toMatch(/Compute, database, and object storage all run in the EU/);
    expect(body).toMatch(
      /Session execution and a few processors[\s\S]{0,140}transfer to the US\s*\n?\s*under Standard Contractual Clauses \+ the EU-US Data Privacy\s*\n?\s*Framework — no undisclosed flows\./,
    );
    // Drift sentinel — the absolute "single-region / no transatlantic
    // flows" claim contradicted the real sub-processor list. MUST NOT
    // come back.
    expect(body).not.toMatch(/Single-region — no silent transatlantic data/);
    // 2026-07-03 Fleet v2 — inline links moved to the AA-safe accent
    // tone (text-tk-accent-text; raw text-tk-accent fails WCAG AA as
    // text on the dark background).
    expect(body).toMatch(
      /<a href="\/trust\/sub-processors\/" class="text-tk-accent-text underline">\/trust\/sub-processors<\/a>/,
    );
    // Vendor names must not appear in the about-page splash strip
    // (still appear in security.astro and /trust/sub-processors, both
    // legitimate compliance surfaces).
    expect(body).not.toMatch(/Compute in Hetzner Falkenstein\./);
    expect(body).not.toMatch(/Database on Neon EU\./);
    expect(body).not.toMatch(/Object\s*\n?\s*storage on Cloudflare R2 EU\./);
  });

  it("'No behavioural data collection' posture: 'We don't log your destination URLs, response bodies, or session content. We don't train models on your traffic. We don't sell datasets. The control plane sees session metadata and license validity — that's the entire surface we touch.' — pinned so the 4-state no-collection commitment (no URL log + no body log + no training + no sale) + the 'metadata + license validity' scope all survive (drift to dropping would weaken the privacy posture marketing customers evaluate Driftstack on)", () => {
    // S20c 2026-07-06 plain-language pass: the metadata+license scope
    // is now stated plainly ("its ID, when it started and stopped")
    // with the precise terms (control plane, session metadata) in
    // parens — same 4-state no-collection commitment, same scope.
    expect(body).toMatch(
      /We don't log your destination URLs, response bodies, or\s+session content\. We don't train models on your traffic\. We\s+don't sell datasets\. Our coordination service \(the control\s+plane\) sees only the basics about each session — its ID,\s+when it started and stopped \(session metadata\) — and whether\s+your license is valid\. That's everything we touch\./,
    );
  });

  it("'Honest scope' posture pins shipped behavioural input and recipes without certification promises", () => {
    // S20c 2026-07-06 plain-language pass: plain words lead (touch/
    // scroll/typing from real human recordings; save/view/list/delete
    // a recipe), precise terms (behavioural input engine, per-profile
    // persona, recipe execution) kept in parens. Same v1.0/v1.1 facts.
    expect(body).toMatch(
      /We say no to things we can't ship well\. Touch, scroll, and\s+typing that come from real human recordings and move like a\s+real hand — each profile keeping its own habits \(the\s+behavioural input engine, with a per-profile persona\) — ship\s+at v1\.0\./,
    );
    expect(body).toMatch(
      /recipe library\s+is live at v1\.0: save a finished agent-session as a\s+replayable step-by-step recipe, then view, list, or delete\s+your saved recipes\./,
    );
    expect(body).not.toMatch(/Running a saved recipe[\s\S]{0,80}v1\.1/);
    expect(body).not.toMatch(/SOC 2|ISO 27001/i);
    // Drift sentinel — the pre-slice-143 "recipe libraries are Phase 3"
    // shape was wrong (contradicted slice 121's roadmap NOW promotion
    // + the live docs/api/recipes.md page). MUST NOT come back.
    expect(body).not.toMatch(/Behavioural simulation\s*\n?\s*and recipe libraries are Phase 3/);
    // Drift sentinel — the behavioural input engine ships at v1.0 (index.astro
    // markets it live, packages/behavioural-simulation is prod-wired), so the
    // stale "Behavioural simulation is Phase 3" claim MUST NOT come back.
    expect(body).not.toMatch(/Behavioural simulation\s*\n?\s*is Phase 3/);
    // Drift sentinel — the read/management path shipped at v1.0, so the
    // old "write-only form" framing is now inaccurate. MUST NOT come back.
    expect(body).not.toMatch(/recipe library is live at v1\.0 in its write-only form/);
  });

  it('V-506 Operating commitments doc-comment framing pinned: \'transparency commitments. Surfaces public-facing trust signals already shipped (security audit cadence, DR runbooks, incident protocol, source-escrow for self-hosted) so the about page is not just "what we are" but "what we commit to". Visible in the About narrative because customers evaluating us read this page before /security and /trust.\' — pinned so the why-on-about-not-just-trust placement rationale survives', () => {
    expect(body).toMatch(
      /<!-- V-506 — transparency commitments\. Surfaces public-facing\s*\n?\s*trust signals already shipped \(security audit cadence, DR\s*\n?\s*runbooks, incident protocol, source-escrow for self-hosted\)/,
    );
  });

  it('V-506 4-card commitments grid (F-5 — "Pre-launch" framing dropped per Issue 5; card titles now describe the ongoing cadence, not the launch-window milestone): Per-merge security audit (→ /security) + DR rehearseable on staging (→ /trust/incidents) + Sub-processor change-log per Article 28(2) (→ /trust/sub-processors) + Source escrow for Enterprise + Self-hosted (→ /faq#acceptable-use)', () => {
    // S20c 2026-07-06 plain-language pass: card titles lead with the
    // plain promise; the precise anchors (Article 28(2), source
    // escrow, staging rehearsal) stay in the title or body.
    expect(body).toMatch(/Per-merge security audit, on a cadence/);
    expect(body).toMatch(/Disaster recovery, rehearsed before it's needed/);
    expect(body).toMatch(/30 days' warning before we change vendors — Article 28\(2\)/);
    expect(body).toMatch(/If we ever shut down, you keep the software \(source escrow\)/);
    expect(body).toMatch(/href="\/security\/"/);
    expect(body).toMatch(/href="\/trust\/incidents\/"/);
    expect(body).toMatch(/href="\/trust\/sub-processors\/"/);
    expect(body).toMatch(/href="\/faq\/#acceptable-use"/);
    // F-5 — "Pre-launch" prefix must not return on these card titles.
    expect(body).not.toMatch(/Pre-launch security audit, on a cadence/);
    expect(body).not.toMatch(/Disaster recovery rehearsed pre-launch/);
  });

  it('11-scenario DR framing pins the complete roster and ongoing staging-before-production rehearsal contract', () => {
    // S20c 2026-07-06 plain-language pass: every scenario keeps its
    // precise name with a plain gloss in parens; the count + coverage
    // commitment is unchanged.
    expect(body).toMatch(
      /Eleven disaster-recovery \(DR\) scenarios documented with\s+concrete recovery commands — host loss \(a dead server\),\s+Postgres corruption \(the database\), Redis loss \(the cache\),\s+R2 object loss \(stored files\),\s+signing-key rotation under attack \(replacing a compromised\s+key mid-incident\), bad deploys, cert renewal failures\s+\(expired security certificates\), Cloudflare Pages\s+regressions \(our website host breaking\), and a\s+multi-day Hetzner regional outage \(our hosting provider\s+losing a region for days\)\./,
    );
    expect(body).toMatch(
      /Every\s+scenario is rehearseable on staging — our test copy of the\s+platform — before the same recovery procedure is ever used\s+against production\./,
    );
  });

  it("Sub-processor change-log framing pinned: 'Every change to our sub-processor list (additions, removals, region migrations) is published 30 days before it takes effect at /trust/sub-processors. Customers get a right-of-objection window to terminate the affected portion of service if a new sub-processor doesn't meet their requirements.' — pinned so the 30-day-pre-notice + the right-of-objection commitment survive (drift to dropping the 30-day would lose the Article 28(2)-aligned advance notice; drift to dropping right-of-objection would weaken the data-processor contractual story)", () => {
    // S20c 2026-07-06 plain-language pass: the card now opens with
    // the plain definition ("Sub-processors are the outside companies
    // that handle customer data for us"); the 30-day pre-notice and
    // the right-of-objection window both survive verbatim-in-intent.
    expect(body).toMatch(
      /Sub-processors are the outside companies that handle\s+customer data for us\./,
    );
    expect(body).toMatch(
      /Every change to our sub-processor\s+list \(additions,\s+removals, region migrations\) is published 30 days\s+before it takes effect/,
    );
    expect(body).toMatch(
      /If a new sub-processor doesn't meet your\s+requirements, those 30 days are your right-of-objection\s+window: you can object and terminate the affected portion\s+of service\./,
    );
  });

  it("Source-escrow framing pinned: 'Enterprise customers and Self-hosted licensees get access to the WebKit fork + control-plane source under a written escrow agreement. If Driftstack sunsets the cloud service, escrow releases the source so customers can continue running on their own hardware indefinitely.' — pinned so the if-we-disappear customer-continuation promise survives (drift to dropping would orphan customers from the 'what if Driftstack goes away?' answer that's a deal-breaker for compliance-conscious buyers)", () => {
    // S20c 2026-07-06 plain-language pass: source-code escrow said
    // plainly (neutral third party holds a copy); the precise terms
    // (WebKit fork, control-plane source) kept in the sentence.
    expect(body).toMatch(
      /Enterprise customers and Self-hosted licensees get\s+access to our source code — the modified WebKit engine\s+\(the WebKit fork\) \+ the control-plane source —\s+under a written escrow agreement: a neutral third party\s+holds a copy\./,
    );
    expect(body).toMatch(
      /If Driftstack\s*\n?\s*sunsets the cloud service, escrow releases the source\s*\n?\s*so customers can continue running on their own\s*\n?\s*hardware indefinitely\./,
    );
  });

  it("R9 Company facts 6-entry dl: Entity Dutch BV (legal entity, kept) + Headquarters Netherlands + Focus 'One product, deliberately narrow' + Funding 'Independent — customer-funded' + Sub-processors link + Contact hello@driftstack.dev — replaces 'Team Solo founder + contractors' + 'Bootstrapped — no VC' which read as indie-builder framing; capability + funding-model surfaces stay legitimate", () => {
    expect(body).toMatch(/<dd class="text-sm text-tk-ink">Dutch BV<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-tk-ink">Netherlands<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-tk-ink">One product, deliberately narrow<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-tk-ink">Independent — customer-funded<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-tk-ink">hello@driftstack\.dev<\/dd>/);
  });

  it("Free-tier bottom CTA: 'Want to try it?' + 'Start free — one profile, 20-minute sessions on real iPhone Safari, no card required. Perpetual, no expiry.' + 'Start free' button → /pricing#free — pinned so the free-tier value-prop (one profile / 20-minute / no card / perpetual) + the CTA destination all survive (drift would re-introduce the retired trial-pack framing). 2026-07-03 Fleet v2 — the CTA is the shared CtaBand component, so destination + button label are pinned via its props.", () => {
    expect(body).toMatch(/Want to try it\?/);
    expect(body).toMatch(
      /Start free — one profile, 20-minute sessions on real\s*\n?\s*iPhone Safari, no card required\. Perpetual, no expiry\./,
    );
    expect(body).toMatch(/primaryHref="\/pricing\/#free"/);
    expect(body).toMatch(/primaryLabel="Start free"/);
    expect(body).not.toMatch(
      /(?:href|primaryHref)="\/(?:glossary|security|trust\/incidents|trust\/sub-processors|faq|pricing)(?:#|"|$)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
