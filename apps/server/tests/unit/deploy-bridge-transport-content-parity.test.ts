// Deploy transport liveness guard. Every remote operation in deploy-bridge.sh
// must cross one shared non-interactive, connect-bounded, keepalive-bounded
// wrapper so a half-open SSH/SCP client cannot freeze release ownership.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const BRIDGE = join(REPO, 'scripts', 'deploy-bridge.sh');
const body = readFileSync(BRIDGE, 'utf8');

describe('deploy-bridge SSH/SCP transport liveness', () => {
  it('centralizes one fail-closed option array for both transport wrappers', () => {
    expect(body).toMatch(
      /readonly -a SSH_TRANSPORT_OPTIONS=\(\s*-o BatchMode=yes\s*-o ConnectTimeout=\d+\s*-o ServerAliveInterval=\d+\s*-o ServerAliveCountMax=\d+\s*\)/,
    );
    expect(body).toContain('command ssh "${SSH_TRANSPORT_OPTIONS[@]}" "$@"');
    expect(body).toContain('command scp "${SSH_TRANSPORT_OPTIONS[@]}" "$@"');
  });

  it('keeps connect plus protocol-liveness failure detection below one minute', () => {
    const connect = Number(body.match(/-o ConnectTimeout=(\d+)/)?.[1]);
    const interval = Number(body.match(/-o ServerAliveInterval=(\d+)/)?.[1]);
    const count = Number(body.match(/-o ServerAliveCountMax=(\d+)/)?.[1]);
    expect(connect).toBeGreaterThan(0);
    expect(interval).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(0);
    expect(interval * count).toBeLessThanOrEqual(30);
    expect(connect + interval * count).toBeLessThan(60);
  });

  it('routes every preflight, read, copy, mutation and metadata call through the wrappers', () => {
    // ⛔ REPOINTED. This asserted exactly 6 `run_ssh` occurrences, which is a
    // proxy for the real property and breaks on any honest refactor — it went
    // red when two duplicated inline SSH reads were folded into one helper,
    // i.e. it resisted a change that improved the very thing it guards.
    //
    // The property is BYPASS, not arity: no transport call may skip the wrappers,
    // because they carry ConnectTimeout + ServerAlive liveness detection. So
    // assert `command ssh` / `command scp` appear ONLY inside the wrapper bodies,
    // and keep a floor so a file that lost its calls entirely still fails.
    const wrapperOnly = body.match(/command (?:ssh|scp)\b/g) ?? [];
    expect(wrapperOnly, 'ssh/scp must be invoked only by run_ssh/run_scp').toHaveLength(2);
    expect(
      (body.match(/\brun_ssh(?=\s)/g) ?? []).length,
      'no SSH calls left in the bridge at all — the parse is broken or the file is',
    ).toBeGreaterThanOrEqual(5);
    expect(body.match(/\brun_scp(?=\s)/g)).toHaveLength(1);

    // ⛔ REPOINTED. These pinned the two DB-isolation reads as INLINE
    // `run_ssh root@<ip>` literals. They were folded into one `_db_host_of`
    // helper so the SSH stderr could be captured per host — the reason the
    // pipeline sat broken for seven weeks was that both reads discarded it.
    // Pin the property: each host is still read for its DB, still through the
    // wrapper, and the assignment still exists.
    expect(body).toMatch(/_db_host_of\s+128\.140\.37\.74/);
    expect(body).toMatch(/_db_host_of\s+116\.203\.22\.197/);
    expect(body).toMatch(/PROD_DB_HOST=/);
    expect(body).toMatch(/STAGING_DB_HOST=/);
    // The helper itself must go through the wrapper, or the fold above would be
    // a way to bypass the transport options this whole file exists to protect.
    expect(body).toMatch(/_db_host_of\(\)\s*\{\s*\n\s*run_ssh "root@\$1"/);
    expect(body).toMatch(/PREVIOUS_SHA=\$\(run_ssh "root@\$\{HOST\}"/);
    expect(body).toMatch(/if ! run_scp -q "\$BUNDLE" "root@\$\{HOST\}:\/tmp\/ds-deploy\.bundle"/);
    expect(body).toMatch(/^run_ssh "root@\$\{HOST\}" "set -euo pipefail;/m);
    expect(body).toMatch(
      /run_ssh "root@\$\{HOST\}" "echo '\$EXPECTED_SHORT_SHA' > \/opt\/driftstack\/api\/\.last-good-sha/,
    );
    expect(body).toMatch(/run_ssh "root@\$\{HOST\}" "echo .*\.deploy-history\.log/);
  });

  it('contains no executable bare ssh/scp bypass outside the two wrappers', () => {
    const executableWithoutWrappers = body
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => !line.includes('command ssh "${SSH_TRANSPORT_OPTIONS[@]}" "$@"'))
      .filter((line) => !line.includes('command scp "${SSH_TRANSPORT_OPTIONS[@]}" "$@"'))
      .join('\n');

    expect(executableWithoutWrappers).not.toMatch(
      /(?:^|\$\(|[;|&]\s*|\b(?:if|then|do)\s+!?\s*|!\s+)(?:command\s+)?(?:ssh|scp)(?=\s)/m,
    );
  });

  it('remains valid strict Bash', () => {
    const syntax = spawnSync('bash', ['-n', BRIDGE], { encoding: 'utf8' });
    expect(syntax.stderr).toBe('');
    expect(syntax.status).toBe(0);
  });
});
