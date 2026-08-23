// W722 — Husky pre-push gate + install-git-hooks installer parity.
// Forty-ninth in the cross-SDK drift-guard series (W649 + W675-
// W722).
//
// Pins THREE files governing the local verify gate + hook installer:
//
//   .husky/pre-push — V-223 pre-push gate (runs typecheck + lint +
//     format-check + tests + V-231 migration-journal-sync backstop).
//
//   .husky/pre-commit — lint-staged per-file gate (faster, narrower
//     than pre-push).
//
//   scripts/install-git-hooks.sh — V-527 installer that copies
//     canonical hooks from scripts/git-hooks/ into the per-clone
//     .git/hooks/ directory.
//
// CRITICAL invariants:
//   1. pre-push uses `set -e` — any failed step aborts the push.
//   2. V-231 migration-journal-sync is the FIRST step (cheap +
//      catches a class of regressions before the expensive
//      typecheck/lint/test chain runs).
//   3. 4-step verify chain in order: typecheck → lint → format-check
//      → tests. Drift to reordering could let typecheck regressions
//      slip if lint comes first and exits early.
//   4. install-git-hooks.sh uses `set -euo pipefail` strict-mode.
//   5. Installer is idempotent (`cp` overwrites; per the canonical-
//      source pattern from W721 V-527).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PRE_PUSH = resolve(REPO_ROOT, '.husky/pre-push');
const PRE_COMMIT = resolve(REPO_ROOT, '.husky/pre-commit');
const INSTALLER = resolve(REPO_ROOT, 'scripts/install-git-hooks.sh');

describe('W722 Husky pre-push gate + installer parity', () => {
  it('all 3 hook files exist at canonical paths', () => {
    expect(existsSync(PRE_PUSH), `missing ${PRE_PUSH}`).toBe(true);
    expect(existsSync(PRE_COMMIT), `missing ${PRE_COMMIT}`).toBe(true);
    expect(existsSync(INSTALLER), `missing ${INSTALLER}`).toBe(true);
  });

  // --- pre-push gate -----------------------------------------------

  it('CRITICAL pre-push V-223 anchor pinned. The V-223 changelog anchor threads the pre-push gate provenance (catches typecheck/test regressions that lint-staged misses).', () => {
    const p = read(PRE_PUSH);
    expect(p).toMatch(/V-223 — pre-push gate/);
    expect(p).toMatch(
      /Catches the class of regression where a\s*\n?\s*#\s*previous commit pushed broken/,
    );
  });

  it('CRITICAL pre-push strict-error mode pinned — `set -e`. Drift to dropping would let any failing step pass through (typecheck failure would not abort).', () => {
    const p = read(PRE_PUSH);
    expect(p).toMatch(/^set -e$/m);
  });

  it("CRITICAL pre-push shebang pinned — `#!/usr/bin/env sh` (POSIX shell, NOT bash). The POSIX-sh shebang is what Husky executes; drift to /bin/bash would break on systems where bash isn't at that path.", () => {
    const p = read(PRE_PUSH);
    expect(p).toMatch(/^#!\/usr\/bin\/env sh/);
  });

  it('CRITICAL V-231 migration-journal-sync backstop is the FIRST verify step pinned. The cheap journal check runs BEFORE the expensive typecheck/test chain — drift to moving it later would waste minutes when migrations are misaligned.', () => {
    const p = read(PRE_PUSH);
    expect(p).toMatch(/V-231 — every new SQL migration MUST have a matching journal entry/);
    expect(p).toMatch(/echo "→ migration journal sync \(V-228 backstop\)"/);

    // Migration loop body.
    expect(p).toMatch(/journal="apps\/server\/src\/db\/migrations\/meta\/_journal\.json"/);
    expect(p).toMatch(/for sql in apps\/server\/src\/db\/migrations\/\*\.sql; do/);
    expect(p).toMatch(/tag=\$\(basename "\$sql" \.sql\)/);
    expect(p).toMatch(/if ! grep -q "\\"tag\\": \\"\$tag\\"" "\$journal"; then/);
    expect(p).toMatch(/exit 1/);
  });

  it('CRITICAL pre-push 4-step verify chain pinned in order: typecheck → lint → format-check → tests. The order is what catches typecheck regressions first (cheapest of the expensive steps); drift to reordering would change which step exits-on-failure first.', () => {
    const p = read(PRE_PUSH);

    // Verify ordering by find-position of each echo.
    const stepEchos = [
      'echo "→ typecheck (workspaces, including tsconfig.test.json)"',
      'echo "→ lint"',
      'echo "→ format check"',
      'echo "→ tests"',
    ];

    let lastIndex = -1;
    for (const e of stepEchos) {
      const idx = p.indexOf(e);
      expect(idx, `step ${e}`).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('CRITICAL pre-push step commands pinned — npm run typecheck, npm run lint, npm run format:check, npm test. Drift to invoking a different runner (pnpm/yarn) would break the gate on machines without that runner.', () => {
    const p = read(PRE_PUSH);
    expect(p).toMatch(/npm run typecheck/);
    expect(p).toMatch(/npm run lint/);
    expect(p).toMatch(/npm run format:check/);
    expect(p).toMatch(/^npm test$/m);
  });

  it('CRITICAL final success line pinned — `✓ pre-push gate clean`. The success marker is what tells engineers all 4+ steps passed; the absence of this line in CI output signals a gate failure.', () => {
    const p = read(PRE_PUSH);
    expect(p).toMatch(/echo "✓ pre-push gate clean"/);
  });

  it("CRITICAL emergency-skip framing pinned — `Skip in emergencies via git push --no-verify. Don't make a habit.` The framing tells engineers the bypass exists but cautions against routine use.", () => {
    const p = read(PRE_PUSH);
    expect(p).toMatch(/Skip in emergencies via `git push --no-verify`\. Don't make a habit\./);
  });

  // --- pre-commit gate ---------------------------------------------

  it('CRITICAL pre-commit invokes `npx lint-staged`. The lint-staged runner is what scopes lint+format to staged files (fast feedback loop); drift to `npm test` would make pre-commit slow and noisy.', () => {
    const p = read(PRE_COMMIT);
    expect(p).toMatch(/^npx lint-staged$/m);
    // Still NOT the whole suite — the point of this hook is a fast loop.
    expect(p).not.toMatch(/npm (run )?test/);
  });

  it("CRITICAL pre-commit also typechecks the staged workspaces. lint-staged runs eslint + prettier, and neither typechecks; vitest does not either. So a type error committed cleanly and only failed the PRE-PUSH gate — which tests the WORKING TREE, meaning one agent's type error rejected every other agent's push until someone repaired it. Twice on 2026-08-23.", () => {
    const p = read(PRE_COMMIT);
    expect(p).toMatch(/tsc --noEmit -p/);
    // Scoped to the affected workspaces, not the whole monorepo: a
    // one-workspace commit must not pay for all of them.
    expect(p).toMatch(/--diff-filter=ACM/);
    expect(p).toMatch(/cut -d\/ -f1,2/);
    // NOT sed: BSD sed has no \(a\|b\) alternation, so the obvious one-liner
    // matched nothing and the loop ran zero times — a hook that passed by
    // checking nothing. Caught only by deliberately committing a type error.
    expect(p).not.toMatch(/sed -n 's#\^/);
  });

  // --- install-git-hooks.sh installer ------------------------------

  it('CRITICAL installer V-527 anchor pinned. The anchor threads the canonical-hook-installer provenance (same V-527 as W721 commit-msg classifier).', () => {
    const i = read(INSTALLER);
    expect(i).toMatch(/V-527 — install git hooks from canonical source/);
  });

  it('CRITICAL installer strict-mode pinned — `set -euo pipefail`. Drift to dropping would let undefined-var errors or pipe-failures pass through, weakening the install reliability.', () => {
    const i = read(INSTALLER);
    expect(i).toMatch(/set -euo pipefail/);
  });

  it('CRITICAL installer SRC + DST path resolution pinned — `$REPO_ROOT/scripts/git-hooks` → `$REPO_ROOT/.git/hooks`. The src + dst pair is what threads the per-clone install. Drift would let the installer copy to the wrong dir or from the wrong source.', () => {
    const i = read(INSTALLER);
    expect(i).toMatch(/REPO_ROOT="\$\(git rev-parse --show-toplevel\)"/);
    expect(i).toMatch(/SRC="\$REPO_ROOT\/scripts\/git-hooks"/);
    expect(i).toMatch(/DST="\$REPO_ROOT\/\.git\/hooks"/);
  });

  it('CRITICAL installer fail-loud-if-missing-dirs pinned. The SRC + DST existence checks emit a clear error before silently no-oping. Drift to skipping would let `bash install-git-hooks.sh` from outside a git clone silently fail.', () => {
    const i = read(INSTALLER);

    expect(i).toMatch(
      /if \[\[ ! -d "\$SRC" \]\]; then\s*\n?\s*echo "✗ source dir not found: \$SRC"/,
    );
    expect(i).toMatch(
      /if \[\[ ! -d "\$DST" \]\]; then\s*\n?\s*echo "✗ destination dir not found: \$DST \(run from a git clone\)"/,
    );
  });

  it('CRITICAL installer idempotent-overwrite pattern pinned — `cp "$HOOK" "$DST/$NAME"`. The cp-overwrite (not cp -i) is what makes the installer safe to re-run after every scripts/git-hooks/ change. Drift to mv or hardlink would change customer-side behavior.', () => {
    const i = read(INSTALLER);
    expect(i).toMatch(/cp "\$HOOK" "\$DST\/\$NAME"/);
    expect(i).toMatch(/chmod \+x "\$DST\/\$NAME"/);
    expect(i).toMatch(/Idempotent: overwrites existing hooks of the same name/);
  });

  it('CRITICAL installer shopt nullglob pinned. Without nullglob, an empty scripts/git-hooks/ dir would expand the for-loop pattern as the literal string `$SRC/*` (and try to cp a non-existent file). Drift to dropping would let the installer crash on empty src.', () => {
    const i = read(INSTALLER);
    expect(i).toMatch(/shopt -s nullglob/);
    expect(i).toMatch(/INSTALLED=0/);
    expect(i).toMatch(/for HOOK in "\$SRC"\/\*; do/);
  });

  it('CRITICAL installer success/empty-source diagnostics pinned. The 2-branch tail (INSTALLED > 0 vs INSTALLED == 0) is what tells the operator whether the install actually did anything — drift to a single message would silently let an empty src dir look successful.', () => {
    const i = read(INSTALLER);

    expect(i).toMatch(/echo "✓ installed: \$NAME"/);
    expect(i).toMatch(/INSTALLED=\$\(\(INSTALLED \+ 1\)\)/);
    expect(i).toMatch(
      /if \[\[ \$INSTALLED -eq 0 \]\]; then\s*\n?\s*echo "\(no hooks found in \$SRC\)"/,
    );
    expect(i).toMatch(/echo "✓ \$INSTALLED hook\(s\) installed into \$DST"/);
  });

  it('CRITICAL pre-commit/pre-push are sibling Husky shell-script hooks (.husky/ tree). Drift to JS-based hook config (lefthook YAML, simple-git-hooks) would break the contract these tests verify.', () => {
    const preCommit = read(PRE_COMMIT);
    const prePush = read(PRE_PUSH);

    // pre-commit gained a scoped typecheck (2026-08-23), so it is no longer a
    // one-liner — but it must stay far smaller than the full pre-push gate.
    expect(preCommit.split('\n').length).toBeLessThanOrEqual(40);
    expect(prePush.split('\n').length).toBeGreaterThanOrEqual(20);
  });

  it('Pre-push gate 6-invariant cluster — V-223 anchor + set -e + V-231 migration-journal first step + 4-step verify chain (typecheck → lint → format → tests) + success marker + emergency-skip framing.', () => {
    const p = read(PRE_PUSH);

    expect(p).toMatch(/V-223/);
    expect(p).toMatch(/V-231/);
    expect(p).toMatch(/V-228 backstop/);
    expect(p).toMatch(/^set -e$/m);
    expect(p).toMatch(/migration journal sync/);
    expect(p).toMatch(/npm run typecheck/);
    expect(p).toMatch(/npm run lint/);
    expect(p).toMatch(/npm run format:check/);
    expect(p).toMatch(/npm test/);
    expect(p).toMatch(/✓ pre-push gate clean/);
    expect(p).toMatch(/git push --no-verify/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/husky-prepush-hooks-parity.test.ts')),
    ).toBe(true);
  });
});
