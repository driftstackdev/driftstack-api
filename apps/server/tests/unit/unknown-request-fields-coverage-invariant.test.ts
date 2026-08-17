// Every customer-facing write reports the fields it ignored.
//
// `unknown-request-fields.ts` says this out loud: "a structural test can pin
// that customer-facing writes go through here rather than calling `safeParse`
// directly". Until now nothing did, and the gap was not theoretical — the
// mechanism's own motivating example is a mistyped `archetype`, and
// POST /v1/sessions, where `archetype` is a create field, was not wired to it.
//
// A per-route arm cannot catch this, because an arm has to name a route to test
// it. The failure is a route that was never added to the mechanism, so the check
// has to be derived from the routes that exist.
//
// Two exemptions, both from the module's own stated design:
//
//   admin-*            staff surfaces. A mistyped field there is a mis-typed
//                      admin action, not a customer's resource silently
//                      configured as something they did not ask for.
//   status-subscribe   the public status page. The module refuses to echo a
//                      caller's keys back to an ANONYMOUS caller: that is a
//                      disclosure of schema shape on exactly the surface that
//                      attracts probing, and this route's gate is not
//                      `requireAuth`.
//
// The exemption list is itself checked for rot, so an exempt file that stops
// parsing bodies — or stops existing — fails here rather than quietly widening
// the exemption.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROUTES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/routes');

/** Files whose body-parsing writes deliberately do not report. */
const EXEMPT_PREFIXES = ['admin-', 'admin.ts'] as const;
const EXEMPT_FILES = ['status-subscribe.ts'] as const;

/**
 * Schemas that are `.strict()`, so zod REJECTS an unknown key with a 400 rather
 * than stripping it. The silent-drop this mechanism exists to surface cannot
 * happen there — the caller is already told, loudly, by the parse itself.
 * Verified rather than assumed: `LaunchProfileRequestSchema.safeParse({ label,
 * labell })` fails with "Unrecognized key(s) in object: 'labell'".
 */
const EXEMPT_SCHEMAS = ['LaunchProfileRequestSchema'] as const;

const isExempt = (file: string): boolean =>
  EXEMPT_PREFIXES.some((p) => file.startsWith(p)) || EXEMPT_FILES.includes(file as never);

/**
 * A body-consuming parse, in both shapes this codebase uses:
 * `XSchema.parse(request.body …)` and the two-step
 * `const rawBody = request.body ?? {}` / `XSchema.parse(rawBody)`.
 *
 * The second shape exists because the reporter needs the RAW body — parsed
 * output has defaults filled in — and it is easy to miss: an earlier draft of
 * this file matched only the first, which silently excluded every route on the
 * session surface, the exact routes the mechanism had just been wired into. The
 * population floor below is what surfaced that.
 */
const PARSE_RE = /(\w+Schema)\.(?:safeParse|parse)\(\s*(?:request\.body|raw[A-Za-z]*Body)/;

/**
 * Lines after the parse within which the report must appear. The report sits
 * next to the parse in every wired route; the window only has to be wide enough
 * to clear an intervening `if (!parsed.success)` block.
 */
const WINDOW = 16;

interface Site {
  readonly file: string;
  readonly line: number;
  readonly schema: string;
  readonly reports: boolean;
}

function scan(): Site[] {
  const sites: Site[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
    const lines = readFileSync(join(ROUTES_DIR, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const match = PARSE_RE.exec(line);
      if (!match) return;
      sites.push({
        file,
        line: i + 1,
        schema: match[1]!,
        reports: lines
          .slice(i, i + WINDOW)
          .join('\n')
          .includes('reportUnknownRequestFields('),
      });
    });
  }
  return sites;
}

describe('customer-facing writes report the fields they ignored', () => {
  const sites = scan();

  it('CRITICAL the scan found a real population of body-parsing routes', () => {
    // Without this the regex could drift to match nothing and every assertion
    // below would pass over an empty list — a guard reporting all clear because
    // it read nothing at all.
    expect(sites.length, 'no body-parsing route sites were found at all').toBeGreaterThanOrEqual(
      30,
    );
    expect(
      sites.filter((s) => s.reports).length,
      'no site was detected as reporting, so the detection half is broken',
    ).toBeGreaterThanOrEqual(18);
  });

  it('CRITICAL every non-exempt route that parses a body also reports unknown fields', () => {
    const missing = sites
      .filter((s) => !isExempt(s.file) && !s.reports && !EXEMPT_SCHEMAS.includes(s.schema as never))
      .map((s) => `${s.file}:${String(s.line)} (${s.schema})`);
    expect(
      missing,
      'a customer-facing write parses a body without reporting the keys it ignored. Zod strips ' +
        'unknown keys, so a mistyped field is dropped and the request answered as success — the ' +
        'customer gets a resource configured as something they did not ask for, with nothing ' +
        'saying so. Wire reportUnknownRequestFields next to the parse, or add the route to the ' +
        'exemption list here with the reason it belongs there',
    ).toEqual([]);
  });

  it('CRITICAL each exemption still names a file that exists and still parses a body', () => {
    // Stops the list from silently widening: a renamed or rewritten route would
    // otherwise leave a permanent hole that reads as a deliberate decision.
    const files = new Set(sites.map((s) => s.file));
    const stale = [...EXEMPT_FILES].filter((f) => !files.has(f));
    expect(stale, 'an exempt file no longer parses a request body — drop the exemption').toEqual(
      [],
    );
    expect(
      sites.some((s) => s.file.startsWith('admin-')),
      'no admin route parses a body any more — the admin exemption is stale',
    ).toBe(true);
    const unusedSchemaExemptions = [...EXEMPT_SCHEMAS].filter(
      (name) => !sites.some((s) => s.schema === name),
    );
    expect(
      unusedSchemaExemptions,
      'a schema exemption names a schema no route parses any more — drop it, or it hides the ' +
        'next route that reuses the name without being strict',
    ).toEqual([]);
  });
});
