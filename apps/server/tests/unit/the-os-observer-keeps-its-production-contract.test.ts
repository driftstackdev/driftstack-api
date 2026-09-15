// The passive OS-fingerprint observer (infra/os-observer/observer.py) is the
// only production component the control plane depends on that is written in
// another language and deployed by hand. Until 2026-09-15 it lived ONLY on the
// production host: no source control, no review trail, and a rebuild would have
// lost it. It is vendored now, which is what makes these assertions possible.
//
// ⛔ WHAT MAKES A REGRESSION HERE EXPENSIVE. The observer answers over loopback
// and the control plane trusts it. A change that breaks the contract does not
// throw: `makeOsObserverLookup` sees a 404 or a malformed body, returns `absent`
// or `error`, and every proxy quietly loses its OS chip. `systemctl` still says
// active, `/healthz` still says ok, and nothing in the TypeScript suite notices,
// because none of it executes this file.
//
// These are SOURCE-TEXT pins, which is weaker than running the thing. Stated
// plainly rather than dressed up: CI installs Python only for the SDK job, so a
// behavioural test here would be fragile in the one place it needs to be
// reliable. The invariants below are the ones whose breakage is silent — a text
// pin catches the edit, and the deploy note in infra/README.md carries the
// post-deploy check that catches the rest.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const OBSERVER = resolve(REPO_ROOT, 'infra/os-observer/observer.py');
const UNIT = resolve(REPO_ROOT, 'infra/systemd/driftstack-os-observer.service');

const source = (): string => readFileSync(OBSERVER, 'utf8');

describe('the vendored OS observer keeps the contract production depends on', () => {
  it('CRITICAL the file is vendored at all — it ran for weeks with no source control, and that is the defect this suite exists after', () => {
    expect(existsSync(OBSERVER), 'infra/os-observer/observer.py is missing').toBe(true);
    expect(existsSync(UNIT), 'the systemd unit is missing').toBe(true);
    // Vacuity: an empty or stub file would satisfy every regex below by
    // accident if they were `not.toMatch` style. They are not, but the floor is
    // cheap and the failure it catches (a truncated scp) is real.
    expect(source().length).toBeGreaterThan(2000);
  });

  it('CRITICAL `/sig/<ip>` still answers the OBSERVER port. The control plane calls exactly this path and nothing else; a second vantage was added as a NEW question, and redefining the old one would change every existing reading silently.', () => {
    const s = source();
    // The bare form falls through to OBS_PORT rather than to "any port".
    expect(s).toMatch(/else:\s*\n\s*ip, port = rest, OBS_PORT/);
    expect(s).toMatch(/sig = _sigs\.get\(\(ip, port\)\)/);
  });

  it('CRITICAL records are keyed per (address, PORT). Keying on the address alone lets a 443 SYN overwrite the same host’s 7791 reading — which destroys the comparison the second vantage exists to make, while leaving both lookups answering 200.', () => {
    const s = source();
    expect(s).toMatch(/key = \(ip, port\)/);
    expect(s).toMatch(/_sigs\[key\] = sig/);
    // The pre-2026-09-15 shape must not come back.
    expect(s).not.toMatch(/_sigs\[ip\] = sig/);
  });

  it('CRITICAL an unobserved port is 400, never 404. "We do not watch that port" and "nothing came from that address" are different facts, and a caller that cannot tell them apart reads a typo as a clean negative.', () => {
    const s = source();
    expect(s).toMatch(/self\._send\(\s*400,\s*\{"error": "port is not observed"/);
  });

  it('CRITICAL an unseen or expired record is 404 with a reason and NEVER a default signature — the absent-vs-measured rule the whole feature rests on', () => {
    const s = source();
    expect(s).toMatch(/if sig is None or time\.time\(\) - sig\["seen_at"\] > TTL_SECONDS:/);
    expect(s).toMatch(/"no SYN observed from this address in the window"/);
  });

  it('CRITICAL every record carries `seen_at`. The control plane refuses a record that predates its own dial — without this field a reading cannot be bound to the connection that produced it, and on a rotating residential exit that means reporting a stranger’s machine as the customer’s.', () => {
    expect(source()).toMatch(/"seen_at": int\(time\.time\(\)\)/);
  });

  it('CRITICAL the lookup stays loopback-only and the unit keeps CAP_NET_RAW alone — this process sees every SYN arriving on the observed ports', () => {
    expect(source()).toMatch(/LOOKUP_ADDR = \("127\.0\.0\.1"/);
    const unit = readFileSync(UNIT, 'utf8');
    expect(unit).toMatch(/AmbientCapabilities=CAP_NET_RAW/);
    expect(unit).toMatch(/CapabilityBoundingSet=CAP_NET_RAW/);
    expect(unit).toMatch(/NoNewPrivileges=true/);
  });

  it('the observed set is exactly the observer port and the web port, and the web port is only a valid vantage on a name that is NOT CDN-fronted', () => {
    const s = source();
    expect(s).toMatch(/OBS_PORTS\s*=\s*\{OBS_PORT, WEB_PORT\}/);
    // The reason is load-bearing and belongs next to the code: a 443 SYN on the
    // Cloudflare-fronted name is the edge's, not the proxy's.
    expect(s).toMatch(/fleet\.driftstack\.dev/);
    expect(s).toMatch(/Cloudflare/);
  });
});
