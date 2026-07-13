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
    expect(body).toContain("refreshBtn.setAttribute('aria-busy', 'true')");
    expect(body).toContain("refreshBtn.textContent = 'Refreshing…'");
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

  it('keeps thrown transport internals out of the visible error banner', () => {
    const body = readFileSync(SOURCE, 'utf8');
    expect(body).toContain('Could not load the queue. Check your connection and try again.');
    expect(body).not.toMatch(/Fetch failed:\s*['"]?\s*\+/);
    expect(body).not.toContain('err.message || String(err)');
  });
});
