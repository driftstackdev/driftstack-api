// V-1071 — a write that reads its body without a schema escapes two guards at once.
//
// Two files police request bodies, and both key their population on the SCHEMA:
//
//   `unknown-request-fields-coverage-invariant` finds `XSchema.safeParse(req.body)`
//   sites and asks whether each reports unknown fields. Its own history records the
//   population problem twice — V-945 raised a floor after the pattern saw half the
//   sites, V-985 widened it for `parseOrThrow`.
//
//   `api-types-shapes-match-the-spec` pairs each route with the schema its handler
//   parses and compares the published bounds against it.
//
// A handler that validates by hand — `typeof body.x !== 'string'` and a thrown
// error — has no schema to key on, so it is in neither population. Not by exemption:
// by construction. Nothing reports it, nothing compares its published shape, and both
// files stay green.
//
// That matters because of what the reporter exists for. `Item 6` in this corpus was a
// mistyped field being dropped in silence, so a request answered success having
// changed nothing the caller asked for. A hand-validated body reintroduces exactly
// that, invisibly.
//
// ── The six, and why each is acceptable ────────────────────────────────────
//
// Measured today: six live writes read `request.body` with no schema parse. Two are
// raw-body webhook receivers whose payload is signature-verified bytes, and four
// hand-check a single field. None is wrong. The point is that a SEVENTH would be
// invisible, so the population is pinned rather than derived — the correction V-1069
// and V-1070 both had to make, applied here from the start.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

/** Every call form that counts as parsing a body through a schema. */
const SCHEMA_PARSE =
  /(\w+Schema)\.(?:safeParse|parse)\(|parseOrThrow\(|parseRequestBodyReportingUnknown\(/;

/**
 * Writes that read `request.body` with no schema parse, and the reason each is
 * acceptable.
 *
 * `POST /v1/webhooks/stripe`, `POST /v1/webhooks/nowpayments` — raw-body receivers.
 * The payload is bytes whose signature is verified before anything reads it; parsing
 * it through zod first would defeat the verification.
 *
 * `PUT /v1/account/me/byok-anthropic-key` — one field, checked as a non-empty string,
 * which is exactly what the document publishes for it (`minLength: 1`, required).
 *
 * `POST /v1/api-keys/:id/rotate` — optional `name`, type- AND length-checked by hand; the
 * route says so in a comment at the check. The type half is V-1478: a present `name` of the
 * wrong type used to fall through both this route's signals and return a silent 201.
 *
 * `POST /v1/profiles/:id/transfer` — one `recipient_account_id`, checked and rejected
 * with a ValidationError carrying the field.
 *
 * `POST /v1/agent-sessions/:id/message` — hand-read, but it DOES pass
 * `RunTurnRequestSchema.shape` to the unknown-field reporter, so the mistyped-key
 * failure this file worries about is already covered there.
 */
const HAND_VALIDATED: Readonly<Record<string, string>> = {
  'POST /v1/webhooks/stripe': 'raw-body signature receiver',
  'POST /v1/webhooks/nowpayments': 'raw-body signature receiver',
  'PUT /v1/account/me/byok-anthropic-key': 'single field, matches the published minLength',
  'POST /v1/api-keys/:id/rotate': 'optional name, hand type- and length-checked',
  'POST /v1/profiles/:id/transfer': 'single recipient_account_id, ValidationError on miss',
  'POST /v1/agent-sessions/:id/message': 'reports unknown fields against RunTurnRequestSchema',
};

interface Write {
  readonly key: string;
  readonly file: string;
  readonly readsBody: boolean;
  readonly parses: boolean;
}

/**
 * Live POST/PUT/PATCH registrations, with whether each reads a body and parses one.
 *
 * Segments are bounded by the enclosing `export function` as well as the next
 * registration — without that the last live route in a file swallows the
 * `…DisabledRoutes` stub beneath it and inherits its contents.
 */
function writes(): Write[] {
  const out: Write[] = [];
  const REGISTRATION =
    /app\.(get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g;
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(ROUTES, file), 'utf8');
    const fns = [...src.matchAll(/^export function (\w+)/gm)].map((m) => [m.index, m[1]!] as const);
    const edges = [...fns.map(([at]) => at), src.length];
    const regs = [...src.matchAll(REGISTRATION)];
    for (const [i, m] of regs.entries()) {
      const verb = (m[1] ?? '').toLowerCase();
      if (verb !== 'post' && verb !== 'put' && verb !== 'patch') continue;
      let owner = '(top)';
      let fnEnd = src.length;
      for (const [idx, [at, name]] of fns.entries()) {
        if (at <= m.index) {
          owner = name;
          fnEnd = edges[idx + 1] ?? src.length;
        } else break;
      }
      if (/Disabled/.test(owner)) continue;
      const nextReg = i + 1 < regs.length ? (regs[i + 1]?.index ?? src.length) : src.length;
      const segment = src.slice(m.index + m[0].length, Math.min(nextReg, fnEnd));
      out.push({
        key: `${verb.toUpperCase()} ${m[2] ?? ''}`,
        file,
        readsBody: /\b(req|request)\.body\b/.test(segment),
        parses: SCHEMA_PARSE.test(segment),
      });
    }
  }
  return out;
}

const handValidated = (): Write[] => writes().filter((w) => w.readsBody && !w.parses);

describe('V-1071 a hand-validated write body is listed', () => {
  it('CRITICAL the scan sees real writes and both detectors discriminate. If the walk matched nothing, or the parse pattern matched everything, the list below would be empty for a reason that has nothing to do with how bodies are validated.', () => {
    const all = writes();
    expect(all.length, 'live POST/PUT/PATCH registrations').toBeGreaterThanOrEqual(80);
    expect(all.filter((w) => w.parses).length, 'writes parsing through a schema').toBeGreaterThan(
      40,
    );
    expect(all.filter((w) => w.readsBody).length, 'writes reading a body at all').toBeGreaterThan(
      40,
    );

    // Both halves of the classifier must actually discriminate.
    expect(SCHEMA_PARSE.test('const p = FooSchema.safeParse(req.body);')).toBe(true);
    expect(SCHEMA_PARSE.test('const body = request.body ?? {};')).toBe(false);
  });

  it('CRITICAL every write that reads a body without a schema is listed with its reason. Such a handler is in neither body-guard population — not by exemption but by construction, since both key on the schema — so nothing reports its unknown fields and nothing compares its published shape.', () => {
    const unlisted = handValidated()
      .filter((w) => !(w.key in HAND_VALIDATED))
      .map((w) => `${w.key}  (${w.file})`)
      .sort();
    expect(
      unlisted,
      'these writes read request.body with no schema parse and are not listed — parse through a ' +
        'schema so the existing guards can see them, or add them here with the reason:',
    ).toEqual([]);
  });

  it('CRITICAL the list holds no stale entry. A route that has since moved to a schema would sit here reading as a considered exception while pre-approving whatever next appears under that path.', () => {
    const live = new Set(handValidated().map((w) => w.key));
    expect(
      Object.keys(HAND_VALIDATED)
        .filter((k) => !live.has(k))
        .sort(),
      'listed as hand-validated but it now parses through a schema — good, and the entry should ' +
        'go with it:',
    ).toEqual([]);
  });
});
