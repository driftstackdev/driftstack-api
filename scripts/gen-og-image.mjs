#!/usr/bin/env node
// Regenerate apps/marketing-site/public/og-default.png from the editable
// SVG source-of-truth (og-default.svg).
//
// Why a PNG at all: Twitter/X, Facebook, LinkedIn, Slack, and Discord do
// NOT render SVG `og:image` assets, so link previews of driftstack.io
// would show no image if the OG image were an SVG. BaseLayout therefore
// points `og:image` at /og-default.png; this script rasterizes the SVG
// design into that 1200x630 PNG. Edit og-default.svg, then re-run:
//
//   node scripts/gen-og-image.mjs
//
// (The founder may instead drop a richer hand-designed 1200x630 PNG at
// the same path — it is a drop-in replacement. The same applies to any
// per-page variant under public/og/.)
//
// Per-page variants (S16): the VARIANTS table below maps a page slug to
// a headline + two sublines. Each variant reuses og-default.svg as the
// layout template verbatim — ONLY the three copy <text> nodes (headline
// y=330, sublines y=404/454) are swapped — and rasterizes to
// apps/marketing-site/public/og/<slug>.png. Pages opt in via BaseLayout's
// `ogImage="/og/<slug>.png"` prop. New paths are immutable-cache safe
// (public/_headers serves /*.png immutable-1y), so variants need no ?v=
// query — if a variant's art must change, ship it under a new filename.
// The default card render path is untouched: running this script with no
// arguments regenerates og-default.png byte-identically AND all variants.

import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const require = createRequire(resolve(REPO_ROOT, 'package.json'));
const sharp = require('sharp');

const SVG = resolve(REPO_ROOT, 'apps/marketing-site/public/og-default.svg');
const PNG = resolve(REPO_ROOT, 'apps/marketing-site/public/og-default.png');
const OG_DIR = resolve(REPO_ROOT, 'apps/marketing-site/public/og');

// Per-page social cards. Every headline/subline is an existing on-page
// phrase (approved claim register) — do NOT introduce copy here that the
// page itself doesn't make.
const VARIANTS = [
  {
    slug: 'pricing',
    headline: 'Start free. Pay for what runs at once.',
    sublines: [
      'One metric — how many iPhones run at the same time.',
      'No per-call markup. No surprise overage bills.',
    ],
  },
  {
    slug: 'comparison',
    headline: 'Not another anti-detect browser.',
    sublines: [
      'Driftstack runs the real thing — actual WebKit',
      'on Apple-shipped iOS. Nothing to detect.',
    ],
  },
  {
    slug: 'security',
    headline: 'Security, in plain terms.',
    sublines: [
      'Client-encrypted profiles. EU-only by default.',
      'Nobody at Driftstack can watch your sessions.',
    ],
  },
  {
    slug: 'faq',
    headline: 'Frequently asked.',
    sublines: ['Plain answers on pricing, tiers, billing,', 'and how the real-iPhone cloud works.'],
  },
  {
    slug: 'use-cases',
    headline: 'Built for the work you actually do.',
    sublines: [
      'Multi-account operations. QA on real WebKit.',
      'Scraping that sees what iPhones see.',
    ],
  },
  {
    slug: 'how-it-works',
    headline: 'Three steps to a real iPhone.',
    sublines: ['Pick a profile. Start a session.', 'Drive it your way — no code required.'],
  },
  {
    slug: 'glossary',
    headline: 'The words, in plain words.',
    sublines: ['Profiles, sessions, fingerprints, proxies —', 'every term on one honest page.'],
  },
];

// ── Width heuristic (character-count, documented) ────────────────────
// The copy column starts at x=60 with a matching right margin, leaving
// ~1080px. We estimate rendered width as chars × 0.55 × font-size —
// 0.55em is a conservative average glyph advance for this 650-weight
// system sans (the default headline measures ~0.53em/char). The default
// card's 32-char headline at 58px ≈ 1020px, which is the proven ceiling,
// so: headlines LONGER than 32 chars step down 58 → 48px (fits up to
// ~40 chars). Anything the heuristic says would still overflow throws —
// future variant copy can't silently clip.
const TEXT_COLUMN_PX = 1080;
const AVG_CHAR_ADVANCE_EM = 0.55;
const HEADLINE_MAX_CHARS_AT_58 = 32;

function assertFits(slug, text, fontSize) {
  const estimate = text.length * AVG_CHAR_ADVANCE_EM * fontSize;
  if (estimate > TEXT_COLUMN_PX) {
    throw new Error(
      `og/${slug}: "${text}" ≈ ${Math.round(estimate)}px at ${fontSize}px — exceeds the ~${TEXT_COLUMN_PX}px column, would clip`,
    );
  }
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Swap the three copy <text> nodes of the base SVG (identified by their
// stable y anchors: headline 330, sublines 404/454). Everything else —
// grid, rule, mark, wordmark, footer — stays byte-identical template.
function variantSvg(baseSvgText, variant) {
  const headlineSize = variant.headline.length > HEADLINE_MAX_CHARS_AT_58 ? 48 : 58;
  assertFits(variant.slug, variant.headline, headlineSize);
  for (const line of variant.sublines) assertFits(variant.slug, line, 36);

  const swaps = [
    { y: 330, text: variant.headline, fontSize: headlineSize },
    { y: 404, text: variant.sublines[0] },
    { y: 454, text: variant.sublines[1] },
  ];
  let out = baseSvgText;
  for (const swap of swaps) {
    const node = new RegExp(`(<text x="60" y="${swap.y}"[^>]*>)[^<]*(</text>)`);
    if (!node.test(out)) {
      throw new Error(
        `og/${variant.slug}: template text node y="${swap.y}" not found in og-default.svg — did the base card layout change?`,
      );
    }
    out = out.replace(node, (_m, open, close) => {
      const openTag =
        swap.fontSize === undefined
          ? open
          : open.replace('font-size="58"', `font-size="${swap.fontSize}"`);
      return `${openTag}${xmlEscape(swap.text)}${close}`;
    });
  }
  return out;
}

// density:144 renders the SVG at ~2x for crisp anti-aliased text, then we
// lock the output to the canonical 1200x630 OpenGraph card dimensions.
async function rasterize(svgInput, outPath, label) {
  await sharp(svgInput, { density: 144 })
    .resize(1200, 630, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  const meta = await sharp(outPath).metadata();
  if (meta.width !== 1200 || meta.height !== 630) {
    throw new Error(`${label} must be 1200x630, got ${meta.width}x${meta.height}`);
  }
  console.log(`${label} written: ${meta.width}x${meta.height} (${meta.format})`);
}

const svg = readFileSync(SVG);
// Default card first — rendered from the raw SVG buffer through the exact
// pre-variants pipeline, so its PNG stays byte-identical run to run.
await rasterize(svg, PNG, 'og-default.png');

mkdirSync(OG_DIR, { recursive: true });
const svgText = svg.toString('utf8');
for (const variant of VARIANTS) {
  await rasterize(
    Buffer.from(variantSvg(svgText, variant), 'utf8'),
    resolve(OG_DIR, `${variant.slug}.png`),
    `og/${variant.slug}.png`,
  );
}
