// W611 — drift guard for scripts/v528-*.sh family (5 modules).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const P = (rel: string) => resolve(REPO_ROOT, `scripts/${rel}`);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W611 scripts V-528 V-656 family content parity', () => {
  it('v528-prestage.sh: V-656 pre-stage runner + 2-3hr → ~30min runbook acceleration + 3-step post-prestage (per-SDK adjustments + 4 irreversible founder-only steps: gh repo create+push / gh repo edit --visibility private / V-205 scrub force-push / CI secrets + tag push) pinned', () => {
    const body = read(P('v528-prestage.sh'));
    expect(body).toMatch(/^# V-656 — V-528 pre-stage runner\.$/m);
    expect(body).toMatch(
      /^# Drops the V-528 trigger from ~2-3 hr \(per the runbook\) to ~30 min for the$/m,
    );
    expect(body).toMatch(
      /^# driftstack team by pre-running every Tier-1-autonomous \(no remote ops\)$/m,
    );
    expect(body).toMatch(/^# preparatory step\./m);
    expect(body).toMatch(/^#\s+1\. Review the cleanup branch \+ this script's output\./m);
    expect(body).toMatch(
      /^#\s+2\. Run the per-SDK adjustment scripts \(Step 2 of V-528 runbook\)\./m,
    );
    expect(body).toMatch(/^#\s+3\. Execute the 4 irreversible founder-only steps:$/m);
    expect(body).toMatch(/^#\s+Step 3 \(gh repo create \+ push\) — manual$/m);
    expect(body).toMatch(/^#\s+Step 4 \(gh repo edit --visibility private\) — manual$/m);
    expect(body).toMatch(
      /^#\s+Step 5 \(V-205 scrub force-push\) — via scripts\/v528-scrub-violators\.sh$/m,
    );
    expect(body).toMatch(/^#\s+Step 7 \(CI secrets \+ tag push\) — manual$/m);
    expect(existsSync(P('v528-prestage.sh'))).toBe(true);
  });

  it('v528-scrub-violators.sh: V-656 Step 5 V-205 historical scrub via git-filter-repo + run-ONLY-AFTER-Steps-3+4-repo-private + zero-public-blast-radius post-Step-4 + 2 violator commits (63a20c1 process-handoff replacement / ef649a1 LLM-vendor replacement) pinned', () => {
    const body = read(P('v528-scrub-violators.sh'));
    expect(body).toMatch(/^# V-656 — V-528 Step 5: V-205 historical scrub via git-filter-repo\.$/m);
    expect(body).toMatch(
      /^# Run ONLY AFTER V-528 Steps 3 \+ 4 \(repo flipped private\)\. Rewrites$/m,
    );
    // V-817 SENTINEL — the retired claim must not return. The script does
    // not push; saying it does invites the operator to skip the push.
    expect(body, 'the script must not claim it pushes').not.toMatch(
      /Force-pushes\s*\n# rewritten history/,
    );
    expect(body).toMatch(/^# history LOCALLY and prints the two force-push commands to run$/m);
    expect(body).toMatch(
      /^# afterwards — it does NOT push\. Public-visible blast radius is zero$/m,
    );
    expect(body).toMatch(
      /^#\s+- 63a20c1 "Handoff: Postmark approval requested \+ seamless-handoff bootstrap"$/m,
    );
    expect(body).toMatch(
      /^#\s+Body references the AI assistant by name in 5 places \("switching X$/m,
    );
    expect(body).toMatch(/Replacement framing: process-handoff \/ handoff-tooling\./);
    expect(body).toMatch(
      /^#\s+- ef649a1 "V-492 \/ V-493 \/ V-508: wave 9 — SDK coverage parity test \+ \.\.\."$/m,
    );
    expect(body).toMatch(/Replacement framing: LLM-vendor\./);
    expect(existsSync(P('v528-scrub-violators.sh'))).toBe(true);
  });

  it('v528-adjust-typescript.sh: V-656 per-SDK TypeScript adjustment + idempotent same-tree + 4 steps (LICENSE copy / package.json repo.url+drop-directory+inline-api-types / ci.yml / publish.yml) on sdk-extract/typescript branch pinned', () => {
    const body = read(P('v528-adjust-typescript.sh'));
    expect(body).toMatch(/^# V-656 — V-528 per-SDK adjustment: TypeScript\.$/m);
    expect(body).toMatch(
      /^# Run ON the `sdk-extract\/typescript` branch BEFORE pushing to the new$/m,
    );
    expect(body).toMatch(/^# public repo\. Idempotent: re-running produces the same tree\./m);
    expect(body).toMatch(
      /^#\s+1\. Copy LICENSE from \/tmp\/driftstack-api-LICENSE → \.\/LICENSE$/m,
    );
    expect(body).toMatch(/^#\s+2\. Edit package\.json:$/m);
    expect(body).toMatch(/^#\s+- repository\.url → driftstack-typescript-sdk$/m);
    expect(body).toMatch(/^#\s+- drop repository\.directory$/m);
    expect(body).toMatch(
      /^#\s+- inline @driftstack\/api-types \(option \(a\) — bundle types into dist\)$/m,
    );
    expect(body).toMatch(/^#\s+3\. Add \.github\/workflows\/ci\.yml$/m);
    expect(body).toMatch(/^#\s+4\. Add \.github\/workflows\/publish\.yml$/m);
    expect(existsSync(P('v528-adjust-typescript.sh'))).toBe(true);
  });

  it('v528-adjust-python.sh: V-656 per-SDK Python adjustment + 4 steps (LICENSE copy / pyproject.toml project.urls.Repository / ci.yml / publish.yml) + sdk-extract/python branch pinned', () => {
    const body = read(P('v528-adjust-python.sh'));
    expect(body).toMatch(/^# V-656 — V-528 per-SDK adjustment: Python\.$/m);
    expect(body).toMatch(/^# Run ON the `sdk-extract\/python` branch BEFORE pushing\.$/m);
    expect(body).toMatch(/^#\s+1\. Copy LICENSE\.$/m);
    expect(body).toMatch(
      /^#\s+2\. Edit pyproject\.toml: project\.urls\.Repository → new repo URL\.$/m,
    );
    expect(body).toMatch(/^#\s+3\. Add \.github\/workflows\/ci\.yml\.$/m);
    expect(body).toMatch(/^#\s+4\. Add \.github\/workflows\/publish\.yml\.$/m);
    expect(body).toMatch(/^EXPECTED_BRANCH="sdk-extract\/python"$/m);
    expect(body).toMatch(/^CURRENT_BRANCH=\$\(git rev-parse --abbrev-ref HEAD\)$/m);
    expect(existsSync(P('v528-adjust-python.sh'))).toBe(true);
  });

  it('v528-adjust-go.sh: V-656 per-SDK Go adjustment + 4 steps (LICENSE / go.mod module-path rewrite / in-tree import rewrite / ci.yml) + no-publish-workflow rationale (Go modules publish via tag push + proxy.golang.org auto-indexes) + sdk-extract/go branch pinned', () => {
    const body = read(P('v528-adjust-go.sh'));
    expect(body).toMatch(/^# V-656 — V-528 per-SDK adjustment: Go\.$/m);
    expect(body).toMatch(/^# Run ON the `sdk-extract\/go` branch BEFORE pushing\.$/m);
    expect(body).toMatch(/^#\s+1\. Copy LICENSE\.$/m);
    expect(body).toMatch(
      /^#\s+2\. Edit go\.mod: module path → github\.com\/driftstackdev\/driftstack-go-sdk\.$/m,
    );
    expect(body).toMatch(
      /^#\s+3\. Rewrite any in-tree import that referenced the old module path\.$/m,
    );
    expect(body).toMatch(/^#\s+4\. Add \.github\/workflows\/ci\.yml\.$/m);
    expect(body).toMatch(
      /^#\s+\(No publish workflow needed — Go modules publish via tag push \+$/m,
    );
    expect(body).toMatch(/^#\s+proxy\.golang\.org auto-indexes\.\)$/m);
    expect(existsSync(P('v528-adjust-go.sh'))).toBe(true);
  });
});
