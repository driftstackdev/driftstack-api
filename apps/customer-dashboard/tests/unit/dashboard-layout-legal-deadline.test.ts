import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(
  resolve(process.cwd(), 'apps/customer-dashboard/src/layouts/DashboardLayout.astro'),
  'utf8',
);

describe('DashboardLayout legal acceptance deadline', () => {
  it('bounds both legal hydration and acceptance writes with a timer-cleaned signal', () => {
    expect(layout).toContain('const LEGAL_REQUEST_TIMEOUT_MS = 15_000;');
    expect(layout).toContain('const controller = new AbortController();');
    expect(layout).toContain('clearTimeout(timeoutId);');
    expect(layout).toMatch(
      /fetchLegalWithDeadline\(apiBaseUrl \+ '\/v1\/legal\/required', \{ headers \}\)/,
    );
    expect(layout).toMatch(/fetchLegalWithDeadline\(apiBaseUrl \+ '\/v1\/legal\/accept', \{/);
  });

  it('restores the disabled accept action with a specific timeout message', () => {
    expect(layout).toContain(
      "err && err.name === 'AbortError'\n                        ? 'Acceptance took too long — check your connection and retry.'",
    );
    expect(layout).toMatch(
      /\.catch\(function \(err\) \{[\s\S]*?acceptAllBtn\.disabled = false;[\s\S]*?\}\);/,
    );
  });
});

describe('DashboardLayout account shell reliability', () => {
  it('reveals the reserved identity and sign-out block before account transport starts', () => {
    const revealAt = layout.indexOf(
      "const signedInBlock = document.querySelector('[data-signed-in-as]')",
    );
    const fetchAt = layout.indexOf("fetchAccountShellWithDeadline(apiBaseUrl + '/v1/account/me'");
    expect(revealAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(revealAt);
    expect(layout.slice(revealAt, fetchAt)).toContain(
      "signedInBlock.classList.remove('invisible');",
    );
  });

  it('bounds account and staff probes with one timer-cleaned helper', () => {
    expect(layout).toContain('const ACCOUNT_SHELL_TIMEOUT_MS = 10_000;');
    expect(layout).toContain(
      "fetchAccountShellWithDeadline(apiBaseUrl + '/v1/admin/audit-log?limit=1'",
    );
    expect(layout).toMatch(
      /function fetchAccountShellWithDeadline[\s\S]*?controller\.abort\(\)[\s\S]*?clearTimeout\(timeoutId\)/,
    );
  });
});
