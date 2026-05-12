// W302.B — drift guard for the default OG image asset. The
// BaseLayout references `/og-default.<ext>` for social-card preview
// renders. The file must exist under public/ so crawlers don't 404.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/marketing-site/src/layouts/BaseLayout.astro');
const PUBLIC = resolve(REPO_ROOT, 'apps/marketing-site/public');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W302.B BaseLayout og-default asset presence', () => {
  it('BaseLayout cites a real /og-default.<ext> file under public/', () => {
    const body = read(LAYOUT);
    const m = body.match(/\?\?\s*['"]\/og-default\.(png|jpg|jpeg|svg)['"]/);
    expect(m).not.toBeNull();
    const ext = m![1]!;
    const path = resolve(PUBLIC, `og-default.${ext}`);
    expect(existsSync(path)).toBe(true);
  });
});
