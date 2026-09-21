// The published `@driftstack/api-types` withholds the unreleased pricing.
//
// `packages/api-types/src/ai-credits.ts` is a rate card, a markup and per-plan
// allowances — 86 exports of a feature that is not live. The barrel re-exports
// it and the server imports every one of those names THROUGH the package
// (`apps/server/src/db/**` and `services/credit-*.ts` write
// `import { callChargeMicro } from '@driftstack/api-types'`), so inside this
// workspace the barrel has to carry them. npm must not: publishing them puts
// unreleased pricing and markup structure into a customer's autocomplete.
//
// ⛔ ONE `exports["."]` IS READ BY BOTH AUDIENCES. A workspace consumer and an
// npm consumer resolve the same `dist/index.js`, so the two shapes cannot be
// made to differ by configuration alone — a subpath export would only help if
// the server's imports moved to it, and those files belong to another workflow.
// The difference is made by `scripts/api-types-build-publish.mjs`, which runs
// between the build and the pack:
//
//     npm run build:publish -w packages/api-types
//     npm pack -w packages/api-types            # or npm publish
//     npm run build -w packages/api-types       # restore the workspace shape
//
// The direction of the remaining risk is deliberate. `files` withholds the
// module's own files UNCONDITIONALLY, so a tarball packed without that step is
// BROKEN AT IMPORT rather than quietly carrying the rate card: a missing file
// is loud on the first `import` and the runbook's install-and-run step catches
// it, while a shipped rate card is silent and permanent.
//
// WHAT THESE ARMS ARE FOR. Each property below has a way of failing that looks
// like success:
//
//   THE WORKSPACE STILL WORKS. A published package with nothing in it would
//   satisfy every "does not ship" arm at once. The first arm is the positive
//   control: the barrel still exports the pricing names for the server.
//
//   THE ALLOWLIST DID NOT OVER-EXCLUDE. `!dist/ai-*` is a glob, and a future
//   `dist/ai-something.js` would vanish from the package with nothing to say
//   so. One arm names exactly what the negations remove.
//
//   REMOVING THE MODULE IS NOT THE WHOLE JOB. The feature also leaks through a
//   NEIGHBOURING module's prose and field names. A check scoped to
//   `ai-credits.*` would report a clean removal and publish that, so the leak
//   check reads every shipped file and is deliberately word-level.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as apiTypes from '@driftstack/api-types';

import {
  filesEntryMatcher,
  npmShippedFilesDerived,
  npmShippedFilesViaPack,
} from '../../../../scripts/scan-shipped-text.mjs';
import {
  WITHHELD_MODULE,
  creditsMentions,
  withheldArtifacts,
  withoutReExport,
  withoutSourceMappingUrl,
} from '../../../../scripts/api-types-build-publish.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PKG_DIR = resolve(REPO_ROOT, 'packages/api-types');
const SRC = resolve(PKG_DIR, 'src');
const DIST = resolve(PKG_DIR, 'dist');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/**
 * The names the pricing module exports, READ FROM IT rather than listed here.
 *
 * A hard-coded roster goes stale the first time someone adds an export, and a
 * stale roster is the shape that reports a clean package while the new name
 * ships. The module is off-limits to this lane, so reading it is also the only
 * way to stay in step with it.
 */
function pricingIdentifiers(): string[] {
  const source = read(resolve(SRC, 'ai-credits.ts'));
  const names = [
    ...source.matchAll(/^export (?:const|function|type|interface|class|enum) (\w+)/gmu),
  ]
    .map((m) => m[1])
    .filter((n): n is string => typeof n === 'string');
  return [...new Set(names)].sort();
}

/**
 * The shipped files this release still names the feature in. EMPTY, and that is
 * the finished state rather than a list nobody got round to filling.
 *
 * ⛔ IT WAS `['dist/admin.d.ts', 'dist/admin.js']`, AND THE LEAK WAS NOT ONLY
 * PROSE. `packages/api-types/src/admin.ts` declared `monthly_credits` on
 * `ChangeTierRequest`, so the unreleased feature's field name reached the
 * emitted `.js` as a Zod field and the `.d.ts` as hover text — which is why
 * rewriting a comment could never have closed it and why `build:publish`
 * REFUSED the release while it stood. It is closed the way this note said it
 * would have to be: the PUBLISHED schema has no such field, and the server
 * extends it inside `src/ai-credits.ts`, the module `files` withholds from the
 * tarball unconditionally.
 *
 * The arm below still fails if anything is ADDED to the leak — that is what
 * keeps this at zero — and would fail if this list named a file that is now
 * clean.
 *
 * S12 ADDED `['dist/problem.d.ts', 'dist/problem.js']`, A DIFFERENT SHAPE OF
 * LEAK FROM THE admin.d.ts ONE ABOVE — CLOSED. That one was a field on a
 * schema and was closeable by moving the field into the withheld module;
 * this one was the `ai-credits-exhausted` problem-type URI itself, and S12
 * had put it in `PROBLEM_TYPES` (`packages/api-types/src/problem.ts`), the
 * single source of truth three OTHER guards read directly from `problem.ts`'s
 * SOURCE (`cross-sdk-problem-type-roster-source-parity.test.ts`,
 * `cross-sdk-problem-type-parity.test.ts`, and each SDK's own error-mapping
 * table) — so it could not be moved into `ai-credits.ts` the way the admin.ts
 * field was, without breaking those.
 *
 * It closed by giving the credits roster its OWN constant instead of sharing
 * `PROBLEM_TYPES`: `AI_CREDITS_PROBLEM_TYPES` in `ai-credits.ts` — a module
 * this package's `files` already withholds unconditionally, so anything
 * declared only there ships nowhere. `PROBLEM_TYPES` dropped the entry
 * entirely (back to its pre-S12 32), the three SDK error-mapping tables lost
 * their `ai_credits_exhausted` branch (an unmapped 402 of this type falls
 * back to each SDK's generic problem error, which still surfaces every
 * extension field), and every docs/error-site guard that used to carry a
 * `WITHHELD_UNTIL_LAUNCH` exemption for this one slug lost it — the slug
 * is no longer a member of the roster those pages compare against, so there
 * is nothing left to exempt.
 * `a-dark-problem-type-reaches-no-published-surface-before-launch.test.ts`
 * now pins the invariant that made this hand-off closeable: no member of
 * `AI_CREDITS_PROBLEM_TYPES` may ever be a member of `PROBLEM_TYPES` at the
 * same time, or reachable on any published surface, while the server can
 * still construct and send it.
 */
const KNOWN_LEAK_HANDOFF: readonly string[] = [];

describe('the published api-types withholds the unreleased pricing', () => {
  const packed = npmShippedFilesViaPack(PKG_DIR);
  const derived = npmShippedFilesDerived(PKG_DIR);

  it('CRITICAL the WORKSPACE barrel still carries the pricing module — the server imports those names through the package', () => {
    const index = read(resolve(SRC, 'index.ts'));
    expect(index.match(/^export \* from '\.\/ai-credits\.js';$/gmu)).toHaveLength(1);
    // Not just the text: the built package the suite actually executes.
    const runtime = apiTypes as unknown as Record<string, unknown>;
    for (const name of ['callChargeMicro', 'CREDIT_RATE_CARD_V1', 'AI_PLAN_ENTITLEMENTS']) {
      expect(runtime[name], `${name} is missing from the workspace barrel`).toBeDefined();
    }
  });

  it('CRITICAL the `files` allowlist withholds the pricing module and the build metadata, unconditionally', () => {
    const manifest = JSON.parse(read(resolve(PKG_DIR, 'package.json'))) as { files: string[] };
    expect(manifest.files).toEqual(['dist', '!dist/ai-*', '!dist/.tsbuildinfo', 'README.md']);
    expect(packed, 'npm pack produced nothing — this arm must fail, not skip').not.toBeNull();
    expect(packed!.filter((f) => /ai[-_]?credit/iu.test(f))).toEqual([]);
    expect(packed!.filter((f) => f.endsWith('.tsbuildinfo'))).toEqual([]);
  });

  it('CRITICAL the negations remove exactly the pricing module and the build metadata — nothing else', () => {
    // What the same allowlist would ship with its negations taken out. The
    // difference is the whole effect of `!dist/ai-*` and `!dist/.tsbuildinfo`,
    // so a future `dist/ai-something.js` silently vanishing shows up here.
    const withoutNegations = new Set(
      derived.concat(
        ['ai-credits.js', 'ai-credits.d.ts', 'ai-credits.js.map', 'ai-credits.d.ts.map'].map(
          (n) => `dist/${n}`,
        ),
        ['dist/.tsbuildinfo'],
      ),
    );
    const removed = [...withoutNegations].filter((f) => !derived.includes(f)).sort();
    expect(removed).toEqual([
      'dist/.tsbuildinfo',
      'dist/ai-credits.d.ts',
      'dist/ai-credits.d.ts.map',
      'dist/ai-credits.js',
      'dist/ai-credits.js.map',
    ]);
    // The matcher itself, both directions — a glob that matched everything
    // would also satisfy the arm above.
    expect(filesEntryMatcher('dist/ai-*').test('dist/ai-credits.js')).toBe(true);
    expect(filesEntryMatcher('dist/ai-*').test('dist/api-keys.js')).toBe(false);
    expect(filesEntryMatcher('dist/ai-*').test('dist/agent-models.js')).toBe(false);
    expect(filesEntryMatcher('dist/ai-*').test('dist/index.d.ts')).toBe(false);
  });

  it('CRITICAL the allowlist did NOT over-exclude — the package still carries its entry, its types, its README and its licence', () => {
    for (const required of [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/common.js',
      'dist/common.d.ts',
    ]) {
      expect(packed, 'npm pack produced nothing').not.toBeNull();
      expect(packed!, `${required} is missing from the tarball`).toContain(required);
    }
    expect(packed!.length).toBeGreaterThan(90);
  });

  it('CRITICAL the derived file list equals `npm pack --dry-run`, so the negations are modelled and not assumed', () => {
    expect(packed, 'npm pack produced nothing — this arm must fail, not skip').not.toBeNull();
    expect(derived).toEqual(packed);
  });

  it('CRITICAL the published barrel drops the pricing re-export and keeps every other one', () => {
    for (const entry of ['index.js', 'index.d.ts']) {
      const before = read(resolve(DIST, entry));
      const after = withoutSourceMappingUrl(withoutReExport(before));
      expect(before).toContain(WITHHELD_MODULE);
      expect(after).not.toContain(WITHHELD_MODULE);
      const count = (text: string): number => (text.match(/^export \* from '/gmu) ?? []).length;
      expect(count(after), `${entry} lost more than the one re-export`).toBe(count(before) - 1);
      expect(after).not.toMatch(/^\/\/# sourceMappingURL=/mu);
    }
  });

  it('CRITICAL the transform REFUSES rather than doing nothing when the re-export is absent or doubled', () => {
    expect(() => withoutReExport("export * from './common.js';\n")).toThrow(/found 0/u);
    expect(() =>
      withoutReExport(`export * from '${WITHHELD_MODULE}';\nexport * from '${WITHHELD_MODULE}';\n`),
    ).toThrow(/found 2/u);
    // Positive control in the same breath, so "throws" cannot mean "always throws".
    expect(withoutReExport(`export * from '${WITHHELD_MODULE}';\nexport * from './x.js';\n`)).toBe(
      "export * from './x.js';\n",
    );
  });

  it('CRITICAL no shipped file names a pricing identifier once the module is withheld, and the barrel has no dangling import', () => {
    const names = pricingIdentifiers();
    expect(
      names.length,
      'the pricing roster came back empty — the reader is broken',
    ).toBeGreaterThan(80);
    const shipped = new Map<string, string>();
    for (const file of derived) {
      if (!/\.(?:js|d\.ts|json|md)$/u.test(file)) continue;
      shipped.set(file, read(resolve(PKG_DIR, file)));
    }
    for (const entry of ['dist/index.js', 'dist/index.d.ts']) {
      shipped.set(entry, withoutSourceMappingUrl(withoutReExport(shipped.get(entry) ?? '')));
    }
    const hits: string[] = [];
    for (const [file, text] of shipped) {
      for (const name of names) {
        if (new RegExp(`\\b${name}\\b`, 'u').test(text)) hits.push(`${file} :: ${name}`);
      }
    }
    expect(hits.sort()).toEqual([]);

    // Every relative specifier the published files import must itself ship, or
    // the tarball installs and then throws on the first import.
    const dangling: string[] = [];
    for (const [file, text] of shipped) {
      if (!/\.(?:js|d\.ts)$/u.test(file)) continue;
      for (const m of text.matchAll(/from '(\.\/[^']+)'/gu)) {
        const target = `dist/${(m[1] ?? '').replace(/^\.\//u, '')}`;
        if (!derived.includes(target)) dangling.push(`${file} -> ${m[1]}`);
      }
    }
    expect(dangling.sort()).toEqual([]);
  });

  it('CRITICAL the leak check reads the word, and leaves ordinary product copy alone', () => {
    expect(creditsMentions('Whole AI credits a month for an Enterprise agreement.')).toHaveLength(
      1,
    );
    expect(creditsMentions('one credit is one US cent')).toHaveLength(1);
    expect(creditsMentions('line 1\nnothing here\nmonthly_credits?: number;')).toEqual([
      { line: 3, text: 'monthly_credits?: number;' },
    ]);
    // Negative control: the words a shipped doc comment really uses.
    expect(
      creditsMentions(
        'Concurrent session limit per plan. Accredited partners are billed monthly.\n' +
          'The storage allowance, the rate limit and the discount all apply.\n',
      ),
    ).toEqual([]);
  });

  it('CRITICAL the package.json that ships never names the feature', () => {
    const manifest = read(resolve(PKG_DIR, 'package.json'));
    expect(manifest).not.toMatch(/ai[-_ ]?credit/iu);
    expect(creditsMentions(manifest)).toEqual([]);
  });

  it('RATCHET the only shipped text still naming the feature is the hand-off, and `build:publish` refuses while it is', () => {
    const leaking = new Set<string>();
    for (const file of derived) {
      if (!/\.(?:js|d\.ts|md)$/u.test(file)) continue;
      let text = read(resolve(PKG_DIR, file));
      if (file === 'dist/index.js' || file === 'dist/index.d.ts') {
        text = withoutSourceMappingUrl(withoutReExport(text));
      }
      if (creditsMentions(text).length > 0) leaking.add(file);
    }
    const remaining = [...leaking].sort();
    // Nothing new may leak…
    expect(
      remaining.filter((f) => !KNOWN_LEAK_HANDOFF.includes(f)),
      'a shipped file started naming the unreleased pricing feature',
    ).toEqual([]);
    // …and a hand-off that has been closed may not still be listed here.
    expect(
      KNOWN_LEAK_HANDOFF.filter((f) => !remaining.includes(f)),
      'this hand-off is done — delete it from KNOWN_LEAK_HANDOFF in the same change',
    ).toEqual([]);
  });

  it('the withheld-artifact matcher names the emitted files by shape, not by a fixed list', () => {
    expect(
      withheldArtifacts([
        'ai-credits.js',
        'ai-credits.d.ts',
        'ai-credits.js.map',
        'ai-credits.d.cts',
        'agent-models.js',
        'api-keys.js',
        'index.js',
      ]),
    ).toEqual(['ai-credits.d.cts', 'ai-credits.d.ts', 'ai-credits.js', 'ai-credits.js.map']);
    expect(withheldArtifacts(['index.js', 'common.js'])).toEqual([]);
  });

  it('the release runbook tells the releaser to run the publish build before packing api-types', () => {
    const runbook = read(resolve(REPO_ROOT, 'docs/runbooks/sdk-release.md'));
    expect(runbook).toMatch(/npm run build:publish -w packages\/api-types/u);
    const buildAt = runbook.indexOf('npm run build:publish -w packages/api-types');
    const packAt = runbook.indexOf('npm publish -w packages/api-types');
    expect(buildAt, 'the publish build is documented').toBeGreaterThan(-1);
    expect(packAt, 'the publish step is documented').toBeGreaterThan(-1);
    expect(buildAt, 'the publish build must be documented BEFORE the publish').toBeLessThan(packAt);
  });
});
