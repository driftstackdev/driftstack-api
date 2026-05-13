// W382.B — drift guard for marketing-site BaseLayout.astro content.
// Existing base-layout-canonical-parity + base-layout-og-meta-parity
// pin canonical + OG-meta presence. This guard pins the load-bearing
// claims for the full layout surface:
//
//   • Props: title (req) + description (default) + pathname +
//     ogImage + V-255 noindex (opt-in).
//   • Default description: "iPhone Safari sessions, on demand.
//     Premium fidelity for the device that matters."
//   • fullTitle: "Driftstack" verbatim if title === 'Driftstack',
//     else "${title} · Driftstack".
//   • canonical = new URL(pathname, Astro.site).
//   • V-255 noindex,nofollow conditional (default index,follow).
//   • OG/Twitter card meta: 11 tags pinned (og:title/description/
//     url/type/site_name/image/image:width=1200/image:height=630/
//     twitter:card=summary_large_image/twitter:title/description/
//     image).
//   • Inline SVG favicon (oxblood #722F37 D-badge).
//   • /og-default.svg fallback for ogImage.
//   • Header + Footer components imported.
//   • <slot /> inside <main class="flex-1">.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/marketing-site/src/layouts/BaseLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W382.B marketing-site BaseLayout.astro content parity', () => {
  const body = read(LAYOUT);

  it('imports Header + Footer + base.css', () => {
    expect(body).toMatch(/import '\.\.\/styles\/base\.css';/);
    expect(body).toMatch(/import Header from '\.\.\/components\/Header\.astro';/);
    expect(body).toMatch(/import Footer from '\.\.\/components\/Footer\.astro';/);
  });

  it('Props interface: 5 props (title required + description + pathname + ogImage + noindex)', () => {
    expect(body).toMatch(/interface Props \{/);
    expect(body).toMatch(/title: string;/);
    expect(body).toMatch(/description\?: string;/);
    expect(body).toMatch(/pathname\?: string;/);
    expect(body).toMatch(/ogImage\?: string;/);
    expect(body).toMatch(/noindex\?: boolean;/);
  });

  it('V-255 noindex framing pinned (draft / pre-counsel-review pages)', () => {
    expect(body).toMatch(
      /V-255 — set true on draft \/ pre-counsel-review pages so search\s*\n?\s*\*\s*engines don't index them as binding/,
    );
  });

  it('default description: "iPhone Safari sessions, on demand. Premium fidelity for the device that matters."', () => {
    expect(body).toMatch(
      /description = 'iPhone Safari sessions, on demand\. Premium fidelity for the device that matters\.',/,
    );
  });

  it('fullTitle pattern: "Driftstack" verbatim if title === "Driftstack", else "${title} · Driftstack"', () => {
    expect(body).toMatch(
      /const fullTitle = title === 'Driftstack' \? title : `\$\{title\} · Driftstack`;/,
    );
  });

  it('canonical link uses Astro.site + pathname', () => {
    expect(body).toMatch(/const canonical = new URL\(pathname, Astro\.site\)\.toString\(\);/);
    expect(body).toMatch(/<link rel="canonical" href=\{canonical\} \/>/);
  });

  it('OG image fallback: /og-default.svg at the site root', () => {
    expect(body).toMatch(/Defaults to \/og-default\.svg at the site root/);
    expect(body).toMatch(
      /const ogImageUrl = new URL\(ogImage \?\? '\/og-default\.svg', Astro\.site\)\.toString\(\);/,
    );
  });

  it('noindex conditional: noindex,nofollow vs index,follow', () => {
    expect(body).toMatch(
      /<meta name="robots" content=\{noindex \? 'noindex,nofollow' : 'index,follow'\} \/>/,
    );
  });

  it('7 OG meta tags pinned (title / description / url / type / site_name / image / image dimensions)', () => {
    expect(body).toMatch(/<meta property="og:title" content=\{fullTitle\} \/>/);
    expect(body).toMatch(/<meta property="og:description" content=\{description\} \/>/);
    expect(body).toMatch(/<meta property="og:url" content=\{canonical\} \/>/);
    expect(body).toMatch(/<meta property="og:type" content="website" \/>/);
    expect(body).toMatch(/<meta property="og:site_name" content="Driftstack" \/>/);
    expect(body).toMatch(/<meta property="og:image" content=\{ogImageUrl\} \/>/);
    expect(body).toMatch(/<meta property="og:image:width" content="1200" \/>/);
    expect(body).toMatch(/<meta property="og:image:height" content="630" \/>/);
  });

  it('4 Twitter/X meta tags pinned (card=summary_large_image / title / description / image)', () => {
    expect(body).toMatch(/<meta name="twitter:card" content="summary_large_image" \/>/);
    expect(body).toMatch(/<meta name="twitter:title" content=\{fullTitle\} \/>/);
    expect(body).toMatch(/<meta name="twitter:description" content=\{description\} \/>/);
    expect(body).toMatch(/<meta name="twitter:image" content=\{ogImageUrl\} \/>/);
  });

  it('R15 favicon points at /driftstack-mark.svg (the brand iPhone-D mark) — replaces the prior inline data-URL placeholder favicon (Georgia-serif white D on oxblood-tile) with the real brand SVG asset shipped under apps/marketing-site/public/', () => {
    expect(body).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/driftstack-mark\.svg(\?v=\d+)?" \/>/,
    );
  });

  it('renders <Header /> + <slot /> in <main class="flex-1"> + <Footer />', () => {
    expect(body).toMatch(/<Header \/>/);
    expect(body).toMatch(/<main class="flex-1">\s*\n?\s*<slot \/>\s*\n?\s*<\/main>/);
    expect(body).toMatch(/<Footer \/>/);
  });

  it('html lang="en" + charset UTF-8 + viewport meta', () => {
    expect(body).toMatch(/<html lang="en" class="dark">/);
    expect(body).toMatch(/<meta charset="UTF-8" \/>/);
    expect(body).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
  });

  it('og-default.svg fallback file exists in public/', () => {
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/public/og-default.svg'))).toBe(true);
  });

  it('Header + Footer components exist', () => {
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/components/Header.astro'))).toBe(
      true,
    );
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/src/components/Footer.astro'))).toBe(
      true,
    );
  });
});
