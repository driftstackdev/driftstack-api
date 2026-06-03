// Marketing-site tracker-free invariant (ePrivacy/GDPR drift-guard).
//
// Pins the privacy property verified in the 2026-06-03 cookie/tracker audit
// (auto-memory project_cookie_tracker_disclosure_clean): the public
// marketing site loads NO third-party analytics/tracker scripts, so it sets
// no non-essential cookies → no EU ePrivacy consent-banner obligation and no
// cookie-disclosure gap. (Auth is Bearer-only; any Cloudflare Web Analytics
// is cookieless.)
//
// Before this guard the property was only verified by hand. Now, if a future
// marketing change adds Google Analytics / GTM / Segment / Mixpanel / Hotjar
// / PostHog / Plausible / Fathom / Meta Pixel / DoubleClick (a cookie-setting
// tracker), CI fails — forcing a deliberate decision: either keep the site
// tracker-free, OR ship a consent banner + privacy-policy disclosure AND
// update this guard's allowlist in the same commit.
//
// The patterns match tracker SCRIPT-LOADS (a tracker domain in a script
// context) and tracker INIT-CALLS — NOT bare prose. So an honest disclaimer
// like "we don't use Google Analytics" does NOT trip it (prose uses the
// product name, not the `google-analytics.com` domain or a `gtag(` call).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCAN_DIRS = [
  resolve(REPO_ROOT, 'apps/marketing-site/src'),
  resolve(REPO_ROOT, 'apps/marketing-site/public'),
];
const SCAN_EXTS = new Set(['.astro', '.html', '.ts', '.tsx', '.js', '.mjs']);

// Known third-party, cookie-setting trackers. Each entry matches a real
// script-load (tracker domain) or an init/track call — patterns that do not
// occur in ordinary prose. Cloudflare Web Analytics (cloudflareinsights) is
// intentionally NOT listed — it is cookieless and needs no consent.
const TRACKER_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'Google Tag Manager', re: /googletagmanager\.com/i },
  { name: 'Google Analytics (domain)', re: /google-analytics\.com/i },
  {
    name: 'Google Analytics (gtag/ga init)',
    re: /\bgtag\s*\(|\b_gaq\b|\bga\s*\(\s*['"]create['"]/i,
  },
  { name: 'Segment', re: /cdn\.segment\.(com|io)|segment\.com\/analytics|analytics\.load\s*\(/i },
  { name: 'Mixpanel', re: /cdn\.mxpnl\.com|\bmixpanel\.(init|track)\b/i },
  { name: 'Hotjar', re: /static\.hotjar\.com|\bhj\s*\(/i },
  { name: 'PostHog', re: /\bposthog\.(init|capture)\b|app\.posthog\.com/i },
  { name: 'Plausible', re: /plausible\.io\/js/i },
  { name: 'Fathom', re: /(cdn\.)?usefathom\.com/i },
  { name: 'Meta/Facebook Pixel', re: /connect\.facebook\.net|\bfbq\s*\(/i },
  { name: 'DoubleClick', re: /stats\.g\.doubleclick\.net|doubleclick\.net\/[a-z]/i },
];

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // dir may not exist in some checkouts; non-vacuity check guards this
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      out = out.concat(walk(p));
    } else if (SCAN_EXTS.has(p.slice(p.lastIndexOf('.')))) {
      out.push(p);
    }
  }
  return out;
}

describe('marketing-site tracker-free invariant (ePrivacy)', () => {
  const files = SCAN_DIRS.flatMap(walk);

  it('scans the marketing-site source (non-vacuity)', () => {
    // Guards against a restructure silently making the scan match ~0 files
    // (a vacuous pass). The 2026-06-03 inventory counted 75.
    expect(files.length).toBeGreaterThan(40);
  });

  it('loads no third-party analytics/tracker scripts (no cookie-setting tracker → no consent-banner obligation)', () => {
    const hits: string[] = [];
    for (const f of files) {
      const body = readFileSync(f, 'utf8');
      for (const { name, re } of TRACKER_PATTERNS) {
        if (re.test(body)) {
          hits.push(`${name} in ${f.slice(REPO_ROOT.length + 1)}`);
        }
      }
    }
    expect(
      hits,
      `Third-party tracker(s) detected in the marketing site:\n  ${hits.join('\n  ')}\n` +
        `The site is intentionally tracker-free (no non-essential cookies → no EU ePrivacy ` +
        `consent banner needed). If a tracker is being added deliberately, ship a consent banner ` +
        `+ privacy-policy disclosure AND update TRACKER_PATTERNS / the cookie disclosure in the same commit.`,
    ).toEqual([]);
  });
});
