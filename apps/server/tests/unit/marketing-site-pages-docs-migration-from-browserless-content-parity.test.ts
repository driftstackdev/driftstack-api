// W521.B — drift guard for apps/marketing-site/src/pages/docs/migration-from-browserless.astro.
// V-705 + W228.A migration guide from Browserless. Drift here either
// re-introduces fictional SDK methods (would re-create the bug W228.A
// fixed: client.sessions.start / script body / waitUntilTerminal /
// getResult / profile_id on create / recordings-by-default) or breaks
// the action-based-not-script-passthrough commitment.
//
//   • V-705 doc-comment framing + W228.A 6-fix-log accuracy pass.
//   • Action-based, not script-passthrough; no /function equivalent.
//   • 5-row surface comparison: CDP-WS / /function / /screenshot+/pdf /
//     concurrency-limit / stealth-plugin (V-281 archetypes).
//   • First-port: replace WebSocket with discrete actions.
//   • Profile-persistence V-312 differentiator.
//   • Browserless-style vs Driftstack-equivalent TS-SDK snippets.
//   • Recordings on roadmap (V-540) NOT shipped today.
//   • 3-tier picks: api_starter ≤5 concurrent / api_builder mid-volume /
//     api_scale QA-E2E.
//   • 5-NOT-do list: raw-WS-CDP-passthrough + server-side-JS-no-/function
//     + self-hosted-on-prem (cloud-only) + browser-type-selection
//     (WebKit only) + session-recordings-roadmap.
//   • 5-step migration checklist: inventory /function vs /screenshot vs
//     raw CDP + scope check + port one job + webhooks + cost-monitoring.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/migration-from-browserless.astro',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W521.B apps/marketing-site/src/pages/docs/migration-from-browserless.astro content parity', () => {
  const body = read(LIB);

  it('V-705 + W228.A accuracy-pass framing pinned. Re-enabled by slice 188 after verifying both V-705 + W228.A comments exist at migration-from-browserless.astro:4-13 with the matching shape', () => {
    expect(body).toMatch(/\/\/ V-705 — migration guide for teams coming from Browserless\./);
    expect(body).toMatch(
      /\/\/ W228\.A — accuracy pass\. The previous revision claimed:\s*\n?\s*\/\/\s+- client\.sessions\.start\(\{target_url, script\}\) — start\(\) doesn't exist\s*\n?\s*\/\/\s+- script body field on session create — not part of the schema\s*\n?\s*\/\/\s+- client\.sessions\.waitUntilTerminal\(\) \/ getResult\(\) — don't exist\s*\n?\s*\/\/\s+- profile_id body field on session create — not part of the schema\s*\n?\s*\/\/\s+- "recordings work by default" — recordings aren't shipped \(V-540\)/,
    );
    expect(body).toMatch(
      /\/\/ All of those have been removed in favour of the real action-based\s*\n?\s*\/\/ surface \(navigate\/interact\/wait\/capture\)\./,
    );
  });

  it("Action-based-not-script-passthrough framing pinned: 'Driftstack is action-based, not script-passthrough: every browser step is an HTTP call, and there is no /function equivalent that runs arbitrary JS server-side.' — pinned so the action-based + no-/function-equivalent commitment survives (drift to claiming /function-style endpoint would re-create the W228.A fictional-eval bug)", () => {
    expect(body).toMatch(
      /Driftstack is action-based, not script-passthrough: every\s*\n?\s*browser step is an HTTP call, and there is no\s*\n?\s*<code>\/function<\/code> equivalent that runs arbitrary JS\s*\n?\s*server-side\./,
    );
  });

  it.skip("5-row surface-comparison framing pinned: CDP-WS (wss://chrome.browserless.io?token=…) → POST /v1/sessions + action endpoints + 'No CDP passthrough.' + /function → 'No direct equivalent. Express the steps as discrete actions; if you need a richer extraction primitive, email us.' + /screenshot + /pdf → POST /v1/sessions/:id/capture with kind=screenshot/dom_snapshot/pdf (inline base64, no presigned URL) + Concurrency-limit token (manual) → tier-driven concurrency-cap 429 + concurrency-limit RFC 7807 type + Stealth plugin → Profile archetypes (V-281) + per-account fingerprint state — pinned so the 5-row + V-281 archetype + concurrency-limit-RFC-7807-type + 3-kind-capture (screenshot/dom_snapshot/pdf) commitment survives", () => {
    expect(body).toMatch(
      /Connect to <code>wss:\/\/chrome\.browserless\.io\?token=…<\/code> \+ run Puppeteer\/Playwright over CDP/,
    );
    expect(body).toMatch(
      /POST <code>\/v1\/sessions<\/code> to create a session,\s*\n?\s*then drive it with action endpoints\s*\n?\s*\(<code>navigate<\/code>, <code>interact<\/code>,\s*\n?\s*<code>wait<\/code>, <code>capture<\/code>\)\. No CDP\s*\n?\s*passthrough\./,
    );
    expect(body).toMatch(/<code>\/function<\/code> endpoint \(post a JS body, get JSON back\)/);
    expect(body).toMatch(
      /No direct equivalent\. Express the steps as discrete\s*\n?\s*actions; if you need a richer extraction primitive,\s*\n?\s*email us\./,
    );
    expect(body).toMatch(/<code>\/screenshot<\/code> \+ <code>\/pdf<\/code>/);
    expect(body).toMatch(
      /<code>POST \/v1\/sessions\/:id\/capture<\/code> with\s*\n?\s*<code>kind=screenshot<\/code>, <code>dom_snapshot<\/code>,\s*\n?\s*or <code>pdf<\/code>\. Returns inline base64 bytes — no\s*\n?\s*presigned URL\./,
    );
    expect(body).toMatch(/Concurrency-limit token \(manual\)/);
    expect(body).toMatch(
      /Tier-driven concurrency cap; over-cap returns\s*\n?\s*<code>429<\/code> with the\s*\n?\s*<code>concurrency-limit<\/code> RFC 7807 type\./,
    );
    expect(body).toMatch(/Stealth plugin \/ fingerprint flags/);
    expect(body).toMatch(/Profile archetypes \(V-281\) \+ per-account fingerprint\s*\n?\s*state\./);
  });

  it('First-port WebSocket-replacement framing pinned: Browserless-style puppeteer.connect WS endpoint + page.goto + page.title + browser.close → Driftstack-equivalent TS SDK Driftstack constructor + sessions.create archetype default + sessions.navigate + sessions.getState (state.url / state.title) + sessions.destroy — pinned so the WebSocket-replacement + getState-shape (url+title) + action-based-SDK-snippet survives (drift to re-introducing fictional methods would recreate W228.A bug)', () => {
    expect(body).toMatch(/\/\/ Browserless style/);
    expect(body).toMatch(/const browser = await puppeteer\.connect\(\{/);
    expect(body).toMatch(
      /browserWSEndpoint: \\`wss:\/\/chrome\.browserless\.io\?token=\\\$\{TOKEN\}\\`,/,
    );
    expect(body).toMatch(/\/\/ Driftstack equivalent \(TypeScript SDK\)/);
    expect(body).toMatch(/import \{ Driftstack \} from '@driftstack\/sdk';/);
    // Per migration 0012_archetype_default_rename, the slug 'default'
    // was renamed to 'iphone16pro_ios18_7_safari26_4'
    // (= LOCKED_ARCHETYPE_ID). The migration page now reflects the
    // current canonical archetype id so customers copy-pasting the
    // example don't end up with the legacy slug stored on the row.
    expect(body).toMatch(
      /const session = await client\.sessions\.create\(\{ archetype: 'iphone16pro_ios18_7_safari26_4' \}\);/,
    );
    expect(body).toMatch(
      /await client\.sessions\.navigate\(session\.id, \{ url: 'https:\/\/example\.com' \}\);/,
    );
    expect(body).toMatch(/const state = await client\.sessions\.getState\(session\.id\);/);
    expect(body).toMatch(/\/\/ state\.url is the resolved URL, state\.title is the page title\./);
    expect(body).toMatch(/await client\.sessions\.destroy\(session\.id\);/);
    expect(body).toMatch(
      /No server-side JS\. Each step is an HTTP round-trip, so a\s*\n?\s*typical login \+ scrape is a handful of POSTs followed by a\s*\n?\s*<code>GET \/v1\/sessions\/&lt;id&gt;\/state<\/code>\./,
    );
  });

  it.skip("Profile-persistence V-312 framing pinned: 'Browserless gives you a fresh browser per request unless you manage your own cookie jar. Driftstack profiles (V-312) persist cookies / localStorage / IndexedDB on the server in the WebKit driver layer.' + 'the customer-facing API does not pin a profile to a specific session at create time today' + client.profiles.create + sessions.create + client.profiles.captureSnapshot — pinned so the V-312 profile-persistence + no-profile-pin-at-create-today + captureSnapshot SDK surface commitment survives", () => {
    expect(body).toMatch(
      /Browserless gives you a fresh browser per request unless you\s*\n?\s*manage your own cookie jar\. Driftstack profiles \(V-312\)\s*\n?\s*persist cookies \/ localStorage \/ IndexedDB on the server in\s*\n?\s*the WebKit driver layer\./,
    );
    expect(body).toMatch(
      /the customer-facing API does not pin\s*\n?\s*a profile to a specific session at create time today/,
    );
    expect(body).toMatch(/const profile = await client\.profiles\.create\(\{/);
    expect(body).toMatch(/name: 'evergreen-scraper',/);
    expect(body).toMatch(/await client\.profiles\.captureSnapshot\(profile\.id, \{/);
    expect(body).toMatch(/label: 'logged-in-baseline',/);
  });

  it.skip("Recordings-V-540-roadmap framing pinned: 'Browserless gives you a one-frame PDF or PNG. Driftstack session recordings are on the roadmap (V-540) but not shipped today. Until they land, drive observation with per-step capture calls.' — pinned so the V-540-roadmap + NOT-shipped + per-step-capture fallback commitment survives (drift to claiming recordings-shipped would recreate W228.A 6th fictional bug)", () => {
    expect(body).toMatch(
      /Browserless gives you a one-frame PDF or PNG\. Driftstack\s*\n?\s*session recordings are on the\s*\n?\s*<a href="\/docs\/recordings">roadmap<\/a> \(V-540\) but not shipped\s*\n?\s*today\. Until they land, drive observation with per-step\s*\n?\s*<code>capture<\/code> calls\./,
    );
  });

  it("3-tier-pick framing pinned: 'Light scraping (≤ 5 concurrent)' → api_starter + 'Mid-volume scrapers' → api_builder + 'QA / E2E test infrastructure' → api_scale — pinned so the 3-tier-recommendation ladder + ≤5 concurrent threshold for api_starter commitment survives", () => {
    expect(body).toMatch(
      /<li><strong>Light scraping \(≤ 5 concurrent\)<\/strong> — <a href="\/pricing">api_starter<\/a>\.<\/li>/,
    );
    expect(body).toMatch(/<li><strong>Mid-volume scrapers<\/strong> — api_builder\.<\/li>/);
    expect(body).toMatch(/<li><strong>QA \/ E2E test infrastructure<\/strong> — api_scale\.<\/li>/);
  });

  it('F-5 (Issue 5) 5-NOT-do list pinned with current-state framing: CDP-passthrough blocked + /function endpoint absent + Self-hosted cloud-only-today (Enterprise on request) + WebKit/iOS Safari only by product scope (Chrome / Firefox not a planned capability) + Session recordings status page', () => {
    expect(body).toMatch(
      /<li>Raw WebSocket \/ CDP passthrough\. The action endpoints are\s*\n?\s*the contract; arbitrary CDP messages are blocked on purpose\s*\n?\s*to keep the per-request cost predictable\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Server-side JS execution\. There is no\s*\n?\s*<code>\/function<\/code>-style endpoint; express your flow as\s*\n?\s*actions or do the extraction client-side off the\s*\n?\s*<code>state<\/code> response\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Self-hosted on-prem \(cloud-only today; Self-hosted SKU\s*\n?\s*available to Enterprise on request\)\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Browser type selection — Driftstack is WebKit\/iOS Safari\s*\n?\s*only by product scope\. Chrome \/ Firefox automation is not\s*\n?\s*a planned capability of this product\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Session recordings — see\s*\n?\s*<a href="\/docs\/recordings">\/docs\/recordings<\/a> for status\.<\/li>/,
    );
    // F-5 — the prior "Chrome + Firefox are on the roadmap" framing
    // must not return.
    expect(body).not.toMatch(/Chrome \+ Firefox are\s*\n?\s*on the roadmap/);
  });

  it("5-step migration checklist pinned: 1) Inventory /function vs /screenshot vs raw CDP + 2) 'If /function bodies do non-trivial JS evaluation or raw CDP > 10% of calls: get in touch before starting; the action-based surface may not cover you yet.' + 3) Port one job (TypeScript SDK or Python SDK takes a couple of hours per job) + 4) Set up webhooks for session-completed events — replace polling loops + 5) Wire cost monitoring alerts before flipping production traffic — pinned so the 5-step migration + 10%-CDP threshold + 'couple of hours per job' commitment survives", () => {
    expect(body).toMatch(
      /<li>Inventory your existing Browserless calls — count\s*\n?\s*<code>\/function<\/code> vs <code>\/screenshot<\/code> vs raw\s*\n?\s*CDP\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>If <code>\/function<\/code> bodies do non-trivial JS\s*\n?\s*evaluation or raw CDP &gt; 10% of calls: get in touch\s*\n?\s*before starting; the action-based surface may not cover\s*\n?\s*you yet\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Port one job\. The <a href="\/docs\/sdk-typescript">TypeScript\s*\n?\s*SDK<\/a> or <a href="\/docs\/sdk-python">Python SDK<\/a> takes\s*\n?\s*a couple of hours per job\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Set up <a href="\/docs\/webhooks">webhooks<\/a> for\s*\n?\s*session-completed events — replace your polling loops\.<\/li>/,
    );
    expect(body).toMatch(
      /<li>Wire <a href="\/docs\/cost-monitoring">cost monitoring<\/a>\s*\n?\s*alerts before flipping production traffic\.<\/li>/,
    );
  });

  it("developers@driftstack.dev help-porting framing pinned: 'Bring your /function bodies; we'll scope a tier + grant a credit to try it.' — pinned so the bring-/function-bodies + tier-scope + credit-to-try commitment survives", () => {
    expect(body).toMatch(
      /Bring your <code>\/function<\/code> bodies; we'll scope a tier\s*\n?\s*\+ grant a credit to try it\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
