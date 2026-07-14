// W381.C — drift guard for status-site StatusLayout.astro. This
// layout wraps every status-site page (index / history / subscribe
// / 404 / per-incident detail). Drift here affects every status
// surface simultaneously. Pins the load-bearing customer-trust
// claims a status-page reader anchors on:
//
//   • Public pages index by default; error/token utility pages can opt out.
//   • Header: "Driftstack · status" wordmark + driftstack.dev
//     cross-link.
//   • "Driftstack is a Dutch BV. Status data is operational only —
//     never customer data." footer claim (load-bearing trust
//     signal — operationally-pinned guarantee).
//   • Footer privacy-policy cross-link to driftstack.dev/legal/
//     privacy.
//   • Single max-w-3xl content container (narrow, focused).
//   • global.css import (status-site styles).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/status-site/src/layouts/StatusLayout.astro');
const DIST = resolve(REPO_ROOT, 'apps/status-site/dist');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W381.C status-site StatusLayout.astro content parity', () => {
  const body = read(LAYOUT);

  it('imports global.css for tailwind/global styles', () => {
    expect(body).toMatch(/import '\.\.\/styles\/global\.css';/);
  });

  it('accepts an opt-in noindex prop while keeping public pages indexable by default', () => {
    expect(body).toMatch(/title: string;/);
    expect(body).toMatch(/description\?: string;/);
    expect(body).toMatch(/noindex\?: boolean;/);
    expect(body).toMatch(/description = 'Driftstack service status and incident updates\.',/);
    expect(body).toMatch(/noindex = false,/);
  });

  it('emits noindex only for utility pages that explicitly request it', () => {
    expect(body).toMatch(
      /<meta name="robots" content=\{noindex \? 'noindex,nofollow' : 'index,follow'\} \/>/,
    );
  });

  it('gives every page a description and canonicalizes only indexable public pages', () => {
    expect(body).toMatch(/<meta name="description" content=\{description\} \/>/);
    expect(body).toMatch(
      /const canonicalUrl = Astro\.site \? new URL\(Astro\.url\.pathname, Astro\.site\) : undefined;/,
    );
    expect(body).toMatch(
      /\{!noindex && canonicalUrl && <link rel="canonical" href=\{canonicalUrl\} \/>\}/,
    );

    const publicPages = [
      ['index.html', 'https://status.driftstack.dev/'],
      ['history/index.html', 'https://status.driftstack.dev/history/'],
      ['incident/index.html', 'https://status.driftstack.dev/incident/'],
      ['subscribe/index.html', 'https://status.driftstack.dev/subscribe/'],
    ];
    for (const [relativePath, canonical] of publicPages) {
      const rendered = read(resolve(DIST, relativePath));
      expect(rendered, relativePath).toMatch(/<meta name="description" content="[^"]+">/);
      expect(rendered, relativePath).toContain(`<link rel="canonical" href="${canonical}">`);
    }

    for (const relativePath of [
      '404.html',
      'subscribe/confirm/index.html',
      'subscribe/unsubscribe/index.html',
    ]) {
      const rendered = read(resolve(DIST, relativePath));
      expect(rendered, relativePath).toMatch(/<meta name="description" content="[^"]+">/);
      expect(rendered, relativePath).not.toContain('<link rel="canonical"');
    }
  });

  it('emits complete share-preview metadata only for indexable public pages', () => {
    expect(body).toMatch(/!noindex && canonicalUrl && \(/);
    expect(body).toContain('<meta property="og:type" content="website" />');
    expect(body).toContain('<meta property="og:site_name" content="Driftstack status" />');
    expect(body).toContain('<meta property="og:title" content={title} />');
    expect(body).toContain('<meta property="og:description" content={description} />');
    expect(body).toContain('<meta property="og:url" content={canonicalUrl} />');
    expect(body).toContain('<meta name="twitter:card" content="summary" />');
    expect(body).toContain('<meta name="twitter:title" content={title} />');
    expect(body).toContain('<meta name="twitter:description" content={description} />');

    for (const relativePath of [
      'index.html',
      'history/index.html',
      'incident/index.html',
      'subscribe/index.html',
    ]) {
      const rendered = read(resolve(DIST, relativePath));
      const canonical = rendered.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
      const title = rendered.match(/<title>([^<]+)<\/title>/)?.[1];
      const description = rendered.match(/<meta name="description" content="([^"]+)">/)?.[1];

      expect(canonical, relativePath).toBeTruthy();
      expect(title, relativePath).toBeTruthy();
      expect(description, relativePath).toBeTruthy();
      expect(rendered.match(/<meta property="og:type" content="website">/g)).toHaveLength(1);
      expect(
        rendered.match(/<meta property="og:site_name" content="Driftstack status">/g),
      ).toHaveLength(1);
      expect(rendered).toContain(`<meta property="og:title" content="${title}">`);
      expect(rendered).toContain(`<meta property="og:description" content="${description}">`);
      expect(rendered).toContain(`<meta property="og:url" content="${canonical}">`);
      expect(rendered.match(/<meta name="twitter:card" content="summary">/g)).toHaveLength(1);
      expect(rendered).toContain(`<meta name="twitter:title" content="${title}">`);
      expect(rendered).toContain(`<meta name="twitter:description" content="${description}">`);
    }

    for (const relativePath of [
      '404.html',
      'subscribe/confirm/index.html',
      'subscribe/unsubscribe/index.html',
    ]) {
      const rendered = read(resolve(DIST, relativePath));
      expect(rendered, relativePath).not.toMatch(/(?:property="og:|name="twitter:)/);
    }
  });

  it('renders noindex on error/token utilities while keeping the public overview indexable', () => {
    const publicPage = readFileSync(resolve(DIST, 'index.html'), 'utf8');
    const utilities = [
      resolve(DIST, '404.html'),
      resolve(DIST, 'subscribe/confirm/index.html'),
      resolve(DIST, 'subscribe/unsubscribe/index.html'),
    ];
    expect(publicPage).toContain('<meta name="robots" content="index,follow">');
    for (const page of utilities) {
      expect(readFileSync(page, 'utf8'), page).toContain(
        '<meta name="robots" content="noindex,nofollow">',
      );
    }
  });

  it('generator + favicon.svg + charset/viewport meta pinned', () => {
    expect(body).toMatch(/<meta name="generator" content=\{Astro\.generator\} \/>/);
    // R17 — status-site favicon swapped from the old /favicon.svg (stale
    // placeholder file shipped before the brand SVG existed) to
    // /driftstack-mark.svg so the browser tab icon matches the rest of
    // the product (marketing-site + docs + customer-dashboard).
    expect(body).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/driftstack-mark\.svg(\?v=\d+)?" \/>/,
    );
    expect(body).toMatch(/<meta charset="UTF-8" \/>/);
    expect(body).toMatch(
      /<meta name="viewport" content="width=device-width, initial-scale=1\.0" \/>/,
    );
  });

  it('keeps mobile browser chrome aligned with the dark-only status surface', () => {
    expect(body).toMatch(/<html lang="en" data-mode="dark" data-accent="oxblood">/);
    expect(body).toMatch(/<meta name="theme-color" content="#0f172a" \/>/);
  });

  it('R13 header: "Driftstack" wordmark + middot + "status" subtitle — using dark-theme ink tokens (text-ink-primary / text-ink-muted) after the status-site dark migration', () => {
    expect(body).toMatch(
      /<span class="text-base font-black italic tracking-tight text-ink-primary">DRIFT<span class="text-glow-red">STACK<\/span><\/span>/,
    );
    expect(body).toMatch(/<span class="text-ink-muted">·<\/span>/);
    expect(body).toMatch(/<span class="text-ink-muted">status<\/span>/);
  });

  it('R13 header right-nav: driftstack.dev external cross-link — dark-theme ink-muted -> ink-primary hover after status-site migration', () => {
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev" class="text-ink-muted hover:text-ink-primary">\s*\n?\s*driftstack\.dev\s*\n?\s*<\/a>/,
    );
  });

  it('footer trust claim: "Driftstack is a Dutch BV. Status data is operational only — never customer data."', () => {
    expect(body).toMatch(
      /<span>Driftstack is a Dutch BV\. Status data is operational only — never customer data\.<\/span>/,
    );
  });

  it('R13 footer privacy-policy cross-link to driftstack.dev/legal/privacy — dark-theme hover:text-ink-primary after status-site migration', () => {
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/privacy\/" class="hover:text-ink-primary">\s*\n?\s*Privacy\s*\n?\s*<\/a>/,
    );
  });

  it('single max-w-3xl content container (narrow, focused — not the wide marketing-site max-w-6xl), with the skip-link target', () => {
    expect(body).toMatch(/<main\b[^>]*\bclass="mx-auto max-w-3xl px-6 py-10">/);
    expect(body).toMatch(/<main\b[^>]*\bid="main-content"[^>]*\btabindex="-1"/);
  });

  it('renders <slot /> inside <main>', () => {
    expect(body).toMatch(/<main[^>]*>\s*\n?\s*<slot \/>\s*\n?\s*<\/main>/);
  });

  it('WCAG 2.4.1 skip link: "Skip to main content" anchor → #main-content (sr-only until focused)', () => {
    expect(body).toMatch(/href="#main-content"/);
    expect(body).toMatch(/sr-only focus:not-sr-only/);
    expect(body).toMatch(/Skip to main content/);
  });

  it('R13 html lang="en" + light+violet header (surface-divider border, not the old invisible white/10) + min-h-screen body — the Fleet light theme is applied via the data-mode/data-accent attributes and the page markup uses the adaptive surface/ink tokens', () => {
    expect(body).toMatch(/<html lang="en" data-mode="dark" data-accent="oxblood">/);
    expect(body).toMatch(/<header class="border-b border-surface-divider bg-surface-raised">/);
    expect(body).toMatch(/<body class="min-h-screen">/);
  });

  it('title rendered verbatim (no app-suffix unlike admin "${title} · Driftstack admin")', () => {
    expect(body).toMatch(/<title>\{title\}<\/title>/);
  });
});
