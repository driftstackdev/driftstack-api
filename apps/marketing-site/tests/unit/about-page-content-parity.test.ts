// W367.A — drift guard for marketing-site /about page content.
// V-506 + V-503 cross-links. Existing tests cover narrative
// baseline + company-info + page parity; this guard pins the
// load-bearing trust claims a prospect reads before signing:
//
//   • Posture 3-card section: EU-resident / no-behavioural-data
//     / honest-scope. These are the headline trust commitments;
//     a future copy softening that drops one would weaken the
//     pre-purchase trust narrative.
//   • V-506 operating-commitments 4-card section: pre-launch
//     security audit + DR rehearsal + sub-processor Article 28(2)
//     change-log + source-escrow. Each has a verifiable public
//     URL (/security, /trust/incidents, /trust/sub-processors,
//     /faq#acceptable-use).
//   • Company facts: Dutch BV + Netherlands HQ + Solo founder
//     + Bootstrapped no-VC + sub-processors cross-link + hello@.
//   • Free-tier CTA cross-link points at /pricing#free
//     with the one-profile / 20-minute-manual / no-card framing.
//   • Source-modified WebKit framing (not JS-runtime-patches)
//     pinned — load-bearing engineering differentiator.
//
// 2026-07-03 Fleet v2 re-skin: the page moved to the shared
// PageHero/Section/IconTile/CtaBand recipes (Band-A hero "We build
// one thing: real iPhones in the cloud." with the pinned positioning
// line as mono small print). Every claim below is byte-identical;
// only the CTA pin changed shape (CtaBand primaryHref prop).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/about.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W367.A marketing-site /about page content parity', () => {
  const body = read(PAGE);

  it('posture 3-card section pinned: EU-resident / no-behavioural-data / honest-scope (2026-09-15 customer-copy pass: the EU heading names what is EU-resident — servers and database — with no "control plane"; the scoping the old parenthetical carried now lives in the heading itself)', () => {
    expect(body).toMatch(
      /<h3 class="font-semibold text-tk-ink">Servers and database in the EU<\/h3>/,
    );
    expect(body, 'the internal term must not return on this page').not.toMatch(/control plane/);
    expect(body).toMatch(
      /<h3 class="font-semibold text-tk-ink">No behavioural data collection<\/h3>/,
    );
    expect(body).toMatch(/<h3 class="font-semibold text-tk-ink">Honest scope<\/h3>/);
  });

  it('EU control-plane posture is accurate: compute + database are EU-resident, uploaded files sit on Cloudflare R2 (default jurisdiction, can replicate outside the EU — S30 2026-07-07 founder decision: soften; supersedes the "object storage all in the EU" claim), and session execution + a few processors transfer to the US under SCCs + EU-US DPF (matches the real /trust/sub-processors list — Anthropic/MacStadium/LiveKit are US). No vendor names on the about-page splash; the dedicated sub-processor page carries the per-vendor breakdown.', () => {
    expect(body).toMatch(/Compute and database run in the EU\./);
    expect(body).toMatch(
      /Uploaded files \(avatars,\s*for example\) sit on Cloudflare's R2 storage, which can\s*replicate outside the EU\./,
    );
    // S30 negative pin — the blanket object-storage-in-EU claim must
    // not silently return.
    expect(body).not.toMatch(/Compute, database, and object storage all run in the EU/);
    // 2026-09-15 customer-copy pass: the transfer disclosure names what
    // transfers (running sessions, the optional AI agent, the live video
    // stream) without naming how sessions are run; the SCC gloss moved
    // inline. The US-transfer + SCC + DPF disclosure itself is unchanged.
    expect(body).toMatch(
      /Running sessions, the optional AI agent, and the live video\s*stream transfer data to the US under Standard Contractual\s*Clauses \(the EU's standard legal contract for sending data\s*abroad\) and the EU-US Data Privacy Framework\. Nothing is\s*transferred that isn't disclosed\./,
    );
    expect(body, 'how sessions are run is not customer copy').not.toMatch(/Mac fleet/);
    // Drift sentinel — the absolute "single-region / no transatlantic
    // flows" claim contradicted the real sub-processor list (US
    // processors under SCCs + DPF). It MUST NOT come back.
    expect(body).not.toMatch(/Single-region — no silent transatlantic data/);
    expect(body).toMatch(/href="\/trust\/sub-processors\/"/);
    expect(body).not.toMatch(/Compute in Hetzner Falkenstein/);
    expect(body).not.toMatch(/Database on Neon EU/);
    expect(body).not.toMatch(/Object\s+storage on Cloudflare R2 EU/);
    expect(body).not.toMatch(/Email through Postmark EU\s+sending region/);
  });

  it('no-behavioural-data 4 specifics pinned (URLs / bodies / training / sale)', () => {
    expect(body).toMatch(
      // V-789 — the destination-URL denial was retracted; see
      // marketing-site-pages-about-content-parity.test.ts for the full reasoning.
      /We don't log response bodies or session content, we don't\s+train models on your traffic, and we don't sell datasets\./,
    );
    expect(body).toMatch(/we don't\s+train models on your traffic/i);
    expect(body).toMatch(/we don't sell datasets/i);
    expect(body, 'the retracted denial must not return').not.toMatch(
      /don't log your destination URLs/i,
    );
  });

  it('honest-scope does not advertise certification plans', () => {
    expect(body).not.toMatch(/SOC 2|ISO 27001/i);
  });

  it('F-5 (Issue 5) V-506 operating-commitments 4 cards pinned (current-scale framing, no "Pre-launch" labels per Issue 5) + each has a verifiable public URL', () => {
    expect(body).toContain('Operating commitments');
    // S20c 2026-07-06 plain-language pass: card titles lead with the
    // plain promise; the precise terms (staging rehearsal, Article
    // 28(2), source escrow) stay in the title or body.
    // 2026-09-15 customer-copy pass: the audit card title says what the
    // customer gets (ongoing audits, published findings), not the
    // engineering process ("per-merge", "cadence").
    expect(body).toMatch(/Ongoing security audits, with findings published/);
    expect(body).not.toMatch(/Per-merge security audit/);
    expect(body).toMatch(/Disaster recovery, rehearsed before it's needed/);
    expect(body).toMatch(/30 days' warning before we change vendors — Article 28\(2\)/);
    expect(body).toMatch(/If we ever shut down, you keep the software \(source escrow\)/);
    // Each card cross-links to a verifiable public page.
    expect(body).toMatch(/href="\/security\/"/);
    expect(body).toMatch(/href="\/trust\/incidents\/"/);
    expect(body).toMatch(/href="\/trust\/sub-processors\/"/);
    expect(body).toMatch(/href="\/faq\/#acceptable-use"/);
    // F-5 — "Pre-launch" labels must not return.
    expect(body).not.toMatch(/Pre-launch security audit, on a cadence/);
    expect(body).not.toMatch(/Disaster recovery rehearsed pre-launch/);
  });

  it('DR runbook scope pinned: 11 rehearsable scenarios (dead server / corrupted database / stored files / certificate / multi-day hosting outage) — 2026-09-15 customer-copy pass: each scenario is named in plain words, with no vendor or component names', () => {
    expect(body).toMatch(
      /Eleven disaster scenarios are written up with step-by-step\s+recovery instructions/,
    );
    // Specific scenario callouts — a future copy edit that drops
    // any of these forces a discussion about coverage.
    for (const scenario of [
      'a dead server',
      'a corrupted database',
      'loss of the cache or of stored files',
      'a compromised signing',
      'a multi-day outage at our hosting',
    ]) {
      expect(body, `DR scenario missing: ${scenario}`).toContain(scenario);
    }
  });

  it('Article 28(2) sub-processor 30-day notice + right-of-objection window pinned', () => {
    expect(body).toMatch(/published 30 days\s+before it takes effect/);
    expect(body).toMatch(/right-of-objection\s+window/); // S20c 2026-07-06: whitespace-flexible (source reflow)
  });

  it('source-escrow framing: "Driftstack sunsets the cloud service" insurance commitment', () => {
    expect(body).toMatch(
      /If Driftstack\s+sunsets the cloud service, escrow releases the source\s+so customers can continue running on their own\s+hardware indefinitely/,
    );
  });

  it('R9 company facts: Dutch BV (legal entity, kept for legitimate transparency) / Netherlands HQ / "One product, deliberately narrow" focus / "Independent — customer-funded" — replaces the prior solo-founder/no-VC framing which read as indie-builder rather than enterprise-grade', () => {
    expect(body).toMatch(/<dd class="text-sm text-tk-ink">Dutch BV<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-tk-ink">Netherlands<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-tk-ink">One product, deliberately narrow<\/dd>/);
    expect(body).toMatch(/<dd class="text-sm text-tk-ink">Independent — customer-funded<\/dd>/);
    expect(body).toContain('hello@driftstack.dev');
  });

  it('free-tier CTA cross-link points at /pricing#free + framing pinned (one profile / 20-minute / no card). 2026-07-03 Fleet v2 — the bottom CTA is now the shared CtaBand component, so the destination is pinned via its primaryHref prop.', () => {
    expect(body).toMatch(/primaryHref="\/pricing\/#free"/);
    expect(body).toMatch(/Start free — one profile, 20-minute sessions on real/);
    expect(body).toMatch(/Perpetual, no expiry\./);
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/pages/pricing.astro'))).toBe(
      true,
    );
  });

  it('source-modified-WebKit-not-JS-patches engineering claim pinned', () => {
    // Load-bearing differentiator vs every Chromium-stealth-
    // plugin competitor. A future copy softening to "stealth
    // bundles" would break the entire positioning.
    expect(body).toMatch(/we run Apple's WebKit\s+source code/);
    // 2026-09-15 customer-copy pass reflowed the line break inside the
    // sentence; the claim is unchanged.
    expect(body).toMatch(/there's nothing for\s+detection to\s+find/);
  });

  it('R9 hero claim pinned: "One engine. One product. Engineered for fidelity." + capability-led EU-residency framing — S30 2026-07-07 (founder decision: soften): "your account data" replaces the blanket "your data" since R2-held file objects replicate EU + US; 2026-09-15 customer-copy pass dropped the "(EU-resident control plane)" parenthetical, which restated the sentence in an internal term', () => {
    expect(body).toMatch(/One engine\. One product\. Engineered for fidelity\./);
    expect(body).toMatch(
      /Our servers and your account data live in the EU, and the scope\s*stays deliberately narrow/,
    );
    // S30 negative pin — the blanket form must not silently return.
    expect(body).not.toMatch(/your data live in the EU \(EU-resident\s*infrastructure\)/);
  });
});
