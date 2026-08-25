// W586 — CORS origin allow-list helper. The SSE routes hijack the reply and
// write raw headers (bypassing @fastify/cors's onSend hook), so they reflect
// the origin via this helper. Pins parity with the @fastify/cors `origin`
// config in lib/app.ts (single source — corsOriginMatchers) so the streamed
// 200 carries the SAME Access-Control-Allow-Origin the normal replies do.

import { readFileSync, readdirSync } from 'node:fs';
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

  it('CRITICAL every hijacked writeHead feeds CORS into it — DERIVED from the source, not a named list. A hijacked reply bypasses @fastify/cors and hijackedReplyHeaders is an allow-list that excludes ACAO, so a route that forgets sseCorsHeaders returns 200 with no ACAO and the browser rejects it at the FETCH layer: TypeError: Load failed, no status, nothing to inspect.', () => {
    // ⛔ V-1611 — this arm used to be titled "both SSE routes" and read exactly
    // two files by name. There were FOUR hijack sites. The message route was
    // the one it did not name, and it shipped with no ACAO, which made AI
    // browser automation unusable from the GUI: every message failed with a
    // fetch-layer error while session-create (a normal reply) and LiveKit (a
    // WebSocket, no ACAO required) both worked, so every adjacent signal said
    // the network was healthy.
    //
    // A guard whose scan is narrower than its own claim is the recurring shape
    // here — see M-1 in docs/internal/OPEN-ITEMS.md. So the population is now
    // DERIVED by walking the route sources for `reply.raw.writeHead` /
    // `raw.writeHead`, and a fifth hijack route cannot be added uncovered.
    const routesDir = resolve(HERE, '..', '..', 'src', 'routes');
    const files = readdirSync(routesDir).filter((f) => f.endsWith('.ts'));

    const hijackers: string[] = [];
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(resolve(routesDir, file), 'utf8');
      // Count the hijack sites in this file, then require an sseCorsHeaders
      // spread for each one. Two hijacks in one file (agent-sessions.ts has the
      // transcript stream AND the message stream) must BOTH be covered, which
      // is precisely the case a per-file boolean would have missed.
      const writes = [...src.matchAll(/raw\.writeHead\(/g)].length;
      if (writes === 0) continue;
      hijackers.push(`${file}:${String(writes)}`);
      const covered = [...src.matchAll(/\.\.\.sseCorsHeaders\(/g)].length;
      if (covered < writes) {
        missing.push(`${file} — ${String(writes)} hijack(s), ${String(covered)} sseCorsHeaders`);
      }
    }

    // The scan found a real population, so a green means checked rather than
    // "the regex matched nothing".
    expect(
      hijackers.length,
      'no hijacked writeHead was found at all — this arm would pass over an empty set',
    ).toBeGreaterThanOrEqual(3);

    expect(
      missing,
      'these routes hijack the reply without reflecting CORS. A hijacked reply bypasses ' +
        '@fastify/cors, so the browser gets 200 with no Access-Control-Allow-Origin and fails ' +
        'the fetch with no inspectable status:',
    ).toEqual([]);
  });
});
