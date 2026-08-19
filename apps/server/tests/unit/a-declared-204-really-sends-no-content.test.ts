// V-940 — the document declares 20 endpoints as `204 No Content`. Nothing
// checked that any of them actually sends 204.
//
// The whole response-contract surface was measured for this entry and is clean:
// all 1073 error responses declare `application/problem+json`, which is exactly
// what `middleware/error-handler.ts` sets; every non-JSON success response
// declares the right type (`text/plain` for receipt.txt, `application/pdf` for
// receipt.pdf, `text/csv` for the admin export, and dual JSON/CSV for the
// audit-log export); and every contentless success response is a 204 rather than
// a 200 that forgot its body. This file exists to keep the last of those true,
// because a 204 is the one response shape a client cannot discover by reading the
// body — there is no body to read. A route that starts returning 200 with JSON
// while the document promises 204 breaks a generated client silently.
//
// SCOPE, stated because it is weaker than it looks: this resolves the declared
// endpoint to the FILE that registers it and asserts that file sends a 204. It
// does not attribute the 204 to the specific handler. That is deliberate — the
// MFA pair (`DELETE /v1/account/mfa` and `POST /v1/account/mfa/disable`) share one
// `disableHandler` DEFINED ABOVE both registrations, so a scan that reads forward
// from a registration finds nothing. My first pass did exactly that and reported
// those two as defects; both were false positives of the scan, not of the code.
// A file-scoped check cannot tell which handler owns the 204, and pretending
// otherwise is how that false positive gets re-invented.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const SRC = resolve(REPO_ROOT, 'apps/server/src');

interface SpecShape {
  paths: Record<string, Record<string, { responses?: Record<string, { content?: object }> }>>;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Endpoints the document declares as a bodyless 204. */
function declared204(): { method: string; path: string }[] {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
  const out: { method: string; path: string }[] = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const r = op.responses?.['204'];
      if (r !== undefined && Object.keys(r.content ?? {}).length === 0) out.push({ method, path });
    }
  }
  return out;
}

/** The file registering `method path`, matching the route's `:id` spelling. */
function registeringFile(method: string, bracedPath: string): string | undefined {
  const colon = bracedPath.replace(/\{([A-Za-z_]+)\}/g, ':$1');
  const escaped = colon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`app\\.${method}\\b[^(]*\\(\\s*['"\`]${escaped}['"\`]`);
  return sourceFiles(SRC).find((f) => re.test(readFileSync(f, 'utf8')));
}

describe('V-940 a declared 204 really sends no content', () => {
  const endpoints = declared204();

  it('CRITICAL the document still declares a real set of 204 endpoints. The arm below reports an ABSENCE, so an empty set would satisfy it having checked nothing — and this count is pinned rather than floored because a 204 disappearing from the document is itself the change worth noticing.', () => {
    expect(endpoints.length, 'endpoints declared as bodyless 204').toBe(20);
  });

  it('CRITICAL every endpoint the document promises a 204 for is registered in a file that sends one. A 204 is the one response a client cannot verify by reading the body, so a route quietly returning 200 with JSON breaks a generated client with nothing in the payload to explain it.', () => {
    const missing: string[] = [];
    for (const { method, path } of endpoints) {
      const file = registeringFile(method, path);
      if (file === undefined) {
        missing.push(`${method.toUpperCase()} ${path} — no file registers this route`);
        continue;
      }
      const src = readFileSync(file, 'utf8');
      if (!/\.code\(204\)|\.status\(204\)|statusCode = 204/.test(src)) {
        missing.push(
          `${method.toUpperCase()} ${path} — ${file.slice(REPO_ROOT.length + 1)} sends no 204`,
        );
      }
    }
    expect(missing, 'the document promises a 204 these routes never send:').toEqual([]);
  });

  it('CRITICAL error responses are still declared as problem+json, matching the error handler. All 1073 of them were, and the handler sets that content type on every error — so a single endpoint drifting to application/json would put the document out of step with RFC 7807 and with every other operation.', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
    const wrong: string[] = [];
    let counted = 0;
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        for (const [status, r] of Object.entries(op.responses ?? {})) {
          if (!/^[45]/.test(status)) continue;
          const types = Object.keys(r.content ?? {});
          if (types.length === 0) continue;
          counted += 1;
          if (types.join(',') !== 'application/problem+json') {
            wrong.push(`${method.toUpperCase()} ${path} [${status}] -> ${types.join(',')}`);
          }
        }
      }
    }
    expect(counted, 'error responses with a declared body').toBeGreaterThan(1000);
    expect(wrong, 'these error responses do not declare problem+json:').toEqual([]);
    expect(
      readFileSync(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'), 'utf8'),
      'and the handler still sets it',
    ).toMatch(/application\/problem\+json/);
  });
});
