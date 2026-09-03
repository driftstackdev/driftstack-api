// W485.A — drift guard for apps/gui-client/src/views/ProfilesView.tsx.
// Profiles view: list/create/delete V-136 persistent identity slots
// with V-239 cap-gate. Drift here either drops the V-239 cap-gating
// (customer sees a 429 tier-limit cap-error from server in normal flow instead
// of a disabled button + tooltip) or breaks the auto-poll cleanup
// (poll continues after unmount + chews API quota).
//
//   • Framing pinned: 'Profiles view — list profiles, create new,
//     delete.' + V-136 Tier 3 framing.
//   • REFRESH_MS = 5000 module constant.
//   • V-238 KNOWN_ARCHETYPES single-option pinned with iphone16pro
//     id + label.
//   • V-239 cap-gate framing pinned + atProfileCap calculation.
//   • refreshAccountMe after delete + after create (cap unlock
//     invariant).
//   • Modal: ESC-to-close + backdrop-click-to-close (not while
//     submitting).
//   • Form: name 1-120 required + description 500-max optional +
//     archetype select disabled when KNOWN_ARCHETYPES.length < 2.
//   • EmptyConnect 'Set an API key in Settings' framing.
//   • friendlyError: preserve the network diagnostic, then delegate safe,
//     actionable fallback formatting to the shared humanizeError helper.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/ProfilesView.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W485.A apps/gui-client/src/views/ProfilesView.tsx content parity', () => {
  const body = read(LIB);

  it('serializes all recycle-bin mutations before confirmation/network work', () => {
    expect(body).toContain('const trashMutationInFlightRef = useRef(false);');
    expect(body.match(/trashMutationInFlightRef\.current = true;/g)).toHaveLength(4);
    expect(body.match(/trashMutationInFlightRef\.current = false;/g)).toHaveLength(4);
    expect(body).toContain('aria-busy={anyBusy}');
    expect(body).toContain("{...(anyBusy ? { inert: '' } : {})}");
    expect(body).toContain("bulkAction === 'restore'");
    expect(body).toContain("bulkAction === 'empty'");
  });

  it('distinguishes verified-empty recycle-bin data from load failure', () => {
    expect(body).toContain('const trashLoadGenerationRef = useRef(0);');
    expect(body).toMatch(/const generation = \+\+trashLoadGenerationRef\.current;/);
    expect(body).toMatch(/if \(generation !== trashLoadGenerationRef\.current\) return;/);
    expect(body).toMatch(/status === 404 \|\| status === 405/);
    expect(body).toContain("Couldn't load the recycle bin. Check your connection and try again.");
    expect(body).toContain('dataAvailable={trashDataAvailable}');
    expect(body).toContain('loadError={trashLoadError}');
    expect(body).toContain('Retry before judging its contents.');
  });

  it('awaits local and account note persistence and reports partial sync honestly', () => {
    const start = body.indexOf('const handleSaveNote = useCallback(');
    const end = body.indexOf('// Switching account/workspace', start);
    const handler = body.slice(start, end);
    expect(handler).toMatch(/async \(id: string, note: string\): Promise<string \| null>/);
    expect(handler).toMatch(/const nextMeta = await saveProfileMeta\(/);
    expect(handler).toMatch(/if \(client\) await client\.profiles\.update\(id,/);
    expect(handler).toContain('Saved on this Mac, but couldn’t sync the note to your account.');
    expect(handler).toContain('Couldn’t save the note on this Mac.');
    expect(handler).not.toMatch(
      /client\.profiles\s*\.update\(id,[\s\S]{0,120}?catch\(\(\) => undefined\)/,
    );
  });

  it('serializes bulk organization and reports local/account persistence outcomes honestly', () => {
    expect(body).toContain('const bulkOrganizationMutationInFlightRef = useRef(false);');
    expect(body).toContain('aria-busy={bulkOrganizationBusy}');
    expect(body.match(/await runBulkOrganization\(/g)).toHaveLength(4);

    const start = body.indexOf('async function runBulkOrganization(');
    const end = body.indexOf('async function handleBulkApply()', start);
    const helper = body.slice(start, end);
    expect(helper).toMatch(
      /if \(selectedIds\.size === 0 \|\| bulkOrganizationMutationInFlightRef\.current\) return;/,
    );
    expect(helper).toContain('bulkOrganizationMutationInFlightRef.current = true;');
    expect(helper).toContain('const next = await saveLocal(ids);');
    expect(helper).toContain('await Promise.allSettled(');
    expect(helper).toContain('await client.profiles.update(id, update);');
    expect(helper).toContain('Saved on this Mac, but couldn’t sync');
    expect(helper).toContain('Couldn’t save profile organization on this Mac.');
    expect(helper).toContain('bulkOrganizationMutationInFlightRef.current = false;');
    expect(helper.indexOf('if (failed > 0)')).toBeLessThan(helper.indexOf('clearDrafts();'));
    expect(helper.indexOf('if (failed > 0)')).toBeLessThan(
      helper.indexOf('setSelectedIds(new Set());'),
    );

    const handlers = body.slice(end, body.indexOf('// Bulk export', end));
    expect(handlers).not.toMatch(/profiles\s*\.update\([\s\S]{0,120}?catch\(\(\) => undefined\)/);
  });

  it('binds offline taxonomy to validated non-secret identity and never falls back to global keys', () => {
    expect(body).toMatch(
      /function buildTaxonomyCacheScope\(baseUrl: string, effectiveAccountId: string\): string \| null/,
    );
    const scopeHelper = body.slice(
      body.indexOf('function buildTaxonomyCacheScope('),
      body.indexOf('function railTaxonomySyncMessage('),
    );
    expect(scopeHelper).toContain('url.origin.toLowerCase()');
    expect(scopeHelper).toContain('effectiveAccountId');
    expect(scopeHelper).not.toMatch(/apiKey|email/i);
    expect(body).toMatch(
      /\(accountMe\?\.teams \?\? \[\]\)\.some\(\(team\) => team\.owner_account_id === activeWorkspace\)/,
    );
    expect(body).toContain('loadFolders(scope)');
    expect(body).toContain('loadFolderIcons(scope)');
    expect(body).toContain('loadTags(scope)');
    expect(body).toContain('const taxonomyReconcileGenerationRef = useRef(0);');
    expect(body).toContain('generation === taxonomyReconcileGenerationRef.current');
    expect(body).toContain('taxonomyReconcileGenerationRef.current += 1;');
    expect(body).toContain('replaceAllFolders(names, icons, scope)');
    expect(body).toContain('replaceAllTags(org.tags, scope)');
    expect(body).not.toMatch(/loadFolders\(\)|loadFolderIcons\(\)|loadTags\(\)/);
  });

  it('generation-fences core, detached agent and metadata refresh publications through unmount', () => {
    expect(body).toContain('const refreshGenerationRef = useRef(0);');
    expect(body).toContain('refreshClientOwnerRef.current === client');
    expect(body).toContain('refreshWorkspaceOwnerRef.current === activeWorkspace');
    expect(body).toMatch(/const generation = \+\+refreshGenerationRef\.current;/);
    expect(body.match(/if \(!isCurrentRefresh\(\)\) return;/g)?.length ?? 0).toBeGreaterThanOrEqual(
      3,
    );
    expect(body).toMatch(/\.then\(\(page\) => \{\s*if \(!isCurrentRefresh\(\)\) return;/);
    expect(body).toMatch(
      /setProfilesMeta\(\(local\) => \{\s*if \(!isCurrentRefresh\(\)\) return local;/,
    );
    expect(body).toContain('refreshGenerationRef.current += 1;');
  });

  it('keeps one tokenized rail taxonomy owner and scope-retained retry remainder', () => {
    expect(body).toContain('const railTaxonomyMutationOwnerRef = useRef<symbol | null>(null);');
    expect(body).toContain('railTaxonomyMutationOwnerRef.current === owner');
    expect(body).toContain('const admittedTransport: RailTaxonomyTransport = {');
    expect(body).toContain('rememberRailTaxonomyRetry(scope, retry);');
    expect(body).toContain(
      'const railTaxonomyRetriesByScope = new Map<string, RailTaxonomySyncPlan>();',
    );
    expect(body).toContain('MAX_RETAINED_TAXONOMY_RETRIES = 16');
    expect(body).toContain('if (railTaxonomyRetriesByScope.has(scope)) return;');
    expect(body).toContain("(!hasAccountTransport || accountResults[0]?.status === 'rejected')");
    expect(body).toMatch(
      /profileClient === null\s*\? plan\.profileUpdates\s*: plan\.profileUpdates\.filter/,
    );
    expect(body).toContain('role="alert"');
    expect(body).toContain('data-component="profiles-taxonomy-sync-issue"');
    expect(body).toContain('onClick={() => void retryRailTaxonomySync()}');
    expect(body).not.toContain('Keep local');
    expect(body).not.toMatch(/catch\(\(\) => undefined\)[\s\S]{0,100}pushOrg/);
  });

  it('states the shipped protected-local and encrypted owner-account proxy sync boundary honestly', () => {
    expect(body).toMatch(
      /Proxy credentials are\s*protected locally and synced encrypted to your account when used for a session\./,
    );
    expect(body).toMatch(
      /Protected locally in this app · synced encrypted to your account when used for\s*a session\./,
    );
    expect(body).not.toMatch(/never uploaded to the control plane|credentials never go/i);
  });

  it("Framing pinned: 'Profiles view — list profiles, create new, delete.' + V-136 Tier 3 draft framing ('Persistent identity slots that survive across sessions. Each profile carries its own cookies + localStorage; the driver attaches them to a session when the session is created against a profile.')", () => {
    expect(body).toMatch(/\/\/ Profiles view — list profiles, create new, delete\./);
    expect(body).toMatch(
      /\/\/ V-136 \(Tier 3 draft\)\. Persistent identity slots that survive across\s*\/\/ sessions\. Each profile carries its own cookies \+ localStorage; the\s*\/\/ driver attaches them to a session when the session is created against\s*\/\/ a profile\./,
    );
  });

  it('2026-05-20 — REFRESH_MS bumped 5000→15_000 (mirror of SessionsView change per d15460c7; customer feedback "the page keeps refreshing")', () => {
    expect(body).toMatch(/const REFRESH_MS = 15_000;/);
  });

  it("W637 KNOWN_ARCHETYPES derived from ARCHETYPE_REGISTRY filtered to verified statuses (launch + available) — pinned so the GUI archetype catalog is the single-source registry (not a hardcoded list) and EXCLUDES reference/planned (e.g. iPhone 17, still per-value verified) so an unverified fingerprint can't ship; new devices appear automatically when A1 flips their status", () => {
    // LiveKitInfo dropped 2026-06-18 when the dead in-app overlay (watchInfo)
    // was removed — the launch flow only opens the separate simulator window now.
    expect(body).toMatch(
      /import \{[^}]*ARCHETYPE_REGISTRY[^}]*type ArchetypeStatus[^}]*\} from '@driftstack\/sdk';/,
    );
    expect(body).toMatch(
      /const SELECTABLE_STATUSES = new Set<ArchetypeStatus>\(\['launch', 'available'\]\);/,
    );
    expect(body).toMatch(
      /const KNOWN_ARCHETYPES: ReadonlyArray<\{ id: string; label: string \}> = ARCHETYPE_REGISTRY\.filter\(\s*\(a\) => SELECTABLE_STATUSES\.has\(a\.status\),\s*\)\.map\(\(a\) => \(\{ id: a\.id, label: a\.displayLabel \}\)\);/,
    );
    // reference/planned MUST NOT be selectable (the 100%-verified rule).
    expect(body).not.toMatch(/SELECTABLE_STATUSES[\s\S]{0,80}?'planned'/);
    expect(body).not.toMatch(/SELECTABLE_STATUSES[\s\S]{0,80}?'reference'/);
  });

  it("V-239 cap-gate framing pinned ('gate the New profile button at the tier cap (skip when profile_cap === null which means enterprise / no fixed cap).') + atProfileCap = profileCap !== null && profileCount !== null && profileCount >= profileCap — pinned so a null profile_cap (enterprise) doesn't accidentally gate the button", () => {
    expect(body).toMatch(
      /\/\/ V-239 — gate the New profile button at the tier cap \(skip when\s*\/\/ profile_cap === null which means enterprise \/ no fixed cap\)\./,
    );
    expect(body).toMatch(
      /const profileCap = accountMe\?\.profile_cap \?\? null;\s*const profileCount = accountMe\?\.profile_count \?\? null;\s*const atProfileCap = profileCap !== null && profileCount !== null && profileCount >= profileCap;/,
    );
  });

  it('2026-05-20 — refreshAccountMe still fires after handleDelete success + after CreateProfileModal onCreated (V-239 cap-gate invariant) but the deleteBinding + refresh(false) calls were inserted ahead of refreshAccountMe in handleDelete per the antidetect-browser restructure', () => {
    expect(body).toMatch(
      /await client\.profiles\.delete\(id\);\s*\/\/ Drop the local binding so stale \{currentSessionId, defaultProxyId\}\s*\/\/ entries don't accumulate as customers churn through profiles\.\s*await deleteBinding\(id\);\s*await refresh\(false\);\s*await refreshAccountMe\(\);/,
    );
    expect(body).toMatch(/void refreshAccountMe\(\);/);
  });

  it('2026-05-20 — auto-poll lifecycle: useEffect runs refresh(true) initially (showLoading hint) + setInterval refresh(false) at REFRESH_MS (no flicker on background ticks); cleanup clears the interval and invalidates late publications; client.profiles.iterate({ limit: 50 }) still caps per-poll in-memory accumulation', () => {
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*void refresh\(true\);[\s\S]*?const id = window\.setInterval\(\(\) => \{[\s\S]*?void refresh\(false\);\s*\}, REFRESH_MS\);[\s\S]*?return \(\) => \{\s*window\.clearInterval\(id\);[\s\S]*?refreshGenerationRef\.current \+= 1;\s*\};\s*\}, \[refresh\]\);/,
    );
    expect(body).toMatch(
      /for await \(const profile of client\.profiles\.iterate\(\{ limit: 50 \}\)\)/,
    );
  });

  it('CreateProfileModal: all close paths use the submission-safe dirty-draft guard; modal keeps dialog semantics', () => {
    expect(body).toMatch(
      /const requestClose = useCallback\(\(\): void => \{\s*if \(submitting \|\| confirmOpenRef\.current\) return;[\s\S]*?if \(!dirty\) \{\s*onClose\(\);/,
    );
    expect(body).toMatch(/useFocusTrap\(true, dialogRef, requestClose\);/);
    expect(body).toMatch(/if \(e\.target === e\.currentTarget\) requestClose\(\);/);
    expect(body).toMatch(
      /role="dialog"\s*aria-modal="true"\s*aria-labelledby="create-profile-title"/,
    );
  });

  it('Form: name input maxLength=120 minLength=1 required + description textarea maxLength=500 rows=2 — pinned so server schema bounds (1-120 name / 500-max description) stay enforced client-side', () => {
    expect(body).toMatch(/maxLength=\{120\}\s*minLength=\{1\}\s*required/);
    expect(body).toMatch(/maxLength=\{500\}\s*rows=\{2\}/);
  });

  it("Device picker (2026-06-25 redesign): the device-card grid is replaced by the searchable/chip-filtered <DevicePicker>; the modal still OWNS selection (selectedId={archetype} onSelect={setArchetype}) and feeds the whole registry as PICKER_DEVICES with `selectable` flagged by the SAME SELECTABLE_STATUSES gate, so reference/planned entries render as muted non-selectable rows and randomize lands only on the filtered+selectable set — pinned so a regression can't drop the picker back to a status==='launch' single-device gate", () => {
    // The picker component is imported + rendered with the modal's selection state.
    expect(body).toMatch(
      /import \{ DevicePicker, type PickerDevice \} from '\.\.\/components\/DevicePicker';/,
    );
    expect(body).toMatch(/<DevicePicker\b/);
    expect(body).toMatch(/selectedId=\{archetype\}/);
    expect(body).toMatch(/onSelect=\{setArchetype\}/);
    expect(body).toMatch(/disabled=\{submitting\}/);
    // PICKER_DEVICES flattens the WHOLE registry; `selectable` MUST track the
    // shared SELECTABLE_STATUSES gate (never a status==='launch' regression).
    expect(body).toMatch(
      /const PICKER_DEVICES: readonly PickerDevice\[\] = ARCHETYPE_REGISTRY\.map\(\(a\) => \(\{[\s\S]*?selectable: SELECTABLE_STATUSES\.has\(a\.status\),[\s\S]*?\}\)\);/,
    );
    expect(body).toMatch(/engine: 'webkit',/);
    // randomize picks only from the picker's filtered + selectable candidate set.
    expect(body).toMatch(
      /onRandomize=\{\(candidates\) => \{[\s\S]*?candidates\[Math\.floor\(Math\.random\(\) \* candidates\.length\)\][\s\S]*?\}\}/,
    );
    expect(body).not.toMatch(/status === 'launch'/);
  });

  it("Empty no-profiles framing pinned: 'A profile keeps a device's logins and identity between sessions. Create one to launch.' — one line via the shared EmptyState (T-7); pinned so customer understands what they're creating", () => {
    expect(body).toMatch(
      /A profile keeps a device's logins and identity between sessions\. Create one to launch\./,
    );
    // T-7 replaced the four-block empty state with the shared EmptyState: one
    // description line, no ephemeral sub-note (it described the absence of the
    // thing the state offers). The old "persistent identity" framing must be gone.
    expect(body).not.toMatch(/A profile is a persistent identity/);
    expect(body).not.toMatch(/Sessions without a profile start ephemeral/);
  });

  it("New profile button: disabled={state.loading || atProfileCap} + aria-disabled={state.loading || atProfileCap}; title tooltip 'Profile cap reached ({cap} for {tier}). Delete a profile or upgrade to add more.' when atProfileCap else undefined — pinned so both screen readers + hover surface the cap explanation", () => {
    expect(body).toMatch(/disabled=\{state\.loading \|\| atProfileCap\}/);
    expect(body).toMatch(/aria-disabled=\{state\.loading \|\| atProfileCap\}/);
    // 2026-06-19 — the New-profile button's cap tooltip now flows through the
    // shared `profileCapReason` const (DRY across New/Import/Clone buttons). The
    // button references it; the const below pins the exact contract text.
    expect(body).toMatch(/title=\{atProfileCap \? profileCapReason : undefined\}/);
    expect(body).toMatch(
      /const profileCapReason = `Profile cap reached \(\$\{\(profileCap \?\? 0\)\.toString\(\)\} for \$\{[\s\S]*?accountMe\?\.tier \?\? 'this tier'[\s\S]*?\}\)\. Delete a profile or upgrade to add more\.`;/,
    );
  });

  it('friendlyError preserves the Tauri-WebKit diagnosticFetchError preflight, strips its raw native suffix, and delegates every non-network error to the shared humanizeError helper with an actionable fallback', () => {
    expect(body).toContain("import { humanizeError } from '../lib/humanize-error';");
    expect(body).toMatch(
      /function friendlyError\(\s*err: unknown,\s*baseUrl\?: string,\s*fallback = "Couldn't complete this profile action\. Try again\.",\s*\): string \{[\s\S]*?if \(baseUrl !== undefined\) \{\s*const diag = diagnosticFetchError\(err, baseUrl\);\s*if \(diag !== null\) \{\s*return `Couldn't reach \$\{baseUrl\}\. Check the URL, connection, firewall, or VPN, then try again\.`;\s*\}\s*\}\s*return humanizeError\(err, fallback\);\s*\}/,
    );
    expect(body).not.toMatch(/return `\$\{err\.title\} \(\$\{err\.kind\}\):/);
  });

  it('Launch gates on `busy` ONLY, not atProfileCap (free-tier fix 0ccff415): the profile cap limits CREATING profiles, not launching an existing one (launch consumes a session slot). A regression to `disabled={busy || atProfileCap}` re-greys Launch on a free-tier account (profile_cap 1) so the one allowed profile can never launch — the exact bug a self-hosted user hit. GRID + LIST(table) both route Launch through handleLaunch with launchDisabled gated on activeWorkspace only. (Duplicate removed per founder 2026-06-15.)', () => {
    expect(body).toMatch(/void handleLaunch\(profile\)/);
    // The fix's rationale comment must stay (explains why Launch is busy-only).
    // 2026-06-30 — reworded "the cap" -> "that cap" alongside the #9 concurrent-cap
    // addition; the substance (NOT atProfileCap) is unchanged.
    expect(body).toMatch(/NOT atProfileCap: that/);
    // The specific regression guard: the Launch button must never re-gate on the
    // profile cap. (`state.loading || atProfileCap` on the New-profile button is
    // correct + separately pinned above; this targets the `busy || atProfileCap` form.)
    expect(body).not.toMatch(/disabled=\{busy\s*\|\|\s*atProfileCap\}/);
  });

  it("Launch in a team workspace is gated by ROLE (2026-06-16): the server now lets a team ADMIN launch the owner's profile (agent-sessions create honors X-Driftstack-Account for admins, mirroring driver V-326e3), so only NON-admin members are blocked. activeRole reads the membership role for the active workspace; teamLaunchBlocked = activeWorkspace !== null && activeRole !== 'admin'. GRID gates via the ProfilePhoneCard launchDisabled prop, LIST via the row-model field — both off the shared teamLaunchBlocked (OR'd with atConcurrentCap since 2026-06-30's #9 cap-gate).", () => {
    expect(body).toMatch(
      /const teamLaunchBlocked = activeWorkspace !== null && activeRole !== 'admin'/,
    );
    // 2026-06-30 — #9 (proactive audit) pre-gates Launch at the concurrent-session
    // cap too, so both sites now OR in atConcurrentCap; teamLaunchBlocked is still
    // present (never dropped) in both expressions.
    expect(body).toContain('launchDisabled={teamLaunchBlocked || atConcurrentCap}'); // grid card prop
    expect(body).toContain('launchDisabled: teamLaunchBlocked || atConcurrentCap'); // table row model
    expect(body).toMatch(/ask a team admin to launch it/);
  });

  it('Workspace recovery bar is ALWAYS rendered when activeWorkspace !== null — independent of profiles/accountMe load state (a revoked-membership persisted workspace 403s everything; the in-stats-row switcher is gated on profiles.length>0 AND accountMe.teams, so without this top-level Switch-to-Personal escape the hub would brick with no way back).', () => {
    expect(body).toContain('data-component="workspace-recovery-bar"');
    expect(body).toContain('{activeWorkspace !== null && (');
    expect(body).toMatch(/↩ Switch to Personal/);
    expect(body).toContain('onClick={() => setActiveWorkspace(null)}');
  });

  it("W624 stop-actually-stops: boundSession resolves the profile's session by KIND (agt_ → agent, else live driver session) so an agent-backed profile counts as running AND its Stop closes the right thing — handleStop calls agentSessions.close(agt_) / sessions.destroy(ses_). The founder-hit bug: launch-with-LiveKit bound an agt_ id that the driver-only lookup never matched, so the profile showed idle and Stop no-op'd (the agent session kept running).", () => {
    // audit #4 perf refactor (behaviour byte-identical): the O(profiles ×
    // sessions) per-call scan is now a `boundSessionByProfileId` useMemo that
    // builds the by-kind index ONCE per relevant-input change (bindings +
    // activeSessions + agentSessions + agentSessionsLoaded), and `boundSession`
    // is a thin O(1) accessor reading `map.get(id) ?? null`. Both the index
    // builder (where the KIND-resolution now lives) and the accessor are pinned.
    expect(body).toMatch(
      /const boundSessionByProfileId = useMemo<\s*Map<string, \{ id: string; kind: 'agent' \| 'driver' \}>\s*>\(\(\) => \{/,
    );
    expect(body).toMatch(/\}, \[bindings, activeSessions, agentSessions, agentSessionsLoaded\]\);/);
    expect(body).toMatch(
      /function boundSession\(profileId: string\): \{ id: string; kind: 'agent' \| 'driver' \} \| null \{\s*return boundSessionByProfileId\.get\(profileId\) \?\? null;\s*\}/,
    );
    // agt_ resolves to agent kind, but the binding now SELF-HEALS (founder
    // 2026-06-18 "always says open session even on long-expired/failed"): once
    // the live agent-session list has loaded, a bound session counts as running
    // only if it's still present AND not closed; before load it trusts the
    // binding so a transient fetch miss doesn't flip a live profile to idle.
    expect(body).toContain("if (sid.startsWith('agt_')) {");
    // audit #4 perf refactor: the per-profile resolution now lives inside the
    // `boundSessionByProfileId` useMemo builder (a Map indexed once per
    // relevant-input change), so "count it running" is `out.set(...); continue`
    // and "read idle" is `continue` — semantically identical to the old scan
    // body's `return { id, kind }` / `return null`. Trust-the-binding before the
    // first successful list fetch is preserved.
    expect(body).toMatch(
      /if \(!agentSessionsLoaded\) \{\s*out\.set\(binding\.profileId, \{ id: sid, kind: 'agent' \}\);\s*continue;\s*\}/,
    );
    expect(body).toContain("if (live === undefined || live.status === 'closed') continue;");
    // LIVENESS re-base (W2679, founder 2026-06-18): an active-but-DEAD session
    // (worker crashed / never came up) stays `active` for up to the 12h reaper
    // cap, so the list/status check alone isn't enough. The SERVER now re-bases
    // the worker's liveness onto the fleet heartbeat and reports it inline on
    // each list entry; boundSession reads that `liveness` field DIRECTLY off the
    // list entry — the old client-side page-state probe + 90s grace are GONE:
    //   • liveness PRESENT && fresh === false → stale beat → idle (null).
    //   • liveness PRESENT && fresh === true, or liveness ABSENT (unknown →
    //     trust the binding) → running. Never treat absent as dead.
    // Stale-beat → idle: `continue` skips the profile in the Map builder (was
    // `return null` in the old per-call scan); a fresh/absent beat falls through
    // to `out.set(...)` = running, per the W2679 contract above.
    expect(body).toContain('if (live.liveness !== undefined && !live.liveness.fresh) continue;');
    expect(body).toMatch(
      /if \(live\.liveness !== undefined && !live\.liveness\.fresh\) continue;\s*out\.set\(binding\.profileId, \{ id: sid, kind: 'agent' \}\);\s*continue;/,
    );
    // The dead page-state probe heuristic must be fully removed.
    expect(body).not.toMatch(/SESSION_LIVENESS_GRACE_MS/);
    expect(body).not.toMatch(/sessionLiveness/);
    expect(body).not.toMatch(/probeSessionLiveness/);
    expect(body).not.toMatch(/pageStatePresent/);
    expect(body).not.toMatch(/getPageState/);
    // The agent-session list entries carry the server `liveness` field through.
    expect(body).toMatch(/import \{ mintGuiControlKey \} from '\.\.\/lib\/agent-session-control';/);
    // The main GUI preserves the server-owned control-key expiry and hands the
    // key+expiry credential to native launch as one value. It never substitutes
    // the account API key into the Simulator payload.
    expect(body).toMatch(/const reopenControlCredential =/);
    expect(body).toContain('{ controlCredential: reopenControlCredential }');
    expect(body).toMatch(/const controlCredential =/);
    expect(body).toContain('{ controlCredential }');
    expect(body).not.toMatch(/\{ controlKey:/);
    expect(body).toContain('...(s.liveness !== undefined ? { liveness: s.liveness } : {})');
    // The driver branch keeps the live-list cross-check but now also EXCLUDES
    // terminal driver sessions (destroyed/errored) so a dead session lingering
    // in the list reads as idle instead of offering "Open session". audit #4
    // pre-indexes this into a `liveDriverIds` Set built ONCE (the terminal-state
    // exclusion is the Set-membership predicate), and the per-binding loop does
    // an O(1) `has(sid)` check — semantically identical to the old per-call
    // `activeSessions.some((s) => s.id === sid && !terminal)` scan.
    expect(body).toMatch(
      /const liveDriverIds = new Set<string>\(\);\s*for \(const s of activeSessions\) \{\s*if \(s\.status !== 'destroyed' && s\.status !== 'errored'\) liveDriverIds\.add\(s\.id\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(liveDriverIds\.has\(sid\)\) out\.set\(binding\.profileId, \{ id: sid, kind: 'driver' \}\);/,
    );
    // handleStop closes by kind (the actual fix for "destroy keeps running").
    expect(body).toMatch(
      /if \(bound\.kind === 'agent'\) \{\s*await client\.agentSessions\.close\(bound\.id\);\s*\} else \{\s*await client\.sessions\.destroy\(bound\.id\);\s*\}/,
    );
    // running flag (per-row) + the status filter both route through boundSession
    // as the single source of truth, so badge / filter / live-count agree and an
    // agt_ session counts as running via the by-kind resolution above.
    expect(body).toMatch(/const running = bound !== null;/);
    expect(body).toMatch(/const running = boundSession\(p\.id\) !== null;/);
    // onPrimary on a running profile re-opens the live stream in the floating
    // Simulator window (reopenStream) — the ONLY live-session UI. Only agent
    // sessions stream; a driver binding has no live UI (driver sessions are no
    // longer created), so there's no `else onOpenSession` branch and no in-app
    // viewer is ever opened (the legacy LiveSessionView was removed).
    expect(body).toMatch(
      /if \(bound\.kind === 'agent'\) void reopenStream\(bound\.id, profile\.id\);/,
    );
    expect(body).not.toMatch(/onOpenSession/);
    // Live view re-opens the stream for an agent session (livekitToken).
    expect(body).toMatch(/await client\.agentSessions\.livekitToken\(agentSessionId\);/);
  });

  it('the legacy LiveKit-less polling fallback is fully removed (2026-06-26): no openPollingFallback / handleQuickSession / usedPollingFallback state / mock-driver banner / Quick Session button — the floating Simulator window is the only live-session UI, so a livekit-less create is a hard error, not an in-app placeholder viewer', () => {
    // No polling-fallback machinery.
    expect(body).not.toMatch(/openPollingFallback/);
    expect(body).not.toMatch(/usedPollingFallback/);
    expect(body).not.toMatch(/setUsedPollingFallback/);
    expect(body).not.toMatch(/data-banner="mock-driver"/);
    expect(body).not.toMatch(/serverDriver/);
    // No Quick Session (it created a driver session → the deleted viewer).
    expect(body).not.toMatch(/handleQuickSession/);
    expect(body).not.toMatch(/Quick Session/);
    // No onOpenSession prop threading (it pointed at the deleted in-app viewer).
    expect(body).not.toMatch(/onOpenSession/);
    // A livekit-less create closes the channel-less session, clears the binding,
    // and surfaces a retry-able error — never opens an in-app page.
    expect(body).toMatch(
      /Couldn't start the live view — the session didn't get a video channel\. Try again\./,
    );
    expect(body).toMatch(
      /await client\.agentSessions\.close\(created\.id\)\.catch\(\(\) => undefined\);/,
    );
  });

  it('W638 reopenStream stale-binding self-heal: a 403/404 from livekitToken (closed/gone agent session that boundSession optimistically showed as running) clears the profile binding + refreshes so it self-heals to idle instead of re-offering a Live-view that 403s', () => {
    expect(body).toMatch(
      /if \(err instanceof DriftstackError && \(err\.status === 403 \|\| err\.status === 404\)\) \{\s*await clearProfileSession\(profileId\)\.catch\(\(\) => undefined\);\s*await refresh\(false\);\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('founder 2026-06-20: Clone + Export + Import are flag-gated (CLONE_ENABLED / IMPORT_EXPORT_ENABLED, default false) and hidden when off — the handlers are KEPT for reversibility, not deleted (clone deemed useless; export/import a profile-cheat abuse vector)', () => {
    expect(body).toMatch(/const CLONE_ENABLED = false;/);
    expect(body).toMatch(/const IMPORT_EXPORT_ENABLED = false;/);
    // Affordances gated off (card clone + export, table clone, import modal).
    expect(body).toMatch(
      /onClone=\{CLONE_ENABLED \? \(\) => void handleClone\(profile\.id\) : undefined\}/,
    );
    expect(body).toMatch(/CLONE_ENABLED \? \(id\) => void handleClone\(id\) : undefined/);
    expect(body).toMatch(
      /IMPORT_EXPORT_ENABLED \? \(\) => void handleExport\(profile\.id\) : undefined/,
    );
    expect(body).toMatch(/IMPORT_EXPORT_ENABLED && importOpen &&/);
    // Reversibility invariant — the handlers must remain DEFINED, not removed.
    expect(body).toMatch(/async function handleClone\(/);
    expect(body).toMatch(/async function handleExport\(/);
    expect(body).toMatch(/async function handleImport\(/);
  });
});
