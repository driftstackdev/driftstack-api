// V-857 — the desktop GUI told customers to wait for a server update that had
// already shipped.
//
// `ProxiesView`'s proxy card rendered a line saying exit geo was unavailable
// because a server update was pending. The two causes its surrounding comments
// named — the native `proxy_exit_probe` command not being built, and
// `/v1/egress/echo` not being deployed — both landed on 2026-06-12 in
// `13a5e4bbc` ("E-2 complete"). The JS half went in the same day, in a commit
// whose own message says it lights up once the native side lands. It landed.
// Nobody came back to the wording.
//
// The line renders in exactly one state: the proxy is reachable AND
// authenticated, but the exit probe returned null. That is the case where the
// customer's own proxy completed a SOCKS5 handshake and then failed to carry a
// round-trip to the echo endpoint — a real, customer-fixable fault, and the one
// state where a useful diagnostic mattered most. It was labelled as our pending
// work instead, so the reader's correct response was to wait for a release that
// was already out.
//
// Nothing pinned the wording, which is why it lasted two months. Not for want
// of tests: fifteen files under `apps/gui-client/tests/` exercise this view, and
// two of them — `proxies-view-test-all-vpn-and-stale-exit` and
// `profiles-view-stale-exit-geo` — are about exit-geo specifically. They assert
// WHEN the line is shown and gate it on probe health; none asserts what it says.
// A surface can be well covered behaviourally and still carry an untrue
// sentence, which is the same gap V-843 found on the crypto documentation page.
//
// This guard derives both dependencies from their own sources instead of
// restating that they exist, so it can contradict its author. If either is ever
// removed the liveness arms fail — and at that point the blunt wording this
// file installs becomes wrong in the other direction, so whoever removes one
// has to come here and decide what the card should say.

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const TAURI = resolve(REPO_ROOT, 'apps/gui-client/src-tauri/src/lib.rs');
const ECHO_ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/egress-echo.ts');
const VIEW = resolve(REPO_ROOT, 'apps/gui-client/src/views/ProxiesView.tsx');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/proxies.ts');

/**
 * Claim shapes that tell a reader a dependency of the exit-geo probe has not
 * shipped. Deliberately specific: a broad match on "deferred" or "not yet"
 * would fire on the many comments in this view that describe runtime
 * sequencing rather than unbuilt work.
 */
const PENDING_CLAIMS: readonly RegExp[] = [
  /server update pending/i,
  /not live yet/i,
  /is ?n[o']?t built yet/i,
  /pre-native-command/i,
];

/** The names Tauri exposes to the JS side, read out of the generate_handler! block. */
function registeredCommands(): string[] {
  const src = readFileSync(TAURI, 'utf8');
  const start = src.indexOf('tauri::generate_handler![');
  const end = src.indexOf(']', start);
  return src
    .slice(start, end)
    .split('\n')
    .slice(1)
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => /^[a-z_][a-z0-9_]*$/.test(l));
}

describe('V-857 the GUI does not blame a shipped server for a failed probe', () => {
  it('CRITICAL every source this guard reasons over parses as real content. The arms below are membership and absence checks, so an empty read would satisfy all of them at once and report an honest card over nothing — the failure mode this sweep kept finding in other guards.', () => {
    expect(registeredCommands().length, 'native commands registered with Tauri').toBeGreaterThan(8);
    expect(statSync(ECHO_ROUTE).size, 'the echo route module').toBeGreaterThan(500);
    expect(statSync(VIEW).size, 'the proxies view').toBeGreaterThan(10_000);
    expect(statSync(LIB).size, 'the proxies lib').toBeGreaterThan(5_000);
  });

  it('CRITICAL the native exit probe is both registered and defined. This is the first of the two things the old wording said was missing. If it is ever removed, the card must go back to telling the customer the capability is unavailable rather than blaming their proxy — this arm is what forces that conversation.', () => {
    expect(registeredCommands(), 'proxy_exit_probe exposed to the JS side').toContain(
      'proxy_exit_probe',
    );
    expect(readFileSync(TAURI, 'utf8'), 'and implemented, not just listed').toMatch(
      /async fn proxy_exit_probe\(/,
    );
  });

  it('CRITICAL the echo endpoint the probe targets is registered on the server. The second thing the old wording said was missing. Unauthenticated by design and IP-rate-limited, but registered — so a null exit result has not been attributable to a missing route since it landed.', () => {
    expect(readFileSync(ECHO_ROUTE, 'utf8'), 'the route registration itself').toMatch(
      /app\.get\('\/v1\/egress\/echo'/,
    );
  });

  it('CRITICAL no GUI source claims either dependency is still pending, now that both arms above prove they are not. This is the arm that would have caught the original defect: the claim outlived its cause by two months in four places at once, because fixing one copy and missing the others is how every one of these survives.', () => {
    const offenders: string[] = [];
    for (const file of [VIEW, LIB]) {
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        for (const claim of PENDING_CLAIMS) {
          if (claim.test(line)) offenders.push(`${file.split('apps/')[1] ?? file}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      'this text says a dependency of the exit-geo probe has not shipped, but the arms above read it out of its own source:',
    ).toEqual([]);
  });

  it('CRITICAL the null-exit line describes the probe rather than a release. A customer sees it only when their proxy connected and authenticated but carried no round-trip, so it must point at the probe outcome; anything that points at our release schedule tells them to wait instead of to look.', () => {
    const view = readFileSync(VIEW, 'utf8');
    expect(view, 'the honest null-exit wording').toContain(
      'exit geo unavailable — the probe did not complete',
    );
  });
});
