// W381.C — drift guard for status-site StatusLayout.astro. This
// layout wraps every status-site page (index / history / subscribe
// / 404 / per-incident detail). Drift here affects every status
// surface simultaneously. Pins the load-bearing customer-trust
// claims a status-page reader anchors on:
//
//   • <meta name="robots" content="index, follow"> (status site
//     is public; opposite of admin's noindex).
//   • Header: "Driftstack · status" wordmark + driftstack.dev
//     cross-link.
//   • "Driftstack is a Dutch BV. Status data is operational only —
//     never customer data." footer claim (load-bearing trust
//     signal — operationally-pinned guarantee).
//   • Footer privacy-policy cross-link to driftstack.dev/legal/
//     privacy-policy.
//   • Single max-w-3xl content container (narrow, focused).
//   • global.css import (status-site styles).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/status-site/src/layouts/StatusLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W381.C status-site StatusLayout.astro content parity', () => {
  const body = read(LAYOUT);

  it('imports global.css for tailwind/global styles', () => {
    expect(body).toMatch(/import '\.\.\/styles\/global\.css';/);
  });

  it('Props interface: title (string, required) — no description prop on status-site layout', () => {
    expect(body).toMatch(/interface Props \{\s*\n?\s*title: string;\s*\n?\s*\}/);
  });

  it('index,follow robots meta (status site is public — opposite of admin noindex)', () => {
    expect(body).toMatch(/<meta name="robots" content="index, follow" \/>/);
  });

  it('generator + favicon.svg + charset/viewport meta pinned', () => {
    expect(body).toMatch(/<meta name="generator" content=\{Astro\.generator\} \/>/);
    expect(body).toMatch(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/);
    expect(body).toMatch(/<meta charset="UTF-8" \/>/);
    expect(body).toMatch(
      /<meta name="viewport" content="width=device-width, initial-scale=1\.0" \/>/,
    );
  });

  it('header: "Driftstack" wordmark + middot + "status" subtitle', () => {
    expect(body).toMatch(
      /<span class="text-base font-semibold tracking-tight text-slate-900">Driftstack<\/span>/,
    );
    expect(body).toMatch(/<span class="text-slate-400">·<\/span>/);
    expect(body).toMatch(/<span class="text-slate-500">status<\/span>/);
  });

  it('header right-nav: driftstack.dev external cross-link', () => {
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev" class="text-slate-500 hover:text-slate-900">\s*\n?\s*driftstack\.dev\s*\n?\s*<\/a>/,
    );
  });

  it('footer trust claim: "Driftstack is a Dutch BV. Status data is operational only — never customer data."', () => {
    expect(body).toMatch(
      /<span>Driftstack is a Dutch BV\. Status data is operational only — never customer data\.<\/span>/,
    );
  });

  it('footer privacy-policy cross-link to driftstack.dev/legal/privacy-policy', () => {
    expect(body).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/privacy-policy" class="hover:text-slate-900">\s*\n?\s*Privacy\s*\n?\s*<\/a>/,
    );
  });

  it('single max-w-3xl content container (narrow, focused — not the wide marketing-site max-w-6xl)', () => {
    expect(body).toMatch(/<main class="mx-auto max-w-3xl px-6 py-10">/);
  });

  it('renders <slot /> inside <main>', () => {
    expect(body).toMatch(/<main[^>]*>\s*\n?\s*<slot \/>\s*\n?\s*<\/main>/);
  });

  it('html lang="en" + bg-white header + bg-slate-50/white split', () => {
    expect(body).toMatch(/<html lang="en">/);
    expect(body).toMatch(/<header class="border-b border-slate-200 bg-white">/);
    expect(body).toMatch(/<body class="min-h-screen">/);
  });

  it('title rendered verbatim (no app-suffix unlike admin "${title} · Driftstack admin")', () => {
    expect(body).toMatch(/<title>\{title\}<\/title>/);
  });
});
