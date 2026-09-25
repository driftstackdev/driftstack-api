// W302.B — drift guard for the default OG image asset. The
// BaseLayout references the site-wide card for social-card preview
// renders. The file must exist under public/ so crawlers don't 404.
// 2026-09-25 — the card is the LIGHT `/og-light.<ext>`, a new name (the
// dark /og-default.png stays on disk for docs and cached previews, but
// BaseLayout no longer cites it), so the guard follows the new name.

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
  it('BaseLayout cites a real /og-light.<ext> file under public/', () => {
    const body = read(LAYOUT);
    const m = body.match(/\?\?\s*['"]\/og-light\.(png|jpg|jpeg|svg)['"]/);
    expect(m).not.toBeNull();
    const ext = m![1]!;
    const path = resolve(PUBLIC, `og-light.${ext}`);
    expect(existsSync(path)).toBe(true);
  });
});
