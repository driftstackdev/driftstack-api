// Drift guard for the branded new-tab page (founder 2026-06-25: "our own blank
// about:me page instead of nothing"). Served at /newtab and opened by the GUI
// simulator's "+" new-tab action (apps/gui-client SimulatorWindow NEW_TAB_URL =
// https://driftstack.io/newtab). Pins the load-fast contract + the on-submit
// navigation so the page stays light + functional:
//   • Driftstack wordmark (DRIFT + STACK) is present.
//   • A search/URL input + a submit affordance navigate on submit.
//   • Self-contained for instant load INSIDE the streamed iPhone: NO BaseLayout
//     import (no Header/Footer/JSON-LD chrome), no webfont/image/external-CSS.
//   • The submit script prefixes https:// when no scheme + sets window.location.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/newtab.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('newtab page baseline', () => {
  const body = read(PAGE);
  // ⛔ Anchored on `resolve`'s OWN closing brace, not on whatever follows it.
  // This used to match up to `form.addEventListener`, so moving that call inside
  // a guard — a change that touched neither `resolve` nor its behaviour — made
  // the extraction fail and this whole file throw at import. A pin that depends
  // on its neighbour breaks when the neighbour moves and reports it as a defect
  // in the thing it was pinning.
  const resolveSource = body.match(/function resolve\(raw\) \{([\s\S]*?)\n        \}\n/)?.[1];
  if (!resolveSource) throw new Error('newtab resolve function not found');
  const resolveTypedEntry = new Function(`return function resolve(raw) {${resolveSource}\n}`)() as (
    raw: unknown,
  ) => string | null;
  const searchFor = (value: string): string =>
    `https://www.google.com/search?q=${encodeURIComponent(value)}`;

  it('renders the Driftstack wordmark (DRIFT + STACK)', () => {
    expect(body).toContain('DRIFT');
    expect(body).toContain('STACK');
  });

  it('has a centered URL/search input that navigates on submit', () => {
    // A text input + a submit affordance.
    expect(body).toMatch(/<input[^>]*type="text"/);
    expect(body).toMatch(/<button[^>]*type="submit"/);
    // The submit handler resolves + navigates.
    expect(body).toMatch(/addEventListener\(['"]submit['"]/);
    expect(body).toContain('window.location.assign');
  });

  it('prefixes https:// when the typed value has no scheme', () => {
    expect(body).toContain("'https://' + v");
    expect(resolveTypedEntry(' example.com/docs ')).toBe('https://example.com/docs');
    expect(resolveTypedEntry('localhost:3000/path')).toBe('https://localhost:3000/path');
  });

  it('directly navigates only HTTP(S) and searches unsupported executable schemes', () => {
    expect(resolveTypedEntry(' HTTPS://example.com/a?b=1 ')).toBe('HTTPS://example.com/a?b=1');
    expect(resolveTypedEntry('http://example.com/')).toBe('http://example.com/');
    expect(resolveTypedEntry('ordinary search')).toBe(searchFor('ordinary search'));
    expect(resolveTypedEntry('')).toBeNull();

    for (const unsafe of [
      'javascript://comment%0Aalert(document.domain)',
      'javascript:alert(document.domain)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://example.com/private',
      'custom-app://open/account',
    ]) {
      expect(resolveTypedEntry(unsafe)).toBe(searchFor(unsafe));
    }
    expect(body).not.toMatch(/\^\[a-z\]\[a-z0-9\+\.\-\]\*:\\\/\\\//i);
  });

  it('stays LIGHT for instant load — self-contained, no BaseLayout / webfont / image assets', () => {
    // Must NOT pull the heavy marketing chrome (Header/Footer/JSON-LD) — load fast.
    expect(body).not.toMatch(/import\s+BaseLayout/);
    expect(body).not.toMatch(/<BaseLayout[\s>]/);
    expect(body).not.toContain('<Header');
    expect(body).not.toContain('<Footer');
    // No external CSS/font/image fetches — inline <style> + inline <svg> only.
    expect(body).not.toMatch(/<link[^>]*rel=['"]stylesheet/);
    expect(body).not.toMatch(/fonts\.googleapis\.com/);
    expect(body).not.toMatch(/<img\b/);
    expect(body).toContain('<style>');
  });

  it('is excluded from search indexing (a chrome page, not a marketing page)', () => {
    expect(body).toMatch(/name="robots"[^>]*content="noindex/);
  });

  it('shows a live connection panel — exit IP, location, time zone, language, protocol, UDP/QUIC (founder 2026-07-02)', () => {
    // The panel rows the customer sees.
    for (const id of ['v-ip', 'v-loc', 'v-tz', 'v-lang', 'v-proto', 'v-quic']) {
      expect(body).toContain(`id="${id}"`);
    }
    // Exit IP + country + negotiated protocol come from the SAME-ORIGIN Cloudflare
    // trace echo (goes through the session proxy → IP is the proxy exit); stays
    // self-contained (no third-party IP API, no new external asset).
    expect(body).toContain('/cdn-cgi/trace');
    expect(body).not.toMatch(/ipify|ipapi|ipinfo|api\.myip/i);
    // Time zone is the (spoofed) browser zone, detected in-page.
    expect(body).toContain('resolvedOptions().timeZone');
    // UDP/QUIC is derived from the negotiated HTTP/3 protocol.
    expect(body).toMatch(/h3|quic/i);
  });

  it('bounds the edge trace and always clears its deadline', () => {
    expect(body).toMatch(/var traceController = new AbortController\(\);/);
    expect(body).toMatch(/traceController\.abort\(\);\s*\}, 5000\);/);
    expect(body).toMatch(
      /fetch\('\/cdn-cgi\/trace', \{ cache: 'no-store', signal: traceController\.signal \}\)/,
    );
    expect(body).toMatch(/if \(!r\.ok\) throw new Error\('HTTP ' \+ r\.status\);/);
    expect(body).toMatch(/\.finally\(function \(\) \{\s*window\.clearTimeout\(traceTimeout\);/);
  });
});
