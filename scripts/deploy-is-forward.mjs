#!/usr/bin/env node
// Refuse to move a deployed environment backwards (security sweep E-9, remaining
// hardening, 2026-09-24).
//
// .github/workflows/deploy.yml runs when CI completes on main and deploys the
// commit that CI run tested. CI completions do not arrive in commit order — a
// re-run of an old CI run finishes long after a newer commit went live — so each
// deploy job runs this first, against the environment it is about to change:
//
//   node scripts/deploy-is-forward.mjs --base-url https://api.driftstack.dev --sha <commit>
//
// It reads the commit the environment serves from its public /version and allows
// the deploy only when the candidate IS that commit or a descendant of it, and the
// candidate is on main. It needs the full history (the workflow's checkout uses
// fetch-depth: 0 for the deploy bundle already).
//
// Exit codes — the workflow branches on them:
//   0  forward, or the same commit again (a re-run finishing a failed deploy)
//   3  the environment already runs a NEWER commit: skip; this is not a failure
//   1  anything it cannot prove safe: not on main, history diverged, a live
//      commit absent from this history, or a live commit that is unreadable or
//      "unknown" when the candidate is not the tip of main. Fails loudly; a
//      person decides (scripts/deploy-bridge.sh deploys by hand).
//   2  usage
//
// An environment that cannot say what it runs (its /version is down, erroring,
// or reports "unknown") still takes the TIP of main: no commit on main is newer
// than the tip, so that deploy cannot move it backwards whatever it runs. This
// is what keeps the automatic fix-forward working when an environment is broken
// badly enough to lose /version (docs/deployment/dr-runbook.md, Scenario 7). A
// live commit this history does not contain is different: somebody put it there
// by hand, and it is refused.
//
// Rollbacks are deliberately NOT subject to this: deploy-bridge.sh's auto-revert
// and revert-bridge.sh move an environment back on purpose, by hand or on a
// failed post-deploy verification, and never go through this check.

import { execFileSync } from 'node:child_process';

const SHA = /^[0-9a-f]{7,40}$/;
const EXIT = { FORWARD: 0, REFUSE: 1, USAGE: 2, OLDER: 3 };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) return null;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return null;
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

function say(message) {
  process.stdout.write(`[deploy-is-forward] ${message}\n`);
}

function resolveCommit(ref) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** `git merge-base --is-ancestor`: exit 0 yes, 1 no, anything else is an error. */
function isAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    if (err && err.status === 1) return false;
    throw err;
  }
}

async function readLiveSha(baseUrl, attempts) {
  const url = `${baseUrl.replace(/\/+$/, '')}/version`;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return String(body?.git_sha ?? '');
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
  throw lastError ?? new Error('no attempt made');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args === null || !args['base-url'] || !args.sha) {
    process.stderr.write(
      'usage: node scripts/deploy-is-forward.mjs --base-url <origin> --sha <commit> [--main-ref origin/main] [--attempts 3]\n',
    );
    return EXIT.USAGE;
  }
  const mainRef = args['main-ref'] ?? 'origin/main';
  const attempts = Math.max(1, Number.parseInt(args.attempts ?? '3', 10) || 3);

  if (!SHA.test(args.sha)) {
    say('refusing: the candidate is not a 7-40 character lowercase hex commit id');
    return EXIT.REFUSE;
  }
  const candidate = resolveCommit(args.sha);
  if (candidate === null) {
    say(`refusing: ${args.sha} is not a commit in this checkout`);
    return EXIT.REFUSE;
  }
  const main = resolveCommit(mainRef);
  if (main === null) {
    say(`refusing: cannot resolve ${mainRef} (the checkout needs full history)`);
    return EXIT.REFUSE;
  }
  if (!isAncestor(candidate, main)) {
    say(`refusing: ${candidate} is not on main (${mainRef})`);
    return EXIT.REFUSE;
  }

  // The live commit cannot be read: only the tip of main may go out, since
  // nothing on main is newer than it.
  const unreadable = (why) => {
    if (candidate === main) {
      say(
        `ok: ${why}; ${candidate} is the tip of main (${mainRef}), which no commit on main is newer than`,
      );
      return EXIT.FORWARD;
    }
    say(
      `refusing: ${why}; only the tip of main (${main}) deploys to an environment that cannot say what it runs, ` +
        'anything else is deployed by hand',
    );
    return EXIT.REFUSE;
  };

  let liveRaw;
  try {
    liveRaw = await readLiveSha(args['base-url'], attempts);
  } catch (err) {
    return unreadable(
      `could not read ${args['base-url']}/version (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!SHA.test(liveRaw)) {
    return unreadable(
      `${args['base-url']} reports git_sha "${liveRaw.slice(0, 64)}", not a commit id`,
    );
  }
  const live = resolveCommit(liveRaw);
  if (live === null) {
    say(`refusing: the live commit ${liveRaw} is not in this repository's history`);
    return EXIT.REFUSE;
  }

  if (live === candidate) {
    say(`ok: ${candidate} is already live; deploying the same commit again`);
    return EXIT.FORWARD;
  }
  if (isAncestor(live, candidate)) {
    say(`ok: ${candidate} is newer than the live ${live}`);
    return EXIT.FORWARD;
  }
  if (isAncestor(candidate, live)) {
    say(`skip: ${candidate} is older than the live ${live}; never deploying backwards`);
    return EXIT.OLDER;
  }
  say(
    `refusing: ${candidate} and the live ${live} have diverged (neither contains the other); ` +
      'a person decides which one production should run',
  );
  return EXIT.REFUSE;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    say(`refusing: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = EXIT.REFUSE;
  },
);
