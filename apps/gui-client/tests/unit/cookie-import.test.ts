// Smart cookie IMPORT — auto-detects + normalizes many formats; never throws.

import { describe, expect, it } from 'vitest';
import { parseCookies, type NormalizedCookie } from '../../src/lib/cookie-import';
import { exportCookies, type ExportableCookie } from '../../src/lib/cookie-export';

describe('parseCookies — JSON', () => {
  it('parses a bare array (EditThisCookie / Puppeteer)', () => {
    const text = JSON.stringify([
      {
        name: 'sid',
        value: 'x',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: 1893456000,
      },
    ]);
    const { cookies, format, warnings } = parseCookies(text);
    expect(format).toBe('json');
    expect(warnings).toEqual([]);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toEqual({
      domain: '.example.com',
      name: 'sid',
      value: 'x',
      path: '/',
      expires: 1893456000000, // seconds → ms
      httpOnly: true,
      secure: true,
      sameSite: 'Lax', // 'lax' → 'Lax'
    });
  });

  it('parses a {cookies:[...]} wrapper (Playwright storageState)', () => {
    const text = JSON.stringify({
      cookies: [{ name: 'a', value: '1', domain: 'x.com' }],
      origins: [],
    });
    const { cookies, format } = parseCookies(text);
    expect(format).toBe('json');
    expect(cookies).toHaveLength(1);
    expect(cookies[0].domain).toBe('x.com');
  });

  it('parses a single cookie object', () => {
    const { cookies } = parseCookies(JSON.stringify({ name: 'a', value: '1', domain: 'x.com' }));
    expect(cookies).toHaveLength(1);
  });

  it('accepts key/host/expiry aliases and no_restriction sameSite', () => {
    const text = JSON.stringify([
      { key: 'a', value: '1', host: 'x.com', sameSite: 'no_restriction' },
    ]);
    const { cookies } = parseCookies(text);
    expect(cookies[0].name).toBe('a');
    expect(cookies[0].domain).toBe('x.com');
    expect(cookies[0].sameSite).toBe('None');
  });

  it('treats a >=1e12 expires as already-ms', () => {
    const text = JSON.stringify([
      { name: 'a', value: '1', domain: 'x.com', expires: 1893456000000 },
    ]);
    const { cookies } = parseCookies(text);
    expect(cookies[0].expires).toBe(1893456000000);
  });

  it('skips a JSON cookie missing name or domain with a warning, does not throw', () => {
    const text = JSON.stringify([
      { value: 'novalue', domain: 'x.com' }, // no name
      { name: 'nodomain', value: '1' }, // no domain, no default
      { name: 'ok', value: '1', domain: 'x.com' },
    ]);
    const { cookies, warnings } = parseCookies(text);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('ok');
    expect(warnings.length).toBe(2);
  });

  it('uses defaultDomain for a domainless JSON cookie', () => {
    const text = JSON.stringify([{ name: 'a', value: '1' }]);
    const { cookies, warnings } = parseCookies(text, { defaultDomain: 'fallback.com' });
    expect(cookies).toHaveLength(1);
    expect(cookies[0].domain).toBe('fallback.com');
    expect(warnings).toEqual([]);
  });

  it('warns (no throw) on a leading-bracket blob that is not valid JSON', () => {
    const { cookies, warnings } = parseCookies('[not json at all');
    expect(Array.isArray(cookies)).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('parseCookies — Netscape / cookies.txt', () => {
  const txt = [
    '# Netscape HTTP Cookie File',
    '# a comment',
    '.example.com\tTRUE\t/\tTRUE\t1893456000\tsid\tabc123',
    '#HttpOnly_.example.com\tTRUE\t/account\tFALSE\t0\thid\tsecretvalue',
  ].join('\n');

  it('parses tab-separated lines, ignores comments', () => {
    const { cookies, format, warnings } = parseCookies(txt);
    expect(format).toBe('netscape');
    expect(warnings).toEqual([]);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toEqual({
      domain: '.example.com',
      name: 'sid',
      value: 'abc123',
      path: '/',
      expires: 1893456000000,
      httpOnly: false,
      secure: true,
    });
  });

  it('reads #HttpOnly_ prefix → httpOnly true, strips it from the domain', () => {
    const { cookies } = parseCookies(txt);
    const hid = cookies.find((c) => c.name === 'hid') as NormalizedCookie;
    expect(hid.domain).toBe('.example.com');
    expect(hid.httpOnly).toBe(true);
    expect(hid.path).toBe('/account');
    expect(hid.expires).toBeNull(); // 0 → session → null (schema-valid sentinel)
    expect(hid.value).toBe('secretvalue');
  });

  it('warns (no throw) on a short / malformed line', () => {
    const bad = '.example.com\tTRUE\t/'; // only 3 fields
    const { cookies, warnings } = parseCookies(`# Netscape HTTP Cookie File\n${bad}`);
    expect(cookies).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('preserves a value containing tabs by rejoining the tail', () => {
    const line = 'x.com\tFALSE\t/\tFALSE\t0\tt\ta\tb';
    const { cookies } = parseCookies(`# Netscape HTTP Cookie File\n${line}`);
    expect(cookies[0].value).toBe('a\tb');
  });
});

describe('parseCookies — HTTP Cookie header', () => {
  it('parses "a=1; b=2" with a default domain', () => {
    const { cookies, format, warnings } = parseCookies('a=1; b=2', { defaultDomain: 'x.com' });
    expect(format).toBe('header');
    expect(warnings).toEqual([]);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatchObject({ name: 'a', value: '1', domain: 'x.com', path: '/' });
    expect(cookies[1]).toMatchObject({ name: 'b', value: '2', domain: 'x.com' });
  });

  it('strips a leading "Cookie:" label', () => {
    const { cookies } = parseCookies('Cookie: sid=xyz; ok=1', { defaultDomain: 'x.com' });
    expect(cookies).toHaveLength(2);
    expect(cookies[0].name).toBe('sid');
  });

  it('warns and imports nothing when no default domain is supplied', () => {
    const { cookies, warnings } = parseCookies('a=1; b=2');
    expect(cookies).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('parseCookies — name=value pairs', () => {
  it('parses newline-separated pairs with a default domain', () => {
    const { cookies, format } = parseCookies('a=1\nb=2\n', { defaultDomain: 'x.com' });
    expect(format).toBe('keyvalue');
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatchObject({ name: 'a', value: '1', domain: 'x.com' });
  });

  it('skips blank / commented / nameless lines with warnings', () => {
    const { cookies, warnings } = parseCookies('a=1\n\n# note\n=novalue\n', {
      defaultDomain: 'x.com',
    });
    expect(cookies).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('parseCookies — defensive', () => {
  it('empty input → empty cookies + warning, no throw', () => {
    const r = parseCookies('   ');
    expect(r.cookies).toEqual([]);
    expect(r.format).toBe('empty');
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('garbage that matches no format → unknown + warning, no throw', () => {
    const r = parseCookies('!!!@@@###');
    expect(r.cookies).toEqual([]);
    expect(['unknown', 'keyvalue']).toContain(r.format);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('round-trip export → parse', () => {
  const jar: ExportableCookie[] = [
    {
      domain: '.example.com',
      name: 'sid',
      value: 'abc123',
      path: '/',
      expires: 1893456000000,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    {
      domain: 'app.example.com',
      name: 'theme',
      value: 'dark',
    },
  ];

  it('JSON round-trips 1:1 (security fields preserved)', () => {
    const { text } = exportCookies(jar, 'json');
    const { cookies, warnings } = parseCookies(text);
    expect(warnings).toEqual([]);
    const sid = cookies.find((c) => c.name === 'sid') as NormalizedCookie;
    expect(sid).toEqual({
      domain: '.example.com',
      name: 'sid',
      value: 'abc123',
      path: '/',
      expires: 1893456000000,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
    const theme = cookies.find((c) => c.name === 'theme') as NormalizedCookie;
    expect(theme.domain).toBe('app.example.com');
    expect(theme.expires).toBeNull(); // session → null
  });

  it('Netscape round-trips name/value/domain/path/secure/httpOnly/expiry', () => {
    const { text } = exportCookies(jar, 'netscape');
    const { cookies, warnings } = parseCookies(text);
    expect(warnings).toEqual([]);
    const sid = cookies.find((c) => c.name === 'sid') as NormalizedCookie;
    expect(sid.domain).toBe('.example.com');
    expect(sid.value).toBe('abc123');
    expect(sid.path).toBe('/');
    expect(sid.secure).toBe(true);
    expect(sid.httpOnly).toBe(true);
    expect(sid.expires).toBe(1893456000000);
    // Netscape format does not carry sameSite — absent after round-trip.
    expect(sid.sameSite).toBeUndefined();
  });
});
