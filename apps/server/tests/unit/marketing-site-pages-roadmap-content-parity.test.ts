// W499.B — drift guard for apps/marketing-site/src/pages/roadmap.astro.
// V-473 public roadmap. Drift here either drops the 'we don't
// publish dates; we publish ordering' framing (would commit
// Driftstack to specific delivery dates) or re-introduces
// internal V-NNN tags (which rotate fast and confuse customers).
//
//   • V-473 selectively-sourced + no-V-NNN-leak framing.
//   • 3-section ordering: NOW (live today) / NEXT (in active
//     engineering) / LATER (on the deck).
//   • NOW 5-item list: iPhone fingerprint parity / 3-language SDKs /
//     dashboard / webhooks / GUI client.
//   • NEXT 7-item list: status page / OAuth / API key rotation /
//     account deletion (GDPR Article 17) / recipe library / live
//     session WebRTC / workflow recording.
//   • LATER 6-item list: additional iOS / Android Chrome / WebAuthn
//     SSO / public benchmarks / self-hosted parity / AI agent layer.
//   • 'concrete demand reorders the deck' CTA framing.
//   • 2-button bottom CTA: Email us (mailto) + Try the platform
//     (/pricing#trial-pack).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/roadmap.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W499.B apps/marketing-site/src/pages/roadmap.astro content parity', () => {
  const body = read(LIB);

  it("V-473 framing pinned: 'public roadmap. Sourced selectively from the internal V-294 catalog; internal V-NNN tags are intentionally NOT exposed (they rotate fast and would confuse customers). Customer-facing groupings are Now / Next / Later, framed as feature outcomes, not engineering slices.' + 'Items here are forward-looking — no commitment to specific dates.' — pinned so the no-V-NNN-leak + no-date-commitment rationale stay explicit (drift to exposing V-NNN would couple the public roadmap to internal slice tracking)", () => {
    expect(body).toMatch(
      /\/\/ V-473 — public roadmap\. Sourced selectively from the internal V-294\s*\n?\s*\/\/ catalog; internal V-NNN tags are intentionally NOT exposed/,
    );
    expect(body).toMatch(/\/\/ Items here are forward-looking — no commitment to specific dates\./);
  });

  it("Hero framing: 'What's live, next, and further out.' + 'We don't publish dates; we publish ordering. Now ships today. Next is in active engineering and lands in the weeks ahead. Later is on the deck and will move up as the foundation supports it.' — pinned so the 'ordering not dates' commitment + the 3-bucket scope-of-meaning all survive (drift to publishing specific dates would commit Driftstack to delivery dates we can't guarantee)", () => {
    expect(body).toMatch(/What's live, next, and further out\./);
    expect(body).toMatch(
      /We don't publish dates; we publish ordering\. <strong>Now<\/strong> ships\s*\n?\s*today\. <strong>Next<\/strong> is in active engineering and lands in the\s*\n?\s*weeks ahead\. <strong>Later<\/strong> is on the deck and will move up\s*\n?\s*as the foundation supports it\./,
    );
  });

  it("'Concrete demand reorders the deck' framing pinned: 'If something on the Later list would unlock a real workload for you today, mail support@driftstack.dev — concrete demand reorders the deck.' + bottom-CTA 'Customer demand is the single best ordering signal we have' — pinned so the demand-driven-reordering commitment survives (drift to dropping would let the roadmap look fixed; drift to dropping support@ would orphan customers from the influence channel)", () => {
    expect(body).toMatch(
      /If something on the Later list would unlock a real workload for you\s*\n?\s*today, mail\s*\n?\s*<a href="mailto:support@driftstack\.dev" class="text-glow-red underline"\s*\n?\s*>support@driftstack\.dev<\/a\s*\n?\s*> — concrete demand reorders the deck\./,
    );
    expect(body).toMatch(/Customer demand is the single best ordering signal we have\./);
  });

  it("NOW section 5-item list (M.6 Path A multi-archetype): 'iPhone family fingerprint parity (15 Pro · 16 Pro · 17 lineup)' (foundation — multi-archetype + Safari 26.5 launch scope per founder verdict 2026-05-17) + 'TypeScript · Python · Go SDKs' + 'Customer dashboard at app.driftstack.dev' + 'Webhook delivery infrastructure' + 'GUI client for human operators' — pinned so the live-today scope covers the 5 customer-visible platform pillars (drift to single-archetype framing would re-introduce the v1.0 scope-mismatch the founder rejected in §6 of the orchestrator handoff)", () => {
    expect(body).toMatch(
      /title: 'iPhone family fingerprint parity \(15 Pro · 16 Pro · 17 lineup\)',/,
    );
    expect(body).toMatch(/title: 'TypeScript · Python · Go SDKs',/);
    expect(body).toMatch(/title: 'Customer dashboard at app\.driftstack\.dev',/);
    expect(body).toMatch(/title: 'Webhook delivery infrastructure',/);
    expect(body).toMatch(/title: 'GUI client for human operators',/);
    // Pre-M.6 single-archetype framing must NOT return.
    expect(body).not.toMatch(/iPhone 16 Pro · iOS 18\.7 · Safari 26\.4 fingerprint parity/);
  });

  it("NEXT section items: 'Public status page' + 'OAuth signup (Google · GitHub)' + 'API key rotation with grace window' + 'Account deletion (GDPR Article 17)' + 'Recipe library' + 'Live session WebRTC stream' + 'Workflow recording' — pinned so the active-engineering surface stays consistent (drift to dropping Account deletion would orphan the GDPR Article 17 compliance promise; drift to renaming OAuth would break the 'Continue with Google/GitHub' marketing-page framing)", () => {
    expect(body).toMatch(/title: 'Public status page',/);
    expect(body).toMatch(/title: 'OAuth signup \(Google · GitHub\)',/);
    expect(body).toMatch(/title: 'API key rotation with grace window',/);
    expect(body).toMatch(/title: 'Account deletion \(GDPR Article 17\)',/);
    expect(body).toMatch(/title: 'Recipe library',/);
    expect(body).toMatch(/title: 'Live session WebRTC stream',/);
    expect(body).toMatch(/title: 'Workflow recording',/);
  });

  it("LATER section items (M.6 Path A: older iOS archetypes split out from NOW since the launch families cover iPhone 15 Pro / 16 Pro / 17 lineup): 'Older iOS archetypes (iPhone 14 + earlier iOS)' + 'Android Chrome archetypes' + 'Hardware-key MFA (WebAuthn)' + 'Public benchmark page' + 'Self-hosted parity polish' + 'AI agent layer' — pinned so the on-the-deck surface covers the canonical 6 directions (drift to dropping AI agent layer would lose the bundled-or-BYOK LLM commitment that's promised in the tier configuration; drift to dropping WebAuthn would orphan the hardware-key MFA path)", () => {
    expect(body).toMatch(/title: 'Older iOS archetypes \(iPhone 14 \+ earlier iOS\)',/);
    expect(body).toMatch(/title: 'Android Chrome archetypes',/);
    expect(body).toMatch(/title: 'Hardware-key MFA \(WebAuthn\)',/);
    expect(body).toMatch(/title: 'Public benchmark page',/);
    expect(body).toMatch(/title: 'Self-hosted parity polish',/);
    expect(body).toMatch(/title: 'AI agent layer',/);
    // Pre-M.6 LATER title must NOT return — would re-imply the
    // launch-only-iPhone-16-Pro scope.
    expect(body).not.toMatch(/title: 'Additional iOS archetypes',/);
  });

  it("AI agent layer body framing: 'Optional bundled-or-BYOK LLM-driven session execution: describe a goal in natural language, the agent navigates the session against your target. The plumbing for both bundled and BYOK billing is already in tier configuration; the agent layer itself is the work.' — pinned so the dual bundled+BYOK billing model + the 'plumbing is done, agent is the work' framing survive (drift to dropping BYOK would lose the customer-bring-your-own-LLM commitment)", () => {
    expect(body).toMatch(
      /Optional bundled-or-BYOK LLM-driven session execution: describe a goal in natural language, the agent navigates the session against your target\. The plumbing for both bundled and BYOK billing is already in tier configuration; the agent layer itself is the work\./,
    );
  });

  it("3-section header taxonomy: Now (emerald, 'Live and supported today.') + Next (oxblood, 'In active engineering.') + Later (slate, 'On the deck.') — pinned so the 3-bucket visual hierarchy (green = shipped / oxblood = active / slate = on deck) survives (drift to flattening the visual color would lose the at-a-glance 'this is live, this is coming, this is later' signal)", () => {
    expect(body).toMatch(
      /class="rounded-full bg-emerald-100 px-3 py-1 font-mono text-xs uppercase tracking-widest text-emerald-300"\s*\n?\s*>\s*\n?\s*Now/,
    );
    expect(body).toMatch(/Live and supported today\./);
    expect(body).toMatch(
      /class="rounded-full bg-glow-red\/20 px-3 py-1 font-mono text-xs uppercase tracking-widest text-glow-red"\s*\n?\s*>\s*\n?\s*Next/,
    );
    expect(body).toMatch(/In active engineering\./);
    expect(body).toMatch(/On the deck\./);
  });

  it("Bottom CTA 2-button row: 'Email us' → mailto:support@driftstack.dev (primary) + 'Try the platform' → /pricing#trial-pack (secondary) — pinned so the influence-channel + the conversion-path both stay visible at page bottom (drift to dropping Try the platform would lose the trial-pack funnel pull from a roadmap reader who's evaluating)", () => {
    expect(body).toMatch(
      /<a href="mailto:support@driftstack\.dev" class="btn-primary">Email us<\/a>/,
    );
    expect(body).toMatch(
      /<a href="\/pricing#trial-pack" class="btn-secondary">Try the platform<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
