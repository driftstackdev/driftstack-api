#!/usr/bin/env node
// Regenerate apps/marketing-site/public/og-default.png from the editable
// SVG source-of-truth (og-default.svg).
//
// Why a PNG at all: Twitter/X, Facebook, LinkedIn, Slack, and Discord do
// NOT render SVG `og:image` assets, so link previews of driftstack.dev
// would show no image if the OG image were an SVG. BaseLayout therefore
// points `og:image` at /og-default.png; this script rasterizes the SVG
// design into that 1200x630 PNG. Edit og-default.svg, then re-run:
//
//   node scripts/gen-og-image.mjs
//
// (The founder may instead drop a richer hand-designed 1200x630 PNG at
// the same path — it is a drop-in replacement.)

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const require = createRequire(resolve(REPO_ROOT, 'package.json'));
const sharp = require('sharp');

const SVG = resolve(REPO_ROOT, 'apps/marketing-site/public/og-default.svg');
const PNG = resolve(REPO_ROOT, 'apps/marketing-site/public/og-default.png');

const svg = readFileSync(SVG);
// density:144 renders the SVG at ~2x for crisp anti-aliased text, then we
// lock the output to the canonical 1200x630 OpenGraph card dimensions.
await sharp(svg, { density: 144 })
  .resize(1200, 630, { fit: 'fill' })
  .png({ compressionLevel: 9 })
  .toFile(PNG);

const meta = await sharp(PNG).metadata();
if (meta.width !== 1200 || meta.height !== 630) {
  throw new Error(`og-default.png must be 1200x630, got ${meta.width}x${meta.height}`);
}
console.log(`og-default.png written: ${meta.width}x${meta.height} (${meta.format})`);
