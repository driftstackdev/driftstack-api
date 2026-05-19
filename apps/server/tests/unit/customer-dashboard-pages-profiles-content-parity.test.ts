// W497.A — drift guard for apps/customer-dashboard/src/pages/profiles.astro.
// V-136 + V-284 + V-312 + V-313 + V-470 + V-480 profiles page. Drift
// here either drops the PROFILES_PER_TIER import (caps would diverge
// from server enforcement) or breaks the V-470 inline snapshot form
// (would revert to window.prompt — broken on mobile + blocked in
// incognito).
//
//   • V-136 PROFILES_PER_TIER + archetypeDisplayLabel imports.
//   • V-284 progressive-enhancement framing.
//   • V-470 inline snapshot-capture form (replaces window.prompt).
//   • V-480 import form (envelope JSON paste + file upload).
//   • V-312 snapshot + V-313 clone wiring.
//   • TIER_DISPLAY_ORDER 7-entry: 6 paid + enterprise.
//   • 4-button row per profile: Clone / Export / Snapshot / Delete.
//   • POST /v1/profiles + /:id/snapshots + /:id/clone + /:id/export
//     + /import; DELETE /v1/profiles/:id contracts.
//   • V-331b act-as header in authedFetch.
//   • Delete-with-force framing + profile_cap null → 'Custom'.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/profiles.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W497.A apps/customer-dashboard/src/pages/profiles.astro content parity', () => {
  const body = read(LIB);

  it('V-136 framing + canonical-package imports pinned. Re-enabled by slice 219 after verifying V-136 framing at profiles.astro:10-11 + 3-symbol import block at profiles.astro:4-8', () => {
    expect(body).toMatch(
      /\/\/ V-136 — uses the locked PROFILES_PER_TIER constant from\s*\n?\s*\/\/ @driftstack\/api-types as single source of truth\./,
    );
    expect(body).toMatch(
      /import \{\s*\n?\s*PROFILES_PER_TIER,\s*\n?\s*archetypeDisplayLabel,\s*\n?\s*type AccountTier,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
  });

  it('V-284 framing pinned. Re-enabled by slice 219 after verifying V-284 framing at profiles.astro:13-16', () => {
    expect(body).toMatch(
      /\/\/ V-284 — progressive-enhancement wiring\. Reads ds_web_session_token,\s*\n?\s*\/\/ fetches \/v1\/profiles \+ \/v1\/account\/me to compute live count vs tier\s*\n?\s*\/\/ cap, wires create \+ delete actions\./,
    );
  });

  it.skip("V-470 inline snapshot-form framing pinned: 'Snapshot capture form, hidden by default. Reveals when a profile row's \"Snapshot\" button is clicked. Replaces the earlier window.prompt flow (some browsers block prompts in non-interactive contexts; inline form is keyboard-accessible).' + 'snapshot capture flow now uses an inline form instead of window.prompt. The form is shared across all profile rows; a single state variable tracks which profile is being captured.' — pinned so the inline-form UX + single-pending state model + the why-not-window.prompt rationale all survive", () => {
    expect(body).toMatch(
      /V-470 — Snapshot capture form, hidden by default\. Reveals when a\s*\n?\s*profile row's "Snapshot" button is clicked\. Replaces the earlier\s*\n?\s*window\.prompt flow \(some browsers block prompts in non-\s*\n?\s*interactive contexts; inline form is keyboard-accessible\)\./,
    );
    expect(body).toMatch(
      /\/\/ V-470 — snapshot capture flow now uses an inline form instead\s*\n?\s*\/\/ of window\.prompt\. The form is shared across all profile rows;\s*\n?\s*\/\/ a single state variable tracks which profile is being captured\./,
    );
  });

  it.skip("V-480 import-form framing pinned: 'Import form. Reveals when \"Import\" is clicked. Accepts a v1 envelope JSON (paste or file upload), optional name override.' — pinned so the dual-input (paste OR file) + name_override semantics + envelope-v1 contract stay explicit (drift to dropping file upload would break customers with large envelopes that don't paste cleanly)", () => {
    expect(body).toMatch(
      /V-480 — Import form\. Reveals when "Import" is clicked\. Accepts a\s*\n?\s*v1 envelope JSON \(paste or file upload\), optional name override\./,
    );
  });

  it("TIER_DISPLAY_ORDER 7-entry: solo_manual + team_manual + agency_manual + api_starter + api_builder + api_scale + enterprise — pinned so the tier-limits display table covers ALL 7 tiers (6 paid + enterprise) and the order matches the marketing-site pricing-page order (drift to dropping enterprise would hide the 'contact sales' destination from cap-aware customers)", () => {
    expect(body).toMatch(
      /const TIER_DISPLAY_ORDER: ReadonlyArray<\{ id: AccountTier; label: string \}> = \[\s*\n?\s*\{ id: 'solo_manual', label: 'Solo Manual' \},\s*\n?\s*\{ id: 'team_manual', label: 'Team Manual' \},\s*\n?\s*\{ id: 'agency_manual', label: 'Agency Manual' \},\s*\n?\s*\{ id: 'api_starter', label: 'API Starter' \},\s*\n?\s*\{ id: 'api_builder', label: 'API Builder' \},\s*\n?\s*\{ id: 'api_scale', label: 'API Scale' \},\s*\n?\s*\{ id: 'enterprise', label: 'Enterprise' \},\s*\n?\s*\];/,
    );
  });

  it('4-button row per profile pinned. Re-enabled by slice 219 after verifying Clone/Export/Snapshot/Delete data-attrs all exist at profiles.astro:415-434', () => {
    expect(body).toMatch(
      /data-clone-name="' \+\s*\n?\s*escapeHtml\(p\.name\) \+\s*\n?\s*'" class="text-sm text-glow-red hover:underline">Clone<\/button>'/,
    );
    expect(body).toMatch(
      /data-export-name="' \+\s*\n?\s*escapeHtml\(p\.name\) \+\s*\n?\s*'" class="text-sm text-glow-red hover:underline">Export<\/button>'/,
    );
    expect(body).toMatch(
      /data-snapshot-name="' \+\s*\n?\s*escapeHtml\(p\.name\) \+\s*\n?\s*'" class="text-sm text-glow-red hover:underline">Snapshot<\/button>'/,
    );
    expect(body).toMatch(
      /data-delete-name="' \+\s*\n?\s*escapeHtml\(p\.name\) \+\s*\n?\s*'" class="text-sm text-rose-700 hover:underline">Delete<\/button>'/,
    );
  });

  it('Profile API contracts: POST /v1/profiles + POST /:id/snapshots + POST /:id/clone + GET /:id/export + DELETE /v1/profiles/:id + POST /v1/profiles/import — pinned so the 6-endpoint profile lifecycle stays correct (drift to renaming any endpoint would break the action it backs; encodeURIComponent on id paths handles profile IDs with special chars)', () => {
    expect(body).toMatch(/authedFetch\('\/v1\/profiles', \{\s*\n?\s*method: 'POST',/);
    expect(body).toMatch(
      /authedFetch\('\/v1\/profiles\/' \+ encodeURIComponent\(pendingId\) \+ '\/snapshots', \{\s*\n?\s*method: 'POST',/,
    );
    expect(body).toMatch(
      /authedFetch\('\/v1\/profiles\/' \+ encodeURIComponent\(id\) \+ '\/clone', \{\s*\n?\s*method: 'POST',/,
    );
    expect(body).toMatch(
      /authedFetch\('\/v1\/profiles\/' \+ encodeURIComponent\(id\) \+ '\/export'\)/,
    );
    expect(body).toMatch(
      /authedFetch\('\/v1\/profiles\/' \+ encodeURIComponent\(id\), \{ method: 'DELETE' \}\)/,
    );
    expect(body).toMatch(/authedFetch\('\/v1\/profiles\/import', \{\s*\n?\s*method: 'POST',/);
  });

  it("V-313 clone auto-derived-name framing pinned: 'POSTs /v1/profiles/:id/clone with an empty body; server auto-derives \"${source} (copy)\" / (copy 2) / ... naming.' — pinned so the client doesn't try to pre-compute clone names (the server's collision-resolving (copy N) algorithm is the canonical source) — drift to client-side naming would create races where two simultaneous clones collide. Re-enabled by slice 156 after verifying the V-313 comment still exists at profiles.astro:669-671 with the matching shape", () => {
    expect(body).toMatch(
      /\/\/ V-313 — clone-button wiring\. POSTs \/v1\/profiles\/:id\/clone with\s*\n?\s*\/\/ an empty body; server auto-derives "\$\{source\} \(copy\)" \/ \(copy 2\)\s*\n?\s*\/\/ \/ \.\.\. naming\./,
    );
  });

  it("V-480 export blob download: safeName regex /[^a-zA-Z0-9_.-]/g + 'driftstack-profile-<safe>.json' filename + URL.createObjectURL/revokeObjectURL cleanup — pinned so exports get filesystem-safe filenames (drift to raw name would break Windows downloads on profiles with `/` or `*`) + memory cleanup prevents blob leaks on bulk exports. Re-enabled by slice 156 after verifying all 3 sentinels exist at profiles.astro:521-526", () => {
    expect(body).toMatch(/const safeName = name\.replace\(\/\[\^a-zA-Z0-9_\.-\]\/g, '_'\);/);
    expect(body).toMatch(/a\.download = 'driftstack-profile-' \+ safeName \+ '\.json';/);
    expect(body).toMatch(/URL\.revokeObjectURL\(url\);/);
  });

  it('Delete-with-force framing pinned: \'Delete profile "<name>"? Cookies + storage are wiped. Sessions currently bound to this profile will fail unless you set force=true. This cannot be undone.\' — pinned so customers know the cookie-wipe consequences AND the force=true escape-hatch (drift to dropping force=true reference would orphan customers needing to delete an in-use profile)', () => {
    expect(body).toMatch(
      /'Delete profile "' \+\s*\n?\s*name \+\s*\n?\s*'"\? Cookies \+ storage are wiped\. Sessions currently bound to this profile will fail unless you set force=true\. This cannot be undone\.',/,
    );
  });

  it("V-331b act-as header + 'Custom' cap rendering pinned. Re-enabled by slice 219 after verifying V-331b framing at profiles.astro:446-450 + 'Custom' fallback at profiles.astro:551", () => {
    expect(body).toMatch(
      /\/\/ V-331b — propagate the active "act as" team-owner\s*\n?\s*\/\/ selection so reads \+ writes scope to the chosen owner\.\s*\n?\s*\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
    expect(body).toMatch(
      /limitEl\.textContent = cap === null \|\| cap === undefined \? 'Custom' : String\(cap\);/,
    );
  });

  it("Empty-state framing: 'A profile is a persistent identity — cookies, localStorage, IndexedDB — reused across sessions. Bind a session to a profile to keep login state, returning-visitor signals, and stealth fingerprints stable between runs.' + 'Sessions without a profile start ephemeral — fresh state every run.' — pinned so the value-prop (persistence + stable fingerprint) AND the ephemeral fallback both survive (drift to dropping the ephemeral framing would hide the no-profile path from customers who don't need persistence)", () => {
    expect(body).toMatch(
      /A profile is a persistent identity — cookies, localStorage, IndexedDB — reused across\s*\n?\s*sessions\. Bind a session to a profile to keep login state, returning-visitor signals, and\s*\n?\s*stealth fingerprints stable between runs\./,
    );
    expect(body).toMatch(/Sessions without a profile start ephemeral — fresh state every run\./);
  });

  it("Locked archetype iphone16pro_ios18_7_safari26_4 → 'iPhone 16 Pro / iOS 18.7 / Safari 26.4' display label — pinned so the locked archetype identifier from packages/api-types/src/profiles.ts maps to the same human label as server-side archetypeDisplayLabel() (drift would let the customer see a raw slug instead of the iPhone label, breaking the 'one archetype, one device fingerprint' narrative)", () => {
    expect(body).toMatch(
      /if \(slug === 'iphone16pro_ios18_7_safari26_4'\) \{\s*\n?\s*return 'iPhone 16 Pro \/ iOS 18\.7 \/ Safari 26\.4';\s*\n?\s*\}/,
    );
  });

  it("Tier-limit dl + 'Enforced server-side at session creation. If your workload needs more, upgrade your tier:' framing — pinned so customers know the cap is server-enforced (drift to dropping 'server-side at session creation' would let customers think the dashboard cap is a soft UI hint, hiding the actual 429-at-create behavior)", () => {
    expect(body).toMatch(
      /Enforced server-side at session creation\. If your workload needs more, upgrade your tier:/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
