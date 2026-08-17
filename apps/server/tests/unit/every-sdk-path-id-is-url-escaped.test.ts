// An identifier interpolated into an SDK request path must be URL-escaped.
//
// All three SDKs put customer-supplied ids straight into `/v1/...` paths. If
// one of them skips the escape, an id containing `/`, `?` or `#` stops being an
// id: `prof_x/../../admin` walks the path, `id?foo=1` grafts a query string
// onto someone else's endpoint, and the request lands somewhere the caller
// never named. The customer's own data decides which endpoint is hit.
//
// Measured when this landed: 197 interpolation sites across the three SDKs,
// every one escaped —
//
//   typescript  57 template interpolations, all encodeURIComponent(...)
//   python      86 f-string fields, 84 quote(..., safe='') and 2 `{suffix}`
//   go          56 path concatenations, all url.PathEscape(...)
//
// The two Python `{suffix}` fields are the private `_session_path` /
// `_webhook_path` helpers, whose suffix argument is a string literal at every
// call site ('/navigate', '/capture', …). The third arm below asserts that
// rather than name-excluding `suffix` — an exclusion by name would keep passing
// the day someone threads a variable through it.
//
// ⚠️ The examined-count arm is not ceremony. Building this, my Go extractor
// matched `fmt.Sprintf` and found ZERO sites, because Go concatenates
// (`"/v1/sessions/" + url.PathEscape(id) + "/navigate"`). It reported "no
// unescaped interpolations" — a perfect score from a scanner that had looked at
// nothing. A per-language floor turns that silence into a failure.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function tracked(pathspec: string, suffix: string): { file: string; body: string }[] {
  return execFileSync('git', ['ls-files', pathspec], { cwd: REPO, encoding: 'utf-8' })
    .split('\n')
    .filter((f) => f.endsWith(suffix) && !f.endsWith(`_test${suffix}`))
    .map((file) => ({ file, body: readFileSync(resolve(REPO, file), 'utf-8') }));
}

interface Site {
  language: string;
  file: string;
  expression: string;
  escaped: boolean;
}

function typescriptSites(): Site[] {
  const sites: Site[] = [];
  for (const { file, body } of tracked('packages/sdk-typescript/src', '.ts'))
    for (const [, template] of body.matchAll(/`(\/v1\/[^`]*)`/g))
      for (const [, expression] of template!.matchAll(/\$\{([^}]*)\}/g))
        sites.push({
          language: 'typescript',
          file,
          expression: expression!.trim(),
          escaped: expression!.includes('encodeURIComponent'),
        });
  return sites;
}

function pythonSites(): Site[] {
  const sites: Site[] = [];
  for (const { file, body } of tracked('packages/sdk-python/src', '.py'))
    for (const [, template] of body.matchAll(/f"(\/v1\/(?:[^"\\]|\\.)*)"/g))
      for (const [, expression] of template!.matchAll(/\{([^{}]*(?:\([^()]*\))?[^{}]*)\}/g))
        sites.push({
          language: 'python',
          file,
          expression: expression!.trim(),
          escaped: expression!.includes('quote('),
        });
  return sites;
}

function goSites(): Site[] {
  const sites: Site[] = [];
  for (const { file, body } of tracked('packages/sdk-go', '.go'))
    for (const [, concatenation] of body.matchAll(
      /path:\s*("(?:\/v1\/[^"]*)"(?:\s*\+\s*[^,\n]+)+)/g,
    ))
      for (const part of concatenation!.split('+').map((p) => p.trim()))
        if (!part.startsWith('"'))
          sites.push({
            language: 'go',
            file,
            expression: part,
            escaped: part.includes('PathEscape') || part.includes('QueryEscape'),
          });
  return sites;
}

/** Python helpers whose `suffix` argument must stay a string literal. */
const LITERAL_SUFFIX_HELPERS = ['_session_path', '_webhook_path'];

describe('every SDK path identifier is URL-escaped', () => {
  const sites = [...typescriptSites(), ...pythonSites(), ...goSites()];

  it('CRITICAL each extractor found sites, so a clean result is a real one', () => {
    // Floors, not exact counts: adding a resource should not fail this arm, but
    // an extractor that stops matching must not read as "nothing unescaped".
    for (const [language, floor] of [
      ['typescript', 40],
      ['python', 60],
      ['go', 40],
    ] as const) {
      const found = sites.filter((s) => s.language === language).length;
      expect(
        found,
        `${language}: found ${found} interpolation sites. That extractor has stopped matching the ` +
          'code it was written for — its verdict below would be a perfect score over an empty set',
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it('CRITICAL no identifier reaches a request path unescaped', () => {
    const unescaped = sites
      .filter((s) => !s.escaped)
      // The private helpers' literal suffix is covered by the arm below.
      .filter((s) => s.expression !== 'suffix')
      .map((s) => `${s.language} ${s.file.split('/').pop()!}: \${${s.expression}}`);
    expect(
      unescaped.sort(),
      'a customer-supplied value is interpolated into a /v1 path without escaping — an id ' +
        'containing / or ? changes which endpoint the request reaches',
    ).toEqual([]);
  });

  it('CRITICAL the python helpers are only ever handed a literal suffix', () => {
    const offenders: string[] = [];
    for (const { file, body } of tracked('packages/sdk-python/src', '.py'))
      for (const helper of LITERAL_SUFFIX_HELPERS)
        for (const [, args] of body.matchAll(new RegExp(`${helper}\\(([^)]*)\\)`, 'g'))) {
          const parts = args!.split(',').map((a) => a.trim());
          const suffix = parts[1];
          // No suffix, or a quoted literal, is fine. Anything else is a value
          // flowing into the path unescaped.
          if (suffix !== undefined && !/^["'].*["']$/.test(suffix) && !suffix.includes('str ='))
            offenders.push(`${file.split('/').pop()!}: ${helper}(…, ${suffix})`);
        }
    expect(
      offenders.sort(),
      'a non-literal suffix reaches the path unescaped through a helper that only escapes its id',
    ).toEqual([]);
  });
});
