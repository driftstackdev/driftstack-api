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
});
