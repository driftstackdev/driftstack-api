// W586 — CORS origin allow-list helper. The SSE routes hijack the reply and
// write raw headers (bypassing @fastify/cors's onSend hook), so they reflect
// the origin via this helper. Pins parity with the @fastify/cors `origin`
// config in lib/app.ts (single source — corsOriginMatchers) so the streamed
// 200 carries the SAME Access-Control-Allow-Origin the normal replies do.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { corsOriginMatchers, resolveCorsOrigin, sseCorsHeaders } from '../../src/lib/cors-allow.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = resolve(HERE, '..', '..', 'src', 'lib', 'app.ts');

const DEPS = {
  dashboardOrigin: 'https://app.driftstack.dev',
  corsAllowedOrigins: ['https://admin.driftstack.dev'],
};

describe('W586 corsOriginMatchers', () => {
  it('includes localhost + tauri + dashboard + extra origins in order', () => {
    const m = corsOriginMatchers(DEPS);
    expect(m[0]).toBeInstanceOf(RegExp);
    expect((m[0] as RegExp).test('http://localhost:5173')).toBe(true);
    expect((m[1] as RegExp).test('tauri://localhost')).toBe(true);
    expect((m[2] as RegExp).test('https://tauri.localhost')).toBe(true);
    expect(m).toContain('https://app.driftstack.dev');
    expect(m).toContain('https://admin.driftstack.dev');
  });

  it('always includes the 3 localhost/tauri regexes + the 6 first-party prod origins; omits dashboard/extra when undefined', () => {
    const m = corsOriginMatchers({});
    expect(m.filter((x) => x instanceof RegExp)).toHaveLength(3);
    for (const o of [
      'https://driftstack.dev',
      'https://www.driftstack.dev',
      'https://app.driftstack.dev',
      'https://admin.driftstack.dev',
      'https://status.driftstack.dev',
      'https://docs.driftstack.dev',
    ]) {
      expect(m).toContain(o);
    }
    expect(m).toHaveLength(9); // 3 regex + 6 prod origins, no dashboard/extra
  });

  it('resolves the first-party prod origins (admin/status/docs) even with NO env allow-list — de-risks the PERMISSIVE_CORS=false flip', () => {
    const bare = {}; // no dashboardOrigin, no corsAllowedOrigins
    expect(resolveCorsOrigin('https://admin.driftstack.dev', bare)).toBe(
      'https://admin.driftstack.dev',
    );
    expect(resolveCorsOrigin('https://status.driftstack.dev', bare)).toBe(
      'https://status.driftstack.dev',
    );
    expect(resolveCorsOrigin('https://docs.driftstack.dev', bare)).toBe(
      'https://docs.driftstack.dev',
    );
    // exact-match only — a look-alike subdomain is still blocked
    expect(resolveCorsOrigin('https://admin.driftstack.dev.evil.com', bare)).toBeNull();
    expect(resolveCorsOrigin('https://evil.com', bare)).toBeNull();
  });
});

describe('W586 resolveCorsOrigin', () => {
  it('reflects an allowed origin (never *)', () => {
    expect(resolveCorsOrigin('https://app.driftstack.dev', DEPS)).toBe(
      'https://app.driftstack.dev',
    );
    expect(resolveCorsOrigin('http://localhost:5173', DEPS)).toBe('http://localhost:5173');
    expect(resolveCorsOrigin('tauri://localhost', DEPS)).toBe('tauri://localhost');
  });

  it('returns null for a disallowed origin', () => {
    expect(resolveCorsOrigin('https://evil.com', DEPS)).toBeNull();
    // look-alike must not match the dashboard string
    expect(resolveCorsOrigin('https://app.driftstack.dev.evil.com', DEPS)).toBeNull();
  });

  it('returns null when no origin header (non-CORS request)', () => {
    expect(resolveCorsOrigin(undefined, DEPS)).toBeNull();
    expect(resolveCorsOrigin('', DEPS)).toBeNull();
  });

  it('permissiveCors reflects any present origin', () => {
    expect(resolveCorsOrigin('https://whatever.example', { permissiveCors: true })).toBe(
      'https://whatever.example',
    );
    expect(resolveCorsOrigin(undefined, { permissiveCors: true })).toBeNull();
  });
});

describe('W586 sseCorsHeaders', () => {
  it('allowed origin → ACAO reflected + credentials + Vary', () => {
    const h = sseCorsHeaders('https://app.driftstack.dev', DEPS);
    expect(h['access-control-allow-origin']).toBe('https://app.driftstack.dev');
    expect(h['access-control-allow-credentials']).toBe('true');
    expect(h['vary']).toBe('Origin');
  });

  it('disallowed / absent origin → empty (header omitted, same as the plugin)', () => {
    expect(sseCorsHeaders('https://evil.com', DEPS)).toEqual({});
    expect(sseCorsHeaders(undefined, DEPS)).toEqual({});
  });
});

describe('W586 single-source parity with lib/app.ts', () => {
  it('app.ts cors registration uses corsOriginMatchers (no inlined duplicate list)', () => {
    const body = readFileSync(APP_SRC, 'utf8');
    expect(body).toMatch(
      /origin: deps\.permissiveCors === true \? true : corsOriginMatchers\(deps\)/,
    );
    // The old inlined regexes must be gone from app.ts (single source now).
    expect(body).not.toMatch(
      /origin:\s*\n?\s*deps\.permissiveCors === true\s*\n?\s*\? true\s*\n?\s*: \[/,
    );
  });

  it('both SSE routes feed the CORS config into their hijacked writeHead', () => {
    const notif = readFileSync(
      resolve(HERE, '..', '..', 'src', 'routes', 'account-notifications.ts'),
      'utf8',
    );
    const status = readFileSync(
      resolve(HERE, '..', '..', 'src', 'routes', 'status-stream.ts'),
      'utf8',
    );
    expect(notif).toMatch(/\.\.\.sseCorsHeaders\(req\.headers\.origin, opts\.cors \?\? \{\}\)/);
    expect(status).toMatch(
      /\.\.\.sseCorsHeaders\(request\.headers\.origin, opts\.cors \?\? \{\}\)/,
    );
  });
});
