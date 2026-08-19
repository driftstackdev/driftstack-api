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
// V-947 adds two more files under the SAME staff rationale as `admin-*`, which
// applies to them by gate rather than by filename:
//
//   mac-nodes-register       all four registrations sit behind
//                            `requireAuth + requireScope('driftstack_internal_admin')`.
//   internal-atlas-priority  bearer-token `requireInternalAuth` on four routes,
//                            the staff scope on two, and — when the internal
//                            token is not configured — the same four paths
//                            registered to an unconditional `reject`.
//
// Those two are not taken on trust either. The `admin-` prefix at least carries
// its rationale in the name; these carry it only in their preHandlers, so the
// staff-gate arm below asserts every registration in them is gated (or rejects),
// and an ungated route added to one of these files fails here rather than
// inheriting a file-level exemption it does not qualify for.
//
// The exemption list is itself checked for rot, so an exempt file that stops
// parsing bodies — or stops existing — fails here rather than quietly widening
// the exemption.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LaunchProfileRequestSchema, ResumeSessionRequestSchema } from '@driftstack/api-types';
import { transportReportBodySchema } from '../../src/routes/agent-sessions-transport-report.js';

const ROUTES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/routes');

/** Files whose body-parsing writes deliberately do not report. */
const EXEMPT_PREFIXES = ['admin-', 'admin.ts'] as const;
const EXEMPT_FILES = [
  'status-subscribe.ts',
  // V-947 — staff surfaces by gate rather than by filename. Checked below.
  'mac-nodes-register.ts',
  'internal-atlas-priority.ts',
] as const;

/**
 * The two files exempted for being staff-only, and the gate markers that make
 * them so. Kept separate from `EXEMPT_FILES` because `status-subscribe.ts` is
 * exempt for the opposite reason — it is ANONYMOUS — and asserting a staff gate
 * on it would be wrong.
 */
const STAFF_EXEMPT_FILES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['mac-nodes-register.ts', ["requireScope('driftstack_internal_admin')"]],
  [
    'internal-atlas-priority.ts',
    ["requireScope('driftstack_internal_admin')", 'requireInternalAuth'],
  ],
];

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
  // V-976 — wired in V-947 by mistake. `.strict()` means an unknown key is a 400
  // from the parse, so the reporter placed after it could never have anything to
  // report. It belongs here, where the strictness that makes it safe is CHECKED.
  ['ResumeSessionRequestSchema', ResumeSessionRequestSchema],
  // V-977 — the second of the two. V-976 said "exactly one is strict" on the
  // strength of a six-line grep window; this schema's `.strict()` sits on line
  // eleven of its declaration, so the window missed it and the claim was wrong.
  ['transportReportBodySchema', transportReportBodySchema],
];
const EXEMPT_SCHEMA_NAMES = EXEMPT_SCHEMAS.map(([name]) => name);

/**
 * V-945 — sites the widened PARSE_RE made visible, recorded as a FALLING ceiling
 * rather than triaged in one pass.
 *
 * These were never checked: the pattern above matched `request.body` only, so
 * roughly half the route surface — the half that names the Fastify argument `req`
 * — was invisible. None of these schemas is `.strict()`, so a mistyped field is
 * stripped and the request answered as success, which is exactly the silent drop
 * this file exists to surface.
 *
 * They are NOT wired here on purpose. Each needs a per-route decision this sweep
 * cannot make mechanically: several are ANONYMOUS surfaces, where the module's own
 * `status-subscribe` exemption reasons that echoing a caller's keys back discloses
 * schema shape on exactly the surface that attracts probing. Deciding which of
 * these are that case, and which simply want the reporter, is route-by-route work
 * — an automated attempt at that classification misread an authed session route as
 * anonymous, so the classification is not offered here as if it were reliable.
 *
 * Keyed by file and schema rather than by line, so an edit above a site does not
 * invalidate the entry. The COUNT is pinned below and may only fall: wiring a
 * route means deleting its key in the same commit.
 */
const KNOWN_UNREPORTED: ReadonlySet<string> = new Set([
  'auth-cli.ts (CliAuthorizeExchangeRequestSchema)',
  'auth-cli.ts (CliAuthorizeInitiateRequestSchema)',
  'auth-oauth-client.ts (ConfirmMergeBodySchema)',
  'auth-oauth-client.ts (StartBodySchema)',
  'auth.ts (LoginRequestSchema)',
  'auth.ts (LogoutRequestSchema)',
  'auth.ts (MagicLinkConsumeRequestSchema)',
  'auth.ts (MagicLinkRequestSchema)',
  'auth.ts (MfaChallengeRequestSchema)',
  'auth.ts (PasswordResetConfirmRequestSchema)',
  'auth.ts (PasswordResetRequestSchema)',
  'auth.ts (RefreshSessionRequestSchema)',
  'auth.ts (ResendVerificationRequestSchema)',
  'auth.ts (SignupRequestSchema)',
  'auth.ts (VerifyEmailRequestSchema)',
  'session-proxy.ts (SessionEgressConfigSchema)',
]);

/**
 * V-949 — schemas parsed at SEVERAL points for one logical request, where the
 * report is made once at the route entry.
 *
 * `RunTurnRequestSchema` is parsed three times on `POST /:id/message` — in
 * `prepareAgentMessage`, `handleAgentMessage`, and `executeAgentMessage` — and the
 * route reports at entry, with a comment saying why: "reporting at each of those
 * would tag the same request up to three times and needs a reply threaded through
 * internals for nothing". The line-based scan below sees three parses with no
 * report inside their windows, so it had all three sitting in KNOWN_UNREPORTED as
 * an unfixed defect. **The route was already correct**, and following the backlog
 * would have added a fourth report to a route that reports.
 *
 * This is a different claim from the backlog's, so it lives in a different list:
 * KNOWN_UNREPORTED means "this request is NOT reported", and that was false here.
 *
 * The exemption is derived, not asserted. An entry is only honoured while the file
 * really does report that schema somewhere, and only while the schema really is
 * parsed more than once — so a single-parse route cannot hide here, and if the
 * route's own report is deleted the sites fall straight back into the main arm.
 */
const REPORTED_AT_ROUTE_ENTRY: ReadonlySet<string> = new Set([
  'agent-sessions.ts (RunTurnRequestSchema)',
]);

/** Site key as it appears in KNOWN_UNREPORTED — file and schema, no line. */
const backlogKey = (site: Site): string => `${site.file} (${site.schema})`;

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
// V-945 — `req.body` as well as `request.body`. The comment above records an
// earlier draft of this pattern silently excluding the whole session surface,
// and the population floor was added to catch that. It could not catch this
// variant: the routes name the Fastify argument `req` in roughly half the
// codebase, so the scan saw 40 of 84 body-parse sites and 40 clears a floor of
// 30. A floor detects a regex matching NOTHING; it cannot detect one matching
// half the population.
const PARSE_RE =
  /(\w+Schema)\.(?:safeParse|parse)\(\s*(?:req\.body|request\.body|raw[A-Za-z]*Body)/;

/** The same pattern, global, for the whole-file scan below. */
const PARSE_RE_GLOBAL = new RegExp(PARSE_RE.source, 'g');

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

/**
 * V-969 — matched over the WHOLE FILE rather than line by line.
 *
 * `PARSE_RE` spans from the schema name to `req.body`, and prettier splits exactly
 * that when the schema name is long:
 *
 *     const parsed = SomeRatherLongRequestSchema.safeParse(
 *       req.body ?? {},
 *     );
 *
 * A per-line loop never sees the newline, so the site becomes invisible and the
 * guard reports one fewer thing to check — silently, and in the direction that
 * reads as clean. No site is formatted that way today (84 seen either way), so this
 * is a latent hole rather than a live one; it is closed because the readiness
 * assessment records this same failure emptying a line-oriented scan twice already,
 * and because the file's own header describes an earlier pattern that silently
 * excluded half the route surface.
 */
function scan(): Site[] {
  const sites: Site[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const lines = src.split('\n');
    for (const match of src.matchAll(PARSE_RE_GLOBAL)) {
      const index = match.index ?? 0;
      const line = src.slice(0, index).split('\n').length;
      const window = lines.slice(line - 1, line - 1 + WINDOW).join('\n');
      const keysMatch = KNOWN_KEYS_RE.exec(window);
      sites.push({
        file,
        line,
        schema: match[1]!,
        reports: window.includes('reportUnknownRequestFields('),
        reportedSchema: keysMatch ? (keysMatch[1] ?? keysMatch[2] ?? null) : null,
      });
    }
  }
  return sites;
}

describe('customer-facing writes report the fields they ignored', () => {
  const sites = scan();

  it('CRITICAL the parse pattern still matches when prettier splits the call across lines. Asserted against a fixture because no route is formatted that way today — which is exactly why it needs a fixture: a per-line scan reports the same clean number whether the sites are all visible or one has silently left the population. The readiness assessment records this failure emptying a line-oriented scan twice.', () => {
    const singleLine = 'const parsed = ShortSchema.safeParse(req.body ?? {});';
    const wrapped = [
      'const parsed = SomeRatherLongRequestSchema.safeParse(',
      '  req.body ?? {},',
      ');',
    ].join('\n');

    expect([...singleLine.matchAll(PARSE_RE_GLOBAL)].length, 'the single-line form').toBe(1);
    expect([...wrapped.matchAll(PARSE_RE_GLOBAL)].length, 'the wrapped form').toBe(1);
    // And the shape a per-line loop would have handled identically, so the arm is
    // about the WRAPPED case rather than about the pattern in general.
    expect(
      wrapped.split('\n').filter((l) => new RegExp(PARSE_RE.source).test(l)).length,
      'a per-line scan sees the wrapped call not at all — this is the hole being closed',
    ).toBe(0);
  });

  it('CRITICAL the scan found a real population of body-parsing routes', () => {
    // Without this the regex could drift to match nothing and every assertion
    // below would pass over an empty list — a guard reporting all clear because
    // it read nothing at all.
    // V-945 — raised from 30 to just under the 84 the widened pattern sees. At 30
    // a scan seeing only the `request.body` half (40) cleared the floor, which is
    // why the floor could not catch this: it detects a regex matching NOTHING, not
    // one matching half the population.
    expect(sites.length, 'no body-parsing route sites were found at all').toBeGreaterThanOrEqual(
      75,
    );
    expect(
      sites.filter((s) => s.reports).length,
      'no site was detected as reporting, so the detection half is broken',
    ).toBeGreaterThanOrEqual(18);
  });

  it('CRITICAL every non-exempt route that parses a body also reports unknown fields', () => {
    const missing = sites
      .filter((s) => !isExempt(s.file) && !s.reports && !EXEMPT_SCHEMA_NAMES.includes(s.schema))
      .filter((s) => !KNOWN_UNREPORTED.has(backlogKey(s)))
      .filter((s) => !REPORTED_AT_ROUTE_ENTRY.has(backlogKey(s)))
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

  it('CRITICAL the unreported backlog only ever shrinks, and holds no stale entry. Pinned rather than floored, because a floor lets it grow: wiring a route means deleting its key in the same commit, and the number below is a falling ceiling with its history in the comments. An entry that no longer matches an unreported site is worse than none — it reads like a considered decision while silencing whatever next lands under that key.', () => {
    // V-946 — 34 to 31: crypto-checkout, its quote, and profile clone were wired
    // after reading each registration individually. Lowering this is what the
    // staleness arm forces — it flagged all three by name the moment they started
    // reporting, so the count cannot drift above the real backlog.
    //
    // V-947 — 31 to 21. Five more wired the same way, one registration at a time:
    // POST /v1/agent-sessions and its resume, the transport report, the CLI
    // bind-device-code, and MFA step-up. The other five came off the list without
    // being wired, because reading them showed they were never customer surfaces:
    // three mac-nodes routes and two internal atlas-priority routes are staff-only,
    // so they moved to the file exemption and its staff-gate arm.
    //
    // V-949 — 21 to 16. Four session writes wired (cookies/set, history, files,
    // handback — all controlKeyOrAccountAuth('write')), attributed correctly only
    // after V-948 fixed the pattern that could not see their type-argument
    // registrations. The fifth, RunTurnRequestSchema, was never a defect at all:
    // see REPORTED_AT_ROUTE_ENTRY above.
    expect(KNOWN_UNREPORTED.size, 'backlog entries — may only fall, never rise').toBe(16);
    const live = new Set(
      sites
        .filter((s) => !isExempt(s.file) && !s.reports && !EXEMPT_SCHEMA_NAMES.includes(s.schema))
        .filter((s) => !REPORTED_AT_ROUTE_ENTRY.has(backlogKey(s)))
        .map(backlogKey),
    );
    const stale = [...KNOWN_UNREPORTED].filter((k) => !live.has(k)).sort();
    expect(
      stale,
      'these backlog entries no longer name an unreported site — the route was wired or removed, so delete the key and lower the count:',
    ).toEqual([]);
  });

  it('CRITICAL every exempt schema is actually strict, which is why it may skip the reporter', () => {
    // The exemption's whole justification. A `.strict()` schema answers an
    // unknown key with a 400, so nothing is silently dropped and there is
    // nothing to report. Lose the modifier and the route starts stripping keys
    // exactly like the ones this mechanism was built for, while the exemption
    // above keeps waving it through.
    // V-977 — the verdict comes from the ISSUE, not from the rejection.
    //
    // This filter used to read `return parsed.success`, i.e. "the probe was
    // refused, so the schema must be strict". That is only sound for a schema
    // whose fields are all optional, because any schema with a REQUIRED field
    // refuses the probe for missing fields whether or not it is strict. Measured:
    // with `transportReportBodySchema` exempted, deleting its `.strict()`
    // left this arm green — the exemption was riding on a check that could not
    // see the property it was named for. Zod reports an `unrecognized_keys`
    // issue only when a strict object meets an unknown key, so that is the
    // verdict, and a schema that refuses for any other reason no longer counts.
    const notStrict = EXEMPT_SCHEMAS.filter(([, schema]) => {
      const parsed = (
        schema as {
          safeParse: (v: unknown) => { success: boolean; error?: { issues: { code: string }[] } };
        }
      ).safeParse({ label: 'x', __unknown_probe__: 'y' });
      if (parsed.success) return true;
      return !(parsed.error?.issues ?? []).some((i) => i.code === 'unrecognized_keys');
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

  it('CRITICAL a route-entry-report exemption is DERIVED, never asserted. Two conditions, both read from the source: the file really does report that schema somewhere, and the schema really is parsed more than once. Without them this list is a way to declare any unreported route fixed — and the entry it holds today was itself the correction of a backlog claim that turned out to be false, so the list gets the scrutiny the claim did not.', () => {
    const KNOWN_KEYS_ANY =
      /knownKeys:\s*(?:Object\.keys\((\w+Schema)\.shape\)|knownRequestKeys\((\w+Schema)\))/g;
    expect(REPORTED_AT_ROUTE_ENTRY.size, 'entries — kept small and each one read').toBe(1);
    for (const key of REPORTED_AT_ROUTE_ENTRY) {
      const parts = /^(.+) \((\w+)\)$/.exec(key);
      expect(parts, `${key} is in "file (Schema)" form`).not.toBeNull();
      const file = parts![1]!;
      const schema = parts![2]!;

      const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
      const reported = new Set(
        [...src.matchAll(KNOWN_KEYS_ANY)].map((m) => m[1] ?? m[2]).filter((n) => n !== undefined),
      );
      expect(
        reported.has(schema),
        `${file} must actually report ${schema} somewhere — the exemption says the route reports at ` +
          'entry, so if that report is gone the parses are unreported again and belong in the backlog',
      ).toBe(true);

      const parseCount = sites.filter((s) => s.file === file && s.schema === schema).length;
      expect(
        parseCount,
        `${schema} must really be parsed more than once in ${file} — a single-parse route has no ` +
          'reason to report anywhere but next to its parse, and must not hide here',
      ).toBeGreaterThan(1);
    }
  });

  it('CRITICAL every registration in a file exempted for being STAFF-ONLY is actually gated. That is the whole justification for skipping the reporter there, and unlike the admin- prefix it is invisible in the filename — an ungated customer route added to one of these files would inherit an exemption it does not qualify for.', () => {
    // Counted rather than brace-matched, deliberately: this arc has had two
    // guards fooled by naive brace matching. Every registration must be either
    // gated by a preHandler naming a staff marker, or one of the unconditional
    // `reject` registrations the module uses when its internal token is absent.
    // An ungated addition breaks the equality; swapping the staff scope for a
    // customer one breaks the marker count.
    // V-948 — `\s*(?:<[^(]*>)?\s*\(` rather than a bare `\(`. Written the bare
    // way one commit earlier, this pattern could not see a registration carrying
    // a type argument — `app.post<{ Params: { id: string } }>(` — which is 119 of
    // the 285 registrations under src/routes. Neither staff file uses that shape
    // today, so the counts were right and the arm looked healthy; it would have
    // gone quietly wrong the moment one did, which is the failure this arm exists
    // to prevent. The fixture arm below tests the pattern instead of trusting it.
    const REGISTRATION = /app\.(?:get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(/g;
    const PREHANDLER = /preHandler:/g;
    for (const [file, markers] of STAFF_EXEMPT_FILES) {
      const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
      const registrations = [...src.matchAll(REGISTRATION)].length;
      const preHandlers = [...src.matchAll(PREHANDLER)].length;
      // A preHandler block naming at least one staff marker, within the 300
      // characters after the keyword — wide enough for a multi-line array.
      const staffGated = [...src.matchAll(PREHANDLER)].filter((m) => {
        const block = src.slice(m.index, m.index + 300);
        return markers.some((marker) => block.includes(marker));
      }).length;
      const rejects = [
        ...src.matchAll(/app\.(?:get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\([^)]*,\s*reject\)/g),
      ].length;

      expect(registrations, `${file} still registers routes`).toBeGreaterThan(0);
      expect(preHandlers, `${file} still has gated registrations`).toBeGreaterThan(0);
      expect(staffGated, `every preHandler block in ${file} names a staff gate`).toBe(preHandlers);
      expect(
        registrations,
        `every registration in ${file} is staff-gated or an unconditional reject — if this is off, ` +
          'a route was added without a gate and the file-level exemption is now covering a ' +
          'surface it was never justified for',
      ).toBe(preHandlers + rejects);
    }

    // V-948 — the pattern above is tested against a fixture, not just run. Both
    // staff files use only the plain shape, so a pattern blind to the other one
    // produces correct counts today and silently stops counting later.
    for (const [label, fixture] of [
      ['type-argument', "  app.post<{ Params: { id: string } }>(\n    '/v1/x/:id',\n"],
      ['plain', "  app.post(\n    '/v1/x',\n"],
    ] as const) {
      expect(
        [...fixture.matchAll(REGISTRATION)].length,
        `the registration pattern sees a ${label} registration`,
      ).toBe(1);
    }
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
