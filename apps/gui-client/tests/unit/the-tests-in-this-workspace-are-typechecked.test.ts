import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * W-12 — until this landed, `apps/gui-client`'s ~250 test files were typechecked
 * by NOTHING.
 *
 * `tsconfig.json` is `include: ["src", "vite.config.ts"]` and the workspace
 * `typecheck` script is a bare `tsc --noEmit`, so every "tsc clean" reported
 * while writing a test here was true of `src` and silent about the test itself.
 * Twelve of the fourteen workspaces are in that position; only `apps/server`
 * (via its own `tsconfig.test.json`) and `packages/sdk-typescript` are not.
 *
 * ⛔ It is not theoretical. A hand-written `ProxyTestResult` fixture omitted the
 * required `can_route`; `isProxyUsable` is `reachable && auth_ok && can_route`,
 * so the fixture named "healthy proxy" was silently exercising the UNHEALTHY
 * path. Two failing assertions were the only reason it surfaced, and they only
 * failed because the code under test happened to read that field.
 *
 * ⚠️ Type-aware LINT already saw these files (`tsconfig.eslint.json` includes
 * them), so they were never invisible to the type system. What no configuration
 * did was run `tsc --noEmit` over them — which is the check that reports a
 * missing required property in an object literal. That distinction is the whole
 * gap.
 */

describe('gui-client test files are typechecked', () => {
  const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

  it('CRITICAL a tsconfig exists that actually includes tests. Without it the workspace typecheck reports clean while every fixture in ~250 files goes unchecked, and a fixture missing a required field silently tests the opposite path.', () => {
    const cfg = read('apps/gui-client/tsconfig.test.json');
    // Deliberately a source-text assertion rather than a JSON parse: the file
    // carries explanatory comments, and hand-rolling a comment stripper to
    // parse it is the thing `no-guard-strips-comments-by-hand` forbids — with
    // good reason, since a private stripper gets string or regex literals wrong
    // and then silently scans a blanked file.
    expect(cfg, 'tsconfig.test.json must include the tests directory').toMatch(
      /"include":\s*\[[^\]]*"tests"/,
    );
    expect(cfg, 'it must extend the workspace config so it inherits strictness').toMatch(
      /"extends":\s*"\.\/tsconfig\.json"/,
    );
  });

  it('CRITICAL the backlog ratchet is actually RUN. A pinned number that nothing executes is a comment, and this one guards ~250 previously-unchecked files.', () => {
    // ⛔ The ratchet lives in a script on pre-push, NOT in this suite: it spawns
    // a full compiler, and doing that inside the runner blew its own timeout at
    // 10s, then — given a longer budget — held the CPU long enough to fail a
    // NEIGHBOURING guard and took suite duration from 254s to 507s. What is
    // checked here is the cheap half: that the wiring exists.
    expect(read('.husky/pre-push'), 'pre-push must run the backlog ratchet').toContain(
      'node scripts/typecheck-test-backlog.mjs',
    );
    const script = read('scripts/typecheck-test-backlog.mjs');
    expect(script, 'the ratchet must cover this workspace').toContain(
      'apps/gui-client/tsconfig.test.json',
    );
    // Two-sided: a one-sided `<=` lets the pin drift above reality forever.
    expect(script, 'it must fail when errors FALL, not only when they rise').toContain(
      'type errors fell to',
    );
  });
});
