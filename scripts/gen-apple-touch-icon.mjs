#!/usr/bin/env node
// Regenerate the marketing site's iOS home-screen icon from the brand mark
// (apps/marketing-site/public/driftstack-mark.svg).
//
// Why a PNG: iOS apple-touch-icons MUST be raster (PNG) — an SVG favicon
// alone means adding driftstack.io to an iPhone home screen shows a
// generic/blank icon. The mark SVG is transparent (the L2 "Drift Layers":
// an ink outline behind an oxblood front layer), so it is composited onto the
// app icon's dark ground (#0b0f14, the same ground as
// scripts/render-gui-icon.mjs) at the standard 180x180 size with ~13%
// padding.
//
// Two names, identical bytes:
//   • LINKED — what BaseLayout's <link rel="apple-touch-icon"> points at.
//     public/_headers serves /*.png immutable for a year, so new art must
//     ship under a NEW name: when a re-render changes the bytes, bump the
//     suffix here, in BaseLayout.astro, and in the pins that name it
//     (grep for the file name), in the same commit.
//   • ROOT — /apple-touch-icon.png, which iOS requests on its own whatever
//     the page links. It is overwritten in place.
//
// Re-run after editing the mark or the ground:
//
//   node scripts/gen-apple-touch-icon.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const require = createRequire(resolve(REPO_ROOT, 'package.json'));
const sharp = require('sharp');

const MARK = resolve(REPO_ROOT, 'apps/marketing-site/public/driftstack-mark.svg');
const LINKED = resolve(REPO_ROOT, 'apps/marketing-site/public/apple-touch-icon-2.png');
const ROOT = resolve(REPO_ROOT, 'apps/marketing-site/public/apple-touch-icon.png');
const BG = '#0b0f14'; // the app icon's ground (render-gui-icon.mjs), kept dark
const SIZE = 180; // iOS Retina standard
const MARK_SIZE = 132; // ~73% — leaves the conventional icon padding

const svg = readFileSync(MARK);
const mark = await sharp(svg, { density: 512 })
  .resize(MARK_SIZE, MARK_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

const icon = await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: BG } })
  .composite([{ input: mark, gravity: 'center' }])
  .png({ compressionLevel: 9 })
  .toBuffer();

const meta = await sharp(icon).metadata();
if (meta.width !== SIZE || meta.height !== SIZE) {
  throw new Error(`apple-touch-icon must be ${SIZE}x${SIZE}, got ${meta.width}x${meta.height}`);
}
for (const out of [LINKED, ROOT]) {
  writeFileSync(out, icon);
  console.log(
    `${out.slice(REPO_ROOT.length + 1)} written: ${meta.width}x${meta.height} (${meta.format})`,
  );
}
