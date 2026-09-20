// The PUBLISH-TIME shape of `@driftstack/api-types`, produced from the ordinary
// build.
//
// ⛔ WHY THIS EXISTS. `src/ai-credits.ts` is an UNRELEASED pricing module — a
// rate card, a markup and per-plan allowances, 86 exports of it. The server
// imports every one of them through the package barrel (`apps/server/src/db/**`
// and `services/credit-*.ts` do `import { callChargeMicro } from
// '@driftstack/api-types'`), so the barrel has to carry them INSIDE this
// workspace. npm must not: publishing them puts unreleased pricing into a
// customer's autocomplete.
//
// One `exports["."]` is read by both audiences, so the two shapes cannot differ
// by configuration alone. They differ by this step, which runs BEFORE
// `npm pack` / `npm publish` and after the ordinary build:
//
//     npm run build:publish -w packages/api-types
//     npm pack -w packages/api-types            # or npm publish
//     npm run build -w packages/api-types       # restore the workspace shape
//
// ⛔ IF THIS STEP IS SKIPPED the published package is BROKEN AT IMPORT rather
// than quietly carrying the pricing module: `files` refuses `dist/ai-credits.*`
// unconditionally, so a tarball whose index still re-exports it cannot resolve
// that specifier. That is the deliberate direction. A missing file is loud and
// the release runbook's install-and-run step catches it on the first import; a
// shipped rate card is silent and permanent.
//
// Everything here is a file edit — no compiler, no network, no credential — so
// it is fast and repeatable, and `npm run build` puts the workspace back.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The module the published barrel must not re-export. */
export const WITHHELD_MODULE = './ai-credits.js';

/**
 * `text` with the `export * from '<specifier>';` line removed.
 *
 * ⛔ THROWS when the line is not there exactly once. A transform that silently
 * did nothing would leave the pricing module re-exported and still report
 * success, which is the failure this whole step exists to prevent — and it is
 * the shape a future edit to `src/index.ts` would produce. Refusing is how the
 * skip becomes visible at the moment it happens rather than on npm.
 */
export function withoutReExport(text, specifier = WITHHELD_MODULE) {
  const line = new RegExp(
    `^export \\* from '${specifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}';[ \\t]*\\r?\\n`,
    'mu',
  );
  const matches = text.match(new RegExp(line.source, 'gmu'));
  if (matches === null || matches.length !== 1) {
    throw new Error(
      `expected exactly one \`export * from '${specifier}';\` line, found ${matches === null ? 0 : matches.length}`,
    );
  }
  return text.replace(line, '');
}

/** `text` with its trailing `//# sourceMappingURL=` line removed, if it has one. */
export function withoutSourceMappingUrl(text) {
  return text.replace(/^\/\/# sourceMappingURL=[^\n]*\r?\n?/mu, '');
}

/**
 * Files under `dist/` whose NAME names the withheld module — the four tsc emits
 * for it, matched by shape rather than listed, so an added `.d.cts` or a renamed
 * map is removed too instead of slipping through a hard-coded list.
 */
export function withheldArtifacts(distFiles) {
  return distFiles.filter((name) => /^ai-credits\./u.test(name)).sort();
}

/**
 * Text that names the unreleased credits feature, wherever it appears.
 *
 * ⛔ REMOVING THE MODULE IS NOT THE WHOLE JOB. The 86 exports are only the
 * obvious half; the feature also leaks through a NEIGHBOURING module's prose
 * and field names — `monthly_credits` on the admin change-tier request is a
 * published field whose doc comment says what a month's credits buy. A check
 * scoped to `ai-credits.*` would report a clean removal and publish that.
 *
 * Deliberately shallow and deliberately loud: it matches the word wherever it
 * stands on its own, so a sentence about a "credit card" trips it too. A false
 * positive costs a sentence; a miss costs a published feature name.
 *
 * ⛔ NOT `\bcredits?\b`. `_` is a word character, so a word-boundary pattern
 * does not match `monthly_credits` — the published FIELD NAME this check exists
 * to catch. The first version had that bug and reported the admin schema clean
 * while its field was right there. The lookarounds below bound on LETTERS, so a
 * field name matches and `Accredited` does not.
 */
export function creditsMentions(text) {
  const out = [];
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && /(?<![A-Za-z])credits?(?![A-Za-z])/iu.test(line)) {
      out.push({ line: i + 1, text: line.trim() });
    }
  }
  return out;
}

function main() {
  const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'api-types');
  const dist = join(pkgDir, 'dist');
  if (!existsSync(join(dist, 'index.js')) || !existsSync(join(dist, 'index.d.ts'))) {
    process.stderr.write(
      'build-publish: dist/index.js or dist/index.d.ts is missing. Run `npm run build` first.\n',
    );
    return 2;
  }

  // ⛔ DECIDE FIRST, WRITE SECOND. An earlier version removed the files and then
  // checked, so a refusal left `dist/` half-published and every workspace import
  // of the pricing module broken until someone re-ran the build. The publish
  // shape is computed in memory, judged there, and only written once it passes.
  const withheld = new Set(withheldArtifacts(readdirSync(dist)).map((n) => `dist/${n}`));
  for (const entry of ['index.js.map', 'index.d.ts.map', '.tsbuildinfo']) {
    if (existsSync(join(dist, entry))) withheld.add(`dist/${entry}`);
  }

  /** Every text file the tarball would carry, keyed by published path. */
  const published = new Map();
  for (const name of readdirSync(dist)) {
    if (!/\.(?:js|d\.ts)$/u.test(name) || withheld.has(`dist/${name}`)) continue;
    published.set(`dist/${name}`, readFileSync(join(dist, name), 'utf8'));
  }
  let rewriteError = null;
  for (const entry of ['index.js', 'index.d.ts']) {
    try {
      published.set(
        `dist/${entry}`,
        withoutSourceMappingUrl(withoutReExport(published.get(`dist/${entry}`) ?? '')),
      );
    } catch (err) {
      rewriteError = `dist/${entry}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (rewriteError !== null) {
    process.stderr.write(
      `build-publish: REFUSING — the published barrel could not be derived.\n  ${rewriteError}\n` +
        'If `src/index.ts` no longer re-exports the pricing module, delete this step; if it\n' +
        're-exports it more than once, say it once.\n',
    );
    return 1;
  }

  const dangling = [...published].filter(([, text]) => text.includes(WITHHELD_MODULE));
  if (dangling.length > 0) {
    process.stderr.write(
      `build-publish: REFUSING — ${dangling.map(([f]) => f).join(', ')} still reference ` +
        `${WITHHELD_MODULE}, which does not ship.\n`,
    );
    return 1;
  }

  const leaking = [];
  for (const [file, text] of published) {
    for (const hit of creditsMentions(text)) leaking.push(`${file}:${hit.line}  ${hit.text}`);
  }
  if (leaking.length > 0) {
    process.stderr.write(
      'build-publish: REFUSING — the unreleased credits feature is still named in text that\n' +
        'ships. Customer-facing text says what the product does, never how it is built.\n' +
        `${leaking.map((l) => `  ${l}`).join('\n')}\n` +
        'Rewrite or withhold each of these, then run this again.\n',
    );
    return 1;
  }

  for (const entry of ['index.js', 'index.d.ts']) {
    writeFileSync(join(dist, entry), published.get(`dist/${entry}`) ?? '');
  }
  const removed = [...withheld].sort();
  for (const shipped of removed) rmSync(join(pkgDir, shipped));

  process.stdout.write(
    `build-publish: dist is in PUBLISH shape. Removed ${removed.length} file(s): ${removed.join(', ')}.\n` +
      'Run `npm run build -w packages/api-types` afterwards to restore the workspace shape.\n',
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
