#!/usr/bin/env node
// Compare the infra/ artefacts in this repo against what is ACTUALLY DEPLOYED.
//
// ⛔ WHY THIS EXISTS. On 2026-09-15 the passive OS observer was found running in
// production with no copy in source control at all — every one of its siblings
// in infra/ was tracked, it was not, and nothing could see the difference. A
// rebuild would have lost it and a change had no review trail.
//
// Vendoring that one file fixes that one file. This is the part that generalises:
// the gap was not "somebody forgot", it was that NOTHING COMPARED THE TWO SIDES.
// The repo could not tell you whether infra/ described the running system, in
// either direction — a file present here but stale, a file edited on the box and
// never brought back, or a file that only ever existed there.
//
// ⚠️ DELIBERATELY NOT IN `lint`. It needs SSH to production, which is slow, fails
// for anyone without access, and has no business as a side effect of a lint run.
// It is a thing you RUN — before a deploy, after a hand-edit on a host, or when
// you want to know whether infra/ is fiction. The archetype gate earns its place
// in lint because it reads a local file; this does not.
//
// Usage:
//   node scripts/check-infra-drift.mjs                  # production (default)
//   DRIFT_ROLE=staging node scripts/check-infra-drift.mjs
//   DRIFT_HOST=root@1.2.3.4 DRIFT_ROLE=prod node scripts/check-infra-drift.mjs
//
// Each artefact declares the host it belongs to, and a run compares only that
// host's set. An unknown DRIFT_HOST without a DRIFT_ROLE is refused (exit 2)
// rather than defaulted — see HOSTS.
//
// Exit 0 = every tracked artefact matches its deployed copy (or the host was
// unreachable, said loudly). Exit 1 = drift, named file by file.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit, env, stdout } from 'node:process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The hosts this repo describes, by role. An artefact belongs to exactly one of
 * them (see TRACKED), and only that host's artefacts are compared on a run.
 *
 * ⛔ WHY THIS IS KEYED BY ROLE. This script used to hold one implicit host —
 * production — and a flat list of "files that live somewhere else". Pointed at
 * staging, exactly as its own usage line told you to, it compared PRODUCTION's
 * artefacts against the staging box, reported all five as drift because they are
 * absent there, and then SKIPPED the one file that does belong to staging with
 * the message "belongs to the staging host". Five false positives and the single
 * true question unasked, from the documented invocation.
 *
 * That is this script's own subject matter turned on itself: it exists because
 * nothing compared the two sides, and for any host but the default it compared
 * the wrong two. An instrument whose population assumption misses the thing it
 * was pointed at still returns a confident answer.
 */
const HOSTS = {
  prod: 'root@128.140.37.74',
  staging: 'root@116.203.22.197',
};

/**
 * Which host to compare against. `DRIFT_ROLE=prod|staging` names it directly;
 * `DRIFT_HOST` still works and resolves to a role when it matches a known host.
 *
 * An unrecognised DRIFT_HOST with no DRIFT_ROLE is REFUSED rather than defaulted:
 * silently comparing production's artefact set against an unknown box is how the
 * original defect read as five real drifts.
 */
const ROLE = (() => {
  const wanted = env.DRIFT_ROLE;
  if (wanted !== undefined) {
    if (!(wanted in HOSTS)) {
      stdout.write(
        `infra-drift: REFUSED — DRIFT_ROLE="${wanted}" is not one of: ${Object.keys(HOSTS).join(', ')}.\n`,
      );
      exit(2);
    }
    return wanted;
  }
  const host = env.DRIFT_HOST;
  if (host === undefined) return 'prod';
  const match = Object.keys(HOSTS).find((r) => HOSTS[r] === host);
  if (match === undefined) {
    stdout.write(
      `infra-drift: REFUSED — DRIFT_HOST="${host}" is not a host this repo describes, so there is\n` +
        '  no way to know WHICH artefacts belong on it. Comparing the default set would report\n' +
        `  every absent file as drift. Pass DRIFT_ROLE=${Object.keys(HOSTS).join('|')} to say which\n` +
        '  set to compare, or add the host to HOSTS in this script.\n',
    );
    exit(2);
  }
  return match;
})();

const HOST = env.DRIFT_HOST ?? HOSTS[ROLE];

/**
 * Every artefact this repo claims to describe, and where it lives on the host.
 *
 * ⛔ A file MISSING from this map is invisible to the check, which is exactly the
 * failure mode that produced it — so the map is also asserted against the
 * directory listing below. Adding a file to infra/ without adding it here fails.
 */
const TRACKED = [
  [
    'prod',
    'infra/nginx/api.driftstack.dev.conf',
    '/etc/nginx/sites-enabled/api.driftstack.dev.conf',
  ],
  [
    'prod',
    'infra/nginx/fleet.driftstack.dev.conf',
    '/etc/nginx/sites-enabled/fleet.driftstack.dev.conf',
  ],
  ['prod', 'infra/systemd/driftstack-api.service', '/etc/systemd/system/driftstack-api.service'],
  [
    'prod',
    'infra/systemd/driftstack-os-observer.service',
    '/etc/systemd/system/driftstack-os-observer.service',
  ],
  ['prod', 'infra/os-observer/observer.py', '/opt/driftstack/os-observer/observer.py'],
  // conf.d/, not sites-enabled/ — included by the vhosts above rather than being
  // one. Both were unwatched on this script's FIRST run, which is the argument
  // for the coverage assertion rather than a hand-kept list.
  ['prod', 'infra/nginx/cloudflare-real-ip.conf', '/etc/nginx/conf.d/cloudflare-real-ip.conf'],
  ['prod', 'infra/nginx/ws_upgrade_map.conf', '/etc/nginx/conf.d/ws_upgrade_map.conf'],
  // Staging's vhost is a first-class artefact, not an exception to the list. It
  // was previously unreachable: named only in a "lives elsewhere" map that was
  // skipped on EVERY run, including runs against staging itself.
  [
    'staging',
    'infra/nginx/staging.driftstack.dev.conf',
    '/etc/nginx/sites-enabled/staging.driftstack.dev.conf',
  ],
];

/** The artefacts belonging to the host being checked, and those deferred to another. */
const FOR_THIS_HOST = TRACKED.filter(([role]) => role === ROLE);
const FOR_OTHER_HOSTS = TRACKED.filter(([role]) => role !== ROLE);

const ssh = (cmd) =>
  execFileSync('ssh', ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', HOST, cmd], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });

try {
  ssh('true');
} catch {
  // Loud, and exit 0. An unreachable host is "I could not look", which must not
  // read as "I looked and it was fine" — but it is also not drift, and failing
  // here would make the script useless to anyone without production access.
  stdout.write(
    `infra-drift: SKIPPED — ${HOST} is unreachable, so nothing was compared.\n` +
      '  This is NOT a pass. Run it from a machine with production SSH.\n',
  );
  exit(0);
}

const drift = [];
const missing = [];

for (const [, repoPath, hostPath] of FOR_THIS_HOST) {
  const local = resolve(REPO, repoPath);
  if (!existsSync(local)) {
    missing.push(`${repoPath} — listed here but absent from the repo`);
    continue;
  }
  let remote;
  try {
    remote = ssh(`cat ${hostPath}`);
  } catch {
    drift.push(`${repoPath}\n    ${hostPath} could not be read on the host (absent? permissions?)`);
    continue;
  }
  // Trailing-newline differences are an editor artefact, not drift.
  if (readFileSync(local, 'utf8').trimEnd() !== remote.trimEnd()) {
    drift.push(`${repoPath}\n    differs from ${hostPath}`);
  }
}

// The map must cover infra/ — otherwise a new artefact is silently unwatched,
// which is the defect this script was written after.
const listed = new Set(TRACKED.map(([, p]) => p));
const onDisk = execFileSync(
  'git',
  ['ls-files', 'infra/nginx', 'infra/systemd', 'infra/os-observer'],
  { cwd: REPO, encoding: 'utf8' },
)
  .split('\n')
  .filter((l) => l.trim() !== '');
const unwatched = onDisk.filter((p) => !listed.has(p));

for (const [role, p] of FOR_OTHER_HOSTS) {
  stdout.write(
    `infra-drift: not checked here — ${p} belongs to ${role} (${HOSTS[role]}); ` +
      `run DRIFT_ROLE=${role} to check it\n`,
  );
}

if (unwatched.length > 0) {
  stdout.write(
    'infra-drift: FILES NOT WATCHED — add them to TRACKED in this script, with their host path:\n' +
      unwatched.map((p) => `  ${p}`).join('\n') +
      '\n',
  );
}
if (missing.length > 0) {
  stdout.write(`infra-drift: LISTED BUT ABSENT:\n${missing.map((m) => `  ${m}`).join('\n')}\n`);
}
if (drift.length > 0) {
  stdout.write(
    `infra-drift: DRIFT against ${HOST}\n${drift.map((d) => `  ${d}`).join('\n')}\n` +
      '  The repo and the running system disagree. Decide which is right — a file\n' +
      '  edited on the box is as much a defect as a repo change never deployed.\n',
  );
}
if (drift.length > 0 || missing.length > 0 || unwatched.length > 0) exit(1);

stdout.write(
  `infra-drift: OK — ${FOR_THIS_HOST.length} ${ROLE} ${FOR_THIS_HOST.length === 1 ? 'artefact matches' : 'artefacts match'} ${HOST}\n`,
);
