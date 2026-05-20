import sharp from 'sharp';
import { readFileSync } from 'node:fs';

// 2026-05-20 — composite the brand D-mark on a near-black rounded-square
// background. Earlier rev produced a transparent-bg icon; on macOS the
// Dock dark + Finder light treat transparency differently and the
// floating D looked inconsistent. Black-squircle backing per founder
// feedback ("black background with the D instead of white"). The
// squircle radius matches macOS's icon-mask radius (~22% of edge).

const SVG_PATH = '/Users/john/code/driftstack-api/apps/marketing-site/public/driftstack-mark.svg';
const OUT_PATH = '/tmp/icon-source.png';
const SIZE = 1024;
const PADDING = 96; // logo inset so the D doesn't crowd the squircle edge
const RADIUS = Math.round(SIZE * 0.22); // macOS icon-mask radius
const BG_HEX = '#0b0f14'; // surface-base — matches the in-app TitleBar DBadge

const markSvg = readFileSync(SVG_PATH);

// Render the D-mark to a transparent PNG sized to (SIZE - 2*PADDING).
const markPng = await sharp(markSvg, { density: 600 })
  .resize(SIZE - 2 * PADDING, SIZE - 2 * PADDING, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

// Build a black-squircle background SVG (rounded square).
const bgSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}" fill="${BG_HEX}"/>` +
    `</svg>`,
);

// Composite the D-mark over the black squircle, centred (PADDING on
// every side).
await sharp(bgSvg)
  .composite([{ input: markPng, top: PADDING, left: PADDING }])
  .png()
  .toFile(OUT_PATH);

console.log(`icon-source.png written (${SIZE}×${SIZE}, black-squircle backing + D-mark)`);
