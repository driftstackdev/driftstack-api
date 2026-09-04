// Marketing-site text-contrast scanner (2026-07-06; S24: both modes).
//
// WHY THIS EXISTS: the founder reported "some text/boxes might not even be
// visible, as the site is very dark." Two root causes were found and fixed
// (S20): a compressed dark surface ladder, and — the sneaky one — status/
// wash tokens (e.g. text-tk-accent-soft, a 13%-alpha WASH) misused as a
// TEXT color, which rendered at ~1.2:1 (effectively invisible) while every
// source-regex parity test stayed green. The repo's unit suite is
// source-grep based; it CANNOT see rendered contrast. This tool can.
//
// It renders every built page in headless Chromium (default theme = dark;
// MODE=light flips the data-mode axis and waits out the transition-colors
// animation — mid-transition reads give phantom ratios), walks every
// element that has its own text node, composites the real background
// (through alpha layers), and reports WCAG-failing pairs (< 4.5:1 normal /
// < 3:1 large). Run it after any token or component-tone change; the bar
// is ZERO unique failures in BOTH modes.
//
// KNOWN BLIND SPOT (S34): the scan runs at a fixed 1440x900 desktop
// viewport, so md:hidden mobile-only chrome (the hamburger nav popup)
// is never rendered/scanned. If mobile-only text styles diverge from
// desktop, verify manually or add a mobile-viewport pass.
//
// USAGE (from repo root):
//   npm run build --workspace @driftstack/marketing-site
//   (cd apps/marketing-site && npx astro preview --port 4321 &)
//   node scripts/marketing-contrast-scan.mjs
//   MODE=light node scripts/marketing-contrast-scan.mjs
//   # optional: BASE_URL=https://driftstack.io node scripts/marketing-contrast-scan.mjs
// Exit code is 1 if any failure is found, 0 if clean — so it can gate a
// pre-deploy check.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4321';
const PAGES = [
  '/',
  '/pricing',
  '/comparison',
  '/faq',
  '/about',
  '/security',
  '/self-hosted',
  '/roadmap',
  '/changelog',
  '/api-reference',
  '/use-cases',
  '/use-cases/multi-account',
  '/use-cases/qa-testing',
  '/use-cases/web-scraping',
  '/how-it-works',
  '/glossary',
  '/trust',
  '/trust/security-overview',
  '/trust/compliance',
  '/trust/incidents',
  '/trust/sub-processors',
  '/trust/cumulative-rig',
  '/pricing/comparison',
  '/pricing/crypto',
  // S34 — previously unscanned surfaces.
  '/newtab',
  '/404',
  '/500',
];

// Runs in the page. Composites alpha backgrounds up the ancestor chain onto
// the near-black page bg, then computes the WCAG ratio for each text element.
const SCAN = `(() => {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: p.slice(0, 3), a: p[3] ?? 1 }; };
  const blend = (fg, a, bg) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
  const bgOf = (el) => {
    let cur = el, stack = [];
    while (cur && cur !== document.documentElement) {
      const st = getComputedStyle(cur);
      const c = parse(st.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
      // S34 — gradient awareness: a background-image gradient with a
      // solid (a >= 0.5) first color stop is the element's real
      // backdrop; the old walk ignored background-image entirely, so
      // #eee text on linear-gradient(#fff,#fff) scanned as a
      // near-black-bg PASS (execution-proven false negative). Take the
      // first solid stop as an opaque layer; low-alpha wash gradients
      // (the body's ambient radials) stay ignored — the solid base
      // beneath dominates them.
      if (st.backgroundImage && st.backgroundImage.includes('gradient')) {
        const g = parse(st.backgroundImage);
        if (g && g.a >= 0.5) { stack.push({ rgb: g.rgb, a: 1 }); break; }
        const hex = st.backgroundImage.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
        if (hex) {
          let h = hex[1];
          if (h.length === 3) h = h.split('').map((x) => x + x).join('');
          stack.push({ rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 });
          break;
        }
      }
      cur = cur.parentElement;
    }
    // S24 — the base under all alpha layers follows the mode axis
    // (--bg: #060608 dark / #f2f3f6 light).
    let base = document.documentElement.getAttribute('data-mode') === 'light' ? [242, 243, 246] : [6, 6, 8];
    for (let i = stack.length - 1; i >= 0; i--) base = blend(stack[i].rgb, stack[i].a, base);
    return base;
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
    if (!hasText) continue;
    // S24 — decorative-illustration exemption (WCAG 1.4.3 "incidental:
    // …that are part of a picture that contains significant other visual
    // content, have no contrast requirement"). ONLY for illustration-OF-a-UI
    // content — e.g. the hero's miniature iPhone-screen mockups, whose 6–9px
    // "print" depicts a rendered app rather than being site UI. Real links,
    // CTAs, or copy the visitor is meant to READ are NEVER decorative and
    // must not sit inside a [data-contrast-decorative] container; keep the
    // attribute on the innermost illustration wrapper so the scanner's
    // zero-failure bar stays meaningful for everything around it.
    if (el.closest('[data-contrast-decorative]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const fgb = fg.a < 1 ? blend(fg.rgb, fg.a, bg) : fg.rgb;
    const L1 = lum(fgb), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const threshold = large ? 3 : 4.5;
    if (ratio < threshold) {
      out.push({ text: el.textContent.trim().slice(0, 60), cls: (el.className?.toString() || '').slice(0, 90), ratio: Math.round(ratio * 100) / 100, px, threshold });
    }
  }
  return out;
})()`;

async function main() {
  const light = process.env.MODE === 'light';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const agg = new Map();
  for (const path of PAGES) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    // S34 — /pricing's annual price blocks are display:none until the
    // billing-period toggle is clicked, so they were structurally
    // unscanned. Flip to annual before scanning (the union of both
    // states is covered: monthly is the SSR default on every other
    // page load in the loop's other rows... the toggle click below
    // scans annual for this row; monthly text is identical classes).
    if (path === '/pricing') {
      const toggled = await page.evaluate(() => {
        const t = document.querySelector('button[data-period="annual"], [data-period="annual"]');
        if (t instanceof HTMLElement) {
          t.click();
          return true;
        }
        return false;
      });
      if (toggled) await page.waitForTimeout(250);
      else
        process.stdout.write(
          '  (warn: /pricing annual toggle not found — annual prices unscanned)\n',
        );
    }
    if (light) {
      // Flip the mode axis the way the themer does, then wait out
      // transition-colors (150–300ms) — computed colors read mid-animation
      // produce phantom ratios (S22.1 lesson).
      await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'light'));
      await page.waitForTimeout(500);
    }
    for (const f of await page.evaluate(SCAN)) {
      const key = `${f.cls}|${f.ratio}|${f.text.slice(0, 25)}`;
      if (!agg.has(key)) agg.set(key, { ...f, pages: [] });
      agg.get(key).pages.push(path);
    }
  }
  await browser.close();
  const rows = [...agg.values()].sort((a, b) => a.ratio - b.ratio);
  if (rows.length === 0) {
    process.stdout.write(
      `✓ marketing ${light ? 'light' : 'dark'}-mode contrast: 0 failures across ` +
        PAGES.length +
        ' pages\n',
    );
    process.exit(0);
  }
  process.stdout.write('✗ ' + rows.length + ' unique text-contrast failures:\n');
  for (const r of rows) {
    process.stdout.write(
      `  ${r.ratio}:1 (${Math.round(r.px)}px, need ${r.threshold}) [${r.pages.length}pg] ${JSON.stringify(r.text.slice(0, 45))} — ${r.cls}\n`,
    );
  }
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(2);
});
