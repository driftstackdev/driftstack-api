// W508.A — drift guard for apps/marketing-site/src/pages/docs/sentry-integration.astro.
// V-709 + W226.A accuracy pass. Drift here either re-introduces
// fictional customer-facing Sentry forwarding (would mislead customers
// into expecting a feature that doesn't exist) or breaks the honest
// 'Sentry internally only today' framing.
//
//   • V-709 + W226.A doc-comment framing.
//   • Status banner: 'no customer-configurable Sentry forwarder'
//     explicit-no.
//   • Internal Sentry use + PII-scrubbing at apps/server/src/lib/sentry.ts.
//   • Sentry on Driftstack sub-processor list, not customer's.
//   • Customer page Sentry forwards to customer Sentry, not Driftstack's.
//   • Until-customer-forwarding-ships pattern: 3-step page-side
//     instrumentation + Sentry.setTag('driftstack_session_id', …).
//   • Roadmap: POST /v1/account/integrations/sentry + integration.sentry.degraded
//     webhook event.
//   • integrations@driftstack.dev contact.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sentry-integration.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W508.A apps/marketing-site/src/pages/docs/sentry-integration.astro content parity', () => {
  const body = read(LIB);

  it("V-709 + W226.A accuracy-pass framing pinned: 'W226.A — accuracy pass. The previous revision documented a customer-configurable Sentry forwarding feature (DSN setting, dashboard integration, sample-rate, source-map upload field on sessions.start) that does NOT exist anywhere in the codebase' — pinned so the V-709 + W226.A accuracy-pass + explicit 'does NOT exist anywhere in the codebase' commitment survive (drift to softening would let fictional customer-facing Sentry features regrow into the doc)", () => {
    expect(body).toMatch(/\/\/ V-709 — Sentry integration page\./);
    expect(body).toMatch(
      /\/\/ W226\.A — accuracy pass\. The previous revision documented a\s*\n?\s*\/\/ customer-configurable Sentry forwarding feature/,
    );
    expect(body).toMatch(/\/\/ sessions\.start\) that does NOT exist anywhere in the codebase:/);
  });

  it("Status banner pinned: 'there is no customer-configurable Sentry forwarder on the Driftstack control plane today. The dashboard does not expose a Sentry DSN setting, sessions.create does not accept a Sentry-related field, and we do not fan events out to customer Sentry projects.' — pinned so the 3-state explicit-no commitment (no DSN setting + sessions.create no field + no fan-out) survives (drift to softening any of the 3 would let customers think one of the three exists)", () => {
    expect(body).toMatch(
      /<strong>Status:<\/strong> there is no customer-configurable\s*\n?\s*Sentry forwarder on the Driftstack control plane today\./,
    );
    expect(body).toMatch(
      /The dashboard does not expose a Sentry DSN setting,\s*\n?\s*<code class="font-mono">sessions\.create<\/code> does not\s*\n?\s*accept a Sentry-related field, and we do not fan events out\s*\n?\s*to customer Sentry projects\./,
    );
  });

  it("Internal Sentry use + PII-scrubbing framing pinned: 'Customer payloads are scrubbed before send by the sensitive-key denylist in apps/server/src/lib/sentry.ts; raw API keys, session secrets, customer-supplied URLs, and webhook secrets never reach sentry.io.' — pinned so the 4-state never-reaches-sentry.io commitment (API keys + session secrets + customer URLs + webhook secrets) + the apps/server/src/lib/sentry.ts code-path-pointer survive (drift to dropping any of the 4 categories would let that data leak; drift to dropping the code-path would force customers to take the scrubbing claim on faith)", () => {
    expect(body).toMatch(
      /Customer payloads are scrubbed before send by the\s*\n?\s*sensitive-key denylist in\s*\n?\s*<code>apps\/server\/src\/lib\/sentry\.ts<\/code>; raw API keys,\s*\n?\s*session secrets, customer-supplied URLs, and webhook secrets\s*\n?\s*never reach sentry\.io\./,
    );
  });

  it("Sentry on Driftstack sub-processor list (not customer's) framing + session.failed webhook delivery framing pinned: 'Sentry is on the Driftstack subprocessor list, not on every customer's. Errors from your code running inside a Driftstack browser session do NOT flow into our Sentry project — they're scoped to the session and surfaced via session.failed webhook deliveries' — pinned so the customer-code-errors-don't-leak-to-Driftstack-Sentry + session.failed-as-customer-error-channel commitments survive (drift to claiming customer errors flow to Driftstack Sentry would mislead privacy-conscious customers)", () => {
    expect(body).toMatch(
      /Sentry is on the Driftstack subprocessor list, not on every\s*\n?\s*customer's\. Errors from <em>your<\/em> code running inside a\s*\n?\s*Driftstack browser session do NOT flow into our Sentry\s*\n?\s*project — they're scoped to the session and surfaced via\s*\n?\s*<code>session\.failed<\/code> webhook deliveries/,
    );
  });

  it("Until-customer-forwarding-ships 3-step instrumentation pattern: Mint a Sentry project + Inject browser SDK + Tag events with driftstack_session_id via Sentry.setTag — pinned so the 3-step DIY-instrumentation guidance + the Sentry.setTag('driftstack_session_id', …) tagging pattern survive (drift to dropping the setTag pattern would orphan customers from the Sentry-issue-back-to-Driftstack-session navigation path)", () => {
    expect(body).toMatch(/Mint a Sentry project on your side and copy its DSN\./);
    expect(body).toMatch(
      /Inject the Sentry browser SDK into your page-under-test\s*\n?\s*\(script tag, bundler import, or an injected snippet via\s*\n?\s*<code>POST \/v1\/sessions\/&lt;id&gt;\/interact<\/code>\)\./,
    );
    expect(body).toMatch(
      /Tag events with your Driftstack session id — read it\s*\n?\s*from the session-create response and pass it to\s*\n?\s*<code>Sentry\.setTag\('driftstack_session_id', …\)<\/code> on\s*\n?\s*page boot\./,
    );
  });

  it('Roadmap forwarding 3-element pinned: POST /v1/account/integrations/sentry + integration.sentry.degraded webhook event + API changelog migration-notes entry — pinned so the 3-element planned-forwarder shape (endpoint + webhook event type + changelog-publication) survives (drift to changing the endpoint path would create marketing↔roadmap divergence; drift to dropping the degraded-webhook event would leave customers without proactive failure detection)', () => {
    expect(body).toMatch(
      /A new <code>POST \/v1\/account\/integrations\/sentry<\/code>\s*\n?\s*endpoint \(and the matching dashboard form\) to register a DSN\s*\n?\s*\+ sample rate\./,
    );
    expect(body).toMatch(
      /A new <code>integration\.sentry\.degraded<\/code> webhook\s*\n?\s*event when the Sentry endpoint starts returning non-2xx\./,
    );
    expect(body).toMatch(
      /An entry on the\s*\n?\s*<a href="\/changelog">API changelog<\/a> with the migration\s*\n?\s*notes\./,
    );
  });

  it('integrations@driftstack.dev contact + 3-related-doc cross-link cluster: /docs/webhooks + /docs/data-residency + /docs/error-codes — pinned so the integrations team routing + the 3-related-doc navigation survive (drift to support@ would lose the integrations-team routing; drift to dropping /docs/error-codes would orphan the RFC-7807-type cross-reference)', () => {
    expect(body).toMatch(
      /<a href="mailto:integrations@driftstack\.dev">integrations@driftstack\.dev<\/a>/,
    );
    expect(body).toMatch(/<a href="\/docs\/webhooks">Webhooks<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/data-residency">Data residency<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/error-codes">Error codes<\/a>/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
