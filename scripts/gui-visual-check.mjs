// Automated visual self-review (2026-06-15). Renders the visual-harness page in
// headless Chromium and writes PNGs so the rendered GUI can be reviewed directly
// (read the images back) instead of editing blind. Hover states are force-shown
// via injected CSS so the action strip + WebRTC/QUIC detail appear in the static
// shot. Captures both theme modes.
//
// Usage (from repo root): start the gui dev server
//   (cd apps/gui-client && npx vite --port 1420 &)
// then `node scripts/gui-visual-check.mjs`.
// Output: $OUT_DIR (default /tmp/driftstack-visual)/cards-{dark,light}.png
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const URL = process.env.HARNESS_URL ?? 'http://localhost:1420/visual-harness.html';
const OUT = process.env.OUT_DIR ?? '/tmp/driftstack-visual';

const FORCE_HOVER = `
  [class*="group-hover:opacity-100"]{opacity:1 !important}
  [class*="group-hover:flex"]{display:flex !important}
`;

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 1100 },
      deviceScaleFactor: 2,
    });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: FORCE_HOVER });
    await page.waitForTimeout(300);

    await page.screenshot({ path: `${OUT}/cards-dark.png`, fullPage: true });
    process.stdout.write(`wrote ${OUT}/cards-dark.png\n`);

    // Per-card close-ups so fine detail (label legibility, badge colours) is
    // reviewable, not just the wall-of-cards overview.
    const cards = page.locator('article');
    const closeups = [
      [0, 'card-idle'],
      [2, 'card-udpfail'],
    ];
    for (const [idx, name] of closeups) {
      await cards.nth(idx).screenshot({ path: `${OUT}/${name}.png` });
      process.stdout.write(`wrote ${OUT}/${name}.png\n`);
    }

    await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'light'));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/cards-light.png`, fullPage: true });
    process.stdout.write(`wrote ${OUT}/cards-light.png\n`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
