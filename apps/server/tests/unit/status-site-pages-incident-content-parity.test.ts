// Drift guard for apps/status-site/src/pages/incident.astro. Pins
// the V-545.A public-incident-detail view + the no-auth-no-cookie
// framing + the ?id query-param URL contract.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/status-site/src/pages/incident.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('status-site pages/incident content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('V-545.A doc-comment framing pinned: public incident-detail view reads ?id=inc_<uuid> from URL. Drift to a different query-param shape would break shareable incident links + the customers who bookmark them', () => {
    expect(body).toMatch(/\/\/ V-545\.A — public incident-detail view\./);
    expect(body).toMatch(/Reads `\?id=inc_<uuid>` from\s*\/\/?\s*the URL on the client/);
  });

  it("no-auth + no-cookie posture pinned: 'the endpoint is no-auth so the fetch happens directly from the browser; the page itself sets no cookies and does not log visitors'. Drift to introducing auth or cookies would break the public-status-page-without-tracking promise that mirrors index.astro", () => {
    expect(body).toMatch(/endpoint is no-auth/);
    expect(body).toMatch(/page itself sets no\s*\/\/?\s*cookies and does not log visitors/);
    expect(body).toMatch(/same posture as index\.astro/);
  });

  it("static-page-with-query-param framing pinned: Astro static-output can't do dynamic [id].astro without enumerating ids at build time, which isn't possible for incident ids. Drift to dropping the rationale would lose the engineering trace if a future refactor tries to convert this to a dynamic route", () => {
    expect(body).toMatch(/Static page — Astro static-output mode doesn't allow dynamic/);
    expect(body).toMatch(/`\[id\]\.astro` routes without prerendering an enumerated set/);
  });

  it("API_BASE env-var fallback pinned: PUBLIC_API_BASE_URL ?? 'https://api.driftstack.dev'. Drift to a different default would route the public-status fetch to the wrong host on deploys that skip the env var", () => {
    expect(body).toMatch(
      /const API_BASE = import\.meta\.env\.PUBLIC_API_BASE_URL \?\? 'https:\/\/api\.driftstack\.dev'/,
    );
  });

  it('3-state UX (loading / error / incident-shown) pinned: drift to dropping the error state would leave customers with a stuck loading spinner when the incident id is wrong or admin-only', () => {
    expect(body).toMatch(/id="loading"/);
    expect(body).toMatch(/id="error"/);
    expect(body).toMatch(/id="incident"/);
    expect(body).toMatch(/Incident not found/);
  });

  it("Admin-only-may-not-be-public hint pinned: explains why 'incident not found' might mean the incident is admin-only rather than deleted. Drift to dropping would let customers think every 'not found' is a bad-id, missing the V-545.A admin-only-incidents semantic", () => {
    expect(body).toMatch(/it may be\s+admin-only \(not yet public\)/);
  });

  it('recoverable fetch failures use friendly copy plus a one-click retry; malformed/not-found links remain distinct and non-retryable', () => {
    expect(body).toMatch(/data-incident-retry/);
    expect(body).toMatch(/showError\('Incident details are temporarily unavailable\.', true\)/);
    expect(body).toMatch(
      /showError\('Could not reach the status service\. Check your connection and try again\.', true\)/,
    );
    expect(body).toMatch(/showError\('This incident link is incomplete or invalid\.'\)/);
    expect(body).toMatch(/showError\('Incident not found\.'\)/);
    expect(body).toMatch(/retry\.textContent = 'Retrying…'/);
    expect(body).not.toMatch(/Could not reach the status API: \$\{msg\}/);
  });
});
