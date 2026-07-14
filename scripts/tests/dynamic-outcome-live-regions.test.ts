import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type LiveRegion = {
  file: string;
  marker: string;
  role: 'alert' | 'status';
  live: 'assertive' | 'polite';
};

const LIVE_REGIONS: LiveRegion[] = [
  {
    file: 'apps/customer-dashboard/src/pages/api-keys.astro',
    marker: 'data-create-error',
    role: 'alert',
    live: 'assertive',
  },
  {
    file: 'apps/customer-dashboard/src/pages/webhooks.astro',
    marker: 'data-create-error',
    role: 'alert',
    live: 'assertive',
  },
  {
    file: 'apps/customer-dashboard/src/pages/settings.astro',
    marker: 'data-field="profile-status"',
    role: 'status',
    live: 'polite',
  },
  {
    file: 'apps/customer-dashboard/src/pages/settings.astro',
    marker: 'data-byok-error',
    role: 'status',
    live: 'polite',
  },
  {
    file: 'apps/customer-dashboard/src/pages/settings.astro',
    marker: 'data-field="email-prefs-status"',
    role: 'status',
    live: 'polite',
  },
  {
    file: 'apps/customer-dashboard/src/pages/security.astro',
    marker: 'data-field="web-sessions-status"',
    role: 'status',
    live: 'polite',
  },
  {
    file: 'apps/admin-panel/src/pages/fleet.astro',
    marker: 'data-banner',
    role: 'status',
    live: 'polite',
  },
];

function openingTagContaining(source: string, marker: string): string {
  const tag = source.match(new RegExp(`<[^>]*${marker}[^>]*>`))?.[0];
  if (!tag) throw new Error(`Missing live-region marker: ${marker}`);
  return tag;
}

describe('dynamic dashboard outcome live regions', () => {
  it.each(LIVE_REGIONS)('$file announces $marker updates', ({ file, marker, role, live }) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    const tag = openingTagContaining(source, marker);

    expect(tag).toContain(`role="${role}"`);
    expect(tag).toContain(`aria-live="${live}"`);
    expect(tag).toContain('aria-atomic="true"');
  });
});
