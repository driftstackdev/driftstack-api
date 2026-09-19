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

  it('the screenshot-and-download section tells the reader to fetch by hand, and no SDK yet says otherwise', () => {
    // The claim "no SDK method yet" is only true while it is true. Derive it.
    const sdkMethods = [
      ...tsAgentSessionMethods(),
      ...pyAgentSessionMethods(),
      ...goAgentSessionMethods(),
    ];
    expect(sdkMethods.length, 'agent-session methods across the three SDKs').toBeGreaterThan(30);
    const wrappers = sdkMethods.filter((m) => /capture|download/i.test(m)).sort();
    expect(wrappers, 'SDK methods that wrap captures or downloads').toEqual([]);

    const section =
      /## Get a screenshot or a downloaded file\n[\s\S]*?(?=\n## )/.exec(guide)?.[0] ?? '';
    expect(section, 'the guide has the screenshot-and-download section').not.toBe('');
    expect(section, 'the section says these two have no SDK method').toMatch(/no SDK method yet/);
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

  it('the guide is written in customer words: no internal machinery, ticket ids, agent names, the word founder, or AI credits', () => {
    expect(bannedIn(guide), 'banned words found in the guide').toEqual([]);
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
