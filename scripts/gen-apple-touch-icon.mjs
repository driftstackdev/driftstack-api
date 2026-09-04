#!/usr/bin/env node
// Regenerate apps/marketing-site/public/apple-touch-icon.png from the
// brand mark (driftstack-mark.svg).
//
// Why a PNG: iOS apple-touch-icons MUST be raster (PNG) — an SVG favicon
// alone means adding driftstack.io to an iPhone home screen shows a
// generic/blank icon. The mark SVG is a transparent gradient "D" (with an
// iPhone silhouette as the counter), so it is composited onto the brand
// dark background (#0b0f14 = the declared <meta name="theme-color">) at
// the standard 180x180 size with ~13% padding. Re-run after editing the
// mark or the brand background:
//
//   node scripts/gen-apple-touch-icon.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const require = createRequire(resolve(REPO_ROOT, 'package.json'));
const sharp = require('sharp');

const MARK = resolve(REPO_ROOT, 'apps/marketing-site/public/driftstack-mark.svg');
const OUT = resolve(REPO_ROOT, 'apps/marketing-site/public/apple-touch-icon.png');
const BG = '#0b0f14'; // brand theme-color (graphite)
const SIZE = 180; // iOS Retina standard
const MARK_SIZE = 132; // ~73% — leaves the conventional icon padding

const svg = readFileSync(MARK);
const mark = await sharp(svg, { density: 512 })
  .resize(MARK_SIZE, MARK_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: BG } })
  .composite([{ input: mark, gravity: 'center' }])
  .png({ compressionLevel: 9 })
  .toFile(OUT);

const meta = await sharp(OUT).metadata();
if (meta.width !== SIZE || meta.height !== SIZE) {
  throw new Error(`apple-touch-icon.png must be ${SIZE}x${SIZE}, got ${meta.width}x${meta.height}`);
}
console.log(`apple-touch-icon.png written: ${meta.width}x${meta.height} (${meta.format})`);
