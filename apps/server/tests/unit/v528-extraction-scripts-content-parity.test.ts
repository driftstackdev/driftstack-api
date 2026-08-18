// W804 — V-525 / V-528 SDK-extraction scripts content parity. One-
// hundred-thirtieth in the drift-guard series. Pins the irreversible
// SDK-repo-privatization toolchain: V-525 extract-sdk-repos.sh +
// V-656 v528-prestage.sh + 3 per-SDK v528-adjust-*.sh + V-528 Step 5
// v528-scrub-violators.sh. Drift in any of these would either silently
// break the trigger window or rewrite history wrong.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const EXTRACT = resolve(REPO_ROOT, 'scripts/extract-sdk-repos.sh');
const PRESTAGE = resolve(REPO_ROOT, 'scripts/v528-prestage.sh');
const ADJ_TS = resolve(REPO_ROOT, 'scripts/v528-adjust-typescript.sh');
const ADJ_PY = resolve(REPO_ROOT, 'scripts/v528-adjust-python.sh');
const ADJ_GO = resolve(REPO_ROOT, 'scripts/v528-adjust-go.sh');
const SCRUB = resolve(REPO_ROOT, 'scripts/v528-scrub-violators.sh');

describe('W804 V-528 extraction scripts content parity', () => {
  it('all 6 V-528 / V-525 scripts exist at canonical paths', () => {
    for (const f of [EXTRACT, PRESTAGE, ADJ_TS, ADJ_PY, ADJ_GO, SCRUB]) {
      expect(existsSync(f)).toBe(true);
    }
  });

  it('CRITICAL all 6 scripts use bash shebang + set -euo pipefail. The irreversible nature of repo extraction + history rewrite means any silent error-swallowing would be catastrophic.', () => {
    for (const f of [EXTRACT, PRESTAGE, ADJ_TS, ADJ_PY, ADJ_GO, SCRUB]) {
      const p = read(f);
      expect(p.startsWith('#!/usr/bin/env bash\n')).toBe(true);
      expect(p).toMatch(/set -euo pipefail/);
    }
  });

  // ─── extract-sdk-repos.sh — V-525 ─────────────────────────────

  it('CRITICAL extract-sdk-repos.sh V-525 anchor + git-subtree-split + idempotent framing pinned. The "subtree split rewrites each packages/sdk-<lang>/ subtree into a branch where the SDK files sit at the branch root" is the load-bearing extraction-shape contract.', () => {
    const p = read(EXTRACT);
    expect(p).toMatch(/# V-525 — extract 3 SDK packages into standalone-repo-shaped branches\./);
    expect(p).toMatch(/Uses `git subtree split` to rewrite each `packages\/sdk-<lang>\/` subtree/);
    expect(p).toMatch(
      /Idempotent: re-running deletes existing extraction branches and re-splits\./,
    );
    expect(p).toMatch(/Safe: branches are local refs — never pushed by this script\./);
  });

  it('CRITICAL extract-sdk-repos.sh 3-SDK set pinned — typescript:packages/sdk-typescript + python:packages/sdk-python + go:packages/sdk-go. Each entry is "lang:prefix"; drift would either skip an SDK or extract from the wrong directory.', () => {
    const p = read(EXTRACT);
    expect(p).toMatch(
      /SDKS=\(\s*\n\s+"typescript:packages\/sdk-typescript"\s*\n\s+"python:packages\/sdk-python"\s*\n\s+"go:packages\/sdk-go"\s*\n\)/,
    );
  });

  it('CRITICAL extract-sdk-repos.sh V-205 violator-SHA awareness pinned — 63a20c1 + ef649a1 + V-368-force-push-scrub-gated-on-V-528-privatization warning. The warning is the load-bearing "history is intentionally not scrubbed yet" anchor.', () => {
    const p = read(EXTRACT);
    expect(p).toMatch(/V205_VIOLATORS=\(\s*\n\s+"63a20c1"\s*\n\s+"ef649a1"\s*\n\)/);
    expect(p).toMatch(/V-368 force-push scrub\s*\n# is gated on V-528 privatization/);
  });

  it("CRITICAL extract-sdk-repos.sh sdk-extract/<lang> branch-name convention pinned. Every output branch is sdk-extract/typescript|python|go — drift would break the v528-adjust-* scripts' branch-check guard.", () => {
    const p = read(EXTRACT);
    expect(p).toMatch(/BRANCH="sdk-extract\/\$\{LANG\}"/);
    expect(p).toMatch(/sdk-extract\/typescript/);
    expect(p).toMatch(/sdk-extract\/python/);
    expect(p).toMatch(/sdk-extract\/go/);
  });

  // ─── v528-prestage.sh — V-656 ─────────────────────────────────

  it('CRITICAL v528-prestage.sh V-656 anchor + "~2-3 hr → ~30 min" framing pinned. The runbook-time-savings claim is the load-bearing "why this script exists" anchor.', () => {
    const p = read(PRESTAGE);
    expect(p).toMatch(/# V-656 — V-528 pre-stage runner\./);
    expect(p).toMatch(/Drops the V-528 trigger from ~2-3 hr \(per the runbook\) to ~30 min/);
  });

  it("CRITICAL v528-prestage.sh 4-irreversible-founder-steps list pinned — Step 3 (gh repo create + push), Step 4 (gh repo edit --visibility private), Step 5 (V-205 scrub force-push), Step 7 (CI secrets + tag push). The numbered list is the canonical 'these stay manual' contract.", () => {
    const p = read(PRESTAGE);
    expect(p).toMatch(/Step 3 \(gh repo create \+ push\) — manual/);
    expect(p).toMatch(/Step 4 \(gh repo edit --visibility private\) — manual/);
    expect(p).toMatch(/Step 5 \(V-205 scrub force-push\) — via scripts\/v528-scrub-violators\.sh/);
    expect(p).toMatch(/Step 7 \(CI secrets \+ tag push\) — manual/);
  });

  it('CRITICAL v528-prestage.sh 9-section pre-flight set pinned — clean tree + on main + LICENSE present + gh auth + V-527 hook + SDK extraction branches + cleanup branch state + V-205 audit + per-SDK adjustment scripts. Drift to dropping any check would let trigger time creep back up.', () => {
    const p = read(PRESTAGE);
    expect(p).toMatch(/Pre-flight: clean working tree/);
    expect(p).toMatch(/Pre-flight: current branch/);
    expect(p).toMatch(/Pre-flight: LICENSE staging/);
    expect(p).toMatch(/Pre-flight: gh auth/);
    expect(p).toMatch(/Pre-flight: V-527 commit-msg hook/);
    expect(p).toMatch(/Pre-flight: SDK extraction branches/);
    expect(p).toMatch(/Pre-flight: cleanup\/v526-sanitize branch/);
    expect(p).toMatch(/Pre-flight: V-205 violator commit audit/);
    expect(p).toMatch(/Pre-flight: per-SDK adjustment scripts/);
  });

  it('CRITICAL v528-prestage.sh LICENSE → /tmp/driftstack-api-LICENSE staging convention pinned. The /tmp/ path is what every v528-adjust-*.sh script reads; drift to a different path would break all 3 adjustment scripts.', () => {
    const p = read(PRESTAGE);
    expect(p).toMatch(/cp LICENSE \/tmp\/driftstack-api-LICENSE/);
  });

  it('CRITICAL v528-prestage.sh --dry-run flag + idempotent framing pinned. The --dry-run flag exists for V-656 self-test; idempotency is the load-bearing safety property.', () => {
    const p = read(PRESTAGE);
    expect(p).toMatch(/# Usage:\s*\n#\s+scripts\/v528-prestage\.sh \[--dry-run\]/);
    expect(p).toMatch(
      /Idempotent — running twice produces the same output \(modulo timestamps\)\./,
    );
  });

  // ─── v528-adjust-{ts,py,go}.sh — V-656 ────────────────────────

  it("CRITICAL all 3 v528-adjust scripts pin EXPECTED_BRANCH = 'sdk-extract/<lang>' branch-check guard. Drift would let the script run on the WRONG branch and corrupt the parent repo.", () => {
    expect(read(ADJ_TS)).toMatch(/EXPECTED_BRANCH="sdk-extract\/typescript"/);
    expect(read(ADJ_PY)).toMatch(/EXPECTED_BRANCH="sdk-extract\/python"/);
    expect(read(ADJ_GO)).toMatch(/EXPECTED_BRANCH="sdk-extract\/go"/);

    for (const f of [ADJ_TS, ADJ_PY, ADJ_GO]) {
      expect(read(f)).toMatch(
        /if \[\[ "\$CURRENT_BRANCH" != "\$EXPECTED_BRANCH" \]\]; then\s*\n\s+printf 'ERROR: must run on %s; currently on %s\\n' "\$EXPECTED_BRANCH" "\$CURRENT_BRANCH" >&2\s*\n\s+exit 1/,
      );
    }
  });

  it("CRITICAL all 3 v528-adjust scripts read LICENSE from /tmp/driftstack-api-LICENSE + cp to ./LICENSE. The /tmp path matches v528-prestage.sh's stage; drift to a different path would break the prestage→adjust pipeline.", () => {
    for (const f of [ADJ_TS, ADJ_PY, ADJ_GO]) {
      const p = read(f);
      expect(p).toMatch(/if \[\[ ! -f \/tmp\/driftstack-api-LICENSE \]\]; then/);
      expect(p).toMatch(/Run scripts\/v528-prestage\.sh first/);
      expect(p).toMatch(/cp \/tmp\/driftstack-api-LICENSE LICENSE/);
    }
  });

  it("CRITICAL v528-adjust-typescript bundles api-types into src/_generated + rewrites import paths. The 'bundle types into dist' rationale + sed rewrite from '@driftstack/api-types' → './_generated/index.js' is the load-bearing self-contained-SDK contract.", () => {
    const p = read(ADJ_TS);
    expect(p).toMatch(/inline @driftstack\/api-types \(option \(a\) — bundle types into dist\)/);
    expect(p).toMatch(
      /rsync -a --delete "\$WORKTREE_DIR\/packages\/api-types\/src\/" src\/_generated\//,
    );
    expect(p).toMatch(
      /sed -i\.bak -E "s\|from '@driftstack\/api-types'\|from '\.\/_generated\/index\.js'\|g"/,
    );
    expect(p).toMatch(/delete pkg\.dependencies\['@driftstack\/api-types'\]/);
  });

  it('CRITICAL v528-adjust-typescript pkg.repository.url pinned to driftstack-typescript-sdk. The repo-URL rewrite is what makes the extracted branch publishable as a standalone npm package.', () => {
    const p = read(ADJ_TS);
    expect(p).toMatch(
      /url: 'git\+https:\/\/github\.com\/driftstackdev\/driftstack-typescript-sdk\.git'/,
    );
  });

  it('CRITICAL each v528-adjust script ends with OK + final commit-on-EXPECTED_BRANCH printf. Drift would lose the visible "I succeeded" signal.', () => {
    expect(read(ADJ_TS)).toMatch(/OK: .* adjustments applied/);
    expect(read(ADJ_PY)).toMatch(
      /printf 'OK: Python SDK adjustments applied \+ committed on %s\\n' "\$EXPECTED_BRANCH"/,
    );
    expect(read(ADJ_GO)).toMatch(
      /printf 'OK: Go SDK adjustments applied \+ committed on %s\\n' "\$EXPECTED_BRANCH"/,
    );
  });

  // ─── v528-scrub-violators.sh — V-205 + V-211 historical scrub ─

  it("CRITICAL scrub-violators.sh V-656 + 'V-528 Step 5: V-205 historical scrub via git-filter-repo' framing pinned. Drift to a different scrub mechanism (interactive rebase, sed-on-pack-files) would either lose idempotency or corrupt the repo.", () => {
    const p = read(SCRUB);
    expect(p).toMatch(/# V-656 — V-528 Step 5: V-205 historical scrub via git-filter-repo\./);
    expect(p).toMatch(
      /Run ONLY AFTER V-528 Steps 3 \+ 4 \(repo flipped private\)\. Rewrites\s*\n# history LOCALLY and prints the two force-push commands to run\s*\n# afterwards — it does NOT push\./,
    );
    // V-817 SENTINEL — the script rewrites locally and PRINTS the push
    // commands. Claiming it pushes invites the operator to tick the runbook
    // step off with the violator commits still live on the remote.
    expect(p, 'the script must not claim it pushes').not.toMatch(
      /private\)\. Force-pushes\s*\n# rewritten history/,
    );
  });

  it('CRITICAL scrub-violators.sh 2-violator-SHA list pinned — 63a20c1 (Postmark handoff, AI-vendor proper noun in 5 places) + ef649a1 (V-492/493/508 wave 9, LLM-vendor proper noun). Drift to a different SHA pair would scrub the wrong commits.', () => {
    const p = read(SCRUB);
    expect(p).toMatch(
      /63a20c1 "Handoff: Postmark approval requested \+ seamless-handoff bootstrap"/,
    );
    expect(p).toMatch(
      /ef649a1 "V-492 \/ V-493 \/ V-508: wave 9 — SDK coverage parity test \+ \.\.\."/,
    );
  });

  it("CRITICAL scrub-violators.sh V-205 AI-tooling 10-replacement set pinned. The replacements are ordered specific→general (Claude Code's auto-memory before Claude Code before Claude) so the more-specific patterns match first. Drift would either over-replace or under-replace.", () => {
    const p = read(SCRUB);
    expect(p).toMatch(/\("Claude Code's auto-memory", "the handoff-tooling auto-memory"\),/);
    expect(p).toMatch(/\("Claude Code", "the handoff tooling"\),/);
    expect(p).toMatch(/\("Claude accounts", "session accounts"\),/);
    expect(p).toMatch(/\("Claude session", "session"\),/);
    expect(p).toMatch(/\("the new Claude", "the new"\),/);
    expect(p).toMatch(/\("Claude", "the assistant"\),/);
    expect(p).toMatch(/\("Anthropic-only", "LLM-vendor-only"\),/);
    expect(p).toMatch(/\("Anthropic", "LLM-vendor"\),/);
    expect(p).toMatch(/\("\/\.claude\/projects\/", "\/\.handoff\/projects\/"\),/);
    expect(p).toMatch(/\("\.claude\/projects", "\.handoff\/projects"\),/);
  });

  it("CRITICAL scrub-violators.sh V-211 anonymity 6-replacement set pinned — covers both capitalized + lowercase 'founder' variants with 'Founder switching' / 'founder action' compound forms ordered first. Drift would re-introduce founder-name leaks in scrubbed history.", () => {
    const p = read(SCRUB);
    expect(p).toMatch(/\("Founder switching", "Team switching"\),/);
    expect(p).toMatch(/\("Founder ", "Team "\),/);
    expect(p).toMatch(/\("founder action", "team action"\),/);
    expect(p).toMatch(/\("founder ", "team "\),/);
    expect(p).toMatch(/\("Founder", "Team"\),/);
    expect(p).toMatch(/\("founder", "team"\),/);
  });

  it("CRITICAL scrub-violators.sh --confirm gate + 'scrub-violators' interactive confirmation + pre-scrub-backup-bundle pinned. The 3-layer safety (--confirm flag + interactive prompt + out-of-repo backup bundle) is the load-bearing destructive-action protection. The backup is a bundle (not an in-repo tag) because git-filter-repo remaps every reachable ref including tags, then gc's the originals away — an in-repo tag provides zero actual recovery once filter-repo runs.", () => {
    const p = read(SCRUB);
    expect(p).toMatch(/CONFIRM=0\s*\nif \[\[ \$\{1:-\} == "--confirm" \]\]; then/);
    expect(p).toMatch(/Type EXACTLY: scrub-violators/);
    expect(p).toMatch(
      /if \[\[ "\$REPLY" != "scrub-violators" \]\]; then\s*\n\s+printf 'Aborted\.\\n' >&2/,
    );
    expect(p).toMatch(/BACKUP_BUNDLE="\/tmp\/pre-v528-scrub-\$\(date \+%s\)\.bundle"/);
    expect(p).toMatch(/git bundle create "\$BACKUP_BUNDLE" --all/);
  });

  it('CRITICAL scrub-violators.sh git-filter-repo invocation pinned. The `--commit-callback "$(cat ...)" --force` pattern passes the Python callback as a string argument; drift would either lose --force (preventing rewrite) or break the callback delivery.', () => {
    const p = read(SCRUB);
    expect(p).toMatch(/git filter-repo --commit-callback "\$\(cat "\$CALLBACK_FILE"\)" --force/);
  });

  it('CRITICAL scrub-violators.sh pre-flight: dirty-tree refuse + not-on-main refuse + git-filter-repo-installed check pinned. Each refuses with non-zero exit before any destructive step.', () => {
    const p = read(SCRUB);
    expect(p).toMatch(/if ! command -v git-filter-repo >\/dev\/null 2>&1; then/);
    expect(p).toMatch(
      /if \[\[ -n \$\(git status --porcelain\) \]\]; then\s*\n\s+printf 'ERROR: working tree dirty/,
    );
    expect(p).toMatch(
      /if \[\[ "\$CURRENT_BRANCH" != "main" \]\]; then\s*\n\s+printf 'ERROR: must run on main/,
    );
  });

  it("CRITICAL scrub-violators.sh DRY-RUN-by-default + 'must re-run with --confirm AND only after V-528 Step 4 done' framing pinned. The dry-run default is the canonical 'this is destructive — make me ask twice' safety.", () => {
    const p = read(SCRUB);
    expect(p).toMatch(/printf '== DRY RUN — no history rewrite ==\\n'/);
    expect(p).toMatch(/To execute, re-run with --confirm AND only after V-528 Step 4 done\./);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/v528-extraction-scripts-content-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
