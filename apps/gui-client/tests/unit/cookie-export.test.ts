// Cookie EXPORT — serializes a session jar to Netscape/cookies.txt + JSON.

import { describe, expect, it } from 'vitest';
import { exportCookies, type ExportableCookie } from '../../src/lib/cookie-export';

const sample: ExportableCookie[] = [
  {
    domain: '.example.com',
    name: 'sid',
    value: 'abc123',
    path: '/',
    expires: 1893456000000, // 2030-01-01 in ms
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  },
  {
    domain: 'app.example.com',
    name: 'theme',
    value: 'dark',
    // session cookie (no expires), no path, not secure/httpOnly
  },
];

describe('exportCookies — netscape', () => {
  it('emits the Netscape header + TAB-separated lines', () => {
    const { filename, mime, text } = exportCookies(sample, 'netscape');
    expect(filename).toBe('cookies.txt');
    expect(mime).toBe('text/plain');
    expect(text.startsWith('# Netscape HTTP Cookie File')).toBe(true);
    const lines = text.trim().split('\n');
    // Data lines = tab-bearing lines (an httpOnly cookie's line begins with the
    // `#HttpOnly_` data prefix, so a bare startsWith('#') filter would drop it).
    const dataLines = lines.filter((l) => l.includes('\t'));
    expect(dataLines).toHaveLength(2);
  });

  it('marks httpOnly with the #HttpOnly_ domain prefix and TRUE flags', () => {
    const { text } = exportCookies(sample, 'netscape');
    const sidLine = text.split('\n').find((l) => l.includes('sid'));
    expect(sidLine).toBeDefined();
    const fields = (sidLine as string).split('\t');
    // #HttpOnly_.example.com  TRUE  /  TRUE  1893456000  sid  abc123
    expect(fields[0]).toBe('#HttpOnly_.example.com');
    expect(fields[1]).toBe('TRUE'); // leading-dot domain → subdomain match
    expect(fields[2]).toBe('/');
    expect(fields[3]).toBe('TRUE'); // secure
    expect(fields[4]).toBe('1893456000'); // ms → seconds
    expect(fields[5]).toBe('sid');
    expect(fields[6]).toBe('abc123');
  });

  it('defaults a session cookie to expiry 0, path /, FALSE flags', () => {
    const { text } = exportCookies(sample, 'netscape');
    const themeLine = text.split('\n').find((l) => l.includes('theme'));
    const fields = (themeLine as string).split('\t');
    expect(fields[0]).toBe('app.example.com'); // host-only, no prefix
    expect(fields[1]).toBe('FALSE'); // no leading dot
    expect(fields[2]).toBe('/'); // default path
    expect(fields[3]).toBe('FALSE'); // not secure
    expect(fields[4]).toBe('0'); // session → 0
  });

  it('handles an empty jar (header only)', () => {
    const { text } = exportCookies([], 'netscape');
    const dataLines = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(dataLines).toHaveLength(0);
  });
});

describe('exportCookies — json', () => {
  it('emits a normalized JSON array with stable fields', () => {
    const { filename, mime, text } = exportCookies(sample, 'json');
    expect(filename).toBe('cookies.json');
    expect(mime).toBe('application/json');
    const arr = JSON.parse(text) as ExportableCookie[];
    expect(arr).toHaveLength(2);
    expect(arr[0]).toEqual({
      domain: '.example.com',
      name: 'sid',
      value: 'abc123',
      path: '/',
      expires: 1893456000000,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
    // session cookie → null expires, default path, false flags, null sameSite
    expect(arr[1]).toEqual({
      domain: 'app.example.com',
      name: 'theme',
      value: 'dark',
      path: '/',
      expires: null,
      httpOnly: false,
      secure: false,
      sameSite: null,
    });
  });
});
