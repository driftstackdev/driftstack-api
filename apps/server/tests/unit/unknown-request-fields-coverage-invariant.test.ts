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
import { LaunchProfileRequestSchema } from '@driftstack/api-types';

const ROUTES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/routes');

/** Files whose body-parsing writes deliberately do not report. */
const EXEMPT_PREFIXES = ['admin-', 'admin.ts'] as const;
const EXEMPT_FILES = ['status-subscribe.ts'] as const;

/**
 * Schemas that are `.strict()`, so zod REJECTS an unknown key with a 400 rather
 * than stripping it. The silent-drop this mechanism exists to surface cannot
 * happen there — the caller is already told, loudly, by the parse itself.
 *
 * The strictness is CHECKED below, not taken on trust. It is the entire reason
 * these routes are allowed to skip the reporter, so a schema that quietly loses
 * `.strict()` would turn this exemption into a permanent hole that still reads
 * like a deliberate decision.
 */
const EXEMPT_SCHEMAS: ReadonlyArray<readonly [string, unknown]> = [
  ['LaunchProfileRequestSchema', LaunchProfileRequestSchema],
];
const EXEMPT_SCHEMA_NAMES = EXEMPT_SCHEMAS.map(([name]) => name);

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

/** The schema whose keys a nearby report treats as known. */
const KNOWN_KEYS_RE =
  /knownKeys:\s*(?:Object\.keys\((\w+Schema)\.shape\)|knownRequestKeys\((\w+Schema)\))/;

interface Site {
  readonly file: string;
  readonly line: number;
  readonly schema: string;
  readonly reports: boolean;
  /** Schema named in the report's knownKeys, when one is present. */
  readonly reportedSchema: string | null;
}

function scan(): Site[] {
  const sites: Site[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
    const lines = readFileSync(join(ROUTES_DIR, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const match = PARSE_RE.exec(line);
      if (!match) return;
      const window = lines.slice(i, i + WINDOW);
      const keysMatch = KNOWN_KEYS_RE.exec(window.join('\n'));
      sites.push({
        file,
        line: i + 1,
        schema: match[1]!,
        reports: window.join('\n').includes('reportUnknownRequestFields('),
        reportedSchema: keysMatch ? (keysMatch[1] ?? keysMatch[2] ?? null) : null,
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
      .filter((s) => !isExempt(s.file) && !s.reports && !EXEMPT_SCHEMA_NAMES.includes(s.schema))
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

  it('CRITICAL every exempt schema is actually strict, which is why it may skip the reporter', () => {
    // The exemption's whole justification. A `.strict()` schema answers an
    // unknown key with a 400, so nothing is silently dropped and there is
    // nothing to report. Lose the modifier and the route starts stripping keys
    // exactly like the ones this mechanism was built for, while the exemption
    // above keeps waving it through.
    const notStrict = EXEMPT_SCHEMAS.filter(([, schema]) => {
      const parsed = (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
        label: 'x',
        __unknown_probe__: 'y',
      });
      return parsed.success;
    }).map(([name]) => name);
    expect(
      notStrict,
      'a schema exempted for being strict now ACCEPTS an unknown key. It is stripping fields ' +
        'silently, which is the failure this mechanism exists to surface, and the exemption is ' +
        'hiding it — drop the exemption and wire the reporter, or restore .strict()',
    ).toEqual([]);
  });

  it('CRITICAL each report describes the schema its own route parses', () => {
    // The coverage arm above only sees that a report exists near the parse. A
    // report block copy-pasted from a neighbouring route passes that and is
    // actively wrong in both directions: keys the caller legitimately sent get
    // reported as ignored, and the typo it was meant to catch does not.
    const mismatched = sites
      .filter((s) => s.reports && s.reportedSchema !== null && s.reportedSchema !== s.schema)
      .map(
        (s) =>
          `${s.file}:${String(s.line)} parses ${s.schema}, reports ${String(s.reportedSchema)}`,
      );
    expect(
      mismatched,
      'a route reports the declared keys of a DIFFERENT schema than the one it parsed',
    ).toEqual([]);

    expect(
      sites.filter((s) => s.reports && s.reportedSchema === null).map((s) => s.file),
      'a report was found with no readable knownKeys expression, so the arm above cannot check it',
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
    const unusedSchemaExemptions = EXEMPT_SCHEMA_NAMES.filter(
      (name) => !sites.some((s) => s.schema === name),
    );
    expect(
      unusedSchemaExemptions,
      'a schema exemption names a schema no route parses any more — drop it, or it hides the ' +
        'next route that reuses the name without being strict',
    ).toEqual([]);
  });
});
