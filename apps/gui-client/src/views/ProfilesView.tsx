// Profiles view — list profiles, create new, delete.
//
// V-136 (Tier 3 draft). Persistent identity slots that survive across
// sessions. Each profile carries its own cookies + localStorage; the
// driver attaches them to a session when the session is created against
// a profile.
//
// Mirrors SessionsView shape: 15-second poll (REFRESH_MS), inline error
// banner, busy state per row.

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  folderList,
  aggregateTags,
  loadProfilesMeta,
  persistProfilesMeta,
  saveProfileMeta,
  seedMetaFromServer,
  saveProfilesMetaBulk,
  type ProfileMeta,
  type ProfilesMetaMap,
} from '../lib/profiles-meta';
import {
  loadFolders,
  addFolder,
  removeFolder,
  renameFolder,
  setFolderIcon,
  loadFolderIcons,
  replaceAllFolders,
} from '../lib/folders-store';
import { loadTags, addTag, removeTag, renameTag, replaceAllTags } from '../lib/tags-store';
import {
  fetchOrganization,
  saveOrganization,
  type AccountOrganization,
} from '../lib/account-organization';
import {
  loadProbeCache,
  saveProbeResult,
  saveExitResult,
  type ProbeCacheMap,
} from '../lib/proxy-probe-cache';
import { downloadJson, timestampedFilename } from '../lib/download';
import { useConfirm } from '../components/ConfirmProvider';
import { PROFILE_ICONS } from '../lib/profile-icons';
import { useFocusTrap } from '../lib/use-focus-trap';
import { OnboardingChecklist } from '../components/OnboardingChecklist';
import { useOnboardingDismissed, buildOnboardingSteps } from '../lib/use-onboarding-steps';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import { Skeleton, SkeletonRegion } from '../components/Skeleton';
import {
  ProfilesActionBar,
  type ProfileSortBy,
  type ProfileSortDir,
  type ProfileStatusFilter,
} from '../components/ProfilesActionBar';
import { ProxyCapabilityChips, proxyCapabilities } from '../components/ProxyCapabilities';
import { ProfilePhoneCard } from '../components/ProfilePhoneCard';
import { DevicePicker, type PickerDevice } from '../components/DevicePicker';
import { RelativeTime } from '../components/RelativeTime';
import {
  ProfilesTable,
  type ProfileTableRow,
  type ProfilesTableSortKey,
} from '../components/ProfilesTable';
import {
  ARCHETYPE_REGISTRY,
  STORAGE_SOFT_WARN_FRACTION,
  TIER_STORAGE_BYTES_CAP,
  type ArchetypeStatus,
  type CreateAgentSessionRequest,
  type UpdateProfileRequest,
} from '@driftstack/sdk';
import { openSimulatorWindow } from '../lib/open-simulator';
import { mintGuiControlKey } from '../lib/agent-session-control';
import { validateProfileName } from '../lib/profile-name';
import { useSettings } from '../lib/SettingsContext';
import { normalizeNavigateUrl } from '../lib/address-bar';
import { DriftstackError, type Session } from '../lib/client';
import { diagnosticFetchError } from '../lib/diagnostic-fetch-error';
import { humanizeError } from '../lib/humanize-error';
import { friendlySimulatorOpenReason } from '../lib/simulator-open-error';
import {
  clearSession as clearProfileSession,
  deleteBinding,
  listBindings,
  markLaunched,
  setDefaultProxy,
  type ProfileBinding,
} from '../lib/profile-bindings';
import {
  isProxyUsable,
  proxyVerdict,
  addProxy,
  listProxies,
  setProxyServerId,
  testProxy,
  probeProxyExit,
  type ProxyConfig as LocalProxyConfig,
  type ProxyDraft,
  type ProxyTestResult,
} from '../lib/proxies';
import {
  createProxy as createAccountProxy,
  updateProxy as updateAccountProxy,
  buildWireGuardProxyInput,
  buildOpenVpnProxyInput,
} from '../lib/account-proxies';
import { parseWireGuardConfig } from '../lib/parse-wireguard';
import { validateOpenVpnConfig } from '../lib/parse-openvpn';

// 2026-05-20 — match SessionsView: slow background poll + skip the
// visible loading flicker on tick refreshes so the panel doesn't
// constantly re-flash.
const REFRESH_MS = 15_000;
const PROFILES_VIEW_MODE_KEY = 'ds-profiles-view-mode';

type ProfilesViewMode = 'list' | 'grid';

// Keep the initial-loading silhouette and the loaded workspace on the same
// geometry. These are intentionally shared rather than copied into the
// skeleton: the folder rail width and responsive phone-card grid should not
// jump when the first profile page resolves.
const PROFILES_WORKSPACE_CLASS = 'flex min-h-0 flex-1 gap-4';
const PROFILES_RAIL_CLASS =
  'flex min-h-0 w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-surface-divider pr-3';
const PROFILES_CONTENT_CLASS = 'flex min-h-0 min-w-0 flex-1 flex-col gap-3';
const PROFILES_SCROLL_CLASS = 'min-h-0 min-w-0 flex-1 overflow-y-auto';
const PROFILES_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(178px,1fr))] gap-3';

function loadProfilesViewMode(): ProfilesViewMode {
  try {
    const stored = window.localStorage.getItem(PROFILES_VIEW_MODE_KEY);
    return stored === 'list' || stored === 'grid' ? stored : 'grid';
  } catch {
    return 'grid';
  }
}
// P2 #8 — folder/tag name caps, unified to the SERVER binding caps (api-types
// ProfileFolderSchema max 32, ProfileTagSchema max 24) so every rail input,
// create/edit slice, the taxonomy stores, and the per-profile meta agree. A name
// longer than these could never be applied to a profile (server rejects + meta
// truncates), so a profile under it vanished from its own folder/tag filter.
const MAX_FOLDER_NAME_CHARS = 32;
const MAX_TAG_NAME_CHARS = 24;

// W637 — the selectable archetype catalog is now derived from the shared
// ARCHETYPE_REGISTRY (single source of truth), filtered to the verified
// statuses that are safe to run a real session as: `launch` (the locked
// reference) + `available` (fingerprint-atlas-ready). `reference` and
// `planned` (e.g. iPhone 17, still per-value verified vs real-device per
// the "100% verified profiles" rule) are intentionally EXCLUDED — they
// light up automatically the moment A1 flips their status, with zero GUI
// change. The locked launch archetype is preselected; the select enables
// once 2+ verified options exist.
const SELECTABLE_STATUSES = new Set<ArchetypeStatus>(['launch', 'available']);
const KNOWN_ARCHETYPES: ReadonlyArray<{ id: string; label: string }> = ARCHETYPE_REGISTRY.filter(
  (a) => SELECTABLE_STATUSES.has(a.status),
).map((a) => ({ id: a.id, label: a.displayLabel }));

// Flattened device catalog feeding the redesigned DevicePicker. Every registry
// entry is surfaced (selectable + reference), so a `reference`/`planned`
// archetype still renders as a muted, non-clickable row instead of vanishing —
// and `selectable` is the SAME SELECTABLE_STATUSES gate as KNOWN_ARCHETYPES, so
// the hero/list/randomize selection paths can never diverge from the catalog.
// All current entries are engine WebKit; the field is explicit so a future
// Chrome archetype is a registry data add, not a picker change.
const PICKER_DEVICES: readonly PickerDevice[] = ARCHETYPE_REGISTRY.map((a) => ({
  id: a.id,
  device: a.device,
  iosVersion: a.iosVersion,
  safariVersion: a.safariVersion,
  engine: 'webkit',
  selectable: SELECTABLE_STATUSES.has(a.status),
}));

interface Profile {
  id: string;
  name: string;
  archetype: string;
  description: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  // doc-150 item 5 — byte size of the profile's last saved sealed store (the
  // opaque encrypted browser-state blob). `null` until the profile is first
  // saved. The server already returns this on GET /v1/profiles; surfaced per-
  // row + summed into the account-wide storage meter. Mirrors the canonical
  // @driftstack/api-types Profile shape.
  size_bytes: number | null;
  // Save metadata proves a persisted browser-state blob exists. Optional for
  // compatibility with older deployments/test fixtures that predate the field.
  last_saved_at?: string | null;
  // L4b recycle bin — null for live profiles; set for trashed ones (only the
  // GET /v1/profiles/trash response carries a non-null value).
  deleted_at: string | null;
}

interface ProfilesState {
  profiles: Profile[];
  refreshedAt: number | null;
  loading: boolean;
  /** Failure from fetching the profile list and its supporting hub data. Kept
   *  separate from action errors so it can offer an honest in-place Retry. */
  loadError: string | null;
  /** User-action failures are dismiss-only; a list refresh must not erase one. */
  error: string | null;
  /** Transient success message (e.g. "Exported …") shown in a dismissible
   *  banner; null when there's nothing to report. Auto-dismisses after ~5s. */
  notice: string | null;
  /** In-flight progress message (e.g. the ~10s launch proxy probe). Shown in
   *  the SAME banner as `notice`, but the 5s auto-dismiss skips it — a slow-but-
   *  normal launch must keep its progress indicator until the success/error
   *  branch overwrites it (audit #15). null when nothing is in flight. */
  progressNotice: string | null;
}

interface RailTaxonomyProfileUpdate {
  id: string;
  body: UpdateProfileRequest;
}

interface RailTaxonomySyncPlan {
  action: string;
  organization: AccountOrganization | null;
  profileUpdates: RailTaxonomyProfileUpdate[];
  profileTotal: number;
}

interface RailTaxonomyLocalResult<T> {
  value: T;
  organization: AccountOrganization;
  profileUpdates?: RailTaxonomyProfileUpdate[];
}

interface RailTaxonomyTransport {
  baseUrl: string;
  apiKey: string | null;
  workspace: string | null;
  client: {
    profiles: {
      update: (id: string, body: UpdateProfileRequest) => Promise<unknown>;
    };
  } | null;
}

// ProfilesView is intentionally remounted at the workspace boundary. Retain a
// small failed-write plan outside that keyed subtree so a late A failure is not
// lost while B is mounted. Entries contain only bounded taxonomy/profile intent
// and the public cache scope — never credentials or raw errors.
const MAX_RETAINED_TAXONOMY_RETRIES = 16;
const railTaxonomyRetriesByScope = new Map<string, RailTaxonomySyncPlan>();

function rememberRailTaxonomyRetry(scope: string, retry: RailTaxonomySyncPlan | null): void {
  railTaxonomyRetriesByScope.delete(scope);
  if (retry === null) return;
  railTaxonomyRetriesByScope.set(scope, retry);
  while (railTaxonomyRetriesByScope.size > MAX_RETAINED_TAXONOMY_RETRIES) {
    const oldest = railTaxonomyRetriesByScope.keys().next().value;
    if (oldest === undefined) break;
    railTaxonomyRetriesByScope.delete(oldest);
  }
}

/** Build a persisted taxonomy namespace from public endpoint/account identity
 * only. An API credential is deliberately neither accepted nor derivable here. */
function buildTaxonomyCacheScope(baseUrl: string, effectiveAccountId: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin.toLowerCase()}|account:${effectiveAccountId}`;
  } catch {
    return null;
  }
}

function railTaxonomySyncMessage(plan: RailTaxonomySyncPlan): string {
  const account = plan.organization === null ? '' : 'organization';
  const profiles = plan.profileUpdates.length;
  const detail =
    account.length > 0 && profiles > 0
      ? `${account} and ${profiles.toString()} of ${plan.profileTotal.toString()} profiles`
      : account.length > 0
        ? account
        : `${profiles.toString()} of ${plan.profileTotal.toString()} profiles`;
  return `Saved on this Mac, but couldn’t sync the ${plan.action} to your account (${detail}). Retry the remaining sync.`;
}

/** Friendly device label for the simulator toolbar, derived from the archetype
 *  slug: "iphone17_ios18_7_safari26_4" → "iPhone 17", "iphone16pro_…" → "iPhone
 *  16 Pro". Falls back to the raw first segment (or "iPhone") for an
 *  unrecognised shape, so a future archetype never renders blank. */
export function formatDeviceName(archetype: string): string {
  const seg = archetype.split('_')[0] ?? archetype;
  const m = /^iphone(\d+)(pro)?(max)?(e)?$/i.exec(seg);
  if (m === null) return seg || 'iPhone';
  const [, num, pro, max, e] = m;
  return ['iPhone', `${num}${e ? 'e' : ''}`, pro ? 'Pro' : '', max ? 'Max' : '']
    .filter(Boolean)
    .join(' ');
}

// doc-150 items 5/6 — human-readable byte size, mirroring the customer
// dashboard's fmtBytes. `null`/`undefined`/negative/non-finite → "—" (a profile
// that's never been saved has no size). BINARY units (1024-based, KiB/MiB/GiB)
// so the quota cap renders the EXACT plan number — TIER_STORAGE_BYTES_CAP is
// declared in GiB (N * 2**30), so a decimal (1000-based) basis would overstate
// the allowance (~7% high). Used bytes share this basis, so the % + bar stay
// correct. 1 decimal place above KiB.
export function fmtBytes(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n.toString()} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i] ?? 'TiB'}`;
}

// 2026-06-20 — UNIFIED sort plumbing. The action-bar (ProfileSortBy) and the
// list-view table headers (ProfilesTableSortKey) speak almost the same
// vocabulary; the only mismatch is last-used ↔ lastUsed. These pure maps keep
// the two in lockstep so a grid↔list toggle (or a header click) never changes
// the order out from under the operator.
function mapTableSortKey(key: ProfilesTableSortKey): ProfileSortBy {
  return key === 'lastUsed' ? 'last-used' : key;
}
function mapSortByToTableKey(by: ProfileSortBy): ProfilesTableSortKey {
  return by === 'last-used' ? 'lastUsed' : by;
}
// Natural first-click direction per key, mirroring the prior grid behavior:
// recency keys default to descending (newest first); name/status/country to
// ascending (A→Z, idle→live, country A→Z).
function defaultSortDir(by: ProfileSortBy): ProfileSortDir {
  return by === 'created' || by === 'last-used' ? 'desc' : 'asc';
}

function ProfilesLoadingRail(): JSX.Element {
  return (
    <aside data-component="profiles-loading-rail" className={PROFILES_RAIL_CLASS}>
      <Skeleton className="mx-2.5 mb-1 h-2.5 w-14" />
      {['w-16', 'w-12', 'w-14', 'w-11'].map((width) => (
        <div key={width} className="flex h-7 items-center gap-2 rounded-lg px-2.5">
          <Skeleton className="h-3.5 w-3.5 shrink-0 rounded" />
          <Skeleton className={`h-2.5 ${width}`} />
          <Skeleton className="ml-auto h-3 w-5 rounded-full" />
        </div>
      ))}
      <Skeleton className="mx-1.5 mt-1 h-8 rounded-lg" />
      <Skeleton className="mx-2.5 mb-1 mt-3 h-2.5 w-9" />
      {['w-12', 'w-16'].map((width) => (
        <div key={width} className="flex h-7 items-center gap-2 rounded-lg px-2.5">
          <Skeleton className="h-1.5 w-1.5 shrink-0 rounded-full" />
          <Skeleton className={`h-2.5 ${width}`} />
          <Skeleton className="ml-auto h-3 w-5 rounded-full" />
        </div>
      ))}
      <Skeleton className="mx-1.5 mt-1 h-8 rounded-lg" />
      <Skeleton className="mx-1.5 mt-3 h-8 rounded-lg" />
    </aside>
  );
}

function ProfilePhoneCardSkeleton(): JSX.Element {
  return (
    <div
      data-component="profiles-loading-phone-card"
      className="rounded-[24px] border border-[#0a0d12] bg-[#0a0e14] p-1.5"
    >
      <div className="relative flex aspect-[9/18.5] flex-col overflow-hidden rounded-[17px] bg-surface-raised px-2.5 pb-2 pt-[26px]">
        <Skeleton className="h-3.5 w-20" />
        <div className="flex flex-col items-center gap-2 pt-5">
          <Skeleton className="h-11 w-11 rounded-full" />
          <Skeleton className="h-3.5 w-24" />
        </div>
        <div className="mt-3 flex flex-col gap-2 rounded-[12px] border border-surface-divider p-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-2.5 flex-1" />
          </div>
          <Skeleton className="h-2 w-3/4" />
        </div>
        <div className="mt-auto flex flex-col gap-2">
          <Skeleton className="h-2.5 w-2/3" />
          <Skeleton className="h-8 w-full rounded-lg" />
          <div className="flex justify-center gap-2">
            <Skeleton className="h-5 w-10 rounded-full" />
            <Skeleton className="h-5 w-10 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

const LOADING_TABLE_COLUMNS: ReadonlyArray<{ width: string; className?: string }> = [
  { width: 'w-24' },
  { width: 'w-12', className: 'ds-col-l' },
  { width: 'w-12', className: 'ds-col-m' },
  { width: 'w-20' },
  { width: 'w-9', className: 'ds-col-m' },
  { width: 'w-14', className: 'ds-col-l' },
  { width: 'w-16', className: 'ds-col-l' },
  { width: 'w-14', className: 'ds-col-l' },
  { width: 'w-16', className: 'ds-col-l' },
  { width: 'w-20' },
];

function ProfilesTableSkeleton(): JSX.Element {
  return (
    <div
      data-component="profiles-loading-table"
      className="ds-table-shell overflow-x-auto rounded-lg border border-surface-divider bg-surface-raised"
    >
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-surface-divider">
            <th className="w-9 px-3 py-2">
              <Skeleton className="h-3.5 w-3.5 rounded" />
            </th>
            {LOADING_TABLE_COLUMNS.map((column, index) => (
              <th key={index} className={`px-3 py-2 ${column.className ?? ''}`}>
                <Skeleton className={`h-2.5 ${column.width}`} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, row) => (
            <tr key={row} className="border-b border-surface-divider/60 last:border-0">
              <td className="px-3 py-2">
                <Skeleton className="h-3.5 w-3.5 rounded" />
              </td>
              <td className="px-3 py-2">
                <div className="flex items-start gap-2">
                  <Skeleton className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" />
                  <div className="flex flex-col gap-1.5">
                    <Skeleton className={`h-3 ${row % 2 === 0 ? 'w-24' : 'w-20'}`} />
                    <Skeleton className="h-2 w-28" />
                  </div>
                </div>
              </td>
              <td className="ds-col-l px-3 py-2">
                <Skeleton className="h-4 w-12 rounded" />
              </td>
              <td className="ds-col-m px-3 py-2">
                <Skeleton className="h-4 w-10 rounded" />
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-2 w-14" />
                </div>
              </td>
              <td className="ds-col-m px-3 py-2">
                <Skeleton className="h-3 w-8" />
              </td>
              <td className="ds-col-l px-3 py-2">
                <Skeleton className="h-3 w-14" />
              </td>
              <td className="ds-col-l px-3 py-2">
                <Skeleton className="h-3 w-16" />
              </td>
              <td className="ds-col-l px-3 py-2">
                <Skeleton className="h-3 w-12" />
              </td>
              <td className="ds-col-l px-3 py-2">
                <Skeleton className="h-3 w-20" />
              </td>
              <td className="px-3 py-2">
                <div className="ml-auto flex w-max gap-1.5">
                  <Skeleton className="h-6 w-12 rounded" />
                  <Skeleton className="h-6 w-8 rounded" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProfilesInitialSkeleton({ viewMode }: { viewMode: ProfilesViewMode }): JSX.Element {
  return (
    <SkeletonRegion
      label="Loading profiles"
      className="min-h-0 flex-1"
      contentClassName={`${PROFILES_WORKSPACE_CLASS} h-full`}
    >
      <ProfilesLoadingRail />
      <div className={PROFILES_CONTENT_CLASS}>
        <div className={PROFILES_SCROLL_CLASS}>
          {viewMode === 'grid' ? (
            <div data-component="profiles-loading-grid" className={PROFILES_GRID_CLASS}>
              {Array.from({ length: 6 }).map((_, index) => (
                <ProfilePhoneCardSkeleton key={index} />
              ))}
            </div>
          ) : (
            <div data-component="profiles-loading-list">
              <ProfilesTableSkeleton />
            </div>
          )}
        </div>
      </div>
    </SkeletonRegion>
  );
}

export interface ProfilesViewProps {
  onGoToSettings: () => void;
  /** F1c — open the AI assistant scoped to a profile (from a card's "Assist"). */
  onAssist?: (profileId: string) => void;
  /** Deep-link target (CommandCenter "Jump back in" card → App nav payload):
   *  once the profile list has loaded, select + scroll-to this profile so the
   *  view lands ON it instead of the bare list. Best-effort — an id no longer in
   *  the account (deleted/cross-account) is silently ignored. */
  initialProfileId?: string;
}

export function ProfilesView({
  onGoToSettings,
  onAssist,
  initialProfileId,
}: ProfilesViewProps): JSX.Element {
  const { client, settings, accountMe, refreshAccountMe, activeWorkspace, setActiveWorkspace } =
    useSettings();
  // Offline taxonomy may render or seed only after /account/me validates the
  // effective owner. A persisted/revoked workspace id is not sufficient: it
  // must still be present in the authenticated caller's memberships.
  const effectiveTaxonomyAccountId =
    activeWorkspace === null
      ? (accountMe?.id ?? null)
      : (accountMe?.teams ?? []).some((team) => team.owner_account_id === activeWorkspace)
        ? activeWorkspace
        : null;
  const taxonomyCacheScope = useMemo(
    () =>
      effectiveTaxonomyAccountId === null
        ? null
        : buildTaxonomyCacheScope(settings.baseUrl, effectiveTaxonomyAccountId),
    [effectiveTaxonomyAccountId, settings.baseUrl],
  );
  // 2026-05-20 — antidetect-browser-style hub: profiles are first-class,
  // sessions are an implementation detail of "this profile is running".
  // Track live sessions + GUI-local bindings so we can show per-profile
  // Launch/Stop buttons + a status badge per row.
  const [activeSessions, setActiveSessions] = useState<Session[]>([]);
  // Worktimer (2026-06-16) — agent sessions (id + created_at) for the running-
  // row live-elapsed timer; agent sessions aren't in activeSessions (driver-
  // only), so we fetch them separately. Empty when the runtime isn't wired.
  // W2679 — each entry also carries the server-reported `liveness` (state +
  // fresh), which boundSession consults to demote a stale/idle session without a
  // separate client-side page-state probe. `liveness` is OMITTED on deployments
  // with no fleet control plane / before a beat reports the session → treat
  // absent as "unknown, trust the binding", never as "dead".
  const [agentSessions, setAgentSessions] = useState<
    Array<{
      id: string;
      created_at: string;
      status: string;
      liveness?: {
        state: 'active' | 'provisioning' | 'idle' | 'terminating' | null;
        fresh: boolean;
      };
    }>
  >([]);
  // True once the live agent-session list has been fetched at least once. Until
  // then boundSession TRUSTS the binding — a transient list-fetch miss must not
  // flip a genuinely-running profile to idle.
  const [agentSessionsLoaded, setAgentSessionsLoaded] = useState(false);
  const [bindings, setBindings] = useState<ProfileBinding[]>([]);
  const [proxies, setProxies] = useState<LocalProxyConfig[]>([]);
  // V-239 — gate the New profile button at the tier cap (skip when
  // profile_cap === null which means enterprise / no fixed cap).
  const profileCap = accountMe?.profile_cap ?? null;
  const profileCount = accountMe?.profile_count ?? null;
  const atProfileCap = profileCap !== null && profileCount !== null && profileCount >= profileCap;
  // Shared cap-reached tooltip for the New / Duplicate / Import affordances.
  const profileCapReason = `Profile cap reached (${(profileCap ?? 0).toString()} for ${
    accountMe?.tier ?? 'this tier'
  }). Delete a profile or upgrade to add more.`;
  // Consistency #9 — gate Launch at the CONCURRENT-SESSION cap (mirrors
  // SessionsView's New-session gate). Launching a profile creates an agent
  // session that consumes a concurrent slot; the server returns a 402 at the
  // cap, but only AFTER a ~12s pre-launch proxy probe → a slow, opaque reject.
  // Pre-check the cap so Launch is greyed with a clear reason instead. The
  // server's `concurrent_session_active` is driver-only, so add the active
  // agent sessions this view already tracks (disjoint ids → no double-count).
  const activeAgentCount = agentSessions.filter((s) => s.status === 'active').length;
  const concurrentCap = accountMe?.concurrent_session_cap ?? null;
  const concurrentActive =
    accountMe?.concurrent_session_active !== undefined
      ? accountMe.concurrent_session_active + activeAgentCount
      : null;
  const atConcurrentCap =
    concurrentCap !== null && concurrentActive !== null && concurrentActive >= concurrentCap;
  const concurrentCapReason = `Concurrent session cap reached (${(concurrentCap ?? 0).toString()} for ${
    accountMe?.tier ?? 'this tier'
  }). Stop a running session or upgrade to launch more.`;
  // Teams (2026-06-16) — the server now lets a team ADMIN launch the owner's
  // profiles (agent-sessions create honors X-Driftstack-Account for admins;
  // the client already ships that header for the active workspace). So launch
  // is blocked only for NON-admin members of a team workspace; admins + Personal
  // can launch.
  const activeRole =
    activeWorkspace !== null
      ? ((accountMe?.teams ?? []).find((t) => t.owner_account_id === activeWorkspace)?.role ?? null)
      : null;
  const teamLaunchBlocked = activeWorkspace !== null && activeRole !== 'admin';
  const teamLaunchBlockedReason =
    'Shared team profile — ask a team admin to launch it (you have read-only access here).';
  const [state, setState] = useState<ProfilesState>({
    profiles: [],
    refreshedAt: null,
    loading: false,
    loadError: null,
    error: null,
    notice: null,
    progressNotice: null,
  });
  // A React loading flag is not an admission/publication authority: same-scope
  // polls can overlap, and an old client can settle after account replacement.
  // Every async publication below must still own both the latest generation and
  // the client/workspace captured by its invocation.
  const refreshGenerationRef = useRef(0);
  const refreshClientOwnerRef = useRef(client);
  const refreshWorkspaceOwnerRef = useRef(activeWorkspace);
  refreshClientOwnerRef.current = client;
  refreshWorkspaceOwnerRef.current = activeWorkspace;
  const [busyId, setBusyId] = useState<string | null>(null);
  // `busyId` is shared by launch, stop, reopen, clone, trim, and delete. Keep the
  // launch identity separate so only a REAL launch shows the long-running
  // "Starting…" treatment; otherwise an unrelated action on this row could make
  // its disabled Launch button claim the wrong work is happening.
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  // V-238 — create-form modal state. Lives here (not lifted to App.tsx)
  // because every other ProfilesView interaction is local; the modal
  // is a transient overlay scoped to this view's lifecycle.
  const [createOpen, setCreateOpen] = useState(false);
  // Edit-profile modal target (null = closed). Holds the Profile being edited so
  // the modal can seed name/description from it + icon/folder/tags/note from
  // profilesMeta. Archetype is immutable post-create so it isn't editable.
  const [editTarget, setEditTarget] = useState<Profile | null>(null);
  // Import-profile modal state (V-480) — drop/paste an export envelope (single
  // object or a bulk array) to mint fresh profiles in this account.
  const [importOpen, setImportOpen] = useState(false);
  // founder 2026-06-20: clone (currently useless) + export/import (a profile-cheat
  // abuse vector) are hidden from the UI for now; the handlers, SDK methods, and
  // server endpoints are kept intact — flip these to re-enable.
  const CLONE_ENABLED = false;
  const IMPORT_EXPORT_ENABLED = false;
  // 2026-05-21 — header action cluster (operator-UI polish wave).
  // Pure-local filter/sort over `state.profiles`; no API change. Defaults
  // mirror the "what did I touch last" mental model that dominates
  // operator usage (show all, sort by recent use).
  const [searchQuery, setSearchQuery] = useState('');
  // Perf (audit 2026-07-08): the search box drives the expensive filter+sort over ALL
  // profiles (+ a full grid re-render). Defer the value the FILTER reads so typing stays
  // instant (the input is still bound to the live `searchQuery`) while React can
  // interrupt/deprioritize the heavy recompute — no per-keystroke jank on a big profile set.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  // Fleet hub (2026-06-12, demo-concepts greenlight): grid/list toggle.
  // Grid is the DEFAULT (founder directive 2026-06-12 night arc) — the
  // visual workspace is the product; list remains a toggle for dense ops. Keep
  // the operator's explicit choice across relaunches (validated so a stale or
  // hand-edited storage value cannot put the view into an impossible state).
  const [viewMode, setViewMode] = useState<ProfilesViewMode>(loadProfilesViewMode);
  const changeViewMode = useCallback((next: ProfilesViewMode): void => {
    setViewMode(next);
    try {
      window.localStorage.setItem(PROFILES_VIEW_MODE_KEY, next);
    } catch {
      // Storage can be unavailable in a hardened WebView. The in-memory choice
      // still applies for this window; persistence is a convenience, not a gate.
    }
  }, []);
  // Increment 2 — client-persisted organization (folders/tags/notes).
  const [profilesMeta, setProfilesMeta] = useState<ProfilesMetaMap>({});
  // Night-arc B: last probe result per proxy id (written by the Proxies
  // tab's Test actions) — cards render the UDP badge from it; absent =
  // honest 'untested'.
  const [probeCache, setProbeCache] = useState<ProbeCacheMap>({});
  // S3 — per-card proxy "Test" in flight (proxy id), so the card can show
  // "Testing…" + disable the button while the native SOCKS5 + exit-geo probe runs.
  const [testingProxyId, setTestingProxyId] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<string>('all');
  // 2026-06-15 (founder) — user-created folder names persisted independently of
  // profiles, so an empty folder made from the rail's "New folder" affordance
  // survives. The rail/pickers show the UNION of these + folders derived from
  // profile metadata. `newFolderName` drives the inline create input.
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  // 2026-06-16 (founder) — per-folder icon (name→emoji), shown in the rail.
  const [customFolderIcons, setCustomFolderIcons] = useState<Record<string, string>>({});
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderIcon, setNewFolderIcon] = useState('');
  // G3 — filter the grid by a single tag (null = all). Composes (AND) with the
  // folder + status + search filters.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 2026-06-16 (founder) — tags moved into the LEFT rail under Folders, with a
  // create affordance mirroring "New folder". User-created tag names persist so
  // an empty tag survives; the rail shows the UNION of these + derived tags.
  const [customTags, setCustomTags] = useState<string[]>([]);
  const [creatingTag, setCreatingTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  // Folder/tag create/delete/re-icon/rename plus retry share one synchronous
  // owner. The retry plan stores only bounded organization/profile intent — no
  // credential, raw error, or filesystem detail.
  const [railTaxonomyBusy, setRailTaxonomyBusy] = useState(false);
  const [railTaxonomyRetry, setRailTaxonomyRetry] = useState<RailTaxonomySyncPlan | null>(null);
  const railTaxonomyMutationOwnerRef = useRef<symbol | null>(null);
  const railTaxonomyMutationGenerationRef = useRef(0);
  const taxonomyReconcileGenerationRef = useRef(0);
  const railTaxonomyClientOwnerRef = useRef(client);
  const railTaxonomyScopeOwnerRef = useRef(taxonomyCacheScope);
  railTaxonomyClientOwnerRef.current = client;
  railTaxonomyScopeOwnerRef.current = taxonomyCacheScope;
  const railTaxonomyControlsBlocked =
    railTaxonomyBusy || railTaxonomyRetry !== null || taxonomyCacheScope === null;
  // Increment 3 — bulk select: client-side organize actions over a selection.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkFolder, setBulkFolder] = useState('');
  const [bulkTag, setBulkTag] = useState('');
  const [bulkOrganizationBusy, setBulkOrganizationBusy] = useState(false);
  // React's disabled state commits after the handler returns. Keep one synchronous
  // owner across every bulk organization action so rapid same-turn clicks (or an
  // alternate action) cannot duplicate local writes and account PATCHes.
  const bulkOrganizationMutationInFlightRef = useRef(false);
  const [bulkExporting, setBulkExporting] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkLaunching, setBulkLaunching] = useState(false);
  // L4b recycle bin — Trash view: a rail entry flips trashView on, which swaps
  // the grid/table for a list of soft-deleted profiles with Restore actions.
  const [trashView, setTrashView] = useState(false);
  const [trashed, setTrashed] = useState<Profile[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashDataAvailable, setTrashDataAvailable] = useState(false);
  const [trashLoadError, setTrashLoadError] = useState<string | null>(null);
  const trashLoadGenerationRef = useRef(0);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [purgingId, setPurgingId] = useState<string | null>(null);
  // 2026-06-20 — bulk trash actions run as a SEQUENTIAL per-row loop over the
  // existing single-id endpoints (no server bulk endpoint yet — see the
  // restoreAll/emptyTrash follow-up note on the SDK). `bulkTrashBusy` flags an
  // in-flight Restore-all / Empty-trash so the row + bulk buttons disable.
  const [bulkTrashBusy, setBulkTrashBusy] = useState(false);
  const [bulkTrashAction, setBulkTrashAction] = useState<'restore' | 'empty' | null>(null);
  // All recycle-bin mutations share one synchronous owner. React state disables
  // the rendered controls, but it cannot stop two callbacks in the same turn;
  // without this latch a double activation (or row action + bulk action) can
  // issue duplicate/overlapping restore and irreversible purge requests.
  const trashMutationInFlightRef = useRef(false);
  const confirm = useConfirm();
  // Onboarding checklist dismissal — webview localStorage persists per
  // install. Guarded: some embeddings/test environments stub storage out.
  const { dismissed: onboardingDismissed, dismiss: dismissOnboarding } = useOnboardingDismissed();
  // Night-arc D — privacy banner (hub demo). Claims limited to wording
  // already shipped on the production dashboard trust surface; the
  // demo's stronger phrasing stays gated on founder+legal sign-off.
  const [privacyDismissed, setPrivacyDismissed] = useState(() => {
    try {
      return localStorage.getItem('ds_privacy_banner_dismissed') === '1';
    } catch {
      return false;
    }
  });
  const [statusFilter, setStatusFilter] = useState<ProfileStatusFilter>('all');
  // 2026-06-20 — UNIFIED sort: `sortBy` + `sortDir` are the SINGLE source of
  // truth for BOTH the grid and the list-view (table). Previously the table kept
  // its own sortKey/sortDir and re-sorted the already-grid-sorted list, so a
  // grid↔list toggle silently changed the order. Now the action-bar dropdown and
  // the table column headers read/write the same state, and `filteredProfiles`
  // is the single ordered list (the table renders it verbatim). Default last-used
  // descending (most-recent first) mirrors the prior grid default.
  const [sortBy, setSortBy] = useState<ProfileSortBy>('last-used');
  const [sortDir, setSortDir] = useState<ProfileSortDir>('desc');
  // Picking a sort key (dropdown OR a table header) seeds that key's natural
  // direction when it CHANGES the key, and toggles direction when the SAME key
  // is re-selected — the long-standing table-header behavior, now shared so the
  // grid dropdown and the table headers stay in lockstep.
  const changeSort = useCallback((next: ProfileSortBy) => {
    setSortBy((cur) => {
      if (cur === next) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return cur;
      }
      setSortDir(defaultSortDir(next));
      return next;
    });
  }, []);
  // F1 deep-link (CommandCenter "Jump back in") — consume `initialProfileId`
  // ONCE, after the first load that actually contains it. Tracked by ref so the
  // 15s background poll re-rendering the list never re-selects/re-scrolls (which
  // would yank the view away from wherever the operator scrolled to).
  const deepLinkConsumed = useRef(false);

  useEffect(() => {
    void loadProfilesMeta().then(setProfilesMeta);
    void loadProbeCache().then(setProbeCache);
  }, []);

  // F1 deep-link — once the list has loaded WITH the requested profile, select it,
  // drop any active filters/trash view that would hide it, and scroll its card
  // into view. Consumed once (deepLinkConsumed) so background polls don't re-grab
  // focus. A missing id (deleted / cross-account) is silently left unconsumed-but-
  // skipped — there's nothing to land on.
  useEffect(() => {
    if (deepLinkConsumed.current) return;
    if (initialProfileId === undefined || initialProfileId.length === 0) return;
    const target = state.profiles.find((p) => p.id === initialProfileId);
    if (target === undefined) return;
    deepLinkConsumed.current = true;
    // Clear filters that could hide the target, leave the trash view, and select it.
    setTrashView(false);
    setSearchQuery('');
    setFolderFilter('all');
    setTagFilter(null);
    setStatusFilter('all');
    setSelectedIds(new Set([initialProfileId]));
    // Scroll to the card after the cleared filters re-render it (grid is default;
    // in table view the selection still highlights the row even if the row isn't
    // tagged for scroll).
    window.setTimeout(() => {
      const el = document.querySelector(`[data-profile-id="${CSS.escape(initialProfileId)}"]`);
      if (el !== null) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 0);
  }, [initialProfileId, state.profiles]);

  // Pull the account taxonomy and reconcile its identity-bound offline cache.
  // A cache snapshot is eligible only when /account/me validated its effective
  // owner above. Legacy global folders.json/tags.json keys are never read here,
  // and the API credential is never part of a persisted cache key.
  useEffect(() => {
    const scope = taxonomyCacheScope;
    if (scope === null) {
      // Fail closed while identity is unavailable/revoked: neither render nor
      // seed taxonomy whose owner cannot be proven.
      setCustomFolders([]);
      setCustomFolderIcons({});
      setCustomTags([]);
      return;
    }
    const apiKey = settings.apiKey;
    const generation = ++taxonomyReconcileGenerationRef.current;
    let cancelled = false;
    const isCurrentReconciliation = (): boolean =>
      !cancelled && generation === taxonomyReconcileGenerationRef.current;
    void (async () => {
      const [localFolders, localIcons, localTags] = await Promise.all([
        loadFolders(scope),
        loadFolderIcons(scope),
        loadTags(scope),
      ]);
      if (!isCurrentReconciliation()) return;
      setCustomFolders(localFolders);
      setCustomFolderIcons(localIcons);
      setCustomTags(localTags);
      // A failed admitted local-first mutation owns newer truth than the server.
      // Keep showing this scoped cache until its retained remote remainder is
      // successfully retried; otherwise an older successful GET could overwrite
      // the local change on return to this workspace.
      if (railTaxonomyRetriesByScope.has(scope)) return;
      if (apiKey === null || apiKey.length === 0) return;
      try {
        const org = await fetchOrganization(settings.baseUrl, apiKey, activeWorkspace);
        if (!isCurrentReconciliation()) return;
        const hasBoundLocalValues = localFolders.length > 0 || localTags.length > 0;
        if (hasBoundLocalValues && org.folders.length === 0 && org.tags.length === 0) {
          // #441 offline-then-online: only a cache already bound to this exact
          // endpoint/account may seed its empty server record.
          await saveOrganization(
            settings.baseUrl,
            apiKey,
            {
              folders: localFolders.map((name) =>
                localIcons[name] !== undefined && localIcons[name].length > 0
                  ? { name, icon: localIcons[name] }
                  : { name },
              ),
              tags: localTags,
            },
            activeWorkspace,
          );
          return;
        }
        const names = org.folders.map((f) => f.name);
        const icons: Record<string, string> = {};
        for (const f of org.folders)
          if (f.icon !== undefined && f.icon.length > 0) icons[f.name] = f.icon;
        await Promise.all([
          replaceAllFolders(names, icons, scope),
          replaceAllTags(org.tags, scope),
        ]);
        if (!isCurrentReconciliation()) return;
        setCustomFolders([...names].sort((a, b) => a.localeCompare(b)));
        setCustomFolderIcons(icons);
        setCustomTags([...org.tags].sort((a, b) => a.localeCompare(b)));
      } catch {
        /* offline / unauth → keep only this validated identity's local cache */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.apiKey, settings.baseUrl, activeWorkspace, taxonomyCacheScope]);

  const buildRailOrganization = useCallback(
    (folders: string[], icons: Record<string, string>, tags: string[]): AccountOrganization => ({
      folders: folders.map((name) =>
        icons[name] !== undefined && icons[name].length > 0
          ? { name, icon: icons[name] }
          : { name },
      ),
      tags,
    }),
    [],
  );

  const syncRailTaxonomy = useCallback(
    async (
      plan: RailTaxonomySyncPlan,
      transport: RailTaxonomyTransport,
    ): Promise<RailTaxonomySyncPlan | null> => {
      const { apiKey } = transport;
      const profileClient = transport.client;
      const hasAccountTransport = apiKey !== null && apiKey.length > 0;
      const accountSettlements =
        plan.organization !== null && hasAccountTransport
          ? Promise.allSettled([
              saveOrganization(transport.baseUrl, apiKey, plan.organization, transport.workspace),
            ])
          : Promise.resolve([]);
      const profileSettlements =
        profileClient === null
          ? Promise.resolve([])
          : Promise.allSettled(
              plan.profileUpdates.map(async ({ id, body }) =>
                profileClient.profiles.update(id, body),
              ),
            );
      const [accountResults, profileResults] = await Promise.all([
        accountSettlements,
        profileSettlements,
      ]);
      const organizationFailed =
        plan.organization !== null &&
        (!hasAccountTransport || accountResults[0]?.status === 'rejected');
      const failedProfileUpdates =
        profileClient === null
          ? plan.profileUpdates
          : plan.profileUpdates.filter(
              (_update, index) => profileResults[index]?.status === 'rejected',
            );
      if (!organizationFailed && failedProfileUpdates.length === 0) return null;
      return {
        ...plan,
        organization: organizationFailed ? plan.organization : null,
        profileUpdates: failedProfileUpdates,
      };
    },
    [],
  );

  const runRailTaxonomyMutation = useCallback(
    async <T,>(
      action: string,
      saveLocal: (scope: string) => Promise<RailTaxonomyLocalResult<T>>,
      publishLocal: (value: T) => void,
    ): Promise<boolean> => {
      const scope = taxonomyCacheScope;
      if (scope === null) {
        setState((s) => ({
          ...s,
          error:
            'Couldn’t verify which account owns this organization. Refresh your account and try again.',
        }));
        return false;
      }
      if (railTaxonomyMutationOwnerRef.current !== null || railTaxonomyRetry !== null) return false;
      const owner = Symbol('rail-taxonomy-mutation');
      railTaxonomyMutationOwnerRef.current = owner;
      // A rail mutation is newer than any GET/cache reconciliation already in
      // flight for this scope. Its local-first write must win that race.
      taxonomyReconcileGenerationRef.current += 1;
      const generation = ++railTaxonomyMutationGenerationRef.current;
      const ownedClient = client;
      const admittedTransport: RailTaxonomyTransport = {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        workspace: activeWorkspace,
        client,
      };
      const isCurrentOwner = (): boolean =>
        railTaxonomyMutationOwnerRef.current === owner &&
        generation === railTaxonomyMutationGenerationRef.current &&
        railTaxonomyClientOwnerRef.current === ownedClient &&
        railTaxonomyScopeOwnerRef.current === scope;
      setRailTaxonomyBusy(true);
      setState((s) => ({ ...s, error: null }));
      try {
        const saved = await saveLocal(scope);
        if (isCurrentOwner()) publishLocal(saved.value);
        const profileUpdates = saved.profileUpdates ?? [];
        // Owner invalidation suppresses stale UI only. The already-admitted,
        // identity-scoped write still settles through its captured A transport.
        const retry = await syncRailTaxonomy(
          {
            action,
            organization: saved.organization,
            profileUpdates,
            profileTotal: profileUpdates.length,
          },
          admittedTransport,
        );
        rememberRailTaxonomyRetry(scope, retry);
        if (isCurrentOwner()) setRailTaxonomyRetry(retry);
        return true;
      } catch {
        if (isCurrentOwner()) {
          setState((s) => ({
            ...s,
            error: `Couldn’t save the ${action} on this Mac. Check app storage and try again.`,
          }));
        }
        return false;
      } finally {
        if (railTaxonomyMutationOwnerRef.current === owner) {
          railTaxonomyMutationOwnerRef.current = null;
          if (
            generation === railTaxonomyMutationGenerationRef.current &&
            railTaxonomyClientOwnerRef.current === ownedClient &&
            railTaxonomyScopeOwnerRef.current === scope
          ) {
            setRailTaxonomyBusy(false);
          }
        }
      }
    },
    [
      activeWorkspace,
      client,
      railTaxonomyRetry,
      settings.apiKey,
      settings.baseUrl,
      syncRailTaxonomy,
      taxonomyCacheScope,
    ],
  );

  const retryRailTaxonomySync = useCallback(async (): Promise<void> => {
    const retry = railTaxonomyRetry;
    const scope = taxonomyCacheScope;
    if (retry === null || scope === null || railTaxonomyMutationOwnerRef.current !== null) return;
    const owner = Symbol('rail-taxonomy-retry');
    railTaxonomyMutationOwnerRef.current = owner;
    const generation = ++railTaxonomyMutationGenerationRef.current;
    const ownedClient = client;
    const isCurrentOwner = (): boolean =>
      railTaxonomyMutationOwnerRef.current === owner &&
      generation === railTaxonomyMutationGenerationRef.current &&
      railTaxonomyClientOwnerRef.current === ownedClient &&
      railTaxonomyScopeOwnerRef.current === scope;
    setRailTaxonomyBusy(true);
    try {
      const remaining = await syncRailTaxonomy(retry, {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        workspace: activeWorkspace,
        client,
      });
      rememberRailTaxonomyRetry(scope, remaining);
      if (!isCurrentOwner()) return;
      setRailTaxonomyRetry(remaining);
      if (remaining === null) {
        setState((s) => ({ ...s, notice: 'Profile organization is fully synced.' }));
      }
    } finally {
      if (railTaxonomyMutationOwnerRef.current === owner) {
        railTaxonomyMutationOwnerRef.current = null;
        if (
          generation === railTaxonomyMutationGenerationRef.current &&
          railTaxonomyClientOwnerRef.current === ownedClient &&
          railTaxonomyScopeOwnerRef.current === scope
        ) {
          setRailTaxonomyBusy(false);
        }
      }
    }
  }, [
    activeWorkspace,
    client,
    railTaxonomyRetry,
    settings.apiKey,
    settings.baseUrl,
    syncRailTaxonomy,
    taxonomyCacheScope,
  ]);

  useEffect(() => {
    setRailTaxonomyBusy(false);
    setRailTaxonomyRetry(
      taxonomyCacheScope === null
        ? null
        : (railTaxonomyRetriesByScope.get(taxonomyCacheScope) ?? null),
    );
    return () => {
      railTaxonomyMutationGenerationRef.current += 1;
      railTaxonomyMutationOwnerRef.current = null;
    };
  }, [client, taxonomyCacheScope]);

  const refresh = useCallback(
    async (showLoading: boolean): Promise<void> => {
      const generation = ++refreshGenerationRef.current;
      const isCurrentRefresh = (): boolean =>
        generation === refreshGenerationRef.current &&
        refreshClientOwnerRef.current === client &&
        refreshWorkspaceOwnerRef.current === activeWorkspace;
      if (!client) {
        if (!isCurrentRefresh()) return;
        setActiveSessions([]);
        setAgentSessions([]);
        setAgentSessionsLoaded(false);
        setBindings([]);
        setProxies([]);
        setState({
          profiles: [],
          refreshedAt: null,
          loading: false,
          loadError: null,
          error: null,
          notice: null,
          progressNotice: null,
        });
        return;
      }
      if (showLoading) setState((s) => ({ ...s, loading: true }));
      try {
        // Fetch profiles + active sessions in parallel — both feed the hub.
        const [profilesPage, sessionsPage, currentBindings, currentProxies] = await Promise.all([
          (async () => {
            const collected: Profile[] = [];
            for await (const profile of client.profiles.iterate({ limit: 50 })) {
              collected.push(profile);
            }
            return collected;
          })(),
          client.sessions.list(),
          listBindings(),
          listProxies(),
        ]);
        if (!isCurrentRefresh()) return;
        setActiveSessions(sessionsPage.data);
        setBindings(currentBindings);
        setProxies(currentProxies);
        // Worktimer (founder) — fetch agent sessions (best-effort, separate
        // from the critical Promise.all: the list endpoint 503s when the agent
        // runtime isn't wired, which must not blank the whole hub). Gives the
        // running-row live "running for" timer the agent session's created_at
        // (driver sessions already carry it in activeSessions).
        if (typeof client.agentSessions.list === 'function') {
          void client.agentSessions
            .list()
            .then((page) => {
              if (!isCurrentRefresh()) return;
              // W2679 — carry the server-reported `liveness` (state + fresh)
              // through so boundSession can demote a stale/idle session straight
              // from the list, no separate client-side page-state probe.
              setAgentSessions(
                page.data.map((s) => ({
                  id: s.id,
                  created_at: s.created_at,
                  status: s.status,
                  ...(s.liveness !== undefined ? { liveness: s.liveness } : {}),
                })),
              );
              setAgentSessionsLoaded(true);
            })
            .catch(() => undefined);
        }
        setState((s) =>
          isCurrentRefresh()
            ? {
                ...s,
                profiles: profilesPage,
                refreshedAt: Date.now(),
                loading: false,
                loadError: null,
                // Preserve the existing error: unlike SessionsView, ProfilesView's
                // `error` also carries LAUNCH errors (e.g. "didn't get a video
                // channel — try again"), which must survive the background 15s poll
                // that races right after a failed launch. Clearing it here wiped a
                // legitimate launch error (caught by profiles-launch-stream tests).
                error: s.error,
              }
            : s,
        );
        // Organization sync Phase 2 — seed-down: profiles organized on
        // another device (server folder/tags set, no local entry) get a
        // local entry so the hub shows them immediately. Local-vs-server
        // conflicts: local wins; the next edit's write-through reconciles.
        setProfilesMeta((local) => {
          if (!isCurrentRefresh()) return local;
          const seeded = seedMetaFromServer(local, profilesPage);
          if (!seeded.changed) return local;
          void persistProfilesMeta(
            seeded.map,
            // Prune orphans ONLY in Personal — there the listed profiles are
            // the authoritative full set. In a team workspace `profilesPage`
            // is the OWNER's profiles; pruning against it would delete the
            // member's personal org metadata (data-loss). Orphan entries are
            // keyed by globally-unique uuids → harmless; they self-clean on
            // the next Personal refresh.
            activeWorkspace === null ? profilesPage.map((p) => p.id) : undefined,
          ).catch(() => undefined);
          return seeded.map;
        });
      } catch (err) {
        if (!isCurrentRefresh()) return;
        setState((s) => ({
          ...s,
          loading: false,
          loadError: friendlyError(
            err,
            settings.baseUrl,
            "Couldn't load profiles. Check your connection and try again.",
          ),
        }));
      }
    },
    [client, settings.baseUrl, activeWorkspace],
  );

  // L4b — load the account's trashed profiles for the recycle-bin view.
  // An older server without /trash (404/405) is a verified unsupported/empty
  // result. Every other failure is unavailable, never empty; generation fencing
  // prevents an older retry from overwriting a newer authoritative snapshot.
  const loadTrash = useCallback(async (): Promise<void> => {
    if (!client || typeof client.profiles.listTrash !== 'function') {
      setTrashed([]);
      setTrashDataAvailable(true);
      setTrashLoadError(null);
      return;
    }
    const generation = ++trashLoadGenerationRef.current;
    setTrashLoading(true);
    setTrashDataAvailable(false);
    setTrashLoadError(null);
    try {
      const page = await client.profiles.listTrash();
      if (generation !== trashLoadGenerationRef.current) return;
      setTrashed(page.data);
      setTrashDataAvailable(true);
    } catch (err) {
      if (generation !== trashLoadGenerationRef.current) return;
      const status = (err as { status?: number } | null)?.status;
      if (status === 404 || status === 405) {
        setTrashed([]);
        setTrashDataAvailable(true);
      } else {
        setTrashLoadError(
          friendlyError(
            err,
            settings.baseUrl,
            "Couldn't load the recycle bin. Check your connection and try again.",
          ),
        );
      }
    } finally {
      if (generation === trashLoadGenerationRef.current) setTrashLoading(false);
    }
  }, [client, settings.baseUrl]);

  // L4b — restore a trashed profile, then refresh both the trash list and the
  // live profile list. A 409 (a live profile took the name) surfaces as a
  // notice telling the customer to rename first.
  const handleRestore = useCallback(
    async (id: string): Promise<void> => {
      if (!client || trashMutationInFlightRef.current) return;
      trashMutationInFlightRef.current = true;
      setRestoringId(id);
      try {
        await client.profiles.restore(id);
        await Promise.all([loadTrash(), refresh(false)]);
      } catch (err) {
        const status = (err as { status?: number }).status;
        await confirm(
          status === 409
            ? 'A live profile already uses this name. Rename it, then restore again.'
            : friendlyError(err, settings.baseUrl),
          { confirmLabel: 'OK' },
        );
      } finally {
        setRestoringId(null);
        trashMutationInFlightRef.current = false;
      }
    },
    [client, loadTrash, refresh, confirm, settings.baseUrl],
  );

  // L4b anti-abuse — permanently delete a trashed profile (frees its cap slot
  // immediately; trashed profiles otherwise hold a slot until the 30-day
  // auto-purge). Irreversible, so we gate it behind a destructive confirm.
  const handlePurge = useCallback(
    async (id: string, name: string): Promise<void> => {
      if (
        !client ||
        typeof client.profiles.purge !== 'function' ||
        trashMutationInFlightRef.current
      )
        return;
      trashMutationInFlightRef.current = true;
      try {
        const ok = await confirm(
          `Permanently delete “${name}”? This frees a profile slot but can’t be undone — the profile is gone for good.`,
          { confirmLabel: 'Delete permanently' },
        );
        if (!ok) return;
        setPurgingId(id);
        await client.profiles.purge(id);
        await Promise.all([loadTrash(), refresh(false)]);
      } catch (err) {
        await confirm(friendlyError(err, settings.baseUrl), { confirmLabel: 'OK' });
      } finally {
        setPurgingId(null);
        trashMutationInFlightRef.current = false;
      }
    },
    [client, loadTrash, refresh, confirm, settings.baseUrl],
  );

  // 2026-06-20 — bulk "Restore all" over the per-id endpoint, run SEQUENTIALLY
  // and PARTIAL-FAILURE TOLERANT: a 409 (name taken) or any other error on one
  // profile is collected, not thrown, so the remaining restores still run. The
  // server has no bulk restore endpoint yet (FOLLOW-UP: add
  // client.profiles.restoreAll() + POST /v1/profiles/trash/restore-all so this
  // is one atomic round-trip instead of N). Refreshes once at the end and
  // surfaces a single summary if anything was skipped.
  const handleRestoreAll = useCallback(
    async (ids: ReadonlyArray<string>): Promise<void> => {
      if (!client || ids.length === 0 || trashMutationInFlightRef.current) return;
      trashMutationInFlightRef.current = true;
      setBulkTrashBusy(true);
      setBulkTrashAction('restore');
      let nameClashes = 0;
      let otherErrors = 0;
      try {
        for (const id of ids) {
          try {
            await client.profiles.restore(id);
          } catch (err) {
            if ((err as { status?: number }).status === 409) nameClashes += 1;
            else otherErrors += 1;
          }
        }
        await Promise.all([loadTrash(), refresh(false)]);
        if (nameClashes > 0 || otherErrors > 0) {
          const parts: string[] = [];
          if (nameClashes > 0)
            parts.push(
              `${nameClashes.toString()} couldn’t be restored because a live profile already uses the name — rename it, then restore again`,
            );
          if (otherErrors > 0) parts.push(`${otherErrors.toString()} failed to restore`);
          await confirm(`Restored what it could. ${parts.join('; ')}.`, { confirmLabel: 'OK' });
        }
      } finally {
        setBulkTrashAction(null);
        setBulkTrashBusy(false);
        trashMutationInFlightRef.current = false;
      }
    },
    [client, loadTrash, refresh, confirm],
  );

  // 2026-06-20 — bulk "Empty trash": confirm ONCE, then purge every trashed
  // profile SEQUENTIALLY over the per-id endpoint, tolerating per-row failures
  // (a failed purge doesn't abort the rest). FOLLOW-UP: a server
  // DELETE /v1/profiles/trash + client.profiles.emptyTrash() would make this
  // atomic instead of N irreversible calls.
  const handleEmptyTrash = useCallback(
    async (ids: ReadonlyArray<string>): Promise<void> => {
      if (
        !client ||
        typeof client.profiles.purge !== 'function' ||
        ids.length === 0 ||
        trashMutationInFlightRef.current
      )
        return;
      trashMutationInFlightRef.current = true;
      setBulkTrashBusy(true);
      setBulkTrashAction('empty');
      let failures = 0;
      try {
        const ok = await confirm(
          `Permanently delete all ${ids.length.toString()} profile${ids.length === 1 ? '' : 's'} in the trash? This frees their slots but can’t be undone — they’re gone for good.`,
          { confirmLabel: 'Empty trash' },
        );
        if (!ok) return;
        for (const id of ids) {
          try {
            await client.profiles.purge(id);
          } catch {
            failures += 1;
          }
        }
        await Promise.all([loadTrash(), refresh(false)]);
        if (failures > 0)
          await confirm(`Emptied the trash. ${failures.toString()} couldn’t be deleted.`, {
            confirmLabel: 'OK',
          });
      } finally {
        setBulkTrashAction(null);
        setBulkTrashBusy(false);
        trashMutationInFlightRef.current = false;
      }
    },
    [client, loadTrash, refresh, confirm],
  );

  // F3 — single note-save path shared by BOTH the grid card and the table row
  // (founder batch #2 "Add note", now editable in the default grid too). Writes
  // the client-persisted org meta AND mirrors the note through to the server
  // profile row so it follows the account (per-account sync, 2026-06-16). Empty
  // string clears the note (sent as null to the server).
  const handleSaveNote = useCallback(
    async (id: string, note: string): Promise<string | null> => {
      let savedLocally = false;
      try {
        const nextMeta = await saveProfileMeta(
          id,
          { note },
          // Only pass the prune list in Personal — in a team workspace state.profiles
          // is the OWNER's set, so pruning against it would WIPE the member's own
          // personal org metadata (same guard as every other save path).
          activeWorkspace === null ? state.profiles.map((pr) => pr.id) : undefined,
        );
        savedLocally = true;
        setProfilesMeta(nextMeta);
        if (client) await client.profiles.update(id, { note: note.length > 0 ? note : null });
        return null;
      } catch {
        return savedLocally
          ? 'Saved on this Mac, but couldn’t sync the note to your account. Check your connection and retry.'
          : 'Couldn’t save the note on this Mac. Check app storage and try again.';
      }
    },
    [client, state.profiles, activeWorkspace],
  );

  // Switching account/workspace must NOT carry the prior account's agent-session
  // cache forward — boundSession would otherwise match a stale agt_ id from the
  // other account and falsely report a profile running until the next list
  // fetch lands. Reset to the not-yet-loaded state so boundSession trusts only
  // the binding until the fresh list arrives.
  useEffect(() => {
    setAgentSessions([]);
    setAgentSessionsLoaded(false);
  }, [client, activeWorkspace]);

  useEffect(() => {
    void refresh(true);
    // Skip the 15s background poll while the window is hidden (audit 2026-07-08) — the
    // interval keeps ticking and resumes the fetch on the next visible tick.
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh(false);
    }, REFRESH_MS);
    return () => {
      window.clearInterval(id);
      // Invalidate core, detached agent-list and metadata publications from the
      // invocation owned by this effect/client, including on final unmount.
      refreshGenerationRef.current += 1;
    };
  }, [refresh]);

  // Auto-dismiss transient success notices (audit #41) — the notice banner is a
  // confirmation of a completed action (folder moved, exported, cache cleared),
  // so it clears itself after ~5s instead of lingering until manually dismissed.
  // Errors stay sticky (they need action + live in the separate ErrorBanner).
  // In-flight progress lives in `progressNotice` (NOT `notice`) so this timer
  // never nulls it mid-wait — a slow launch would otherwise lose its progress
  // indicator at 5s while the ~10s probe is still running (audit #15).
  useEffect(() => {
    if (state.notice === null) return;
    const id = window.setTimeout(() => {
      setState((s) => ({ ...s, notice: null }));
    }, 5000);
    return () => window.clearTimeout(id);
  }, [state.notice]);

  async function handleDelete(id: string): Promise<void> {
    // Don't delete a profile while ANY action is in flight (esp. a launch of this
    // profile): the grid card's Delete row only checked p.running, so a delete
    // could race an in-flight launch before node_id/running was set (adversarial
    // review w410wv3eq #4). Mirror handleClone's single-flight guard.
    if (!client || busyId !== null) return;
    // Founder 2026-06-16 — confirm before a single-profile delete (the bulk bar
    // already confirms; the per-row/card delete did not). Profile delete is a
    // permanent server hard-delete (the identity's cookies/storage/fingerprint
    // + its encryption key are destroyed), so it must not fire on a stray click.
    const name = state.profiles.find((p) => p.id === id)?.name ?? 'this profile';
    const ok = await confirm(
      `Delete "${name}"? This permanently removes the profile's identity — its cookies, storage, and fingerprint — from your account and can't be undone.`,
      { confirmLabel: 'Delete' },
    );
    if (!ok) return;
    setBusyId(id);
    try {
      await client.profiles.delete(id);
      // Drop the local binding so stale {currentSessionId, defaultProxyId}
      // entries don't accumulate as customers churn through profiles.
      await deleteBinding(id);
      await refresh(false);
      await refreshAccountMe();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  // doc-150 §8 — "Clear cache, keep logins". POST /v1/profiles/:id/trim reclaims
  // the profile's re-fetchable caches (images/scripts/service-workers) while
  // KEEPING logins, localStorage, IndexedDB + open tabs — the headline reclaim
  // action when over the storage cap. The server always returns 200 with a
  // DISCRIMINATED body, so we branch on `status` (NOT the HTTP code). On `ok` we
  // surface the freed bytes + refresh so the per-profile size + account meter
  // pick up the smaller size_bytes immediately. Single-flight on busyId mirrors
  // handleDelete/handleClone so a trim can't race an in-flight launch.
  async function handleTrim(id: string): Promise<void> {
    if (!client || busyId !== null) return;
    const name = state.profiles.find((p) => p.id === id)?.name ?? 'this profile';
    const ok = await confirm(
      `Clear cached website data for "${name}"? This frees re-fetchable caches (images, scripts, service workers) to reclaim storage. Your logins, saved site data and open tabs are KEPT — they reload from the network on the next visit, just like clearing a browser cache.`,
      { confirmLabel: 'Clear cache' },
    );
    if (!ok) return;
    setBusyId(id);
    try {
      const result = await client.profiles.trim(id);
      if (result.status === 'ok') {
        setState((s) => ({
          ...s,
          notice: `Cleared cache for "${name}" — freed ${fmtBytes(result.bytes_reclaimed)}.`,
        }));
        await refresh(false);
      } else if (result.status === 'error') {
        setState((s) => ({
          ...s,
          error: `Couldn't clear cache for "${name}": ${result.reason}.`,
        }));
      } else if (result.status === 'timeout') {
        setState((s) => ({
          ...s,
          error: `Clearing cache for "${name}" timed out — the session node didn't respond. Try again shortly.`,
        }));
      } else {
        // unavailable — informative, not an error: a fresh profile with no saved
        // state has nothing to clear.
        setState((s) => ({
          ...s,
          notice: `Nothing to clear for "${name}": ${result.reason}.`,
        }));
      }
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  /** Returns the currently-active session for a profile, or null when
   *  the profile is idle. Looks up the binding's currentSessionId in
   *  the live activeSessions list — a stale binding (session destroyed
   *  externally) reads as idle. */
  // W624 — the session a profile is bound to, by KIND. A launch with live
  // video binds the profile to an AGENT session (agt_<uuid>); a LiveKit-less
  // launch binds a DRIVER session (ses_<uuid>). The old runningSessionFor
  // only looked agt_ ids up in the driver-session list (sessions.list()),
  // never found them, so an agent-backed profile showed idle AND its Stop
  // button no-op'd — the founder-hit "destroy doesn't stop it, keeps
  // running". Driver sessions keep the staleness cross-check against the
  // live list; agent sessions are treated as running from the binding (no
  // cheap list endpoint — and agentSessions.close is idempotent, so a Stop
  // on an already-reaped agent session is a harmless cleanup).
  // Perf (audit #4) — boundSession/boundSessionStartedAt were each doing a
  // bindings.find + activeSessions/agentSessions scan on EVERY call, and both
  // are invoked per-profile across the filter, comparator, grid, table, and
  // liveCount paths → O(profiles × sessions) per render pass. Pre-index the
  // bound session (and its start time) by profileId ONCE per relevant-input
  // change so every call site is an O(1) Map read. Only profiles with a binding
  // land in the map; a miss reads as idle (null), byte-identical to the old
  // bindings.find(...) === undefined path. The per-profile decision logic is
  // preserved verbatim below.
  const boundSessionByProfileId = useMemo<
    Map<string, { id: string; kind: 'agent' | 'driver' }>
  >(() => {
    // Index the session lists once so the per-binding resolution is O(1), not a
    // fresh scan per profile.
    const agentById = new Map<string, (typeof agentSessions)[number]>();
    for (const s of agentSessions) agentById.set(s.id, s);
    const liveDriverIds = new Set<string>();
    for (const s of activeSessions) {
      if (s.status !== 'destroyed' && s.status !== 'errored') liveDriverIds.add(s.id);
    }
    const out = new Map<string, { id: string; kind: 'agent' | 'driver' }>();
    for (const binding of bindings) {
      const sid = binding.currentSessionId ?? null;
      if (sid === null) continue;
      if (sid.startsWith('agt_')) {
        // Self-heal stale agent bindings to idle (founder 2026-06-18: "always
        // says open session even on long-expired/failed sessions"). Once the
        // live agent-session list has loaded, a bound session reads as running
        // ONLY if it's still present AND not closed (expired/failed → closed or
        // gone). Before the first successful list fetch, trust the binding so a
        // transient fetch miss doesn't flip a genuinely-live session to idle.
        if (!agentSessionsLoaded) {
          out.set(binding.profileId, { id: sid, kind: 'agent' });
          continue;
        }
        const live = agentById.get(sid);
        if (live === undefined || live.status === 'closed') continue;
        // LIVENESS (W2679, founder 2026-06-18) — an `active`-but-DEAD session
        // (worker crashed / never came up) stays `active` for up to the 12h
        // reaper cap, so the list/status check above isn't enough. The server
        // now re-bases the worker's liveness onto the fleet heartbeat and
        // reports it inline on each list entry, replacing the old client-side
        // page-state probe:
        //   • liveness PRESENT && fresh === true → a recent beat trusts the
        //     worker state (any state) → RUNNING.
        //   • liveness PRESENT && fresh === false → the owning node's beat is
        //     stale (worker silent) → treat as IDLE (skip) so the row shows
        //     Launch.
        //   • liveness ABSENT (no fleet control plane / no beat yet) → UNKNOWN →
        //     trust the binding (RUNNING), mirroring the agentSessionsLoaded
        //     pattern, so a transient miss never flips a genuinely-running
        //     profile to idle. NEVER treat absent as dead.
        if (live.liveness !== undefined && !live.liveness.fresh) continue;
        out.set(binding.profileId, { id: sid, kind: 'agent' });
        continue;
      }
      // A driver session reads as running only if it's live AND not in a
      // terminal state — an errored/destroyed session lingering in the list must
      // read idle (otherwise the row offers "Open session" on a dead session).
      if (liveDriverIds.has(sid)) out.set(binding.profileId, { id: sid, kind: 'driver' });
    }
    return out;
  }, [bindings, activeSessions, agentSessions, agentSessionsLoaded]);

  // Worktimer — pre-index the ISO start time of each profile's bound running
  // session so boundSessionStartedAt is an O(1) Map read too. Driver sessions
  // carry created_at in activeSessions; agent sessions come from the separately-
  // fetched agentSessions list (absent until/unless that fetch succeeds → the
  // timer just doesn't show, never errors).
  const boundStartedAtByProfileId = useMemo<Map<string, string>>(() => {
    const driverStart = new Map<string, string>();
    for (const s of activeSessions) driverStart.set(s.id, s.created_at);
    const agentStart = new Map<string, string>();
    for (const s of agentSessions) agentStart.set(s.id, s.created_at);
    const out = new Map<string, string>();
    for (const [profileId, bound] of boundSessionByProfileId) {
      const started =
        bound.kind === 'driver' ? driverStart.get(bound.id) : agentStart.get(bound.id);
      if (started !== undefined) out.set(profileId, started);
    }
    return out;
  }, [boundSessionByProfileId, activeSessions, agentSessions]);

  /** Returns the currently-active session for a profile, or null when the
   *  profile is idle — an O(1) read of the memoized index above. */
  function boundSession(profileId: string): { id: string; kind: 'agent' | 'driver' } | null {
    return boundSessionByProfileId.get(profileId) ?? null;
  }

  function boundSessionStartedAt(profileId: string): string | null {
    return boundStartedAtByProfileId.get(profileId) ?? null;
  }

  // W624 — re-open the live stream for an already-running agent session
  // (the profile-row "Live view" when the binding is an agent session).
  async function reopenStream(agentSessionId: string, profileId: string): Promise<void> {
    if (!client) return;
    setBusyId(profileId);
    try {
      const info = await client.agentSessions.livekitToken(agentSessionId);
      // Mint the per-session gui_control_key so the SEPARATE simulator app (which can't
      // read this app's keychain) can drive the control endpoints — identical to the launch
      // path. Without it, reopen-via-"Live view" left Take over / Hand back / End session
      // dead (401 auth_missing) in the separate app (audit #1, 2026-06-22).
      const reopenApiKey = settings.apiKey;
      const reopenControlCredential =
        reopenApiKey !== null && reopenApiKey.length > 0
          ? ((await mintGuiControlKey(settings.baseUrl, reopenApiKey, agentSessionId)) ?? undefined)
          : undefined;
      // Open the floating-iPhone simulator window (the only experience now).
      const reopened = state.profiles.find((p) => p.id === profileId);
      const reopenProxy = pickProxy(profileId);
      const reopenCountry =
        reopenProxy !== null ? (probeCache[reopenProxy.id]?.exitCountry ?? null) : null;
      const sim = await openSimulatorWindow({
        sessionId: agentSessionId,
        info,
        deviceName: formatDeviceName(reopened?.archetype ?? ''),
        profileName: reopened?.name,
        countryCode: reopenCountry,
        // Hand off the API host so the separate app's control calls hit the real
        // server (its store may be empty → defaults to localhost) — founder 2026-06-23.
        baseUrl: settings.baseUrl,
        ...(reopenControlCredential !== undefined
          ? { controlCredential: reopenControlCredential }
          : {}),
        ...(reopenProxy !== null
          ? { proxyLabel: `${reopenProxy.label} · ${reopenProxy.host}:${String(reopenProxy.port)}` }
          : {}),
      });
      if (!sim.opened) {
        // No in-app full-page fallback (founder 2026-06-18: it looked bad,
        // scaled). The simulator is ONLY the separate window now.
        setState((s) => ({
          ...s,
          error: `${friendlySimulatorOpenReason(sim.reason)} If one is already open for this session, close it and relaunch.`,
        }));
      }
    } catch (err) {
      // W638 — a profile bound to a CLOSED agent session 403s here ("Cannot
      // mint LiveKit token for closed agent session"); 404 if it's gone.
      // boundSession (W624) can't cheaply tell live from closed (no list
      // endpoint), so it optimistically showed the profile "running". On
      // that signal the binding is stale — clear it so the profile
      // self-heals to idle instead of repeatedly offering a Live-view that
      // 403s.
      if (err instanceof DriftstackError && (err.status === 403 || err.status === 404)) {
        await clearProfileSession(profileId).catch(() => undefined);
        await refresh(false);
      }
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  // Workspace-scoped org metadata for folder ENUMERATION (sidebar / pickers).
  // profiles-meta.json is a single global store keyed by globally-unique
  // profile uuid; seed-down adds the active workspace's owner folders to it,
  // so enumerating the whole map would bleed one workspace's folders into
  // another's view. Scope folder lists to the currently-listed profiles
  // (state.profiles = the active workspace's set). Per-profile chip/filter
  // reads stay keyed by id directly (unambiguous).
  const scopedMeta = useMemo<ProfilesMetaMap>(() => {
    const out: ProfilesMetaMap = {};
    for (const p of state.profiles) {
      const m = profilesMeta[p.id];
      if (m) out[p.id] = m;
    }
    return out;
  }, [state.profiles, profilesMeta]);

  // Effective folder list = folders derived from profile metadata UNION the
  // user-created (possibly empty) folders. Used by the rail + both folder
  // pickers so a freshly-created empty folder is immediately pickable.
  const allFolders = useMemo<string[]>(() => {
    const set = new Set<string>([...folderList(scopedMeta), ...customFolders]);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [scopedMeta, customFolders]);

  // Effective tag list (rail) = tags derived from profiles (with counts) UNION
  // the user-created tags (count 0 until a profile uses them), sorted by name.
  const allTags = useMemo<Array<{ tag: string; count: number }>>(() => {
    const counts = new Map<string, number>();
    for (const { tag, count } of aggregateTags(scopedMeta)) counts.set(tag, count);
    for (const t of customTags) if (!counts.has(t)) counts.set(t, 0);
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [scopedMeta, customTags]);

  // Create a tag from the rail's inline input (mirrors handleCreateFolder).
  const handleCreateTag = useCallback(async (): Promise<boolean> => {
    const created = newTagName.trim().replace(/^#+/, '').trim();
    const saved = await runRailTaxonomyMutation(
      'new tag',
      async (scope) => {
        const next = await addTag(newTagName, scope);
        return {
          value: next,
          organization: buildRailOrganization(customFolders, customFolderIcons, next),
        };
      },
      (next) => {
        setCustomTags(next);
        if (created.length > 0) setTagFilter(created);
      },
    );
    if (saved) {
      setNewTagName('');
      setCreatingTag(false);
    }
    return saved;
  }, [
    buildRailOrganization,
    customFolderIcons,
    customFolders,
    newTagName,
    runRailTaxonomyMutation,
  ]);

  // Create a folder from the rail's inline input: persist the name, refresh the
  // list, jump the filter to the new folder, and close the input.
  const handleCreateFolder = useCallback(async (): Promise<boolean> => {
    const created = newFolderName.trim();
    const nextIcons =
      created.length > 0 && newFolderIcon.length > 0
        ? { ...customFolderIcons, [created]: newFolderIcon }
        : customFolderIcons;
    const saved = await runRailTaxonomyMutation(
      'new folder',
      async (scope) => {
        const next = await addFolder(newFolderName, scope, newFolderIcon);
        return {
          value: next,
          organization: buildRailOrganization(next, nextIcons, customTags),
        };
      },
      (next) => {
        setCustomFolders(next);
        if (created.length > 0 && newFolderIcon.length > 0) {
          setCustomFolderIcons(nextIcons);
        }
        if (created.length > 0 && next.includes(created)) setFolderFilter(created);
      },
    );
    if (saved) {
      setNewFolderName('');
      setNewFolderIcon('');
      setCreatingFolder(false);
    }
    return saved;
  }, [
    buildRailOrganization,
    customFolderIcons,
    customTags,
    newFolderIcon,
    newFolderName,
    runRailTaxonomyMutation,
  ]);

  // 2026-06-19 (founder GUI-improvement audit) — folder/tag MANAGEMENT from the
  // rail: delete, re-icon (folders only), rename. The stores' remove*/rename*/
  // setFolderIcon existed but were never wired, and — the known gap — removals/
  // re-icons never pushed to the account org (only CREATE did). Every mutation
  // now shares one synchronous owner and awaits both local + account outcomes.

  // Delete a folder from the rail. Removes the custom name (+ its icon) from the
  // local store, syncs the shrunk org, and resets the filter if it was active.
  // Profiles still carrying the name keep deriving it (per removeFolder's
  // contract) — this clears the EMPTY-folder taxonomy entry, not the profiles.
  const handleDeleteFolder = useCallback(
    async (name: string): Promise<boolean> => {
      const nextIcons = { ...customFolderIcons };
      delete nextIcons[name];
      return runRailTaxonomyMutation(
        'folder deletion',
        async (scope) => {
          const next = await removeFolder(name, scope);
          return {
            value: next,
            organization: buildRailOrganization(next, nextIcons, customTags),
          };
        },
        (next) => {
          setCustomFolders(next);
          setCustomFolderIcons(nextIcons);
          if (folderFilter === name) setFolderFilter('all');
        },
      );
    },
    [buildRailOrganization, customFolderIcons, customTags, folderFilter, runRailTaxonomyMutation],
  );

  // Re-icon a folder from the rail (the existing PROFILE_ICONS picker; '' clears
  // back to the deterministic glyph). Persists via setFolderIcon, then pushes.
  const handleReiconFolder = useCallback(
    async (name: string, icon: string): Promise<boolean> =>
      runRailTaxonomyMutation(
        'folder icon',
        async (scope) => {
          const nextIcons = await setFolderIcon(name, icon, scope);
          // Re-iconing a profile-derived folder seeds it into the custom names so the
          // icon has a stable home in the synced taxonomy.
          const names = customFolders.includes(name) ? customFolders : await addFolder(name, scope);
          return {
            value: { names, icons: nextIcons },
            organization: buildRailOrganization(names, nextIcons, customTags),
          };
        },
        ({ names, icons }) => {
          setCustomFolders(names);
          setCustomFolderIcons(icons);
        },
      ),
    [buildRailOrganization, customFolders, customTags, runRailTaxonomyMutation],
  );

  // Rename a folder: re-key the custom name + icon (renameFolder), BULK re-assign
  // every profile carrying the old folder to the new one (local meta + a PATCH
  // each), then push the edited taxonomy. Keeps the filter pinned to the folder
  // (now under its new name) if it was active.
  const handleRenameFolder = useCallback(
    async (oldName: string, rawNew: string): Promise<boolean> => {
      const newName = rawNew.trim().slice(0, MAX_FOLDER_NAME_CHARS);
      if (newName.length === 0 || newName === oldName) return true;
      const nextIcons = { ...customFolderIcons };
      if (nextIcons[oldName] !== undefined) {
        if (nextIcons[newName] === undefined) nextIcons[newName] = nextIcons[oldName];
        delete nextIcons[oldName];
      }
      const affected = state.profiles
        .filter((p) => profilesMeta[p.id]?.folder === oldName)
        .map((p) => p.id);
      return runRailTaxonomyMutation(
        'folder rename',
        async (scope) => {
          const nextNames = await renameFolder(oldName, newName, scope);
          const nextMeta =
            affected.length === 0
              ? profilesMeta
              : await saveProfilesMetaBulk(
                  affected,
                  { folder: newName },
                  'replace',
                  activeWorkspace === null ? state.profiles.map((p) => p.id) : undefined,
                );
          return {
            value: { nextNames, nextMeta },
            organization: buildRailOrganization(nextNames, nextIcons, customTags),
            profileUpdates: affected.map((id) => ({ id, body: { folder: newName } })),
          };
        },
        ({ nextNames, nextMeta }) => {
          setCustomFolders(nextNames);
          setCustomFolderIcons(nextIcons);
          if (affected.length > 0) setProfilesMeta(nextMeta);
          if (folderFilter === oldName) setFolderFilter(newName);
        },
      );
    },
    [
      activeWorkspace,
      buildRailOrganization,
      customFolderIcons,
      customTags,
      folderFilter,
      profilesMeta,
      runRailTaxonomyMutation,
      state.profiles,
    ],
  );

  // Delete a tag from the rail. Drops the custom name, syncs, clears the filter.
  const handleDeleteTag = useCallback(
    async (name: string): Promise<boolean> =>
      runRailTaxonomyMutation(
        'tag deletion',
        async (scope) => {
          const next = await removeTag(name, scope);
          return {
            value: next,
            organization: buildRailOrganization(customFolders, customFolderIcons, next),
          };
        },
        (next) => {
          setCustomTags(next);
          if (tagFilter === name) setTagFilter(null);
        },
      ),
    [buildRailOrganization, customFolderIcons, customFolders, runRailTaxonomyMutation, tagFilter],
  );

  // Rename a tag: re-key the custom name (renameTag), BULK swap the tag on every
  // profile carrying it (subtract old + union new, local meta + a PATCH each),
  // then push. Keeps the filter on the tag (now renamed) if it was active.
  const handleRenameTag = useCallback(
    async (oldName: string, rawNew: string): Promise<boolean> => {
      const newName = rawNew.trim().replace(/^#+/, '').trim().slice(0, MAX_TAG_NAME_CHARS);
      if (newName.length === 0 || newName === oldName) return true;
      const affected = state.profiles
        .filter((p) => (profilesMeta[p.id]?.tags ?? []).includes(oldName))
        .map((p) => p.id);
      return runRailTaxonomyMutation(
        'tag rename',
        async (scope) => {
          const nextNames = await renameTag(oldName, newName, scope);
          let nextMeta = profilesMeta;
          if (affected.length > 0) {
            const live = activeWorkspace === null ? state.profiles.map((p) => p.id) : undefined;
            // Subtract the old tag, then union the new one — two passes so a profile
            // that already carried both doesn't end up with a duplicate.
            await saveProfilesMetaBulk(affected, { tags: [oldName] }, 'remove', live);
            nextMeta = await saveProfilesMetaBulk(affected, { tags: [newName] }, 'merge', live);
          }
          return {
            value: { nextNames, nextMeta },
            organization: buildRailOrganization(customFolders, customFolderIcons, nextNames),
            profileUpdates: affected.flatMap((id) => {
              const saved = nextMeta[id];
              return saved === undefined ? [] : [{ id, body: { tags: saved.tags } }];
            }),
          };
        },
        ({ nextNames, nextMeta }) => {
          setCustomTags(nextNames);
          if (affected.length > 0) setProfilesMeta(nextMeta);
          if (tagFilter === oldName) setTagFilter(newName);
        },
      );
    },
    [
      activeWorkspace,
      buildRailOrganization,
      customFolders,
      customFolderIcons,
      profilesMeta,
      runRailTaxonomyMutation,
      state.profiles,
      tagFilter,
    ],
  );

  // 2026-05-21 — derive the filtered/sorted view over state.profiles.
  // Search matches name + description + archetype AND the org metadata the
  // product syncs (folder name, tags, note) so a customer can find a profile
  // by how THEY organised it, not just its server fields; status filter treats
  // a profile as running when it's bound to a live driver session OR an agent
  // session (W624); sort is recency-by-default ("what did I touch last?"
  // beats alpha for the operator workflow).
  const filteredProfiles = useMemo(() => {
    let list = state.profiles;
    const q = deferredSearchQuery.trim().toLowerCase();
    if (q.length > 0) {
      list = list.filter((p) => {
        const meta = profilesMeta[p.id];
        return (
          p.name.toLowerCase().includes(q) ||
          (p.description?.toLowerCase().includes(q) ?? false) ||
          p.archetype.toLowerCase().includes(q) ||
          (meta?.folder.toLowerCase().includes(q) ?? false) ||
          (meta?.tags.some((t) => t.toLowerCase().includes(q)) ?? false) ||
          (meta?.note.toLowerCase().includes(q) ?? false)
        );
      });
    }
    // Search is GLOBAL (the Finder/Gmail convention): while the query is non-empty it
    // searches ALL profiles, bypassing the folder/tag rail scoping. Intersecting them
    // was the founder's "search doesn't find anything" (2026-07-11): browse into a
    // folder, later type a search for a profile that lives elsewhere → 0 results with
    // no hint why. The rail selection is browse-mode state, easy to leave behind; a
    // typed query is an explicit "find it wherever it is". The STATUS filter still
    // applies while searching — it's a visible segmented control in the SAME bar as
    // the search box, not a forgotten sidebar selection.
    if (q.length === 0 && folderFilter !== 'all') {
      list = list.filter((p) =>
        folderFilter === 'unfiled'
          ? (profilesMeta[p.id]?.folder ?? '') === ''
          : profilesMeta[p.id]?.folder === folderFilter,
      );
    }
    if (q.length === 0 && tagFilter !== null) {
      list = list.filter((p) => (profilesMeta[p.id]?.tags ?? []).includes(tagFilter));
    }
    if (statusFilter !== 'all') {
      list = list.filter((p) => {
        // Single source of truth for "running" — boundSession self-heals stale
        // agent bindings + ignores terminal driver sessions, so filter, badge,
        // and live count agree.
        const running = boundSession(p.id) !== null;
        return statusFilter === 'running' ? running : !running;
      });
    }
    // 2026-06-20 — single, direction-aware comparator over the unified sortBy.
    // The base comparator orders ASCENDING for every key; `dir` flips it. The
    // status/country keys read the same derived signals the list-view row uses
    // (boundSession running, probed exit country) so a grid sort by Status or
    // Country matches what the table would have shown.
    const exitCountryOf = (p: Profile): string => {
      const px = pickProxy(p.id);
      const probe = px !== null ? probeCache[px.id] : undefined;
      // 'zz' sinks the unknowns to the end of an ascending sort.
      return probe?.exitCountry ?? 'zz';
    };
    const cmp = (a: Profile, b: Profile): number => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'created':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'last-used': {
          const at = a.last_used_at !== null ? new Date(a.last_used_at).getTime() : 0;
          const bt = b.last_used_at !== null ? new Date(b.last_used_at).getTime() : 0;
          return at - bt;
        }
        case 'status':
          return Number(boundSession(a.id) !== null) - Number(boundSession(b.id) !== null);
        case 'country':
          return exitCountryOf(a).localeCompare(exitCountryOf(b));
      }
    };
    const sign = sortDir === 'asc' ? 1 : -1;
    const ordered = [...list].sort((a, b) => sign * cmp(a, b));
    return ordered;
  }, [
    folderFilter,
    tagFilter,
    profilesMeta,
    state.profiles,
    deferredSearchQuery,
    statusFilter,
    sortBy,
    sortDir,
    // status/country comparators read the proxy probe cache + the proxy set.
    probeCache,
    proxies,
    activeSessions,
    bindings,
    // boundSession (via the status filter + status sort) also reads the
    // agent-session list (now carrying the server `liveness`) + its loaded flag,
    // so recompute when those change.
    agentSessions,
    agentSessionsLoaded,
  ]);

  // Keep the selection within the VISIBLE set. Bulk actions (incl. destructive
  // Delete + billed Launch) operate on selectedIds, so a selection made before a
  // filter/search/workspace change must not silently act on now-hidden profiles.
  // Prune ids that left filteredProfiles → the bulk-bar count and every bulk
  // action cover exactly what's on screen (audit wn1ghalx1).
  useEffect(() => {
    const visible = new Set(filteredProfiles.map((p) => p.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filteredProfiles]);

  // Are any of the composing filters narrowing the grid? Drives the "clear
  // filters" affordance on the empty state (folder + tag + search + status all
  // AND together, so it's easy to filter to zero and not see why).
  const hasActiveFilters =
    folderFilter !== 'all' ||
    tagFilter !== null ||
    searchQuery.trim() !== '' ||
    statusFilter !== 'all';
  const clearFilters = useCallback(() => {
    setFolderFilter('all');
    setTagFilter(null);
    setSearchQuery('');
    setStatusFilter('all');
  }, []);

  // S5 (GUI-rework 2026-06-14) — hero/stat derived metrics. Live count =
  // profiles bound to a live session. Proxy health = share of saved proxies
  // whose LAST probe was reachable (honest: from the real probeCache; null
  // when nothing's been probed yet so we don't invent a number).
  const liveCount = useMemo(
    () => state.profiles.filter((p) => boundSession(p.id) !== null).length,
    // boundSession reads bindings + activeSessions + the agent-session list (now
    // carrying the server `liveness`) + its loaded flag; recompute on any move.
    [state.profiles, bindings, activeSessions, agentSessions, agentSessionsLoaded],
  );
  const proxyHealthPct = useMemo<number | null>(() => {
    if (proxies.length === 0) return null;
    const probed = proxies.filter((p) => probeCache[p.id] !== undefined);
    if (probed.length === 0) return null;
    const ok = probed.filter((p) => probeCache[p.id]?.result.reachable === true).length;
    return (ok / probed.length) * 100;
  }, [proxies, probeCache]);
  // doc-150 items 5/6 — account-wide storage: sum every profile's size_bytes
  // (never-saved / pre-column profiles contribute 0), and resolve the per-tier
  // hard cap from the live tier (TIER_STORAGE_BYTES_CAP). The quota leg
  // (cap/pct/bar/warn) only renders once the tier is known — we don't guess a
  // cap. Enterprise is soft-only (the server never hard-blocks it), so its
  // over-cap state reads as a warning, not a stop. Mirrors the dashboard's
  // renderStorageTotal + the server's computeAccountStorageState.
  const storage = useMemo(() => {
    const total = state.profiles.reduce(
      (sum, p) => sum + (typeof p.size_bytes === 'number' && p.size_bytes > 0 ? p.size_bytes : 0),
      0,
    );
    const tier = accountMe?.tier ?? null;
    const cap = tier !== null ? (TIER_STORAGE_BYTES_CAP[tier] ?? null) : null;
    const fraction = cap !== null && cap > 0 ? total / cap : null;
    return {
      total,
      cap,
      fraction,
      pct: fraction !== null ? Math.round(fraction * 100) : null,
      isEnterprise: tier === 'enterprise',
      overCap: fraction !== null && fraction >= 1,
      nearCap: fraction !== null && fraction >= STORAGE_SOFT_WARN_FRACTION && fraction < 1,
    };
  }, [state.profiles, accountMe?.tier]);
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  /** Pick the proxy to use on Launch — explicit binding default first,
   *  else the first saved proxy, else null (handled in handleLaunch as
   *  an inline error). */
  // S3 — test a profile's bound proxy right from the hub card (founder: "not a
  // proxy check"). Runs the native SOCKS5 capability probe + the exit-geo probe
  // and persists both to the shared probe cache, so the card immediately shows
  // exit IP / country / latency / last-checked / UDP. Mirrors the canonical
  // ProxiesView.handleTest flow. Best-effort: a probe failure keeps prior state.
  async function handleTestProxy(px: LocalProxyConfig): Promise<void> {
    setTestingProxyId(px.id);
    try {
      const result = await testProxy({
        host: px.host,
        port: px.port,
        username: px.username,
        password: px.password,
      });
      setProbeCache(await saveProbeResult(px.id, result, Date.now()));
      // Exit-IP probing REQUIRES routing — it makes a real request through the
      // proxy. Gating it on auth alone meant a non-routing proxy kept whatever exit
      // geo it had cached, which is the stale-green badge in another costume.
      if (isProxyUsable(result)) {
        const exit = await probeProxyExit({
          host: px.host,
          port: px.port,
          username: px.username,
          password: px.password,
        });
        if (exit !== null) {
          setProbeCache(
            await saveExitResult(px.id, exit.ip, exit.country, {
              city: exit.city ?? null,
              region: exit.region ?? null,
              timezone: exit.timezone ?? null,
              asnOrg: exit.asn_org ?? null,
            }),
          );
        }
      }
    } catch {
      /* best-effort — the card keeps its prior probe state on failure */
    } finally {
      setTestingProxyId(null);
    }
  }

  function pickProxy(profileId: string): LocalProxyConfig | null {
    const binding = bindings.find((b) => b.profileId === profileId);
    if (binding?.defaultProxyId !== undefined && binding?.defaultProxyId !== null) {
      const explicit = proxies.find((p) => p.id === binding.defaultProxyId);
      // EXPLICIT binding to a now-missing proxy (the bound proxy was deleted):
      // do NOT silently fall back to proxies[0] — that would route this profile's
      // egress through a DIFFERENT IP/country than configured with no warning, a
      // real privacy hazard for an anti-detect tool. Return null so the launch
      // path surfaces "the configured proxy was deleted" instead.
      return explicit ?? null;
    }
    // No explicit default binding → use the first saved proxy (account default).
    return proxies[0] ?? null;
  }
  /**
   * True when this profile is bound to a proxy DELIBERATELY rather than inheriting
   * the first saved one.
   *
   * Reported: adding a single proxy made every profile look linked to it. Nothing
   * writes a bulk binding — `profiles` has no proxy column, the server routes never
   * touch one, and `setDefaultProxy` is only called from the two single-profile
   * modals. It is this fallback: with one saved proxy, every profile that never
   * picked one resolves to it, and the card's egress widget then shows its country
   * and exit IP as though it had been chosen.
   *
   * The default itself is reasonable and is left alone — `pickProxy` still decides
   * launches. Only the DISPLAY needs to tell a choice from an inheritance, so that
   * adding a second proxy cannot silently move every unbound profile without the
   * customer having seen that coming.
   */
  function proxyIsExplicit(profileId: string): boolean {
    const binding = bindings.find((b) => b.profileId === profileId);
    return binding?.defaultProxyId !== undefined && binding.defaultProxyId !== null;
  }

  /** True when the profile has an EXPLICIT default-proxy binding that points at
   *  a proxy that no longer exists (it was deleted). Lets the launch path tell
   *  the "deleted proxy" case apart from the "no proxies saved at all" case. */
  function bindingProxyMissing(profileId: string): boolean {
    const binding = bindings.find((b) => b.profileId === profileId);
    if (binding?.defaultProxyId === undefined || binding.defaultProxyId === null) return false;
    return !proxies.some((p) => p.id === binding.defaultProxyId);
  }

  // ARC A — ensure the picked local proxy has a server-side account_proxies row
  // (encrypted under the account TMK, owner-scoped) and return its id to pass as
  // proxy_id at launch. Creates on first use (caching the id on the local proxy),
  // refreshes on later launches so an edited host/credential stays current
  // server-side. Returns undefined when there's no API key (caller launches
  // without proxy_id → operator-default egress).
  async function ensureServerProxy(p: LocalProxyConfig): Promise<string | undefined> {
    const apiKey = settings.apiKey;
    if (apiKey === null || apiKey.length === 0) return undefined;
    const input = {
      label: p.label,
      scheme: p.scheme ?? ('socks5' as const),
      host: p.host,
      port: p.port,
      username: p.username,
      password: p.password,
      // OVPN/WG — forward the VPN config block when present so the server wraps
      // the secret (config_blob / private_key) under the account TMK.
      ...(p.openvpn !== undefined ? { openvpn: p.openvpn } : {}),
      ...(p.wireguard !== undefined ? { wireguard: p.wireguard } : {}),
    };
    if (p.serverId !== undefined) {
      try {
        await updateAccountProxy(settings.baseUrl, apiKey, p.serverId, input);
        return p.serverId;
      } catch (err) {
        // Stale cached serverId: the account_proxies row was deleted server-side
        // (e.g. during a DB recovery), so the PUT 404s. Self-heal by clearing the
        // stale id and re-creating below, instead of failing the launch-sync
        // forever. Any other error is real — re-throw it.
        if ((err as { status?: number }).status !== 404) throw err;
      }
    }
    const created = await createAccountProxy(settings.baseUrl, apiKey, input);
    await setProxyServerId(p.id, created.id);
    setProxies(await listProxies());
    return created.id;
  }

  async function handleLaunch(
    profile: Profile,
    opts: { skipProxyDownConfirm?: boolean } = {},
  ): Promise<void> {
    // Single-flight on the shared busyId (mirrors handleClone): without this, two
    // different rows could launch concurrently (a second row's Launch stays enabled
    // while the first is in flight) → an extra billed session + the busyId/
    // "Launching…" indicator clobbered (adversarial review w410wv3eq #1/#5). The
    // bulk loop is unaffected — it awaits each handleLaunch sequentially, so busyId
    // is null at the start of each iteration.
    if (!client || busyId !== null) return;
    // Consistency #9 — pre-gate the concurrent-session cap so a launch at the
    // cap shows a clear "at your limit" message instead of firing a create that
    // runs the server's ~12s pre-launch proxy probe before returning an opaque
    // 402. Covers the single-row Launch + each bulk iteration (handleBulkLaunch
    // awaits handleLaunch per profile). Team block is checked at the call sites.
    if (atConcurrentCap) {
      setState((s) => ({ ...s, error: concurrentCapReason }));
      return;
    }
    setBusyId(profile.id);
    setLaunchingId(profile.id);
    try {
      const proxy = pickProxy(profile.id);
      if (proxy === null) {
        setState((s) => ({
          ...s,
          error: bindingProxyMissing(profile.id)
            ? // The profile was bound to a specific proxy that has since been
              // deleted. Refuse to silently reroute through a different exit —
              // tell the operator so they can re-bind a proxy on purpose.
              `This profile's configured proxy was deleted. Open Edit and choose a new default proxy before launching, so its egress isn't rerouted to a different IP/country.`
            : 'No saved proxies. Open the Proxies tab, add a SOCKS5 server, then launch this profile. (Sessions require a proxy on this deployment.)',
        }));
        return;
      }
      // Test-before-open (#4): if the bound proxy's LAST probe showed it down,
      // warn before launching (override-able) rather than opening a session
      // that'll fail on a dead exit. Uses the CACHED result only — never blocks
      // a launch on a fresh probe, so an untested/healthy proxy launches
      // straight through. SKIPPED for bulk launch (skipProxyDownConfirm) — the
      // operator already confirmed the batch up front; a per-profile modal here
      // would block the whole loop on each prompt (audit wn1ghalx1).
      // When the operator EXPLICITLY overrides a failed local probe ("Launch
      // anyway"), tell the server to skip its own pre-launch proxy probe for this
      // create — otherwise the server-side gate re-probes the same proxy and hard-
      // blocks the launch with a 422, silently nullifying the override (#12). The
      // server honors `skip_proxy_probe: true` to bypass the gate for this launch.
      let skipProxyProbe = false;
      // Re-test the proxy NOW rather than trusting whatever the cache remembers.
      // A proxy's plan lapses, its ruleset changes, its endpoint rotates — and the
      // cached verdict may predate all of it. Bulk launch keeps using the cache
      // (skipProxyDownConfirm) because probing N proxies serially would stall the
      // whole batch; the up-front bulk confirm already covered intent there.
      // The verdict this gate acts on. Prefer a fresh probe; fall back to the cache.
      // Deliberately NOT read back out of storage after saving: a cache write that
      // drops or reshapes the entry would silently discard a verdict we just
      // measured, and a launch would proceed on no evidence at all.
      let verdict: ProxyTestResult | undefined = probeCache[proxy.id]?.result;
      if (!opts.skipProxyDownConfirm) {
        try {
          const fresh = await testProxy({
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
          });
          verdict = fresh;
          // Persistence is best-effort and separate from the decision.
          setProbeCache(await saveProbeResult(proxy.id, fresh, Date.now()));
        } catch (err) {
          // A probe that could not RUN is not a verdict. Fall through to whatever
          // the cache holds rather than blocking a launch on our own failure.
          console.warn('pre-launch proxy re-test failed; using the cached verdict', err);
        }
      }
      const lastProbe = verdict === undefined ? undefined : { result: verdict };
      if (!opts.skipProxyDownConfirm && lastProbe && !isProxyUsable(lastProbe.result)) {
        // Name the actual fault. "Rejected its credentials" sends someone to retype a
        // password that was accepted; a routing refusal sends them to their provider.
        const reason = !lastProbe.result.reachable
          ? 'was unreachable'
          : !lastProbe.result.auth_ok
            ? 'rejected its credentials'
            : 'authenticated but could not route traffic';
        const proceed = await confirm(
          `The proxy "${proxy.label}" ${reason} on its last test, so this session may fail to reach the internet. Launch anyway?`,
          { confirmLabel: 'Launch anyway' },
        );
        if (!proceed) return; // finally resets busyId
        // The operator accepted the risk → the server must not re-block on its probe.
        skipProxyProbe = true;
      }
      // ARC A — sync the picked proxy to the account (server-side, encrypted)
      // so the dispatch routes egress through it. ensureServerProxy creates or
      // refreshes the account_proxies row + caches its id locally; we pass that
      // id as proxy_id.
      //
      // FAIL CLOSED when the sync does not yield an id (founder-hit sweep 2026-07-08):
      // this profile has a proxy BOUND (pickProxy returned it), so we must NOT fall
      // back to launching without proxy_id — the server treats an absent proxy_id as
      // operator-default egress, so the session would leak out through Driftstack's
      // shared/datacenter IP instead of the user's configured proxy. That is an
      // egress-identity LEAK — the exact thing an anti-detect tool must never do — and
      // the server's own fail-closed guard only covers a present-but-UNRESOLVABLE
      // proxy_id, not an OMITTED one, so the GUI must not omit it.
      //
      // ⚠️ There are TWO ways not to get an id, and the sweep only closed one of them.
      // A THROW (SSRF-rejected host / 4xx / offline blip) was caught; `undefined` was
      // waved through with "only the no-API-key case, which fails at create anyway",
      // and the create body below then OMITTED proxy_id — the exact leak, written out
      // in full, three lines under the comment forbidding it. That branch is unreachable
      // TODAY only because `client` is null whenever the API key is empty (buildClient),
      // and handleLaunch returns early on `!client`. That is a fact about a different
      // module, unstated here, and it is the only thing standing between this call site
      // and the leak: one more `return undefined` inside ensureServerProxy (an
      // unsupported scheme, a cleared key mid-flight) reinstates it silently.
      //
      // So both outcomes are refused the same way, and there is no proxy-less create
      // body left to fall into. AgentChatView's resolveProfileProxyId already treats
      // `undefined` as `blocked` for the same reason; the two mirrored launch paths now
      // agree. `undefined` gets its own sentence because its cause is different: nothing
      // failed, we simply cannot prove the session would exit on the customer's proxy.
      const reportEgressBlock = async (leakMsg: string): Promise<void> => {
        if (opts.skipProxyDownConfirm) {
          // Bulk launch — don't stack a modal per profile; surface via the error banner.
          setState((s) => ({ ...s, error: leakMsg }));
        } else {
          await confirm(leakMsg, { confirmLabel: 'OK' });
        }
      };
      let proxyIdForLaunch: string | undefined;
      try {
        proxyIdForLaunch = await ensureServerProxy(proxy);
      } catch (err) {
        console.warn('proxy account-sync failed; aborting launch to avoid an egress leak', err);
        await reportEgressBlock(
          `Couldn’t set up the proxy “${proxy.label}” for this session, so it was NOT launched — ` +
            `starting it would have sent traffic through Driftstack’s default IP instead of your ` +
            `proxy. Check the proxy and try again.`,
        );
        return; // finally resets busyId; NO proxy-less create body is built
      }
      if (proxyIdForLaunch === undefined) {
        console.warn('proxy account-sync returned no id; aborting launch to avoid an egress leak');
        await reportEgressBlock(
          `Couldn’t set up the proxy “${proxy.label}” for this session, so it was NOT launched — ` +
            `starting it would have sent traffic through Driftstack’s default IP instead of your ` +
            `proxy. Reconnect your API key in Settings and try again.`,
        );
        return; // finally resets busyId; NO proxy-less create body is built
      }
      // Attach THIS profile so the session restores/persists its saved browser
      // identity (file 57). Pass the canonical prof_<uuid> id as-is — the create
      // API accepts it (W335/W336 made both session routes normalize prof_<uuid>
      // or a bare uuid server-side).
      // Launch in manual mode: a GUI launch opens the simulator for the user to
      // drive, so it should start under their control (not AI). They can switch
      // via the mode toggle. (The agent-chat path creates with mode:'ai'.)
      // Start URL the remote browser opens on launch (Settings → Sessions → Start
      // URL; default https://driftstack.dev). normalizeNavigateUrl prepends
      // https:// + rejects non-http(s); fall back to the default if it returns null.
      const startUrl = normalizeNavigateUrl(settings.startUrl) ?? 'https://driftstack.dev';
      // `skip_proxy_probe` is an additive create field the server honors to bypass its
      // pre-launch proxy probe (set only when the operator overrode a failed local
      // probe via "Launch anyway"). It rides on the request body even though the SDK's
      // CreateAgentSessionRequest type doesn't (yet) declare it — the SDK forwards the
      // body verbatim; the cast keeps the call type-safe without editing the SDK.
      // Advanced per-profile geolocation override (task #115) — when the profile
      // has one saved in its local meta, pass it so the device reports those
      // exact coordinates; absent → omitted, so the server/harness keeps the
      // default proxy-exit auto-derive. Validated at save time (profiles-meta
      // cleanEntry + the edit modal), re-bounded server-side on create.
      const geoOverride = profilesMeta[profile.id]?.geolocation;
      // proxy_id is unconditional: the only paths that reach here have a resolved id.
      // A profile with no bound proxy returned above ("Sessions require a proxy on this
      // deployment"), and both no-id outcomes returned as an egress block. There is
      // deliberately no proxy-less variant of this object — the leak is not guarded
      // against, it is unwritable.
      const createBody: CreateAgentSessionRequest & { skip_proxy_probe?: boolean } = {
        profile_id: profile.id,
        proxy_id: proxyIdForLaunch,
        mode: 'manual',
        initial_url: startUrl,
        ...(geoOverride !== undefined ? { geolocation: geoOverride } : {}),
        ...(skipProxyProbe ? { skip_proxy_probe: true } : {}),
      };
      // Idempotency-Key on create: the server runs a pre-launch proxy probe (up to ~12s)
      // before responding, so a launch feels slow and a network blip can drop the 201
      // AFTER the server already created the session. With a stable key the SDK can
      // replay the cached 201 (and a founder retry of the same intent the server dedupes)
      // instead of re-probing and creating a SECOND billed session. The SDK ONLY retries
      // a transient failure when a key is present (no key → maxAttempts:0), so this also
      // arms the retry path. crypto.randomUUID is available in the Tauri webview.
      // Surface the ~10s pre-launch proxy probe as progress so the wait doesn't
      // read as a hang (journey audit H1). Written to `progressNotice` (NOT
      // `notice`) so the 5s success-notice auto-dismiss can't null it mid-probe
      // and make a slow-but-normal launch read as frozen (audit #15). Superseded
      // by the success/error notice, which also clears this progress line.
      setState((s) => ({
        ...s,
        progressNotice:
          'Starting your session — this can take about 10 seconds while we check your proxy…',
        notice: null,
        error: null,
      }));
      const idempotencyKey = crypto.randomUUID();
      const created = await client.agentSessions.create(createBody, { idempotencyKey });
      // BEST-EFFORT: the binding is a local Tauri store write; the session is
      // already created + billed. If markLaunched threw (store IO failure), the
      // unguarded await used to jump straight to the catch — surfacing an error
      // but NEVER closing the session, stranding a billed, running session with
      // no binding so the row's Stop button (gated on boundSession) never showed.
      // Swallow the write failure and proceed to open the simulator (the actual
      // goal); the row falls back to idle but the simulator window can still stop
      // the session, matching the leak-guards in the !sim.opened / no-livekit
      // branches below. (audit)
      await markLaunched(profile.id, created.id).catch((err: unknown) => {
        console.warn('[profiles] markLaunched failed (session created):', err);
      });
      if (created.livekit) {
        // Mint the per-session gui_control_key so the SEPARATE simulator
        // app (which can't read this app's keychain) can drive the
        // control endpoints. Best-effort: minting in the MAIN app with
        // the account API key; a failure leaves control unavailable rather
        // than handing the account credential to the simulator. The key and
        // its API-owned expiry are session-scoped — NOT the account API key.
        const apiKey = settings.apiKey;
        const controlCredential =
          apiKey !== null && apiKey.length > 0
            ? ((await mintGuiControlKey(settings.baseUrl, apiKey, created.id)) ?? undefined)
            : undefined;
        // Open the floating-iPhone simulator window (the only experience now).
        // The proxy's exit country (from its probe) rides through so the
        // separate simulator app's macOS Dock tile reflects the egress country.
        const launchProxy = pickProxy(profile.id);
        const launchCountry =
          launchProxy !== null ? (probeCache[launchProxy.id]?.exitCountry ?? null) : null;
        const sim = await openSimulatorWindow({
          sessionId: created.id,
          info: created.livekit,
          deviceName: formatDeviceName(profile.archetype),
          profileName: profile.name,
          countryCode: launchCountry,
          // Hand off the API host so the separate app's control calls hit the real
          // server (its store may be empty → defaults to localhost) — founder 2026-06-23.
          baseUrl: settings.baseUrl,
          ...(controlCredential !== undefined ? { controlCredential } : {}),
          ...(launchProxy !== null
            ? {
                proxyLabel: `${launchProxy.label} · ${launchProxy.host}:${String(launchProxy.port)}`,
              }
            : {}),
        });
        if (!sim.opened) {
          // No in-app full-page fallback — founder 2026-06-18: the in-app view
          // looked bad (a phone scaled into the full GUI page). The simulator is
          // ONLY ever the separate window now; surface why it didn't open.
          //
          // The session was already created + markLaunched'd, so a window-open failure
          // would otherwise STRAND a billed browser session with no UI to control or
          // stop it. Close it and clear the binding before surfacing the error so a
          // failed open never leaks a running session. Best-effort — a close failure
          // still surfaces the open error (the row's manual Stop remains as a backstop).
          await client.agentSessions.close(created.id).catch(() => undefined);
          await clearProfileSession(profile.id).catch(() => undefined);
          setState((s) => ({
            ...s,
            error: `${friendlySimulatorOpenReason(sim.reason)} The session was stopped — try launching again.`,
          }));
        } else {
          // Concrete success confirmation — the separate window appears, but a note
          // in Profiles closes the loop (journey audit H1).
          setState((s) => ({
            ...s,
            notice: 'Session launched — opening the live window.',
            progressNotice: null,
            error: null,
          }));
        }
      } else {
        // No livekit block — the session didn't get a video channel, so there's
        // nothing to stream into the Simulator window (the only live-session UI).
        // The legacy in-app polling viewer is gone, so this is a hard failure:
        // close the session + clear the binding so a channel-less create never
        // strands a billed browser session, then surface a retry-able error.
        await client.agentSessions.close(created.id).catch(() => undefined);
        await clearProfileSession(profile.id).catch(() => undefined);
        setState((s) => ({
          ...s,
          error:
            "Couldn't start the live view — the session didn't get a video channel. Try again.",
        }));
      }
      await refresh(false);
      await refreshAccountMe();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setLaunchingId(null);
      setBusyId(null);
      // Always retire the in-flight launch progress line once the launch settles
      // (success, any error branch, or a throw) so it can't linger past the probe;
      // the success branch already set the transient `notice`, untouched here (audit #15).
      setState((s) => (s.progressNotice === null ? s : { ...s, progressNotice: null }));
    }
  }

  function toggleSelected(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runBulkOrganization(
    saveLocal: (ids: string[]) => Promise<ProfilesMetaMap>,
    accountUpdateFor: (id: string, next: ProfilesMetaMap) => UpdateProfileRequest | null,
    successNotice: (count: number) => string,
    clearDrafts: () => void,
  ): Promise<void> {
    if (selectedIds.size === 0 || bulkOrganizationMutationInFlightRef.current) return;
    bulkOrganizationMutationInFlightRef.current = true;
    setBulkOrganizationBusy(true);
    setState((s) => ({ ...s, notice: null }));
    const ids = [...selectedIds];
    try {
      const next = await saveLocal(ids);
      setProfilesMeta(next);

      let failed = ids.length;
      if (client) {
        const outcomes = await Promise.allSettled(
          ids.map(async (id) => {
            const update = accountUpdateFor(id, next);
            if (update === null) throw new Error('missing locally-saved profile organization');
            await client.profiles.update(id, update);
          }),
        );
        failed = outcomes.filter((outcome) => outcome.status === 'rejected').length;
      }

      if (failed > 0) {
        const noun = ids.length === 1 ? 'profile' : 'profiles';
        setState((s) => ({
          ...s,
          error: `Saved on this Mac, but couldn’t sync ${failed.toString()} of ${ids.length.toString()} ${noun} to your account. Check your connection and retry.`,
          notice: null,
        }));
        return;
      }

      clearDrafts();
      setSelectedIds(new Set());
      setState((s) => ({ ...s, error: null, notice: successNotice(ids.length) }));
    } catch {
      setState((s) => ({
        ...s,
        error: 'Couldn’t save profile organization on this Mac. Check app storage and try again.',
        notice: null,
      }));
    } finally {
      bulkOrganizationMutationInFlightRef.current = false;
      setBulkOrganizationBusy(false);
    }
  }

  async function handleBulkApply(): Promise<void> {
    if (selectedIds.size === 0) return;
    const meta: { folder?: string; tags?: string[] } = {};
    if (bulkFolder.trim().length > 0) meta.folder = bulkFolder.trim();
    if (bulkTag.trim().length > 0) meta.tags = [bulkTag.trim()];
    if (meta.folder === undefined && meta.tags === undefined) return;
    await runBulkOrganization(
      (ids) =>
        saveProfilesMetaBulk(
          ids,
          meta,
          'merge',
          // Personal-only prune (see refresh seed-down).
          activeWorkspace === null ? state.profiles.map((p) => p.id) : undefined,
        ),
      (id, next) => {
        const saved = next[id];
        return saved
          ? { folder: saved.folder.length > 0 ? saved.folder : null, tags: saved.tags }
          : null;
      },
      (n) => `Updated ${n.toString()} profile${n === 1 ? '' : 's'}.`,
      () => {
        setBulkFolder('');
        setBulkTag('');
      },
    );
  }

  // 2026-06-19 (founder GUI-improvement audit) — handleBulkApply is additive
  // only. These two SUBTRACT: clear the folder off every selected profile, and
  // remove a named tag from each. Both use the same local-first + awaited account
  // write-through lane as the additive action.

  // Clear the folder on every selected profile (folder → '' / null).
  async function handleBulkClearFolder(): Promise<void> {
    if (selectedIds.size === 0) return;
    await runBulkOrganization(
      (ids) =>
        saveProfilesMetaBulk(
          ids,
          { folder: '' },
          'replace',
          activeWorkspace === null ? state.profiles.map((p) => p.id) : undefined,
        ),
      () => ({ folder: null }),
      (n) => `Cleared the folder on ${n.toString()} profile${n === 1 ? '' : 's'}.`,
      () => setBulkFolder(''),
    );
  }

  // Remove the named tag from every selected profile (subtract via the new
  // 'remove' mode); PATCH each profile's recomputed tag set.
  async function handleBulkRemoveTag(): Promise<void> {
    const tag = bulkTag.trim();
    if (selectedIds.size === 0 || tag.length === 0) return;
    await runBulkOrganization(
      (ids) =>
        saveProfilesMetaBulk(
          ids,
          { tags: [tag] },
          'remove',
          activeWorkspace === null ? state.profiles.map((p) => p.id) : undefined,
        ),
      (id, next) => {
        const saved = next[id];
        return saved ? { tags: saved.tags } : null;
      },
      (n) => `Removed "${tag}" from ${n.toString()} profile${n === 1 ? '' : 's'}.`,
      () => setBulkTag(''),
    );
  }

  // Set (or clear, with '') a chosen icon on every selected profile — applied
  // immediately on pick to the local cache, then mirrored to each account row.
  async function handleBulkIcon(icon: string): Promise<void> {
    if (selectedIds.size === 0) return;
    await runBulkOrganization(
      (ids) =>
        saveProfilesMetaBulk(
          ids,
          { icon },
          'merge',
          activeWorkspace === null ? state.profiles.map((p) => p.id) : undefined,
        ),
      () => ({ icon: icon.length > 0 ? icon : null }),
      (n) =>
        icon.length > 0
          ? `Set the icon on ${n.toString()} profile${n === 1 ? '' : 's'}.`
          : `Cleared the icon on ${n.toString()} profile${n === 1 ? '' : 's'}.`,
      () => undefined,
    );
  }

  // Bulk export — snapshot each selected profile via profiles.export (the v1
  // portability envelope; had zero GUI callers) and download them as one JSON
  // file. Best-effort per id; a failed export is skipped, not fatal.
  async function handleBulkExport(): Promise<void> {
    if (!client || selectedIds.size === 0 || bulkExporting) return;
    setBulkExporting(true);
    try {
      const envelopes = [];
      for (const id of selectedIds) {
        try {
          envelopes.push(await client.profiles.export(id));
        } catch {
          /* skip a profile that failed to export; keep the rest */
        }
      }
      if (envelopes.length > 0) {
        // Gate on the CONFIRMED-write boolean: in the Tauri WKWebView the anchor
        // fallback writes NOTHING but returns true, so a successful-looking export
        // could have saved no file. Surface a real error when the write didn't land.
        const saved = await downloadJson(
          timestampedFilename('driftstack-profiles', 'json', new Date()),
          envelopes,
        );
        if (!saved) {
          setState((s) => ({ ...s, error: 'Could not save the exported profiles.' }));
        }
      } else {
        setState((s) => ({ ...s, error: 'Could not export the selected profiles.' }));
      }
    } finally {
      setBulkExporting(false);
    }
  }

  // Single-profile export — the grid ⋯ menu's Export action. Downloads the
  // portable JSON envelope for one profile (same format as bulk, one entry).
  async function handleExport(id: string): Promise<void> {
    if (!client) return;
    try {
      const envelope = await client.profiles.export(id);
      // Gate the success notice on the CONFIRMED-write boolean (the Tauri WKWebView
      // anchor fallback writes NOTHING but returns true) — don't claim a save that
      // didn't happen.
      const saved = await downloadJson(
        timestampedFilename('driftstack-profile', 'json', new Date()),
        envelope,
      );
      const name = state.profiles.find((p) => p.id === id)?.name ?? 'profile';
      if (saved) {
        setState((s) => ({ ...s, notice: `Exported "${name}" as a JSON file.` }));
      } else {
        setState((s) => ({ ...s, error: `Could not save the export for "${name}".` }));
      }
    } catch (err) {
      // Route through the same diagnostic-error path as the other handlers so a
      // Tauri-WebKit "Load failed" surfaces the baseUrl-aware diagnostic.
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    }
  }

  // Duplicate — V-313 server clone. Mints a copy with a server-derived
  // "(copy)" name (archetype + description + folder/tags + icon/note ride
  // along server-side). Seeds the local organization cache from the source so
  // the new card shows the same folder/tags/icon/note immediately + offline,
  // then refreshes the list + the cap counter (a clone consumes a slot).
  async function handleClone(id: string): Promise<void> {
    if (!client || busyId !== null) return;
    setBusyId(id);
    try {
      const clone = await client.profiles.clone(id);
      // Seed local meta from the source so the clone's card matches at once.
      const sourceMeta = profilesMeta[id];
      if (sourceMeta) {
        const next = await saveProfileMeta(clone.id, sourceMeta, [
          ...state.profiles.map((p) => p.id),
          clone.id,
        ]);
        setProfilesMeta(next);
      }
      await refresh(false);
      // A clone consumes a cap slot — refresh the counter so the gate flips.
      await refreshAccountMe();
      setState((s) => ({ ...s, notice: `Duplicated as "${clone.name}".` }));
    } catch (err) {
      // friendlyError surfaces 402 TierLimit / 409 Conflict via DriftstackError.
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  // Import — V-480. Parse an exported JSON file (a single envelope object OR a
  // bulk array of them), import each via profiles.import, then refresh. The
  // optional name-override only applies to a single-envelope import.
  async function handleImport(text: string, nameOverride: string): Promise<void> {
    if (!client) return;
    type ImportBody = Parameters<typeof client.profiles.import>[0];
    type Envelope = ImportBody['envelope'];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setState((s) => ({ ...s, error: 'That file is not valid JSON.' }));
      return;
    }
    // A single export file is one envelope object; a bulk file is an array. The
    // shape is validated server-side on import — here we just split it.
    const envelopes: Envelope[] = Array.isArray(parsed)
      ? (parsed as Envelope[])
      : [parsed as Envelope];
    if (envelopes.length === 0) {
      setState((s) => ({ ...s, error: 'No profiles found in that file.' }));
      return;
    }
    const override = nameOverride.trim();
    // name_override only makes sense for a single profile (a bulk array would
    // collide on the second). Apply it solely to a one-envelope import.
    const applyOverride = override.length > 0 && envelopes.length === 1;
    try {
      let imported = 0;
      for (const envelope of envelopes) {
        await client.profiles.import({
          envelope,
          ...(applyOverride ? { name_override: override } : {}),
        });
        imported += 1;
      }
      setImportOpen(false);
      await refresh(false);
      // Imports consume cap slots — refresh the counter so the gate flips.
      await refreshAccountMe();
      setState((s) => ({
        ...s,
        notice: `Imported ${imported.toString()} profile${imported === 1 ? '' : 's'}.`,
      }));
    } catch (err) {
      // friendlyError surfaces 400 version-mismatch / 402 TierLimit / 409 Conflict.
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    }
  }

  // Bulk launch — start a session for each selected profile, sequentially (so
  // the fleet sees distinct launches + we don't blast the concurrency cap).
  // Confirms first since each launch spawns a billed session; best-effort per
  // profile (a gated/failed one is skipped, the rest still launch).
  async function handleBulkLaunch(): Promise<void> {
    if (!client || selectedIds.size === 0 || bulkLaunching) return;
    // Read-only team member: the per-row Launch is disabled (teamLaunchBlocked),
    // but the bulk-bar Launch wasn't gated — so a non-admin could click it and get
    // N opaque per-profile 403s instead of a clean block. Surface the same reason
    // up front and don't fire any (billed-on-the-server-attempt) create calls.
    if (teamLaunchBlocked) {
      setState((s) => ({ ...s, error: teamLaunchBlockedReason }));
      return;
    }
    // Consistency #9 — already at the concurrent cap → block the whole batch up
    // front with the cap message (handleLaunch also guards per-iteration, but
    // this gives one clean reason instead of letting the first launch error).
    if (atConcurrentCap) {
      setState((s) => ({ ...s, error: concurrentCapReason }));
      return;
    }
    // Skip profiles that ALREADY have a live session. The per-row Launch routes a
    // running profile to reopenStream (never a second create), but bulk launch
    // called handleLaunch unconditionally — and handleLaunch has no running guard
    // (the UI gated it), so a "select all → Launch" over a list that includes
    // running profiles spun up a SECOND billed session for each one already live
    // (double-billing + a duplicate fleet browser). Filter them out here so bulk
    // launch only creates sessions for idle profiles, matching the single-row path.
    const idleTargets = state.profiles.filter(
      (p) => selectedIds.has(p.id) && boundSession(p.id) === null,
    );
    if (idleTargets.length === 0) return;
    // Bulk-cap trim (audit #5) — handleLaunch pre-gates atConcurrentCap, but that
    // value is captured ONCE at this render and never refreshes across the awaited
    // loop (accountMe only re-fetches after the batch), so a bulk launch of N idle
    // profiles with headroom for only a few still fires all N creates and blows
    // past the cap server-side. Trim up front to the remaining headroom so the
    // batch stays within the cap; the server still enforces the true limit.
    const headroom =
      concurrentCap !== null && concurrentActive !== null
        ? Math.max(0, concurrentCap - concurrentActive)
        : null;
    if (headroom === 0) {
      setState((s) => ({ ...s, error: concurrentCapReason }));
      return;
    }
    const trimmed = headroom !== null && idleTargets.length > headroom;
    const targets = trimmed ? idleTargets.slice(0, headroom ?? undefined) : idleTargets;
    if (targets.length === 0) return;
    const ok = await confirm(
      `Launch ${targets.length.toString()} session${
        targets.length === 1 ? '' : 's'
      }? Each selected profile opens its own browser session.${
        trimmed
          ? ` (Limited to your remaining concurrent-session headroom — ${(
              concurrentCap ?? 0
            ).toString()} at a time on ${accountMe?.tier ?? 'this tier'}.)`
          : ''
      }`,
      { confirmLabel: 'Launch' },
    );
    if (!ok) return;
    setBulkLaunching(true);
    try {
      for (const p of targets) {
        try {
          // skipProxyDownConfirm: the up-front bulk confirm already covered intent;
          // a per-profile proxy-down modal here would block the whole batch.
          await handleLaunch(p, { skipProxyDownConfirm: true });
        } catch {
          /* defensive: handleLaunch handles its own errors, but keep the batch
             resilient if a future change lets one throw */
        }
      }
      setSelectedIds(new Set());
    } finally {
      setBulkLaunching(false);
    }
  }

  // Bulk delete — destructive, so it goes through the in-app confirm (native
  // confirm() is flaky in the Tauri WKWebView). Best-effort per id (a running
  // profile's delete fails server-side and is skipped, not fatal); bindings are
  // dropped alongside so stale entries don't linger.
  async function handleBulkDelete(): Promise<void> {
    if (!client || selectedIds.size === 0 || bulkDeleting) return;
    const ids = [...selectedIds];
    const ok = await confirm(
      `Delete ${ids.length} profile${ids.length === 1 ? '' : 's'}? This removes ${
        ids.length === 1 ? 'it' : 'them'
      } from your account and can't be undone.`,
      { confirmLabel: 'Delete' },
    );
    if (!ok) return;
    setBulkDeleting(true);
    let failures = 0;
    try {
      for (const id of ids) {
        try {
          await client.profiles.delete(id);
          await deleteBinding(id);
        } catch {
          // Skip one that failed (e.g. a RUNNING profile the server 409s) — keep
          // deleting the rest, but COUNT it so we can tell the user which/how many
          // survived instead of leaving them silently in the list (mirrors
          // handleEmptyTrash). (audit)
          failures += 1;
        }
      }
      setSelectedIds(new Set());
      await refresh(false);
      await refreshAccountMe();
      if (failures > 0) {
        await confirm(
          `Deleted what it could. ${failures.toString()} profile${
            failures === 1 ? '' : 's'
          } couldn’t be deleted — stop any running ${
            failures === 1 ? 'session' : 'sessions'
          } first, then try again.`,
          { confirmLabel: 'OK' },
        );
      }
    } finally {
      setBulkDeleting(false);
    }
  }

  async function handleStop(profile: Profile): Promise<void> {
    if (!client) return;
    const bound = boundSession(profile.id);
    if (bound === null) {
      await clearProfileSession(profile.id);
      await refresh(false);
      return;
    }
    setBusyId(profile.id);
    try {
      // W624 — close by KIND so an agent-backed profile actually stops
      // (was the founder-hit "destroy keeps running"): agent → close the
      // agent session (which tears down its dispatched browser); driver →
      // destroy the session.
      if (bound.kind === 'agent') {
        await client.agentSessions.close(bound.id);
      } else {
        await client.sessions.destroy(bound.id);
      }
      await clearProfileSession(profile.id);
      await refresh(false);
      await refreshAccountMe();
    } catch (err) {
      setState((s) => ({ ...s, error: friendlyError(err, settings.baseUrl) }));
    } finally {
      setBusyId(null);
    }
  }

  if (!client) {
    return <EmptyConnect baseUrl={settings.baseUrl} onGoToSettings={onGoToSettings} />;
  }

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 p-6">
      {/* ALWAYS-RENDERED workspace recovery bar (independent of profiles/
          accountMe load state). A persisted activeWorkspace pointing at a
          team the user was REMOVED from 403s every request → profiles +
          accountMe both empty → the in-stats-row switcher (gated on those)
          never renders → the hub would be bricked with no way back. This
          bar guarantees a Switch-to-Personal escape regardless of load
          state. */}
      {activeWorkspace !== null && (
        <div
          data-component="workspace-recovery-bar"
          className="flex items-center gap-3 rounded-md border border-accent/40 bg-accent-subtle px-3 py-2 text-xs"
        >
          <span className="text-ink-primary">
            Viewing a team workspace
            <span className="mono ml-1.5 text-ink-muted">{activeWorkspace}</span>
          </span>
          <button
            type="button"
            className="ml-auto rounded-full border border-surface-divider bg-surface-raised px-2.5 py-0.5 font-medium text-ink-primary hover:border-accent"
            onClick={() => setActiveWorkspace(null)}
          >
            ↩ Switch to Personal
          </button>
        </div>
      )}
      {!privacyDismissed && (
        <div
          data-component="privacy-banner"
          className="flex items-center gap-3 rounded-lg border border-surface-divider bg-surface-raised px-4 py-2.5"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
            className="shrink-0 text-accent"
          >
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <p className="flex-1 text-xs text-ink-secondary">
            <b className="text-ink-primary">Sealed &amp; private.</b> Profile state is sealed with
            per-profile encryption under your account's own key hierarchy. Proxy credentials are
            protected locally and synced encrypted to your account when used for a session.
          </p>
          <button
            type="button"
            aria-label="Dismiss privacy note"
            className="text-xs text-ink-muted hover:text-ink-primary"
            onClick={() => {
              setPrivacyDismissed(true);
              try {
                localStorage.setItem('ds_privacy_banner_dismissed', '1');
              } catch {
                /* session-only dismissal */
              }
            }}
          >
            ✕
          </button>
        </div>
      )}
      {/* (Profiles hub-stats strip removed 2026-06-15 — the fleet KPIs live on
          the Command Center only, per founder; Profiles stays focused on the
          grid/list.) */}
      {/* doc-150 items 5/6 — account-wide storage meter (parity with the
          customer dashboard). Sums every profile's size_bytes and shows
          "X of Y used" vs the live tier's cap, with a % + bar + soft (>=80%)
          warn + an over-cap state. Hidden when there are no profiles; the cap
          leg stays collapsed until the live tier is known. Enterprise is
          soft-only — its over-cap state reads as a warning, not a stop. */}
      {state.profiles.length > 0 && (
        <div
          data-component="storage-meter"
          className="flex flex-col gap-1.5 rounded-md border border-surface-divider bg-surface-raised px-3 py-2"
        >
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-secondary">
            <span className="section-label">Storage</span>
            <span className="font-medium text-ink-primary" data-field="storage-total">
              {fmtBytes(storage.total)}
            </span>
            <span>of</span>
            <span className="font-medium text-ink-primary" data-field="storage-cap">
              {storage.cap !== null ? fmtBytes(storage.cap) : '—'}
            </span>
            <span>used across your profiles</span>
            {storage.pct !== null && (
              <span className="text-ink-muted" data-field="storage-pct">
                ({storage.pct.toString()}%)
              </span>
            )}
            {storage.overCap && (
              <span className="font-medium text-status-error" data-field="storage-warn">
                ·{' '}
                {storage.isEnterprise
                  ? 'over your plan allowance — contact sales to raise it'
                  : 'storage limit reached — clear a cache or delete a profile to launch new sessions'}
              </span>
            )}
            {storage.nearCap && (
              <span className="font-medium text-amber-500" data-field="storage-warn">
                · approaching your storage limit
              </span>
            )}
          </p>
          {storage.fraction !== null && (
            <div
              className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-surface-inset"
              role="presentation"
            >
              <div
                className={`h-full rounded-full transition-[width] ${
                  storage.overCap
                    ? 'bg-status-error'
                    : storage.nearCap
                      ? 'bg-amber-500'
                      : 'bg-accent'
                }`}
                style={{ width: `${Math.min(100, storage.pct ?? 0).toString()}%` }}
              />
            </div>
          )}
        </div>
      )}
      {/* Team workspace indicator (hub demo, honest v1): memberships
          from /v1/account/me. Workspace SWITCHING (X-Driftstack-Account
          effective-account) is the named follow-up — this surfaces the
          real memberships so the demo's team surface stops being
          invisible. Sits below the stat strip (not inside the bordered
          grid) so the metrics read as a clean console strip. */}
      {state.profiles.length > 0 && (
        <div
          data-component="workspace-strip"
          className="flex flex-wrap items-center gap-2 rounded-md border border-surface-divider bg-surface-raised px-3 py-2 text-xs"
        >
          <span className="section-label">Workspaces</span>
          {/* The chips ARE the switcher (half-2): selecting rebuilds the
                  client with the SDK effectiveAccount option; every list/
                  action then runs against that workspace (writes need the
                  admin role — server-enforced, surfaced via the role label). */}
          <button
            type="button"
            aria-pressed={activeWorkspace === null}
            className={`rounded-full px-2 py-0.5 ${
              activeWorkspace === null
                ? 'bg-accent-subtle font-medium text-ink-primary'
                : 'border border-surface-divider text-ink-secondary hover:border-ink-muted/40'
            }`}
            onClick={() => setActiveWorkspace(null)}
          >
            Personal
          </button>
          {(accountMe?.teams ?? []).map((t) => (
            <button
              key={t.membership_id}
              type="button"
              aria-pressed={activeWorkspace === t.owner_account_id}
              className={`rounded-full px-2 py-0.5 ${
                activeWorkspace === t.owner_account_id
                  ? 'bg-accent-subtle font-medium text-ink-primary'
                  : 'border border-surface-divider text-ink-secondary hover:border-ink-muted/40'
              }`}
              title={`Owner account ${t.owner_account_id}`}
              onClick={() => setActiveWorkspace(t.owner_account_id)}
            >
              Team · {t.role}
            </button>
          ))}
          {/* Discoverability (2026-06-16, founder "where am I supposed to look"):
              the strip now renders for everyone (not only team members). With no
              teams yet, explain what team workspaces are + where to set one up,
              so Teams isn't invisible until you already belong to one. */}
          {(accountMe?.teams?.length ?? 0) === 0 && (
            <span className="ml-auto text-2xs text-ink-muted">
              Team workspaces let members share profiles — set one up in the web dashboard (Team),
              then it appears here.
            </span>
          )}
          {activeWorkspace !== null && (
            <span className="ml-auto text-2xs text-ink-muted">
              Viewing a team workspace — writes need the admin role.
            </span>
          )}
        </div>
      )}
      {!onboardingDismissed && (
        <OnboardingChecklist
          steps={buildOnboardingSteps(
            {
              apiKeyPresent: settings.apiKey !== null,
              // profile_count is the server truth; state.profiles covers a
              // just-created profile before accountMe re-fetches.
              hasProfile: (accountMe?.profile_count ?? 0) > 0 || state.profiles.length > 0,
              // `concurrent_session_active` + `activeSessions` are DRIVER-only; a GUI
              // launch binds an AGENT session (agt_…), so without activeAgentCount the
              // guided first-run path (create → launch a profile) never checks this off
              // and the checklist never completes/auto-hides (audit 2026-07-08).
              hasLiveSession:
                (accountMe?.concurrent_session_active ?? 0) > 0 ||
                activeSessions.length > 0 ||
                activeAgentCount > 0,
            },
            { goConnect: onGoToSettings, goProfile: () => setCreateOpen(true) },
          )}
          onDismiss={dismissOnboarding}
        />
      )}
      {/* S5 (GUI-rework 2026-06-14) — HERO strip (console.html): greeting +
          health line on the left; primary New-profile + a "Refreshed … ·
          auto-refresh" live pill on the right. No personal name (founder
          anonymity). The refresh timestamp folds into the hero-right pill. */}
      <div
        data-component="profiles-hero"
        className="flex flex-wrap items-start gap-4 border-b border-surface-divider pb-3"
      >
        <div className="min-w-0">
          <h2 className="text-[19px] font-semibold tracking-tight text-ink-primary">{greeting}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
            <b className="font-semibold text-ink-primary">{liveCount}</b> live
            <span className="text-surface-divider">·</span>
            {proxyHealthPct !== null ? (
              <span className="font-semibold text-status-ready">
                {proxyHealthPct.toFixed(1)}% proxy health
              </span>
            ) : (
              <span className="text-ink-muted">proxy health untested</span>
            )}
            <span className="text-surface-divider">·</span>
            all systems nominal
          </p>
        </div>
        <div className="ml-auto flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            {IMPORT_EXPORT_ENABLED && (
              <button
                type="button"
                className="btn-secondary flex items-center gap-1.5"
                onClick={() => setImportOpen(true)}
                disabled={state.loading || atProfileCap}
                aria-disabled={state.loading || atProfileCap}
                title={
                  atProfileCap ? profileCapReason : 'Import profiles from an exported JSON file'
                }
              >
                <span aria-hidden="true">⤒</span>
                <span>Import</span>
              </button>
            )}
            <button
              type="button"
              className="btn-primary flex items-center gap-1.5"
              onClick={() => setCreateOpen(true)}
              disabled={state.loading || atProfileCap}
              aria-disabled={state.loading || atProfileCap}
              title={atProfileCap ? profileCapReason : undefined}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path
                  d="M8 3v10M3 8h10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              <span>New profile</span>
            </button>
          </div>
          <button
            type="button"
            className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-muted hover:text-ink-secondary disabled:opacity-60"
            onClick={() => void refresh(true)}
            disabled={state.loading}
            title="Refresh now"
          >
            <span
              aria-hidden="true"
              className="relative inline-block h-1.5 w-1.5 rounded-full bg-status-ready"
            >
              <span className="absolute inset-[-3px] animate-ping rounded-full border border-status-ready opacity-60" />
            </span>
            {state.loading ? (
              'Refreshing…'
            ) : (
              <>
                Refreshed{' '}
                <span className="mono">
                  {state.refreshedAt !== null
                    ? new Date(state.refreshedAt).toLocaleTimeString()
                    : '—'}
                </span>{' '}
                · auto-refresh {(REFRESH_MS / 1000).toString()}s
              </>
            )}
          </button>
        </div>
      </div>
      <header className="flex flex-col gap-3">
        {state.profiles.length > 0 && (
          <ProfilesActionBar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            sortBy={sortBy}
            onSortByChange={changeSort}
            sortDir={sortDir}
            onSortDirChange={setSortDir}
            visibleCount={filteredProfiles.length}
            totalCount={state.profiles.length}
          />
        )}
        {state.profiles.length > 0 && (
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              aria-pressed={viewMode === 'list'}
              className={
                viewMode === 'list'
                  ? 'rounded bg-accent-subtle px-2 py-1 text-xs font-medium text-ink-primary'
                  : 'rounded px-2 py-1 text-xs text-ink-muted hover:text-ink-primary'
              }
              onClick={() => changeViewMode('list')}
            >
              ☰ List
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'grid'}
              className={
                viewMode === 'grid'
                  ? 'rounded bg-accent-subtle px-2 py-1 text-xs font-medium text-ink-primary'
                  : 'rounded px-2 py-1 text-xs text-ink-muted hover:text-ink-primary'
              }
              onClick={() => changeViewMode('grid')}
            >
              ▦ Grid
            </button>
          </div>
        )}
      </header>

      {selectedIds.size > 0 && (
        <div
          data-component="bulk-bar"
          aria-busy={bulkOrganizationBusy}
          // rounded-2xl (not rounded-full) so the wrapped multi-row state at narrow
          // widths reads as an intentional card rather than a mangled pill (audit #19);
          // the bar holds 10+ controls and wraps once the viewport gets tight.
          className="animate-view-in fixed bottom-5 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-2xl border border-surface-divider bg-surface-elevated px-4 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.4)]"
        >
          <span className="text-xs font-semibold text-ink-primary">
            {selectedIds.size.toString()} selected
          </span>
          <button
            type="button"
            className="btn-primary flex items-center gap-1.5 px-3 py-1 text-xs disabled:opacity-50"
            onClick={() => void handleBulkLaunch()}
            disabled={bulkLaunching || bulkOrganizationBusy}
            title="Open a browser session for each selected profile"
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
              <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
            </svg>
            {bulkLaunching ? 'Launching…' : 'Launch'}
          </button>
          <span aria-hidden className="h-5 w-px bg-surface-divider" />
          <FolderPicker
            ariaLabel="Bulk folder"
            noneLabel="Move to folder…"
            folders={allFolders}
            value={bulkFolder}
            onChange={setBulkFolder}
            disabled={bulkOrganizationBusy}
          />
          {/* Subtract — clear the folder off every selected profile (2026-06-19). */}
          <button
            type="button"
            className="rounded px-2 py-1 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-raised hover:text-ink-primary"
            onClick={() => void handleBulkClearFolder()}
            disabled={bulkOrganizationBusy}
            title="Remove the selected profiles from their folder"
          >
            Clear folder
          </button>
          <input
            aria-label="Bulk tag"
            placeholder="Add or remove tag…"
            className="w-32 rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary"
            value={bulkTag}
            onChange={(e) => setBulkTag(e.target.value)}
            disabled={bulkOrganizationBusy}
          />
          {/* Subtract — remove the typed tag from every selected profile (2026-06-19). */}
          <button
            type="button"
            className="rounded px-2 py-1 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-raised hover:text-ink-primary disabled:opacity-50"
            onClick={() => void handleBulkRemoveTag()}
            disabled={bulkOrganizationBusy || bulkTag.trim().length === 0}
            title="Remove the tag from the selected profiles"
          >
            Remove tag
          </button>
          <select
            aria-label="Set icon"
            className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary"
            value="__noop"
            disabled={bulkOrganizationBusy}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__noop') return;
              void handleBulkIcon(v === '__none' ? '' : v);
            }}
          >
            <option value="__noop">Set icon…</option>
            <option value="__none">✕ None</option>
            {PROFILE_ICONS.map((i) => (
              <option key={i.emoji} value={i.emoji}>
                {i.emoji} {i.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-primary px-2.5 py-1 text-xs"
            onClick={() => void handleBulkApply()}
            disabled={
              bulkOrganizationBusy ||
              (bulkFolder.trim().length === 0 && bulkTag.trim().length === 0)
            }
          >
            {bulkOrganizationBusy ? 'Saving…' : 'Apply'}
          </button>
          {IMPORT_EXPORT_ENABLED && (
            <button
              type="button"
              className="btn-secondary px-2.5 py-1 text-xs disabled:opacity-50"
              onClick={() => void handleBulkExport()}
              disabled={bulkExporting || bulkOrganizationBusy}
              title="Download the selected profiles as a portable JSON export"
            >
              {bulkExporting ? 'Exporting…' : 'Export'}
            </button>
          )}
          <span aria-hidden className="h-5 w-px bg-surface-divider" />
          <button
            type="button"
            className="rounded px-2.5 py-1 text-xs font-medium text-status-error transition-colors hover:bg-status-error/10 disabled:opacity-50"
            onClick={() => void handleBulkDelete()}
            disabled={bulkDeleting || bulkOrganizationBusy}
            title="Delete the selected profiles (asks for confirmation)"
          >
            {bulkDeleting ? 'Deleting…' : 'Delete'}
          </button>
          <button
            type="button"
            className="text-xs text-ink-muted hover:text-ink-primary"
            onClick={() => {
              if (bulkOrganizationMutationInFlightRef.current) return;
              setSelectedIds(new Set());
            }}
            disabled={bulkOrganizationBusy}
          >
            Clear
          </button>
        </div>
      )}
      {state.loadError !== null ? (
        <ErrorBanner
          message={state.loadError}
          onRetry={() => void refresh(true)}
          retrying={state.loading}
          onDismiss={() => setState((s) => ({ ...s, loadError: null }))}
        />
      ) : (
        state.error !== null && (
          <ErrorBanner
            message={state.error}
            onDismiss={() => setState((s) => ({ ...s, error: null }))}
          />
        )
      )}
      {railTaxonomyRetry !== null && (
        <div
          role="alert"
          data-component="profiles-taxonomy-sync-issue"
          className="flex flex-wrap items-center gap-3 rounded border border-status-warning/30 bg-status-warning/10 px-3 py-2"
        >
          <span className="min-w-0 flex-1 text-sm text-ink-primary">
            {railTaxonomySyncMessage(railTaxonomyRetry)}
          </span>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void retryRailTaxonomySync()}
            disabled={railTaxonomyBusy}
          >
            {railTaxonomyBusy ? 'Retrying…' : 'Retry sync'}
          </button>
        </div>
      )}
      {state.notice !== null && (
        <div
          role="status"
          data-component="profiles-notice"
          className="flex items-start justify-between gap-3 rounded border border-status-ready/30 bg-status-ready/10 px-3 py-2"
        >
          <span className="text-sm text-ink-primary">{state.notice}</span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setState((s) => ({ ...s, notice: null }))}
          >
            Dismiss
          </button>
        </div>
      )}
      {/* In-flight launch progress (audit #15) — a separate banner from the
          transient `notice` so the 5s auto-dismiss can't null it mid-probe. No
          Dismiss button: the launch continues regardless and it clears itself
          once the launch settles (see the launch handler's finally). */}
      {state.progressNotice !== null && (
        <div
          role="status"
          aria-live="polite"
          data-component="profiles-progress-notice"
          className="flex items-start gap-3 rounded border border-status-ready/30 bg-status-ready/10 px-3 py-2"
        >
          <span className="text-sm text-ink-primary">{state.progressNotice}</span>
        </div>
      )}

      {state.profiles.length === 0 && state.loading && state.refreshedAt === null ? (
        // Initial load in flight — show a skeleton, NOT the "No profiles yet"
        // empty state. The mount effect runs refresh(true) with profiles still [],
        // so the full empty state used to flash on every open (reads as data loss
        // for a beat) even for an account with many profiles. The empty state
        // below renders once the initial load RESOLVES (loading:false) — on
        // success with genuinely zero profiles, or on error (the error banner
        // above explains it; we don't strand the user on a spinner). Subsequent
        // refreshes keep refreshedAt set, so they never re-show the skeleton. (audit)
        <ProfilesInitialSkeleton viewMode={viewMode} />
      ) : state.profiles.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded border border-dashed border-surface-divider px-8 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-accent-subtle text-accent">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-medium text-ink-primary">No profiles yet</h3>
            <p className="max-w-md text-sm text-ink-secondary">
              A profile is a persistent identity — cookies, localStorage, IndexedDB — reused across
              sessions. Bind a session to a profile to keep login state, returning-visitor signals,
              and stealth fingerprints stable between runs.
            </p>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setCreateOpen(true)}
            disabled={atProfileCap}
            title={
              atProfileCap
                ? `Profile cap reached (${(profileCap ?? 0).toString()} for ${
                    accountMe?.tier ?? 'this tier'
                  }). Upgrade to add more.`
                : undefined
            }
          >
            Create your first profile
          </button>
          <p className="text-xs text-ink-muted">
            Sessions without a profile start ephemeral — fresh state every run.
          </p>
          <p className="text-xs text-ink-muted">
            Sessions run through a proxy — add one in the Proxies tab first.
          </p>
        </div>
      ) : (
        <div className={PROFILES_WORKSPACE_CLASS}>
          {/* S3 (GUI-rework 2026-06-15, founder) — FOLDERS as a permanent left
              NAV rail (vertical, full-width rows) instead of the old horizontal
              shelf + the redundant filter dropdown. Counts derive from the same
              organization map; selection drives folderFilter unchanged. */}
          <aside
            aria-label="Folders and tags"
            aria-busy={railTaxonomyBusy}
            className={PROFILES_RAIL_CLASS}
          >
            <span className="section-label px-2.5 pb-1">Folders</span>
            <FolderItem
              variant="rail"
              label="All profiles"
              count={state.profiles.length}
              active={folderFilter === 'all'}
              onSelect={() => setFolderFilter('all')}
            />
            {allFolders.map((f) => (
              <div key={f} className="group/rail relative">
                <FolderItem
                  variant="rail"
                  label={f}
                  icon={customFolderIcons[f]}
                  count={state.profiles.filter((p) => profilesMeta[p.id]?.folder === f).length}
                  active={folderFilter === f}
                  onSelect={() => setFolderFilter(f)}
                />
                <RailRowMenu
                  key={`${taxonomyCacheScope ?? 'unowned'}:${f}`}
                  label={`folder ${f}`}
                  maxChars={MAX_FOLDER_NAME_CHARS}
                  disabled={railTaxonomyControlsBlocked}
                  onRename={(next) => handleRenameFolder(f, next)}
                  onReicon={(emoji) => handleReiconFolder(f, emoji)}
                  onDelete={() => handleDeleteFolder(f)}
                />
              </div>
            ))}
            <FolderItem
              variant="rail"
              label="Unfiled"
              count={state.profiles.filter((p) => (profilesMeta[p.id]?.folder ?? '') === '').length}
              active={folderFilter === 'unfiled'}
              onSelect={() => setFolderFilter('unfiled')}
            />
            {/* 2026-06-15/16 (founder) — create a new (possibly empty) folder
                from the rail, now WITH an optional icon picker. Name + icon +
                Add; Enter-in-name or Add commits via handleCreateFolder, Escape
                cancels. (No blur-commit — clicking the icon select blurs the
                name input, which must not fire a create.) */}
            {creatingFolder ? (
              <div className="mt-0.5 flex flex-col gap-1 rounded-lg border border-surface-divider bg-surface-inset p-1.5">
                <input
                  autoFocus
                  aria-label="New folder name"
                  placeholder="Folder name…"
                  value={newFolderName}
                  disabled={railTaxonomyControlsBlocked}
                  maxLength={MAX_FOLDER_NAME_CHARS}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreateFolder();
                    else if (e.key === 'Escape') {
                      setNewFolderName('');
                      setNewFolderIcon('');
                      setCreatingFolder(false);
                    }
                  }}
                  className="w-full rounded border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary placeholder:text-ink-muted focus:border-accent focus:outline-none"
                />
                <select
                  aria-label="New folder icon"
                  value={newFolderIcon}
                  disabled={railTaxonomyControlsBlocked}
                  onChange={(e) => setNewFolderIcon(e.target.value)}
                  className="w-full rounded border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary focus:border-accent focus:outline-none"
                >
                  <option value="">— Icon (optional) —</option>
                  {PROFILE_ICONS.map((i) => (
                    <option key={i.emoji} value={i.emoji}>
                      {i.emoji} {i.label}
                    </option>
                  ))}
                </select>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => void handleCreateFolder()}
                    disabled={railTaxonomyControlsBlocked || newFolderName.trim().length === 0}
                    className="flex-1 rounded bg-accent-subtle px-2 py-1 text-xs font-medium text-ink-primary disabled:opacity-50"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNewFolderName('');
                      setNewFolderIcon('');
                      setCreatingFolder(false);
                    }}
                    disabled={railTaxonomyBusy}
                    className="rounded px-2 py-1 text-xs text-ink-muted hover:text-ink-primary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreatingFolder(true)}
                disabled={railTaxonomyControlsBlocked}
                className="mt-0.5 flex w-full items-center gap-1.5 rounded-lg border border-dashed border-surface-divider px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-ink-muted/60 hover:text-ink-primary"
              >
                <span aria-hidden="true" className="text-sm leading-none">
                  +
                </span>
                New folder
              </button>
            )}
            {/* 2026-06-16 (founder) — TAGS section in the left rail, under
                Folders, with a create affordance (mirrors folders). Filtering
                by a tag composes (AND) with the folder filter. */}
            <span className="section-label px-2.5 pb-1 pt-3">Tags</span>
            {allTags.map(({ tag, count }) => {
              const active = tagFilter === tag;
              return (
                <div key={tag} className="group/rail relative">
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTagFilter(active ? null : tag)}
                    className={`flex w-full items-center gap-2 rounded-lg border border-transparent px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      active
                        ? 'bg-accent-subtle font-semibold text-ink-primary'
                        : 'text-ink-secondary hover:bg-surface-raised hover:text-ink-primary'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: folderColor(tag) }}
                    />
                    <span className="flex-1 truncate text-left">#{tag}</span>
                    <span
                      className={`mono rounded-[5px] px-1.5 py-px text-2xs font-semibold ${
                        active ? 'bg-accent/15 text-ink-primary' : 'bg-surface-inset text-ink-muted'
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                  <RailRowMenu
                    key={`${taxonomyCacheScope ?? 'unowned'}:${tag}`}
                    label={`tag ${tag}`}
                    maxChars={MAX_TAG_NAME_CHARS}
                    disabled={railTaxonomyControlsBlocked}
                    onRename={(next) => handleRenameTag(tag, next)}
                    onDelete={() => handleDeleteTag(tag)}
                  />
                </div>
              );
            })}
            {creatingTag ? (
              <input
                autoFocus
                aria-label="New tag name"
                placeholder="Tag name…"
                value={newTagName}
                disabled={railTaxonomyControlsBlocked}
                maxLength={MAX_TAG_NAME_CHARS}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateTag();
                  else if (e.key === 'Escape') {
                    setNewTagName('');
                    setCreatingTag(false);
                  }
                }}
                onBlur={() => {
                  if (newTagName.trim().length > 0) void handleCreateTag();
                  else setCreatingTag(false);
                }}
                className="mt-0.5 w-full rounded-lg border border-surface-divider bg-surface-inset px-2.5 py-1.5 text-xs text-ink-primary placeholder:text-ink-muted focus:border-accent focus:outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => setCreatingTag(true)}
                disabled={railTaxonomyControlsBlocked}
                className="mt-0.5 flex w-full items-center gap-1.5 rounded-lg border border-dashed border-surface-divider px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:border-ink-muted/60 hover:text-ink-primary"
              >
                <span aria-hidden="true" className="text-sm leading-none">
                  +
                </span>
                New tag
              </button>
            )}
            {/* L4b recycle bin — Trash entry, pinned at the bottom of the rail.
                Toggles the trashed-profiles view; loads on open. */}
            <button
              type="button"
              onClick={() => {
                setTrashView((on) => {
                  const next = !on;
                  if (next) void loadTrash();
                  return next;
                });
              }}
              className={`mt-3 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                trashView
                  ? 'border-accent bg-accent-subtle text-ink-primary'
                  : 'border-transparent text-ink-muted hover:bg-surface-elevated hover:text-ink-primary'
              }`}
              aria-pressed={trashView}
            >
              <span aria-hidden="true">🗑️</span>
              <span className="flex-1 truncate text-left">Trash</span>
              {trashed.length > 0 ? (
                <span className="rounded-full bg-surface-divider px-1.5 text-[10px] text-ink-secondary">
                  {trashed.length}
                </span>
              ) : null}
            </button>
          </aside>
          <div className={PROFILES_CONTENT_CLASS}>
            {/* min-h-0 + overflow-y-auto so the grid/table scrolls WITHIN the
                view on small screens instead of overflowing off-screen
                (founder: "profile list isn't fully in view, should auto-scale").
                When the fixed bulk-action bar is shown, reserve bottom padding
                so the last grid/table row can scroll clear of it. */}
            <div className={`${PROFILES_SCROLL_CLASS} ${selectedIds.size > 0 ? 'pb-20' : ''}`}>
              {trashView ? (
                <TrashPanel
                  trashed={trashed}
                  loading={trashLoading}
                  dataAvailable={trashDataAvailable}
                  loadError={trashLoadError}
                  restoringId={restoringId}
                  purgingId={purgingId}
                  bulkBusy={bulkTrashBusy}
                  bulkAction={bulkTrashAction}
                  onRestore={(id) => void handleRestore(id)}
                  onPurge={(id, name) => void handlePurge(id, name)}
                  onRestoreAll={(ids) => void handleRestoreAll(ids)}
                  onEmptyTrash={(ids) => void handleEmptyTrash(ids)}
                  onRetry={() => void loadTrash()}
                  onBack={() => setTrashView(false)}
                />
              ) : viewMode === 'grid' ? (
                <div className={PROFILES_GRID_CLASS}>
                  {filteredProfiles.length === 0 ? (
                    <div className="col-span-full">
                      <ProfilesEmpty hasActiveFilters={hasActiveFilters} onClear={clearFilters} />
                    </div>
                  ) : null}
                  {filteredProfiles.map((profile) => {
                    const bound = boundSession(profile.id);
                    const running = bound !== null;
                    // S5 (GUI-rework 2026-06-14) — card-level derived display
                    // values from the REAL probe cache (no invented data). The
                    // proxy row + latency meter + health pill all read these.
                    const px = pickProxy(profile.id);
                    const probe = px !== null ? probeCache[px.id] : undefined;
                    // Only surface the cached exit IP / country / flag when the LAST
                    // capability probe was actually healthy. saveProbeResult preserves
                    // a proxy's prior exit-geo across a FAILED capability re-test
                    // (capability + exit probes are separate), so without this gate a
                    // proxy that was healthy (exit US 1.2.3.4 cached) then went down
                    // would still show a misleading "exits from US 1.2.3.4" — for an
                    // anti-detect tool, a stale exit geo on a dead proxy is a real
                    // hazard. Matches the in-session/reload gate in ProxiesView.
                    const exitOk = probe !== undefined && isProxyUsable(probe.result);
                    const lat = probe?.result.latency_ms;
                    // latency meter fill: 0–250ms mapped to 0–100% (clamped).
                    const latFill =
                      lat !== undefined ? Math.max(6, Math.min(100, (lat / 250) * 100)) : 0;
                    const latGood = lat !== undefined && lat <= 100;
                    return (
                      <div key={profile.id} data-profile-id={profile.id}>
                        <ProfilePhoneCard
                          name={profile.name}
                          monogram={profileMonogram(profile.name)}
                          icon={profilesMeta[profile.id]?.icon ?? ''}
                          hue={identityHue(profile.name)}
                          deviceLabel={formatDeviceName(profile.archetype)}
                          running={running}
                          selected={selectedIds.has(profile.id)}
                          lastUsedIso={profile.last_used_at}
                          sizeLabel={fmtBytes(profile.size_bytes)}
                          savedTabsReopen={
                            profile.last_saved_at != null || profile.size_bytes !== null
                          }
                          folder={profilesMeta[profile.id]?.folder ?? ''}
                          tags={profilesMeta[profile.id]?.tags ?? []}
                          note={profilesMeta[profile.id]?.note ?? ''}
                          onSaveNote={(note) => handleSaveNote(profile.id, note)}
                          hasProxy={px !== null}
                          proxyExplicit={proxyIsExplicit(profile.id)}
                          flag={exitOk && probe?.exitCountry ? flagEmoji(probe.exitCountry) : '🌍'}
                          countryCode={exitOk ? (probe?.exitCountry ?? null) : null}
                          exitIp={exitOk ? (probe?.exitIp ?? null) : null}
                          latencyMs={lat ?? null}
                          latencyFillPct={latFill}
                          latencyGood={latGood}
                          probed={probe !== undefined}
                          capabilities={probe?.result ?? null}
                          checkedAtIso={
                            probe?.at !== undefined ? new Date(probe.at).toISOString() : null
                          }
                          busy={busyId === profile.id}
                          launching={launchingId === profile.id}
                          anyBusy={busyId !== null}
                          testing={px !== null && testingProxyId === px.id}
                          testDisabled={testingProxyId !== null}
                          // Consistency #9 — gate Launch at the concurrent cap
                          // too (team block takes precedence). The card applies
                          // launchDisabled only to IDLE profiles, so a running
                          // profile's Stop/Open stays enabled.
                          launchDisabled={teamLaunchBlocked || atConcurrentCap}
                          launchDisabledReason={
                            teamLaunchBlocked ? teamLaunchBlockedReason : concurrentCapReason
                          }
                          onToggleSelect={() => toggleSelected(profile.id)}
                          onPrimary={() => {
                            // A running profile re-opens its live stream in the
                            // floating Simulator window (the only live-session UI).
                            // Only agent sessions stream; a driver binding has no
                            // live UI (driver sessions are no longer created), so
                            // it has nothing to open. An idle profile launches.
                            if (running && bound !== null) {
                              if (bound.kind === 'agent') void reopenStream(bound.id, profile.id);
                            } else void handleLaunch(profile);
                          }}
                          onWatch={() => {
                            if (running && bound !== null) {
                              if (bound.kind === 'agent') void reopenStream(bound.id, profile.id);
                            } else void handleLaunch(profile);
                          }}
                          onTest={() => {
                            if (px !== null) void handleTestProxy(px);
                          }}
                          onStop={running ? () => void handleStop(profile) : undefined}
                          onAssist={onAssist ? () => onAssist(profile.id) : undefined}
                          onEdit={() => setEditTarget(profile)}
                          onClone={CLONE_ENABLED ? () => void handleClone(profile.id) : undefined}
                          cloneDisabled={atProfileCap}
                          cloneDisabledReason={profileCapReason}
                          onExport={
                            IMPORT_EXPORT_ENABLED ? () => void handleExport(profile.id) : undefined
                          }
                          onTrim={() => void handleTrim(profile.id)}
                          onDelete={() => void handleDelete(profile.id)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : filteredProfiles.length === 0 ? (
                <ProfilesEmpty hasActiveFilters={hasActiveFilters} onClear={clearFilters} />
              ) : (
                (() => {
                  const byId = new Map(filteredProfiles.map((pr) => [pr.id, pr]));
                  const rows: ProfileTableRow[] = filteredProfiles.map((profile) => {
                    const bound = boundSession(profile.id);
                    const px = pickProxy(profile.id);
                    const probe = px !== null ? probeCache[px.id] : undefined;
                    // Gate the exit IP / country / location on the last capability
                    // probe being healthy — saveProbeResult preserves prior exit-geo
                    // across a failed re-test, so a down proxy must NOT keep showing a
                    // stale "exits from US 1.2.3.4". Matches the grid card + ProxiesView.
                    const exitOk = probe !== undefined && isProxyUsable(probe.result);
                    const caps = probe !== undefined ? proxyCapabilities(probe.result) : null;
                    const udp: 'ok' | 'fail' | 'unknown' =
                      caps === null
                        ? 'unknown'
                        : (caps.find((c) => c.key === 'webrtc')?.ok ?? false)
                          ? 'ok'
                          : 'fail';
                    return {
                      id: profile.id,
                      name: profile.name,
                      icon: profilesMeta[profile.id]?.icon ?? '',
                      deviceLabel: formatDeviceName(profile.archetype),
                      running: bound !== null,
                      runningSinceIso: boundSessionStartedAt(profile.id),
                      hasProxy: px !== null,
                      flag: exitOk && probe?.exitCountry ? flagEmoji(probe.exitCountry) : '🌍',
                      countryCode: exitOk ? (probe?.exitCountry ?? null) : null,
                      exitIp: exitOk ? (probe?.exitIp ?? null) : null,
                      proxyAddress: px !== null ? `${px.host}:${px.port}` : null,
                      // Prefer the granular lumtest geo (city, region) when the
                      // exit probe captured it; the flag already conveys the
                      // country, so fall back to the country name otherwise. Gated on
                      // exitOk so a down proxy doesn't show a stale location.
                      locationLabel: !exitOk
                        ? null
                        : probe?.exitCity != null && probe.exitCity.length > 0
                          ? [probe.exitCity, probe.exitRegion]
                              .filter((s): s is string => typeof s === 'string' && s.length > 0)
                              .join(', ')
                          : probe?.exitCountry
                            ? regionName(probe.exitCountry)
                            : null,
                      probed: probe !== undefined,
                      udp,
                      latencyMs: probe?.result.latency_ms ?? null,
                      folder: profilesMeta[profile.id]?.folder ?? '',
                      tags: profilesMeta[profile.id]?.tags ?? [],
                      note: profilesMeta[profile.id]?.note ?? '',
                      sizeLabel: fmtBytes(profile.size_bytes),
                      savedTabsReopen: profile.last_saved_at != null || profile.size_bytes !== null,
                      createdAtIso: profile.created_at,
                      lastUsedIso: profile.last_used_at,
                      selected: selectedIds.has(profile.id),
                      busy: busyId === profile.id,
                      launching: launchingId === profile.id,
                      testing: px !== null && testingProxyId === px.id,
                      testDisabled: testingProxyId !== null,
                      // Launch blocks NON-admin team members (the server lets
                      // admins launch the owner's profile, V-326e3-style) AND at
                      // the CONCURRENT-SESSION cap (consistency #9 — launching
                      // consumes a session slot; pre-gate so the founder isn't
                      // hit by the slow ~12s 402). NOT atProfileCap: that cap
                      // limits CREATING, not launching. The table applies
                      // launchDisabled only to idle rows, so Stop/Open stay live.
                      launchDisabled: teamLaunchBlocked || atConcurrentCap,
                      launchDisabledReason: teamLaunchBlocked
                        ? teamLaunchBlockedReason
                        : concurrentCapReason,
                    };
                  });
                  // 2026-06-20 — UNIFIED sort: `rows` is built from the already
                  // ordered `filteredProfiles`, so the table renders it verbatim
                  // (the old in-table re-sort is gone — it was what silently
                  // changed the order on a grid↔list toggle). The header reflects
                  // the shared sortBy via the key map; clicking one routes back
                  // through `changeSort`.
                  const resolve = (id: string) => byId.get(id) ?? null;
                  return (
                    <ProfilesTable
                      rows={rows}
                      anyBusy={busyId !== null}
                      sortKey={mapSortByToTableKey(sortBy)}
                      sortDir={sortDir}
                      onSort={(k) => changeSort(mapTableSortKey(k))}
                      allSelected={rows.length > 0 && rows.every((row) => selectedIds.has(row.id))}
                      onToggleSelectAll={() => {
                        setSelectedIds((prev) => {
                          const allOn = rows.length > 0 && rows.every((row) => prev.has(row.id));
                          if (allOn) return new Set();
                          return new Set(rows.map((row) => row.id));
                        });
                      }}
                      onToggleSelect={(id) => toggleSelected(id)}
                      onPrimary={(id) => {
                        const profile = resolve(id);
                        if (profile === null) return;
                        const bound = boundSession(id);
                        if (bound !== null) {
                          // A running profile re-opens its live stream in the
                          // floating Simulator window (the only live-session UI).
                          // Only agent sessions stream; a driver binding has no
                          // live UI (driver sessions are no longer created).
                          if (bound.kind === 'agent') void reopenStream(bound.id, id);
                        } else void handleLaunch(profile);
                      }}
                      onWatch={(id) => {
                        const profile = resolve(id);
                        if (profile === null) return;
                        const bound = boundSession(id);
                        if (bound !== null) {
                          if (bound.kind === 'agent') void reopenStream(bound.id, id);
                        } else void handleLaunch(profile);
                      }}
                      onStop={(id) => {
                        const profile = resolve(id);
                        if (profile !== null) void handleStop(profile);
                      }}
                      onTest={(id) => {
                        const px = pickProxy(id);
                        if (px !== null) void handleTestProxy(px);
                      }}
                      onEdit={(id) => {
                        const profile = resolve(id);
                        if (profile !== null) setEditTarget(profile);
                      }}
                      onClone={CLONE_ENABLED ? (id) => void handleClone(id) : undefined}
                      cloneDisabled={atProfileCap}
                      cloneDisabledReason={profileCapReason}
                      onTrim={(id) => void handleTrim(id)}
                      onDelete={(id) => void handleDelete(id)}
                      onSaveNote={handleSaveNote}
                    />
                  );
                })()
              )}
            </div>
          </div>
        </div>
      )}

      {createOpen && (
        <CreateProfileModal
          existingFolders={allFolders}
          // When the user is viewing a specific folder, a new profile inherits it
          // (founder: "created inside a folder → add it to that folder, not unfiled").
          initialFolder={folderFilter !== 'all' && folderFilter !== 'unfiled' ? folderFilter : ''}
          // Likewise, a profile created while filtered to a tag inherits that tag.
          initialTag={tagFilter ?? ''}
          onClose={() => setCreateOpen(false)}
          onCreated={(opts) => {
            setCreateOpen(false);
            void refresh(false);
            // V-239 — refresh the cap counter so the gate flips to
            // disabled if we just hit cap.
            void refreshAccountMe();
            // #142 — the profile was created but an EXPLICIT proxy choice didn't
            // persist, so at launch it would silently use the first proxy, not the
            // one picked. Non-blocking warning (the create already completed) so the
            // user re-binds from the row before launching.
            if (opts?.proxyBindFailed === true) {
              void confirm(
                'The profile was created, but your proxy choice couldn’t be saved — set it ' +
                  'from the profile’s row before launching, otherwise it will use your first ' +
                  'proxy, not the one you picked.',
                { confirmLabel: 'OK' },
              );
            }
            // #3 auto-test on create: a new profile launches through the first
            // available proxy — probe it now (if not already cached) so its
            // card shows egress without a manual Test. Best-effort, background.
            const firstProxy = proxies[0];
            if (firstProxy !== undefined && probeCache[firstProxy.id] === undefined) {
              void handleTestProxy(firstProxy);
            }
          }}
        />
      )}

      {editTarget !== null && (
        <EditProfileModal
          profile={editTarget}
          meta={profilesMeta[editTarget.id]}
          existingFolders={allFolders}
          proxies={proxies}
          // The explicitly-bound proxy (null = "First available" at launch).
          currentProxyId={
            bindings.find((b) => b.profileId === editTarget.id)?.defaultProxyId ?? null
          }
          onClose={() => setEditTarget(null)}
          onSaved={(updatedMeta) => {
            // Mirror the edited organization metadata into the local cache so the
            // hub reflects it immediately + offline (server already PATCHed).
            void saveProfileMeta(
              editTarget.id,
              updatedMeta,
              // Personal only — in a team workspace state.profiles is the OWNER's
              // set; pruning against it would wipe the member's own org metadata.
              activeWorkspace === null ? state.profiles.map((pr) => pr.id) : undefined,
            ).then(setProfilesMeta);
            setEditTarget(null);
            // refresh(false) reloads bindings → the card/table re-render via
            // pickProxy with the rebound proxy.
            void refresh(false);
          }}
        />
      )}

      {IMPORT_EXPORT_ENABLED && importOpen && (
        <ImportProfileModal
          onClose={() => setImportOpen(false)}
          onImport={(text, nameOverride) => void handleImport(text, nameOverride)}
        />
      )}
    </div>
  );
}

/**
 * Route every profile-form exit through one guard. A backdrop click, Escape,
 * Close, and Cancel must all behave identically: pristine forms close at once,
 * dirty forms ask before discarding, and an in-flight submit cannot be closed.
 *
 * The ref closes a small re-entrancy hole: while the branded confirmation is
 * open, its Escape event also reaches the underlying form's focus trap. Without
 * the ref, that second Escape could open a replacement confirmation and orphan
 * the first promise.
 */
function useProfileDraftCloseGuard({
  dirty,
  submitting,
  dialogRef,
  onClose,
  discardPrompt = 'Discard your unsaved profile changes?',
  discardLabel = 'Discard changes',
}: {
  dirty: boolean;
  submitting: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  discardPrompt?: string;
  discardLabel?: string;
}): { requestClose: () => void; discardConfirmOpen: boolean } {
  const confirm = useConfirm();
  const confirmOpenRef = useRef(false);
  const mountedRef = useRef(true);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestClose = useCallback((): void => {
    if (submitting || confirmOpenRef.current) return;
    if (!dirty) {
      onClose();
      return;
    }

    confirmOpenRef.current = true;
    setDiscardConfirmOpen(true);
    void confirm(discardPrompt, {
      confirmLabel: discardLabel,
      tone: 'danger',
    }).then((discard) => {
      if (!mountedRef.current) return;
      confirmOpenRef.current = false;
      setDiscardConfirmOpen(false);
      if (discard) onClose();
    });
  }, [confirm, dirty, discardLabel, discardPrompt, onClose, submitting]);

  useFocusTrap(true, dialogRef, requestClose);
  return { requestClose, discardConfirmOpen };
}

// V-238 — Create-profile modal. Form has name (required, 1-120 chars),
// optional description (max 500 chars per server schema), and archetype
// picker (currently single-option; expands when V-136+ adds more).
// On submit: calls client.profiles.create(); closes + refreshes parent
// on success; surfaces server error inline on failure (e.g. tier-cap
// reached, duplicate name).
function CreateProfileModal({
  onClose,
  onCreated,
  existingFolders,
  initialFolder,
  initialTag,
}: {
  onClose: () => void;
  /** `proxyBindFailed` — an explicit proxy choice couldn't be saved (#142); the
   *  parent surfaces a non-blocking warning so the user re-binds before launch. */
  onCreated: (opts?: { proxyBindFailed?: boolean }) => void;
  /** Folder names for the Notes-tab picker (from the hub's organization map). */
  existingFolders: string[];
  /** Pre-selected folder — the one the user is currently viewing, so a profile
   *  created from inside a folder lands there. Empty = unfiled. */
  initialFolder?: string;
  /** Pre-filled tag — the tag the user is currently filtered to, so a profile
   *  created from inside a tag view carries it. Empty = no tag. */
  initialTag?: string;
}): JSX.Element {
  const { client, settings } = useSettings();
  const initialArchetype = KNOWN_ARCHETYPES[0]?.id ?? '';
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [archetype, setArchetype] = useState(initialArchetype);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Icon at create (founder 2026-06-16: "same for new Profile" — the icon
  // picker existed only for bulk-edit; offer it up-front too). Saved into
  // profilesMeta alongside folder/tags after create.
  const [icon, setIcon] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Inline "Add new proxy" mints a proxy BEFORE creating the profile. If the
  // create then fails (tier cap / dup name / network), the proxy was already
  // saved — and the catch lets the user retry, which would run addProxy AGAIN,
  // minting a SECOND identical proxy (the Proxies tab accumulates duplicates).
  // Cache the minted proxy id for THIS modal session so a retry REUSES it
  // instead of re-creating. Cleared when the proxy choice/draft changes. (audit)
  const mintedProxyIdRef = useRef<string | null>(null);
  // Same duplicate-on-retry hazard as the proxy mint above, one step later: if
  // client.profiles.create() SUCCEEDS but a follow-up step (saveProfileMeta /
  // setDefaultProxy) throws, the catch lets the user retry — which re-ran
  // profiles.create() and minted a SECOND (billed) profile. Cache the created
  // profile id for THIS modal session so a retry REUSES it instead of
  // re-creating; the follow-up steps are best-effort (see handleSubmit). (audit)
  const createdProfileIdRef = useRef<string | null>(null);
  // Configurator port (founder-approved profile-create demo, 2026-06-12):
  // tabbed layout + live identity-preview rail. Storage/Behavior tabs are
  // informational (their facts are real, their controls are future).
  const [tab, setTab] = useState<'identity' | 'proxy' | 'storage' | 'behavior' | 'notes'>(
    'identity',
  );
  // Organization metadata at create (backend columns, migration 0076).
  const [folder, setFolder] = useState(initialFolder ?? '');
  const [tags, setTags] = useState(initialTag ?? '');
  // 2026-05-20 — antidetect-style advanced panel. Proxy is selected
  // up-front + bound to the profile via profile-bindings on create.
  // 'create-new' opens an inline mini-form so the customer can mint a
  // proxy from inside this modal (no context-switch to the Proxies tab):
  // SOCKS5/HTTP host:port:user:pass, or paste/upload a .ovpn / wg0.conf
  // for OpenVPN / WireGuard.
  const [proxies, setProxies] = useState<LocalProxyConfig[]>([]);
  const [proxyChoice, setProxyChoice] = useState<string>('first-available');
  // Hydration can automatically switch an account with zero proxies to the
  // inline "create new" form. Record that hydrated value as the baseline so the
  // automatic switch does not falsely make a pristine form look dirty.
  const initialProxyChoiceRef = useRef<string | null>(null);
  const [newProxy, setNewProxy] = useState<{
    scheme: NonNullable<ProxyDraft['scheme']>;
    label: string;
    host: string;
    port: string;
    username: string;
    password: string;
    /** OpenVPN .ovpn / WireGuard wg0.conf paste — config_blob for the matching scheme. */
    configBlob: string;
  }>({
    scheme: 'socks5',
    label: '',
    host: '',
    port: '1080',
    username: '',
    password: '',
    configBlob: '',
  });
  const dirty =
    name !== '' ||
    description !== '' ||
    archetype !== initialArchetype ||
    icon !== '' ||
    folder !== (initialFolder ?? '') ||
    tags !== (initialTag ?? '') ||
    (initialProxyChoiceRef.current !== null && proxyChoice !== initialProxyChoiceRef.current) ||
    newProxy.scheme !== 'socks5' ||
    newProxy.label !== '' ||
    newProxy.host !== '' ||
    newProxy.port !== '1080' ||
    newProxy.username !== '' ||
    newProxy.password !== '' ||
    newProxy.configBlob !== '';
  const { requestClose, discardConfirmOpen } = useProfileDraftCloseGuard({
    dirty,
    submitting,
    dialogRef,
    onClose,
  });
  // VPN paste-parse feedback (✓ endpoint host:port, or the parse error).
  const [newProxyVpnHint, setNewProxyVpnHint] = useState<string | null>(null);
  // If the customer edits the proxy choice or the new-proxy draft, invalidate the
  // cached minted-proxy id so the NEXT attempt mints a fresh proxy for the new
  // inputs (rather than reusing the one minted for the old inputs).
  useEffect(() => {
    mintedProxyIdRef.current = null;
  }, [proxyChoice, newProxy]);
  // Invalidate the cached created-profile id when the identity-defining inputs
  // change — a different name/archetype is a genuinely different profile, so the
  // next submit should create it (not reuse the one already created for the old
  // inputs). A retry of the SAME inputs keeps the ref so it doesn't double-create.
  useEffect(() => {
    createdProfileIdRef.current = null;
  }, [name, archetype]);
  const newProxyIsVpn = newProxy.scheme === 'openvpn' || newProxy.scheme === 'wireguard';
  // The native "Test proxy" probe runs a SOCKS5 handshake, so it is only
  // meaningful for socks5 proxies. For an HTTP proxy it would always fail the
  // handshake → a valid HTTP proxy showed "Not reachable". Gate the Test button
  // to socks5 (VPN schemes already hide it via newProxyIsVpn).
  const newProxyCanTest = newProxy.scheme === 'socks5';
  // Native proxy probe (SOCKS5 reachability + UDP-associate detection).
  // Runs against the inline create-new draft so the customer can confirm
  // the proxy works — and whether UDP/QUIC/WebRTC will tunnel — before
  // minting the profile. Cleared whenever the draft host/port changes so
  // a stale "reachable" badge can't outlive its inputs.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  useEffect(() => {
    void (async () => {
      const list = await listProxies();
      setProxies(list);
      const initialChoice = list.length === 0 ? 'create-new' : 'first-available';
      initialProxyChoiceRef.current = initialChoice;
      if (list.length === 0) setProxyChoice(initialChoice);
    })();
  }, []);

  async function handleTestDraftProxy(): Promise<void> {
    const portNum = Number.parseInt(newProxy.port, 10);
    if (
      newProxy.host.trim().length === 0 ||
      Number.isNaN(portNum) ||
      portNum < 1 ||
      portNum > 65535
    ) {
      setTestResult({
        reachable: false,
        auth_ok: false,
        udp_associate: false,
        // A synthesised result is not evidence of routing. Fail closed: an
        // unknown proxy must never inherit a usable verdict by omission.
        can_route: false,
        connect_reply: 0xff,
        latency_ms: 0,
        message: 'Enter a host and a port between 1–65535 before testing.',
      });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProxy({
        host: newProxy.host.trim(),
        port: portNum,
        username: newProxy.username.trim().length > 0 ? newProxy.username.trim() : null,
        password: newProxy.password.length > 0 ? newProxy.password : null,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({
        reachable: false,
        auth_ok: false,
        udp_associate: false,
        // A synthesised result is not evidence of routing. Fail closed: an
        // unknown proxy must never inherit a usable verdict by omission.
        can_route: false,
        connect_reply: 0xff,
        latency_ms: 0,
        message: humanizeError(err, "Couldn't test this proxy. Check the details and try again."),
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!client) {
      setError('No client configured.');
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Name is required.');
      return;
    }
    // Pre-validate the name against the server's ProfileNameSchema so a bad name
    // (e.g. leading/trailing punctuation, an emoji) shows a SPECIFIC message
    // here instead of the opaque "Validation Failed" the server's 422 maps to.
    const nameProblem = validateProfileName(trimmed);
    if (nameProblem !== null) {
      setError(nameProblem);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // 1. Optionally mint a new proxy first (inline create flow keyed by
      //    proxyChoice === 'create-new'). SOCKS5/HTTP take host/port/user/pass
      //    fields; OpenVPN/WireGuard take the pasted .ovpn / wg0.conf and parse
      //    the endpoint out of it (host/port are the display endpoint).
      let resolvedProxyId: string | null = null;
      if (proxyChoice === 'create-new' && mintedProxyIdRef.current !== null) {
        // A prior attempt already minted this proxy; reuse it (don't re-create).
        resolvedProxyId = mintedProxyIdRef.current;
      } else if (proxyChoice === 'create-new') {
        const label = newProxy.label.trim();
        if (label.length === 0) {
          // Consistency #10 — the error renders in the always-visible preview
          // rail, but it names a field on the Proxy tab. Switch to that tab so
          // the founder can SEE the field the message is about (otherwise the
          // error reads as a dead-end when they're on the Identity tab).
          setTab('proxy');
          setError('Proxy label is required.');
          setSubmitting(false);
          return;
        }
        let draft: ProxyDraft;
        if (newProxy.scheme === 'wireguard') {
          const built = buildWireGuardProxyInput(label, parseWireGuardConfig(newProxy.configBlob));
          if ('error' in built) {
            setTab('proxy'); // #10 — reveal the WireGuard paste field
            setError(`WireGuard config: ${built.error}`);
            setSubmitting(false);
            return;
          }
          draft = {
            label,
            scheme: 'wireguard',
            host: built.host,
            port: built.port,
            username: null,
            password: null,
            wireguard: built.wireguard,
          };
        } else if (newProxy.scheme === 'openvpn') {
          const v = validateOpenVpnConfig(newProxy.configBlob);
          if (!v.ok) {
            setTab('proxy'); // #10 — reveal the OpenVPN paste field
            setError(`OpenVPN config: ${v.reason}`);
            setSubmitting(false);
            return;
          }
          const built = buildOpenVpnProxyInput(label, newProxy.configBlob, {
            host: v.remoteHost,
            port: v.remotePort,
          });
          if ('error' in built) {
            setTab('proxy'); // #10 — reveal the OpenVPN paste field
            setError(`OpenVPN config: ${built.error}`);
            setSubmitting(false);
            return;
          }
          draft = {
            label,
            scheme: 'openvpn',
            host: built.host,
            port: built.port,
            username: null,
            password: null,
            openvpn: built.openvpn,
          };
        } else {
          const portNum = Number.parseInt(newProxy.port, 10);
          if (
            newProxy.host.trim().length === 0 ||
            Number.isNaN(portNum) ||
            portNum < 1 ||
            portNum > 65535
          ) {
            setTab('proxy'); // #10 — reveal the host/port fields
            setError('Proxy host and a port between 1–65535 are all required.');
            setSubmitting(false);
            return;
          }
          draft = {
            label,
            scheme: newProxy.scheme,
            host: newProxy.host.trim(),
            port: portNum,
            username: newProxy.username.trim().length > 0 ? newProxy.username.trim() : null,
            password: newProxy.password.length > 0 ? newProxy.password : null,
          };
        }
        const created = await addProxy(draft);
        resolvedProxyId = created.id;
        // Remember it so a retry after a later failure reuses it, not re-mints.
        mintedProxyIdRef.current = created.id;
      } else if (proxyChoice !== 'first-available') {
        resolvedProxyId = proxyChoice;
      }
      // 2. Create the profile (organization metadata rides the create —
      //    backend columns since migration 0076; a pre-0076 server strips
      //    the unknown fields harmlessly).
      // Clamp to the server caps HERE too (the organize paths go through
      // cleanEntry; create previously didn't — a 25-char tag 400'd the
      // whole create).
      const tagList = tags
        .split(',')
        .map((t) => t.trim().slice(0, MAX_TAG_NAME_CHARS))
        .filter((t) => t.length > 0)
        .slice(0, 12);
      // Create the profile ONCE per modal session: if a prior attempt already
      // created it (and only a follow-up step failed), reuse that id on retry so
      // we don't mint a SECOND billed profile. createdProfileIdRef is cleared
      // when name/archetype change (a genuinely different profile).
      let profileId = createdProfileIdRef.current;
      if (profileId === null) {
        const profile = await client.profiles.create({
          name: trimmed,
          archetype,
          ...(description.trim().length > 0 ? { description: description.trim() } : {}),
          ...(folder.trim().length > 0
            ? { folder: folder.trim().slice(0, MAX_FOLDER_NAME_CHARS) }
            : {}),
          ...(tagList.length > 0 ? { tags: [...new Set(tagList)] } : {}),
          // Per-account sync — send the chosen icon so it follows the account.
          ...(icon.length > 0 ? { icon } : {}),
        });
        profileId = profile.id;
        createdProfileIdRef.current = profile.id;
      }
      // 2b/3. Follow-up steps are BEST-EFFORT: a failure here must NOT force a
      // re-create of the (already-billed) profile on retry. The profile exists;
      // these only enrich it (local org-cache mirror) or set its default proxy,
      // both of which the customer can fix from the profile row afterward.
      // Mirror into the local organization cache so the hub shows the
      // folder/tags immediately (and offline).
      if (folder.trim().length > 0 || tagList.length > 0 || icon.length > 0) {
        await saveProfileMeta(profileId, { folder: folder.trim(), tags: tagList, icon }).catch(
          (err: unknown) => {
            console.warn('[profiles] saveProfileMeta failed (profile created):', err);
          },
        );
      }
      // Bind the chosen proxy to the new profile. null = use the first-available
      // proxy at Launch time. BEST-EFFORT by design (the profile is already created +
      // billed; a bind failure must NOT force a re-create) — the create still completes.
      // But (founder-hit sweep #3/#142) an EXPLICIT proxy choice that silently fails to
      // persist means launch falls back to proxies[0] — a DIFFERENT proxy than picked —
      // so flag it and let the PARENT surface a NON-blocking warning after the modal
      // closes (keeps the best-effort contract; the customer re-binds from the row).
      let explicitProxyBindFailed = false;
      await setDefaultProxy(profileId, resolvedProxyId).catch((err: unknown) => {
        console.warn('[profiles] setDefaultProxy failed (profile created):', err);
        if (resolvedProxyId !== null) explicitProxyBindFailed = true;
      });
      onCreated(explicitProxyBindFailed ? { proxyBindFailed: true } : undefined);
    } catch (err) {
      setError(friendlyError(err, settings.baseUrl));
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-profile-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-md border border-surface-divider bg-surface-raised p-5 shadow-lg">
        <header className="mb-3 flex items-center justify-between">
          <h3 id="create-profile-title" className="text-base font-medium text-ink-primary">
            New profile
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={requestClose}
              disabled={submitting || discardConfirmOpen}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        {/* Configurator tabs (demo port). role=tablist keyboardable via the buttons. */}
        <div
          role="tablist"
          aria-label="Profile configuration"
          className="mb-3 flex gap-1 border-b border-surface-divider"
        >
          {(
            [
              ['identity', '📱 Identity'],
              ['proxy', '🌍 Proxy'],
              ['storage', '🍪 Storage'],
              ['behavior', '🖐 Behavior'],
              ['notes', '🏷 Notes & tags'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`-mb-px rounded-t border-b-2 px-3 py-1.5 text-xs ${
                tab === id
                  ? 'border-accent font-medium text-ink-primary'
                  : 'border-transparent text-ink-muted hover:text-ink-secondary'
              }`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex min-h-0 flex-1 gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            {tab === 'identity' && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="section-label">Name</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    minLength={1}
                    required
                    autoFocus
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                    placeholder="my-recurring-workflow"
                  />
                  <span className="text-xs text-ink-muted">
                    Used to identify the profile in lists + when attaching sessions.
                  </span>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="section-label">Icon (optional)</span>
                  <select
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                    aria-label="Profile icon"
                  >
                    <option value="">— No icon —</option>
                    {PROFILE_ICONS.map((i) => (
                      <option key={i.emoji} value={i.emoji}>
                        {i.emoji} {i.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-ink-muted">
                    A quick visual marker shown on the profile card + list.
                  </span>
                </label>

                <div className="flex flex-col gap-2">
                  <div>
                    <h4 className="text-sm font-medium text-ink-primary">Device &amp; identity</h4>
                    <p className="mt-0.5 text-2xs text-ink-muted">
                      A bit-exact mobile fingerprint, not a spoofed user-agent — pick the device;
                      everything stays coherent with it. Search or filter to find one of{' '}
                      {PICKER_DEVICES.length} devices.
                    </p>
                  </div>
                  {/* Redesigned device picker (2026-06-25): searchable, chip-
                      filtered, family-grouped list with a selected-device hero.
                      Selection state stays owned here (archetype/setArchetype),
                      and `selectable` is the SAME SELECTABLE_STATUSES gate — so
                      reference rows render but never become the selection. */}
                  <DevicePicker
                    devices={PICKER_DEVICES}
                    selectedId={archetype}
                    onSelect={setArchetype}
                    onRandomize={(candidates) => {
                      if (candidates.length === 0) return;
                      const pick = candidates[Math.floor(Math.random() * candidates.length)];
                      if (pick) setArchetype(pick.id);
                    }}
                    disabled={submitting}
                  />
                </div>

                <div className="flex flex-col gap-1 rounded border border-surface-divider bg-surface-base/40 p-3">
                  <h4 className="text-sm font-medium text-ink-primary">Locale &amp; timezone</h4>
                  <p className="text-xs text-ink-secondary">
                    Auto-follows the proxy exit geo at session time — language, locale and timezone
                    never contradict the IP. No overrides: coherence is the point.
                  </p>
                </div>
              </>
            )}

            {tab === 'proxy' && (
              <div className="flex flex-col gap-1 rounded border border-surface-divider bg-surface-base/40 p-3">
                <span className="section-label">Proxy</span>
                <select
                  value={proxyChoice}
                  onChange={(e) => setProxyChoice(e.target.value)}
                  disabled={submitting}
                  className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                >
                  {proxies.length > 0 && (
                    <option value="first-available">First available saved proxy</option>
                  )}
                  {proxies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ·{' '}
                      {p.scheme === 'openvpn' || p.scheme === 'wireguard'
                        ? `${p.scheme} · ${p.host}:${p.port}`
                        : `${p.host}:${p.port}`}
                    </option>
                  ))}
                  <option value="create-new">+ Add new proxy…</option>
                </select>
                {proxyChoice === 'create-new' && (
                  <div className="mt-2 flex flex-col gap-1.5 rounded-sm border border-dashed border-surface-divider bg-surface-base/60 p-2">
                    <select
                      aria-label="Proxy type"
                      value={newProxy.scheme}
                      onChange={(e) => {
                        // Switch scheme — clear the now-irrelevant fields so a
                        // half-typed socks5 password can't ride along on a VPN
                        // proxy (and vice versa) + drop the stale test result.
                        const scheme = e.target.value as NonNullable<ProxyDraft['scheme']>;
                        setNewProxy((p) => ({
                          ...p,
                          scheme,
                          configBlob: '',
                          ...(scheme === 'openvpn' || scheme === 'wireguard'
                            ? { username: '', password: '' }
                            : {}),
                        }));
                        setNewProxyVpnHint(null);
                        setTestResult(null);
                      }}
                      disabled={submitting}
                      className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                    >
                      <option value="socks5">SOCKS5</option>
                      <option value="http">HTTP</option>
                      <option value="openvpn">OpenVPN</option>
                      <option value="wireguard">WireGuard</option>
                    </select>
                    <input
                      type="text"
                      value={newProxy.label}
                      onChange={(e) => setNewProxy((p) => ({ ...p, label: e.target.value }))}
                      placeholder="Label (e.g. shopify-us-east)"
                      disabled={submitting}
                      className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                    />
                    {!newProxyIsVpn && (
                      <div className="grid grid-cols-2 gap-1.5">
                        <input
                          type="text"
                          value={newProxy.host}
                          onChange={(e) => {
                            setNewProxy((p) => ({ ...p, host: e.target.value }));
                            setTestResult(null);
                          }}
                          placeholder="Host (e.g. proxy.example.com)"
                          disabled={submitting}
                          className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                        />
                        <input
                          type="number"
                          min={1}
                          max={65535}
                          value={newProxy.port}
                          onChange={(e) => {
                            setNewProxy((p) => ({ ...p, port: e.target.value }));
                            setTestResult(null);
                          }}
                          placeholder="Port"
                          disabled={submitting}
                          className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                        />
                        <input
                          type="text"
                          value={newProxy.username}
                          onChange={(e) => {
                            setNewProxy((p) => ({ ...p, username: e.target.value }));
                            setTestResult(null);
                          }}
                          placeholder="Username (optional)"
                          disabled={submitting}
                          className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                        />
                        <input
                          type="password"
                          value={newProxy.password}
                          onChange={(e) => {
                            setNewProxy((p) => ({ ...p, password: e.target.value }));
                            setTestResult(null);
                          }}
                          placeholder="Password (optional)"
                          disabled={submitting}
                          className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                        />
                      </div>
                    )}
                    {newProxyIsVpn && (
                      <div className="flex flex-col gap-1">
                        <textarea
                          value={newProxy.configBlob}
                          onChange={(e) => {
                            const text = e.target.value;
                            // Parse the paste so the customer sees the extracted
                            // endpoint (or the error) before they hit Create.
                            let hint: string | null = null;
                            if (text.trim() === '') {
                              hint = null;
                            } else if (newProxy.scheme === 'wireguard') {
                              const built = buildWireGuardProxyInput(
                                newProxy.label.trim(),
                                parseWireGuardConfig(text),
                              );
                              hint =
                                'error' in built
                                  ? built.error
                                  : `✓ endpoint ${built.host}:${built.port.toString()}`;
                            } else {
                              const v = validateOpenVpnConfig(text);
                              hint = v.ok
                                ? `✓ remote ${v.remoteHost}:${v.remotePort.toString()}`
                                : v.reason;
                            }
                            setNewProxy((p) => ({ ...p, configBlob: text }));
                            setNewProxyVpnHint(hint);
                          }}
                          placeholder={
                            newProxy.scheme === 'wireguard'
                              ? '[Interface]\nPrivateKey = …\n[Peer]\nPublicKey = …\nEndpoint = host:port'
                              : 'client\nremote vpn.example.com 1194 udp\ndev tun\n…'
                          }
                          disabled={submitting}
                          autoComplete="off"
                          spellCheck={false}
                          className="mono min-h-[120px] rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary"
                        />
                        <label className="inline-flex cursor-pointer items-center gap-1 text-2xs text-accent hover:underline">
                          <span aria-hidden>⤓</span> or upload your{' '}
                          {newProxy.scheme === 'wireguard' ? 'wg0.conf' : '.ovpn'} file
                          <input
                            type="file"
                            accept={
                              newProxy.scheme === 'wireguard'
                                ? '.conf,.txt,text/plain'
                                : '.ovpn,.conf,.txt,text/plain'
                            }
                            className="sr-only"
                            disabled={submitting}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = '';
                              if (!file) return;
                              const reader = new FileReader();
                              reader.onload = () => {
                                if (typeof reader.result !== 'string') return;
                                const text = reader.result;
                                let hint: string | null = null;
                                if (newProxy.scheme === 'wireguard') {
                                  const built = buildWireGuardProxyInput(
                                    newProxy.label.trim(),
                                    parseWireGuardConfig(text),
                                  );
                                  hint =
                                    'error' in built
                                      ? built.error
                                      : `✓ endpoint ${built.host}:${built.port.toString()}`;
                                } else {
                                  const v = validateOpenVpnConfig(text);
                                  hint = v.ok
                                    ? `✓ remote ${v.remoteHost}:${v.remotePort.toString()}`
                                    : v.reason;
                                }
                                setNewProxy((p) => ({ ...p, configBlob: text }));
                                setNewProxyVpnHint(hint);
                              };
                              reader.onerror = () =>
                                setNewProxyVpnHint('Could not read that file.');
                              reader.readAsText(file);
                            }}
                          />
                        </label>
                        {newProxyVpnHint !== null && (
                          <span className="text-2xs text-ink-muted">{newProxyVpnHint}</span>
                        )}
                      </div>
                    )}
                    {newProxyCanTest && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void handleTestDraftProxy()}
                          disabled={submitting || testing || newProxy.host.trim().length === 0}
                          className="btn-secondary text-xs"
                        >
                          {testing ? 'Testing…' : 'Test proxy'}
                        </button>
                        <span className="text-2xs text-ink-muted">
                          Runs a SOCKS5 handshake from this Mac — checks reachability, auth, and UDP
                          support.
                        </span>
                      </div>
                    )}
                    {newProxyCanTest && testResult !== null && (
                      <div
                        role="status"
                        className={`flex flex-col gap-1 rounded-sm border px-2 py-1.5 text-2xs ${
                          isProxyUsable(testResult)
                            ? 'border-status-success/40 bg-status-success/10 text-status-success'
                            : 'border-status-error/40 bg-status-error/10 text-status-error'
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          {/* One shared verdict for the label AND the colour.
                              This ladder used to stop at auth_ok while the
                              colour above already came from isProxyUsable, so a
                              proxy that authenticates but cannot route rendered
                              RED and read "Reachable · 12 ms". */}
                          <span className="font-medium">{proxyVerdict(testResult).label}</span>
                          {testResult.reachable && (
                            <ProxyCapabilityChips result={testResult} size="sm" />
                          )}
                        </div>
                        <span className="text-ink-secondary">{testResult.message}</span>
                      </div>
                    )}
                    <span className="text-2xs text-ink-muted">
                      Protected locally in this app · synced encrypted to your account when used for
                      a session.
                    </span>
                  </div>
                )}
                <span className="text-xs text-ink-muted">
                  Sessions launched from this profile route through the selected proxy. Manage all
                  saved proxies under the Proxies tab.
                </span>
              </div>
            )}

            {tab === 'storage' && (
              <div className="flex flex-col gap-2 rounded border border-surface-divider bg-surface-base/40 p-3">
                <h4 className="text-sm font-medium text-ink-primary">Persistent browser state</h4>
                <p className="text-xs text-ink-secondary">
                  Cookies, localStorage and IndexedDB persist across this profile's sessions — log
                  in once, stay logged in. State is sealed with per-profile encryption under your
                  account's own key hierarchy; staff can't read it.
                </p>
                <p className="text-2xs text-ink-muted">
                  Always on for profile-backed sessions — nothing to configure here yet.
                </p>
              </div>
            )}

            {tab === 'behavior' && (
              <div className="flex flex-col gap-2 rounded border border-surface-divider bg-surface-base/40 p-3">
                <h4 className="text-sm font-medium text-ink-primary">Human-cadence input</h4>
                <p className="text-xs text-ink-secondary">
                  Taps, scrolls and typing run through the behavioral simulation layer — native
                  events with human timing, not synthetic JavaScript. On by default for every
                  session this profile launches.
                </p>
                <p className="text-2xs text-ink-muted">
                  Per-session behavioral profiles are selectable via the API/SDK (behavioral_profile
                  on session create); a per-profile default lands here when the backend grows that
                  column.
                </p>
              </div>
            )}

            {tab === 'notes' && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="section-label">Description (optional)</span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={500}
                    rows={2}
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                    placeholder="What this identity slot is for"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="section-label">Folder (optional)</span>
                  <FolderPicker
                    ariaLabel="Profile folder"
                    noneLabel="No folder"
                    folders={existingFolders}
                    value={folder}
                    onChange={setFolder}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="section-label">Tags (optional, comma-separated)</span>
                  <input
                    type="text"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    disabled={submitting}
                    className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                    placeholder="retail, warmup"
                  />
                  <span className="text-2xs text-ink-muted">
                    Up to 12 tags, 24 characters each — synced to your account and shown across
                    devices.
                  </span>
                </label>
              </>
            )}
          </div>

          {/* Live identity-preview rail (demo port — verified facts only). */}
          <aside
            data-component="identity-preview-rail"
            className="flex w-60 shrink-0 flex-col gap-2 self-start rounded-md border border-surface-divider bg-surface-base/40 p-3"
          >
            <span className="section-label">Live identity preview</span>
            <p className="truncate text-sm font-medium text-ink-primary">
              {name.trim().length > 0 ? name.trim() : 'unnamed profile'}
            </p>
            {/* Identity panel (demo's coherence ring, honest version): the
                ring renders the VERIFIED state of the selected archetype —
                launch archetypes are device-verified bit-exact; no invented
                numeric score. */}
            <div className="flex items-center gap-2.5 rounded border border-surface-divider bg-surface-base/60 p-2">
              <div
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-status-ready text-status-ready"
              >
                ✓
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink-primary">Identity coherence</p>
                <p className="text-2xs text-ink-muted">bit-exact archetype · engine-deep</p>
              </div>
            </div>
            {(() => {
              const a = ARCHETYPE_REGISTRY.find((x) => x.id === archetype);
              return (
                <dl className="flex flex-col">
                  <PreviewRow k="Device" v={a?.device ?? '—'} />
                  <PreviewRow
                    k="iOS / Safari"
                    v={a ? `${a.iosVersion} / ${a.safariVersion}` : '—'}
                  />
                  <PreviewRow k="Locale" v="follows proxy exit" />
                  <PreviewRow
                    k="Proxy"
                    v={
                      proxyChoice === 'create-new'
                        ? newProxy.label.trim() || 'new SOCKS5'
                        : proxyChoice === 'first-available'
                          ? 'first available'
                          : (proxies.find((p) => p.id === proxyChoice)?.label ?? '—')
                    }
                  />
                  <PreviewRow k="Storage" v="🔒 sealed" />
                  <PreviewRow k="Tags" v={tags.trim().length > 0 ? tags.trim() : '—'} />
                </dl>
              );
            })()}
            <p className="rounded-sm border border-surface-divider bg-surface-base/60 p-2 text-2xs text-ink-muted">
              <b className="text-ink-secondary">What a site sees:</b> a genuine iPhone — Apple's
              engine with a bit-exact device identity, not a spoofed user-agent.
            </p>

            {error !== null && (
              <p className="text-xs text-status-error" role="alert">
                {error}
              </p>
            )}

            <div className="mt-1 flex flex-col gap-1.5">
              <button
                type="submit"
                className="btn-primary"
                disabled={submitting || name.trim().length === 0}
              >
                {submitting ? 'Creating…' : 'Create profile'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={requestClose}
                disabled={submitting || discardConfirmOpen}
              >
                Cancel
              </button>
            </div>
          </aside>
        </form>
      </div>
    </div>
  );
}

// Folder picker (founder UX fix, night arc): SELECT existing folders
// instead of retyping names — '__new__' reveals a free-text input;
// '' = no change (bulk) / unfiled (organize). Controlled entirely by
// the caller through value/onChange.
function FolderPicker({
  value,
  onChange,
  folders,
  ariaLabel,
  noneLabel,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  folders: string[];
  ariaLabel: string;
  noneLabel: string;
  disabled?: boolean;
}): JSX.Element {
  const isCustom = value.length > 0 && !folders.includes(value);
  const [mode, setMode] = useState<'pick' | 'new'>(isCustom ? 'new' : 'pick');
  // External clears (bulk apply resets value to '') drop back to the
  // select — otherwise the picker strands on an empty 'new' input.
  useEffect(() => {
    if (value === '' && mode === 'new') setMode('pick');
    // NOTE: deliberately depends on `value` only — `mode` is the state
    // this effect manages; depending on it would re-close user-opened
    // 'new' inputs (this workspace doesn't enable react-hooks lint rules,
    // so no disable directive is needed or valid here).
  }, [value]);
  return (
    <span className="inline-flex items-center gap-1">
      {mode === 'pick' ? (
        <select
          aria-label={ariaLabel}
          className="w-36 rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary"
          value={folders.includes(value) ? value : ''}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === '__new__') {
              setMode('new');
              onChange('');
            } else {
              onChange(e.target.value);
            }
          }}
        >
          <option value="">{noneLabel}</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              📁 {f}
            </option>
          ))}
          <option value="__new__">＋ New folder…</option>
        </select>
      ) : (
        <>
          <input
            aria-label={`${ariaLabel} (new)`}
            placeholder="New folder name"
            autoFocus
            maxLength={MAX_FOLDER_NAME_CHARS}
            className="w-32 rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
          />
          <button
            type="button"
            aria-label="Back to folder list"
            className="text-xs text-ink-muted hover:text-ink-primary"
            disabled={disabled}
            onClick={() => {
              setMode('pick');
              onChange('');
            }}
          >
            ↩
          </button>
        </>
      )}
    </span>
  );
}

// Edit-profile modal — mirrors the Create modal's identity/notes fields but for
// an EXISTING profile. Seeds name/description from the Profile + icon/folder/
// tags/note from the local meta. On submit it builds a partial diff (only the
// changed fields) and PATCHes via client.profiles.update; archetype is immutable
// post-create so it's shown read-only and never sent. Returns the saved
// organization metadata to the parent so it can mirror it into the local cache.
function EditProfileModal({
  profile,
  meta,
  existingFolders,
  proxies,
  currentProxyId,
  onClose,
  onSaved,
}: {
  profile: Profile;
  /** Local organization metadata for this profile (icon/folder/tags/note). */
  meta: ProfileMeta | undefined;
  existingFolders: string[];
  /** Saved proxies, mirrors the create modal's proxy select (2026-06-19). */
  proxies: LocalProxyConfig[];
  /** The profile's explicitly-bound proxy id (null = "First available"). */
  currentProxyId: string | null;
  onClose: () => void;
  /** Called with the (cleaned) organization metadata after a successful PATCH. */
  onSaved: (meta: Partial<ProfileMeta>) => void;
}): JSX.Element {
  const { client, settings } = useSettings();
  // Freeze the edit baseline when the modal opens. Profiles metadata and proxy
  // bindings refresh behind the modal; comparing the draft to live props would
  // make a pristine form suddenly look dirty (or change what a Save diff means)
  // when one of those background reads settles.
  const baselineRef = useRef({
    name: profile.name,
    description: profile.description ?? '',
    icon: meta?.icon ?? '',
    folder: meta?.folder ?? '',
    tags: [...(meta?.tags ?? [])],
    note: meta?.note ?? '',
    proxyId: currentProxyId,
    proxyChoice: currentProxyId ?? 'first-available',
    geoLat: meta?.geolocation ? String(meta.geolocation.latitude) : '',
    geoLon: meta?.geolocation ? String(meta.geolocation.longitude) : '',
    geoAccuracy: meta?.geolocation?.accuracy !== undefined ? String(meta.geolocation.accuracy) : '',
  });
  const baseline = baselineRef.current;
  const initialTags = baseline.tags.join(', ');
  const [name, setName] = useState(baseline.name);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [description, setDescription] = useState(baseline.description);
  const [icon, setIcon] = useState(baseline.icon);
  const [folder, setFolder] = useState(baseline.folder);
  const [tags, setTags] = useState(initialTags);
  const [note, setNote] = useState(baseline.note);
  // 2026-06-19 (founder GUI-improvement audit) — post-create proxy REBIND.
  // setDefaultProxy was only ever called from the create modal; a profile's
  // proxy binding couldn't be changed afterward. The select mirrors the create
  // modal's saved-proxy picker ('first-available' = null binding); on save we
  // setDefaultProxy when it changed, and the parent's refresh(false) reloads
  // bindings so pickProxy re-renders the card/table with the rebound proxy.
  const [proxyChoice, setProxyChoice] = useState<string>(baseline.proxyChoice);
  // Advanced geolocation override (A3-approved per-session contract 2026-07-01).
  // Held as strings so a partially-typed value doesn't fight a numeric input;
  // parsed + range-validated on submit. Empty lat AND lon = "no override" (clear
  // → the device auto-derives its location from the proxy exit IP, the default).
  const [geoLat, setGeoLat] = useState(baseline.geoLat);
  const [geoLon, setGeoLon] = useState(baseline.geoLon);
  const [geoAccuracy, setGeoAccuracy] = useState(baseline.geoAccuracy);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty =
    name !== baseline.name ||
    description !== baseline.description ||
    icon !== baseline.icon ||
    folder !== baseline.folder ||
    tags !== initialTags ||
    note !== baseline.note ||
    proxyChoice !== baseline.proxyChoice ||
    geoLat !== baseline.geoLat ||
    geoLon !== baseline.geoLon ||
    geoAccuracy !== baseline.geoAccuracy;
  const { requestClose, discardConfirmOpen } = useProfileDraftCloseGuard({
    dirty,
    submitting,
    dialogRef,
    onClose,
  });

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!client || submitting) return;
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError('Name is required.');
      return;
    }
    setError(null);
    setSubmitting(true);
    // Build a minimal PATCH diff — only the fields that actually changed (mirror
    // the create-form clamping for tags/folder so an over-long entry doesn't 400).
    const tagList = [
      ...new Set(
        tags
          .split(',')
          .map((t) => t.trim().slice(0, MAX_TAG_NAME_CHARS))
          .filter((t) => t.length > 0)
          .slice(0, 12),
      ),
    ];
    const nextFolder = folder.trim().slice(0, MAX_FOLDER_NAME_CHARS);
    const nextNote = note.trim().slice(0, 280);
    const nextDescription = description.trim();
    // Parse the advanced geolocation override. Both lat AND lon blank = clear
    // (no override → the device auto-derives location from the proxy exit IP).
    // Otherwise BOTH are required + must be in range; accuracy is optional but,
    // when given, must be a positive number. A partial/invalid entry aborts the
    // save with a message rather than silently dropping to the auto-derive
    // default (which would look like the override "didn't take").
    const latStr = geoLat.trim();
    const lonStr = geoLon.trim();
    const accStr = geoAccuracy.trim();
    let nextGeolocation: { latitude: number; longitude: number; accuracy?: number } | undefined;
    if (latStr.length > 0 || lonStr.length > 0) {
      const lat = Number(latStr);
      const lon = Number(lonStr);
      if (
        latStr.length === 0 ||
        lonStr.length === 0 ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      ) {
        setError('Location override needs a latitude (-90 to 90) and longitude (-180 to 180).');
        setSubmitting(false);
        return;
      }
      nextGeolocation = { latitude: lat, longitude: lon };
      if (accStr.length > 0) {
        const acc = Number(accStr);
        if (!Number.isFinite(acc) || acc <= 0) {
          setError('Location accuracy must be a positive number of meters (or leave it blank).');
          setSubmitting(false);
          return;
        }
        nextGeolocation.accuracy = acc;
      }
    }
    const diff: UpdateProfileRequest = {};
    if (trimmedName !== baseline.name) diff.name = trimmedName;
    if (nextDescription !== baseline.description) {
      diff.description = nextDescription.length > 0 ? nextDescription : null;
    }
    if (nextFolder !== baseline.folder) diff.folder = nextFolder.length > 0 ? nextFolder : null;
    const prevTags = baseline.tags;
    const tagsChanged =
      tagList.length !== prevTags.length || tagList.some((t, i) => t !== prevTags[i]);
    if (tagsChanged) diff.tags = tagList;
    if (icon !== baseline.icon) diff.icon = icon.length > 0 ? icon : null;
    if (nextNote !== baseline.note) diff.note = nextNote.length > 0 ? nextNote : null;
    try {
      // Skip the round-trip when nothing changed — still mirror meta so the
      // local cache stays the source of truth for the hub render.
      if (Object.keys(diff).length > 0) {
        await client.profiles.update(profile.id, diff);
      }
      // Rebind the proxy when it changed ('first-available' = null binding).
      // BEST-EFFORT: this is a local Tauri store write and the org-metadata
      // edit has ALREADY been accepted server-side above. If setDefaultProxy
      // threw, the unguarded await used to jump to the catch — onSaved (which
      // mirrors the just-saved folder/tags/icon/note into the local cache) was
      // then never called, so the server had the new values but the hub kept
      // rendering the OLD ones (local-wins seed-down never re-seeds a profile
      // that already has a local entry), making the edit look silently
      // reverted. Swallow a rebind-write failure so the org-metadata mirror
      // below always runs; the proxy binding is independently recoverable from
      // the row. (audit)
      const nextProxyId = proxyChoice === 'first-available' ? null : proxyChoice;
      if (nextProxyId !== baseline.proxyId) {
        await setDefaultProxy(profile.id, nextProxyId).catch((err: unknown) => {
          console.warn('[profiles] setDefaultProxy failed (profile updated):', err);
        });
      }
      // geolocation is client-side org metadata only (no server profile column),
      // so it rides onSaved → saveProfileMeta, never the PATCH diff. Passing
      // `undefined` when both fields are blank CLEARS a prior override (back to
      // the proxy-exit auto-derive default) via cleanEntry's absence handling.
      onSaved({
        icon,
        folder: nextFolder,
        tags: tagList,
        note: nextNote,
        geolocation: nextGeolocation,
      });
    } catch (err) {
      setError(friendlyError(err, settings.baseUrl));
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-profile-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-md border border-surface-divider bg-surface-raised p-5 shadow-lg"
      >
        <header className="flex items-center justify-between">
          <h3 id="edit-profile-title" className="text-base font-medium text-ink-primary">
            Edit profile
          </h3>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={requestClose}
            disabled={submitting || discardConfirmOpen}
            aria-label="Close"
          >
            Close
          </button>
        </header>
        {error !== null && (
          <p className="rounded-sm border border-status-error/40 bg-status-error/10 px-2 py-1 text-xs text-status-error">
            {error}
          </p>
        )}
        <label className="flex flex-col gap-1">
          <span className="section-label">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            minLength={1}
            required
            autoFocus
            disabled={submitting}
            className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="section-label">Device (locked)</span>
          <input
            type="text"
            value={formatDeviceName(profile.archetype)}
            readOnly
            disabled
            className="rounded-sm border border-surface-divider bg-surface-base/40 px-2 py-1 text-sm text-ink-muted"
          />
          <span className="text-2xs text-ink-muted">
            The device fingerprint is fixed when a profile is created and can’t be changed.
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="section-label">Icon (optional)</span>
          <select
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            disabled={submitting}
            className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
            aria-label="Profile icon"
          >
            <option value="">— No icon —</option>
            {PROFILE_ICONS.map((i) => (
              <option key={i.emoji} value={i.emoji}>
                {i.emoji} {i.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="section-label">Description (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={2}
            disabled={submitting}
            className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="section-label">Folder (optional)</span>
          <FolderPicker
            ariaLabel="Profile folder"
            noneLabel="No folder"
            folders={existingFolders}
            value={folder}
            onChange={setFolder}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="section-label">Tags (optional, comma-separated)</span>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            disabled={submitting}
            className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
            placeholder="retail, warmup"
          />
        </label>
        {/* Proxy rebind (2026-06-19) — change the bound proxy after creation;
            mirrors the create modal's saved-proxy picker. 'first-available' =
            no fixed binding (the first saved proxy is used at launch). */}
        <label className="flex flex-col gap-1">
          <span className="section-label">Proxy</span>
          <select
            aria-label="Profile proxy"
            value={proxyChoice}
            onChange={(e) => setProxyChoice(e.target.value)}
            disabled={submitting}
            className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
          >
            <option value="first-available">First available saved proxy</option>
            {proxies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ·{' '}
                {p.scheme === 'openvpn' || p.scheme === 'wireguard'
                  ? `${p.scheme} · ${p.host}:${p.port}`
                  : `${p.host}:${p.port}`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="section-label">Note (optional)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={280}
            rows={2}
            disabled={submitting}
            className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
          />
        </label>
        {/* Advanced — explicit location override (A3-approved per-session
            geolocation contract). Collapsed by default (<details>) because the
            RIGHT choice for almost everyone is to leave it blank: the device's
            reported location then derives from the proxy's exit IP, so it stays
            coherent with where the session appears to connect from. */}
        <details className="rounded-sm border border-surface-divider bg-surface-base/40 px-2 py-1.5">
          <summary className="cursor-pointer select-none text-xs font-medium text-ink-secondary">
            Advanced — location override
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-[11px] leading-snug text-ink-muted">
              Leave blank (recommended): the device reports a location derived from your proxy's
              exit IP, so it matches where the session appears to connect from. Set coordinates only
              if you know your proxy's real location — a location that doesn't match the proxy's
              country is an inconsistency sites can detect.
            </p>
            <div className="flex gap-2">
              <label className="flex flex-1 flex-col gap-1">
                <span className="section-label">Latitude</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={-90}
                  max={90}
                  value={geoLat}
                  onChange={(e) => setGeoLat(e.target.value)}
                  placeholder="48.8566"
                  disabled={submitting}
                  className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="section-label">Longitude</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={-180}
                  max={180}
                  value={geoLon}
                  onChange={(e) => setGeoLon(e.target.value)}
                  placeholder="2.3522"
                  disabled={submitting}
                  className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                />
              </label>
              <label className="flex w-24 flex-col gap-1">
                <span className="section-label">Accuracy&nbsp;(m)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={0}
                  value={geoAccuracy}
                  onChange={(e) => setGeoAccuracy(e.target.value)}
                  placeholder="auto"
                  disabled={submitting}
                  className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                />
              </label>
            </div>
          </div>
        </details>
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={requestClose}
            disabled={submitting || discardConfirmOpen}
          >
            Cancel
          </button>
          <button type="submit" className="btn-primary text-xs" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Import-profile modal (V-480) — drop or paste an exported JSON file (a single
// envelope object OR a bulk array) and optionally rename a single import. The
// actual parse + import loop lives in ProfilesView.handleImport so it can drive
// the cap refresh + success notice; this modal just collects the text.
function ImportProfileModal({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (text: string, nameOverride: string) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [nameOverride, setNameOverride] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const { requestClose, discardConfirmOpen } = useProfileDraftCloseGuard({
    dirty: text.trim().length > 0 || nameOverride.trim().length > 0,
    submitting: false,
    dialogRef,
    onClose,
    discardPrompt: 'Discard this profile import draft?',
    discardLabel: 'Discard import',
  });

  function readFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === 'string' ? reader.result : '');
      setFileName(file.name);
    };
    reader.readAsText(file);
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-profile-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-md border border-surface-divider bg-surface-raised p-5 shadow-lg">
        <header className="flex items-center justify-between">
          <h3 id="import-profile-title" className="text-base font-medium text-ink-primary">
            Import profiles
          </h3>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={requestClose}
            disabled={discardConfirmOpen}
            aria-label="Close"
          >
            Close
          </button>
        </header>
        <p className="text-xs text-ink-secondary">
          Drop or paste a profile JSON file exported from Driftstack. A single export or a bulk
          array of exports are both supported.
        </p>
        <label
          className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed px-3 py-6 text-center text-xs transition-colors ${
            dragOver
              ? 'border-accent bg-accent-subtle text-ink-primary'
              : 'border-surface-divider text-ink-muted hover:border-accent'
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) readFile(file);
          }}
        >
          <span aria-hidden="true" className="text-lg">
            ⤒
          </span>
          <span>
            {fileName !== null
              ? `Loaded ${fileName}`
              : 'Drop a .json file here, or click to choose'}
          </span>
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) readFile(file);
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="section-label">Or paste JSON</span>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFileName(null);
            }}
            rows={5}
            className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 font-mono text-xs text-ink-primary"
            placeholder='{ "version": 1, "profile": { … } }'
            aria-label="Profile JSON"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="section-label">Rename on import (optional)</span>
          <input
            type="text"
            value={nameOverride}
            onChange={(e) => setNameOverride(e.target.value)}
            maxLength={120}
            className="rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
            placeholder="Leave blank to keep the exported name"
          />
          <span className="text-2xs text-ink-muted">
            Applies only when importing a single profile.
          </span>
        </label>
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={requestClose}
            disabled={discardConfirmOpen}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary text-xs"
            disabled={text.trim().length === 0}
            onClick={() => onImport(text, nameOverride)}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

// G2 (5→10, 2026-06-14) — profile IDENTITY card for the grid thumbnail.
// Replaces the old `MiniPage` faux-webpage placeholder, which the founder read
// as "random images of a browser". We have no real screenshots yet (driver is
// mock), so instead of inventing a fake page we render a clean, deterministic
// IDENTITY: a monogram on a per-profile accent-hued wash + the device label.
// Future-proof: pass `screenshotUrl` once the driver captures a real last-frame
// and it takes over from the identity fallback.
export function profileMonogram(name: string): string {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase() || '?';
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
}

// Deterministic 0..359 hue from the name so each card reads distinctly and
// stably (no flicker across renders).
export function identityHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

// (ProfileIdentity removed — GX replaced the device-frame thumbnail with the
// full ProfilePhoneCard; profileMonogram/identityHue/formatDeviceName are now
// consumed by that component via props computed in the grid map.)

// Folder visual identity (founder: folders "look boring without any images").
// All/Unfiled get fixed glyphs; named folders get a per-name emoji (matched on
// common operator terms, console.html's 🛒/🏦/📣 shelf) plus a deterministic
// color dot hashed from the name so each folder is visually distinguishable at
// a glance without requiring per-folder icon metadata.
export function folderGlyph(label: string): string {
  if (label === 'All profiles') return '▦';
  if (label === 'Unfiled') return '📥';
  const l = label.toLowerCase();
  if (/shop|store|retail|cart|commerce/.test(l)) return '🛒';
  if (/bank|finance|pay|wallet/.test(l)) return '🏦';
  if (/ad|market|campaign|promo/.test(l)) return '📣';
  if (/social|insta|meta|tweet|post/.test(l)) return '📱';
  if (/test|sandbox|dev|qa/.test(l)) return '🧪';
  return '📁';
}

export function folderColor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i += 1) h = (h * 31 + label.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 55%)`;
}

function FolderItem({
  label,
  count,
  active,
  onSelect,
  variant = 'pill',
  icon,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
  // 'pill' = the original inline emoji shelf chip; 'rail' = a full-width row
  // for the S3 (2026-06-15) left folder rail (icon + name on the left, count
  // pushed right). Same folderFilter selection behavior either way.
  variant?: 'pill' | 'rail';
  // 2026-06-16 (founder) — a user-chosen folder icon; overrides the
  // deterministic folderGlyph when set.
  icon?: string;
}): JSX.Element {
  const namedFolder = label !== 'All profiles' && label !== 'Unfiled';
  const rail = variant === 'rail';
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={
        rail
          ? `flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              active
                ? 'border-transparent bg-accent-subtle font-semibold text-ink-primary'
                : 'border-transparent text-ink-secondary hover:bg-surface-raised hover:text-ink-primary'
            }`
          : `inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
              active
                ? 'border-transparent bg-accent-subtle font-semibold text-ink-primary'
                : 'border-surface-divider bg-surface-raised text-ink-secondary hover:border-ink-muted/50 hover:text-ink-primary'
            }`
      }
    >
      <span aria-hidden="true" className="text-[13px] leading-none">
        {icon !== undefined && icon.length > 0 ? icon : folderGlyph(label)}
      </span>
      {namedFolder && (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: folderColor(label) }}
        />
      )}
      <span className={rail ? 'flex-1 truncate text-left' : 'max-w-[10rem] truncate'}>{label}</span>
      <span
        className={`mono rounded-[5px] px-1.5 py-px text-2xs font-semibold ${
          active ? 'bg-accent/15 text-ink-primary' : 'bg-surface-inset text-ink-muted'
        }`}
      >
        {count}
      </span>
    </button>
  );
}

// 2026-06-19 (founder GUI-improvement audit) — per-row management menu for the
// folder/tag rail: a ⋯ toggle (revealed on hover OR tap) opening Rename / Re-icon
// (folders only) / Delete. Absolutely positioned over the right edge of the row
// so it overlays the count without disturbing the FolderItem/tag button DOM the
// content-parity tests pin. Outside-click + Escape close it; the inline rename
// input commits on Enter / blur. onReicon is optional (tags carry no icon).
function RailRowMenu({
  label,
  onRename,
  onReicon,
  onDelete,
  maxChars,
  disabled,
}: {
  /** Accessible disambiguator, e.g. "folder Work" / "tag aged". */
  label: string;
  onRename: (next: string) => Promise<boolean>;
  onReicon?: (emoji: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  /** P2 #8 — the name cap for THIS row's kind (folder 32 / tag 24) so the rename
   *  input can't type past what the rename handler + server will accept. */
  maxChars: number;
  disabled: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const actionOwnerRef = useRef<symbol | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setRenaming(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function commitRename(): Promise<void> {
    const next = draft.trim();
    if (next.length === 0 || disabled || actionOwnerRef.current !== null) return;
    const owner = Symbol('rail-row-rename');
    actionOwnerRef.current = owner;
    try {
      const saved = await onRename(next);
      if (actionOwnerRef.current !== owner || !saved) return;
      setRenaming(false);
      setOpen(false);
      setDraft('');
    } finally {
      if (actionOwnerRef.current === owner) actionOwnerRef.current = null;
    }
  }

  async function commitMenuAction(action: () => Promise<boolean>): Promise<void> {
    if (disabled || actionOwnerRef.current !== null) return;
    const owner = Symbol('rail-row-action');
    actionOwnerRef.current = owner;
    try {
      const saved = await action();
      if (actionOwnerRef.current === owner && saved) setOpen(false);
    } finally {
      if (actionOwnerRef.current === owner) actionOwnerRef.current = null;
    }
  }

  return (
    <div ref={ref} className="absolute right-1 top-1/2 -translate-y-1/2">
      <button
        type="button"
        aria-label={`Manage ${label}`}
        title="Manage"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`rounded px-1 text-ink-muted transition-opacity hover:text-ink-primary group-hover/rail:opacity-100 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-surface-divider bg-surface-raised py-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
        >
          {renaming ? (
            <input
              autoFocus
              aria-label={`Rename ${label}`}
              value={draft}
              maxLength={maxChars}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename();
                else if (e.key === 'Escape') {
                  setRenaming(false);
                  setOpen(false);
                }
              }}
              onBlur={() => void commitRename()}
              disabled={disabled}
              className="m-1 w-[calc(100%-0.5rem)] rounded border border-surface-divider bg-surface-base px-2 py-1 text-xs text-ink-primary focus:border-accent focus:outline-none"
            />
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => {
                setDraft(label.replace(/^(folder|tag) /, ''));
                setRenaming(true);
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-ink-secondary hover:bg-surface-raised hover:text-ink-primary"
            >
              Rename
            </button>
          )}
          {onReicon !== undefined && !renaming && (
            <label className="flex items-center gap-1 px-3 py-1.5 text-xs text-ink-secondary">
              Icon
              <select
                aria-label={`Re-icon ${label}`}
                value=""
                disabled={disabled}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '__noop') return;
                  void commitMenuAction(() => onReicon(v === '__none' ? '' : v));
                }}
                className="ml-auto rounded border border-surface-divider bg-surface-base px-1 py-0.5 text-xs text-ink-primary"
              >
                <option value="__noop">Pick…</option>
                <option value="__none">✕ None</option>
                {PROFILE_ICONS.map((i) => (
                  <option key={i.emoji} value={i.emoji}>
                    {i.emoji} {i.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!renaming && (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={() => void commitMenuAction(onDelete)}
              className="block w-full px-3 py-1.5 text-left text-xs font-medium text-status-error hover:bg-status-error/10"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// G3 — tag filter rail. A row of "#tag · count" pills below the folder shelf;
// clicking one filters the grid to that tag (clicking the active one, or
// "clear", resets). Renders nothing when there are no tags so it never adds
// empty chrome. Tag color is the deterministic folderColor hash so a tag reads
// consistently wherever it appears.
export function TagFilterRail({
  tags,
  active,
  onSelect,
}: {
  tags: Array<{ tag: string; count: number }>;
  active: string | null;
  onSelect: (tag: string | null) => void;
}): JSX.Element | null {
  if (tags.length === 0) return null;
  return (
    <nav aria-label="Tags" className="flex flex-col gap-2 border-b border-surface-divider pb-3">
      <div className="flex items-center justify-between">
        <span className="section-label">Tags</span>
        {active !== null && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="section-label text-accent hover:underline"
          >
            clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tags.map(({ tag, count }) => {
          const on = active === tag;
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(on ? null : tag)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                on
                  ? 'border-accent bg-accent-subtle font-medium text-ink-primary'
                  : 'border-surface-divider text-ink-secondary hover:border-accent/50 hover:text-ink-primary'
              }`}
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: folderColor(tag) }}
              />
              {tag}
              <span
                className={`mono rounded-[5px] px-1 text-2xs ${
                  on ? 'bg-accent/15 text-ink-primary' : 'bg-surface-inset text-ink-muted'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// Empty state for the profile grid/list (5→10 polish). Distinguishes the two
// "nothing shows" reasons: an active filter narrowed everything out (offer a
// one-click "Clear filters" that resets folder + tag + search + status — the
// old list-only "Clear" forgot folder + tag, so a tag/folder filter to zero was
// unrecoverable) vs a genuinely empty account. Uses the shared EmptyState so it
// reads deliberate, not like a bare gray line.
export function ProfilesEmpty({
  hasActiveFilters,
  onClear,
}: {
  hasActiveFilters: boolean;
  onClear: () => void;
}): JSX.Element {
  return (
    <EmptyState
      icon={
        <svg
          viewBox="0 0 16 16"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5Z" />
        </svg>
      }
      title={hasActiveFilters ? 'No profiles match these filters' : 'No profiles here yet'}
      description={
        hasActiveFilters
          ? 'Nothing matches the folder, tag, search and status filters together. Clear them to see everything.'
          : 'Profiles you create show up here, ready to launch or hand to the AI.'
      }
      action={
        hasActiveFilters ? (
          <button type="button" className="btn-secondary px-3 py-1 text-xs" onClick={onClear}>
            Clear filters
          </button>
        ) : undefined
      }
    />
  );
}

function PreviewRow({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-surface-divider py-1 text-xs last:border-0">
      <dt className="text-ink-muted">{k}</dt>
      <dd className="truncate text-ink-primary">{v}</dd>
    </div>
  );
}

function EmptyConnect({
  baseUrl,
  onGoToSettings,
}: {
  baseUrl: string;
  onGoToSettings: () => void;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="section-label">Not connected</span>
      <p className="max-w-md text-sm text-ink-secondary">
        Set an API key in Settings to load profiles from <span className="mono">{baseUrl}</span>.
      </p>
      <button type="button" className="btn-primary" onClick={onGoToSettings}>
        Open Settings
      </button>
    </div>
  );
}

/** ISO-3166 alpha-2 → regional-indicator flag emoji ('NL' → 🇳🇱). */
function flagEmoji(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '🌍';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// Country name for an ISO-3166 alpha-2 code via the platform's Intl region
// names (WebKit ships the full set) — no hand-maintained map. Falls back to the
// raw code for non-country values (Tor 'T1', 'XX').
function regionName(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return cc;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc;
  } catch {
    return cc;
  }
}

function friendlyError(
  err: unknown,
  baseUrl?: string,
  fallback = "Couldn't complete this profile action. Try again.",
): string {
  // 2026-05-20 — network-failure preflight (catches Tauri WebKit
  // "Load failed" before falling through to per-view formatting). Keep the
  // configured target/actionable guidance, but never include the raw native
  // exception appended by the shared diagnostic helper.
  if (baseUrl !== undefined) {
    const diag = diagnosticFetchError(err, baseUrl);
    if (diag !== null) {
      return `Couldn't reach ${baseUrl}. Check the URL, connection, firewall, or VPN, then try again.`;
    }
  }
  return humanizeError(err, fallback);
}

// L4b recycle bin — the Trash view. Lists soft-deleted profiles with a Restore
// action; the row data + DEK survive server-side until a purge. Restore returns
// a profile to the live list (its name must be free, else the server 409s).
//
// 2026-06-20 — upgrades: client-side search/filter + sort over `trashed[]`, plus
// bulk "Restore all" / "Empty trash" that loop the existing per-id endpoints
// (no server bulk endpoint yet — see the restoreAll/emptyTrash follow-up notes
// on the bulk handlers).
type TrashSortBy = 'deleted' | 'name' | 'device';

function TrashPanel({
  trashed,
  loading,
  dataAvailable,
  loadError,
  restoringId,
  purgingId,
  bulkBusy,
  bulkAction,
  onRestore,
  onPurge,
  onRestoreAll,
  onEmptyTrash,
  onRetry,
  onBack,
}: {
  trashed: Profile[];
  loading: boolean;
  dataAvailable: boolean;
  loadError: string | null;
  restoringId: string | null;
  purgingId: string | null;
  bulkBusy: boolean;
  bulkAction: 'restore' | 'empty' | null;
  onRestore: (id: string) => void;
  onPurge: (id: string, name: string) => void;
  onRestoreAll: (ids: ReadonlyArray<string>) => void;
  onEmptyTrash: (ids: ReadonlyArray<string>) => void;
  onRetry: () => void;
  onBack: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<TrashSortBy>('deleted');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered =
      q.length === 0
        ? trashed
        : trashed.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              formatDeviceName(p.archetype).toLowerCase().includes(q),
          );
    const sign = sortDir === 'asc' ? 1 : -1;
    const cmp = (a: Profile, b: Profile): number => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'device':
          return formatDeviceName(a.archetype).localeCompare(formatDeviceName(b.archetype));
        case 'deleted': {
          const at = a.deleted_at !== null ? new Date(a.deleted_at).getTime() : 0;
          const bt = b.deleted_at !== null ? new Date(b.deleted_at).getTime() : 0;
          return at - bt;
        }
      }
    };
    return [...filtered].sort((a, b) => sign * cmp(a, b));
  }, [trashed, query, sortBy, sortDir]);

  // Bulk targets the FILTERED view, so a search lets the operator restore/empty
  // just the matching subset (matching the per-row buttons' scope).
  const visibleIds = visible.map((p) => p.id);
  const anyBusy = bulkBusy || restoringId !== null || purgingId !== null;

  return (
    <div aria-busy={anyBusy} {...(anyBusy ? { inert: '' } : {})} className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-ink-primary">Recycle bin</h3>
          <p className="mt-0.5 text-[11px] text-ink-secondary">
            Deleted profiles are kept here so you can restore them. Restoring returns a profile to
            your list; its name must be free. Trashed profiles still use a slot toward your plan —
            delete one permanently to free it now, or it’s purged automatically after 30 days.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="shrink-0 rounded-lg border border-surface-divider px-2.5 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:text-ink-primary"
        >
          ← Back to profiles
        </button>
      </div>
      {!loading && dataAvailable && trashed.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            aria-label="Search trash"
            placeholder="Search trash…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-[12rem] flex-1 rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary placeholder:text-ink-muted focus-visible:border-accent focus-visible:outline-none"
          />
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
            <span className="section-label">Sort</span>
            <select
              aria-label="Sort trash"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as TrashSortBy)}
              className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary focus-visible:border-accent focus-visible:outline-none"
            >
              <option value="deleted">Deleted</option>
              <option value="name">Name</option>
              <option value="device">Device</option>
            </select>
            <button
              type="button"
              aria-label={`Trash sort direction: ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
              title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
              onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
              className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-xs text-ink-primary focus-visible:border-accent focus-visible:outline-none"
            >
              {sortDir === 'asc' ? '↑' : '↓'}
            </button>
          </label>
          <span aria-hidden className="h-5 w-px bg-surface-divider" />
          <button
            type="button"
            onClick={() => onRestoreAll(visibleIds)}
            disabled={anyBusy || visibleIds.length === 0}
            title="Restore every profile shown — names already in use are skipped"
            className="rounded-lg border border-surface-divider px-2.5 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:text-ink-primary disabled:opacity-50"
          >
            {bulkAction === 'restore'
              ? 'Restoring…'
              : `Restore all (${visibleIds.length.toString()})`}
          </button>
          <button
            type="button"
            onClick={() => onEmptyTrash(visibleIds)}
            disabled={anyBusy || visibleIds.length === 0}
            title="Permanently delete every profile shown — can’t be undone"
            className="rounded-lg border border-status-error/40 px-2.5 py-1.5 text-xs font-medium text-status-error transition-colors hover:bg-status-error/15 disabled:opacity-50"
          >
            {bulkAction === 'empty' ? 'Deleting…' : 'Empty trash'}
          </button>
        </div>
      )}
      {loading ? (
        <p className="py-8 text-center text-xs text-ink-muted">Loading…</p>
      ) : loadError !== null ? (
        <div
          role="alert"
          className="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-5 text-center"
        >
          <p className="text-xs text-status-error">{loadError}</p>
          <button type="button" onClick={onRetry} className="btn-secondary mt-3 text-xs">
            Retry
          </button>
        </div>
      ) : !dataAvailable ? (
        <p className="rounded-lg border border-dashed border-surface-divider py-10 text-center text-xs text-ink-muted">
          Recycle-bin status is unavailable. Retry before judging its contents.
        </p>
      ) : trashed.length === 0 ? (
        <p className="rounded-lg border border-dashed border-surface-divider py-10 text-center text-xs text-ink-muted">
          Trash is empty.
        </p>
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-surface-divider py-10 text-center text-xs text-ink-muted">
          No trashed profiles match your search.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((p) => {
            const id = p.id.replace(/^prof_/, '');
            const restoring = restoringId === id || restoringId === p.id;
            const purging = purgingId === id || purgingId === p.id;
            const busy = restoring || purging || bulkBusy;
            return (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-surface-divider bg-surface-raised px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink-primary">{p.name}</div>
                  <div className="truncate text-[11px] text-ink-muted">
                    {formatDeviceName(p.archetype)}
                    {p.deleted_at !== null ? (
                      <>
                        {' · deleted '}
                        <RelativeTime iso={p.deleted_at} />
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onPurge(p.id, p.name)}
                    disabled={busy}
                    title="Permanently delete — frees a profile slot, can’t be undone"
                    className="rounded-lg border border-status-error/40 px-2.5 py-1.5 text-xs font-medium text-status-error transition-colors hover:bg-status-error/15 disabled:opacity-50"
                  >
                    {purging ? 'Deleting…' : 'Delete permanently'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onRestore(p.id)}
                    disabled={busy}
                    className="btn-primary text-xs"
                  >
                    {restoring ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
