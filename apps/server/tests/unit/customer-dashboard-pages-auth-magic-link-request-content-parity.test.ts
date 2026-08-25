// Drift guard for apps/customer-dashboard/src/pages/auth/magic-
// link-request.astro. Pins the #190 magic-link-request flow + the
// anti-enumeration response-shape contract + the debug-token
// dev-convenience escape hatch.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/auth/magic-link-request.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('customer-dashboard auth/magic-link-request content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('#190 + V-079 doc-comment framing pinned: pairs with backend route `POST /v1/auth/magic-link/request`. Drift to renaming the endpoint would orphan the frontend-backend pairing', () => {
    expect(body).toMatch(/\/\/ #190 — Magic-link REQUEST page/);
    expect(body).toMatch(/`POST \/v1\/auth\/magic-link\/request`/);
  });

  it("anti-enumeration response-shape contract pinned: 'shape is stable regardless of whether the email matches an account'. Drift to returning different shapes on match-vs-no-match would re-introduce email-enumeration as a side channel", () => {
    expect(body).toMatch(
      /shape is stable regardless of whether the email matches an\s*\/\/?\s*account \(anti-enumeration — same posture as forgot-password\)/,
    );
  });

  it('debug-token dev-convenience contract pinned: AUTH_EXPOSE_DEBUG_TOKEN=true gates the field surfacing. Drift to surfacing the token unconditionally would let local-dev leak into prod responses (silently weakening the security posture)', () => {
    expect(body).toMatch(/AUTH_EXPOSE_DEBUG_TOKEN=true on the server/);
    expect(body).toMatch(/a `debug_token` field is surfaced as a paste-into link/);
  });

  it('forgot-password shape-parity framing pinned: drift to diverging the two no-leak self-service flows would create UX inconsistency + complicate cross-flow help-text', () => {
    expect(body).toMatch(
      /Mirrors forgot-password\.astro's shape so the visual \+ behavior are\s*\/\/?\s*consistent across the two no-leak self-service flows/,
    );
  });

  it('withSidebar={false} on DashboardLayout — unauthenticated landing surface; drift would surface broken sidebar nav to users not yet signed in', () => {
    expect(body).toMatch(/<DashboardLayout title="Magic-link sign-in" withSidebar=\{false\}>/);
  });

  it('shows honest in-flight feedback, blocks duplicate requests, and keeps an ambiguous timed-out delivery latched', () => {
    expect(body).toMatch(/if \(requestInFlight\) return;/);
    expect(body).toMatch(/if \(requestOutcomeUnknown\) return;/);
    expect(body).toMatch(/if \(requestResponseAccepted\) return;/);
    expect(body).toMatch(/setSubmitting\(true\);/);
    expect(body).toMatch(/submitBtn\.setAttribute\('aria-busy', on \? 'true' : 'false'\);/);
    expect(body).toMatch(/submitBtn\.textContent = on \? 'Sending…' : submitLabel;/);
    expect(body).toMatch(/const REQUEST_TIMEOUT_MS = 15_000;/);
    expect(body).toMatch(/signal: controller\.signal,/);
    expect(body).toMatch(
      /if \(controller\.signal\.aborted\) \{\s*showUnknownOutcome\(email\);\s*return;/,
    );
    expect(body).toMatch(
      /requestInFlight = false;\s*if \(!requestOutcomeUnknown && !requestResponseAccepted\) setSubmitting\(false\);/,
    );
    expect(body).toMatch(
      /if \(r\.ok\) \{\s*requestResponseAccepted = true;[\s\S]*?if \(requestResponseAccepted\) \{[\s\S]*?form\.classList\.add\('hidden'\);[\s\S]*?success\.classList\.remove\('hidden'\);\s*return;/,
    );
    expect(
      body.replace('!requestOutcomeUnknown && !requestResponseAccepted', '!requestOutcomeUnknown'),
    ).not.toMatch(
      /requestInFlight = false;\s*if \(!requestOutcomeUnknown && !requestResponseAccepted\) setSubmitting\(false\);/,
    );
  });
});
