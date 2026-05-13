// W512.C — drift guard for apps/marketing-site/src/pages/docs/api-quickstart.astro.
// V-680 API quickstart. Drift here either changes a sample-curl
// pattern (would create marketing↔runtime divergence) or breaks the
// 60-second-spin-up positioning.
//
//   • V-680 doc-comment framing.
//   • Flat-object-no-envelope commitment.
//   • Sample 5-step flow: get key → /v1/account/me health check →
//     POST /v1/sessions create → poll → POST capture.
//   • ds_live_ prefix + only-store-hash + can't-show-again posture.
//   • 3-scope ladder: read / write / account_owner.
//   • Session id ses_ prefix + creating → ready → busy → destroyed /
//     errored states.
//   • Captures inline base64 + encoding field + byte_size + duration_ms.
//   • Live-view at https://app.driftstack.dev/sessions/<id>.
//   • Poll every 5 seconds fine for small workloads; webhooks for prod.
//   • developers@driftstack.dev + 1-business-day SLA.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-quickstart.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W512.C apps/marketing-site/src/pages/docs/api-quickstart.astro content parity', () => {
  const body = read(LIB);

  it("V-680 framing pinned: 'API quickstart for developers landing on docs.driftstack.dev for the first time. Companion to /api-reference (full surface) + /docs/oauth-apps (third-party app authors); this page is for the \"I want to spin up a session in 60 seconds\" path.' + 'Posture: focuses on api_starter tier (the cheapest entry into the programmatic surface). Examples are runnable verbatim once the reader has an API key in hand.' — pinned so the V-680 anchor + 2-companion cross-references + 60-second positioning + api_starter-tier-floor + runnable-verbatim commitments survive (drift to dropping V-680 would orphan the page from the engineering posture; drift to softening 'runnable verbatim' would let samples drift from being copy-paste-ready)", () => {
    expect(body).toMatch(
      /\/\/ V-680 — API quickstart for developers landing on docs\.driftstack\.dev\s*\n?\s*\/\/ for the first time\. Companion to \/api-reference \(full surface\) \+\s*\n?\s*\/\/ \/docs\/oauth-apps \(third-party app authors\); this page is for the\s*\n?\s*\/\/ "I want to spin up a session in 60 seconds" path\./,
    );
    expect(body).toMatch(
      /\/\/ Posture: focuses on api_starter tier \(the cheapest entry into the\s*\n?\s*\/\/ programmatic surface\)\. Examples are runnable verbatim once the\s*\n?\s*\/\/ reader has an API key in hand\./,
    );
  });

  it("API-key minting framing pinned: 'You'll see a single full-string key starting with ds_live_. Copy it now — we only store the hash, so we can't show it again. If you lose it, revoke and mint a new one.' — pinned so the ds_live_-prefix + hash-only-storage + can't-show-again + revoke-and-rotate-on-loss 4-state key-minting framing survives (drift to a different prefix would create marketing↔server divergence; drift to softening 'can't show it again' would mislead customers about the hash-only commitment)", () => {
    expect(body).toMatch(
      /You'll see a single full-string\s*\n?\s*key starting with <code>ds_live_<\/code>\. Copy it now — we only\s*\n?\s*store the hash, so we can't show it again\. If you lose it,\s*\n?\s*revoke and mint a new one\./,
    );
  });

  it('3-scope ladder pinned: read (list sessions + fetch session metadata) + write (start sessions + modify profiles) + account_owner (full account control) — pinned so the 3-scope ladder stays consistent (drift to dropping any scope would create marketing↔scope-enum divergence; drift to changing the read/write boundary would shift the least-privilege guidance)', () => {
    expect(body).toMatch(/<li><code>read<\/code> — list sessions, fetch session metadata\.<\/li>/);
    expect(body).toMatch(/<li><code>write<\/code> — start sessions, modify profiles\.<\/li>/);
    expect(body).toMatch(/<li><code>account_owner<\/code> — full account control\.<\/li>/);
  });

  it("/v1/account/me sample response 5-field framing pinned: id (acc_) + email + tier api_starter + concurrent_session_cap 2 + profile_cap 25 + 'A 401 here means the key is wrong, malformed, or revoked.' + flat-object-no-envelope framing — pinned so the canonical /account/me response shape + the 401-diagnosis hint + flat-no-envelope commitment all survive (drift to envelope-wrapping the response would create marketing↔server divergence; drift to dropping the 401 hint would orphan first-time-key-typo debugging)", () => {
    expect(body).toMatch(/"tier": "api_starter"/);
    expect(body).toMatch(/"concurrent_session_cap": 2/);
    expect(body).toMatch(/"profile_cap": 25/);
    expect(body).toMatch(
      /A <code>401<\/code> here means the key is wrong, malformed, or\s*\n?\s*revoked\. Check the dashboard\. The response is a flat object —\s*\n?\s*no <code>\{`\{"account": …\}`\}<\/code> envelope\./,
    );
  });

  it("Session-create sample 3-field body pinned: archetype: 'default' + purpose: 'production_customer' + label: 'first-session' + 201 Created + ses_ id prefix + 'creating → ready → busy → destroyed (or errored on failure)' lifecycle — pinned so the 3-field body + 201-status + ses_-prefix + 5-state-lifecycle commitment survives (consistent with /docs/sdk-typescript + /docs/sdk-python lifecycle framing)", () => {
    expect(body).toMatch(/"archetype": "default"/);
    expect(body).toMatch(/"purpose": "production_customer"/);
    expect(body).toMatch(/"label": "first-session"/);
    expect(body).toMatch(/→ 201 Created/);
    expect(body).toMatch(
      /The session id prefix is <code>ses_<\/code>\. Status moves\s*\n?\s*through <code>creating<\/code> → <code>ready<\/code> →\s*\n?\s*<code>busy<\/code> → <code>destroyed<\/code> \(or\s*\n?\s*<code>errored<\/code> on failure\)\./,
    );
  });

  it("Live-view URL pinned: 'https://app.driftstack.dev/sessions/<id>' — pinned so the dashboard live-view URL pattern stays consistent (drift to a different path would create marketing↔dashboard-routing divergence)", () => {
    expect(body).toMatch(
      /Open the live-view stream in\s*\n?\s*the dashboard at\s*\n?\s*<code>https:\/\/app\.driftstack\.dev\/sessions\/&lt;id&gt;<\/code>\./,
    );
  });

  it('Separate-navigate-call framing pinned: \'To drive the session to a URL after it\'s running, use POST /v1/sessions/<id>/navigate with {"url": "https://example.com"} — the session-create call itself doesn\'t take a target URL.\' — pinned so the separate-navigate + sessions.create-no-URL commitment stays consistent with /docs/sdk-typescript + /docs/sdk-python (drift to claiming session-create takes a URL would create marketing↔SDK divergence)', () => {
    expect(body).toMatch(
      /To drive the session to a URL after it's running, use\s*\n?\s*<code>POST \/v1\/sessions\/&lt;id&gt;\/navigate<\/code> with/,
    );
    expect(body).toMatch(/the\s*\n?\s*session-create call itself doesn't take a target URL\./);
  });

  it("Polling guidance pinned: 'Poll every 5 seconds is fine for small workloads. For production traffic, subscribe to webhooks (see POST /v1/webhooks).' — pinned so the 5s-polling-fine + webhooks-for-prod recommendation survives (drift to dropping the small-workload caveat would mislead developers about scale-acceptable polling)", () => {
    expect(body).toMatch(
      /Poll every 5 seconds is fine for small workloads\. For\s*\n?\s*production traffic, subscribe to webhooks \(see <code>POST \/v1\/webhooks<\/code>\)\./,
    );
  });

  it("Capture endpoint sample 5-field pinned: kind: 'screenshot' + data (base64) + encoding (base64) + byte_size + duration_ms + 'Captures return inline base64 bytes — there is no presigned URL.' — pinned so the 5-field capture-response shape + the explicit-no-presigned-URL commitment survives (drift to claiming presigned URLs would mislead customers about the bytes-inline contract; consistent with /docs/recordings's 'no /v1/sessions/:id/recording endpoint today' framing)", () => {
    expect(body).toMatch(/-d '\{"kind": "screenshot"\}'/);
    expect(body).toMatch(/"kind": "screenshot"/);
    expect(body).toMatch(/"data": "<base64-encoded bytes>"/);
    expect(body).toMatch(/"encoding": "base64"/);
    expect(body).toMatch(/"byte_size": 184320/);
    expect(body).toMatch(/"duration_ms": 412/);
    expect(body).toMatch(
      /Captures return inline base64 bytes — there is no presigned\s*\n?\s*URL\./,
    );
  });

  it('4-where-to-go-next cluster: /api-reference + /docs/cost-monitoring + /docs/oauth-apps + /pricing — pinned so the 4-doc next-step navigation stays complete (drift to dropping /pricing would orphan tier-upgrade discovery; drift to dropping /docs/oauth-apps would orphan third-party-app developers from their canonical doc)', () => {
    expect(body).toMatch(/<a href="\/api-reference">Full API reference<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/cost-monitoring">Cost monitoring<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/oauth-apps">OAuth apps<\/a>/);
    expect(body).toMatch(/<a href="\/pricing">Pricing<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
