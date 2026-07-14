// W499.B — drift guard for apps/marketing-site/src/pages/roadmap.astro.
// V-473 public roadmap. Drift here either drops the 'we don't
// publish dates; we publish ordering' framing (would commit
// Driftstack to specific delivery dates) or re-introduces
// internal V-NNN tags (which rotate fast and confuse customers).
//
//   • V-473 selectively-sourced + no-V-NNN-leak framing.
//   • 3-section ordering: NOW (live today) / NEXT (in active
//     engineering) / LATER (on the deck).
//   • NOW 10-item list: iPhone fingerprint parity / 3-language SDKs /
//     dashboard / webhooks / GUI client / status page / OAuth signup /
//     API key rotation / recipe library (write-only at v1.0) / agent
//     sessions (AI / manual / pair). The 5 launch pillars + 4
//     promoted from NEXT on 2026-05-19 + agent sessions promoted from
//     LATER on 2026-05-19 (the founder strategic-directive 2026-05-17
//     called AI chat + manual the v1.0 primary differentiator;
//     changelog entry 2026-05-18 confirms shipped — having it in
//     LATER contradicted both signals).
//   • NEXT 3-item list: account deletion (GDPR Article 17) / live
//     session WebRTC / workflow recording.
//   • LATER 5-item list: additional iOS / Android Chrome / WebAuthn
//     SSO / public benchmarks / self-hosted parity. (Agent layer
//     graduated to NOW; the old "AI agent layer" LATER entry is
//     intentionally gone — its framing called the agent the "work",
//     which is the opposite of the now-shipped reality.)
//   • 'concrete demand reorders the deck' CTA framing.
//   • 2-button bottom CTA: Email us (mailto) + Try the platform
//     (/pricing/#free).

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
    // 2026-07-03 v2 re-skin — inline accent links moved to the AA-safe
    // text-tk-accent-text token (raw --accent is a fill tone).
    expect(body).toMatch(
      /If something on the Later list would unlock a real workload for you\s*\n?\s*today, mail\s*\n?\s*<a href="mailto:support@driftstack\.dev" class="text-tk-accent-text underline"\s*\n?\s*>support@driftstack\.dev<\/a\s*\n?\s*> — concrete demand reorders the deck\./,
    );
    expect(body).toMatch(/Customer demand is the single best ordering signal we have\./);
  });

  it("NOW section 10-item list (2026-05-19 promotion: status-site + V-667.C OAuth + api-keys.rotate + write-only recipes + AI/manual/pair agent sessions joined the 5 launch pillars): 'iPhone family fingerprint parity (81 profiles, iPhone 13 → 17 Pro Max)' (S18 2026-07-04: title now a template literal interpolating DEVICE_SUPPORT.archetypeCount + .deviceFamilies from src/data/capabilities.ts, itself registry-derived — rendered output unchanged) + 'TypeScript · Python · Go SDKs' + 'Customer dashboard at app.driftstack.dev' + 'Webhook delivery infrastructure' + 'GUI client for human operators' + 'Public status page' + 'OAuth signup (Google · GitHub)' + 'API key rotation with grace window' + 'Recipe library (write-only at v1.0)' + 'Agent sessions — natural-language automation with AI / manual / pair modes' — pinned so the live-today scope covers ALL 10 shipped customer-facing pillars (drift to demoting any of them back to NEXT or LATER would mis-represent what's actually deployed; agent sessions specifically are the v1.0 primary differentiator per the founder strategic-directive 2026-05-17 and changelog 2026-05-18, so leaving them in LATER directly contradicts marketing positioning)", () => {
    expect(body).toMatch(/import \{ DEVICE_SUPPORT \} from '\.\.\/data\/capabilities\.ts';/);
    expect(body).toMatch(
      /title: `iPhone family fingerprint parity \(\$\{DEVICE_SUPPORT\.archetypeCount\} profiles, \$\{DEVICE_SUPPORT\.deviceFamilies\}\)`,/,
    );
    expect(body).toMatch(/title: 'TypeScript · Python · Go SDKs',/);
    expect(body).toMatch(/title: 'Customer dashboard at app\.driftstack\.dev',/);
    expect(body).toMatch(/title: 'Webhook delivery infrastructure',/);
    expect(body).toMatch(/title: 'GUI client for human operators',/);
    expect(body).toMatch(/title: 'Public status page',/);
    expect(body).toMatch(/title: 'OAuth signup \(Google · GitHub\)',/);
    expect(body).toMatch(/title: 'API key rotation with grace window',/);
    expect(body).toMatch(/title: 'Recipe library \(capture \+ manage at v1\.0\)',/);
    expect(body).toMatch(
      /title: 'Agent sessions — natural-language automation with AI \/ manual \/ pair modes',/,
    );
    // Pre-M.6 single-archetype framing must NOT return.
    expect(body).not.toMatch(/iPhone 16 Pro · iOS 18\.7 · Safari 26\.4 fingerprint parity/);
    // Pre-2026-05-19 NEXT-only title for recipes must NOT return —
    // promotion to NOW dropped the unbounded "Recipe library" label for
    // a scope-qualified one; once list/get/delete shipped, the qualifier
    // moved from "(write-only at v1.0)" to "(capture + manage at v1.0)".
    expect(body).not.toMatch(/title: 'Recipe library',/);
    // The read/management path shipped, so the "write-only" qualifier is
    // now inaccurate and MUST NOT come back.
    expect(body).not.toMatch(/title: 'Recipe library \(write-only at v1\.0\)',/);
  });

  it("NEXT section 3-item list (post-2026-05-19 promotion: status-site + OAuth + api-key rotation + recipes graduated to NOW; remaining surface is account deletion + WebRTC stream + workflow recording): 'Account deletion (GDPR Article 17)' + 'Live session WebRTC stream' + 'Workflow recording' — pinned so the active-engineering surface stays consistent (drift to dropping Account deletion would orphan the GDPR Article 17 compliance promise; drift to re-adding the 4 promoted items would re-introduce the stale 'NEXT' framing for things customers can already use today)", () => {
    expect(body).toMatch(/title: 'Account deletion \(GDPR Article 17\)',/);
    expect(body).toMatch(/title: 'Live session WebRTC stream',/);
    expect(body).toMatch(/title: 'Workflow recording',/);
    // Confirm the NEXT block does NOT re-list the 4 promoted titles.
    const nextBlock = body.match(/const NEXT:[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(nextBlock).not.toMatch(/Public status page/);
    expect(nextBlock).not.toMatch(/OAuth signup/);
    expect(nextBlock).not.toMatch(/API key rotation with grace window/);
    expect(nextBlock).not.toMatch(/Recipe library/);
  });

  it("LATER section 5-item list (post-2026-05-19 promotion: AI agent layer graduated to NOW; LATER now holds the genuinely-still-on-the-deck items): 'Older iOS archetypes (iPhone 12 + earlier)' + 'Android Chrome archetypes' + 'Hardware-key MFA (WebAuthn)' + 'Public benchmark page' + 'Self-hosted parity polish' — pinned so the on-the-deck surface covers the 5 directions actually still in scope for v1.1+ (drift to re-adding 'AI agent layer' here would resurrect a contradiction with the changelog 2026-05-18 + founder strategic-directive 2026-05-17)", () => {
    expect(body).toMatch(/title: 'Older iOS archetypes \(iPhone 12 \+ earlier\)',/);
    expect(body).toMatch(/title: 'Android Chrome archetypes',/);
    expect(body).toMatch(/title: 'Hardware-key MFA \(WebAuthn\)',/);
    expect(body).toMatch(/title: 'Public benchmark page',/);
    expect(body).toMatch(/title: 'Self-hosted parity polish',/);
    // Pre-M.6 LATER title must NOT return — would re-imply the
    // launch-only-iPhone-16-Pro scope.
    expect(body).not.toMatch(/title: 'Additional iOS archetypes',/);
    // Drift sentinel — the LATER block must NOT carry 'AI agent
    // layer' (post-2026-05-19 promotion to NOW). The legacy entry
    // also leaked a contradictory body: "agent layer itself is
    // the work" → which by 2026-05-18 was the opposite of true.
    const laterBlock = body.match(/const LATER:[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    expect(laterBlock).not.toMatch(/title: 'AI agent layer',/);
    expect(laterBlock).not.toMatch(/the agent layer itself is the work/);
  });

  it("Agent sessions body framing in NOW pins the 3 operational modes (AI / manual / pair) + SSE transcript + bundled/BYOK billing — drift to dropping any mode would understate the v1.0 surface; drift to dropping the SSE transcript or BYOK mention would mismatch the changelog 2026-05-18 entry that customers will read alongside the roadmap. Slice 131 corrected the BYOK framing from the aspirational '/settings → BYOK Anthropic' shape (no such dashboard UI ships at v1.0) to the honest 'via PUT /v1/account/me/byok-anthropic-key, dashboard at v1.1' shape", () => {
    expect(body).toMatch(/AI \/ manual \/ pair modes/);
    // S20c 2026-07-06 plain-language pass: all 3 modes + SSE resume +
    // opt-in AI + BYOK route + honest v1.1-dashboard state survive,
    // plain words lead with the precise terms in parens.
    expect(body).toMatch(/AI mode \(the default\) turns your message into concrete browser steps/);
    expect(body).toMatch(
      /\(Server-Sent Events\); if your connection drops, it resumes where it left off \(Last-Event-ID resume\)/,
    );
    expect(body).toMatch(/The built-in AI is opt-in and runs on an Anthropic budget we manage/);
    expect(body).toMatch(
      /bring your own Anthropic key \(BYOK\) via PUT \/v1\/account\/me\/byok-anthropic-key/,
    );
    expect(body).toMatch(
      /the server route is live today and your stored key is used automatically; the dashboard page for it lands at v1\.1/,
    );
    // Drift sentinel — the pre-slice-131 aspirational claim about a
    // dashboard "/settings → BYOK Anthropic" surface must NOT come
    // back until that UI actually ships. Pinning the regex prevents
    // future copy-edits from accidentally re-introducing the
    // marketing-vs-reality drift.
    expect(body).not.toMatch(/BYOK Anthropic ships from \/settings → BYOK Anthropic/);
  });

  it("3-section header taxonomy: Now (tk-ready family, 'Live and supported today.') + Next (tk-busy family, 'In active engineering.') + Later (muted, 'On the deck.') — pinned so the 3-bucket visual hierarchy (green = shipped / warm = active / muted = on deck) survives (drift to flattening the visual color would lose the at-a-glance 'this is live, this is coming, this is later' signal). 2026-07-03 v2 re-skin — the raw emerald/oxblood palette classes moved onto the design-system status tokens; S24 2026-07-06 — the chip LABELS read the AA-safe status-text tones (raw ready/busy are fill tones, 2.7–3.3:1 as small light-mode text) while the /30 borders keep the raw tint.", () => {
    expect(body).toMatch(
      /class="rounded-full border border-tk-ready\/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-tk-ready-text"\s*\n?\s*>\s*\n?\s*Now/,
    );
    expect(body).toMatch(/Live and supported today\./);
    expect(body).toMatch(
      /class="rounded-full border border-tk-busy\/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-tk-busy-text"\s*\n?\s*>\s*\n?\s*Next/,
    );
    expect(body).toMatch(/In active engineering\./);
    expect(body).toMatch(/On the deck\./);
  });

  it("Bottom CTA 2-button row: 'Email us' → mailto:support@driftstack.dev (primary) + 'Try the platform' → /pricing/#free (secondary) — pinned so the influence-channel + the canonical conversion path both stay visible at page bottom (drift to dropping Try the platform would lose the free-tier funnel pull from a roadmap reader who's evaluating)", () => {
    expect(body).toMatch(
      /<a href="mailto:support@driftstack\.dev" class="btn-primary">Email us<\/a>/,
    );
    expect(body).toMatch(/<a href="\/pricing\/#free" class="btn-secondary">Try the platform<\/a>/);
    expect(body).not.toMatch(/href="\/pricing#free"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
