// The chaos runner's verdict must match what the scenarios actually reported.
//
// `scripts/chaos/run-all.sh` is the script an operator runs to decide whether a
// release is safe, and its header promises: "Exits non-zero if any scenario
// emits FAIL." It did not do that. It judged purely on each scenario's EXIT
// STATUS, so a scenario that printed a FAIL line and then returned 0 was
// counted as a pass and the run reported all-green. Measured, not inferred: a
// stub emitting `FAIL scenario=02 ... reason=bad-signature-not-rejected` with
// no `exit 1` produced `pass: 5 / fail: 0` and status 0.
//
// It also discarded the scenario's output on failure — `printf '%s\n' "$RESULT"`
// ran only in the success branch — so a real failure named the slug and threw
// away the `reason=` field, which is the entire diagnostic content, at exactly
// the moment it mattered.
//
// Neither was caught, because the existing coverage for these scripts is
// source-text parity: it pins that the header sentence and the counter
// variables are present, which is true of a runner that ignores them. This
// file runs the real script against stub scenarios instead.
//
// The scenarios shipped today all pair `emit_fail` with `exit 1`, so their
// status and their output agree. That is the reason the defect was latent
// rather than live — and it is a property of the scenarios, not of the
// aggregator, so the aggregator is the wrong place to assume it.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const RUN_ALL = resolve(REPO_ROOT, 'scripts/chaos/run-all.sh');

/** The scenario slugs run-all.sh iterates, in its own order. */
const SCENARIOS = [
  '01-postmark-outage',
  '02-stripe-bad-signature',
  '03-nowpayments-bad-signature',
  '04-postgres-restart',
  '06-redis-down',
];

let dir: string;

/** Write a stub scenario that prints `body` and exits `status`. */
function stub(slug: string, body: string, status = 0): void {
  const path = join(dir, `${slug}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\nexit ${status}\n`);
  chmodSync(path, 0o755);
}

function runAll(): { status: number; output: string } {
  const r = spawnSync('bash', [join(dir, 'run-all.sh')], { encoding: 'utf8' });
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('the chaos runner reports the verdict its scenarios reported', () => {
  beforeEach(() => {
    // run-all.sh resolves its scenario directory from BASH_SOURCE, so a copy
    // beside stub scenarios exercises the REAL script with no test hook in it.
    dir = mkdtempSync(join(tmpdir(), 'ds-chaos-'));
    copyFileSync(RUN_ALL, join(dir, 'run-all.sh'));
    for (const slug of SCENARIOS) stub(slug, `printf 'PASS scenario=${slug} name=stub\\n'`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('POSITIVE CONTROL an all-passing run exits 0 and says so. Without this, a runner that failed unconditionally would satisfy every failure case below and look like perfect rigour while blocking every release.', () => {
    const { status, output } = runAll();
    expect(status, output).toBe(0);
    expect(output).toContain('pass: 5');
    expect(output).toContain('fail: 0');
  });

  it('CRITICAL a scenario that emits FAIL but exits 0 still fails the run. This is the defect: the runner judged on exit status alone, so this exact case reported pass: 5 / fail: 0 and returned 0, while the script header promised the opposite.', () => {
    stub(
      '02-stripe-bad-signature',
      `printf 'FAIL scenario=02 name=stub reason=sig-not-rejected\\n'`,
    );
    const { status, output } = runAll();
    expect(status, output).toBe(1);
    expect(output).toContain('fail: 1');
    expect(
      output,
      'and the mismatch between what it printed and what it returned is visible',
    ).toContain('exit=0');
  });

  it('CRITICAL a failing scenario keeps its reason IN THE RUN LOG, not only in the summary. The runner printed scenario output on success only, so a real failure named the slug and dropped the reason= field at the one moment it is worth having. Asserting merely that the reason appears SOMEWHERE is too weak to catch that — the summary line carries it too, so suppressing the run-log copy passed. This splits the two.', () => {
    stub(
      '02-stripe-bad-signature',
      `printf 'FAIL scenario=02 name=stub reason=sig-not-rejected\\n'`,
      1,
    );
    const { status, output } = runAll();
    expect(status, output).toBe(1);

    const marker = '=== Summary';
    expect(output, 'the summary section is present to split on').toContain(marker);
    const runLog = output.slice(0, output.indexOf(marker));
    expect(runLog, "the scenario's own output survives where it was produced").toContain(
      'reason=sig-not-rejected',
    );
    expect(output.slice(output.indexOf(marker)), 'and the summary names it as well').toContain(
      'reason=sig-not-rejected',
    );
  });

  it('CRITICAL a scenario that dies silently is still a failure, and its status is reported. A crash before any output produces no FAIL line, so a runner keyed only on the text would count it as a pass.', () => {
    stub('02-stripe-bad-signature', 'true', 3);
    const { status, output } = runAll();
    expect(status, output).toBe(1);
    expect(output).toContain('fail: 1');
    expect(output, "the scenario's real status is named rather than flattened").toContain('exit=3');
  });

  it('CRITICAL every scenario runs even after an earlier one fails. Stopping at the first failure would leave the rest of a rehearsal unreported, which is the opposite of what a chaos run is for.', () => {
    stub('01-postmark-outage', `printf 'FAIL scenario=01 name=stub reason=first\\n'`, 1);
    stub('06-redis-down', `printf 'FAIL scenario=06 name=stub reason=last\\n'`, 1);
    const { status, output } = runAll();
    expect(status, output).toBe(1);
    expect(output).toContain('fail: 2');
    expect(output, 'the LAST scenario still ran despite the first having failed').toContain(
      'reason=last',
    );
    expect(output).toContain('pass: 3');
  });
});
