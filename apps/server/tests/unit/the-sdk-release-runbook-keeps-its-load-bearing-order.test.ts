// The SDK release runbook keeps its load-bearing order.
//
// `docs/runbooks/sdk-release.md` is read once, under time pressure, by someone
// about to spend three version numbers that cannot be spent twice. Most of it
// is explanation and may be rewritten freely. Four claims may not drift,
// because each one was earned:
//
//   1. @driftstack/api-types publishes BEFORE the SDK — now for its OWN direct
//      consumers, because the SDK stopped depending on it. Measured 2026-09-20,
//      twice: the 0.2.0 tarball installed into an empty project threw on
//      `import` (npm resolved the api-types already on the registry, which
//      lacks names the SDK re-exported) and on `require`
//      (ERR_PACKAGE_PATH_NOT_EXPORTED — api-types is ESM-only). Both are closed
//      by bundling api-types into the SDK and inlining its declarations, so the
//      runbook has to keep saying which problem the ordering still solves and
//      which one it no longer does. A reader who thinks the SDK still resolves
//      api-types will publish in the wrong order for the wrong reason.
//   2. Tokens are passed, never written. npm's by flag, twine's from the
//      environment with the literal username __token__ — never a file in the
//      repo, which is how a token reaches a commit.
//   3. The Go tag is ANNOTATED, carries the `packages/sdk-go/` prefix, names
//      the CI-green sha, and is pushed with --no-verify.
//   4. Nothing published can be replaced. Fix forward.
//
// Claim 3 has a half that is a statement about ANOTHER file: the runbook says
// the pre-push annotated-tag guard does not cover this tag's prefix, and that
// is only true while `.husky/pre-push` keeps matching `gui-v*` and `server-v*`
// alone. So this guard READS THE HOOK rather than trusting the sentence. If
// someone extends the hook to cover `packages/sdk-go/v*` — a good change — this
// goes red and the runbook paragraph gets corrected instead of quietly becoming
// false. `tagPrefixesGuardedBy` is that check, and the last describe runs it
// over hook texts written to fail it and one written to pass.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const RUNBOOK = resolve(REPO_ROOT, 'docs/runbooks/sdk-release.md');
const PRE_PUSH = resolve(REPO_ROOT, '.husky/pre-push');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/**
 * The `refs/tags/…` patterns a pre-push hook's tag `case` inspects. Returns an
 * empty array when the hook has no such `case` at all, which callers must treat
 * as "the claim can no longer be checked" rather than as "nothing is guarded".
 */
function tagPrefixesGuardedBy(hook: string): string[] {
  const line = /^\s*(refs\/tags\/\S*(?:\|refs\/tags\/\S*)*)\)\s*;;\s*$/m.exec(hook);
  if (line === null) return [];
  return line[1]!.split('|').map((p) => p.trim());
}

describe('the SDK release runbook keeps its load-bearing order', () => {
  it('the runbook exists at the canonical path and the runbooks index links it', () => {
    expect(existsSync(RUNBOOK)).toBe(true);
    expect(read(resolve(REPO_ROOT, 'docs/runbooks/README.md'))).toContain(
      '[`sdk-release.md`](sdk-release.md)',
    );
  });

  // ⛔ THE INDEX ROW IS A SECOND DOCUMENT, AND IT CONTRADICTED THIS ONE. When
  // the SDK became hermetic, the runbook's own section was rewritten to say the
  // ordering "no longer protects the SDK" — and the row in docs/runbooks/README.md
  // still read "api-types publishes first OR THE NPM PACKAGE THROWS ON IMPORT".
  // The index is the sentence an operator reads while deciding whether this
  // runbook is the one they need, so it is the sentence that sets their
  // expectation before step 6 ever tells them otherwise. Nothing read both.
  it('CRITICAL the runbooks-index row does not restate the ordering as an SDK-install requirement — the runbook it points at says that stopped being true', () => {
    const row = read(resolve(REPO_ROOT, 'docs/runbooks/README.md'))
      .split('\n')
      .find((l) => l.includes('[`sdk-release.md`](sdk-release.md)'));
    expect(row, 'the sdk-release row is gone from the index').toBeDefined();
    expect(
      row,
      'the index row ties an SDK install to the api-types publish order; the SDK bundles ' +
        'api-types and a consumer never resolves it (see "Why api-types goes first")',
    ).not.toMatch(
      /api-types publishes first or[^|]*\b(npm package|sdk)\b[^|]*\b(throw|break|fail)/iu,
    );

    // And the runbook's own answer is still the one the row has to agree with,
    // so this arm fails if the PRODUCT changes back rather than only the prose.
    expect(
      read(RUNBOOK),
      'the runbook no longer says the ordering stopped protecting the SDK — if the SDK went ' +
        'back to resolving api-types at runtime, the index row above is right and this arm is wrong',
    ).toMatch(/it no longer protects the SDK/u);
  });

  it('CRITICAL the twelve numbered steps stay in order: decide, bump, changelog, commit, gate+push, CI green, api-types, npm, PyPI, Go tag, verify, release note', () => {
    const body = read(RUNBOOK);
    const order = [
      '# 0. DECIDE THE VERSIONS',
      '# 1. Bump every place the version lives',
      '# 2. CHANGELOG',
      '# 3. Commit the bump ON ITS OWN, on main',
      '# 4. Gate, then push',
      '# 5. WAIT FOR CI GREEN',
      '# 6. PUBLISH @driftstack/api-types FIRST',
      '# 7. TypeScript',
      '# 8. Python',
      '# 9. Go',
      '# 10. VERIFY FROM THE REGISTRIES',
      '# 11. Write the GitHub release note',
    ];
    let cursor = -1;
    for (const step of order) {
      const at = body.indexOf(step);
      expect(at, `the runbook no longer carries the step "${step}"`).toBeGreaterThan(-1);
      expect(at, `"${step}" moved above the step before it`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('CRITICAL api-types publishes before the SDK, and the runbook keeps BOTH measurements that say why — the import failure and the require failure — plus what the ordering does and does not protect now that the SDK bundles it', () => {
    const body = read(RUNBOOK);

    expect(body).toMatch(/## ⛔ Why api-types goes first/);
    // Measurement 1 — the stale api-types on the registry, seen on `import`.
    expect(body).toContain('does not provide an\nexport named');
    expect(body).toMatch(/dead on arrival for every customer/);
    // Measurement 2 — the ESM-only exports map, seen on `require`. Added
    // 2026-09-20: this one broke every CommonJS consumer and no guard, no CI
    // step and no lane had ever loaded dist/index.cjs.
    expect(body).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(
      body,
      'the runbook no longer says why giving api-types a require entry is not the fix',
    ).toMatch(/throws ERR_REQUIRE_ESM on the Node 18 and\n20 the SDK still supports/);
    // What the ordering protects NOW. A reader who thinks the SDK still
    // resolves api-types draws the wrong conclusion from the same rule.
    expect(body).toMatch(/Publish api-types before the SDK whenever its surface has moved/);
    expect(body).toMatch(/for\n {3}the people who install `@driftstack\/api-types` DIRECTLY/);
    expect(body, 'the runbook no longer records that the SDK is hermetic').toMatch(
      /\*\*Both are closed the same way: the SDK is hermetic\.\*\*/,
    );
    expect(body).toMatch(/A customer resolves `zod` and nothing else\./);
    expect(
      body,
      'the sideEffects lever is not recorded, and removing it publishes a feature',
    ).toMatch(/`sideEffects: false` on api-types is load-bearing for the SDK's tarball/);
    expect(body).toMatch(
      /A\nworkspace build proves nothing here, because the workspace is exactly where the\nstale dependency is invisible, and loading one module format proves nothing\nabout the other\./,
    );
  });

  it('CRITICAL the publish tokens are passed, never written: npm by flag, twine from the environment as __token__', () => {
    const body = read(RUNBOOK);

    expect(body).toContain('--//registry.npmjs.org/:_authToken="$NPM_TOKEN"');
    expect(body).toContain('TWINE_USERNAME=__token__ TWINE_PASSWORD="$PYPI_TOKEN"');
    expect(body).toMatch(/never into a file in the\n# {4}repo/);
    expect(body).toMatch(/never from a \.pypirc/);
  });

  it('CRITICAL the Go tag is annotated, prefixed, on the CI-green sha, and pushed with --no-verify for a stated reason', () => {
    const body = read(RUNBOOK);

    expect(body).toContain('git tag -a packages/sdk-go/v0.3.0 <ci-green-sha>');
    expect(body).toContain('git push --no-verify origin packages/sdk-go/v0.3.0');
    expect(body).toMatch(/it runs against the WORKING TREE/);
    expect(body).toMatch(/not the commit the tag points at/);
    expect(body).toContain("--format='%(objecttype)'");
    expect(body).toMatch(/A tag without the prefix publishes nothing and burns the version\./);
  });

  it('CRITICAL the claim that the pre-push tag guard does not cover this prefix is TRUE OF THE HOOK, not merely written down', () => {
    const guarded = tagPrefixesGuardedBy(read(PRE_PUSH));

    expect(
      guarded.length,
      '.husky/pre-push no longer has a refs/tags case this guard can read — the runbook paragraph about it cannot be checked, so re-derive it rather than leaving the sentence standing',
    ).toBeGreaterThan(0);
    expect(
      guarded.some((p) => p.startsWith('refs/tags/packages/sdk-go/')),
      `the hook now inspects the Go SDK tag prefix (${guarded.join(', ')}). That is an improvement — update the runbook's "--no-verify also skips the annotated-tag guard" paragraph, which is now false, and then update this guard.`,
    ).toBe(false);
    expect(read(RUNBOOK)).toMatch(
      /The hook's tag check matches\n`refs\/tags\/gui-v\*` and `refs\/tags\/server-v\*` only/,
    );
  });

  it('CRITICAL the permanence table and fix-forward rule survive — there is no command that recovers a bad publish', () => {
    const body = read(RUNBOOK);

    expect(body).toMatch(/## ⛔ What cannot be undone/);
    for (const registry of ['npm', 'PyPI', 'Go proxy']) {
      expect(body, `the permanence table no longer covers ${registry}`).toContain(`| ${registry}`);
    }
    expect(body).toMatch(/\*\*Fix forward, always\.\*\*/);
    expect(body).toMatch(
      /the file list is checked with `--dry-run` \/\n`twine check` BEFORE the upload/,
    );
  });

  it('CRITICAL verification is from the registries and ends by running the guide’s programs from the INSTALLED packages', () => {
    const body = read(RUNBOOK);

    expect(body).toMatch(/## Verify — from the registries, not from the tree/);
    expect(body).toContain('npm view @driftstack/sdk version');
    expect(body).toContain('pip index versions driftstack-sdk');
    expect(body).toContain('proxy.golang.org');
    expect(body).toMatch(/run the guide's programs\nfrom the INSTALLED packages/);
    expect(body).toMatch(/with NO `replace` directive/);
    // Both TypeScript entry points, from the installed package, on every Node
    // major `engines` claims. Loading only the ESM build is what let a broken
    // CJS entry through the whole 0.2.0 preparation.
    expect(body, 'Verify no longer loads BOTH entry points').toMatch(
      /BOTH TypeScript entry points load from the INSTALLED package/,
    );
    expect(body).toContain(`require('@driftstack/sdk'); console.log('cjs ok')`);
    expect(body).toMatch(
      /If\n# {4}@driftstack\/api-types is in there, the SDK stopped bundling it\./,
    );
    expect(body).toMatch(
      /A program that needs an edit to run is a documentation defect, and the guide is\nwhat gets fixed\./,
    );
  });

  it('CRITICAL the release note carries the install line at this version, the migration when something broke, and what is NOT in the release', () => {
    const body = read(RUNBOOK);

    expect(body).toMatch(/## The release note/);
    expect(body).toMatch(/\*\*The install line, at this version\.\*\*/);
    expect(body).toMatch(/\*\*The migration, if anything broke\.\*\*/);
    expect(body).toMatch(/\*\*What is NOT in this release\.\*\*/);
    expect(body).toMatch(/internal identifiers, ticket numbers, and how the service is\nbuilt/);
  });

  it('the runbook itself carries no credential — only the names of the variables that hold one', () => {
    const body = read(RUNBOOK);
    const secretShaped =
      /\b(npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9-]{20,})\b/g;
    expect([...body.matchAll(secretShaped)].map((m) => m[0])).toEqual([]);
  });

  // ─── Negative control ─────────────────────────────────────────
  //
  // `tagPrefixesGuardedBy` returning [] on a hook it cannot parse would make
  // the "not covered" assertion pass on every possible hook, including one
  // that covers the prefix. These run it over hooks built to exercise each
  // outcome, so a green above means it discriminates.

  describe('the hook reader itself: it finds the prefixes, and says so when it cannot', () => {
    const REAL_SHAPE = [
      'while read -r _local_ref local_sha remote_ref _remote_sha; do',
      '  case "$remote_ref" in',
      '    refs/tags/gui-v*|refs/tags/server-v*) ;;',
      '    *) continue ;;',
      '  esac',
      'done',
    ].join('\n');

    it('the prefixes a hook guards are read back exactly', () => {
      expect(tagPrefixesGuardedBy(REAL_SHAPE)).toEqual(['refs/tags/gui-v*', 'refs/tags/server-v*']);
    });

    it('a hook that DID cover the Go SDK prefix is reported as covering it', () => {
      const widened = REAL_SHAPE.replace(
        'refs/tags/gui-v*|refs/tags/server-v*',
        'refs/tags/gui-v*|refs/tags/server-v*|refs/tags/packages/sdk-go/v*',
      );
      const guarded = tagPrefixesGuardedBy(widened);
      expect(guarded).toContain('refs/tags/packages/sdk-go/v*');
      expect(guarded.some((p) => p.startsWith('refs/tags/packages/sdk-go/'))).toBe(true);
    });

    it('a hook with no tag case at all reads as UNCHECKABLE (empty), not as "nothing is guarded"', () => {
      expect(tagPrefixesGuardedBy('#!/bin/sh\nnpm run typecheck\n')).toEqual([]);
    });
  });
});
