// W572.C — drift guard for /docs/marketing/v214-density-audit.md.
// V-214 marketing-site visitor-density audit. Drift here either
// widens the audit beyond /index + /pricing + /faq, removes the
// "leave dense" exception for dev-audience answers, or unsets the
// minimal-not-rewrite framing.
//
//   • V-214. Index + pricing + faq audit.
//   • Scoped-out: /security + /docs/* + /api-reference/* +
//     /developers-quickstart + /self-hosted + /about + sub-processors.
//   • Per-page jargon-on-first-use findings + redlines.
//   • Two "leave dense" exceptions on /faq for technical evaluators.
//   • Minimal-not-rewrite: targeted parentheticals, not rewrites.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/marketing/v214-density-audit.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W572.C /docs/marketing/v214-density-audit.md content parity', () => {
  const body = read(LIB);

  it('Header + V-214-marketing-density audit + 3-page scope + scope-out blockquote framing pinned', () => {
    expect(body).toMatch(/^# V-214 — marketing site visitor-density audit$/m);
    expect(body).toMatch(/Audit of `\/index`, `\/pricing`, `\/faq` for jargon-on-first-use and/);
    expect(body).toMatch(/inaccessible framing per the V-214 founder directive\./);
    expect(body).toMatch(/The/);
    expect(body).toMatch(
      /working-tree drafts in `apps\/marketing-site\/src\/pages\/\{index,pricing,faq\}\.astro`/,
    );
    expect(body).toMatch(/apply the proposed redlines\. Drafts stay uncommitted until founder/);
    expect(body).toMatch(/redline pass\./);
    expect(body).toMatch(/> \*\*Scope-out\*\*: `\/security`, `\/docs\/\*`, `\/api-reference\/\*`,/);
    expect(body).toMatch(
      /> `\/developers-quickstart`, `\/self-hosted` are dev-audience-appropriate/,
    );
    expect(body).toMatch(/> at current density per founder direction\. Not modified\./);
    expect(body).toMatch(
      /> \*\*Also untouched\*\*: `\/about` is at acceptable density post-V-213 trim\./,
    );
    expect(body).toMatch(/> `\/trust\/sub-processors` is reference data\./);
  });

  it('/index.astro findings (Cumulative-rig + Metering + Compliance + Built-for-two) framing pinned', () => {
    expect(body).toMatch(/### `\/index\.astro`/);
    expect(body).toMatch(
      /\| Cumulative rig\s+\| "iPhone Safari \(iOS 18\.7 \/ Safari 26\.4\) fingerprint surface"/,
    );
    expect(body).toMatch(/"fingerprint surface" assumes reader knows what fingerprinting is/);
    expect(body).toMatch(
      /Add a short visitor-first paragraph explaining what "fingerprint" means in this context/,
    );
    expect(body).toMatch(
      /\(the signals a website reads to identify the device\) before the dense methodology paragraph/,
    );
    expect(body).toMatch(/\| Cumulative rig\s+\| "Match or P0 finding"/);
    expect(body).toMatch(/Internal severity-tier jargon \(P0\) on a customer-facing page/);
    expect(body).toMatch(
      /Replace with: "Every signal either matches the iPhone reference, or we treat the gap as a launch-blocker bug\."/,
    );
    expect(body).toMatch(/\| Metering\s+\| "Concurrent caps are the only meter"/);
    expect(body).toMatch(/"concurrent" first-mention without definition/);
    expect(body).toMatch(
      /Add visitor-first sentence: "Concurrent = how many sessions run at the same time, like browser tabs you'd have open at once\."/,
    );
    expect(body).toMatch(/\| Compliance\s+\| "customer-controlled egress"/);
    expect(body).toMatch(/"egress" jargon/);
    expect(body).toMatch(
      /Inline parenthetical: "egress \(the network path your sessions use to reach the internet\)"/,
    );
    expect(body).toMatch(
      /\| Built-for-two cards \| "Bundled LLM or BYOK for AI-driven sessions \(Builder\+\)"/,
    );
    expect(body).toMatch(/BYOK undefined/);
    expect(body).toMatch(
      /Replace with: "Bundled LLM, or bring your own API key from OpenAI \/ Anthropic, for AI-driven sessions \(Builder\+\)"/,
    );
    expect(body).toMatch(/— drops the acronym in favor of plain words on first use/);
  });

  it('/pricing.astro + /faq.astro findings + Out-of-scope + Cadence + Why-minimal-not-rewrite framing pinned', () => {
    expect(body).toMatch(/### `\/pricing\.astro`/);
    expect(body).toMatch(
      /\| Trial pack hero\s+\| "299¢ of pre-paid credit, decremented at \$0\.18\/hr"/,
    );
    expect(body).toMatch(/Math-first framing instead of human-time framing/);
    expect(body).toMatch(/Lead with "\$2\.99 buys ~16 hours of iPhone Safari sessions";/);
    expect(body).toMatch(
      /keep the credit \/ decrement detail as a follow-on for readers who want it/,
    );
    expect(body).toMatch(/\| Tier tables \(Manual \+ API\) \| "Concurrent sessions" row label/);
    expect(body).toMatch(/"Concurrent" undefined on first use/);
    expect(body).toMatch(
      /Lead the tier section with a one-line "Concurrent sessions = how many run at the same time" inline note above the tier-card grid/,
    );
    expect(body).toMatch(/\| Tier tables\s+\| "BYOK \(Anthropic key required\)" cell value/);
    expect(body).toMatch(/BYOK first-mention is INSIDE a tier-feature cell;/);
    expect(body).toMatch(
      /the BYOK explainer block is BELOW the tier tables \(visitor scans tiers first\)/,
    );
    expect(body).toMatch(
      /Move the BYOK \/ Bundled LLM explainer block ABOVE the API tier table OR add a 1-sentence "What's BYOK\?" inline above the tables/,
    );
    expect(body).toMatch(/\| Tier tables\s+\| "AI agent \(LLM-driven sessions\)" row label/);
    expect(body).toMatch(/LLM acronym on first use/);
    expect(body).toMatch(
      /Already paired with "\(LLM-driven sessions\)" — this is fine; LLM is mainstream-enough by now and the parenthetical helps/,
    );
    expect(body).toMatch(/### `\/faq\.astro`/);
    expect(body).toMatch(/\| Pricing model\s+\| "How does concurrent metering work\?"/);
    expect(body).toMatch(
      /Answer jumps straight to per-tier numbers without defining concurrency first/,
    );
    expect(body).toMatch(
      /Lead the answer with one visitor-first sentence: "Concurrent = the number of sessions you can run at the same time, like browser tabs you'd have open at once\." Then the existing per-tier numbers\./,
    );
    expect(body).toMatch(/\| Bundled LLM \+ BYOK\s+\| First entry "What is the bundled LLM\?"/);
    expect(body).toMatch(/Defines bundled LLM but uses "BYOK" inline before defining it/);
    expect(body).toMatch(
      /Replace the BYOK acronym on first occurrence inside the answer with the explanation,/,
    );
    expect(body).toMatch(/then use BYOK as shorthand for the rest of the section/);
    expect(body).toMatch(
      /\| Pricing model\s+\| "How does this compare to Chromium-cloud stealth services\?"/,
    );
    expect(body).toMatch(
      /Very dense \("user-agent strings, JavaScript Proxy traps over canvas \/ WebGL \/ navigator, monkeypatched Object\.getOwnPropertyDescriptor calls"\)/,
    );
    expect(body).toMatch(
      /\*\*Leave dense\*\* — this is the comparison answer for technical evaluators, who are exactly the audience that wants this depth\./,
    );
    expect(body).toMatch(/Per founder direction\./);
    expect(body).toMatch(/\| Pricing model\s+\| "What happens when I hit my concurrent cap\?"/);
    expect(body).toMatch(/"fail with HTTP 429 \+ a structured RFC 7807 problem-detail"/);
    expect(body).toMatch(
      /\*\*Leave dense\*\* — answer is for the developer audience; HTTP status \+ RFC names are signal of correctness, not bug/,
    );
    expect(body).toMatch(/### Out of scope \(intentionally not modified\)/);
    expect(body).toMatch(/- `\/security` — dev-audience appropriate at current density\./);
    expect(body).toMatch(
      /- `\/docs\/\*` \+ `\/api-reference\/\*` \+ `\/developers-quickstart\/\*` — same\./,
    );
    expect(body).toMatch(/- `\/self-hosted` — pricing-density audit didn't surface problems;/);
    expect(body).toMatch(/visitor visiting \/self-hosted has clear intent\./);
    expect(body).toMatch(/- `\/trust\/sub-processors` — reference data\./);
    expect(body).toMatch(/- `\/about` — already trimmed in V-213\./);
    expect(body).toMatch(/## Cadence/);
    expect(body).toMatch(/1\. ✅ Audit findings \(this doc\) — engineering scaffolding, commits\./);
    expect(body).toMatch(
      /2\. 🔄 Working-tree drafts in `apps\/marketing-site\/src\/pages\/\{index,pricing,faq\}\.astro` — Tier 3, NOT committed\./,
    );
    expect(body).toMatch(/3\. ⏳ Surface drafts for founder \+ main-chat redline pass\./);
    expect(body).toMatch(/4\. ⏳ Apply redlines \+ commit on approval\./);
    expect(body).toMatch(/5\. ⏳ Repeat per page if additional surfaces need same treatment\./);
    expect(body).toMatch(/## Why the redlines are minimal-not-rewrite/);
    expect(body).toMatch(
      /The current copy is mostly in correct company voice \+ good positioning\./,
    );
    expect(body).toMatch(
      /The visitor-density problem is jargon-on-first-use, not the surrounding paragraphs\./,
    );
    expect(body).toMatch(
      /Targeted parenthetical \/ lead-in additions fix the density without unsettling proven framing\./,
    );
    expect(body).toMatch(
      /If founder wants a broader rewrite \(different positioning, different section ordering\),/,
    );
    expect(body).toMatch(/that's a follow-up Tier 3 draft round, separately surfaced\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
