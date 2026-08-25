// V-1604 — a response builder whose default fills a PUBLISHED field must be
// called with that argument, or the default answers the customer.
//
// `publicEndpoint(row, counts = { delivered: 0, failed: 0, dlq: 0 })` emits
// `delivery_counts`, which `openapi.json` publishes on four operations. Two of
// them — `GET /v1/webhooks/{id}` and `PATCH /v1/webhooks/{id}` — passed no counts
// argument, so the default answered: a customer reading the list saw an
// endpoint's delivery history and the same endpoint opened on its own reported
// nothing delivered, nothing failed and nothing in the DLQ. V-1603 fixed both.
//
// The integration test added there asserts the three responses agree, which is
// the behaviour. This asserts the shape, because the behavioural test needed a
// seeded delivery to have any force at all — its first version compared a fresh
// endpoint's zeros against the default's zeros and passed with the fix reverted.
// A call site added tomorrow without counts is caught here whether or not
// somebody remembers to seed one.
//
// Scope, measured rather than assumed: `publicEndpoint` is the ONLY builder in
// the routes tree with a defaulted parameter feeding a response — a scan for
// `function name(... = {literal})` across every route file returns exactly one.
// So this file is a one-member class, and it says so rather than implying a
// general rule it does not enforce.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBHOOKS = resolve(HERE, '..', '..', 'src', 'routes', 'webhooks.ts');

/**
 * Call sites entitled to the default, with why.
 *
 * `created.row` is a webhook endpoint that was created microseconds ago and
 * cannot have a delivery yet, so zero is the true count rather than a stand-in
 * for one. Rostered rather than pattern-excluded, so a second such claim has to
 * be argued for here.
 */
const DEFAULT_IS_CORRECT: Record<string, string> = {
  'created.row':
    'a just-created endpoint has no deliveries; zero is the measurement, not a placeholder',
};

/** Cut `//` to end of line, leaving string literals alone. */
function codeOf(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      let quote: string | null = null;
      let out = '';
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i] as string;
        if (quote !== null) {
          out += ch;
          if (ch === quote && line[i - 1] !== '\\') quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
          out += ch;
          continue;
        }
        if (ch === '/' && line[i + 1] === '/') break;
        out += ch;
      }
      return out;
    })
    .join('\n');
}

/** Every `publicEndpoint(...)` call, excluding its own declaration. */
function callSites(): Array<{ args: string; line: number }> {
  const code = codeOf(readFileSync(WEBHOOKS, 'utf8'));
  const out: Array<{ args: string; line: number }> = [];
  for (const m of code.matchAll(
    /(?<!function\s)\bpublicEndpoint\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
  )) {
    out.push({ args: (m[1] ?? '').trim(), line: code.slice(0, m.index).split('\n').length });
  }
  return out;
}

describe('a defaulted response field is passed at every call site', () => {
  it('CRITICAL the scan found the call sites. An empty list satisfies the assertion below, and a renamed builder would report perfect compliance having inspected nothing.', () => {
    const sites = callSites();
    expect(sites.length, 'publicEndpoint call sites found').toBeGreaterThanOrEqual(4);
    expect(
      sites.filter((s) => s.args.includes(',')).length,
      'most call sites already pass the counts argument',
    ).toBeGreaterThanOrEqual(3);
  });

  it('CRITICAL every call site passes the counts argument, or is rostered with the reason its default is the true value. The default is not a neutral fallback — it is three zeroes published to a customer as a delivery history.', () => {
    const bare = callSites()
      .filter((s) => !s.args.includes(','))
      .filter((s) => !(s.args in DEFAULT_IS_CORRECT))
      .map((s) => `webhooks.ts:${s.line} publicEndpoint(${s.args})`);
    expect(
      bare,
      'these publish delivery_counts as zeroes without having asked what the counts are',
    ).toEqual([]);
  });

  it('CRITICAL a rostered call site that no longer exists is struck. An exemption outlives its reason silently, and this roster carries exactly one entry — it stops being read the moment it is wrong.', () => {
    const args = new Set(callSites().map((s) => s.args));
    const gone = Object.keys(DEFAULT_IS_CORRECT).filter((k) => !args.has(k));
    expect(gone, 'rostered here but no longer a call site — strike it').toEqual([]);
  });
});
