// The published `@driftstack/api-types` ships hover docs and no internal notes.
//
// Two different comments live in `packages/api-types/src`, and they have
// different audiences:
//
//   A JSDoc block on an exported declaration is CUSTOMER TEXT. tsc copies it
//   into `dist/*.d.ts`, and that is literally what an editor shows on hover, so
//   it has to say what the field means and what to do about it.
//
//   Everything else — the file headers, the `//` notes beside a regex, the
//   block comments recording why a bound is what it is — is ENGINEERING TEXT.
//   It belongs in the repository. It does not belong in a customer's
//   `node_modules`, and by default tsc copied every word of it into
//   `dist/*.js`: 607 of the 933 internal findings this package carried were
//   there, not in the `.d.ts`.
//
// ⛔ `removeComments` ALONE IS THE WRONG TOOL, AND IT LOOKS RIGHT. Measured
// 2026-09-20: `tsc --removeComments` strips the `.d.ts` too, so the hover docs
// vanish with the internal notes and the scanner reports a clean package.
// That is the failure that reads as success — the count goes to zero because
// the text is gone, not because it was rewritten. So the build is TWO passes:
// `tsc --build` emits the declarations WITH their JSDoc, then
// `tsconfig.dist-js.json` re-emits the JavaScript with `removeComments` on.
//
// THE ORDER IS CHOSEN FOR ITS FAILURE DIRECTION. The comment-free pass is the
// SECOND one, so a build that runs only the first (a bare `tsc --build`, a
// project-reference build from `apps/server`) puts the engineering text back
// into `dist/*.js` — where the shipped-text scanner reports it, loudly. Had
// `removeComments` been the default with a docs pass second, the same mistake
// would silently ship a package with no documentation at all and every guard
// green.
//
// MEASURED, BECAUSE THE ORDER DEPENDS ON IT: CI runs `npm run build`, then
// `npm run typecheck`, then the suite — and both typecheck scripts are
// `tsc --build`, which EMITS. Checked 2026-09-20: after the two-pass build,
// `npm run typecheck -w packages/api-types` and `-w apps/server` both leave
// `dist/egress.js` at zero comments, because the incremental build sees outputs
// newer than their inputs and does nothing. That is a timestamp property, not a
// guarantee, so the second arm below is what actually holds it: a typecheck that
// did re-emit would put the comments back and this file would go red before
// anything was packed.
//
// This file asserts BOTH halves against the built artifact, plus the negative
// control that matters: the engineering text is still in `src/`. Deleting
// documentation would also make the JS clean, and these arms say that is not
// what happened.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PKG = resolve(REPO_ROOT, 'packages/api-types');
const SRC = resolve(PKG, 'src');
const DIST = resolve(PKG, 'dist');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** The emitted JavaScript, without the one comment the build is allowed to leave. */
function emittedJs(): { file: string; body: string }[] {
  return readdirSync(DIST)
    .filter((n) => n.endsWith('.js'))
    .sort()
    .map((file) => ({
      file,
      body: read(resolve(DIST, file)).replace(/^\/\/# sourceMappingURL=[^\n]*$/mu, ''),
    }));
}

describe('the published api-types ships hover docs and no internal notes', () => {
  it('CRITICAL the build is two passes, and the second one is the comment-free JS pass', () => {
    const cfgPath = resolve(PKG, 'tsconfig.dist-js.json');
    expect(existsSync(cfgPath), 'tsconfig.dist-js.json is missing').toBe(true);
    const cfg = JSON.parse(read(cfgPath)) as {
      extends: string;
      compilerOptions: Record<string, unknown>;
    };
    // It EXTENDS the build config rather than restating it, so target, module
    // and rootDir/outDir cannot drift between the two emitted halves.
    expect(cfg.extends).toBe('./tsconfig.json');
    expect(cfg.compilerOptions.removeComments).toBe(true);
    // Declarations are NOT re-emitted here. If they were, this pass would
    // overwrite the documented `.d.ts` with a comment-free one and the hover
    // docs would be gone — the exact failure the two-pass shape exists to avoid.
    expect(cfg.compilerOptions.declaration).toBe(false);
    expect(cfg.compilerOptions.declarationMap).toBe(false);
    expect(cfg.compilerOptions.composite).toBe(false);
    expect(cfg.compilerOptions.incremental).toBe(false);
  });

  it('CRITICAL the emitted JavaScript carries no comment at all', () => {
    const files = emittedJs();
    expect(files.length, 'dist holds no JavaScript — it was never built').toBeGreaterThan(20);
    const withComments: string[] = [];
    for (const { file, body } of files) {
      // `codeOnly` blanks comments and keeps everything else, and it models
      // strings and regex literals — so `'https://…'` is not read as a comment
      // and a `/*` inside one does not swallow the rest of the file.
      if (codeOnly(body) !== body) withComments.push(file);
    }
    expect(withComments, 'these emitted files still carry comments').toEqual([]);
  });

  it('CRITICAL the emitted declarations DO carry their hover docs — a clean scan must not mean an empty one', () => {
    const files = readdirSync(DIST).filter((n) => n.endsWith('.d.ts'));
    expect(files.length, 'dist holds no declarations — it was never built').toBeGreaterThan(20);
    const documented = files.filter((f) => read(resolve(DIST, f)).includes('/**'));
    // Most of this package is documented; a handful of small modules are not.
    expect(documented.length).toBeGreaterThan(15);

    // Named, so "some file somewhere has a `/**`" cannot satisfy this.
    const common = read(resolve(DIST, 'common.d.ts'));
    expect(common).toMatch(/How many sessions each plan may run at once/u);
    expect(common).toMatch(/concurrency_limit_exceeded` \(HTTP 429\)/u);
    const egress = read(resolve(DIST, 'egress.d.ts'));
    expect(egress).toMatch(/Resolve host names through the proxy instead of locally/u);
    const sessions = read(resolve(DIST, 'sessions.d.ts'));
    expect(sessions).toMatch(/Start the session from a saved profile/u);
  });

  it('CRITICAL the engineering notes are still in the SOURCE — the JS is clean because of the build, not because documentation was deleted', () => {
    // Each of these is a block that was demoted out of the `.d.ts` rather than
    // removed. If a future edit deletes one instead of demoting it, that is a
    // loss of repository knowledge and this arm is where it shows up.
    expect(read(resolve(SRC, 'common.ts'))).toMatch(
      /CHROME-ON-iOS ARCHETYPES ARE HELD OUT of this registry/u,
    );
    expect(read(resolve(SRC, 'common.ts'))).toMatch(/per-tier rate-limit defaults/u);
    expect(read(resolve(SRC, 'egress.ts'))).toMatch(
      /Source of truth: planning doc 133 \(egress architecture\) in the/u,
    );
    expect(read(resolve(SRC, 'openvpn-directives.ts'))).toMatch(
      /Lower `script-security 2\|3` to 1, and touch NOTHING else\./u,
    );
    expect(read(resolve(SRC, 'accounts.ts'))).toMatch(/R2 public-snapshot bucket/u);

    // And the negative control for the arm above: those same sentences are NOT
    // in the emitted JavaScript. Without this, "src still has it" and "dist is
    // clean" could both be true of a build that emitted nothing.
    const js = emittedJs()
      .map(({ body }) => body)
      .join('\n');
    expect(js).not.toMatch(/CHROME-ON-iOS/u);
    expect(js).not.toMatch(/docs\/planning\/133-egress-architecture-cross-agent/u);
    expect(js).not.toMatch(/R2 public-snapshot bucket/u);
  });

  it('CRITICAL a demoted block really is out of the declarations, and its replacement really is in them', () => {
    const accounts = read(resolve(DIST, 'accounts.d.ts'));
    expect(accounts).not.toMatch(/R2 public-snapshot bucket/u);
    expect(accounts).toMatch(/The largest avatar you can upload: 2 MiB of raw image bytes/u);
    const common = read(resolve(DIST, 'common.d.ts'));
    expect(common).not.toMatch(/CHROME-ON-iOS/u);
    expect(common).toMatch(/Every device this platform models/u);
  });
});
