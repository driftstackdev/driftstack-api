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
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { BUNDLED_CAP_MAX_NEW_WRITE_CENTS } from '../../src/services/bundled-llm.js';
import { codeOnly } from './_helpers/code-only.js';
import { markupOnly } from './_helpers/markup-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/settings.astro');
const BYOK_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-byok-anthropic.ts');
const BUNDLED_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/account-bundled-llm.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** The page's inline script with its comments removed, so a pin cannot be met by prose. */
function pageScript(page: string): string {
  const match = page.match(
    /<script is:inline define:vars=\{\{ apiBaseUrl \}\}>([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) throw new Error('settings inline script not found');
  return codeOnly(match[1]);
}

/** The page's markup with its HTML and expression comments removed. */
function pageMarkup(page: string): string {
  return markupOnly(page);
}

describe('W497.C apps/customer-dashboard/src/pages/settings.astro content parity', () => {
  const body = read(LIB);

  it("V-217 framing pinned: 'progressive-enhancement live wiring against: /v1/account/email-preferences (V-204) — list + PUT per-event toggles' — pinned so the remaining live-wire scope + the V-204 provenance survive (the V-216/V-079 wires moved to security.astro with the 2026-07-03 split)", () => {
    expect(body).toMatch(
      /\/\/ V-217 — progressive-enhancement live wiring against:\s*\/\/ {3}- \/v1\/account\/email-preferences \(V-204\) — list \+ PUT per-event toggles/,
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
      /Security and billing emails \(verification, password reset, failed\s*payments, support replies\) are always sent\. The emails below are\s*optional — switch off any you don't want\./,
    );
    expect(body).toMatch(
      /When you cancel, the only email you may get is "Subscription tier\s*changed" below\./,
    );
  });

  it("V-352 + V-298a + V-298b profile form contract: PATCH /v1/account/me { name, timezone, slug?, region? } with null-on-empty + IANA timezone hint — pinned so the 4-field profile mutation contract stays consistent (drift to dropping null-on-empty would force customers to keep filling fields they've cleared; drift to dropping region would orphan the V-298b data-residency preference UI)", () => {
    expect(body).toMatch(/boundedFetch\(apiBaseUrl \+ '\/v1\/account\/me', \{\s*method: 'PATCH',/);
    expect(body).toMatch(
      /name: name\.length > 0 \? name : null,\s*timezone: tz\.length > 0 \? tz : null,/,
    );
    expect(body).toMatch(/body\.slug = slug\.length > 0 \? slug : null;/);
    expect(body).toMatch(/body\.region = region\.length > 0 \? region : null;/);
  });

  it("V-298b region 3-option preference: us / eu / apac — pinned so the data-residency preference taxonomy stays consistent + the 'sub-processor list governs physical routing' clarifier stays explicit (drift to dropping APAC would orphan ANZ/JP customers; drift to dropping the sub-processor link would let customers think the preference forces physical routing)", () => {
    expect(body).toMatch(/<option value="us">us — Americas<\/option>/);
    expect(body).toMatch(/<option value="eu">eu — Europe<\/option>/);
    expect(body).toMatch(/<option value="apac">apac — Asia-Pacific<\/option>/);
    expect(body).toMatch(
      /doesn't change where your data is\s*stored today\. See <a href="https:\/\/driftstack\.io\/trust\/sub-processors\/"/,
    );
  });

  it('profile late-load and ambiguous-save guards preserve customer input', () => {
    expect(body).toMatch(/profileEditedBeforeHydration/);
    expect(body).toMatch(/accountMatchesProfile\(account, body\)/);
    expect(body).toMatch(/copy them, then reload to check before trying again/);
  });

  it('V-352b avatar upload contract: 2MB max + PNG/JPEG/WebP only + R2 EU storage + POST /v1/account/me/avatar { content_type, data_base64 } + DELETE /v1/account/me/avatar — pinned so the upload constraints (size + types + region) + the base64 wire format + the DELETE-to-remove contract all survive (drift to dropping size limit would let bad actors flood R2 with multi-GB avatars; drift to dropping base64 would change the wire format)', () => {
    // S30 2026-07-07 (founder decision: soften) — the "(EU)" tag
    // over-claimed: avatars live on R2 in the default jurisdiction
    // (EU + US replication). Size/type/wire-format guards unchanged.
    expect(body).toMatch(/PNG, JPEG or WebP, up to 2 MB\. Stored privately\./);
    expect(body).not.toMatch(/Cloudflare R2 \(EU\)/);
    expect(body).toMatch(/if \(file\.size > 2 \* 1024 \* 1024\) \{/);
    expect(body).toMatch(/if \(!\/\^image\\\/\(png\|jpeg\|webp\)\$\/\.test\(file\.type\)\) \{/);
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/account\/me\/avatar', \{\s*method: 'POST',/,
    );
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/account\/me\/avatar', \{\s*method: 'DELETE',/,
    );
    expect(body).toMatch(/data-field="avatar-source"/);
    expect(body).toMatch(/avatarRemoveBtn\.hidden = source !== 'user'/);
    expect(body).toMatch(/fetchCurrentAccount\(\)/);
  });

  it("V-331b act-as header in authedFetch — pinned so the team-scoped flow propagates to settings reads/writes (drift would let team managers accidentally modify their OWN email prefs when trying to manage a team-mate's account)", () => {
    expect(body).toMatch(
      /\/\/ V-331b — act-as header for team-scoped requests\.\s*\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\? window\.driftstackActAsHeaders\(\)\s*: \{\}\),/,
    );
  });

  it('moved-to-/security header cross-link pinned with canonical /security/ href — customers hunting the old surfaces get the pointer instead of reading the split as a feature removal', () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    expect(body).toMatch(
      /Security, sign-ins &amp; danger zone moved to\s*<a href="\/security\/" class="text-tk-accent-text underline">Privacy &amp; security<\/a>\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('BYOK card and API share the metadata-only has_key/set_at/last_used_at response contract', () => {
    const route = read(BYOK_ROUTE);
    expect(route).toMatch(
      /return \{\s*has_key: meta\.hasKey,\s*set_at: meta\.setAt \? meta\.setAt\.toISOString\(\) : null,\s*last_used_at: meta\.lastUsedAt \? meta\.lastUsedAt\.toISOString\(\) : null,\s*\};/,
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
    expect(body).toMatch(
      /If you've saved your own Anthropic\s*API key, it's used first, billed by Anthropic/,
    );
    expect(body).toMatch(
      /data-field="bundled-cap-usd"[\s\S]{0,250}min="0"[\s\S]{0,100}max="100"[\s\S]{0,100}step="0\.01"/,
    );
    expect(body).toMatch(/data-field="bundled-used"/);
    expect(body).toMatch(/data-field="bundled-remaining"/);
    expect(body).toMatch(/data-field="bundled-reset"/);
    expect(body).toMatch(
      /Up to \$100\. A \$0 limit stops all bundled AI use, even when it's enabled\./,
    );
    // The old ceiling, which the server no longer accepts as a new limit.
    expect(pageMarkup(body)).not.toMatch(/\$10,000|max="10000"/);
    expect(pageScript(body)).not.toMatch(/\$10,000/);
  });

  it('the cap input accepts exactly what the server accepts: at most $100 for a new limit, and a kept higher limit only unchanged or lowered', () => {
    const script = pageScript(body);
    const markup = pageMarkup(body);
    // The page's new-limit maximum is the server's, not a copy that can drift.
    const pinned = script.match(/const BUNDLED_CAP_NEW_MAX_CENTS = ([\d_]+);/);
    expect(pinned?.[1]).toBeDefined();
    expect(Number(pinned?.[1]?.replace(/_/g, ''))).toBe(BUNDLED_CAP_MAX_NEW_WRITE_CENTS);
    // The ceiling is the larger of $100 and the limit last loaded from the server…
    expect(script).toMatch(
      /function bundledCapCeilingCents\(\) \{\s*return Math\.max\(BUNDLED_CAP_NEW_MAX_CENTS, bundledLoadedCapCents\);\s*\}/,
    );
    // …remembered on every load and set as the input's max, so a kept limit above
    // $100 never sits over a lower max that blocks the browser's submit (the form
    // has no novalidate).
    expect(script).toMatch(
      /function renderBundledStatus\(status\) \{[\s\S]{0,200}bundledLoadedCapCents = status\.cap_cents;[\s\S]{0,100}bundledCapUsd\.max = \(bundledCapCeilingCents\(\) \/ 100\)\.toFixed\(2\);\s*bundledCapUsd\.value = \(status\.cap_cents \/ 100\)\.toFixed\(2\);/,
    );
    // The client check refuses anything above that ceiling before sending it.
    expect(script).toMatch(
      /function desiredBundledSettings\(\) \{[\s\S]{0,200}const ceilingCents = bundledCapCeilingCents\(\);[\s\S]{0,700}cents > ceilingCents/,
    );
    // A kept limit above $100 is explained, and only then.
    expect(markup).toMatch(
      /<p data-bundled-cap-kept class="[^"]*\bhidden\b[^"]*">\s*Your current limit was set before new limits were capped at \$100\. You can keep it or\s*lower it, but not raise it\.\s*<\/p>/,
    );
    expect(script).toMatch(
      /bundledCapKept\.classList\.toggle\('hidden', status\.cap_cents <= BUNDLED_CAP_NEW_MAX_CENTS\)/,
    );
  });

  it("a cap the server refuses is explained in dollars, keyed to the route's own problem type and field", () => {
    const script = pageScript(body);
    const route = codeOnly(read(BUNDLED_ROUTE));
    // The route refuses a cap as a validation problem naming monthly_cap_usd_cents…
    expect(route).toMatch(
      /throw new ValidationError\(\{\s*formErrors: \[\],\s*fieldErrors: \{ monthly_cap_usd_cents: \[refusal\] \},\s*\}\)/,
    );
    // …and the page recognises exactly that shape.
    expect(script).toContain(`body.type !== '${PROBLEM_TYPES.ValidationFailed}'`);
    expect(script).toMatch(/fieldErrors\.monthly_cap_usd_cents/);
    expect(script).toMatch(
      /if \(isBundledCapRefusal\(response, body\)\) \{[\s\S]{0,200}throw refused;[\s\S]{0,20}\}\s*throw window\.driftstackResponseError\(response, body\);/,
    );
    // It says the rule in dollars — the server's own text names the API field in cents.
    expect(script).toMatch(
      /const BUNDLED_CAP_REFUSED_MESSAGE =\s*'That limit was not accepted\. New limits are at most \$100, and a limit already above \$100 can be kept or lowered, but not raised\.';/,
    );
    expect(script).not.toMatch(/showBundledError\([^)]*capErrors/);
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
    expect(body).toMatch(/we couldn't refresh your settings\. Reload to check before trying again/);
    expect(body).not.toMatch(/bundledConsent\.checked = desired\.consent/);
    expect(body).not.toMatch(/bundledCapUsd\.value = desired/);
  });
});
