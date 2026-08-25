// W382.B — drift guard for marketing-site BaseLayout.astro content.
// Existing base-layout-canonical-parity + base-layout-og-meta-parity
// pin canonical + OG-meta presence. This guard pins the load-bearing
// claims for the full layout surface:
//
//   • Props: title (req) + description (default) + pathname +
//     ogImage + V-255 noindex (opt-in).
//   • Default description: the fleet register ("Real iPhone Safari
//     in the cloud — ... just people on phones.", S15 2026-07-03).
//   • fullTitle: preserve an already-branded title, otherwise append
//     " · Driftstack" exactly once.
//   • canonical = new URL(pathname, Astro.site).
//   • V-255 noindex,nofollow conditional (default index,follow).
//   • OG/Twitter card meta: 11 tags pinned (og:title/description/
//     url/type/site_name/image/image:width=1200/image:height=630/
//     twitter:card=summary_large_image/twitter:title/description/
//     image).
//   • Inline SVG favicon (oxblood #722F37 D-badge).
//   • /og-default.png fallback for ogImage.
//   • Header + Footer components imported.
//   • <slot /> inside <main class="flex-1">.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/marketing-site/src/layouts/BaseLayout.astro');
const BUILT_HOME = resolve(REPO_ROOT, 'apps/marketing-site/dist/index.html');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W382.B marketing-site BaseLayout.astro content parity', () => {
  it('makes only genuinely overflowing code blocks keyboard-scrollable and reverses the generated tab stop responsively', () => {
    expect(body).toContain("document.querySelectorAll('pre')");
    expect(body).toMatch(/block\.scrollWidth > block\.clientWidth \+ 1/);
    expect(body).toContain("block.setAttribute('tabindex', '0')");
    expect(body).toContain("block.setAttribute('data-scroll-focus', 'true')");
    expect(body).toContain("block.removeAttribute('tabindex')");
    expect(body).toContain("block.removeAttribute('data-scroll-focus')");
    expect(body).toContain("'ResizeObserver' in window");
  });
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
      /V-255 — set true on draft \/ pre-counsel-review pages so search\s*\*\s*engines don't index them as binding/,
    );
  });

  it('default description (S15 2026-07-03): the fleet register — "Real iPhone Safari in the cloud — to every website, they\'re just people on phones." (replaces the retired on-demand/premium-fidelity tagline)', () => {
    expect(body).toMatch(
      /description =\s*"Real iPhone Safari in the cloud — to every website, they're just people on phones\. Drive them by hand, by code, or by AI\. Start free\.",/,
    );
  });

  it('preserves any already-branded title and appends Driftstack exactly once otherwise', () => {
    expect(body).toMatch(
      /const fullTitle = title\.includes\('Driftstack'\) \? title : `\$\{title\} · Driftstack`;/,
    );
  });

  it('canonical link uses Astro.site + pathname only on indexable pages', () => {
    expect(body).toMatch(/const canonical = new URL\(pathname, Astro\.site\)\.toString\(\);/);
    expect(body).toMatch(/\{!noindex && <link rel="canonical" href=\{canonical\} \/>\}/);
  });

  it('OG image fallback: /og-default.png at the site root', () => {
    expect(body).toMatch(/Defaults to \/og-default\.png at the site root/);
    expect(body).toMatch(
      /const ogImageBase = new URL\(ogImage \?\? '\/og-default\.png', Astro\.site\)\.toString\(\);/,
    );
    expect(body).toMatch(/const ogImageUrl = ogImage \? ogImageBase : `\$\{ogImageBase\}\?v=2`;/);
  });

  it('noindex conditional: noindex,nofollow vs index,follow', () => {
    expect(body).toMatch(
      /<meta name="robots" content=\{noindex \? 'noindex,nofollow' : 'index,follow'\} \/>/,
    );
    expect(body).toMatch(/!noindex && \(\s*<>/);
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

  it('iOS apple-touch-icon points at the raster /apple-touch-icon.png (iOS requires a PNG; SVG favicon alone = blank home-screen icon)', () => {
    expect(body).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" \/>/);
  });

  it('visitor mode toggle (S13 2026-07-03): pre-paint whitelisted ds_theme_mode script + [data-theme-toggle] delegated wiring + theme-color sync — plain-code is:inline bodies only', () => {
    expect(body).toMatch(/var m = localStorage\.getItem\('ds_theme_mode'\);/);
    expect(body).toMatch(/if \(m === 'light' \|\| m === 'dark'\) \{/);
    expect(body).toMatch(/e\.target\.closest\('\[data-theme-toggle\]'\)/);
    expect(body).toMatch(/localStorage\.setItem\('ds_theme_mode', next\);/);
    expect(body).toMatch(/function syncThemeControls\(mode\)/);
    expect(body).toMatch(/control\.setAttribute\('aria-pressed', light \? 'true' : 'false'\)/);
    expect(body).toMatch(
      /var actionLabel = light \? 'Switch to dark theme' : 'Switch to light theme'/,
    );
    expect(body).toMatch(/control\.setAttribute\('aria-label', actionLabel\)/);
    expect(body).toMatch(/control\.setAttribute\('title', actionLabel\)/);
    expect(body).not.toMatch(/<script is:inline>\s*\{`/);
  });

  it('built theme controls announce the next action before and after a mode change', () => {
    const html = read(BUILT_HOME);
    const script = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
      .map((match) => match[1] ?? '')
      .find((candidate) => candidate.includes('function syncThemeControls(mode)'));
    expect(script).toBeDefined();

    const dom = new JSDOM(html, {
      url: 'https://driftstack.dev/',
      runScripts: 'outside-only',
    });
    dom.window.eval(script!);
    const controls = Array.from(
      dom.window.document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]'),
    );
    expect(controls).toHaveLength(2);
    expect(
      controls.every(
        (control) =>
          control.getAttribute('aria-label') === 'Switch to light theme' &&
          control.getAttribute('title') === 'Switch to light theme' &&
          control.getAttribute('aria-pressed') === 'false',
      ),
    ).toBe(true);

    controls[0]?.click();
    expect(dom.window.document.documentElement.getAttribute('data-mode')).toBe('light');
    expect(
      controls.every(
        (control) =>
          control.getAttribute('aria-label') === 'Switch to dark theme' &&
          control.getAttribute('title') === 'Switch to dark theme' &&
          control.getAttribute('aria-pressed') === 'true',
      ),
    ).toBe(true);
    dom.window.close();
  });

  it('progressively enhances the native mobile menu with state sync and expected dismissal paths', () => {
    expect(body).toContain("document.querySelector('[data-mobile-nav]')");
    expect(body).toMatch(/menu\.addEventListener\('toggle', syncMobileMenu\)/);
    expect(body).toMatch(/trigger\.setAttribute\('aria-expanded', expanded \? 'true' : 'false'\)/);
    expect(body).toMatch(/expanded \? 'Close navigation menu' : 'Open navigation menu'/);
    expect(body).toMatch(/event\.key !== 'Escape' \|\| !menu\.open/);
    expect(body).toMatch(/!menu\.contains\(event\.target\)/);
    expect(body).toMatch(/trigger\.focus\(\)/);
  });

  it('self-hosted font preloads (Fleet v2 port 2026-07-03): GeistVF + JetBrainsMono-Regular woff2, as="font" + crossorigin, and both files ship in public/fonts/', () => {
    expect(body).toMatch(
      /<link rel="preload" href="\/fonts\/geist\/GeistVF\.woff2" as="font" type="font\/woff2" crossorigin \/>/,
    );
    expect(body).toMatch(/href="\/fonts\/jetbrains-mono\/JetBrainsMono-Regular\.woff2"/);
    const publicDir = resolve(REPO_ROOT, 'apps/marketing-site/public');
    expect(existsSync(resolve(publicDir, 'fonts/geist/GeistVF.woff2'))).toBe(true);
    expect(existsSync(resolve(publicDir, 'fonts/geist/OFL.txt'))).toBe(true);
    expect(existsSync(resolve(publicDir, 'fonts/jetbrains-mono/JetBrainsMono-Regular.woff2'))).toBe(
      true,
    );
    expect(existsSync(resolve(publicDir, 'fonts/jetbrains-mono/JetBrainsMono-Bold.woff2'))).toBe(
      true,
    );
    expect(existsSync(resolve(publicDir, 'fonts/jetbrains-mono/OFL.txt'))).toBe(true);
  });

  it('renders <Header /> + <slot /> in <main class="flex-1"> + <Footer />, with the skip-link target on <main>', () => {
    expect(body).toMatch(/<Header \/>/);
    expect(body).toMatch(/<main\b[^>]*\bclass="flex-1">\s*<slot \/>\s*<\/main>/);
    expect(body).toMatch(/<main\b[^>]*\bid="main-content"[^>]*\btabindex="-1"/);
    expect(body).toMatch(/<Footer \/>/);
  });

  it('WCAG 2.4.1 skip link: a "Skip to main content" anchor targets #main-content (sr-only until focused)', () => {
    expect(body).toMatch(/href="#main-content"/);
    expect(body).toMatch(/sr-only focus:not-sr-only/);
    expect(body).toMatch(/Skip to main content/);
  });

  it('html lang="en" + charset UTF-8 + viewport meta', () => {
    // Fleet token axes (2026-06-12 rework): dark+oxblood = today's look until
    // the index Fleet port flips the default to light+violet (founder-locked).
    expect(body).toMatch(/<html lang="en" data-mode="dark" data-accent="oxblood">/);
    expect(body).toMatch(/<meta charset="UTF-8" \/>/);
    expect(body).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
  });

  it('og-default.png fallback file exists in public/', () => {
    expect(existsSync(resolve(REPO_ROOT, 'apps/marketing-site/public/og-default.png'))).toBe(true);
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
