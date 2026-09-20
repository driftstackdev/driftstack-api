// The "Run AI tasks from your code" guide teaches only what the API and the SDKs do.
//
// apps/docs/src/pages/guides/run-ai-tasks-from-code.md is the page a developer copies a
// working AI job from. Every fact it leans on here is DERIVED from the code that makes it
// true, never from a list copied into this file:
//
//   • the API paths it names      ← the route registrations in apps/server/src
//   • the SDK methods it calls    ← each SDK's agent-sessions resource source
//   • the option names it lists   ← each SDK's message() signature / options struct
//   • the result kinds it teaches ← the published message-response schema
//   • the step kinds it teaches   ← IntentResultSchema in @driftstack/api-types
//   • the stream events it lists  ← the frames the message route writes
//   • the error types it names    ← PROBLEM_TYPES in @driftstack/api-types
//
// and one arm keeps the page in customer words: no internal machinery, no ticket ids,
// no agent names, and nothing about AI credits, which are not live.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IntentResultSchema, PROBLEM_TYPES, TIER_FEATURES } from '@driftstack/api-types';
import {
  ALL_TURN_NOTICE_REASONS,
  TURN_LOOP_STOP_SENTENCES,
  TURN_NOTICE_REASONS,
  type TurnLoopStopReason,
  type TurnNoticeReason,
} from '../../src/services/agent-runtime.js';
import { codeOnly } from './_helpers/code-only.js';
import { markupOnly } from './_helpers/markup-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

const GUIDE_PATH = 'apps/docs/src/pages/guides/run-ai-tasks-from-code.md';
const REFERENCE_PATH = 'apps/docs/src/pages/api/agent-sessions.md';
const guide = read(GUIDE_PATH);

// ── Extractors (each is exercised on a synthetic input in the last arm) ─────────

/** `{id}`, `:id`, `$ID` and `${id}` all become `:p`, so the vocabularies compare. */
function normPath(p: string): string {
  return p
    .replace(/\$\{[^}]+\}/g, ':p')
    .replace(/\$[A-Za-z_]\w*/g, ':p')
    .replace(/\{[^}]+\}/g, ':p')
    .replace(/:[A-Za-z_]\w*/g, ':p')
    .replace(/[.,;]+$/, '')
    .replace(/\/+$/, '');
}

/** Every `METHOD /v1/…` route registered by a route file or app.ts, comments excluded. */
function registeredRoutes(): Set<string> {
  const files = [
    ...readdirSync(resolve(REPO_ROOT, 'apps/server/src/routes'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `apps/server/src/routes/${f}`),
    'apps/server/src/lib/app.ts',
  ];
  const out = new Set<string>();
  for (const file of files) {
    for (const m of codeOnly(read(file)).matchAll(
      /\bapp\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'(\/v1\/[^']+)'/g,
    )) {
      out.add(`${(m[1] ?? '').toUpperCase()} ${normPath(m[2] ?? '')}`);
    }
  }
  return out;
}

/** Every `/v1/…` path written anywhere on a page — prose, links, code and curl lines. */
function pathsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\/v1\/[A-Za-z0-9_\-/{}$:.]+/g)) out.add(normPath(m[0]));
  return out;
}

/** The `METHOD /v1/…` pairs a page names in inline code. */
function methodPathsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/`(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/[^`\s]+)`/g)) {
    out.add(`${m[1] ?? ''} ${normPath(m[2] ?? '')}`);
  }
  return out;
}

/** Fenced blocks by language tag. */
function fences(text: string, tags: readonly string[]): string[] {
  return [...text.matchAll(/```(\w+)\n([\s\S]*?)```/g)]
    .filter((m) => tags.includes((m[1] ?? '').toLowerCase()))
    .map((m) => m[2] ?? '');
}

/** Rows of the first markdown table whose header's first cell is exactly `head`. */
function tableRows(text: string, head: string): string[][] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => {
    const cells = l.trim().split('|').slice(1, -1);
    return cells.length > 1 && (cells[0] ?? '').trim() === head;
  });
  if (at === -1) return [];
  const rows: string[][] = [];
  for (let i = at + 2; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  }
  return rows;
}

/** The backticked value in a table cell (`plan-executed` → plan-executed). */
function codeIn(cell: string | undefined): string {
  return /`([^`]+)`/.exec(cell ?? '')?.[1] ?? '';
}

/** Text a customer reads, minus the runtime's own name and module specifiers. */
function customerWords(text: string): string {
  return text.replace(/Node\.js/g, '').replace(/['"]node:[a-z_]+['"]/g, "''");
}

const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ['infrastructure: fleet', /\bfleet\b/i],
  ['infrastructure: node', /\bnodes?\b/i],
  ['infrastructure: harness', /\bharness\b/i],
  ['infrastructure: control plane', /\bcontrol[\s-]plane\b/i],
  ['infrastructure: observer', /\bobserver\b/i],
  ['infrastructure: vantage', /\bvantage\b/i],
  ['an internal port in a URL', /https?:\/\/[^\s/'"`)]+:\d{2,5}\b/],
  ['a ticket id', /\b[VW]-?\d{2,5}\b/],
  ['an agent name', /\bA[123]\b/],
  ['the word founder', /\bfounder\b/i],
  ['AI credits, which are not live', /\bcredits?\b/i],
];

function bannedIn(text: string): string[] {
  const words = customerWords(text);
  return BANNED.filter(([, re]) => re.test(words)).map(([label]) => label);
}

// ── SDK surfaces ────────────────────────────────────────────────────────────────

function methodsOfClass(source: string, className: string, decl: RegExp): Set<string> {
  const at = new RegExp(`^(?:export )?class ${className}\\b`, 'm').exec(source);
  if (at === null) return new Set();
  let body = source.slice(at.index + at[0].length);
  const next = /\n(?:export )?class /.exec(body);
  if (next !== null) body = body.slice(0, next.index);
  return new Set(
    [...body.matchAll(decl)].map((m) => m[1] ?? '').filter((n) => n !== 'constructor'),
  );
}

const TS_RESOURCE = 'packages/sdk-typescript/src/resources/agent-sessions.ts';
const PY_RESOURCE = 'packages/sdk-python/src/driftstack/resources/agent_sessions.py';
const GO_RESOURCE = 'packages/sdk-go/agent_sessions.go';

function tsAgentSessionMethods(): Set<string> {
  return methodsOfClass(
    read(TS_RESOURCE),
    'AgentSessionsResource',
    /^ {2}(?:async\s+)?(\w+)\s*[(<]/gm,
  );
}
function pyAgentSessionMethods(): Set<string> {
  // The SYNC class: the guide's Python is synchronous.
  return methodsOfClass(read(PY_RESOURCE), 'AgentSessionsResource', /^ {4}def (\w+)\s*\(/gm);
}
function goAgentSessionMethods(): Set<string> {
  const src = [
    GO_RESOURCE,
    ...readdirSync(resolve(REPO_ROOT, 'packages/sdk-go'))
      .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
      .map((f) => `packages/sdk-go/${f}`),
  ]
    .map(read)
    .join('\n');
  return new Set(
    [...src.matchAll(/^func \(\w+ \*AgentSessionsResource\) (\w+)\(/gm)].map((m) => m[1] ?? ''),
  );
}

/** The source text of one method's parameter list, up to its body. */
function signatureOf(source: string, opener: RegExp, closer: RegExp): string {
  const at = opener.exec(source);
  if (at === null) return '';
  const rest = source.slice(at.index);
  const end = closer.exec(rest);
  return end === null ? '' : rest.slice(0, end.index);
}

function tsMessageSignature(): string {
  return signatureOf(read(TS_RESOURCE), /^ {2}message\(/m, /\): Promise<AgentMessageResponse>/);
}
function pySyncMessageSignature(): string {
  return signatureOf(read(PY_RESOURCE), /^ {4}def message\(/m, /\) -> /);
}
function goMessageOptionsStruct(): string {
  return signatureOf(read(GO_RESOURCE), /^type MessageOptions struct \{/m, /^\}/m);
}

// ── Derived contract facts ──────────────────────────────────────────────────────

interface SpecSchema {
  oneOf?: SpecSchema[];
  anyOf?: SpecSchema[];
  $ref?: string;
  properties?: Record<string, { enum?: string[]; const?: string }>;
}

/** The `kind` values the published message response can carry. */
function messageKindsFromSpec(): string[] {
  const spec = JSON.parse(read('packages/sdk-python/openapi.json')) as {
    components: { schemas: Record<string, SpecSchema> };
  };
  const schemas = spec.components.schemas;
  const top = schemas['AgentMessageResponse'];
  const variants = top?.oneOf ?? top?.anyOf ?? [];
  return variants
    .map((v) => (v.$ref !== undefined ? schemas[v.$ref.split('/').pop() ?? ''] : v))
    .map((v) => v?.properties?.['kind']?.enum?.[0] ?? v?.properties?.['kind']?.const ?? '')
    .filter((k) => k !== '')
    .sort();
}

/**
 * The "there is no answer, and here is why" field name, DERIVED from the
 * published response rather than spelled here.
 *
 * ⛔ IT IS THE HALF THAT GOES MISSING. `answer` and this field never arrive
 * together and a task that only acts has neither, so a program that branches
 * only on `answer` prints NOTHING for a turn that ran cleanly and could not
 * read the page back — silence that reads like a crash. The three guide
 * snippets lost that branch once already; nothing asserted it, so nothing said.
 */
function answerUnavailableFieldFromSpec(): string {
  const spec = JSON.parse(read('packages/sdk-python/openapi.json')) as {
    components: { schemas: Record<string, SpecSchema> };
  };
  const schemas = spec.components.schemas;
  const top = schemas['AgentMessageResponse'];
  const variants = (top?.oneOf ?? top?.anyOf ?? []).map((v) =>
    v.$ref !== undefined ? schemas[v.$ref.split('/').pop() ?? ''] : v,
  );
  const names = new Set<string>();
  for (const v of variants) for (const k of Object.keys(v?.properties ?? {})) names.add(k);
  const candidates = [...names].filter((n) => /^answer_/u.test(n));
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error(
      `the published AgentMessageResponse has ${candidates.length} answer_* fields ` +
        `(${candidates.join(', ')}); this guard assumed exactly one and would otherwise ` +
        'assert on a field nobody publishes',
    );
  }
  return candidates[0];
}

/** `answer_unavailable` -> `AnswerUnavailable`, the Go SDK's spelling of the same field. */
function pascal(snake: string): string {
  return snake.replace(/(?:^|_)([a-z])/gu, (_m, c: string) => c.toUpperCase());
}

/**
 * The body of the guide's `report()` function in one language's complete
 * program, comments stripped.
 *
 * Scoped to that function on purpose: the field name appears in the guide's
 * prose and in its result table too, so a whole-page search would stay green
 * with all three programs silently missing the branch.
 */
function reportBody(lang: 'ts' | 'python' | 'go'): string {
  const [tag, open, strip] = (
    {
      ts: ['ts', /^function report\(/mu, codeOnly],
      python: ['python', /^def report\(/mu, (src: string) => src.replace(/#[^\n]*/gu, '')],
      go: ['go', /^func report\(/mu, codeOnly],
    } as const
  )[lang];
  const complete = strip(fences(guide, [tag]).find((b) => b.length > 3000) ?? '');
  const at = open.exec(complete)?.index;
  if (at === undefined) return '';
  const rest = complete.slice(at);
  // TypeScript and Go close the function with a `}` in column 1; Python ends at
  // the next line that starts in column 1 and is not blank.
  const end =
    lang === 'python' ? /\n(?=[^\s#])/u.exec(rest.slice(rest.indexOf('\n'))) : /\n\}/u.exec(rest);
  return end === null || end.index === undefined
    ? rest
    : rest.slice(0, lang === 'python' ? rest.indexOf('\n') + end.index : end.index + 2);
}

/** The step-result kinds, from the schema the executor's results are published with. */
function stepKindsFromSchema(): string[] {
  return IntentResultSchema.options.map((o) => o.shape.kind.value as string).sort();
}

/** The SSE event names the message route writes. */
function streamEventsFromRoute(): string[] {
  const route = codeOnly(read('apps/server/src/routes/agent-sessions.ts'));
  const start = route.indexOf("'/v1/agent-sessions/:id/message'");
  const end = route.indexOf("'/v1/agent-sessions/:id/stop'", start);
  const handler = route.slice(start, end);
  const names = new Set<string>();
  for (const m of handler.matchAll(/writeProgressFrame\('(\w+)'/g)) names.add(m[1] ?? '');
  for (const m of handler.matchAll(/event: (\w+)\\n/g)) names.add(m[1] ?? '');
  return [...names].sort();
}

const problemSlugs = new Set(Object.values(PROBLEM_TYPES).map((uri) => uri.split('/').pop() ?? ''));

// ─────────────────────────────────────────────────────────────────────────────────

describe('the Run AI tasks guide teaches only what the API and SDKs do', () => {
  it('every API path the guide names is a route the server registers, under the method the guide gives', () => {
    const routes = registeredRoutes();
    // Vacuity: an extractor that found nothing would pass everything.
    expect(routes.size, 'registered routes found').toBeGreaterThan(200);
    expect(routes).toContain('POST /v1/agent-sessions/:p/message');

    const paths = pathsIn(guide);
    expect(paths.size, 'paths the guide names').toBeGreaterThan(8);
    expect(paths).toContain('/v1/agent-sessions/:p/message');

    const registeredPaths = new Set([...routes].map((r) => r.split(' ')[1] ?? ''));
    const unknownPaths = [...paths].filter((p) => !registeredPaths.has(p)).sort();
    expect(unknownPaths, 'paths the guide names that no route registers').toEqual([]);

    const named = methodPathsIn(guide);
    expect(named.size, 'METHOD /path pairs the guide names').toBeGreaterThan(8);
    const unknownPairs = [...named].filter((p) => !routes.has(p)).sort();
    expect(unknownPairs, 'METHOD /path pairs the guide names that no route registers').toEqual([]);
  });

  it('every SDK method the guide calls exists on that SDK’s agent-sessions resource', () => {
    const surfaces = [
      {
        lang: 'TypeScript',
        tags: ['ts', 'typescript'],
        call: /\bclient\.agentSessions\.(\w+)\s*\(/g,
        methods: tsAgentSessionMethods(),
      },
      {
        lang: 'Python',
        tags: ['python', 'py'],
        call: /\b\w*client\.agent_sessions\.(\w+)\s*\(/g,
        methods: pyAgentSessionMethods(),
      },
      {
        lang: 'Go',
        tags: ['go'],
        call: /\bclient\.AgentSessions\.(\w+)\s*\(/g,
        methods: goAgentSessionMethods(),
      },
    ];
    for (const s of surfaces) {
      expect(s.methods.size, `${s.lang}: agent-session methods extracted`).toBeGreaterThan(8);
      const called = new Set(
        fences(guide, s.tags).flatMap((code) => [...code.matchAll(s.call)].map((m) => m[1] ?? '')),
      );
      // The canonical flow in every language: create, read, send, stop, close.
      expect(called.size, `${s.lang}: agent-session calls in the guide`).toBeGreaterThanOrEqual(5);
      const missing = [...called].filter((m) => !s.methods.has(m)).sort();
      expect(missing, `${s.lang}: methods the guide calls that the SDK does not have`).toEqual([]);
    }
  });

  it('every option name the guide lists for an SDK is one that SDK’s message() accepts', () => {
    const rows = tableRows(guide, 'Option');
    expect(rows.length, 'rows in the guide’s option-name table').toBeGreaterThanOrEqual(3);
    const ts = tsMessageSignature();
    const py = pySyncMessageSignature();
    const go = goMessageOptionsStruct();
    expect(ts, 'the TypeScript message() signature was found').toMatch(/idempotencyKey/);
    expect(py, 'the Python message() signature was found').toMatch(/idempotency_key/);
    expect(go, 'the Go MessageOptions struct was found').toMatch(/IdempotencyKey/);
    for (const row of rows) {
      const [label, tsName, pyName, goName] = [
        row[0],
        codeIn(row[1]),
        codeIn(row[2]),
        codeIn(row[3]),
      ];
      expect(ts, `TypeScript option for "${label}"`).toMatch(new RegExp(`\\b${tsName}\\?:`));
      expect(py, `Python option for "${label}"`).toMatch(new RegExp(`\\b${pyName}:`));
      expect(go, `Go option for "${label}"`).toMatch(new RegExp(`^\\s*${goName}\\s`, 'm'));
    }
  });

  it('the result kinds the guide teaches are exactly the kinds a message can return, and every example branches on each one an AI session can produce', () => {
    const fromSpec = messageKindsFromSpec();
    expect(fromSpec.length, 'kinds in the published message response').toBeGreaterThanOrEqual(4);
    // The dump must still agree with the source it is generated from.
    const openapi = codeOnly(read('apps/server/src/lib/openapi.ts'));
    for (const k of fromSpec) expect(openapi).toContain(`kind: z.literal('${k}')`);

    const taught = tableRows(guide, '`kind`')
      .map((r) => codeIn(r[0]))
      .sort();
    expect(taught, 'the guide’s kind table vs the published response').toEqual(fromSpec);

    const steps = stepKindsFromSchema();
    const taughtSteps = tableRows(guide, '`results[i].kind`')
      .map((r) => codeIn(r[0]))
      .sort();
    expect(taughtSteps, 'the guide’s step-kind table vs IntentResultSchema').toEqual(steps);

    // `logged-manual` only comes back from a `manual` session; the guide's programs create
    // `ai` sessions, and each has a default branch for anything else.
    const aiKinds = fromSpec.filter((k) => k !== 'logged-manual');
    // Comments are stripped first: a comment that merely MENTIONS "stopped" is not a
    // branch that handles it.
    const programs = [
      ['TypeScript', fences(guide, ['ts']), codeOnly],
      ['Python', fences(guide, ['python']), (src: string) => src.replace(/#[^\n]*/g, '')],
      ['Go', fences(guide, ['go']), codeOnly],
    ] as const;
    for (const [lang, blocks, stripComments] of programs) {
      const complete = stripComments(blocks.find((b) => b.length > 3000) ?? '');
      expect(complete.length, `${lang}: the complete program was found`).toBeGreaterThan(2500);
      for (const k of [...aiKinds, ...steps]) {
        // `case 'k':` (TS, Go) or an equality test against the literal (TS, Python, Go).
        expect(complete, `${lang} program branches on ${k}`).toMatch(
          new RegExp(`(?:\\bcase\\s+|={2,3}\\s*)['"]${k}['"]`),
        );
      }
    }
  });

  it('the stream events the guide and the reference list are exactly the events the message route writes', () => {
    const fromRoute = streamEventsFromRoute();
    expect(fromRoute, 'events derived from the route').toContain('response');
    expect(fromRoute, 'events derived from the route').toContain('step');
    expect(fromRoute.length, 'events derived from the route').toBeGreaterThanOrEqual(5);

    const inGuide = tableRows(guide, '`event`')
      .map((r) => codeIn(r[0]))
      .sort();
    expect(inGuide, 'the guide’s event table vs the route').toEqual(fromRoute);

    const inReference = tableRows(read(REFERENCE_PATH), 'Event')
      .map((r) => codeIn(r[0]))
      .sort();
    expect(inReference, 'the reference’s event table vs the route').toEqual(fromRoute);
  });

  it('every error type the guide’s error table names is a problem type the API sends', () => {
    const rows = tableRows(guide, 'Status');
    expect(rows.length, 'rows in the guide’s error table').toBeGreaterThan(10);
    const unknown = rows
      .map((r) => codeIn(r[1]))
      .filter((slug) => !problemSlugs.has(slug))
      .sort();
    expect(unknown, 'error types in the guide that PROBLEM_TYPES does not define').toEqual([]);
  });

  it('the guide is reachable from the nav, the guides index, the docs home, the agent-sessions reference and every quickstart', () => {
    const linkers = [
      'apps/docs/src/data/nav.ts',
      'apps/docs/src/pages/guides/index.astro',
      'apps/docs/src/pages/index.astro',
      REFERENCE_PATH,
      'apps/docs/src/pages/quickstart.md',
      'apps/docs/src/pages/quickstart-curl.md',
      'apps/docs/src/pages/sdk/typescript-quickstart.md',
      'apps/docs/src/pages/sdk/python-quickstart.md',
      'apps/docs/src/pages/sdk/go-quickstart.md',
    ];
    const missing = linkers.filter((rel) => {
      const src = read(rel);
      // A link inside a comment is not a link a reader can follow.
      const visible = rel.endsWith('.astro')
        ? markupOnly(src)
        : rel.endsWith('.ts')
          ? codeOnly(src)
          : src;
      return !visible.includes('/guides/run-ai-tasks-from-code/');
    });
    expect(missing, 'pages that should link the guide and do not').toEqual([]);
  });

  it('the profile-in-use advice covers every kind of session the create can name, with the endpoint that ends each one', () => {
    // A 409 profile-in-use names whatever holds the profile, and the repo's
    // create can name TWO kinds: another agent session, or an ordinary browser
    // session started through /v1/sessions. The guide used to say "close it with
    // DELETE /v1/agent-sessions/{id}" of both, which is the wrong endpoint for
    // half of them. Both prefixes are DERIVED from the throw sites here.
    const repo = codeOnly(read('apps/server/src/db/agent-sessions-repo.ts'));
    const prefixes = new Set<string>();
    for (const m of repo.matchAll(/new ProfileInUseError\(\s*`([a-z]+)_\$\{/g)) {
      prefixes.add(`${m[1] ?? ''}_`);
    }
    // A throw that passes an agent-session row's own id carries this file's minted prefix.
    if (/new ProfileInUseError\(\s*\w+\.id\s*\)/.test(repo)) {
      const minted = /const id = `([a-z]+)_\$\{randomUUID/.exec(repo)?.[1];
      expect(minted, 'the agent-session id prefix was found').toBeDefined();
      prefixes.add(`${minted ?? ''}_`);
    }
    // Vacuity: an extractor that found nothing would pass on any wording.
    expect([...prefixes].sort(), 'id prefixes a profile-in-use can name').toEqual(['agt_', 'ses_']);

    const bullet = /- `409 profile-in-use`[\s\S]*?(?=\n- `|\n\n##)/.exec(guide)?.[0] ?? '';
    expect(bullet, 'the guide has a profile-in-use bullet').not.toBe('');
    for (const prefix of prefixes) {
      expect(bullet, `the profile-in-use advice names a ${prefix}… id`).toContain(prefix);
    }
    // And the endpoint that ends each kind, under a method the server registers.
    const routes = registeredRoutes();
    for (const pair of methodPathsIn(bullet)) {
      expect(routes, `the profile-in-use advice names ${pair}`).toContain(pair);
    }
    expect(methodPathsIn(bullet), 'both delete endpoints are named').toEqual(
      new Set(['DELETE /v1/agent-sessions/:p', 'DELETE /v1/sessions/:p']),
    );
  });

  it('the plan bullet names every tier, on the side the feature matrix puts it', () => {
    // A tier added to the product, or a tier whose aiAgent flag flips, must move
    // in this bullet. Both halves are DERIVED from TIER_FEATURES, never listed here.
    const withAgent = Object.entries(TIER_FEATURES)
      .filter(([, f]) => f.aiAgent)
      .map(([tier]) => tier)
      .sort();
    const withoutAgent = Object.entries(TIER_FEATURES)
      .filter(([, f]) => !f.aiAgent)
      .map(([tier]) => tier)
      .sort();
    // Vacuity: a matrix read as empty would pass any prose at all.
    expect(withAgent.length, 'tiers whose matrix turns the AI agent on').toBeGreaterThan(3);
    expect(withoutAgent.length, 'tiers whose matrix turns it off').toBeGreaterThan(0);

    const bullet =
      /- \*\*A plan with the AI agent\.\*\*[\s\S]*?(?=\n- \*\*)/.exec(guide)?.[0] ?? '';
    expect(bullet, 'the guide has a plan bullet').not.toBe('');
    // One lower-case word in backticks is a tier id; `403 forbidden` and the like are not.
    const idsIn = (text: string): string[] =>
      [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1] ?? '').sort();
    // The refusal sentence is the one that names the status; the rest is the include list.
    const sentences = bullet.replace(/\s+/g, ' ').split('. ');
    const refusal = sentences.filter((sentence) => sentence.includes('403')).join(' ');
    const included = sentences.filter((sentence) => !sentence.includes('403')).join(' ');
    expect(refusal, 'the bullet has a refusal sentence').not.toBe('');
    expect(idsIn(included), 'tiers the bullet says include the AI agent').toEqual(withAgent);
    expect(idsIn(refusal), 'tiers the bullet says are refused').toEqual(withoutAgent);
  });

  it('the enum values the guide spells out for `mode` and `stopped_during` are the published ones', () => {
    const enumIn = (source: string, field: string): string[] => {
      const found = new RegExp(`${field}: z\\.enum\\(\\[([^\\]]*)\\]\\)`).exec(source)?.[1] ?? '';
      return [...found.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '').sort();
    };
    const modes = enumIn(read('packages/api-types/src/agent-sessions.ts'), 'mode');
    const phases = enumIn(codeOnly(read('apps/server/src/lib/openapi.ts')), 'stopped_during');
    expect(modes, 'the published mode enum').toContain('ai');
    expect(modes.length, 'the published mode enum').toBeGreaterThan(2);
    expect(phases.length, 'the published stopped_during enum').toBeGreaterThan(2);

    // The mode bullet: every mode named, with `ai` given as the default.
    const modeBullet = /- `mode` defaults to[\s\S]*?(?=\n- )/.exec(guide)?.[0] ?? '';
    expect(modeBullet, 'the guide has a mode bullet').not.toBe('');
    const namedModes = [...modeBullet.matchAll(/`([a-z]+)`/g)]
      .map((m) => m[1] ?? '')
      .filter((word) => word !== 'mode' && word !== 'model');
    expect([...new Set(namedModes)].sort(), 'modes the guide names').toEqual(modes);

    // The stopped_during bullet: every phase, so a reader never meets an unlisted one.
    const phaseBullet =
      /- A `stopped` result also carries `stopped_during`[\s\S]*?(?=\n- )/.exec(guide)?.[0] ?? '';
    expect(phaseBullet, 'the guide has a stopped_during bullet').not.toBe('');
    const namedPhases = [...phaseBullet.matchAll(/`([a-z_]+)`/g)]
      .map((m) => m[1] ?? '')
      .filter((word) => word !== 'stopped' && word !== 'stopped_during');
    expect([...new Set(namedPhases)].sort(), 'phases the guide names').toEqual(phases);
  });

  it('the screenshot-and-download section names the SDK method for whichever of the two has one, and still teaches the other by hand', () => {
    // Which of the two has an SDK method is DERIVED, never asserted from memory:
    // when the download fetch gains one, "no SDK method yet" becomes false here
    // and this fails until the section is rewritten.
    const sdkMethods = [
      ...tsAgentSessionMethods(),
      ...pyAgentSessionMethods(),
      ...goAgentSessionMethods(),
    ];
    expect(sdkMethods.length, 'agent-session methods across the three SDKs').toBeGreaterThan(30);
    const captureMethods = sdkMethods.filter((m) => /capture/i.test(m)).sort();
    const downloadMethods = sdkMethods.filter((m) => /download/i.test(m)).sort();

    const section =
      /## Get a screenshot or a downloaded file\n[\s\S]*?(?=\n## )/.exec(guide)?.[0] ?? '';
    expect(section, 'the guide has the screenshot-and-download section').not.toBe('');

    // All three SDKs fetch a capture, and the section names each spelling, so a
    // reader in any language finds the call rather than the curl.
    expect(captureMethods, 'capture methods across the three SDKs').toEqual([
      'GetCapture',
      'getCapture',
      'get_capture',
    ]);
    for (const method of captureMethods) {
      expect(section, `the section names the ${method} method`).toContain(method);
    }
    // The download fetch has none, so the section must still say so.
    expect(downloadMethods, 'SDK methods that wrap the download fetch').toEqual([]);
    expect(section, 'the section says the download fetch has no SDK method').toMatch(
      /no SDK method yet/,
    );
    // Every sample here is self-contained. A reader lands on this section from the
    // result table, not from the curl program far below, so a sample leaning on the
    // `$API` / `$AUTH` shorthands that program defines would not run as written.
    const samples = fences(section, ['bash']);
    expect(samples.length, 'runnable samples in this section').toBeGreaterThan(1);
    for (const sample of samples) {
      expect(sample, 'a sample here borrows $API/$AUTH from the program below').not.toMatch(
        /\$\{?(API|AUTH)\b/,
      );
      const commands = sample.split('\n').filter((line) => line.trimStart().startsWith('curl'));
      expect(commands.length, 'curl commands in this sample').toBeGreaterThan(0);
      for (const command of commands) {
        expect(command, 'each curl names the full base URL').toContain(
          'https://api.driftstack.dev/v1/agent-sessions/',
        );
      }
      expect(
        sample.split('Authorization: Bearer').length - 1,
        'each curl carries its own auth header',
      ).toBe(commands.length);
    }
    // Exactly the three routes, all registered, all readable with read:sessions.
    expect(pathsIn(section), 'the routes this section teaches').toEqual(
      new Set([
        '/v1/agent-sessions/:p/captures/:p',
        '/v1/agent-sessions/:p/downloads',
        '/v1/agent-sessions/:p/downloads/content',
      ]),
    );
    const registeredPaths = new Set([...registeredRoutes()].map((r) => r.split(' ')[1] ?? ''));
    for (const p of pathsIn(section)) expect(registeredPaths, `${p} is registered`).toContain(p);
  });

  it('the download fetch the guide shows sends only query parameters the route accepts', () => {
    const route = codeOnly(read('apps/server/src/routes/agent-sessions.ts'));
    const schema =
      /const DownloadFetchQuerySchema = z\.object\(\{([\s\S]*?)\n {2}\}\);/.exec(route)?.[1] ?? '';
    expect(schema, 'the download query schema was found in the route').not.toBe('');
    const accepted = [...schema.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1] ?? '').sort();
    // Vacuity: an extractor that found nothing would wave through any URL at all.
    // Not a pinned pair — renaming a parameter should fail on the GUIDE's URL below,
    // which is the sentence a reader copies, not on a list retyped into this file.
    expect(accepted.length, 'query parameters the route accepts').toBeGreaterThan(1);
    expect(accepted, 'the route takes a format parameter').toContain('format');
    const formats = [
      ...(/format: z\.enum\(\[([^\]]*)\]\)/.exec(schema)?.[1] ?? '').matchAll(/'(\w+)'/g),
    ].map((m) => m[1] ?? '');
    expect(formats.length, 'formats the route offers').toBeGreaterThan(1);

    const query =
      /\/v1\/agent-sessions\/\$ID\/downloads\/content\?([^"\s]+)/.exec(guide)?.[1] ?? '';
    expect(query, 'the guide shows a downloads/content URL with a query').not.toBe('');
    const used = new Map(
      query.split('&').map((pair) => [pair.split('=')[0] ?? '', pair.split('=')[1] ?? '']),
    );
    expect(used.size, 'query parameters the guide sends').toBeGreaterThan(0);
    for (const key of used.keys()) expect(accepted, `query parameter ${key}`).toContain(key);
    expect(formats, 'the format the guide asks for').toContain(used.get('format'));
  });

  it('the live-transcript bullet names the SDK method in all three languages, and each SDK really has one', () => {
    // Derived: if an SDK loses its transcript method, the sentence that tells a
    // reader to call it stops being true, and this says so.
    const surfaces: ReadonlyArray<readonly [string, Set<string>]> = [
      ['TypeScript', tsAgentSessionMethods()],
      ['Python', pyAgentSessionMethods()],
      ['Go', goAgentSessionMethods()],
    ];
    const named: string[] = [];
    for (const [lang, methods] of surfaces) {
      expect(methods.size, `${lang}: agent-session methods extracted`).toBeGreaterThan(8);
      const transcript = [...methods].filter(
        (m) => m.toLowerCase().replace(/[^a-z]/g, '') === 'transcript',
      );
      expect(transcript, `${lang}: a method for the session transcript`).toHaveLength(1);
      named.push(transcript[0] ?? '');
    }

    const section = /## Watch it live \(optional\)\n[\s\S]*?(?=\n## )/.exec(guide)?.[0] ?? '';
    expect(section, 'the guide has the watch-it-live section').not.toBe('');
    for (const method of new Set(named)) {
      expect(section, `the section names the ${method} method`).toContain(method);
    }
    // And the route behind it, under the method the server registers.
    const routes = registeredRoutes();
    expect(routes, 'the transcript route is registered').toContain(
      'GET /v1/agent-sessions/:p/transcript',
    );
    expect(pathsIn(section), 'the section names the transcript route').toContain(
      '/v1/agent-sessions/:p/transcript',
    );
  });

  it('the stop section names the SDK method in all three languages, and says each hands back the status the section tells you to branch on', () => {
    // The section tells a reader to tell `stop_requested` from `no_turn_running`
    // — "If your own message is still waiting, ask again a second later". A
    // reader who cannot see that the SDK hands the status back has to guess
    // whether it does. Derived: the method set comes from each SDK's source,
    // and the returned status values from the TypeScript signature, so a stop
    // that stopped returning them fails here.
    const surfaces: ReadonlyArray<readonly [string, Set<string>]> = [
      ['TypeScript', tsAgentSessionMethods()],
      ['Python', pyAgentSessionMethods()],
      ['Go', goAgentSessionMethods()],
    ];
    const named: string[] = [];
    for (const [lang, methods] of surfaces) {
      expect(methods.size, `${lang}: agent-session methods extracted`).toBeGreaterThan(8);
      const stop = [...methods].filter((m) => m.toLowerCase() === 'stop');
      expect(stop, `${lang}: a method that stops the running turn`).toHaveLength(1);
      named.push(stop[0] ?? '');
    }

    // The statuses the SDK really hands back, from its own signature.
    const tsStop =
      /\n {2}stop\(id: string\): Promise<\{([^}]*)\}>/.exec(read(TS_RESOURCE))?.[1] ?? '';
    expect(tsStop, 'the TypeScript stop() return type was found').toContain('status');
    const statuses = [...tsStop.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
    expect(statuses.length, 'statuses the TypeScript stop() can return').toBeGreaterThan(1);

    const pages: ReadonlyArray<readonly [string, string]> = [
      ['the guide', /## Stop a task that runs too long\n[\s\S]*?(?=\n## )/.exec(guide)?.[0] ?? ''],
      [
        'the reference',
        /## Stop the running turn\n[\s\S]*?(?=\n## )/.exec(read(REFERENCE_PATH))?.[0] ?? '',
      ],
    ];
    for (const [label, section] of pages) {
      expect(section.length, `${label} has a stop section`).toBeGreaterThan(400);
      for (const method of new Set(named)) {
        // As a CALL, not as a word: both sections are headed "Stop …", so
        // `toContain('Stop')` would pass on a page that never names the method.
        expect(section, `${label} names the ${method} method`).toContain(`${method}(`);
      }
      for (const status of statuses) {
        expect(section, `${label} names the ${status} status`).toContain(status);
      }
      expect(section, `${label} says the SDKs hand the status back`).toMatch(
        /SDKs (?:hand you that|return the)/,
      );
      expect(section, `${label} names the field on the unconfirmed 503`).toContain(
        'stop_unconfirmed',
      );
    }
  });

  it('every field the published plan-executed result can carry is one the guide teaches, or one it declares it leaves out', () => {
    // A field added to the turn result is a field a reader needs to know about.
    // The list is DERIVED from the published response, so a new one shows up
    // here rather than waiting to be noticed.
    const spec = JSON.parse(read('packages/sdk-python/openapi.json')) as {
      components: { schemas: Record<string, SpecSchema> };
    };
    const schemas = spec.components.schemas;
    const top = schemas['AgentMessageResponse'];
    const planExecuted = (top?.oneOf ?? top?.anyOf ?? [])
      .map((v) => (v.$ref !== undefined ? schemas[v.$ref.split('/').pop() ?? ''] : v))
      .find(
        (v) =>
          (v?.properties?.['kind']?.enum?.[0] ?? v?.properties?.['kind']?.const) ===
          'plan-executed',
      );
    const fields = Object.keys(planExecuted?.properties ?? {}).sort();
    // Vacuity: a variant read as empty would pass on a guide that taught nothing.
    expect(fields, 'fields on the published plan-executed result').toContain('answer');
    expect(fields.length, 'fields on the published plan-executed result').toBeGreaterThan(5);

    /** Fields the guide deliberately does not teach, each with the reason. */
    const NOT_TAUGHT = new Map<string, string>([
      ['kind', 'the discriminator itself: the kind table IS this field, row by row'],
      [
        'session',
        'the session envelope, taught in its own right under "Start a session" and "Close the session"',
      ],
      [
        'usage',
        'per-turn token and cost evidence for billing, not something a task-running program branches on; the reference documents it',
      ],
    ]);
    const untaught = fields.filter((f) => !NOT_TAUGHT.has(f) && !guide.includes(`\`${f}\``));
    expect(
      untaught,
      'fields the published plan-executed result carries that the guide neither teaches nor declares it leaves out',
    ).toEqual([]);
    // The declared list cannot outlive the fields it excuses.
    expect(
      [...NOT_TAUGHT.keys()].filter((f) => !fields.includes(f)).sort(),
      'declared-untaught fields the published result no longer has',
    ).toEqual([]);
  });

  it('both pages name every reason a turn hands back with a notice, and both say the sentence does not always ask for “continue”', () => {
    // `notice` is prose, and nothing else in the result says WHY the turn
    // stopped — so the sentence is the whole of what a reader has to go on, and
    // a page that lists four of the six causes reads as a closed list that is
    // missing two. The set is DERIVED from the copy the runtime actually sends,
    // and the record below is keyed by the reason type, so a seventh reason is
    // a compile error here until both pages say what it asks the reader for.
    const reasons = Object.keys(TURN_LOOP_STOP_SENTENCES) as TurnLoopStopReason[];
    expect(reasons.length, 'reasons a turn can hand back for').toBeGreaterThan(3);

    const bulletIn = (page: string, pattern: RegExp, what: string): string => {
      // Wrapped prose: a phrase the page states can be split across two lines,
      // so compare against one line rather than against the page's wrapping.
      const bullet = (pattern.exec(page)?.[0] ?? '').replace(/\s+/g, ' ');
      // Vacuity: an extraction that missed would pass every assertion below.
      expect(bullet.length, `the ${what} notice paragraph`).toBeGreaterThan(200);
      return bullet;
    };
    const pages: ReadonlyArray<readonly [string, string]> = [
      [
        'the guide',
        bulletIn(guide, /1\. \*\*`notice` is present\*\*[\s\S]*?(?=\n2\. \*\*)/, 'guide’s'),
      ],
      [
        'the reference',
        bulletIn(
          read(REFERENCE_PATH),
          /- `notice` is present when the task[\s\S]*?(?=\n- `ok` is)/,
          'reference’s',
        ),
      ],
    ];

    /** Per reason: a phrase from its OWN sentence, and the cause both pages must name. */
    const CAUSES: Record<TurnLoopStopReason, { inSentence: RegExp; inDocs: RegExp }> = {
      planner_call_limit: {
        inSentence: /more steps than I take in one message/,
        inDocs: /planning rounds/i,
      },
      wall_clock: {
        inSentence: /taking too long for one message/,
        inDocs: /ran out of time|three minutes/i,
      },
      budget_floor: { inSentence: /AI budget left/, inDocs: /token budget/i },
      no_progress: { inSentence: /rather than go in circles/, inDocs: /going in circles/i },
      repeat_refused: {
        inSentence: /repeated an action that already ran/,
        inDocs: /repeated an action that already ran/i,
      },
      planner_unavailable: {
        inSentence: /could not work out the next ones/,
        inDocs: /could not work out the next steps/i,
      },
    };

    for (const reason of reasons) {
      const cause = CAUSES[reason];
      // The phrase is anchored to the live copy, so the mapping cannot drift
      // from the sentence it claims to be about.
      expect(
        TURN_LOOP_STOP_SENTENCES[reason],
        `the phrase pinned for ${reason} is in the sentence the runtime sends`,
      ).toMatch(cause.inSentence);
      for (const [label, bullet] of pages) {
        expect(bullet, `${label} names the cause behind ${reason}`).toMatch(cause.inDocs);
      }
    }

    // The premise behind the advice, derived: some sentences ask for "continue"
    // and some ask for something else. If that stops being true, the pages are
    // over-explaining and this arm says so rather than going quietly stale.
    const asksToContinue = reasons.filter((r) => /continue/i.test(TURN_LOOP_STOP_SENTENCES[r]));
    expect(asksToContinue.length, 'reasons whose sentence asks for “continue”').toBeGreaterThan(0);
    expect(
      reasons.length - asksToContinue.length,
      'reasons whose sentence asks for something other than “continue”',
    ).toBeGreaterThan(0);

    for (const [label, bullet] of pages) {
      expect(bullet, `${label} says which ones ask for “continue”`).toMatch(
        /"continue"|“continue”/,
      );
      expect(bullet, `${label} gives the token-budget sentence’s own advice`).toMatch(
        /start a new session/i,
      );
      expect(bullet, `${label} gives the going-in-circles sentence’s own advice`).toMatch(
        /what to try differently/i,
      );
      expect(bullet, `${label} says the sentence is open text, not something to match on`).toMatch(
        /open text: show it, do not match on it/,
      );
    }
  });

  it('both pages give every `notice_reason` a turn can send, and tell a program what to DO about each one', () => {
    // The point of the field: an unattended job decides without reading English.
    // So it is not enough that the pages list the values — each value has to
    // carry the ACTION, and the actions differ in ways that matter (three ask
    // for "continue", one says start a new session, three say a person must
    // look). The set is derived from the runtime, so a ninth value fails here
    // until both pages say what to do about it.
    const values = ALL_TURN_NOTICE_REASONS;
    expect(values.length, 'values a turn can send as notice_reason').toBeGreaterThan(6);
    // Every loop ending maps to one of them: the two that are not loop endings
    // are the hand-backs (a question, and a refusal to carry on).
    const mapped = new Set<string>(Object.values(TURN_NOTICE_REASONS));
    expect(
      values.filter((v) => !mapped.has(v)).sort(),
      'values that are not a loop ending',
    ).toEqual(['declined', 'question']);

    /** What each value's row must tell a program to do. */
    const ACTION: Record<TurnNoticeReason, RegExp> = {
      step_limit: /send "continue"/i,
      time_limit: /send "continue"/i,
      ai_unavailable: /send "continue"/i,
      repeated_step: /check the page/i,
      budget_low: /start a new session/i,
      no_progress: /ask a person/i,
      question: /answer it/i,
      declined: /ask a person/i,
    };

    for (const [label, page] of [
      ['the guide', guide],
      ['the reference', read(REFERENCE_PATH)],
    ] as const) {
      // Vacuity: the field itself has to be on the page at all.
      expect(page, `${label} names the field`).toContain('`notice_reason`');
      for (const value of values) {
        // The row for this value, on one line — a markdown table row.
        const row = page
          .split('\n')
          .find((line) => line.includes(`| \`${value}\``) || line.includes(`\`${value}\` |`));
        expect(row, `${label} has a row for ${value}`).toBeDefined();
        expect(row ?? '', `${label} says what to do about ${value}`).toMatch(ACTION[value]);
      }
      // And the OPEN rule, which is the whole compatibility story: a value this
      // reader has never seen must not be treated as an error.
      expect(page, `${label} says the list is open`).toMatch(
        /list is \*\*open\*\*|The list is \*\*open\*\*/,
      );
      expect(page, `${label} says what to do with a value you do not recognise`).toMatch(
        /value you do not recognise/i,
      );
    }
  });

  it('the guide says closing a session stops the turn it is running, because the close route really asks for the stop', () => {
    // Derived from the route, not from the sentence: the DELETE handler asks the
    // runtime to stop the turn and waits for it to wind down before closing, so
    // the message answers `stopped`. If that call goes away, the guide's claim
    // is a promise the product no longer keeps.
    const route = codeOnly(read('apps/server/src/routes/agent-sessions.ts'));
    const closeCancel =
      /cancelRunningTurn\(\{\s*runtime,\s*agentSessionId: req\.params\.id,\s*action: 'close',\s*waitForWindDown: true,/;
    expect(route, 'the close route asks the running turn to stop, and waits for it').toMatch(
      closeCancel,
    );
    expect(guide, 'the guide tells the reader that closing stops a running turn').toMatch(
      /it stops a turn that is still running/,
    );
    expect(guide, 'the guide says which result that message then answers').toMatch(
      /the same `stopped` result/,
    );
  });

  it('the guide does not send a reader into a retry loop that cannot end for an unrecordable key', () => {
    // The 503 fires when the deployment has NO receipt store, which does not
    // change while you wait — so "try again later with the same key" was advice
    // that loops forever. Derived: the route throws it from the branch that
    // finds no receipts repository at all, not from a failed write.
    const route = codeOnly(read('apps/server/src/routes/agent-sessions.ts'));
    expect(
      route,
      'the unrecordable-key 503 is thrown because the deployment has no receipt store',
    ).toMatch(/agentTurnReceipts === undefined\)\s*\{\s*throw new FeatureUnavailableError\(/);
    const row = guide
      .split('\n')
      .find((line) => line.includes('`feature-unavailable`') && line.includes('Idempotency-Key'));
    expect(row, 'the guide’s 503 row').toBeDefined();
    expect(row ?? '', 'the guide no longer calls it transient').not.toMatch(/try again later/i);
    expect(row ?? '', 'the guide says the same key will keep failing').toMatch(/Not transient/i);
    expect(row ?? '', 'the guide names the way out').toMatch(/without\*?\*? the header/i);
  });

  it('the refusals the guide says are safe to send again with the same key are exactly the ones the server gives the key back for', () => {
    // THE point of the retry section. The server releases an Idempotency-Key
    // only for a refusal wrapped in refusedBeforeAnyWork() at its throw site;
    // both the set and each refusal's status/type are derived from source, so
    // the guide cannot drift from the predicate.
    const route = codeOnly(read('apps/server/src/routes/agent-sessions.ts'));
    const errorsSrc = codeOnly(read('apps/server/src/lib/errors.ts'));

    /** name → `409 conflict`, from a class or helper that builds one problem. */
    function problemOf(source: string, name: string): string {
      const at = new RegExp(
        `(?:export )?(?:class ${name}\\b|function ${name}\\b|const ${name} = )`,
      ).exec(source);
      if (at === null) return '';
      const body = source.slice(at.index, at.index + 1500);
      const slug = /type: PROBLEM_TYPES\.(\w+)/.exec(body)?.[1];
      const status = /status: (\d{3})/.exec(body)?.[1];
      if (slug !== undefined && status !== undefined) {
        return `${status} ${PROBLEM_TYPES[slug as keyof typeof PROBLEM_TYPES].split('/').pop() ?? ''}`;
      }
      // One hop: a helper that delegates to another builder in the same file.
      const delegate = new RegExp(`return (?:new )?(\\w*Error)\\(`).exec(body)?.[1];
      return delegate === undefined || delegate === name ? '' : problemOf(source, delegate);
    }

    const released = new Set<string>();
    for (const m of route.matchAll(/refusedBeforeAnyWork\(\s*(?:new )?(\w+)\(/g)) {
      const name = m[1] ?? '';
      const problem = problemOf(route, name) || problemOf(errorsSrc, name);
      expect(
        problem,
        `the status and type of ${name}, the error at a released throw site`,
      ).not.toBe('');
      released.add(problem);
    }
    // Vacuity: no throw sites found would make the comparison below pass empty.
    expect(released.size, 'distinct refusals the server gives the key back for').toBeGreaterThan(4);

    // The guide's same-key table, read as `status type` pairs.
    const rows = tableRows(guide, 'Status').length;
    expect(rows, 'the guide still has its error table').toBeGreaterThan(10);
    const sameKey =
      /- \*\*The same key, after a refusal that did no work\.\*\*[\s\S]*?\n\n(?=- )/.exec(
        guide,
      )?.[0];
    expect(sameKey, 'the guide has a same-key retry table').toBeDefined();
    const taught = new Set(
      [...(sameKey ?? '').matchAll(/^\s*\|\s*(\d{3})\s*\|\s*`([a-z-]+)`/gm)].map(
        (m) => `${m[1] ?? ''} ${m[2] ?? ''}`,
      ),
    );
    expect([...taught].sort(), 'the guide’s same-key list vs the server’s released set').toEqual(
      [...released].sort(),
    );
  });

  it('the guide is written in customer words: no internal machinery, ticket ids, agent names, the word founder, or AI credits', () => {
    expect(bannedIn(guide), 'banned words found in the guide').toEqual([]);
  });

  it('CRITICAL all three report() snippets branch on the no-answer field, not just on `answer`. The two never arrive together and a task that only acts has neither, so a program that reads only `answer` prints nothing at all for a turn that ran cleanly and could not read the page back. The branch was missing from all three snippets until 2026-09-20 and this page has 50 pins, none of which read a report() body', () => {
    const field = answerUnavailableFieldFromSpec();
    expect(field, 'the field is derived from the published response').toBe('answer_unavailable');
    const goField = pascal(field);
    // The Go spelling is checked against the SDK that defines it rather than
    // assumed from the snake_case name.
    expect(
      codeOnly(read('packages/sdk-go/agent_sessions.go')),
      `the Go SDK does not expose ${goField}`,
    ).toMatch(new RegExp(`\\b${goField}\\b`, 'u'));

    const branches = [
      ['TypeScript', 'ts', new RegExp(`(?:else\\s+if|if)\\s*\\([^)]*\\breply\\.${field}\\b`, 'u')],
      ['Python', 'python', new RegExp(`(?:elif|if)\\s+[^\\n:]*["']${field}["'][^\\n:]*:`, 'u')],
      ['Go', 'go', new RegExp(`(?:else\\s+if|if)\\s+[^{\\n]*\\breply\\.${goField}\\b`, 'u')],
    ] as const;

    for (const [lang, tag, branch] of branches) {
      const body = reportBody(tag);
      // Vacuity: an extractor that returned nothing would make every assertion
      // below pass on a page with no programs at all.
      expect(
        body.length,
        `${lang}: report() body was not extracted from the guide`,
      ).toBeGreaterThan(200);
      expect(body, `${lang}: report() no longer prints the answer`).toMatch(/answer/iu);
      expect(
        body,
        `${lang}: report() does not branch on ${field} — a turn that ran cleanly but could ` +
          'not read the page back prints nothing',
      ).toMatch(branch);
    }
  });

  it(`NEGATIVE CONTROL the report() branch check fails on a body with the branch deleted, in each language's own syntax — otherwise "it branches" is a claim a matcher that matches nothing also satisfies`, () => {
    const field = answerUnavailableFieldFromSpec();
    const goField = pascal(field);
    const cases = [
      [
        new RegExp(`(?:else\\s+if|if)\\s*\\([^)]*\\breply\\.${field}\\b`, 'u'),
        `if (reply.answer !== undefined) console.log(reply.answer);\n  else if (reply.${field} !== undefined) console.log(reply.${field});`,
        'if (reply.answer !== undefined) console.log(reply.answer);',
      ],
      [
        new RegExp(`(?:elif|if)\\s+[^\\n:]*["']${field}["'][^\\n:]*:`, 'u'),
        `if "answer" in reply:\n    print(reply["answer"])\nelif "${field}" in reply:\n    print(reply["${field}"])`,
        'if "answer" in reply:\n    print(reply["answer"])',
      ],
      [
        new RegExp(`(?:else\\s+if|if)\\s+[^{\\n]*\\breply\\.${goField}\\b`, 'u'),
        `if reply.Answer != "" {\n\t\tfmt.Println(reply.Answer)\n\t} else if reply.${goField} != "" {\n\t\tfmt.Println(reply.${goField})\n\t}`,
        'if reply.Answer != "" {\n\t\tfmt.Println(reply.Answer)\n\t}',
      ],
    ] as const;
    for (const [branch, withBranch, withoutBranch] of cases) {
      expect(branch.test(withBranch), 'the matcher rejects a body that DOES branch').toBe(true);
      expect(branch.test(withoutBranch), 'the matcher accepts a body that does NOT branch').toBe(
        false,
      );
      // Mentioning the field without branching on it must not count either.
      expect(
        branch.test(`// ${field} is documented above\n${withoutBranch}`),
        'a mention of the field satisfies the matcher',
      ).toBe(false);
    }
  });

  it('the extractors discriminate: each flags a planted defect and passes the clean control', () => {
    // Paths and route shapes.
    expect(normPath('/v1/agent-sessions/$ID/message')).toBe('/v1/agent-sessions/:p/message');
    expect(normPath('/v1/agent-sessions/{id}/captures/{captureId}.')).toBe(
      '/v1/agent-sessions/:p/captures/:p',
    );
    expect(normPath('/v1/agent-sessions/${session.id}')).toBe('/v1/agent-sessions/:p');
    expect([...pathsIn('curl "$API/v1/agent-sessions/$ID/stop" -d {}')]).toEqual([
      '/v1/agent-sessions/:p/stop',
    ]);
    expect([...methodPathsIn('call `DELETE /v1/agent-sessions/{id}` to close')]).toEqual([
      'DELETE /v1/agent-sessions/:p',
    ]);

    // Tables: header match is exact and the scan stops at the end of the table.
    const table = '| `kind` | a |\n| --- | --- |\n| `one` | x |\n| `two` | y |\n\nnot a row\n';
    expect(tableRows(table, '`kind`').map((r) => codeIn(r[0]))).toEqual(['one', 'two']);
    expect(tableRows(table, 'kind')).toEqual([]);

    // Customer words: the runtime's name is fine, the machinery is not.
    expect(bannedIn("Node.js 18+ and import { randomUUID } from 'node:crypto'")).toEqual([]);
    expect(bannedIn('the step runs on a node in the fleet')).toEqual([
      'infrastructure: fleet',
      'infrastructure: node',
    ]);
    expect(bannedIn('see V-1234 and https://host.internal:8443/x')).toEqual([
      'an internal port in a URL',
      'a ticket id',
    ]);
    expect(bannedIn('each plan includes monthly AI credits')).toEqual([
      'AI credits, which are not live',
    ]);
  });
});
