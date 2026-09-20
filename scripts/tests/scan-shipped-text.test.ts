// The shipped-text scanner actually distinguishes internal text from product copy.
//
// `apps/server/tests/unit/nothing-internal-ships-in-a-published-package.test.ts`
// is a RATCHET: it says a number did not get worse. No arm of it can tell a
// working scanner from one whose patterns stopped matching — a scanner that
// matched nothing would satisfy every arm of a ratchet at once, and read as the
// four lanes having finished. These are the arms that say it matches.
//
// Three properties are worth naming because each one has a way of failing that
// looks like success:
//
//   FIXTURES, BOTH DIRECTIONS. Planted internal text is found; ordinary
//   customer copy (Node.js, `node:crypto`, ISO-8601, SHA-256, RFC 7807, a
//   semantic version, a UUID, HTTP/2, macOS) is not. A rule that over-matches
//   makes the lanes chase ghosts; a rule that under-matches ships the thing.
//
//   THE ALLOW-LIST IS A SPAN, NOT A LINE. `node:crypto` on the same line as
//   "the session node" must suppress the first and report the second. Allowing
//   by proximity would quietly excuse every neighbouring hit, which is how an
//   allow-list turns into an off switch.
//
//   `sourcesContent` IS REALLY READ. `dist/index.js.map` embeds the whole
//   TypeScript source, so every comment in `packages/sdk-typescript/src` ships
//   inside the npm tarball. A scanner that only read `.js` and `.d.ts` would
//   report a smaller, wrong number and nobody would notice.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  ALLOW_LIST,
  INTERNAL_VOCABULARY,
  RULES,
  TICKET_ID,
  allowedRanges,
  filesEntryMatcher,
  goShippedFiles,
  hatchListsFrom,
  npmShippedFilesDerived,
  npmShippedFilesViaPack,
  isTextPath,
  nearestVcsIgnore,
  scanText,
  sourcesFromSourceMap,
  textUnitsForFile,
} from '../scan-shipped-text.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT_PATH = resolve(HERE, '..', 'scan-shipped-text.mjs');

const rulesOf = (text: string): string[] => [...new Set(scanText(text).map((f) => f.rule))].sort();

describe('shipped-text scanner — what it finds', () => {
  it('CRITICAL finds a ticket id in the doc comment an editor shows on hover', () => {
    const hover = '/** V-312 — immutable point-in-time copy of a profile. */';
    const found = scanText(hover, { file: 'dist/index.d.ts' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      rule: 'verdict-id',
      class: TICKET_ID,
      text: 'V-312',
      file: 'dist/index.d.ts',
      line: 1,
    });
  });

  it('CRITICAL finds internal infrastructure vocabulary in prose', () => {
    expect(rulesOf('The harness on the fleet node reports over the control plane.')).toEqual([
      'control-plane',
      'fleet',
      'harness',
      'node-as-infrastructure',
    ]);
    expect(scanText('the box forces --script-security 1')[0]?.class).toBe(INTERNAL_VOCABULARY);
  });

  it('reports the line and the matched text, so a lane can go straight to it', () => {
    const body = ['line one', 'line two', 'a comment citing W834 here', 'line four'].join('\n');
    const found = scanText(body);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
    expect(found[0]?.column).toBe(18);
    expect(found[0]?.text).toBe('W834');
  });

  it('CRITICAL every rule matches at least one string it says it was derived from', () => {
    const missing: string[] = [];
    for (const rule of RULES) {
      expect(
        rule.seen.length,
        `${rule.id} records no example, so nothing exercises it`,
      ).toBeGreaterThan(0);
      for (const example of rule.seen)
        if (!scanText(example).some((f) => f.rule === rule.id))
          missing.push(`${rule.id} does not match its own example ${JSON.stringify(example)}`);
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('finds the shapes the release review named, including ones absent from today’s artifacts', () => {
    for (const planted of ['V-312', 'W834', 'D-021', 'L-001', 'GUI4', 'SDK-B', 'TD-002'])
      expect(
        scanText(planted).map((f) => f.class),
        planted,
      ).toContain(TICKET_ID);
    expect(rulesOf('see planning file 133 and file 128')).toContain('planning-doc-ref');
    expect(rulesOf('agreed with A3 on the Mac mini')).toEqual(
      expect.arrayContaining(['agent-name', 'mac-hardware']),
    );
  });
});

describe('shipped-text scanner — what it leaves alone', () => {
  it('CRITICAL reports nothing in ordinary customer-facing copy', () => {
    const copy = [
      'Requires Node.js >= 18 (uses native `fetch`).',
      "import { randomUUID } from 'node:crypto';",
      'Errors follow RFC 7807. Signatures are HMAC-SHA-256 over a UTF-8 body.',
      'Timestamps are ISO-8601. Install @driftstack/sdk 0.2.0. Works over HTTP/2.',
      'Session 018f3a1c-9b2e-7c41-8a55-1f2b3c4d5e6f. Keys use P-256. Runs on macOS.',
      'A fleeting redirect is followed; the checkbox in the sandbox is not clicked.',
    ].join('\n');
    expect(scanText(copy)).toEqual([]);
  });

  it('does not mistake the Node runtime for a machine in the estate', () => {
    for (const ok of [
      'Node.js 18+',
      "await import('node:crypto')",
      '"node": ">=18"',
      'the importer is in node compatibility mode',
      '../../../node_modules/@types/node/crypto.d.ts',
    ])
      expect(scanText(ok), ok).toEqual([]);
  });

  it('CRITICAL the allow-list suppresses by SPAN, so a legitimate phrase cannot excuse its neighbours', () => {
    const mixed = "import 'node:crypto'; // the session node did not respond";
    const found = scanText(mixed);
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe('node-as-infrastructure');
    // The suppressed one is the first `node`, not the reported one.
    expect(found[0]?.column).toBeGreaterThan(mixed.indexOf('session'));

    const ranges = allowedRanges(mixed).filter((r) => r.allow === 'node-builtin-module');
    expect(ranges).toHaveLength(1);
    expect(mixed.slice(ranges[0]!.start, ranges[0]!.end)).toBe('node:crypto');
  });

  it('CRITICAL a package.json script that RUNS a file with node is the runtime, not a machine', () => {
    // `package.json` ships, so its `scripts` block is customer-visible text.
    expect(scanText('"build:publish": "npm run build && node scripts/build-publish.mjs"')).toEqual(
      [],
    );
    expect(scanText('"sync": "node ./tools/sync.cjs --check"')).toEqual([]);
    // NEGATIVE CONTROL, same breath: `node` without a file after it is still
    // reported, so this entry cannot be read as "the word node is allowed".
    const infra = scanText('the fleet node ran it');
    expect(infra.map((f) => f.rule).sort()).toEqual(['fleet', 'node-as-infrastructure']);
    expect(scanText('"deploy": "node the worker"').map((f) => f.rule)).toEqual([
      'node-as-infrastructure',
    ]);
  });

  it('NEGATIVE CONTROL the allow-list is load-bearing: the same word without its allowed context IS reported', () => {
    expect(scanText('node:crypto')).toEqual([]);
    expect(scanText('the fleet node').map((f) => f.rule)).toContain('node-as-infrastructure');
    expect(scanText('P-256')).toEqual([]);
    expect(scanText('P-23').map((f) => f.rule)).toContain('decision-id');
    expect(scanText('a classic-Mac-ended .ovpn')).toEqual([]);
    expect(scanText('the Mac harness').map((f) => f.rule)).toContain('mac-hardware');
    expect(scanText('point a webhook at http://localhost:4242/webhook')).toEqual([]);
    expect(scanText('the worker at 10.1.2.3:8443').map((f) => f.rule)).toContain('internal-host');
    expect(scanText('measured_from is "control_plane" or "fleet"')).toEqual([]);
    expect(scanText('ask for it with `?vantage=fleet`')).toEqual([]);
    expect(scanText('a fleet-vantage test of a VPN proxy').map((f) => f.rule)).toEqual([
      'fleet',
      'vantage',
    ]);
    expect(scanText('the deployment has no fleet').map((f) => f.rule)).toContain('fleet');
    expect(scanText('the vantage that produced it').map((f) => f.rule)).toContain('vantage');
  });

  it('every allow-list entry names a real rule and says why in a sentence', () => {
    const ruleIds = RULES.map((r) => r.id);
    for (const entry of ALLOW_LIST) {
      expect(entry.reason.length, `${entry.id}`).toBeGreaterThan(30);
      if (entry.rules !== '*')
        for (const r of entry.rules) expect(ruleIds, `${entry.id}`).toContain(r);
    }
  });
});

describe('shipped-text scanner — what counts as shipped text', () => {
  it('CRITICAL scans the TypeScript source a bundler embeds in a source map', () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['../src/profiles.ts'],
      sourcesContent: ['/** P-23 — the profile’s recent navigation. */\nexport const x = 1;\n'],
      mappings: '',
    });
    const units = textUnitsForFile('dist/index.js.map', map);
    expect(units).toHaveLength(1);
    expect(units[0]?.file).toBe('dist/index.js.map::../src/profiles.ts');
    const found = scanText(units[0]!.text, { file: units[0]!.file });
    expect(found.map((f) => f.text)).toEqual(['P-23']);
  });

  it('a map with no sourcesContent contributes nothing, and that is a real distinction not a parse failure', () => {
    // tsc emits these for api-types; tsup emits sourcesContent for the SDK.
    const bare = JSON.stringify({ version: 3, sources: ['../src/egress.ts'], mappings: 'AAAA' });
    expect(sourcesFromSourceMap(bare)).toEqual([]);
    expect(textUnitsForFile('dist/egress.js.map', bare)).toEqual([]);
    expect(sourcesFromSourceMap('not json at all')).toEqual([]);
    // …and the positive half, so "empty" cannot mean "the parser is broken".
    expect(
      sourcesFromSourceMap(
        JSON.stringify({ version: 3, sources: ['a.ts'], sourcesContent: ['hello'] }),
      ),
    ).toEqual([{ source: 'a.ts', content: 'hello' }]);
  });

  it('the base64 mappings blob of a map is never scanned', () => {
    // A mappings string is hex-and-letters noise; scanning it would invent
    // commit-sha findings by the thousand.
    const map = JSON.stringify({
      version: 3,
      sources: ['a.ts'],
      sourcesContent: ['clean'],
      mappings: 'a1b2c3d4e5f6;AACA,SAAS,cafe1234',
    });
    expect(textUnitsForFile('dist/a.js.map', map).map((u) => u.text)).toEqual(['clean']);
  });

  it('recognises the shipped file types whose names defeat a plain extension test', () => {
    for (const p of [
      'dist/index.d.ts',
      'dist/index.d.cts',
      'dist/.tsbuildinfo',
      'driftstack_sdk-0.2.0/.gitignore',
      'go.mod',
      'LICENSE',
      'driftstack_sdk-0.2.0.dist-info/METADATA',
      'PKG-INFO',
    ])
      expect(isTextPath(p), p).toBe(true);
    for (const p of ['assets/logo.png', 'fonts/inter.woff2', 'a.zip'])
      expect(isTextPath(p), p).toBe(false);
  });
});

describe('shipped-text scanner — how it decides what ships', () => {
  it('reads the hatch include rules out of the real pyproject.toml', () => {
    const py = readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/pyproject.toml'), 'utf8');
    const lists = hatchListsFrom(py);
    expect(lists.wheelPackages).toEqual(['src/driftstack']);
    expect(lists.sdistInclude).toEqual([
      '/src/driftstack',
      '/README.md',
      '/CHANGELOG.md',
      '/LICENSE',
      '/pyproject.toml',
    ]);
  });

  it('refuses rather than guessing when the hatch config is not the shape it models', () => {
    expect(hatchListsFrom('[project]\nname = "x"\n')).toEqual({
      wheelPackages: null,
      sdistInclude: null,
    });
  });

  it('finds the package-local ignore file hatchling force-includes, not the repository root one', () => {
    const found = nearestVcsIgnore(resolve(REPO_ROOT, 'packages/sdk-python'));
    expect(found).toBe(resolve(REPO_ROOT, 'packages/sdk-python/.gitignore'));
    expect(found).not.toBe(resolve(REPO_ROOT, '.gitignore'));
  });

  it('CRITICAL the Go list carries the examples and the licence, and excludes the test files by default', () => {
    const base = goShippedFiles(REPO_ROOT);
    const paths = base.files.map((f) => f.shipped);
    expect(paths).toContain('examples/quickstart/main.go');
    expect(paths).toContain('README.md');
    expect(paths).toContain('CHANGELOG.md');
    expect(paths).toContain('go.mod');
    expect(paths).toContain('LICENSE'); // untracked in this release; still in the tag
    expect(paths.filter((p) => p.endsWith('_test.go'))).toEqual([]);
    expect(base.excludedTests).toBeGreaterThan(20);

    const withTests = goShippedFiles(REPO_ROOT, { includeTests: true });
    expect(withTests.files.length).toBe(base.files.length + base.excludedTests);
  });

  it('CRITICAL honours an npm `files` NEGATION, because npm does', () => {
    // `@driftstack/api-types` withholds its unreleased pricing module and its
    // incremental-build cache with `!dist/ai-*` and `!dist/.tsbuildinfo`. A
    // derivation blind to the `!` reports files npm does not pack — the
    // direction that invents findings the artifact does not have, and the one
    // that would make this scanner's numbers describe a tarball nobody ships.
    const derived = npmShippedFilesDerived(resolve(REPO_ROOT, 'packages/api-types'));
    expect(derived.filter((f) => /^dist\/ai-/u.test(f))).toEqual([]);
    expect(derived.filter((f) => f.endsWith('.tsbuildinfo'))).toEqual([]);
    // POSITIVE CONTROL in the same breath: a negation that removed everything
    // would satisfy the two lines above and nothing else.
    expect(derived).toContain('dist/index.js');
    expect(derived).toContain('dist/index.d.ts');
    expect(derived).toContain('dist/api-keys.js');
    expect(derived).toContain('README.md');
    expect(derived).toContain('package.json');
    expect(derived.length).toBeGreaterThan(90);
  });

  it('CRITICAL the derived npm list equals `npm pack --dry-run` for both published packages', () => {
    // This is what proves the negation model above is npm's and not a plausible
    // guess. Written to FAIL rather than skip when npm produces nothing: it is
    // the only arm checking that the derived list is complete.
    for (const pkg of ['packages/api-types', 'packages/sdk-typescript']) {
      const dir = resolve(REPO_ROOT, pkg);
      const packed = npmShippedFilesViaPack(dir);
      expect(packed, `npm pack --dry-run produced nothing for ${pkg}`).not.toBeNull();
      expect(npmShippedFilesDerived(dir), pkg).toEqual(packed);
    }
  });

  it('NEGATIVE CONTROL the `files` matcher is a glob, not a substring — it does not remove its neighbours', () => {
    const ai = filesEntryMatcher('dist/ai-*');
    expect(ai.test('dist/ai-credits.js')).toBe(true);
    expect(ai.test('dist/ai-credits.d.ts.map')).toBe(true);
    // The files that share a prefix but are NOT the withheld module.
    expect(ai.test('dist/api-keys.js')).toBe(false);
    expect(ai.test('dist/agent-models.js')).toBe(false);
    expect(ai.test('dist/archetypes.js')).toBe(false);
    // `*` stops at a separator; `**` does not.
    expect(filesEntryMatcher('dist/*.js').test('dist/nested/x.js')).toBe(false);
    expect(filesEntryMatcher('dist/**/*.js').test('dist/nested/x.js')).toBe(true);
    // A directory entry covers its whole tree, which is how a bare `dist` works.
    expect(filesEntryMatcher('dist').test('dist/deep/x.d.ts')).toBe(true);
    expect(filesEntryMatcher('dist').test('distant/x.d.ts')).toBe(false);
    // A dot in the entry is a dot, not "any character".
    expect(filesEntryMatcher('dist/.tsbuildinfo').test('dist/.tsbuildinfo')).toBe(true);
    expect(filesEntryMatcher('dist/.tsbuildinfo').test('dist/Xtsbuildinfo')).toBe(false);
  });

  it('importing the module runs nothing — main() is behind an entry-point guard', () => {
    const src = readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(
      /if \(process\.argv\[1\] !== undefined && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\)/,
    );
  });
});
