// Owner item 6 (2026-09-24, verbatim): "NEW TAB page, the custom pgae we have;
// the HTTP/3 always show still as ; Not detected, this whole might need a upgrade
// as well. Here is some inspiration to improve the page with useful stuff;
// https://detectme.pro/"
//
// ROOT CAUSE, measured with a real browser (Chromium, HTTP/3 on) against the live
// https://driftstack.io/newtab/ on a DIRECT connection — no proxy anywhere:
//   navigation nextHopProtocol  h2
//   /cdn-cgi/trace (the page's)  h2   · http=http/2
//   /cdn-cgi/trace (a 2nd fetch) h3   · http=http/3
//   the page's HTTP/3 row        "✗ Not detected"
// Two defects, both the page's own:
//   1. It looked only at its FIRST loads. A first contact is over TCP; the browser
//      learns from that response (`alt-svc: h3=":443"`) that the site offers
//      HTTP/3 and uses it from the next request on.
//   2. It tested the trace's `http=` value with /h3|quic/ — and Cloudflare spells
//      it `http/3`, which contains no "h3". So even a trace that arrived over
//      HTTP/3 read "Not detected" while the Connection row said "HTTP/3".
//
// This file runs the page's REAL inline script (extracted from newtab.astro) over
// a minimal DOM, with the network answered as the live site answers, and pins:
//   · the HTTP/3 row reads "In use" when ANY of the page's own loads used it —
//     the trace's `http=http/3`, or a later load's nextHopProtocol `h3`;
//   · it asks again after the first load (the browser has then learned h3);
//   · a connection that stays on TCP reads "Not in use", and says the site
//     offered HTTP/3 when the response said so;
//   · the time-zone and language rows say whether they agree with the IP
//     address's location, and WebRTC compares its addresses with the IP address.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, '..', '..', 'src', 'pages', 'newtab.astro');
const SOURCE = readFileSync(PAGE, 'utf8');
const SCRIPT: string = (() => {
  const found = /<script is:inline>([\s\S]*?)<\/script>/.exec(SOURCE)?.[1];
  if (found === undefined) throw new Error('newtab.astro inline script not found');
  return found;
})();

const ORIGIN = 'https://driftstack.io';

interface FakeEl {
  id: string;
  textContent: string;
  className: string;
  children: FakeEl[];
  appendChild(c: FakeEl): void;
  addEventListener(): void;
  set innerHTML(v: string);
  get innerHTML(): string;
}
function fakeEl(id: string): FakeEl {
  let html = '';
  const e: FakeEl = {
    id,
    textContent: '',
    className: '',
    children: [],
    appendChild(c: FakeEl) {
      e.children.push(c);
    },
    addEventListener() {},
    set innerHTML(v: string) {
      html = v;
      e.textContent = v.replace(/<[^>]*>/g, '');
    },
    get innerHTML() {
      return html;
    },
  };
  return e;
}
/** The visible text of an element: its own text, or its children's. */
const text = (e: FakeEl | undefined): string =>
  e === undefined ? '' : e.textContent + e.children.map((c) => c.textContent).join('');

interface World {
  /** What each trace request answers: `http=` value and the Resource Timing
   *  protocol the browser records for it, in request order. */
  traces: Array<{ http: string; hop: string }>;
  nav: string;
  altSvc: string | null;
  echo: Record<string, unknown> | null;
  languages: string[];
  webrtcIps: string[] | null; // null = no RTCPeerConnection
  /** Every trace request fails (a proxy that does not pass it, a timeout). */
  traceFails?: boolean;
}

async function runPage(w: World): Promise<Record<string, FakeEl>> {
  const els: Record<string, FakeEl> = {};
  const document = {
    getElementById(id: string) {
      els[id] ??= fakeEl(id);
      return els[id];
    },
    createElement() {
      return fakeEl('');
    },
  };
  const entries: Record<string, Array<{ nextHopProtocol: string }>> = {};
  let traceN = 0;
  const fetch = (url: string, init?: { method?: string }): Promise<unknown> => {
    const abs = new URL(url, `${ORIGIN}/newtab/`).href;
    if (abs.startsWith(`${ORIGIN}/newtab/`) && init?.method === 'HEAD') {
      // The page itself: the site's `alt-svc` offer rides here (the trace carries none).
      const t = w.traces[Math.min(traceN, w.traces.length - 1)]!;
      (entries[abs] ??= []).push({ nextHopProtocol: t.hop });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === 'alt-svc' ? w.altSvc : null) },
      });
    }
    if (abs.startsWith(`${ORIGIN}/cdn-cgi/trace`) && w.traceFails === true) {
      return Promise.reject(new Error('trace did not answer'));
    }
    if (abs.startsWith(`${ORIGIN}/cdn-cgi/trace`)) {
      const t = w.traces[Math.min(traceN, w.traces.length - 1)]!;
      traceN += 1;
      (entries[abs] ??= []).push({ nextHopProtocol: t.hop });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () =>
          Promise.resolve(
            `fl=1\nh=driftstack.io\nip=203.0.113.7\nhttp=${t.http}\nloc=NL\ntls=TLSv1.3\n`,
          ),
      });
    }
    if (abs.startsWith('https://api.driftstack.dev/v1/egress/echo')) {
      return w.echo === null
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, json: () => Promise.resolve(w.echo) });
    }
    return Promise.reject(new Error(`unexpected fetch ${abs}`));
  };
  const performance = {
    getEntriesByType: (t: string) => (t === 'navigation' ? [{ nextHopProtocol: w.nav }] : []),
    getEntriesByName: (n: string) => entries[n] ?? [],
  };
  class PC {
    onicecandidate: ((e: { candidate: { candidate: string } | null }) => void) | null = null;
    createDataChannel(): void {}
    createOffer(): Promise<unknown> {
      return Promise.resolve({});
    }
    setLocalDescription(): Promise<void> {
      queueMicrotask(() => {
        for (const ip of w.webrtcIps ?? [])
          this.onicecandidate?.({
            candidate: { candidate: `candidate:1 1 udp 1 ${ip} 5000 typ srflx` },
          });
        this.onicecandidate?.({ candidate: null });
      });
      return Promise.resolve();
    }
    close(): void {}
  }
  const window = {
    setTimeout: (f: () => void, ms: number) => setTimeout(f, Math.min(ms, 5)),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
    location: { assign() {}, reload() {}, href: `${ORIGIN}/newtab/`, pathname: '/newtab/' },
    ...(w.webrtcIps !== null ? { RTCPeerConnection: PC } : {}),
  };
  const navigator = { language: w.languages[0], languages: w.languages };
  const run = new Function(
    'window',
    'document',
    'fetch',
    'performance',
    'navigator',
    'location',
    SCRIPT,
  ) as (...a: unknown[]) => void;
  run(window, document, fetch, performance, navigator, window.location);
  // Let every bounded fetch, retry and WebRTC timer settle.
  await new Promise((r) => setTimeout(r, 120));
  return els;
}

const LIVE_SITE: World = {
  // What the live page measured on a direct connection (header of this file).
  traces: [
    { http: 'http/2', hop: 'h2' },
    { http: 'http/3', hop: 'h3' },
    { http: 'http/3', hop: 'h3' },
  ],
  nav: 'h2',
  altSvc: 'h3=":443"; ma=86400',
  echo: { country: 'NL', region: 'Overijssel', city: 'Almelo', timezone: 'Europe/Amsterdam' },
  languages: ['en-NL', 'en'],
  webrtcIps: [],
};

describe('owner item 6 — the new-tab page says HTTP/3 when its own loads used it', () => {
  it('CRITICAL the live site on a clean connection: the first load is h2, the next is h3 → "In use" (it read "Not detected")', async () => {
    const els = await runPage(LIVE_SITE);
    expect(text(els['v-quic'])).toContain('In use');
    expect(text(els['v-quic'])).not.toMatch(/Not detected|Not in use/);
    expect(text(els['v-proto'])).toContain('HTTP/3');
  });

  it('CRITICAL the trace’s own spelling `http=http/3` counts — even when Resource Timing reports nothing', async () => {
    const els = await runPage({
      ...LIVE_SITE,
      nav: '',
      traces: [{ http: 'http/3', hop: '' }],
    });
    expect(text(els['v-quic'])).toContain('In use');
  });

  it('a connection that stays on TCP reads "Not in use", and says the site offered HTTP/3 when it did', async () => {
    const tcp = await runPage({ ...LIVE_SITE, traces: [{ http: 'http/2', hop: 'h2' }] });
    expect(text(tcp['v-quic'])).toContain('Not in use');
    expect(text(tcp['v-quic-note'])).toMatch(/offers HTTP\/3.*stayed on TCP/);
    expect(text(tcp['v-proto'])).toContain('HTTP/2');
    const noOffer = await runPage({
      ...LIVE_SITE,
      altSvc: null,
      traces: [{ http: 'http/2', hop: 'h2' }],
    });
    expect(text(noOffer['v-quic-note'])).not.toMatch(/offers HTTP\/3/);
  });

  it('CRITICAL no protocol reading at all → "Could not be checked" on both rows, never a claim of TCP', async () => {
    // Every trace fails and the timing reports nothing (a failed load's
    // nextHopProtocol is empty): the page has no evidence of TCP or of QUIC.
    const failed = await runPage({ ...LIVE_SITE, nav: '', traceFails: true });
    expect(text(failed['v-quic'])).toContain('Could not be checked');
    expect(text(failed['v-quic'])).not.toContain('Not in use');
    expect(text(failed['v-quic-note'])).not.toMatch(/TCP/);
    expect(text(failed['v-proto'])).toBe('Could not be checked');
    // …and the same when the trace answers but carries no protocol at all.
    const blank = await runPage({ ...LIVE_SITE, nav: '', traces: [{ http: '', hop: '' }] });
    expect(text(blank['v-quic'])).toContain('Could not be checked');
    expect(text(blank['v-proto'])).toBe('Could not be checked');
    // VACUITY: one TCP reading is enough evidence for "Not in use".
    const one = await runPage({ ...LIVE_SITE, nav: 'h2', traceFails: true });
    expect(text(one['v-quic'])).toContain('Not in use');
    expect(text(one['v-proto'])).toBe('HTTP/2');
  });

  it('time zone and language say whether they agree with the IP address’s location', async () => {
    const els = await runPage(LIVE_SITE);
    // The test runner's own zone is the "browser" zone here; the check compares
    // it with the echo's Europe/Amsterdam by name, then by wall-clock time.
    const tzCheck = text(els['v-tz-check']);
    expect(tzCheck).toMatch(
      /Matches your IP address’s location|Same time as|Your IP address is in Europe\/Amsterdam/,
    );
    expect(text(els['v-lang-check'])).toBe('✓ Matches your IP address’s country');
    const elsewhere = await runPage({ ...LIVE_SITE, languages: ['de-DE'] });
    expect(text(elsewhere['v-lang-check'])).toBe('Your IP address is in NL');
    expect(text(els['v-loc'])).toBe('Almelo, Overijssel · 🇳🇱 NL');
  });

  it('WebRTC: another public address is flagged; the IP address itself and private addresses are not', async () => {
    const leak = await runPage({ ...LIVE_SITE, webrtcIps: ['198.51.100.9', '192.168.1.4'] });
    expect(text(leak['v-webrtc'])).toContain('Shows another address');
    expect(text(leak['v-webrtc-note'])).toContain('198.51.100.9');
    expect(text(leak['v-webrtc-note'])).not.toContain('192.168.1.4');
    const same = await runPage({ ...LIVE_SITE, webrtcIps: ['203.0.113.7'] });
    expect(text(same['v-webrtc'])).toContain('Same as your IP address');
    const none = await runPage({ ...LIVE_SITE, webrtcIps: [] });
    expect(text(none['v-webrtc'])).toContain('No address shown');
  });

  it('copy says what a site can see, never how the product works', () => {
    const visible = SOURCE.replace(/^---[\s\S]*?\n---\n/, '').replace(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(visible).not.toMatch(
      /\b(fleet|node|harness|control plane|observer|vantage|interpose|macworker|undetectable)\b/i,
    );
    expect(visible).not.toMatch(/credits/i);
  });
});
