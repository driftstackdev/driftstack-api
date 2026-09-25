// 2026-09-25 — the iOS home-screen icon is rendered from the CURRENT mark.
// The final theme review found apple-touch-icon.png last rendered when the
// mark was VIOLET (#6d5efc) and never re-rendered after it moved to oxblood:
// adding driftstack.io to an iPhone home screen, or seeing it as a Safari
// Favorites tile, showed a violet logo. Nothing tied the raster to its source.
//
// These arms tie the icon to the mark (its dominant colour is the mark's front
// fill, its outline the mark's back-layer stroke over the generator's ground),
// so the next recolour of the mark fails here until the icon is re-rendered.
// `/*.png` is immutable at the edge for a year (public/_headers), so new art
// ships under a NEW name; the arms pin that too.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PUBLIC = resolve(REPO_ROOT, 'apps/marketing-site/public');
const MARK = resolve(PUBLIC, 'driftstack-mark.svg');
const BASE_LAYOUT = resolve(REPO_ROOT, 'apps/marketing-site/src/layouts/BaseLayout.astro');
const GENERATOR = resolve(REPO_ROOT, 'scripts/gen-apple-touch-icon.mjs');

// The name the page links. /*.png is immutable for a year, so the bytes behind
// a published name never change: a re-render that changes them ships under the
// next name (-3, -4, ...) and this pin moves with it.
const LINKED_ICON = '/apple-touch-icon-2.png';
const LINKED_ICON_SHA256 = 'f41e3d8567d6915047210b29f24fba13c65abd91b69702f24e5696d91b0da31f';
// iOS also requests /apple-touch-icon.png on its own, whatever the page links,
// so the root path carries the same icon (overwritten in place: a client that
// cached the violet one there keeps it until its cache expires, which no name
// change can reach).
const ROOT_ICON = '/apple-touch-icon.png';

type Rgb = readonly [number, number, number];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

// The two layers of the L2 mark.
function layerColours(svg: string): { front: string; back: string } {
  const front =
    /<rect x="86" y="30" width="118" height="194" rx="34" fill="(#[0-9a-f]{6})"\/>/i.exec(svg);
  const back = /fill="none" stroke="(#[0-9a-f]{6})" stroke-width="14" opacity="0\.55"/i.exec(svg);
  expect(front, 'front layer <rect … fill="#…"/> found').not.toBeNull();
  expect(back, 'back layer outline stroke="#…" found').not.toBeNull();
  return { front: front![1]!.toLowerCase(), back: back![1]!.toLowerCase() };
}

// Hue in degrees and HSV saturation/value, for the violet detector.
function hsv([r, g, b]: Rgb): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

// Violet/indigo/purple: hue 225–300°, clearly saturated, not near-black. The
// retired violet #6d5efc sits at ≈246°; the oxblood #a83b4d at ≈350° and the
// graphite ground #0b0f14 at ≈213° with almost no saturation or value.
function isViolet(px: Rgb): boolean {
  const { h, s, v } = hsv(px);
  return s > 0.3 && v > 0.2 && h >= 225 && h <= 300;
}

async function rgbaPixels(buf: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function histogram(data: Buffer): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < data.length; i += 4) {
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function key([r, g, b]: Rgb): string {
  return `${r},${g},${b}`;
}

describe('the iOS home-screen icon is the current mark', () => {
  it(`the page links ${LINKED_ICON}, a raster the site ships at 180×180`, async () => {
    expect(read(BASE_LAYOUT)).toContain(`<link rel="apple-touch-icon" href="${LINKED_ICON}" />`);
    const p = resolve(PUBLIC, LINKED_ICON.slice(1));
    expect(existsSync(p), `${LINKED_ICON} is missing under public/`).toBe(true);
    const meta = await sharp(readFileSync(p)).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({
      format: 'png',
      width: 180,
      height: 180,
    });
  });

  it(`the bytes behind ${LINKED_ICON} are the pinned ones (an immutable name never gets new art)`, () => {
    const bytes = readFileSync(resolve(PUBLIC, LINKED_ICON.slice(1)));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(LINKED_ICON_SHA256);
  });

  it(`iOS's own request for ${ROOT_ICON} gets the same icon as the linked one`, () => {
    const linked = readFileSync(resolve(PUBLIC, LINKED_ICON.slice(1)));
    const root = readFileSync(resolve(PUBLIC, ROOT_ICON.slice(1)));
    expect(root.equals(linked)).toBe(true);
  });

  it('the generator writes both names, from the marketing mark', () => {
    const gen = read(GENERATOR);
    expect(gen).toContain("'apps/marketing-site/public/driftstack-mark.svg'");
    expect(gen).toContain(`'apps/marketing-site/public${LINKED_ICON}'`);
    expect(gen).toContain(`'apps/marketing-site/public${ROOT_ICON}'`);
  });

  it("the icon's largest colour after its ground is the mark's front fill, and the back-layer outline is there too", async () => {
    const { front, back } = layerColours(read(MARK));
    const ground = /const BG = '(#[0-9a-f]{6})'/i.exec(read(GENERATOR));
    expect(ground, "generator's `const BG = '#…'` found").not.toBeNull();
    const bg = hexToRgb(ground![1]!);

    const { data } = await rgbaPixels(readFileSync(resolve(PUBLIC, LINKED_ICON.slice(1))));
    const ranked = [...histogram(data).entries()].sort((a, b) => b[1] - a[1]);
    expect(ranked[0]![0], 'the ground fills the most pixels').toBe(key(bg));
    expect(ranked[1]![0], "the next largest colour is the mark's front fill").toBe(
      key(hexToRgb(front)),
    );

    // The outline is drawn at opacity .55 over the ground.
    const stroke = hexToRgb(back);
    const blended = [0, 1, 2].map((c) => 0.55 * stroke[c]! + 0.45 * bg[c]!);
    let outline = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ([0, 1, 2].every((c) => Math.abs(data[i + c]! - blended[c]!) <= 2)) outline++;
    }
    expect(outline, 'pixels in the blended back-layer outline colour').toBeGreaterThan(200);
  });

  it('no pixel of either icon file is violet (the detector flags #6d5efc and passes #a83b4d)', async () => {
    // Positive and negative control, in the same breath as the measurement.
    expect(isViolet(hexToRgb('#6d5efc'))).toBe(true);
    expect(isViolet(hexToRgb('#a83b4d'))).toBe(false);
    expect(isViolet(hexToRgb('#0b0f14'))).toBe(false);
    const control = await rgbaPixels(
      await sharp({
        create: { width: 2, height: 1, channels: 3, background: '#6d5efc' },
      })
        .png()
        .toBuffer(),
    );
    let controlHits = 0;
    for (let i = 0; i < control.data.length; i += 4) {
      if (isViolet([control.data[i]!, control.data[i + 1]!, control.data[i + 2]!])) controlHits++;
    }
    expect(controlHits, 'the detector sees a violet PNG').toBe(2);

    for (const name of [LINKED_ICON, ROOT_ICON]) {
      const { data, width, height } = await rgbaPixels(
        readFileSync(resolve(PUBLIC, name.slice(1))),
      );
      expect(width * height).toBe(180 * 180);
      let violet = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (isViolet([data[i]!, data[i + 1]!, data[i + 2]!])) violet++;
      }
      expect(violet, `violet pixels in ${name}`).toBe(0);
    }
  });
});
