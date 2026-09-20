// A new field on an AI answer reaches every SDK, or none.
//
// The AI routes answer a program with typed refusals and a typed turn result.
// Each extension field on them is a fact a customer program branches on — "was
// my key rejected, or was there no key?", "did the session close, and why?",
// "is this stop worth calling again?" — and each is published in the OpenAPI
// document as a named schema.
//
// Three hand-written SDKs read those fields. A field added to the server and
// picked up by one SDK is invisible from the other two: their own suites pass,
// the docs cite whichever SDK the author had open, and a customer in the other
// two languages has to reach into a raw problem map for something the product
// says is typed.
//
// So every arm here DERIVES its expected list from the published document —
// `packages/sdk-python/openapi.json`, the dump the spec tests already keep in
// step with `openapi.ts` — and then requires all three SDKs to name each one.
// Nothing is retyped into this file except the declared exclusions, each with
// the reason it is not an SDK's business, and each checked for staleness.
//
// The same rule covers the two streams-and-bytes methods the SDKs gained
// alongside those fields: a screenshot fetch and a transcript reader are only
// a product surface if all three have them and all three send the same things.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

/**
 * Python source with its comments and docstrings removed, and ordinary string
 * literals kept — the Python counterpart of `codeOnly`, which handles the
 * `//`-and-`/*` languages.
 *
 * Both halves matter. Stripping is what stops a field's name in a doc comment
 * passing for code that reads it: a first version of the arm below searched
 * whole files, and its negative control did not fire, because renaming the
 * accessor left the name standing in the sentence above it. Keeping ordinary
 * strings is just as load-bearing — every extension IS read as a string key
 * (`self.problem.get("closed_reason")`), so blanking string literals too would
 * make the arm vacuous in the other direction.
 */
function pythonCodeOnly(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const rest = src.slice(i);
    if (quote !== null) {
      if (rest.startsWith('\\')) {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (rest.startsWith(quote)) {
        out += quote;
        i += quote.length;
        quote = null;
        continue;
      }
      out += src[i];
      i += 1;
      continue;
    }
    const triple = rest.startsWith('"""') ? '"""' : rest.startsWith("'''") ? "'''" : null;
    if (triple !== null) {
      const end = src.indexOf(triple, i + 3);
      const stop = end === -1 ? src.length : end + 3;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (src[i] === '#') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (src[i] === "'" || src[i] === '"') {
      quote = src[i] as string;
      out += quote;
      i += 1;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

// An SDK's error surface is more than one file: TypeScript and Python decode a
// problem in their HTTP layer as well as their error classes, and Go splits the
// wire mapping into its own module. Each bundle is everything that language has
// to read a problem with, so "not read by Go" cannot be an artefact of looking
// in one file. Comments are stripped: a field named in a sentence is not a
// field the SDK reads.
const TS_ERRORS = [
  read('packages/sdk-typescript/src/errors.ts'),
  read('packages/sdk-typescript/src/http.ts'),
]
  .map(codeOnly)
  .join('\n');
const PY_ERRORS = [
  read('packages/sdk-python/src/driftstack/errors.py'),
  read('packages/sdk-python/src/driftstack/http.py'),
]
  .map(pythonCodeOnly)
  .join('\n');
// Go's comments are the same two shapes as TypeScript's, and its raw strings
// are backquoted, which the scanner already tracks.
const GO_ERRORS = [read('packages/sdk-go/errors.go'), read('packages/sdk-go/error_mapping.go')]
  .map(codeOnly)
  .join('\n');

// The resource sources, WHOLE: the arm that reads them asks whether a field is
// NAMED for a customer, and in Python — which hands back dicts — the docstring
// is where a customer finds it. That arm is about the documented surface, not
// about executable accessors.
const TS_RESOURCE = read('packages/sdk-typescript/src/resources/agent-sessions.ts');
const PY_RESOURCE = read('packages/sdk-python/src/driftstack/resources/agent_sessions.py');
const GO_RESOURCE = read('packages/sdk-go/agent_sessions.go');

// …and the same three as code, for the arms that ask what an SDK DOES.
const TS_RESOURCE_CODE = codeOnly(TS_RESOURCE);
const PY_RESOURCE_CODE = pythonCodeOnly(PY_RESOURCE);
const GO_RESOURCE_CODE = codeOnly(GO_RESOURCE);

const TS_HTTP = codeOnly(read('packages/sdk-typescript/src/http.ts'));
const PY_HTTP = pythonCodeOnly(read('packages/sdk-python/src/driftstack/http.py'));
const GO_HTTP = codeOnly(read('packages/sdk-go/client.go'));

interface SpecSchema {
  oneOf?: SpecSchema[];
  anyOf?: SpecSchema[];
  $ref?: string;
  properties?: Record<string, { enum?: string[]; const?: string }>;
}
const SPEC = JSON.parse(read('packages/sdk-python/openapi.json')) as {
  paths: Record<string, unknown>;
  components: { schemas: Record<string, SpecSchema> };
};

/** The RFC 7807 members every problem has; an SDK reads them on the base class. */
const RFC7807 = new Set(['type', 'title', 'status', 'detail', 'instance']);

/** What a published problem schema adds on top of RFC 7807. */
function extensionsOf(schemaName: string): string[] {
  const schema = SPEC.components.schemas[schemaName];
  return Object.keys(schema?.properties ?? {})
    .filter((f) => !RFC7807.has(f))
    .sort();
}

/** The properties of the `plan-executed` arm of the published turn result. */
function planExecutedFields(): string[] {
  const schemas = SPEC.components.schemas;
  const top = schemas['AgentMessageResponse'];
  const arm = (top?.oneOf ?? top?.anyOf ?? [])
    .map((v) => (v.$ref !== undefined ? schemas[v.$ref.split('/').pop() ?? ''] : v))
    .find(
      (v) =>
        (v?.properties?.['kind']?.enum?.[0] ?? v?.properties?.['kind']?.const) === 'plan-executed',
    );
  return Object.keys(arm?.properties ?? {}).sort();
}

/**
 * The three sources that have to name a field, by the SDK that owns each.
 * A field is "read" when its wire spelling appears in the source: all three
 * SDKs pull extensions out of the problem map by that literal.
 */
const SDKS = ['TypeScript', 'Python', 'Go'] as const;
function missingFrom(sources: readonly [string, string, string], field: string): string[] {
  return SDKS.filter((_lang, i) => !(sources[i] ?? '').includes(field));
}

describe('a new field on an AI answer reaches every SDK, or none', () => {
  it('CRITICAL the published document was found and carries the AI problem schemas this file reads. A spec read as empty would report no gaps at all', () => {
    for (const name of [
      'AgentAiKeyProblem',
      'AgentMessageConflictProblem',
      'AgentStopUnavailableProblem',
      'AgentOwnKeyRequiredProblem',
      'AgentTurnLimitProblem',
    ]) {
      expect(SPEC.components.schemas[name], `${name} in the published document`).toBeDefined();
      expect(extensionsOf(name).length, `${name} extension fields`).toBeGreaterThan(0);
    }
    expect(planExecutedFields(), 'the published plan-executed result').toContain('answer');
    // And the sources this file compares against are the real ones, with the
    // comment strippers having kept the code rather than eaten it.
    expect(TS_ERRORS.length, 'the TypeScript error module').toBeGreaterThan(1000);
    expect(PY_ERRORS.length, 'the Python error module').toBeGreaterThan(1000);
    expect(GO_ERRORS.length, 'the Go error module').toBeGreaterThan(1000);
    expect(TS_ERRORS, 'TypeScript still reads a problem').toContain('turn_in_progress');
    expect(PY_ERRORS, 'Python still reads a problem').toContain('turn_in_progress');
    expect(GO_ERRORS, 'Go still reads a problem').toContain('turn_in_progress');
    // …and stripped the comments they were asked to: a field named only in
    // prose must not reach the comparison.
    const stripped = pythonCodeOnly('x = 1  # dropped_name\ny = "kept_name"  # dropped_name');
    expect(stripped, 'the Python stripper drops a comment').not.toContain('dropped_name');
    expect(stripped, '…and keeps an ordinary string literal').toContain('"kept_name"');
    expect(stripped.split('\n'), '…without moving any line').toHaveLength(2);
    expect(
      pythonCodeOnly('def f():\n    """answer_unavailable"""\n    return 1'),
      'the Python stripper drops a docstring',
    ).not.toContain('answer_unavailable');
  });

  it('every extension the published AI problems carry is read by all three SDKs, so a program branches on the same facts in any language', () => {
    // Code only: a field is "read" when the SDK reaches for it, not when a
    // sentence mentions it.
    const errors: [string, string, string] = [TS_ERRORS, PY_ERRORS, GO_ERRORS];
    const gaps: string[] = [];
    let checked = 0;
    for (const schema of [
      'AgentAiKeyProblem',
      'AgentMessageConflictProblem',
      'AgentStopUnavailableProblem',
      'AgentOwnKeyRequiredProblem',
      'AgentTurnLimitProblem',
    ]) {
      for (const field of extensionsOf(schema)) {
        checked += 1;
        const missing = missingFrom(errors, field);
        if (missing.length > 0) gaps.push(`${schema}.${field}: not read by ${missing.join(', ')}`);
      }
    }
    // Vacuity: nothing checked would pass on three empty SDKs.
    expect(checked, 'extension fields compared').toBeGreaterThan(10);
    expect(
      gaps.sort(),
      'the server publishes these fields on an AI problem and not every SDK reads them',
    ).toEqual([]);
  });

  it('every field the published plan-executed result carries is named by all three SDKs, or declared here as one an SDK does not surface', () => {
    const resources: [string, string, string] = [TS_RESOURCE, PY_RESOURCE, GO_RESOURCE];
    /** Fields no SDK resource names, with why that is right. */
    const NOT_ON_THE_RESOURCE = new Map<string, string>([
      [
        'usage',
        'named on the SDKs’ own usage type, not on the turn result’s doc surface; each SDK passes it through as the published AgentMessageUsage',
      ],
    ]);
    const gaps: string[] = [];
    const fields = planExecutedFields();
    for (const field of fields) {
      if (NOT_ON_THE_RESOURCE.has(field)) continue;
      const missing = missingFrom(resources, field);
      if (missing.length > 0) gaps.push(`${field}: not named by ${missing.join(', ')}`);
    }
    expect(fields.length, 'fields on the published plan-executed result').toBeGreaterThan(5);
    expect(
      gaps.sort(),
      'the server publishes these on a finished turn and not every SDK names them',
    ).toEqual([]);
    expect(
      [...NOT_ON_THE_RESOURCE.keys()].filter((f) => !fields.includes(f)).sort(),
      'declared exclusions the published result no longer has',
    ).toEqual([]);
  });

  it('every value the published `notice_reason` can carry is named by all three SDKs, and all three say the list is open', () => {
    // A value a program never hears about is a branch it never writes. The set
    // is read from the PUBLISHED document — not from the runtime — so this arm
    // fails when the server starts sending a value the SDKs have not been told
    // about, which is the direction the compatibility rule cares about.
    const schemas = SPEC.components.schemas;
    const top = schemas['AgentMessageResponse'];
    const arm = (top?.oneOf ?? top?.anyOf ?? [])
      .map((v) => (v.$ref !== undefined ? schemas[v.$ref.split('/').pop() ?? ''] : v))
      .find(
        (v) =>
          (v?.properties?.['kind']?.enum?.[0] ?? v?.properties?.['kind']?.const) ===
          'plan-executed',
      );
    const published = arm?.properties?.['notice_reason'] as
      | { anyOf?: Array<{ enum?: string[]; type?: string }> }
      | undefined;
    expect(published, 'notice_reason on the published plan-executed result').toBeDefined();
    const values = published?.anyOf?.flatMap((v) => v.enum ?? []) ?? [];
    // Vacuity: a field read as having no values would report no gaps at all.
    expect(values.length, 'published notice_reason values').toBeGreaterThan(6);
    // Published OPEN: the enum arm names the values, and a bare string arm
    // accepts the ones that do not exist yet.
    expect(
      published?.anyOf?.some((v) => v.type === 'string' && v.enum === undefined),
      'the published notice_reason accepts a value newer than the document',
    ).toBe(true);

    const resources: [string, string, string] = [TS_RESOURCE, PY_RESOURCE, GO_RESOURCE];
    const gaps: string[] = [];
    for (const value of values) {
      const missing = missingFrom(resources, value);
      if (missing.length > 0) gaps.push(`${value}: not named by ${missing.join(', ')}`);
    }
    expect(gaps.sort(), 'notice_reason values the server sends that an SDK never names').toEqual(
      [],
    );
    // And each SDK tells its reader the set is open, so an unknown value is a
    // default branch rather than a crash.
    expect(TS_RESOURCE, 'TypeScript says the set is open').toMatch(/OPEN|open string/i);
    expect(PY_RESOURCE, 'Python says the set is open').toMatch(/OPEN/);
    expect(GO_RESOURCE, 'Go says the set is open').toMatch(/set is OPEN/);
  });

  it('all three SDKs fetch a screenshot from the published capture route, reading the media type rather than assuming one', () => {
    const path = '/v1/agent-sessions/{id}/captures/{captureId}';
    expect(SPEC.paths[path], 'the capture route is published').toBeDefined();

    // Each SDK builds the same path, escaping both ids.
    for (const [lang, src] of [
      ['TypeScript', TS_RESOURCE_CODE],
      ['Python', PY_RESOURCE_CODE],
      ['Go', GO_RESOURCE_CODE],
    ] as const) {
      expect(src, `${lang}: the capture path`).toContain('/captures/');
      expect(src, `${lang}: a capture method`).toMatch(/get_?capture/i);
    }
    // Each reads the media type off the response rather than assuming one: the
    // route serves PNG or JPEG and only the header says which.
    expect(TS_HTTP, 'TypeScript reads the response media type').toMatch(/content-type/i);
    expect(PY_HTTP, 'Python reads the response media type').toMatch(/content-type/i);
    expect(GO_HTTP, 'Go reads the response media type').toMatch(/Content-Type/);
    // And hands it back beside the bytes, so a caller can name the file it
    // writes. The three spellings are one field.
    expect(TS_RESOURCE_CODE, 'TypeScript returns the media type').toMatch(/contentType/);
    expect(PY_RESOURCE_CODE, 'Python returns the media type').toMatch(/content_type/);
    expect(GO_RESOURCE_CODE, 'Go returns the media type').toMatch(/ContentType/);
  });

  it('all three SDKs read the transcript from the published stream, resuming with Last-Event-ID and selecting the same event name', () => {
    const path = '/v1/agent-sessions/{id}/transcript';
    expect(SPEC.paths[path], 'the transcript route is published').toBeDefined();
    // The event name the route writes, derived rather than remembered.
    const route = read('apps/server/src/routes/agent-sessions.ts');
    expect(route, 'the route writes transcript.entry frames').toContain(
      'event: transcript.entry\\n',
    );

    for (const [lang, src] of [
      ['TypeScript', TS_RESOURCE_CODE],
      ['Python', PY_RESOURCE_CODE],
      ['Go', GO_RESOURCE_CODE],
    ] as const) {
      expect(src, `${lang}: the transcript path`).toContain('/transcript');
      expect(src, `${lang}: selects the transcript.entry event`).toContain('transcript.entry');
      expect(src, `${lang}: resumes with Last-Event-ID`).toContain('Last-Event-ID');
      // Resume takes an index, and 0 is an index: none of the three may treat
      // it as "unset". Each guards on an explicit absence instead.
      expect(src, `${lang}: 0 is a resume point, not "unset"`).toMatch(
        /!== undefined|is not None|!= nil/,
      );
    }
  });
});
