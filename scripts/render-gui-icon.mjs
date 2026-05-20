import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync(
  '/Users/john/code/driftstack-api/apps/marketing-site/public/driftstack-mark.svg',
);

// The SVG has fill-rule:evenodd on a path with both the outer D shape
// and the inner iPhone counter (subtraction). Tauri icon CLI takes a
// solid raster; render at 1024×1024 with the SVG's native transparent
// background. macOS app icons want padding (squircle clipping at the
// system level adds rounded corners); the SVG already includes some
// internal margin via the path's bounding box. Render at 1024 so all
// downstream sizes (16 / 32 / 64 / 128 / 256 / 512) downsample cleanly.

await sharp(svg, { density: 600 })
  .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile('/tmp/icon-source.png');

console.log('icon-source.png written (1024×1024)');
