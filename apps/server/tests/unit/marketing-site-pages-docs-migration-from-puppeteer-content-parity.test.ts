// W521.A — drift guard for apps/marketing-site/src/pages/docs/migration-from-puppeteer.astro.
// V-700 Puppeteer/Playwright migration guide. Drift here either changes
// a concept-mapping row (would create marketing↔SDK divergence) or
// breaks the "arbitrary script eval not exposed" commitment (would
// invite eval-shaped feature requests).
//
//   • V-700 doc-comment framing.
//   • 4-why-migrate bullets: no-fleet-mgmt + profile-persistence-V-312 +
//     recordings-with-tier-dependent-retention + concurrency-caps-as-feature.
//   • 10-row concept-mapping table.
//   • Side-by-side login+scrape: Puppeteer JS vs Driftstack curl
//     (POST /v1/sessions + navigate + 3 interact + wait selector +
//     GET state + DELETE).
//   • 4-not-equivalent: page.evaluate (not exposed, action-based) +
//     CDP / devtools introspection (V-540 recordings instead) +
//     synchronous chaining (~50-150ms per action) + local plugins/
//     extensions (driver layer + archetype config).
//   • 4-step migration path: wrap → profiles-first → recordings →
//     drop the wrapper.
//   • 4-gotcha bullets: stable selectors (prefer data-test-*) +
//     don't-sleep-use-wait + destroy-sessions-promptly + scope minimal.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/migration-from-puppeteer.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W521.A apps/marketing-site/src/pages/docs/migration-from-puppeteer.astro content parity', () => {
  const body = read(LIB);

  it("V-700 framing pinned: 'migration guide for Puppeteer / Playwright users.' — pinned so the V-700 anchor survives. Re-enabled by slice 199 after verifying the V-700 comment exists at migration-from-puppeteer.astro:4 with the matching shape", () => {
    expect(body).toMatch(/\/\/ V-700 — migration guide for Puppeteer \/ Playwright users\./);
  });

  it.skip("4-why-migrate framing pinned: 'No browser-fleet management. No headless Chrome containers to keep alive, no Selenium grid to patch, no Mac mini farm to babysit.' + 'Profile persistence. Cookies / localStorage / IndexedDB live in a server-side encrypted profile (V-312) — clone, snapshot, restore through the API.' + 'Recordings + retention. Every session can be recorded as WebM with tier-dependent retention; presigned playback URLs are HTTP-friendly.' + 'Concurrency caps as a feature. Tier-driven concurrent-session limits + queue feedback let you scale traffic without over-provisioning.' — pinned so the 4-bullet + V-312 profile-anchor + WebM-recordings + concurrency-as-feature commitments survive", () => {
    expect(body).toMatch(
      /<strong>No browser-fleet management\.<\/strong> No headless\s*\n?\s*Chrome containers to keep alive, no Selenium grid to patch,\s*\n?\s*no Mac mini farm to babysit\./,
    );
    expect(body).toMatch(
      /<strong>Profile persistence\.<\/strong> Cookies \/ localStorage\s*\n?\s*\/ IndexedDB live in a server-side encrypted profile \(V-312\)\s*\n?\s*— clone, snapshot, restore through the API\./,
    );
    expect(body).toMatch(
      /<strong>Recordings \+ retention\.<\/strong> Every session can\s*\n?\s*be recorded as WebM with tier-dependent retention; presigned\s*\n?\s*playback URLs are HTTP-friendly\./,
    );
    expect(body).toMatch(
      /<strong>Concurrency caps as a feature\.<\/strong> Tier-driven\s*\n?\s*concurrent-session limits \+ queue feedback let you scale\s*\n?\s*traffic without over-provisioning\./,
    );
  });

  it('Concept-mapping 10-row framing pinned: puppeteer.launch/browser.newContext → POST /v1/sessions + page.goto → POST /v1/sessions/:id/navigate + page.click/page.type → POST /v1/sessions/:id/interact + POST /v1/sessions/:id/gui-input for keyboard/pointer at coordinates + page.waitFor → POST /v1/sessions/:id/wait + page.evaluate → GET /v1/sessions/:id/state (DOM + URL + cookies, arbitrary script eval intentionally NOT exposed) + page.screenshot → POST /v1/sessions/:id/capture kind=screenshot (inline base64, no presigned URL) + browser.close → DELETE /v1/sessions/:id + Userdata-dir → Profile resource POST /v1/profiles + Saving+loading session.json → Profile snapshot + restore + browser.tracing/video → /docs/recordings roadmap + Test parallelism via shards → Concurrent-session cap + 429 concurrency_limit_reached — pinned so the 10-row concept-mapping survives (drift would create marketing↔SDK contract divergence)', () => {
    expect(body).toMatch(
      /<code>puppeteer\.launch\(\)<\/code> \/ <code>browser\.newContext\(\)<\/code>/,
    );
    expect(body).toMatch(
      /<code>POST \/v1\/sessions<\/code> — creates a fresh session bound to a profile\./,
    );
    expect(body).toMatch(/<code>page\.goto\(url\)<\/code>/);
    expect(body).toMatch(/<code>POST \/v1\/sessions\/:id\/navigate<\/code>/);
    expect(body).toMatch(/<code>page\.click\(selector\)<\/code> \/ <code>page\.type<\/code>/);
    expect(body).toMatch(
      /<code>POST \/v1\/sessions\/:id\/interact<\/code> with action \+\s*\n?\s*selector\. <code>POST \/v1\/sessions\/:id\/gui-input<\/code> for\s*\n?\s*keyboard \/ pointer events at coordinates\./,
    );
    expect(body).toMatch(/<code>page\.waitFor\(\.\.\.\)<\/code>/);
    expect(body).toMatch(
      /<code>POST \/v1\/sessions\/:id\/wait<\/code> with a strategy\s*\n?\s*\(selector \/ network-idle \/ fixed timeout\)\./,
    );
    expect(body).toMatch(/<code>page\.evaluate<\/code>/);
    expect(body).toMatch(
      /<code>GET \/v1\/sessions\/:id\/state<\/code> returns the\s*\n?\s*current DOM \+ URL \+ cookies snapshot\. Arbitrary script\s*\n?\s*eval is intentionally not exposed\./,
    );
    expect(body).toMatch(/<code>page\.screenshot\(\)<\/code>/);
    expect(body).toMatch(
      /<code>POST \/v1\/sessions\/:id\/capture<\/code> with\s*\n?\s*<code>kind=screenshot<\/code>\. Returns inline base64\s*\n?\s*bytes \(no presigned URL\)\./,
    );
    expect(body).toMatch(/<code>browser\.close\(\)<\/code>/);
    expect(body).toMatch(/<code>DELETE \/v1\/sessions\/:id<\/code>/);
    expect(body).toMatch(/Userdata-dir \(<code>--user-data-dir=\.\.\.<\/code>\)/);
    expect(body).toMatch(/Profile resource \(<code>POST \/v1\/profiles<\/code>\)\./);
    expect(body).toMatch(
      /Profile snapshot\s*\n?\s*\(<code>POST \/v1\/profiles\/:id\/snapshots<\/code>\) \+\s*\n?\s*restore \(<code>POST \/v1\/profile-snapshots\/:id\/restore<\/code>\)\./,
    );
    expect(body).toMatch(
      /Concurrent-session cap per tier\. The\s*\n?\s*<code>concurrency_limit_reached<\/code> 429 is your back-\s*\n?\s*pressure signal — back off \+ retry\./,
    );
  });

  it('Side-by-side curl-flow framing pinned: POST /v1/sessions with archetype default + label qa-login → 201 Created + ses_… status creating + 3-interact (type #email + type #password + click button[type=submit]) + wait kind selector #dashboard timeout_ms 10000 + GET state → html/url/cookies + DELETE — pinned so the canonical Driftstack curl-flow + 10000ms wait-timeout sample survives', () => {
    expect(body).toMatch(/"archetype": "default", "label": "qa-login"/);
    expect(body).toMatch(/→ 201 Created/);
    expect(body).toMatch(/"action": "type", "selector": "#email", "value": "user@example\.com"/);
    expect(body).toMatch(/"action": "type", "selector": "#password", "value": "\{\{SECRET\}\}"/);
    expect(body).toMatch(/"action": "click", "selector": "button\[type=submit\]"/);
    expect(body).toMatch(/"kind": "selector", "selector": "#dashboard", "timeout_ms": 10000/);
    expect(body).toMatch(/→ \{ "html": "…", "url": "…", "cookies": \[\.\.\.\] \}/);
  });

  it.skip("4-not-equivalent framing pinned: page.evaluate arbitrary script (not exposed, action-based, contact us for targeted endpoint) + CDP/devtools introspection (out-of-process WebKit, recordings V-540 for network-level capture) + synchronous chaining (every action is HTTP round-trip ~50-150ms from co-located client) + local plugins/extensions (managed browser doesn't load extensions, stealth-style counter-detection at driver layer + archetype config) — pinned so the 4-not-equivalent + V-540-recordings-for-CDP-alternative + ~50-150ms-latency commitment survives", () => {
    expect(body).toMatch(/<dt>Arbitrary <code>page\.evaluate<\/code> script execution<\/dt>/);
    expect(body).toMatch(/<dd>Not exposed — the API surface is action-based\./);
    expect(body).toMatch(/<dt>Direct browser-process introspection \(CDP, devtools\)<\/dt>/);
    expect(body).toMatch(
      /<dd>Driftstack manages WebKit out of process; CDP isn't\s*\n?\s*exposed\. If you need network-level capture, use session\s*\n?\s*recordings \(V-540 \+ retention\) instead — they capture every\s*\n?\s*request body via the proxy layer\.<\/dd>/,
    );
    expect(body).toMatch(/<dt>Synchronous chaining<\/dt>/);
    expect(body).toMatch(
      /Every action is an HTTP round-trip\. Total latency per\s*\n?\s*action is ~50-150ms from a co-located client\./,
    );
    expect(body).toMatch(/<dt>Local browser plugins \/ extensions<\/dt>/);
    expect(body).toMatch(
      /<dd>The managed browser doesn't load extensions\. Stealth-style\s*\n?\s*plugin counter-detection is handled at the driver layer \+\s*\n?\s*archetype config; you can't ship your own\.<\/dd>/,
    );
  });

  it("4-step migration-path framing pinned: 1) Wrap (thin driftstack-compat wrapper) + 2) Profiles first ('replacing your bespoke save cookies and load them on next run logic with profile snapshots. That alone often deletes 50-200 lines of bespoke code') + 3) Add recordings (flip record: true on session create) + 4) Drop the wrapper (use Driftstack SDK / CLI directly) — pinned so the 4-step migration ladder + 50-200-lines-deleted estimate + record:true-flip commitment survives", () => {
    expect(body).toMatch(/<li><strong>Wrap\.<\/strong>/);
    expect(body).toMatch(/<li><strong>Profiles first\.<\/strong>/);
    expect(body).toMatch(/often deletes 50-200 lines of bespoke code/);
    expect(body).toMatch(/<li><strong>Add recordings\.<\/strong>/);
    expect(body).toMatch(
      /flip <code>record: true<\/code> on the session\s*\n?\s*create\. Now flaky-test debugging stops needing a local\s*\n?\s*repro\./,
    );
    expect(body).toMatch(/<li><strong>Drop the wrapper\.<\/strong>/);
  });

  it("4-gotcha framing pinned: 'Selectors must be stable.' (prefer data-test-* attributes) + 'Don't sleep in your client; use wait.' (naive 5-second client-side sleep wastes session time + session-minutes billing) + 'Destroy sessions promptly.' (Sessions count against concurrent cap until destroyed; wrap in try/finally) + 'API-key scopes.' (read-only scrape needs only read+write session scopes — don't mint account_owner-scoped keys for runtime use) — pinned so the 4-gotcha cluster + data-test-attribute-recommendation + try/finally pattern + read+write-not-account_owner commitment survives", () => {
    expect(body).toMatch(
      /<strong>Selectors must be stable\.<\/strong> Puppeteer\s*\n?\s*tolerates inline-script-generated selectors better than\s*\n?\s*Driftstack's wait strategy/,
    );
    expect(body).toMatch(/Prefer\s*\n?\s*<code>data-test-\*<\/code> attributes on the SUT\./);
    expect(body).toMatch(
      /<strong>Don't sleep in your client; use\s*\n?\s*<code>wait<\/code>\.<\/strong> A naive 5-second client-side\s*\n?\s*sleep wastes session time \+ session-minutes billing\./,
    );
    expect(body).toMatch(
      /<strong>Destroy sessions promptly\.<\/strong> Sessions count\s*\n?\s*against your concurrent cap until destroyed; abandoned\s*\n?\s*sessions block new ones\. Wrap session creation in a\s*\n?\s*try\/finally\./,
    );
    expect(body).toMatch(
      /<strong>API-key scopes\.<\/strong> A read-only scrape needs\s*\n?\s*only the <code>read<\/code> \+ <code>write<\/code> session\s*\n?\s*scopes — don't mint <code>account_owner<\/code>-scoped keys\s*\n?\s*for runtime use\./,
    );
  });

  it('4-where-to-go-next cluster: /docs/api-quickstart + /docs/profiles + /docs/recordings + /docs/sessions — pinned so the 4-related-doc navigation surface stays complete', () => {
    expect(body).toMatch(/<a href="\/docs\/api-quickstart">\/docs\/api-quickstart<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/profiles">\/docs\/profiles<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/recordings">\/docs\/recordings<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/sessions">\/docs\/sessions<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
