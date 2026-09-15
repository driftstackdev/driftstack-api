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
//   node scripts/check-infra-drift.mjs                  # production
//   DRIFT_HOST=root@1.2.3.4 node scripts/check-infra-drift.mjs
//
// Exit 0 = every tracked artefact matches its deployed copy (or the host was
// unreachable, said loudly). Exit 1 = drift, named file by file.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit, env, stdout } from 'node:process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = env.DRIFT_HOST ?? 'root@128.140.37.74';

/**
 * Every artefact this repo claims to describe, and where it lives on the host.
 *
 * ⛔ A file MISSING from this map is invisible to the check, which is exactly the
 * failure mode that produced it — so the map is also asserted against the
 * directory listing below. Adding a file to infra/ without adding it here fails.
 */
const TRACKED = [
  ['infra/nginx/api.driftstack.dev.conf', '/etc/nginx/sites-enabled/api.driftstack.dev.conf'],
  ['infra/nginx/fleet.driftstack.dev.conf', '/etc/nginx/sites-enabled/fleet.driftstack.dev.conf'],
  ['infra/systemd/driftstack-api.service', '/etc/systemd/system/driftstack-api.service'],
  [
    'infra/systemd/driftstack-os-observer.service',
    '/etc/systemd/system/driftstack-os-observer.service',
  ],
  ['infra/os-observer/observer.py', '/opt/driftstack/os-observer/observer.py'],
  // conf.d/, not sites-enabled/ — included by the vhosts above rather than being
  // one. Both were unwatched on this script's FIRST run, which is the argument
  // for the coverage assertion rather than a hand-kept list.
  ['infra/nginx/cloudflare-real-ip.conf', '/etc/nginx/conf.d/cloudflare-real-ip.conf'],
  ['infra/nginx/ws_upgrade_map.conf', '/etc/nginx/conf.d/ws_upgrade_map.conf'],
];

/**
 * Tracked, but NOT deployed to this host — so comparing them here would report
 * drift that does not exist.
 *
 * ⛔ Named individually rather than skipped by a pattern. "Not on production" is
 * a claim about each file, and a pattern would silently absorb a new file that
 * SHOULD be watched — the same silence this script exists to end. Point
 * DRIFT_HOST at staging to check this one there.
 */
const OTHER_HOST = new Map([
  ['infra/nginx/staging.driftstack.dev.conf', 'the staging host (116.203.22.197)'],
]);

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

for (const [repoPath, hostPath] of TRACKED) {
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
const listed = new Set(TRACKED.map(([p]) => p));
const onDisk = execFileSync(
  'git',
  ['ls-files', 'infra/nginx', 'infra/systemd', 'infra/os-observer'],
  { cwd: REPO, encoding: 'utf8' },
)
  .split('\n')
  .filter((l) => l.trim() !== '');
const unwatched = onDisk.filter((p) => !listed.has(p) && !OTHER_HOST.has(p));

for (const [p, where] of OTHER_HOST) {
  stdout.write(`infra-drift: not checked here — ${p} belongs to ${where}\n`);
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

stdout.write(`infra-drift: OK — ${TRACKED.length} artefacts match ${HOST}\n`);
