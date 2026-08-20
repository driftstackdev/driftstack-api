// On Windows the simulator connected, showed the page, and then did nothing: stuck at
// "connecting", input ignored, no cookies, and the "Control may not be reaching the
// device" badge up the whole time. That badge was telling the truth.
//
// ── why, exactly ──────────────────────────────────────────────────────────────
//
// The per-session control key reaches the simulator through a Rust process-memory
// vault. Everything about that path is scoped to the SEPARATE app:
//
//   is_simulator_command_caller()   requires app_identifier == SIMULATOR_IDENTIFIER
//                                   ("dev.driftstack.simulator")
//   caller_session                  window_label.strip_prefix("sim-")
//
// The in-process window restored in 907d88b70 runs under the MAIN app
// ("dev.driftstack.gui") with label `simulator-<id>`. It fails BOTH checks, so it can
// never load a key — and `launch_simulator`, which is what populates the vault in the
// first place, is macOS-only and is deliberately not called on Windows at all.
//
// With no key, `controlAuthBoundaryForQuery` fell to its `controlGeneration === null`
// branch, which is the deliberate in-app path: authenticate with the ACCOUNT API KEY.
// That needs a keychain read, and keychain reads are gated in Rust to
// `window_label === "main"` (secret_command_caller_allowed → is_main_gui_command_caller).
// So the window had no usable credential of either kind, and every control call failed.
// One gap, all four symptoms.
//
// ── the fix, and its honest tradeoff ──────────────────────────────────────────
//
// The in-process window reads `ck` from its own query. The separate app must NEVER
// receive a key that way: it is launched as its own PROCESS and anything in argv is
// world-readable in the process list — which is precisely why Rust consumes ck/cke from
// an owner-only 0600 handoff and hands JavaScript only a non-secret generation.
//
// That threat does not exist in-process. The URL never reaches argv or any process
// list; the window renders our own `index.html`, and the device appears as a WebRTC
// video track, so no remote DOM ever executes there. `safeSimulatorSearch` then rewrites
// the URL to an allowlist of `window`/`session`/`cg` in a layout effect — before paint —
// so the key does not persist in history or a copied URL either.
//
// ⚠️ NOT the principled fix, and this is stated rather than glossed. The principled fix
// is a Rust command family for the main app's own simulator windows, mirroring the
// existing vault with the same bounds and zeroization. That is real surgery: a new store
// write path, a widened caller gate, and a store-then-open flow on the TS side. This is
// the small change that makes the product work on Windows today; the vault version is
// still worth doing.
//
// The arms below exist mostly to prove the new branch CANNOT widen the other two.

import { describe, expect, it } from 'vitest';

const { controlAuthBoundaryForQuery, infoFromQuery } =
  await import('../../src/views/SimulatorWindow');
const { safeSimulatorSearch } = await import('../../src/lib/simulator-control-key');

const SESSION = 'agt_abc123';
const BASE = 'https://api.driftstack.dev';
const KEY = 'gck_live_secret';

describe('an in-process simulator needs a credential it can actually reach', () => {
  it('CRITICAL a query with NO generation and NO key still yields the in-app account path. This is the untouched behaviour and the control for everything below — if the new branch had simply replaced this one, every arm here could pass while the macOS in-app path was silently gone.', () => {
    const b = controlAuthBoundaryForQuery(SESSION, null, BASE);
    expect(b.auth, 'the deliberate in-app/account-key path changed shape').toBeNull();
    expect(b.needsNativeLoad).toBe(false);
  });

  it('CRITICAL a query WITH a key and no generation authenticates with that key. This is the Windows fix: without it the window has no credential of any kind, and every control call fails — which is what produced stuck-at-connecting, dead input and no cookies.', () => {
    const b = controlAuthBoundaryForQuery(SESSION, null, BASE, KEY);
    expect(b.needsNativeLoad, 'the in-process path must not wait on a native vault load').toBe(
      false,
    );
    expect(b.auth, 'no auth was produced from a query-carried key').not.toBeNull();
    expect(b.auth?.controlKey, 'the control key did not reach the request header').toBe(KEY);
    expect(b.auth?.baseUrl, 'the handed-off API base was dropped').toBe(BASE);
  });

  it('CRITICAL a query carrying a GENERATION ignores any key and stays fail-closed. This is the separate-app path, and it is the property that makes the new branch safe: a native launch can never be talked into using a query-supplied credential, however one got there.', () => {
    const b = controlAuthBoundaryForQuery(SESSION, 7, BASE, KEY);
    expect(b.needsNativeLoad, 'a generation query stopped loading from the native vault').toBe(
      true,
    );
    expect(
      b.auth?.controlKey,
      'a native-generation query accepted a key from the URL instead of the vault',
    ).not.toBe(KEY);
    expect(b.auth, 'the fail-closed sentinel is gone').not.toBeNull();
    expect(b.auth?.controlKey, 'the sentinel should carry no usable key').toBeNull();
  });

  it('CRITICAL a generation of zero — the malformed marker — stays fail-closed even with a key present. Zero is how a tampered or unparseable generation arrives, and it must not become an opening for the query path.', () => {
    const b = controlAuthBoundaryForQuery(SESSION, 0, BASE, KEY);
    expect(b.needsNativeLoad).toBe(false);
    expect(b.auth, 'a malformed generation stopped being fail-closed').not.toBeNull();
    expect(b.auth?.controlKey, 'a malformed generation accepted the URL key').toBeNull();
  });

  it('CRITICAL the key does not survive in the URL. safeSimulatorSearch rebuilds the query from an ALLOWLIST, so the credential is gone from location.search and from history before paint — which is what keeps it out of screenshots, crash reports and copied URLs.', () => {
    const safe = safeSimulatorSearch(SESSION, null);
    expect(safe, 'the scrubbed URL still carries a control key').not.toContain('ck=');
    expect(safe, 'the scrubbed URL still carries the key value').not.toContain(KEY);
    expect(safe, 'the session was dropped from the safe URL').toContain(`session=${SESSION}`);
    // And with a generation, the non-secret marker is what survives — not the key.
    const withGen = safeSimulatorSearch(SESSION, 7);
    expect(withGen).toContain('cg=7');
    expect(withGen).not.toContain('ck=');
  });

  it('CRITICAL the query is actually PARSED for the key, end to end. Every arm above hands the boundary a key directly, so all of them would pass while `ck` was never read off the URL — which is precisely the state that shipped and produced the bug.', () => {
    const q = infoFromQuery(
      `?window=simulator&ws=wss://lk&token=tok&session=${SESSION}&base=${BASE}&ck=${KEY}`,
    );
    expect(q.controlKey, 'ck was not parsed out of the query').toBe(KEY);
    expect(q.controlGeneration, 'a query with no cg must have a null generation').toBeNull();

    const b = controlAuthBoundaryForQuery(
      q.sessionId,
      q.controlGeneration,
      q.baseUrl,
      q.controlKey,
    );
    expect(b.auth?.controlKey, 'the parsed key did not survive into the auth boundary').toBe(KEY);
  });

  it('CRITICAL an empty key is not a credential. An absent `ck` parses to the empty string, and treating that as a key would send an empty auth header and turn a clean "no credential" into a confusing 401.', () => {
    const b = controlAuthBoundaryForQuery(SESSION, null, BASE, '');
    expect(b.auth, 'an empty key was treated as a usable credential').toBeNull();
  });
});
