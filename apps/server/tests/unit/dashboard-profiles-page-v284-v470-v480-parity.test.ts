// W752 — customer-dashboard /profiles.astro V-136 (tier-cap source)
// + V-284 (live-fetch) + V-312/V-313 (snapshot/clone) + V-470 (snapshot
// inline form) + V-480 (import) parity. Seventy-eighth in the cross-SDK
// drift-guard series.
//
// /profiles is one of two surfaces (other: /sessions) where the
// tier-cap enforcement is visible to customers. The page also wires
// 5 destructive/state-changing actions (create + delete + clone +
// snapshot + export + import) — drift here would let the dashboard
// drift from the server-side tier-cap enforcement.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/profiles.astro');

describe('W752 dashboard /profiles page V-284 + V-470 + V-480 parity', () => {
  it('profiles.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-136 + V-284 anchor framing pinned. The "V-136 — uses the locked PROFILES_PER_TIER constant from @driftstack/api-types as single source of truth" + "V-284 — progressive-enhancement wiring" wording threads BOTH the tier-cap source + the live-fetch anchor.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /V-136 — uses the locked PROFILES_PER_TIER constant from\s*\n\/\/ @driftstack\/api-types as single source of truth\./,
    );
    expect(p).toMatch(/V-284 — progressive-enhancement wiring\. Reads ds_web_session_token,/);
    expect(p).toMatch(/fetches \/v1\/profiles \+ \/v1\/account\/me to compute live count vs tier/);
  });

  it('CRITICAL PROFILES_PER_TIER + archetypeDisplayLabel + AccountTier imported from @driftstack/api-types. Drift to inlining would let dashboard tier-cap drift from server enforcement.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/PROFILES_PER_TIER/);
    expect(p).toMatch(/archetypeDisplayLabel/);
    expect(p).toMatch(/type AccountTier/);
    expect(p).toMatch(/from\s*'@driftstack\/api-types'/);
  });

  it('CRITICAL 7-tier display order pinned — solo_manual + team_manual + agency_manual + api_starter + api_builder + api_scale + enterprise. Drift to dropping a tier (e.g. enterprise) would silently hide the upgrade-path from customers about to hit their limit.', () => {
    const p = read(PAGE);

    for (const tier of [
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
      'enterprise',
    ]) {
      expect(p, `tier ${tier}`).toMatch(new RegExp(`id: '${tier}'`));
    }
  });

  it("CRITICAL persistent-identity framing pinned — 'Persistent identity slots that survive across sessions. Each profile carries its own cookies, localStorage, and last-used timestamp. Sessions can be created against a profile or anonymously.' Drift would lose the load-bearing 'why profiles exist' framing.", () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /Persistent identity slots that survive across sessions\. Each profile carries its own\s*\n\s+cookies, localStorage, and last-used timestamp\. Sessions can be created against a profile\s*\n\s+or anonymously\./,
    );
  });

  it('CRITICAL atLimit gate handles "custom" tier sentinel — `profileLimit !== \'custom\' && profileCount >= profileLimit`. Drift to a bare comparison would compare strings to numbers + falsely trip the limit-reached banner for enterprise customers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const atLimit = profileLimit !== 'custom' && profileCount >= profileLimit;/);
    expect(p).toMatch(
      /const limitDisplay = profileLimit === 'custom' \? 'Custom' : profileLimit\.toString\(\);/,
    );
  });

  it('CRITICAL V-331b act-as header passthrough pinned in authedFetch. The \'V-331b — propagate the active "act as" team-owner selection so reads + writes scope to the chosen owner\' wording is the load-bearing RBAC framing.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ V-331b — propagate the active "act as" team-owner/);
    expect(p).toMatch(/selection so reads \+ writes scope to the chosen owner\./);
    expect(p).toMatch(
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n\s+\? window\.driftstackActAsHeaders\(\)\s*\n\s+: \{\}\),/,
    );
  });

  it('CRITICAL delete-confirm framing pinned (L4b recycle bin) — recycle bin + 30-day auto-purge + still-counts-toward-limit-until-purged (#10/#13) + restore-is-in-the-desktop-app/API (#11: no web restore UI) + bound-sessions-fail consequence; stale permanent-deletion + fictional force=true framing removed (delete is soft; no force flag on profile DELETE). The OLD "restore it within 30 days" copy is removed — the dashboard has no restore UI, so it must not promise one.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/It moves to the recycle bin/);
    expect(p).toMatch(/permanently purged after 30 days/);
    expect(p).toMatch(/still counts toward your profile limit/);
    expect(p).toMatch(/use the desktop app or the API/);
    expect(p).toMatch(/Sessions currently using this profile will fail/);
    // #11 — no in-dashboard restore, so the broken "restore within 30 days" promise is gone.
    expect(p).not.toMatch(/restore it within 30 days/);
    expect(p).not.toMatch(/This cannot be undone/);
    expect(p).not.toMatch(/force=true/);
  });

  it('CRITICAL DELETE /v1/profiles/<id> + 204-or-error handling. Drift to a 200-only check would let the 204-on-success response trigger a false-positive error path.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /authedFetch\('\/v1\/profiles\/' \+ encodeURIComponent\(id\), \{ method: 'DELETE' \}\)/,
    );
    expect(p).toMatch(/if \(!r\.ok && r\.status !== 204\) \{/);
  });

  it('CRITICAL V-313 clone-button framing pinned. The \'V-313 — clone-button wiring. POSTs /v1/profiles/:id/clone with an empty body; server auto-derives "${source} (copy)" / (copy 2) / ... naming\' framing is the load-bearing copy-naming contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-313 — clone-button wiring\. POSTs \/v1\/profiles\/:id\/clone with/);
    expect(p).toMatch(/an empty body; server auto-derives "\$\{source\} \(copy\)" \/ \(copy 2\)/);
    expect(p).toMatch(/\/ \.\.\. naming\./);
    expect(p).toMatch(
      /authedFetch\('\/v1\/profiles\/' \+ encodeURIComponent\(id\) \+ '\/clone', \{\s*\n\s+method: 'POST',\s*\n\s+body: JSON\.stringify\(\{\}\),\s*\n\s+\}\)/,
    );
  });

  it("CRITICAL V-312 + V-470 snapshot inline-form framing pinned. The 'V-470 — snapshot capture flow now uses an inline form instead of window.prompt. The form is shared across all profile rows; a single state variable tracks which profile is being captured.' explains WHY the form is module-scope.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-470 — snapshot capture flow now uses an inline form instead/);
    expect(p).toMatch(/of window\.prompt\. The form is shared across all profile rows;/);
    expect(p).toMatch(/a single state variable tracks which profile is being captured\./);
    expect(p).toMatch(/let snapshotPending = null;/);
  });

  it('CRITICAL snapshot form prompts for label + description; label required. Drift to dropping the label-required gate would let server reject the request after submit + leave the form in a stuck state.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /if \(!label\) \{\s*\n\s+if \(snapshotError\) \{\s*\n\s+snapshotError\.textContent = 'Label is required\.';/,
    );
    expect(p).toMatch(
      /const payload = \{ label: label \};\s*\n\s+if \(description\) payload\.description = description;/,
    );
  });

  it("CRITICAL POST /v1/profiles/<id>/snapshots used for snapshot capture (NOT /v1/snapshots). The per-profile-namespaced URL is what makes the snapshot inherit the source-profile's account context.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /authedFetch\('\/v1\/profiles\/' \+ encodeURIComponent\(pendingId\) \+ '\/snapshots', \{\s*\n\s+method: 'POST',\s*\n\s+body: JSON\.stringify\(payload\),\s*\n\s+\}\)/,
    );
  });

  it("CRITICAL V-480 Export pinned. The 'V-480 — Export button: GETs the envelope, triggers a JSON download via Blob + a synthetic anchor click. No server-side attachment headers needed; the dashboard owns the file naming.' framing explains the no-attachment-headers design.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-480 — Export button: GETs the envelope, triggers a JSON/);
    expect(p).toMatch(/download via Blob \+ a synthetic anchor click\. No server-side/);
    expect(p).toMatch(/attachment headers needed; the dashboard owns the file naming\./);
  });

  it("CRITICAL Export filename sanitization — `name.replace(/[^a-zA-Z0-9_.-]/g, '_')`. Drift to dropping would let a profile name with `/` create a path-traversal-like filename on download.", () => {
    const p = read(PAGE);
    expect(p).toMatch(/const safeName = name\.replace\(\/\[\^a-zA-Z0-9_\.-\]\/g, '_'\);/);
    expect(p).toMatch(/a\.download = 'driftstack-profile-' \+ safeName \+ '\.json';/);
  });

  it("CRITICAL Export Blob has type 'application/json'. Drift to text/plain would let some browsers treat the download as a plain text file (lossy on round-trip Import).", () => {
    const p = read(PAGE);
    expect(p).toMatch(/const blob = new Blob\(\[text\], \{ type: 'application\/json' \}\);/);
  });

  it('CRITICAL Export uses URL.createObjectURL + URL.revokeObjectURL. Drift to dropping revokeObjectURL would leak memory over repeated exports.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/const url = URL\.createObjectURL\(blob\);/);
    expect(p).toMatch(/URL\.revokeObjectURL\(url\);/);
  });

  it('CRITICAL V-480 Import form: file-input OR textarea source pinned. The "Paste a v1 envelope (from another profile\'s Export action) or upload a .json file" framing explains both input modes.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Paste a v1 envelope \(from another profile's Export action\) or upload a\s*\n\s+<code class="font-mono text-xs">\.json<\/code> file\./,
    );
    expect(p).toMatch(/Tier-cap \+ name-conflict\s*\n\s+rules match creating a fresh profile\./);
  });

  it("CRITICAL Import file-input populates textarea via FileReader. The 'File input populates the textarea; either source is acceptable.' inline comment is the load-bearing UX rule.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ File input populates the textarea; either source is acceptable\./);
    expect(p).toMatch(
      /const reader = new FileReader\(\);\s*\n\s+reader\.onload = \(\) => \{\s*\n\s+if \(importTextInput && typeof reader\.result === 'string'\) \{\s*\n\s+importTextInput\.value = reader\.result;/,
    );
  });

  it('CRITICAL Import POST /v1/profiles/import body shape — { envelope, name_override? }. The optional name_override threads through unchanged when blank.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/const payload = \{ envelope: envelope \};/);
    expect(p).toMatch(/if \(nameOverride !== undefined\) payload\.name_override = nameOverride;/);
    expect(p).toMatch(
      /authedFetch\('\/v1\/profiles\/import', \{\s*\n\s+method: 'POST',\s*\n\s+body: JSON\.stringify\(payload\),\s*\n\s+\}\)/,
    );
  });

  it('CRITICAL Import error-state shows JSON parse failure inline. Drift to silent-rejection would leave customers wondering why their paste failed.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /try \{\s*\n\s+envelope = JSON\.parse\(text\);\s*\n\s+\} catch \(e\) \{\s*\n\s+showImportError\('Could not parse JSON: ' \+ \(e && e\.message \? e\.message : ''\)\);/,
    );
  });

  it('CRITICAL parallel-fetch refresh — the FULL profile set (fetchAllProfiles, cursor-walked) + /v1/account/me run via Promise.all. The /v1/account/me failure is non-fatal (.catch(() => null)) so profile rendering keeps working.', () => {
    const p = read(PAGE);

    // doc-150 item 6 — profilesP fetches EVERY page (the storage meter sums all
    // profiles' size_bytes; a first-page-only fetch understated the quota). The
    // walk pages at the 100 max and follows next_cursor while has_more.
    expect(p).toMatch(/const profilesP = fetchAllProfiles\(\);/);
    expect(p).toMatch(/function fetchAllProfiles\(\) \{/);
    expect(p).toMatch(/'\/v1\/profiles' \+ qs/);
    expect(p).toMatch(/body\.has_more && body\.next_cursor/);
    expect(p).toMatch(
      /const meP = authedFetch\('\/v1\/account\/me'\)\s*\n\s+\.then\(\(r\) => \(r\.ok \? r\.json\(\) : Promise\.reject\(new Error\('HTTP ' \+ r\.status\)\)\)\)\s*\n\s+\.catch\(\(\) => null\);/,
    );
    // #10 — refresh() also fetches the trash count (the profile cap is enforced
    // over LIVE + TRASHED, so the "tier limit reached" gate uses the same total).
    expect(p).toMatch(/const trashP = authedFetch\('\/v1\/profiles\/trash'\)/);
    expect(p).toMatch(/return Promise\.all\(\[profilesP, meP, trashP\]\)/);
  });

  it('CRITICAL renderUsage() injects "tier limit reached" inline span when the ENFORCED total (LIVE + TRASHED) >= cap (#10/#13 — the cap counts trashed, so the flag must too or it contradicts the server 429). The flag is rebuilt every render (remove + re-add) so a restore/purge clears it.', () => {
    const p = read(PAGE);

    // The enforced total is live count + trashed count (the same predicate the
    // server's insertWithLimit cap uses).
    expect(p).toMatch(/const enforcedTotal = count \+ trashed;/);
    expect(p).toMatch(/cap !== null && cap !== undefined && enforcedTotal >= cap/);
    // Idempotent rebuild: drop any prior flag, then re-add when over the enforced cap.
    expect(p).toMatch(/if \(existing\) existing\.remove\(\);/);
    expect(p).toMatch(/span\.setAttribute\('data-cap-flag', ''\);/);
    expect(p).toMatch(/tier limit reached/);
    // #13 — when trashed profiles are what hold the slot (live grid shows room
    // but creation is still refused), the flag says so + points to the purge path.
    expect(p).toMatch(/in the recycle bin still count toward your limit/);
  });

  it('CRITICAL escapeHtml() 5-char XSS guard pinned in inline script. Every dynamically-rendered profile field flows through it on row build. Drift to dropping would let a malicious profile name inject HTML.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/'&': '&amp;'/);
    expect(p).toMatch(/'<': '&lt;'/);
    expect(p).toMatch(/'>': '&gt;'/);
    expect(p).toMatch(/'"': '&quot;'/);
    expect(p).toMatch(/"'": '&#39;'/);

    const escapeUsages = (p.match(/escapeHtml\(/g) ?? []).length;
    expect(escapeUsages).toBeGreaterThanOrEqual(14);
  });

  it('CRITICAL archetypeLabel() reads the registry-injected archetypeLabels map (define:vars wiring), so every archetype renders friendly — not a single hardcoded mapping. (Label-map construction is pinned in W314.C archetype-baseline.)', () => {
    const p = read(PAGE);

    // The map is injected into the client script via define:vars...
    expect(p).toMatch(/archetypeLabels: ARCHETYPE_LABELS/);
    // ...and the client label fn reads it (raw-id fallback for unknown slugs).
    expect(p).toMatch(/return \(archetypeLabels && archetypeLabels\[slug\]\) \|\| slug;/);
  });

  it('CRITICAL 4 row-actions per profile — Clone/Export/Snapshot/Delete. Drift to adding or dropping an action would break the UX consistency with the cross-row layout.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/data-clone="/);
    expect(p).toMatch(/data-export="/);
    expect(p).toMatch(/data-snapshot="/);
    expect(p).toMatch(/data-delete="/);
  });

  it('CRITICAL no-token preview-fallback framing pinned (matches W749/W750/W751 pattern).', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /showBanner\('Sign in to see live profiles\. Showing preview data below\.'\);\s*\n\s+return;/,
    );
  });

  it('CRITICAL ephemeral-session-fallback framing pinned. The "Sessions without a profile start ephemeral — fresh state every run" empty-state copy explains the no-profile-needed path.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Sessions without a profile start ephemeral — fresh state every run\./);
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used (no withSidebar={false}). Profiles IS sidebar-enabled.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/<DashboardLayout title="Profiles">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-profiles-page-v284-v470-v480-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
