// W497.C — drift guard for apps/customer-dashboard/src/pages/settings.astro.
// V-217 + V-204 + V-298a + V-298b + V-352 + V-352b + bundled-AI settings page.
// The security surfaces (V-079 change-password, V-353h MFA, V-355
// web-sessions, V-216 audit teaser, danger zone) moved to /security
// with the 2026-07-03 design-system v2 split — their pins live in
// customer-dashboard-pages-security-content-parity.test.ts. Drift
// here breaks the V-204 EMAIL_EVENTS list (customers couldn't opt
// out of lifecycle emails matching the server-side
// OptOutableEmailEventSchema) or the V-352 profile editor.
//
//   • V-217 progressive-enhancement framing (V-204 live wire).
//   • V-204 EMAIL_EVENTS 6-entry list mirroring
//     OptOutableEmailEventSchema.
//   • V-352 + V-352b + V-298a + V-298b profile form (name +
//     timezone + slug + region + avatar).
//   • V-331b act-as header in authedFetch.
//   • Bundled-AI consent/cap/status with authoritative timeout reconciliation.
//   • The moved-to-/security header cross-link.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro');
const BYOK_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-byok-anthropic.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W497.C apps/customer-dashboard/src/pages/settings.astro content parity', () => {
  const body = read(LIB);

  it("V-217 framing pinned: 'progressive-enhancement live wiring against: /v1/account/email-preferences (V-204) — list + PUT per-event toggles' — pinned so the remaining live-wire scope + the V-204 provenance survive (the V-216/V-079 wires moved to security.astro with the 2026-07-03 split)", () => {
    expect(body).toMatch(
      /\/\/ V-217 — progressive-enhancement live wiring against:\s*\n?\s*\/\/ {3}- \/v1\/account\/email-preferences \(V-204\) — list \+ PUT per-event toggles/,
    );
  });

  it('V-204 EMAIL_EVENTS 6-entry list: signup-welcome / session-failed-first / session-success-first / tier-changed / billing-receipt / billing-renewal-reminder — pinned so the customer-facing opt-outable email taxonomy stays consistent with OptOutableEmailEventSchema (drift to dropping any would orphan customers from opting out of a lifecycle email they receive; drift to adding security/financial events would let customers opt out of must-deliver emails). The trial-pack pair was removed with the dead trial_pack lifecycle.', () => {
    expect(body).toMatch(/type: 'signup-welcome',/);
    expect(body).toMatch(/type: 'session-failed-first',/);
    expect(body).toMatch(/type: 'session-success-first',/);
    expect(body).toMatch(/type: 'tier-changed',/);
    expect(body).toMatch(/type: 'billing-receipt',/);
    expect(body).toMatch(/type: 'billing-renewal-reminder',/);
    expect(body).not.toMatch(/type: 'trial-pack-purchased',/);
    expect(body).not.toMatch(/type: 'trial-pack-expired',/);
  });

  it("Security-vs-lifecycle email framing pinned: 'Security + financial emails (signup verification, password reset, billing failure, subscription cancellation, support replies) always go out. Below are the optional lifecycle emails — toggle off any you don't want.' — pinned so the must-deliver vs. opt-outable distinction stays explicit (drift to dropping the security/financial framing would let customers think they can opt out of billing-failure or password-reset emails, breaking the security model)", () => {
    // "subscription cancellation" was removed from this list, and the pin with it. No
    // cancellation template exists — it was deleted as unused — so the page was promising
    // mail no code path can send, directly above the toggle that suppresses the only message
    // a cancellation actually produces. The always-send list is now checked against the
    // TEMPLATES map in opt-outable-email-event-cross-source-invariant.test.ts, so a name
    // outliving its template fails there rather than being frozen here.
    expect(body).toMatch(
      /Security \+ financial emails \(signup verification, password reset,\s*\n?\s*billing failure, support replies\) always go out\. Below are the\s*\n?\s*optional lifecycle emails — toggle off any you don't want\./,
    );
    expect(body).toMatch(/Cancelling a subscription sends no email of its own\./);
  });

  it("V-352 + V-298a + V-298b profile form contract: PATCH /v1/account/me { name, timezone, slug?, region? } with null-on-empty + IANA timezone hint — pinned so the 4-field profile mutation contract stays consistent (drift to dropping null-on-empty would force customers to keep filling fields they've cleared; drift to dropping region would orphan the V-298b data-residency preference UI)", () => {
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/account\/me', \{\s*\n?\s*method: 'PATCH',/,
    );
    expect(body).toMatch(
      /name: name\.length > 0 \? name : null,\s*\n?\s*timezone: tz\.length > 0 \? tz : null,/,
    );
    expect(body).toMatch(/body\.slug = slug\.length > 0 \? slug : null;/);
    expect(body).toMatch(/body\.region = region\.length > 0 \? region : null;/);
  });

  it("V-298b region 3-option preference: us / eu / apac — pinned so the data-residency preference taxonomy stays consistent + the 'sub-processor list governs physical routing' clarifier stays explicit (drift to dropping APAC would orphan ANZ/JP customers; drift to dropping the sub-processor link would let customers think the preference forces physical routing)", () => {
    expect(body).toMatch(/<option value="us">us — Americas<\/option>/);
    expect(body).toMatch(/<option value="eu">eu — Europe<\/option>/);
    expect(body).toMatch(/<option value="apac">apac — Asia-Pacific<\/option>/);
    expect(body).toMatch(
      /sub-processor list \(see <a href="https:\/\/driftstack\.dev\/trust\/sub-processors\/"/,
    );
  });

  it('profile late-load and ambiguous-save guards preserve customer input', () => {
    expect(body).toMatch(/profileEditedBeforeHydration/);
    expect(body).toMatch(/accountMatchesProfile\(account, body\)/);
    expect(body).toMatch(/copy them, then reload to verify before trying again/);
  });

  it('V-352b avatar upload contract: 2MB max + PNG/JPEG/WebP only + R2 EU storage + POST /v1/account/me/avatar { content_type, data_base64 } + DELETE /v1/account/me/avatar — pinned so the upload constraints (size + types + region) + the base64 wire format + the DELETE-to-remove contract all survive (drift to dropping size limit would let bad actors flood R2 with multi-GB avatars; drift to dropping base64 would change the wire format)', () => {
    // S30 2026-07-07 (founder decision: soften) — the "(EU)" tag
    // over-claimed: avatars live on R2 in the default jurisdiction
    // (EU + US replication). Size/type/wire-format guards unchanged.
    expect(body).toMatch(/PNG, JPEG, or WebP\. Max 2 MB\. Stored privately on Cloudflare R2\./);
    expect(body).not.toMatch(/Cloudflare R2 \(EU\)/);
    expect(body).toMatch(/if \(file\.size > 2 \* 1024 \* 1024\) \{/);
    expect(body).toMatch(/if \(!\/\^image\\\/\(png\|jpeg\|webp\)\$\/\.test\(file\.type\)\) \{/);
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/account\/me\/avatar', \{\s*\n?\s*method: 'POST',/,
    );
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/account\/me\/avatar', \{\s*\n?\s*method: 'DELETE',/,
    );
    expect(body).toMatch(/data-field="avatar-source"/);
    expect(body).toMatch(/avatarRemoveBtn\.hidden = source !== 'user'/);
    expect(body).toMatch(/fetchCurrentAccount\(\)/);
  });

  it("V-331b act-as header in authedFetch — pinned so the team-scoped flow propagates to settings reads/writes (drift would let team managers accidentally modify their OWN email prefs when trying to manage a team-mate's account)", () => {
    expect(body).toMatch(
      /\/\/ V-331b — act-as header for team-scoped requests\.\s*\n?\s*\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
  });

  it('moved-to-/security header cross-link pinned with canonical /security/ href — customers hunting the old surfaces get the pointer instead of reading the split as a feature removal', () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /Security, sign-ins &amp; danger zone moved to\s*\n?\s*<a href="\/security\/" class="text-tk-accent-text underline">Privacy &amp; security<\/a>\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('BYOK card and API share the metadata-only has_key/set_at/last_used_at response contract', () => {
    const route = read(BYOK_ROUTE);
    expect(route).toMatch(
      /return \{\s*\n?\s*has_key: meta\.hasKey,\s*\n?\s*set_at: meta\.setAt \? meta\.setAt\.toISOString\(\) : null,\s*\n?\s*last_used_at: meta\.lastUsedAt \? meta\.lastUsedAt\.toISOString\(\) : null,\s*\n?\s*\};/,
    );
    expect(body).toMatch(/body\.has_key !== true/);
    expect(body).toMatch(/body\.set_at/);
    expect(body).toMatch(/body\.last_used_at/);
    expect(body).not.toMatch(/body\.key_set|body\.key_prefix|data-byok-prefix/);
  });

  it('bundled-AI card exposes live consent, exact cap bounds, spend/reset status, honest pricing, and BYOK priority', () => {
    expect(body).toMatch(/data-region="bundled-llm"/);
    expect(body).toMatch(/Builder and Scale use a flat[\s\S]{0,100}\$0\.10 per agent turn/);
    expect(body).toMatch(/Enterprise uses your contracted custom rate/);
    expect(body).toMatch(/A stored Anthropic BYOK key takes[\s\S]{0,80}priority/);
    expect(body).toMatch(
      /data-field="bundled-cap-usd"[\s\S]{0,250}min="0"[\s\S]{0,100}max="10000"[\s\S]{0,100}step="0\.01"/,
    );
    expect(body).toMatch(/data-field="bundled-used"/);
    expect(body).toMatch(/data-field="bundled-remaining"/);
    expect(body).toMatch(/data-field="bundled-reset"/);
    expect(body).toMatch(/Exact range \$0–\$10,000/);
  });

  it('bundled-AI wiring uses dedicated load failure/retry, busy reasons, and authoritative timeout reconciliation without optimistic mutation', () => {
    expect(body).toMatch(/authedFetch\('\/v1\/account\/me\/bundled-llm-status'/);
    expect(body).toMatch(/authedFetch\('\/v1\/account\/me\/bundled-llm-settings'/);
    expect(body).toMatch(/data-bundled-state="error"/);
    expect(body).toMatch(/data-bundled-retry/);
    expect(body).toMatch(/let bundledLoadGeneration = 0/);
    expect(body).toMatch(/let bundledSaving = false/);
    expect(body).toMatch(/bundledSave\.toggleAttribute\('aria-busy', bundledSaving\)/);
    expect(body).toMatch(/Wait for the current AI settings save to finish/);
    expect(body).toMatch(
      /if \(err && err\.name === 'AbortError'\)[\s\S]{0,500}fetchBundledStatus\(\)/,
    );
    expect(body).toMatch(
      /live\.consent === desired\.consent &&[\s\S]{0,100}live\.cap_cents === desired\.monthly_cap_usd_cents/,
    );
    expect(body).toMatch(/The save outcome is unknown and live settings could not be refreshed/);
    expect(body).not.toMatch(/bundledConsent\.checked = desired\.consent/);
    expect(body).not.toMatch(/bundledCapUsd\.value = desired/);
  });
});
