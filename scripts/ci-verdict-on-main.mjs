#!/usr/bin/env node
// W-34 — the pre-push hook's CI line: CI's verdict for the commit at the HEAD of
// origin/main, or a plain statement that there is none. ADVISORY: this script
// always exits 0; it reports and the human decides (see .husky/pre-push).
//
// ⛔ ONE COMMIT, NAMED. The first version asked for the eight most recent CI runs
// on main and printed the first one that carried a verdict, labelled "CI on
// origin/main". Pushes supersede in-flight runs (they end `cancelled`) and the
// head's own run is still going when the next push lands, so "the newest run with
// a verdict" was routinely a run for an OLDER commit: on 2026-09-25 the hook said
// "green (7172d0cc5)", a run from 09-22, while origin/main was c2be2354b and its
// run had no verdict yet. A green for another commit is not a green for this one.
//
// So: read the head of main from GitHub at the moment of the push, then that
// commit's CI run, and say what IT says:
//   success               → green, naming the head
//   failure / timed_out   → the red warning, naming the head
//   still running         → "no verdict yet" — Not a green
//   cancelled / skipped…  → "no verdict — its run ended <conclusion>" — Not a green
//   no run for the head   → "no CI run for this commit yet" — Not a green
//   anything unreadable   → COULD NOT CHECK — Not a green
// A check that goes quiet when it cannot run is indistinguishable from a green one,
// so every state that is not a green says so in those words.

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.DRIFTSTACK_CI_REPO ?? 'driftstackdev/driftstack-api';
const MANUAL = `gh run list --repo ${REPO} --workflow CI --branch main --limit 3`;

/** Run gh and parse its JSON answer; null on ANY failure (not installed, not
 *  signed in, offline, a timeout, or an answer that is not JSON). */
function ghJson(args) {
  try {
    const out = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Never hold a push hostage to a slow network.
      timeout: 20_000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function couldNotCheck(why) {
  return [
    `→ CI on origin/main: COULD NOT CHECK (${why})`,
    '    Not a green. Check manually if this push matters:',
    `    ${MANUAL}`,
  ];
}

/**
 * The lines to print for the head of main and the CI runs GitHub listed for it.
 * Pure — the tests and main() share it. `head` is a full sha or null (unreadable);
 * `runs` is gh's `run list --json status,conclusion,headSha,createdAt` answer, or
 * null when that call failed.
 */
export function ciVerdictLines(head, runs) {
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) {
    return couldNotCheck(
      'the head of origin/main could not be read — gh unavailable, unauthenticated, or offline',
    );
  }
  const short = head.slice(0, 9);
  if (!Array.isArray(runs)) {
    return couldNotCheck(`the CI runs for ${short} could not be read`);
  }
  // Only runs FOR THIS COMMIT answer for it — whatever the list call was asked,
  // a row for another sha is not admitted. Newest first.
  const mine = runs
    .filter((r) => r !== null && typeof r === 'object' && r.headSha === head)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const run = mine[0];
  if (run === undefined) {
    return [
      `→ CI on origin/main (${short}): no verdict — there is no CI run for this commit yet.`,
      '    Not a green. It cannot tell until CI has run on it.',
    ];
  }
  if (run.status !== 'completed') {
    return [
      `→ CI on origin/main (${short}): no verdict yet — its CI run is ${String(run.status || 'queued').replace(/_/g, ' ')}.`,
      '    Not a green. It cannot tell until that run finishes.',
    ];
  }
  if (run.conclusion === 'success') return [`→ CI on origin/main: green (${short})`];
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
    return [
      '',
      `⛔ CI on origin/main is currently: ${run.conclusion} (run for ${short})`,
      '   You are pushing on top of a RED CI. Deploys do not depend on CI, so',
      '   nothing else will tell you. The jobs this gate does not run are listed',
      '   at the end of every verify-suite run, each with a command you can paste.',
      '',
    ];
  }
  // cancelled (a newer push superseded it), skipped, neutral, stale, action_required…
  return [
    `→ CI on origin/main (${short}): no verdict — its CI run ended ${String(run.conclusion || 'without a conclusion')}.`,
    `    Not a green. Check manually if this push matters: ${MANUAL}`,
  ];
}

function main() {
  const commit = ghJson(['api', `repos/${REPO}/commits/main`]);
  const head = commit !== null && typeof commit === 'object' ? commit.sha : null;
  const runs =
    typeof head === 'string' && /^[0-9a-f]{40}$/.test(head)
      ? ghJson([
          'run',
          'list',
          '--repo',
          REPO,
          '--workflow',
          'CI',
          '--branch',
          'main',
          '--commit',
          head,
          '--limit',
          '10',
          '--json',
          'status,conclusion,headSha,createdAt',
        ])
      : null;
  process.stdout.write(`${ciVerdictLines(head, runs).join('\n')}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    // Advisory to the end: an unexpected throw is one more "could not check".
    process.stdout.write(
      `${couldNotCheck(String(err instanceof Error ? err.message : err)).join('\n')}\n`,
    );
  }
  process.exitCode = 0;
}
