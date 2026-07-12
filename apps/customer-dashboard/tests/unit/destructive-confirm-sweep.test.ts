import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(HERE, '..', '..', 'src', 'pages');
const CONFIRM_PAGES = [
  'api-keys.astro',
  'webhooks.astro',
  'team.astro',
  'settings.astro',
  'security.astro',
];

describe('customer dashboard destructive-confirm sweep', () => {
  it('marks every consequential shared-modal confirmation as destructive', () => {
    let calls = 0;
    let guarded = 0;
    for (const page of CONFIRM_PAGES) {
      const body = readFileSync(resolve(PAGES, page), 'utf8');
      const pageCalls = body.match(/window\.driftstackConfirm\(/g) ?? [];
      const pageGuards = body.match(/destructive:\s*true/g) ?? [];
      expect(pageGuards.length, `${page}: every confirm must require an explicit OK click`).toBe(
        pageCalls.length,
      );
      calls += pageCalls.length;
      guarded += pageGuards.length;
    }
    expect(calls).toBe(10);
    expect(guarded).toBe(10);
  });
});
