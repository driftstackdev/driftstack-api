// W529 — drift guard for the marketing-site Fleet v2 shared component kit
// (2026-07-03): Section, PageHero, Card, IconTile, Stat, HonestyChip,
// FeatureRow, PriceCard, CtaBand, CodeWindow under
// apps/marketing-site/src/components/. One consolidated parity file (the
// kit evolves together) pinning each component's load-bearing contract:
//
//   • Section/PageHero: .section-label + tokened headline shell.
//   • HonestyChip: EXACTLY three states with verbatim labels
//     ('Live' / 'Rolling out' / 'Roadmap') — the honest-claims guardrail;
//     unshipped features must carry their chip.
//   • Stat: the Band-B "big plain line + small mono technical line" tile.
//   • PriceCard: NO dollar literals and NO pricing imports — the caller
//     formats figures from src/data/pricing.ts (W292.B data-binding), so
//     the card can never become a second pricing source of truth.
//   • CtaBand/PriceCard: external (http) hrefs get rel="noopener noreferrer".
//   • CodeWindow: plain-code is:inline copy script with a double-bind
//     guard — NEVER an expression-container template literal (that Astro
//     pattern ships a dead no-op string).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const COMPONENTS = resolve(REPO_ROOT, 'apps/marketing-site/src/components');

function read(name: string): string {
  return readFileSync(resolve(COMPONENTS, name), 'utf8');
}

const KIT = [
  'Section.astro',
  'PageHero.astro',
  'Card.astro',
  'IconTile.astro',
  'Stat.astro',
  'HonestyChip.astro',
  'FeatureRow.astro',
  'PriceCard.astro',
  'CtaBand.astro',
  'CodeWindow.astro',
];

describe('W529 marketing-site Fleet v2 component kit content parity', () => {
  it('all 10 kit components exist at the canonical path', () => {
    for (const name of KIT) {
      expect(existsSync(resolve(COMPONENTS, name)), name).toBe(true);
    }
  });

  it('Section: label/title/lead/id/wide props + .section-label + tokened h2 + border-t hairline shell', () => {
    const body = read('Section.astro');
    expect(body).toMatch(/label: string;/);
    expect(body).toMatch(/title: string;/);
    expect(body).toMatch(/lead\?: string;/);
    expect(body).toMatch(/wide\?: boolean;/);
    expect(body).toMatch(/'relative border-t border-tk-border'/);
    expect(body).toMatch(/class="section-label">\{label\}/);
    expect(body).toMatch(/text-tk-ink sm:text-3xl md:text-4xl/);
    expect(body).toMatch(/wide \? 'max-w-7xl' : 'max-w-6xl'/);
  });

  it('PageHero: h1 hero for interior pages over hero-glow + grid-bg (homepage keeps its bespoke hero)', () => {
    const body = read('PageHero.astro');
    expect(body).toMatch(/class="hero-glow" aria-hidden="true"/);
    expect(body).toMatch(/grid-bg opacity-60/);
    expect(body).toMatch(/<h1/);
    expect(body).toMatch(/class="section-label">\{label\}/);
  });

  it('Card + IconTile: solid .card recipe wrapper with icon slot; IconTile is the AA-safe accent chip and is decorative (aria-hidden)', () => {
    const card = read('Card.astro');
    expect(card).toMatch(/'card p-6'/);
    expect(card).toMatch(/<slot name="icon" \/>/);
    const tile = read('IconTile.astro');
    expect(tile).toMatch(/bg-tk-accent\/10 text-tk-accent-text/);
    expect(tile).toMatch(/aria-hidden="true"/);
  });

  it('Stat: the Band-B copy pattern — plain (required) + technical (optional, small mono in tk-ink-3) inside .stat-card', () => {
    const body = read('Stat.astro');
    expect(body).toMatch(/plain: string;/);
    expect(body).toMatch(/technical\?: string;/);
    expect(body).toMatch(/'stat-card'/);
    expect(body).toMatch(/font-mono text-xs leading-5 text-tk-ink-3/);
  });

  it("HonestyChip: EXACTLY three states with verbatim labels — live→'Live' (tk-ready family), rolling-out→'Rolling out' (tk-busy family), roadmap→'Roadmap' (muted). These are contract strings; rewording requires a deliberate re-pin. S24 2026-07-06: the LABEL text reads the AA-safe status-text tones (raw ready/busy are fill tones, 2.7–3.3:1 as small light-mode text); the /30 borders keep the raw status tint", () => {
    const body = read('HonestyChip.astro');
    expect(body).toMatch(/type ChipState = 'live' \| 'rolling-out' \| 'roadmap';/);
    expect(body).toMatch(/live: 'Live',/);
    expect(body).toMatch(/'rolling-out': 'Rolling out',/);
    expect(body).toMatch(/roadmap: 'Roadmap',/);
    expect(body).toMatch(/live: 'text-tk-ready-text border-tk-ready\/30',/);
    expect(body).toMatch(/'rolling-out': 'text-tk-busy-text border-tk-busy\/30',/);
  });

  it('FeatureRow: copy + media two-column grid with optional HonestyChip and reverse ordering', () => {
    const body = read('FeatureRow.astro');
    expect(body).toMatch(/import HonestyChip from '\.\/HonestyChip\.astro';/);
    expect(body).toMatch(/chip\?: 'live' \| 'rolling-out' \| 'roadmap';/);
    expect(body).toMatch(/<slot name="media" \/>/);
    expect(body).toMatch(/reverse \? 'md:order-2' : ''/);
  });

  it('PriceCard: caller-formatted price string, NO dollar literals, NO pricing.ts import (W292.B — pages own the data-binding); highlight variant + external-href rel', () => {
    const body = read('PriceCard.astro');
    expect(body).toMatch(/price: string;/);
    expect(body).toMatch(/highlight\?: boolean;/);
    // the component itself must never carry a figure or import the data —
    // that would create a second pricing source of truth
    expect(body).not.toMatch(/\$\d/);
    expect(body).not.toMatch(/from '\.\.\/data\/pricing/);
    expect(body).toMatch(/const external = href\.startsWith\('http'\);/);
    expect(body).toMatch(/rel=\{external \? 'noopener noreferrer' : undefined\}/);
    expect(body).toMatch(/highlight \? 'btn-primary w-full' : 'btn-secondary w-full'/);
  });

  it('CtaBand: accent radial wash + primary/secondary CTA pair; external (http) hrefs get rel="noopener noreferrer"', () => {
    const body = read('CtaBand.astro');
    expect(body).toMatch(/bg-glow-radial-accent opacity-50/);
    expect(body).toMatch(
      /const relFor = \(href: string\) => \(href\.startsWith\('http'\) \? 'noopener noreferrer' : undefined\);/,
    );
    expect(body).toMatch(/class="btn-primary" rel=\{relFor\(primaryHref\)\}/);
  });

  it('CodeWindow: chrome + copy button; plain guarded inline script has a single-flight, generation-safe, accessible clipboard lifecycle', () => {
    const body = read('CodeWindow.astro');
    expect(body).toMatch(/class="code-preview overflow-hidden"/);
    expect(body).toMatch(/class="code-window-chrome"/);
    expect(body).toMatch(/data-copy-target=\{copyTargetId\}/);
    expect(body).toMatch(/window\.__dsCopyWired = true;/);
    // Clipboard capability failures and synchronous browser throws are
    // normalized onto the same promise path as async write rejections.
    expect(body).toMatch(
      /if \(!navigator\.clipboard \|\| typeof navigator\.clipboard\.writeText !== 'function'\)/,
    );
    expect(body).toMatch(/return Promise\.resolve\(navigator\.clipboard\.writeText\(value\)\);/);
    expect(body).toMatch(/catch \(error\) \{\s*return Promise\.reject\(error\);\s*\}/);
    // Rapid taps must not overlap writes or let an older reset overwrite a
    // newer result. The active write also exposes visible and AT feedback.
    expect(body).toMatch(/var copyStates = new WeakMap\(\);/);
    expect(body).toMatch(/if \(state\.inFlight\) return;/);
    expect(body).toMatch(/var generation = \+\+state\.generation;/);
    expect(body).toMatch(/btn\.textContent = 'Copying…';/);
    expect(body).toMatch(/btn\.disabled = true;/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'true'\);/);
    expect(body).toMatch(/if \(generation !== state\.generation\) return;/);
    expect(body).toMatch(
      /showCopyResult\(\s*btn,\s*state,\s*generation,\s*'Copy failed',\s*'Could not copy code; select it manually',\s*1800,?\s*\);/,
    );
    expect(body).toMatch(/btn\.disabled = false;/);
    expect(body).toMatch(/btn\.setAttribute\('aria-busy', 'false'\);/);
    // the dead-inline-script trap: an expression container opening right
    // after the script tag ships a literal string instead of running
    expect(body).not.toMatch(/<script is:inline>\s*\{/);
  });

  it('kit hygiene: no inline event handlers (onclick=), no hard-coded hex colors, no driftstack.com/.io TLD drift', () => {
    for (const name of KIT) {
      const body = read(name);
      expect(body, name).not.toMatch(/\son[a-z]+="/);
      expect(body, name).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(body, name).not.toMatch(/driftstack\.(com|io|app|co)\b/);
    }
  });
});
