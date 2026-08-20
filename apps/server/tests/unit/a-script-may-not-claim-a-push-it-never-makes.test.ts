// V-1009 — an operator script may not TELL the operator it pushed when it does not.
//
// `scripts/v528-scrub-violators.sh` rewrites V-205 violator commits out of history
// with `git filter-repo`. Its only executed git commands are `git bundle create`
// and `git filter-repo`; every push is a `printf`. Until this commit it also told
// the operator, at runtime, two things that were not true:
//
//   dry run : "Force-push to remote follows automatically after filter-repo completes."
//   confirm : "V-205 historical scrub will FORCE-PUSH rewritten history."
//
// V-817 had already corrected the HEADER comment of that same file — and left both
// runtime messages standing. The sweep predicted exactly that ("the header fix alone
// leaves the runtime lie in place"), and it is the third time in this arc that a
// correction reached a file's header and stopped there. A header is read by whoever
// edits the script; the printf is read by whoever RUNS it, mid-remediation, deciding
// whether the violator commits are gone from the remote. They were not.
//
// So this guard reads what the operator SEES, not what the file says about itself:
// only `printf`/`echo` argument text is scanned. Comments are deliberately excluded,
// because a corrected file records the claim it used to make — that same v528 header
// quotes the retracted sentence at line 9 — and a guard that could not tell a
// retraction from a live claim would force the record to be deleted to stay green.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCRIPTS = resolve(REPO_ROOT, 'scripts');

/** Text the operator actually sees: the argument of a printf/echo. */
function printedText(src: string): string {
  const out: string[] = [];
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const m = /(?:printf|echo)\s+(.*)$/.exec(trimmed);
    if (m !== null) out.push(m[1] ?? '');
  }
  return out.join('\n');
}

/** A message asserting the script itself pushes — not one printing a command to run. */
const CLAIMS_A_PUSH =
  /force-?pushes\b|will\s+FORCE-PUSH|push[^\n]{0,40}follows automatically|pushes? (?:the )?rewritten history/i;

/** An executed push: `git push` at the start of a command, not inside a printf. */
function executesPush(src: string): boolean {
  return src.split('\n').some((line) => {
    const t = line.trim();
    if (t.startsWith('#') || t.startsWith('printf') || t.startsWith('echo')) return false;
    return /(^|[;&|]\s*)git\s+push\b/.test(t);
  });
}

function shellScripts(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(SCRIPTS)) {
    const p = join(SCRIPTS, entry);
    if (statSync(p).isDirectory()) continue;
    if (entry.endsWith('.sh')) out.push(p);
  }
  return out;
}

describe('V-1009 a script may not claim a push it never makes', () => {
  const scripts = shellScripts();

  it('CRITICAL the scan reaches the scripts and both detectors discriminate. A walk that found nothing, or a claim matcher that never fires, would make the arm below pass for every script in the repo — which is how the v528 runtime message survived its own header being corrected.', () => {
    expect(scripts.length, 'shell scripts under scripts/').toBeGreaterThanOrEqual(5);

    // The claim matcher fires on an assertion and not on printed instructions.
    expect(CLAIMS_A_PUSH.test('Force-push to remote follows automatically after filter-repo')).toBe(
      true,
    );
    expect(CLAIMS_A_PUSH.test('V-205 historical scrub will FORCE-PUSH rewritten history.')).toBe(
      true,
    );
    expect(CLAIMS_A_PUSH.test('  git push --force origin main')).toBe(false);
    expect(CLAIMS_A_PUSH.test('prints the two force-push commands to run')).toBe(false);

    // The push detector separates an executed command from a printed one.
    expect(executesPush('git push --force origin main')).toBe(true);
    expect(executesPush("printf '  git push --force origin main\\n'")).toBe(false);
    expect(executesPush('# git push --force origin main')).toBe(false);
  });

  it('CRITICAL no script tells the operator it pushes unless it executes a push. The failure this catches is not cosmetic: a security remediation that prints "force-push follows automatically" and pushes nothing leaves the operator believing violator commits are gone from the remote, which is the state in which nobody goes and checks.', () => {
    const liars: string[] = [];
    for (const path of scripts) {
      const src = readFileSync(path, 'utf8');
      if (!CLAIMS_A_PUSH.test(printedText(src))) continue;
      if (!executesPush(src)) liars.push(path.slice(REPO_ROOT.length + 1));
    }
    expect(
      liars,
      'these scripts PRINT that they push and never run a push — either push, or say the push is ' +
        'a manual step the operator must run afterwards:',
    ).toEqual([]);
  });

  it('CRITICAL the v528 scrub still prints the manual re-add step. `git filter-repo` removes the origin remote by default — its own help describes suppressing "removing of the origin remote" as the non-default case — so the push commands the script prints fail with a missing remote until origin is re-added. Printing a command that cannot work is the same defect one layer down.', () => {
    const src = readFileSync(resolve(SCRIPTS, 'v528-scrub-violators.sh'), 'utf8');
    expect(src, 'the scrub script no longer prints a push instruction at all').toMatch(
      /git push --force origin main/,
    );
    expect(
      printedText(src),
      'the printed completion steps no longer warn that filter-repo dropped origin',
    ).toMatch(/git remote add origin/);
  });

  it('V-1102 CRITICAL the RUNBOOK carries the re-add too, not just the script. The arm above checks what the script prints at the end of a run; this checks the document the operator is actually working through, which listed the rewrite and the force-push as consecutive commands with nothing between them. Following it verbatim fails on a remote filter-repo has just deleted, at the point where the remediation is half-applied — history rewritten locally, violator commits still live on the remote, and a ticked checkbox saying otherwise.', () => {
    const runbook = readFileSync(
      resolve(REPO_ROOT, 'docs/internal/v528-repo-privatization-runbook.md'),
      'utf8',
    );
    const at = runbook.indexOf('scripts/v528-scrub-violators.sh --confirm');
    expect(at, 'the runbook no longer names the scrub invocation').toBeGreaterThan(0);
    const block = runbook.slice(at, runbook.indexOf('```', at));

    expect(
      block,
      'the runbook goes from the rewrite straight to the force-push, but filter-repo removed origin ' +
        'by default — the push fails and the scrub is left half-applied:',
    ).toMatch(/git remote add origin/);

    // Order matters as much as presence: a re-add printed after the push is
    // the same failure with tidier text.
    const reAdd = block.indexOf('git remote add origin');
    const push = block.indexOf('git push --force origin main');
    expect(reAdd, 'the runbook no longer re-adds the remote before pushing').toBeGreaterThan(-1);
    expect(push, 'the runbook no longer shows the force-push').toBeGreaterThan(-1);
    expect(
      reAdd < push,
      'the runbook re-adds origin AFTER the force-push, so the push still runs against a remote ' +
        'that does not exist yet',
    ).toBe(true);
  });
});
