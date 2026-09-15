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
    // 2026-09-15 customer-copy pass: the "(EU-resident control plane)"
    // parenthetical restated the sentence in an internal term and is gone.
    expect(body).toMatch(
      /Our servers and your account data live in the EU, and the scope\s+stays deliberately narrow: one product, two ways to use it, no\s+land-grab\./,
    );
    expect(body, 'the internal term must not return on this page').not.toMatch(/control plane/);
    expect(body).not.toMatch(/Driftstack ships real iPhone Safari sessions/);
    // S30 negative pin — the blanket form must not silently return.
    expect(body).not.toMatch(/your data live in the EU \(EU-resident\s+infrastructure\)/);
  });

  it("WebKit source-code framing pinned (R6 plain-English rewrite + 2026-05-16 unique-per-session contrast): 'we run Apple's WebKit source code, the same engine that ships on every real iPhone' kept; the contrast paragraph now names the 100% unique canvas/WebGL hashes competitors leak as the literal opposite of a real iPhone returning the same hash as millions of others", () => {
    // 2026-09-15 customer-copy pass: the nested parentheticals
    // (rewriting JavaScript at runtime, hashes, invisible test image) are
    // gone; the hidden-test-image check is explained in one plain clause,
    // the canvas glossary link survives, and the same-value-as-millions
    // contrast + the WebKit-source-code claim are unchanged.
    expect(body).toMatch(
      /Most stealth browsers fake an iPhone by changing the\s+browser's behaviour on the fly\. Detection systems are built\s+to catch exactly that\. One common check asks the browser to\s+draw a hidden test image and compares the result \(the\s+<a href="\/glossary\/#canvas-hash"[^>]*>canvas<\/a>\s+and WebGL fingerprints\): the values those tools return come\s+out different every session — the opposite of a real iPhone,\s+which returns the same value as millions of other iPhones\.\s+Driftstack takes a different approach: we run Apple's WebKit\s+source code, the same engine that ships on every real iPhone\./,
    );
    expect(body).toMatch(
      /Nothing is changed on the fly, so there's nothing for\s+detection to find\./,
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
    // 2026-09-15 customer-copy pass: names what transfers (running
    // sessions, the optional AI agent, the live video stream) without
    // "the Mac fleet"; the SCC gloss moved inline; the disclosure itself
    // (US transfer under SCCs + DPF, nothing undisclosed) is unchanged.
    expect(body).toMatch(
      /Running sessions, the optional AI agent, and the live video\s*stream transfer data to the US under Standard Contractual\s*Clauses \(the EU's standard legal contract for sending data\s*abroad\) and the EU-US Data Privacy Framework\. Nothing is\s*transferred that isn't disclosed\./,
    );
    expect(body, 'how sessions are run is not customer copy').not.toMatch(/Mac fleet/);
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
    expect(body).not.toMatch(/Object\s*storage on Cloudflare R2 EU\./);
  });

  it("'No behavioural data collection' posture, corrected by V-789. This card used to say \"We don't log your destination URLs\" and close with \"That's everything we touch\" — a denial and a closed enumeration that BOTH contradicted Driftstack's own binding privacy policy (§3.3 lists target URL) and its own trust page (which answers 'Do you see our destination URLs?' with 'Yes'). Agent navigate intents carry a full url and are persisted verbatim into the transcript (agent-runtime.ts spreads decomposed.intents), and the driver path records origin. Three of four surfaces already matched the code; this page was the outlier. What is pinned now is the part that IS true, plus the pointer to the binding document instead of a marketing-side enumeration that can drift out of date.", () => {
    // S20c 2026-07-06 plain-language pass: the metadata+license scope
    // is now stated plainly ("its ID, when it started and stopped")
    // with the precise terms (control plane, session metadata) in
    // parens — same 4-state no-collection commitment, same scope.
    expect(body).toMatch(
      /We don't log response bodies or session content, we don't\s+train models on your traffic, and we don't sell datasets\./,
    );
    // 2026-09-15 customer-copy pass: same recorded categories (pages
    // visited, session id, timing, duration, outcome), said without
    // "control plane" / "navigations it coordinates".
    expect(body).toMatch(
      /We do record the pages you ask a session to visit, along\s+with the session id, timing, duration and outcome — running\s+and billing the service requires it\./,
    );
    // Per-occurrence negatives. A denial and a closure claim are the two shapes
    // that made this false; both must stay gone, and the page must keep pointing
    // at the binding document rather than re-enumerating categories itself.
    expect(body, 'the URL denial must not return').not.toMatch(/don't log your destination URLs/);
    expect(body, 'nor the closure claim').not.toMatch(/That's everything we touch/);
    // Trailing slashes are load-bearing, not cosmetic: without them Cloudflare
    // Pages answers 308 and the live-quality scan flags the redirect hop. These
    // two were the only slash-less internal links left on the site.
    expect(body).toMatch(/href="\/legal\/privacy\/"/);
    expect(body).toMatch(/href="\/trust\/"/);
    expect(body).toMatch(/lists every\s+category in full/);
  });

  it("'Honest scope' posture pins shipped behavioural input and recipes without certification promises", () => {
    // 2026-09-15 customer-copy pass: the internal names (behavioural
    // input engine, per-profile persona) and the v1.0 version talk are
    // gone; the shipped facts (recorded human input, per-profile habits,
    // save/replay/view/delete recipes) are unchanged.
    expect(body).toMatch(
      /We say no to things we can't ship well\. Touch, scroll, and\s+typing are built from real human recordings and move like a\s+real hand, and each profile keeps its own habits\./,
    );
    expect(body).toMatch(
      /You can also\s+save a finished agent session as a step-by-step recipe you can\s+replay, then view or delete your saved recipes\./,
    );
    expect(body).not.toMatch(/behavioural input engine|per-profile persona/);
    expect(body).not.toMatch(/Running a saved recipe[\s\S]{0,80}v1\.1/);
    expect(body).not.toMatch(/SOC 2|ISO 27001/i);
    // Drift sentinel — the pre-slice-143 "recipe libraries are Phase 3"
    // shape was wrong (contradicted slice 121's roadmap NOW promotion
    // + the live docs/api/recipes.md page). MUST NOT come back.
    expect(body).not.toMatch(/Behavioural simulation\s*and recipe libraries are Phase 3/);
    // Drift sentinel — the behavioural input engine ships at v1.0 (index.astro
    // markets it live, packages/behavioural-simulation is prod-wired), so the
    // stale "Behavioural simulation is Phase 3" claim MUST NOT come back.
    expect(body).not.toMatch(/Behavioural simulation\s*is Phase 3/);
    // Drift sentinel — the read/management path shipped at v1.0, so the
    // old "write-only form" framing is now inaccurate. MUST NOT come back.
    expect(body).not.toMatch(/recipe library is live at v1\.0 in its write-only form/);
  });

  it('V-506 Operating commitments doc-comment framing pinned: \'transparency commitments. Surfaces public-facing trust signals already shipped (security audit cadence, DR runbooks, incident protocol, source-escrow for self-hosted) so the about page is not just "what we are" but "what we commit to". Visible in the About narrative because customers evaluating us read this page before /security and /trust.\' — pinned so the why-on-about-not-just-trust placement rationale survives', () => {
    expect(body).toMatch(
      /<!-- V-506 — transparency commitments\. Surfaces public-facing\s*trust signals already shipped \(security audit cadence, DR\s*runbooks, incident protocol, source-escrow for self-hosted\)/,
    );
  });

  it('V-506 4-card commitments grid (F-5 — "Pre-launch" framing dropped per Issue 5; card titles now describe the ongoing cadence, not the launch-window milestone): Per-merge security audit (→ /security) + DR rehearseable on staging (→ /trust/incidents) + Sub-processor change-log per Article 28(2) (→ /trust/sub-processors) + Source escrow for Enterprise + Self-hosted (→ /faq#acceptable-use)', () => {
    // S20c 2026-07-06 plain-language pass: card titles lead with the
    // plain promise; the precise anchors (Article 28(2), source
    // escrow, staging rehearsal) stay in the title or body.
    // 2026-09-15 customer-copy pass: the audit card title says what the
    // customer gets, not the engineering process ("per-merge", "cadence").
    expect(body).toMatch(/Ongoing security audits, with findings published/);
    expect(body).not.toMatch(/Per-merge security audit/);
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
    // 2026-09-15 customer-copy pass: every scenario is named in plain
    // words with no vendor or component names (Postgres, Redis, R2,
    // Cloudflare Pages, Hetzner); the count + the rehearse-on-a-test-copy
    // commitment are unchanged.
    expect(body).toMatch(
      /Eleven disaster scenarios are written up with step-by-step\s+recovery instructions — a dead server, a corrupted database,\s+loss of the cache or of stored files, a compromised signing\s+key, a bad release, an expired security certificate, our\s+website host breaking, and a multi-day outage at our hosting\s+provider\./,
    );
    expect(body).toMatch(
      /Every one can be rehearsed on a test copy of the\s+platform before the same recovery steps are ever used in\s+production\./,
    );
    expect(body).not.toMatch(/Postgres|Redis|Hetzner|Cloudflare Pages/);
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
    // 2026-09-15 customer-copy pass: what is escrowed is still the
    // MODIFIED engine source plus the server software, said without
    // "fork" / "control-plane".
    expect(body).toMatch(
      /Enterprise customers and Self-hosted licensees get\s+access to our source code — our modified version of the\s+WebKit browser engine, plus the Driftstack server software —\s+under a written escrow agreement: a neutral third party\s+holds a copy\./,
    );
    expect(body).toMatch(
      /If Driftstack\s*sunsets the cloud service, escrow releases the source\s*so customers can continue running on their own\s*hardware indefinitely\./,
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
      /Start free — one profile, 20-minute sessions on real\s*iPhone Safari, no card required\. Perpetual, no expiry\./,
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
