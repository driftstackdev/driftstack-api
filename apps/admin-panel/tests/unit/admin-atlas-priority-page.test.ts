import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '..', '..', 'src', 'pages', 'atlas-priority-queue.astro');

describe('admin Atlas priority queue manual refresh', () => {
  it('is single-flight and exposes visible + accessible progress', () => {
    const body = readFileSync(SOURCE, 'utf8');
    expect(body).toContain('if (manual && manualRefreshLoading) return');
    expect(body).toContain('manualRefreshLoading = true;');
    expect(body).toContain('setRefreshAuthority(true);');
    expect(body).toContain("refreshBtn.setAttribute('aria-busy', 'true')");
    expect(body).toContain("refreshBtn.textContent = 'Refreshing…'");
    expect(body).toContain('manualRefreshLoading = false;');
    expect(body).toContain(
      "setRefreshAuthority(Boolean(getToken()), 'Available after staff sign-in.');",
    );
    expect(body).toContain("refreshBtn.setAttribute('aria-busy', 'false')");
    expect(body).toContain("refreshBtn.textContent = 'Refresh now'");
  });

  it('bounds reads, aborts superseded filters/polls, and defers initial SSO hydration', () => {
    const body = readFileSync(SOURCE, 'utf8');
    expect(body).toContain('const QUEUE_REQUEST_TIMEOUT_MS = 15000');
    expect(body).toContain('Request timed out. Try again.');
    expect(body).toContain('if (loadController) loadController.abort()');
    expect(body).toContain('window.driftstackFetchWithDeadline(');
    expect(body).toContain('QUEUE_REQUEST_TIMEOUT_MS,');
    expect(body).toContain('if (myReq === inFlight)');
    expect(body).toMatch(
      /document\.addEventListener\('DOMContentLoaded', start, \{ once: true \}\)/,
    );
  });

  it('ships a neutral, inert first paint instead of claiming a queue request is already running', () => {
    const body = readFileSync(SOURCE, 'utf8');
    expect(body).toContain('Live queue events are unavailable until loaded.');
    expect(body).not.toContain('Loading via /v1/internal/atlas-priority/queue…');
    expect(body).toMatch(
      /id="refresh-btn"\s*type="button"\s*disabled\s*aria-disabled="true"\s*title="Available after staff sign-in\."/,
    );
    for (const id of [
      'filter-status',
      'filter-customer',
      'filter-page-url',
      'filter-failures-only',
    ]) {
      expect(body).toMatch(new RegExp(`id="${id}"[\\s\\S]{0,180}?disabled`));
    }
  });

  it('fails closed when staff bearer storage is absent or unavailable and never sends a signed-out queue request', () => {
    const body = readFileSync(SOURCE, 'utf8');
    expect(body).toMatch(
      /function getToken\(\) \{\s*try \{\s*return localStorage\.getItem\('ds_web_session_token'\) \|\| '';\s*\} catch \(_\) \{\s*return '';/,
    );
    expect(body).toMatch(
      /const token = getToken\(\);\s*if \(!token\) \{[\s\S]*?renderUnavailable\('Sign in with a staff admin account to load the live queue\.'\);[\s\S]*?return false;\s*\}/,
    );
    expect(body.indexOf('if (!token) {')).toBeLessThan(
      body.indexOf('const res = await boundedFetch('),
    );
  });

  it('grants filters only after a successful current response and clears all stale regions on current failure', () => {
    const body = readFileSync(SOURCE, 'utf8');
    expect(body).toMatch(
      /renderStats\(data\.stats \|\| \{\}\);\s*renderRows\(filterClientSide\(data\.events \|\| \[\]\)\);\s*setFilterAuthority\(true\);/,
    );
    expect(body).toMatch(
      /function renderUnavailable\(message\) \{[\s\S]*?renderStatsUnavailable\(\);\s*statusLine\.textContent = message;\s*setFilterAuthority\(false, message\);/,
    );
    expect(body).toMatch(
      /if \(!res\.ok\) \{[\s\S]*?renderUnavailable\(message\);\s*showError\(message\);\s*return false;/,
    );
    expect(body).toMatch(
      /catch \(err\) \{[\s\S]*?if \(myReq !== inFlight\) return;[\s\S]*?renderUnavailable\(message\);\s*showError\(message\);\s*return false;/,
    );
  });

  it('keeps thrown transport internals out of the visible error banner', () => {
    const body = readFileSync(SOURCE, 'utf8');
    expect(body).toContain('Could not load the queue. Check your connection and try again.');
    expect(body).toContain('window.driftstackRequestErrorMessage(');
    expect(body).toContain("new Error('HTTP ' + res.status)");
    expect(body).not.toMatch(/Fetch failed:\s*['"]?\s*\+/);
    expect(body).not.toContain('err.message || String(err)');
    expect(body).not.toContain('res.statusText');
    expect(body).not.toContain("'Queue endpoint returned ' + res.status");
  });
});
