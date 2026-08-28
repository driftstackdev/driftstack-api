// A chaos scenario must undo its fault injection on every exit path.
//
// These scripts deliberately break things — blackhole api.postmarkapp.com in
// /etc/hosts, stop the Redis container, restart Postgres — and then put them
// back. Putting them back only when everything went well is the failure mode
// that matters, because the run that goes wrong is exactly the run that leaves
// the machine broken.
//
// Two real gaps, both measured against the shipped scripts rather than
// inferred:
//
//   * 01-postmark-outage restored /etc/hosts as its LAST step, which its three
//     failure branches jump past with `exit 1`. A failed rehearsal left
//     `127.0.0.1 api.postmarkapp.com` in place — outbound signup, reset and
//     invoice email silently dead on that host until somebody edited the file
//     by hand. It also runs FIRST, so it poisoned the rest of the run too.
//   * 04-postgres-restart restored inline in two of its three failure branches,
//     so an abort between the injection and the recovery check — any command
//     failing under `set -e` — left the container down.
//
// Neither was caught, and the reason is worth stating: the existing coverage is
// source-text parity, and its pin for 01 asserts the sed line EXISTS with the
// rationale "drift to a different cleanup mechanism would leave the host with a
// broken hosts entry". The line existed. It was simply unreachable when it
// mattered. A pin on the presence of a cleanup cannot tell you it runs.
//
// So this executes the real scripts against a stub lib.sh: `run_or_describe`
// records commands instead of running them, and `assert_http_status` returns
// whatever the case needs. Nothing touches the host.
//
// THE ROSTER COMES FROM run-all.sh, not from a list written here. The parity
// file content-pins lib.sh, 01, 02 and 06 — scenarios 03 and 04 appear in it
// only as names inside the runner's array, never as content — and a guard that
// hardcoded its own list would drift the same way the moment a scenario is
// added.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CHAOS_DIR = resolve(REPO_ROOT, 'scripts/chaos');

/** `run_or_describe` records; `assert_http_status` is steerable. Nothing runs. */
const STUB_LIB = `set -euo pipefail
CHAOS_MODE="\${CHAOS_MODE:-dry-run}"
log_step(){ :; }; log_warn(){ :; }; log_ok(){ :; }; log_fail(){ :; }
API_BASE="\${API_BASE:-http://localhost:3000}"
DOCKER="\${DOCKER:-docker compose}"
run_or_describe(){
  printf 'RAN: %s\\n' "$*" >&2
  if [[ -n "\${STUB_FAIL_CMD:-}" && "$*" == *"\${STUB_FAIL_CMD}"* ]]; then return 1; fi
}
assert_http_status(){ return "\${STUB_ASSERT_STATUS:-0}"; }
emit_pass(){ printf 'PASS scenario=%s name=%s\\n' "$1" "$2"; }
emit_fail(){ printf 'FAIL scenario=%s name=%s reason=%s\\n' "$1" "$2" "$3"; }
`;

/** The scenario slugs the runner actually iterates. */
function scenariosFromRunner(): string[] {
  const runner = readFileSync(resolve(CHAOS_DIR, 'run-all.sh'), 'utf8');
  const block = /SCENARIOS=\(([\s\S]*?)\)/.exec(runner);
  if (block === null) return [];
  return block[1]!
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

let dir: string;

/** Run a scenario in the sandbox and return the commands it would have run. */
function run(slug: string, env: Record<string, string> = {}): string[] {
  const r = spawnSync('bash', [join(dir, `${slug}.sh`)], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return `${r.stderr ?? ''}`
    .split('\n')
    .filter((l) => l.startsWith('RAN: '))
    .map((l) => l.slice('RAN: '.length).trim());
}

const SCENARIOS = scenariosFromRunner();

describe('chaos scenarios undo their fault injection on every exit path', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ds-chaos-restore-'));
    writeFileSync(join(dir, 'lib.sh'), STUB_LIB);
    for (const slug of SCENARIOS) {
      copyFileSync(resolve(CHAOS_DIR, `${slug}.sh`), join(dir, `${slug}.sh`));
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('CRITICAL the roster comes from run-all.sh and the sandbox actually executes them. Every assertion below reports an absence of leaked state, so a roster that came back empty — or a stub that produced no commands — would report every scenario clean having exercised none. The parity file already drifted this way: it content-pins 01, 02 and 06, and never grew pins for 03 or 04.', () => {
    expect(SCENARIOS.length, 'scenarios parsed out of run-all.sh').toBeGreaterThan(4);
    const injecting = SCENARIOS.filter((s) => run(s).length > 0);
    expect(
      injecting.length,
      'scenarios that run at least one command in the sandbox',
    ).toBeGreaterThan(2);
  });

  it('CRITICAL every scenario script on disk is in the runner roster. The floor above is a magic number, and a magic number cannot see the gap that matters: a scenario ADDED to scripts/chaos but never added to run-all.sh is executed by neither the chaos suite nor this guard, and five-or-six still clears a floor of four. The roster is the thing being trusted, so the assertion has to be the relationship — roster equals disk — rather than a count that happens to be right today.', () => {
    const onDisk = readdirSync(CHAOS_DIR)
      .filter((f) => /^\d\d-.*\.sh$/.test(f))
      .map((f) => f.replace(/\.sh$/, ''))
      .sort();
    // Non-vacuity: a readdir that returned nothing would make the comparison
    // agree with an empty roster, which is the failure this arm exists to catch.
    expect(onDisk.length, 'numbered scenario scripts found in scripts/chaos').toBeGreaterThan(0);
    expect([...SCENARIOS].sort(), 'run-all.sh roster vs scripts/chaos on disk').toEqual(onDisk);
  });

  for (const slug of SCENARIOS) {
    it(`CRITICAL what ${slug} does LAST does not depend on whether it succeeded. That is exactly the property an EXIT trap gives and the property these scripts lacked: the undo was the final step of the happy path, so any earlier exit skipped it. Stated this way rather than as "the last command is the cleanup" on purpose — that would be an assumption about intent, and it would flag a correct scenario whose final step is a probe rather than an undo.`, () => {
      const onSuccess = run(slug);
      if (onSuccess.length === 0) {
        // A pure-probe scenario (forged signatures, no injection) has nothing
        // to undo. Asserted rather than skipped so it cannot quietly become an
        // injecting scenario without this file noticing.
        expect(
          run(slug, { STUB_ASSERT_STATUS: '1' }),
          `${slug} injects no fault, so its failure path must run nothing either`,
        ).toEqual([]);
        return;
      }
      const lastOnSuccess = onSuccess[onSuccess.length - 1]!;
      const onFailure = run(slug, { STUB_ASSERT_STATUS: '1' });
      expect(
        onFailure[onFailure.length - 1],
        `${slug} ends on "${lastOnSuccess}" when it passes; it must end there when a check fails too`,
      ).toBe(lastOnSuccess);
    });
  }

  it('CRITICAL a scenario aborting part-way still ends the same way. A command failing under `set -e` produces no FAIL line and reaches no failure branch at all, so per-branch cleanups do not cover it: 04-postgres-restart restored inline in two of its three branches and still left the container down when an intermediate step aborted.', () => {
    const withIntermediateSteps = SCENARIOS.map((slug) => ({ slug, cmds: run(slug) })).filter(
      ({ cmds }) => cmds.length > 2,
    );
    expect(
      withIntermediateSteps.length,
      'scenarios with a step between injection and cleanup to abort on',
    ).toBeGreaterThan(0);

    for (const { slug, cmds } of withIntermediateSteps) {
      const lastOnSuccess = cmds[cmds.length - 1]!;
      const abortOn = cmds[1]!; // the first step after the injection
      const onAbort = run(slug, { STUB_FAIL_CMD: abortOn });
      expect(
        onAbort[onAbort.length - 1],
        `${slug} must still end on "${lastOnSuccess}" when "${abortOn}" fails mid-run`,
      ).toBe(lastOnSuccess);
    }
  });
});
