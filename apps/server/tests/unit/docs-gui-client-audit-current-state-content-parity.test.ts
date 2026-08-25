// W573.B — drift guard for /docs/gui-client/audit-current-state.md.
// V-236 GUI-client PHASE-1 audit per founder direction 2026-05-06.
// Drift here either re-weights the "GUI client is more complete than
// checklist suggested" headline finding, drops a P0/P1/P2/T3 audit-
// dimension verdict, or unsets the 2-item P0 (profile-create + tier-
// aware enforcement) + 1-backend-dep launch-blocker triage.
//
//   • V-236. PHASE 1. 13 audit dimensions.
//   • Headline: GUI client more complete than launch checklist.
//   • P0: profile-create form + tier-aware enforcement + backend
//     /v1/account/me dep.
//   • P1: rust-toolchain.toml pin + self-hosted titlebar conditional.
//   • P2: WebRTC + auto-update + first-run wizard + UX polish.
//   • T3 founder-ack: API-key at-rest + telemetry + distribution.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/gui-client/audit-current-state.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W573.B /docs/gui-client/audit-current-state.md content parity', () => {
  const body = read(LIB);

  it('Header + V-236 PHASE-1 + 13-dimension + Tauri-2.0-2.1 + Rust-1.95 + React-18.3 + Vite-5.4 framing pinned', () => {
    expect(body).toMatch(/^# GUI client audit — current state vs file 128 spec$/m);
    expect(body).toMatch(
      /\*\*V-236 — PHASE 1 of GUI client launch arc per founder direction 2026-05-06\.\*\*/,
    );
    expect(body).toMatch(/Walks `apps\/gui-client\/` systematically\./);
    expect(body).toMatch(
      /For each of the 13 audit dimensions: current state, gap vs file 128 spec, recommended priority for closure/,
    );
    expect(body).toMatch(
      /\(P0 launch-blocking \/ P1 launch-recommended \/ P2 post-launch \/ T2-T3-surface for items needing founder ack\)\./,
    );
    expect(body).toMatch(
      /The headline finding: \*\*the GUI client is more complete than the launch checklist suggested\.\*\*/,
    );
    expect(body).toMatch(
      /Sessions \/ profiles \(read \+ delete\) \/ proxies \/ recordings \/ connectivity \/ settings all wire to live Driftstack API endpoints\./,
    );
    expect(body).toMatch(/Auth chain is live; brand consistency is locked\./);
    expect(body).toMatch(/The remaining launch-blockers are narrow \+ concrete\./);
    expect(body).toMatch(/### 1\. Tauri framework version \+ Rust toolchain pin/);
    expect(body).toMatch(/\*\*Current:\*\* Tauri 2\.0–2\.1/);
    expect(body).toMatch(
      /`@tauri-apps\/cli@\^2\.1\.0` in `package\.json:18`; `tauri = "2\.0"` in `Cargo\.toml:18`/,
    );
    expect(body).toMatch(/Rust edition 2021\./);
    expect(body).toMatch(
      /`README\.md` mentions "Rust 1\.95\+" as soft requirement; no `rust-toolchain\.toml` for hard pin\./,
    );
    expect(body).toMatch(
      /\*\*Priority:\*\* \*\*P1\*\* — small \(5 min\): add `rust-toolchain\.toml` with `\[toolchain\] channel = "1\.95\.0"`\./,
    );
    expect(body).toMatch(/### 2\. Frontend stack/);
    expect(body).toMatch(
      /\*\*Current:\*\* React 18\.3 \+ TypeScript 5\.7 \(strict\) \+ Tailwind 3\.4 \+ Vite 5\.4\./,
    );
  });

  it('Dimensions 3-7 (runnable + auth + sessions + GUI streaming + profile mgmt) framing pinned', () => {
    expect(body).toMatch(/### 3\. Runnable today/);
    expect(body).toMatch(/- `npm run dev` → Vite browser shell at `http:\/\/localhost:1420`\./);
    expect(body).toMatch(/All 10 views route correctly in browser-only mode/);
    expect(body).toMatch(
      /- `npm run tauri:dev` → native macOS desktop window with hot reload against the same Vite backend\./,
    );
    expect(body).toMatch(/### 4\. Auth flow state/);
    expect(body).toMatch(/\*\*Current:\*\* API-key auth \(no web session\)\./);
    expect(body).toMatch(
      /`client\.ts:16–19` builds `Driftstack` SDK client from `apiKey` \+ `baseUrl`\./,
    );
    expect(body).toMatch(
      /Settings persisted via Tauri Store plugin to `~\/Library\/Application Support\/dev\.driftstack\.gui\/settings\.json`/,
    );
    expect(body).toMatch(/API key masked in Settings UI but \*\*stored plaintext on disk\*\*/);
    expect(body).toMatch(
      /\(acknowledged in `settings\.ts:6–8` with future keychain upgrade queued for "GUI8"\)/,
    );
    expect(body).toMatch(
      /\*\*Priority:\*\* \*\*T3 founder-ack required\*\* — security\/customer-data architecture decision\./,
    );
    expect(body).toMatch(
      /Three approaches: \(a\) macOS Keychain via `@tauri-apps\/plugin-stronghold` or similar,/,
    );
    expect(body).toMatch(
      /\(b\) encrypted-at-rest with OS-derived key, \(c\) keep plaintext \+ document explicitly\./,
    );
    expect(body).toMatch(/### 5\. Session management/);
    expect(body).toMatch(
      /\*\*Current:\*\* Fully wired to `\/v1\/sessions\/\*` via `@driftstack\/sdk`\./,
    );
    expect(body).toMatch(
      /- `SessionsView\.tsx:37–91` — `client\.sessions\.list\(\)` with 5s auto-poll/,
    );
    expect(body).toMatch(
      /- `LiveSessionView\.tsx:114` — `client\.sessions\.capture\(sessionId, \{ kind: 'screenshot' \}\)` polled at 500ms\./,
    );
    expect(body).toMatch(/- `client\.sessions\.getState\(sessionId\)` for URL \+ title metadata\./);
    expect(body).toMatch(
      /- `client\.sessions\.interact\(\)` for intent actions \(scroll, key\) at line 225\./,
    );
    expect(body).toMatch(
      /- Coordinate-level input → `\/v1\/sessions\/:id\/gui-input` \(separate endpoint, requires `gui_control` scope\)/,
    );
    expect(body).toMatch(/### 6\. GUI streaming/);
    expect(body).toMatch(
      /\*\*Current:\*\* Polling-based base64 PNG over HTTP\/JSON via `client\.sessions\.capture\(\)`\./,
    );
    expect(body).toMatch(
      /500ms frame interval; ~50–200 KB per frame on the wire; ~1s end-to-end latency floor/,
    );
    expect(body).toMatch(/Tap marker UX shows input registered for 600ms \(line 470\)\./);
    expect(body).toMatch(
      /All frames are live captures from real WebKit fork driver sessions — no mock data path\./,
    );
    expect(body).toMatch(/\*\*Priority:\*\* \*\*P2\*\* \(post-launch\)\./);
    expect(body).toMatch(/### 7\. Profile management/);
    expect(body).toMatch(
      /\*\*Current:\*\* Read \+ delete fully wired to `\/v1\/profiles\/\*` via `@driftstack\/sdk`\./,
    );
    expect(body).toMatch(
      /- `ProfilesView\.tsx:39–92` — `client\.profiles\.iterate\(\{ limit: 50 \}\)` for listing \(async iterator\)/,
    );
    expect(body).toMatch(
      /\*\*Gap:\*\* Create-profile button is stubbed: `aria-disabled="true"` at `ProfilesView\.tsx:118`\./,
    );
    expect(body).toMatch(/Comment notes "pending dialog for name \+ archetype picker\."/);
    expect(body).toMatch(
      /\*\*Priority:\*\* \*\*P0 launch-blocking\.\*\* Manual-tier customers expect profile management end-to-end in the GUI\./,
    );
    expect(body).toMatch(
      /Estimated ~1-2hr Tier-1 work: form modal with name \+ archetype picker, calls existing `\/v1\/profiles POST`, refreshes list on success\./,
    );
  });

  it('Dimensions 8-13 + Section-14 endpoint + P0/P1/P2/T3 summaries + Conclusion framing pinned', () => {
    expect(body).toMatch(/### 8\. Tier-aware enforcement/);
    // V-866 — §8 recorded tier-aware enforcement as an unbuilt P0 launch-blocker.
    // It shipped: SessionsView reads concurrent_session_cap and greys the
    // New-session button, ProfilesView mirrors that on Launch, and V-239 gates
    // New/Duplicate/Import on profile_cap. One negative per stale sentence, so a
    // partial restoration cannot pass.
    expect(body, 'the not-implemented verdict is gone').not.toMatch(
      /\*\*Current:\*\* Not implemented\. No tier reading from API/,
    );
    expect(body, 'and the claim the GUI does not pre-empt the 402').not.toMatch(
      /the GUI just doesn't show the cap or pre-empt the 402 response\./,
    );
    expect(body, 'and the gap describing the customer meeting a 402 banner').not.toMatch(
      /server returns `402 ConcurrencyLimitExceeded`, GUI shows error banner\./,
    );
    // Asserted positively, per V-794: state what IS true rather than freezing an
    // absence. Server-side enforcement is unchanged and still worth pinning.
    expect(body, 'the section records the shipped state').toMatch(
      /\*\*Current \(V-866\): SHIPPED\./,
    );
    expect(body, 'and still credits the server-side half').toMatch(
      /Server-side V-073 enforcement\s*is unchanged/,
    );
    // V-866 continued — the same §8 sentences, frozen a second time in this
    // block. The first grep found only the earlier copy; this is the fourth time
    // this arc that a claim lived in a spot the obvious search missed, and the
    // second time within a single file.
    expect(body, 'the file-128 behaviour is described as shipped, not owed').toMatch(
      /is what ships\./,
    );
    expect(body, 'the P0 label is gone — it was closed long before this').not.toMatch(
      /\*\*Priority:\*\* \*\*P0 launch-blocking\*\* for Manual-tier UX\./,
    );
    expect(body, 'and the estimate with it').not.toMatch(/Estimated ~2-3hr Tier-1 work:/);
    expect(body, 'the four planned steps are recorded as done').toMatch(
      /all four are in the GUI today:/,
    );
    expect(body).toMatch(/1\. Read tier \+ concurrent cap on settings load/);
    expect(body).toMatch(
      /2\. Display "X \/ Y concurrent sessions" in `SessionsView\.tsx` header\./,
    );
    expect(body).toMatch(/3\. Gate Spawn button on `active < cap`\./);
    expect(body).toMatch(/### 9\. Self-hosted variant/);
    expect(body).toMatch(/\*\*Current:\*\* Single build, dual-mode via runtime config\./);
    expect(body).toMatch(
      /The first-run wizard asks Cloud or Self-hosted, pins Cloud to `https:\/\/api\.driftstack\.dev`/,
    );
    expect(body).toMatch(
      /The titlebar derives `cloud` versus `self-hosted` from the configured hostname/,
    );
    expect(body).toMatch(/base-URL-scoped OS keychain entries/);
    expect(body).toMatch(/### 10\. Update mechanism/);
    expect(body).toMatch(/\*\*Current:\*\* Implemented with `tauri-plugin-updater`\./);
    expect(body).toMatch(/`src\/lib\/updater\.ts` performs the programmatic startup check/);
    expect(body).toMatch(/the updater accepts only signed manifests\./);
    expect(body).not.toMatch(/No auto-update mechanism|Add when first signed release is cut/);
    expect(body).toMatch(/### 11\. Telemetry \/ Sentry/);
    expect(body).toMatch(
      /\*\*Current:\*\* Not implemented\. No `@sentry\/\*` imports, no error reporting, no telemetry crates in `Cargo\.toml`\./,
    );
    expect(body).toMatch(
      /\*\*Priority:\*\* \*\*T3 founder-ack required\.\*\* Customer-data architecture decision\./,
    );
    expect(body).toMatch(
      /Driftstack-cloud API has Sentry \(V-198 \/ D-034\); should the GUI client also report\?/,
    );
    expect(body).toMatch(/### 12\. Anonymity policy compliance \(V-211 mirror\)/);
    expect(body).toMatch(
      /\*\*Current:\*\* \*\*COMPLIANT\.\*\* No founder name in customer-facing strings\./,
    );
    expect(body).toMatch(/No external-tooling references in any visible text\./);
    expect(body).toMatch(/Internal developer comments reference "the founder" generically/);
    expect(body).toMatch(/### 13\. Brand consistency \(`V-219\*` mirror\)/);
    expect(body).toMatch(
      /\*\*Current:\*\* \*\*LOCKED \+ COMPLIANT\.\*\* All tokens aligned with the Driftstack brand:/,
    );
    expect(body).toMatch(/- \*\*Oxblood accent\*\* — `#a83b4d` \(`tailwind\.config\.ts:37`\)/);
    expect(body).toMatch(
      /- \*\*Geist Sans body font\*\* — `tailwind\.config\.ts:54–62` with system-ui fallback\./,
    );
    expect(body).toMatch(
      /- \*\*Berkeley Mono technical accents\*\* — `tailwind\.config\.ts:67–75` via `\.mono` class\./,
    );
    expect(body).toMatch(
      /- \*\*Lowercase "driftstack" wordmark\*\* — `App\.tsx:141` renders sentence-case in titlebar\./,
    );
    expect(body).toMatch(/## Section 14 — Endpoint contracts the GUI needs/);
    expect(body).toMatch(
      /\*\*what endpoint returns the calling account's tier \+ concurrent-session cap\?\*\*/,
    );
    expect(body).toMatch(/- `\/v1\/sessions GET` already returns the active list;/);
    expect(body).toMatch(
      /- `\/v1\/account` — exists\? Need to verify in `apps\/server\/src\/routes\/`\./,
    );
    expect(body).toMatch(/- A new `\/v1\/account\/me` or `\/v1\/account\/limits` endpoint\./);
    expect(body).toMatch(/\*\*P0 dependency chain:\*\*/);
    expect(body).toMatch(/1\. Verify whether `\/v1\/account` or equivalent exists\./);
    expect(body).toMatch(
      /2\. If not, add minimal `\/v1\/account\/me` endpoint returning `\{ tier, concurrent_cap, profiles_used, profiles_cap \}`\./,
    );
    expect(body).toMatch(/3\. Wire SDK accessor\./);
    expect(body).toMatch(/4\. Consume in GUI's SessionsView\./);
    expect(body).toMatch(/## P0 launch-blocking summary/);
    expect(body).toMatch(
      /\| 1\s+\| Profile create form modal\s+\| ~1-2hr Tier-1\s+\| None \(`\/v1\/profiles POST` exists\)\s+\|/,
    );
    expect(body).toMatch(
      /\| 2\s+\| Tier-aware enforcement display\s+\| ~2-3hr Tier-1\s+\| Verify `\/v1\/account` shape; may need backend addition \|/,
    );
    expect(body).toMatch(
      /\| 3\s+\| Backend: confirm or add `\/v1\/account\/me` \| ~1hr Tier-1 in `apps\/server` \| Blocks #2\s+\|/,
    );
    expect(body).toMatch(/## P1 launch-recommended summary/);
    expect(body).toMatch(/\| 1\s+\| `rust-toolchain\.toml` pin\s+\| ~5min\s+\|/);
    expect(body).toMatch(
      /\| 2\s+\| Self-hosted titlebar label conditional on URL \| ~30min Tier-1\s+\|/,
    );
    expect(body).toMatch(/## P2 post-launch summary/);
    expect(body).toMatch(
      /- WebRTC streaming \(depends on file 36 server-side architecture work\)\./,
    );
    expect(body).toMatch(
      /- Auto-update mechanism \(Sparkle \/ Tauri Updater \/ GitHub Releases\)\./,
    );
    expect(body).toMatch(/- First-run setup wizard \(cloud vs self-hosted choice\)\./);
    expect(body).toMatch(/## T3 founder-ack-required surfaces/);
    expect(body).toMatch(
      /- \*\*API key at-rest storage\*\* — keychain vs encrypted file vs plaintext \+ acknowledged\./,
    );
    expect(body).toMatch(
      /- \*\*Telemetry posture\*\* — cloud-reports-to-Sentry vs self-hosted-no-reporting vs both-with-opt-in\./,
    );
    expect(body).toMatch(
      /- \*\*Distribution mechanism\*\* \(when reaching PHASE 3\) — signed `\.dmg` \/ Sparkle \/ GitHub Releases \/ etc\./,
    );
    expect(body).toMatch(/## Conclusion/);
    expect(body).toMatch(
      /The GUI client is in much better shape than the founder direction's checklist suggested\./,
    );
    expect(body).toMatch(
      /Sessions \/ profiles \(read\+delete\) \/ proxies \/ recordings \/ connectivity \/ settings are live against real API endpoints;/,
    );
    expect(body).toMatch(/brand \+ anonymity are locked; auth \+ storage paths work\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  // V-1139 — this document says, in §4, that customer API keys are stored in
  // PLAINTEXT ON DISK. That was true when it was written and is false now: the GUI
  // stores the key in the OS keychain via `keyring-rs`, scoped per baseUrl, and
  // purges both historical plaintext shapes out of settings.json on first load.
  //
  // The only thing standing between a reader and that retired claim is the
  // HISTORICAL SNAPSHOT banner V-801 added at the top. Nothing pinned the banner —
  // 117 assertions in this file froze the body, and none of them held the one
  // paragraph that makes the body safe to read. Delete the banner and the document
  // silently becomes a current-state claim that Driftstack keeps paid license keys
  // in the clear.
  it('CRITICAL the historical-snapshot banner is present. Every "Current:" heading below it describes 2026-05-06, and §4 in particular still reports plaintext at-rest storage of customer API keys — a claim the shipped keychain implementation retired. Without this paragraph the document reads as a live security posture that is both false and alarming.', () => {
    const body = read(LIB);
    expect(body, 'the historical-snapshot banner was removed').toMatch(/HISTORICAL SNAPSHOT/);
    expect(body, 'the as-of qualifier on every Current: heading was removed').toMatch(
      /means current _as of the date in the\s*\n?>?\s*line above_, not today/,
    );
    expect(body, 'the banner no longer records that the outstanding items shipped').toMatch(
      /has since shipped/,
    );
  });

  it('CRITICAL every file the banner cites as evidence still exists. The banner earns its authority by saying each item was "confirmed to exist in the tree rather than assumed" — so a path that moved turns the evidence back into an assertion, which is exactly what it was written to stop being.', () => {
    const body = read(LIB);
    const banner = body.slice(
      body.indexOf('HISTORICAL SNAPSHOT'),
      body.indexOf('\n\n', body.indexOf('has since shipped')),
    );
    const cited = [...banner.matchAll(/`([a-z][\w./-]+\.(?:tsx|toml|json|ts))`/g)].map(
      (m) => m[1] ?? '',
    );
    expect(cited.length, 'no evidence paths parsed out of the banner').toBeGreaterThanOrEqual(5);

    const missing = cited.filter((rel) => !existsSync(resolve(REPO_ROOT, 'apps/gui-client', rel)));
    expect(
      missing.sort(),
      'banner evidence paths that no longer resolve under apps/gui-client',
    ).toEqual([]);
  });

  it('CRITICAL the keychain claim the banner rests on is still true in source. If the GUI ever falls back to persisting the key in settings.json, §4 stops being historical and becomes accurate again — and this file should go red rather than let a retired security gap quietly return.', () => {
    const settings = read(resolve(REPO_ROOT, 'apps/gui-client/src/lib/settings.ts'));
    expect(settings, 'the OS-keychain load path is gone').toMatch(/async function keychainLoad\(/);
    expect(settings, 'the OS-keychain save path is gone').toMatch(/async function keychainSave\(/);
    expect(settings, 'the plaintext purge on load is gone').toMatch(
      /Purge BOTH historical plaintext shapes/,
    );
  });
});
