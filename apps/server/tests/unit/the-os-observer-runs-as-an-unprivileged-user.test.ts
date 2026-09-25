// Security sweep E-24 (2026-09-24). The passive OS observer sniffs every SYN
// arriving on its ports — it parses packets from the internet — and its unit
// had no User= or DynamicUser=, so it ran as uid 0. CapabilityBoundingSet
// already strips CAP_DAC_OVERRIDE, but a uid-0 process can still read every
// root-owned file through ordinary permissions (SSH host keys, root-only
// config), so a bug in the parser would have exposed them.
//
// The fix is in the repo's unit file (infra/systemd/driftstack-os-observer.service,
// installed by hand at /etc/systemd/system/ per infra/README.md): a transient
// unprivileged user (DynamicUser=yes) that keeps CAP_NET_RAW as an AMBIENT
// capability — the one thing the raw socket needs — plus InaccessiblePaths for
// the directories that hold the host's secrets.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const UNIT = readFileSync(
  resolve(REPO_ROOT, 'infra/systemd/driftstack-os-observer.service'),
  'utf8',
);
const OBSERVER = readFileSync(resolve(REPO_ROOT, 'infra/os-observer/observer.py'), 'utf8');

/** Every `Key=value` directive in the [Service] section, comments dropped. */
function serviceDirectives(unit: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let section = '';
  for (const raw of unit.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? '';
      continue;
    }
    if (section !== 'Service') continue;
    const eq = line.indexOf('=');
    if (eq > 0) out.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return out;
}

const directives = serviceDirectives(UNIT);
const values = (key: string): string[] => directives.filter(([k]) => k === key).map(([, v]) => v);

describe('the OS observer runs as an unprivileged user', () => {
  it('reads the unit it guards', () => {
    expect(values('ExecStart').length, 'no ExecStart= parsed from the [Service] section').toBe(1);
  });

  it('CRITICAL the service does not run as root: DynamicUser=yes, and no User= names root', () => {
    expect(values('DynamicUser')).toEqual(['yes']);
    for (const user of values('User')) {
      expect(['root', '0']).not.toContain(user);
    }
  });

  it('CRITICAL it keeps CAP_NET_RAW, as an AMBIENT capability — the raw socket fails without it once the process is not root', () => {
    expect(values('AmbientCapabilities')).toEqual(['CAP_NET_RAW']);
    expect(values('CapabilityBoundingSet')).toEqual(['CAP_NET_RAW']);
    expect(values('NoNewPrivileges')).toEqual(['true']);
  });

  it('CRITICAL the directories holding the host secrets are inaccessible to it', () => {
    const hidden = values('InaccessiblePaths')
      .flatMap((v) => v.split(/\s+/))
      .map((p) => p.replace(/^-/, ''));
    expect(hidden).toContain('/opt/driftstack/api');
    expect(hidden).toContain('/etc/ssh');
    expect(values('ProtectHome')).toEqual(['true']);
    expect(values('ProtectSystem')).toEqual(['strict']);
  });

  it('every port the observer binds is unprivileged, so it needs no CAP_NET_BIND_SERVICE as a non-root user', () => {
    const defaults = [
      ...OBSERVER.matchAll(/os\.environ\.get\("DS_OBS_(?:PORT|LOOKUP_PORT)", "(\d+)"\)/g),
    ].map((m) => Number(m[1]));
    // Non-vacuity: both the acceptor port and the lookup port were found.
    expect(defaults).toHaveLength(2);
    for (const port of defaults) expect(port).toBeGreaterThan(1023);
    expect(values('AmbientCapabilities').join(' ')).not.toContain('CAP_NET_BIND_SERVICE');
  });
});
