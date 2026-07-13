import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/auth/magic-link-request.astro');

describe('customer-dashboard magic-link request reliability', () => {
  const body = readFileSync(PAGE, 'utf8');

  it('serializes request submissions with accessible busy feedback', () => {
    expect(body).toContain('let requestInFlight = false;');
    expect(body).toContain('if (requestInFlight) return;');
    expect(body).toContain('requestInFlight = true;');
    expect(body).toContain("submitBtn.setAttribute('aria-busy', on ? 'true' : 'false')");
    expect(body).toContain("submitBtn.textContent = on ? 'Sending…' : submitLabel");
  });

  it('bounds the POST and always releases the request lease', () => {
    expect(body).toContain('const REQUEST_TIMEOUT_MS = 15_000;');
    expect(body).toMatch(/const controller = new AbortController\(\);/);
    expect(body).toMatch(/window\.setTimeout\(\(\) => controller\.abort\(\), REQUEST_TIMEOUT_MS\)/);
    expect(body).toMatch(/signal: controller\.signal/);
    expect(body).toMatch(/window\.clearTimeout\(timeout\)/);
    expect(body).toMatch(
      /\.finally\(\(\) => \{\s*window\.clearTimeout\(timeout\);\s*requestInFlight = false;/,
    );
  });

  it('turns an abort into actionable recovery copy', () => {
    expect(body).toContain("err && err.name === 'AbortError'");
    expect(body).toContain(
      'Sending the magic link took too long. Check your connection and try again.',
    );
  });
});
