// Audit scenes (2026-09-12) — one `?scene=audit-<view>` composition per view
// the six marketing scenes do not cover, so scripts/gui-text-quality.mjs
// (both themes, WCAG AA, positive control) measures EVERY view's text and not
// six. Each scene mounts the REAL view component — no replica — inside the
// same AppWindow chrome (gallery.tsx: real TitleBar + Sidebar through the real
// SettingsContext), fed the data it needs to reach its LOADED state:
//
//   • a fixture SDK `client` through SettingsContext — only the resource
//     methods the view actually calls (read off the view: sessions.list,
//     agentSessions.list, team.listMembers/listInvites, recipes.list,
//     account.getBundledLlmSettings/getBundledLlmStatus/getByokAnthropicKey,
//     profiles.iterate), returning the fixtures below;
//   • props (onGoToSettings, onOpen, onComplete …) = noop;
//   • where a view reads Tauri DIRECTLY — plugin-store (Fleet registry, chat
//     history, assistant templates, profile bindings, proxies), plugin-fs (the
//     recordings index, the dev-log mirror) or a command (`secret_load`,
//     `plugin:app|version`) — a small WINDOW-LEVEL STUB, `window.__TAURI_
//     INTERNALS__.invoke`, the one choke point every @tauri-apps/* module
//     funnels through (`invoke(cmd, args)` in @tauri-apps/api/core is a
//     one-liner over it). It is installed by the scene BEFORE the view mounts
//     (render phase — a child's mount effect runs before the parent's effects)
//     and removed when the scene unmounts (deferred one microtask so React
//     StrictMode's simulated unmount → remount does not leave a window without
//     it while the children's effects re-run). It answers the store / fs /
//     command shapes the plugins send, from the fixtures; a write is
//     acknowledged and DROPPED (nothing persists); an unknown command REJECTS
//     with its name — loudly, exactly what a browser without Tauri does today
//     (TypeError on the missing internals), never a silent null. It is never
//     installed over a real Tauri runtime.
//
// PRIVACY (tests/unit/marketing-scenes.test.tsx scans every audit scene the
// way it scans the marketing ones — text nodes + attributes): hosts are
// *.example.com, IPs are RFC 5737 TEST-NET, the account is ops@example.com
// (FIXTURE_ACCOUNT), session / recording / recipe ids are obviously synthetic,
// no keys, no exit cities beyond the fixture set.
//
// DETERMINISM: every timestamp is relative to FROZEN_NOW_ISO (gallery.tsx
// freezes Date.now at module load when `?scene=` names ANY scene, audit ones
// included). The base URL is https://api.example.com — a host that answers
// nothing — so the views that probe the server themselves (ConnectivityView
// and SettingsAccountCard fetch /version and /v1/account/me; AgentChatView's
// useConnectionStatus polls /version) render their unreachable branch the same
// way online and offline, instead of whatever the live cloud says that minute.
//
// STATE REACHED (what the gate measures; see the table in the batch report):
//   audit-sessions      SessionsView     loaded — 3 driver sessions (ready / busy / errored) + 1 active agent session
//   audit-fleet         FleetView        loaded — 3 registry members, un-pinged (pings are click-driven; stub: plugin-store)
//   audit-recordings    RecordingsView   loaded — 3 persisted recordings, first selected (stub: plugin-fs index + dir)
//   audit-connectivity  ConnectivityView idle — settings summary + Run check; /version unreachable → no server line
//   audit-settings      SettingsView     loaded — bundled-LLM settings/status + BYOK metadata from the client;
//                                         account card = unreachable branch; self-hosted mode (example.com URL)
//   audit-first-run     FirstRunWizard   welcome step (the wizard's first screen; later steps need a live key check)
//   audit-recipes       RecipesView      loaded — 3 saved tasks, none selected (detail loads on click)
//   audit-agent-chat    AgentChatView    idle composer — 3 profiles in the picker, 2 saved chats, no turns
//   audit-agent-chat-<kind>              the SAME view in each state a customer can be in — nokey,
//                                         planning, running, approval, done, trouble, stopping. Driven
//                                         through the three seams of spec §8 (a fixture chat published
//                                         by the real AgentChatProvider, a drawn IMAGE in the live
//                                         view's screen, a drawn image for a captured screenshot), so
//                                         the gates measure the REAL view and not a replica of it.
//                                         Fixtures live in agent-chat-scenes.tsx.
//   audit-team          TeamView         loaded — 2 members + 1 pending invite — in the jsdom arm. ⚠️ In the
//                                         harness (React.StrictMode, main.tsx) the view sits on its skeleton:
//                                         TeamView's `mountedRef` starts true and its unmount cleanup sets it
//                                         false, StrictMode's simulated unmount → remount never sets it back,
//                                         and every refresh() result is then dropped as "unmounted". Fix in
//                                         TeamView: set `mountedRef.current = true` inside that effect.
//   audit-proxies       ProxiesView      loaded — the TABLE (the marketing `proxies` scene shows only the editor
//                                         cards): 7 saved proxies over a probe cache that puts one row in each
//                                         state the grid has to hold — every reading fresh, every reading 5 h
//                                         old, failed with a long sentence, a tunnel that is up, never tested,
//                                         an HTTP row, and a label + host long enough to truncate (stub:
//                                         plugin-store settings.json + proxy-probe-cache.json, `secret_load`).
//                                         `?stage=<W>x<H>` renders it at another window size (see auditSceneSizes).
//
// ⚠️ CYCLE with gallery.tsx (it imports AuditScene + AUDIT_SCENE_SIZES; we
// import AppWindow + the fixtures): nothing here reads a gallery export at
// module top level — every fixture that needs FROZEN_NOW_ISO is built inside
// a function — so either import order evaluates both modules fully first.

import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import type {
  AgentSession,
  BundledLlmSettings,
  BundledLlmStatus,
  ByokAnthropicKeyMetadata,
  Recipe,
  TeamInvite,
  TeamMember,
} from '@driftstack/sdk';
import type { DriftstackClient, Session } from '../lib/client';
import type { DriftstackSettings } from '../lib/settings';
import { SettingsContext } from '../lib/SettingsContext';
import { ToastProvider } from '../lib/toasts';
import { ConfirmProvider } from '../components/ConfirmProvider';
import type { FleetMember } from '../lib/fleet-members';
import type { RecordingHeader } from '../lib/recordings-store';
import type { StoredChat } from '../lib/chat-history';
import type { ProxyMetadata } from '../lib/proxies';
import {
  PROBE_CACHE_SCHEMA_VERSION,
  endpointPlaceholderResult,
  type CachedProbe,
} from '../lib/proxy-probe-cache';
import { unavailableOsFingerprint } from '../lib/os-fingerprint-verdict';
import { SessionsView } from '../views/SessionsView';
import { FleetView } from '../views/FleetView';
import { RecordingsView } from '../views/RecordingsView';
import { ConnectivityView } from '../views/ConnectivityView';
import { SettingsView } from '../views/SettingsView';
import { FirstRunWizard } from '../views/FirstRunWizard';
import { RecipesView } from '../views/RecipesView';
import { AgentChatView } from '../views/AgentChatView';
import { AgentChatProvider, type AgentChatContextValue } from '../lib/AgentChatProvider';
import {
  AGENT_CHAT_SCENE_KINDS,
  agentChatSceneFixture,
  type AgentChatSceneFixture,
  type AgentChatSceneKind,
} from './agent-chat-scenes';
import { TeamView } from '../views/TeamView';
import { ProxiesView } from '../views/ProxiesView';
import {
  AppWindow,
  FIXTURE_ACCOUNT,
  FIXTURE_SETTINGS,
  FROZEN_NOW_ISO,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  type AuditSceneName,
  type HarnessSettingsValue,
} from './gallery';

const noop = (): void => undefined;
const noopAsync = (): Promise<void> => Promise.resolve();

/** Stage per audit scene. 1280×800 like the marketing default; Settings is a
 *  long single-column form (connection, account, AI & billing, updates, danger
 *  zone) that the window's own scroll would hide from a screenshot reviewer —
 *  the gate measures the DOM either way, the taller stage is for the human.
 *  A function, not a constant: it reads SCENE_WIDTH/HEIGHT from gallery.tsx,
 *  which is in the import cycle (header) — a top-level read here would see the
 *  binding before it exists (TDZ in the browser; `undefined` under vite-node,
 *  which turned every audit stage into `undefinedpx` the first time). */
export function auditSceneSizes(): Record<AuditSceneName, { width: number; height: number }> {
  const stage = { width: SCENE_WIDTH, height: SCENE_HEIGHT };
  const sizes = auditDefaultSizes(stage);
  const override = stageOverrideFromSearch(
    typeof window === 'undefined' ? '' : window.location.search,
  );
  if (override === null) return sizes;
  for (const name of Object.keys(sizes) as AuditSceneName[]) sizes[name] = override;
  return sizes;
}

/** `?stage=<W>x<H>` (CSS px) — render an audit scene's window at another size.
 *  The stage is a fixed box that ignores the viewport, so a 960-wide screenshot
 *  of the default stage is a 1280 layout CROPPED, and a scaled one is a 1280
 *  layout shrunk; neither shows what the app does in a 960 window (which
 *  columns truncate, whether the table overflows). With this the stage IS that
 *  window. Audit scenes only: the marketing stages are mirrored by scripts/
 *  marketing-screens.mjs and pinned byte-for-byte. Absent → null and nothing
 *  changes (the text-quality gate and both jsdom arms never pass it). A value
 *  that is present and unusable THROWS: falling back to the default would hand
 *  back a 1280 render labelled as whatever was asked for. */
export function stageOverrideFromSearch(search: string): { width: number; height: number } | null {
  const raw = new URLSearchParams(search).get('stage');
  if (raw === null) return null;
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(raw);
  const width = m === null ? NaN : Number(m[1]);
  const height = m === null ? NaN : Number(m[2]);
  if (!(width >= 640 && width <= 3840 && height >= 400 && height <= 4000)) {
    throw new Error(
      `visual harness: ?stage=${raw} is not <W>x<H> with W 640–3840 and H 400–4000 (e.g. ?stage=960x600)`,
    );
  }
  return { width, height };
}

function auditDefaultSizes(stage: {
  width: number;
  height: number;
}): Record<AuditSceneName, { width: number; height: number }> {
  return {
    'audit-sessions': stage,
    'audit-fleet': stage,
    // Three recordings + the selected one's detail measure 819 CSS px in the
    // 1280×800 window's 764 px main area; 880 shows the whole list.
    'audit-recordings': { width: SCENE_WIDTH, height: 880 },
    'audit-connectivity': stage,
    // The whole settings form (connection, account, AI & billing, updates,
    // danger zone) measures 1684 CSS px; 1720 fits it without a scrollbar.
    'audit-settings': { width: SCENE_WIDTH, height: 1720 },
    'audit-first-run': stage,
    'audit-recipes': stage,
    'audit-agent-chat': stage,
    // The seven AI-view states share the default stage: they are compared with
    // each other and with the mockup, which is drawn at 1280x800. A real window
    // size is a `?stage=960x600` away (above) and is checked by hand.
    'audit-agent-chat-nokey': stage,
    'audit-agent-chat-planning': stage,
    'audit-agent-chat-running': stage,
    'audit-agent-chat-approval': stage,
    'audit-agent-chat-done': stage,
    'audit-agent-chat-trouble': stage,
    'audit-agent-chat-stopping': stage,
    // ⛔ THE ONE AI SCENE WITH ITS OWN WINDOW. The Tauri minimum, so the gate
    // measures the narrow tier — 44px rail strip, 44px bar, 252px stage — that
    // the other seven, all at the default stage, can never reach.
    'audit-agent-chat-small': { width: 960, height: 600 },
    'audit-team': stage,
    // Seven rows measure 860 CSS px in the 1280×800 window's 764 px main area
    // (896 would just fit); 920 keeps the last row in frame when a chip wraps.
    // A look at a real window size passes ?stage= instead (above).
    'audit-proxies': { width: SCENE_WIDTH, height: 920 },
  };
}

// ─── Fixtures (built lazily — see the CYCLE note in the header) ──────────────

/** A host that answers nothing, so the views' own probes are deterministic. */
export const AUDIT_BASE_URL = 'https://api.example.com';

function minutesBefore(minutes: number): string {
  return new Date(Date.parse(FROZEN_NOW_ISO) - minutes * 60_000).toISOString();
}
function daysAfter(days: number): string {
  return new Date(Date.parse(FROZEN_NOW_ISO) + days * 86_400_000).toISOString();
}

function auditSettings(): DriftstackSettings {
  return { ...FIXTURE_SETTINGS, baseUrl: AUDIT_BASE_URL };
}

export function auditSessions(): Session[] {
  const base = {
    account_id: FIXTURE_ACCOUNT.id,
    api_key_id: 'key_audit_fixture',
    purpose: 'production_customer' as const,
    metadata: null,
    egress_capability_report: null,
    destroyed_at: null,
  };
  return [
    {
      ...base,
      id: 'ses_audit_amsterdam_checkout',
      status: 'ready',
      archetype: 'iphone17_ios18_7_safari26_4',
      label: 'Amsterdam checkout',
      egress_capabilities: {
        udp_associate: true,
        quic_route: 'proxy',
        dns_remote_resolve: true,
        warnings: [],
      },
      created_at: minutesBefore(12),
      updated_at: minutesBefore(1),
      last_state_at: minutesBefore(1),
    },
    {
      ...base,
      id: 'ses_audit_berlin_price_watch',
      status: 'busy',
      archetype: 'iphone16_ios18_4_safari18_4',
      label: 'Price watch · Berlin',
      egress_capabilities: {
        udp_associate: false,
        quic_route: 'disabled',
        dns_remote_resolve: true,
        warnings: ['QUIC disabled by the proxy'],
      },
      created_at: minutesBefore(3),
      updated_at: minutesBefore(0),
      last_state_at: minutesBefore(0),
    },
    {
      ...base,
      id: 'ses_audit_lisbon_login',
      status: 'errored',
      archetype: 'iphone15_ios17_6_safari17_6',
      label: null,
      egress_capabilities: null,
      created_at: minutesBefore(40),
      updated_at: minutesBefore(35),
      last_state_at: minutesBefore(35),
    },
  ];
}

/** Only what SessionsView / the Sidebar badge read off an agent session. */
export function auditAgentSessions(): Array<
  Pick<AgentSession, 'id' | 'status' | 'created_at' | 'mode'>
> {
  return [
    {
      id: 'agt_audit_launched_profile',
      status: 'active',
      created_at: minutesBefore(8),
      mode: 'manual',
    },
  ];
}

export function auditTeam(): { members: TeamMember[]; invites: TeamInvite[] } {
  return {
    members: [
      {
        id: 'mem_audit_ana',
        owner_account_id: FIXTURE_ACCOUNT.id,
        member_account_id: 'acc_audit_ana',
        member_email: 'ana@example.com',
        role: 'admin',
        invited_at: minutesBefore(60 * 24 * 30),
        accepted_at: minutesBefore(60 * 24 * 29),
        invited_by_account_id: FIXTURE_ACCOUNT.id,
      },
      {
        id: 'mem_audit_ben',
        owner_account_id: FIXTURE_ACCOUNT.id,
        member_account_id: 'acc_audit_ben',
        member_email: 'ben@example.com',
        role: 'member',
        invited_at: minutesBefore(60 * 24 * 6),
        accepted_at: minutesBefore(60 * 24 * 5),
        invited_by_account_id: 'acc_audit_ana',
      },
    ],
    invites: [
      {
        id: 'inv_audit_newhire',
        owner_account_id: FIXTURE_ACCOUNT.id,
        invitee_email: 'newhire@example.com',
        role: 'member',
        expires_at: daysAfter(13),
        invited_by_account_id: FIXTURE_ACCOUNT.id,
        accepted_at: null,
        created_at: minutesBefore(60 * 24),
      },
    ],
  };
}

export function auditRecipes(): Recipe[] {
  const account_id = FIXTURE_ACCOUNT.id;
  return [
    {
      id: 'rec_audit_jacket_prices',
      account_id,
      agent_session_id: 'agt_audit_jacket',
      label: 'Compare jacket prices',
      description: 'Open the three shops, search the jacket, capture each price.',
      intent_count: 14,
      created_at: minutesBefore(60 * 24 * 3),
      updated_at: minutesBefore(60 * 5),
    },
    {
      id: 'rec_audit_newsletter_signup',
      account_id,
      agent_session_id: null,
      label: 'Newsletter sign-up check',
      description: null,
      intent_count: 6,
      created_at: minutesBefore(60 * 24 * 9),
      updated_at: minutesBefore(60 * 24 * 9),
    },
    {
      id: 'rec_audit_checkout_dry_run',
      account_id,
      agent_session_id: 'agt_audit_checkout',
      label: 'Checkout dry run',
      description: 'Add to basket, reach the payment step, stop before paying.',
      intent_count: 22,
      created_at: minutesBefore(60 * 24 * 14),
      updated_at: minutesBefore(60 * 24 * 2),
    },
  ];
}

/** The profile picker in AgentChatView reads id + name off `profiles.iterate`. */
export const AUDIT_PROFILES: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'prof_audit_amsterdam', name: 'amsterdam shopper' },
  { id: 'prof_audit_berlin', name: 'berlin price watch' },
  { id: 'prof_audit_lisbon', name: 'lisbon travel' },
];

export function auditAccountAi(): {
  bundled: BundledLlmSettings;
  status: BundledLlmStatus;
  byok: ByokAnthropicKeyMetadata;
} {
  return {
    bundled: { consent: true, monthly_cap_usd_cents: 2500 },
    status: {
      consent: true,
      cap_cents: 2500,
      used_this_month_cents: 640,
      remaining_cents: 1860,
      refused_count_this_month: 0,
      month_started_at: '2026-06-01T00:00:00.000Z',
    },
    byok: { has_key: true, set_at: minutesBefore(60 * 24 * 30), last_used_at: minutesBefore(120) },
  };
}

/** The fleet registry (plugin-store settings.json → fleetMembers): two rigs on
 *  TEST-NET addresses, one example.com host. Un-pinged — pings are click-driven. */
export function auditFleetMembers(): FleetMember[] {
  return [
    {
      id: 'fleet_audit_rig_a',
      label: 'Rig A · Amsterdam',
      baseUrl: 'http://192.0.2.10:3000',
      notes: 'Primary capture rig',
      createdAt: minutesBefore(60 * 24 * 20),
    },
    {
      id: 'fleet_audit_rig_b',
      label: 'Rig B · Berlin',
      baseUrl: 'http://198.51.100.7:3000',
      notes: null,
      createdAt: minutesBefore(60 * 24 * 12),
    },
    {
      id: 'fleet_audit_staging',
      label: 'Staging',
      baseUrl: 'https://staging.example.com',
      notes: 'Mock driver — smoke tests only',
      createdAt: minutesBefore(60 * 24 * 2),
    },
  ];
}

/** The persisted recordings index (plugin-fs $APPDATA/recordings/index.json). */
export function auditRecordings(): RecordingHeader[] {
  const now = Date.parse(FROZEN_NOW_ISO);
  return [
    {
      id: 'rec_audit_checkout_flow',
      sessionId: 'ses_audit_amsterdam_checkout',
      label: 'Checkout flow',
      startedAt: now - 50 * 60_000,
      endedAt: now - 38 * 60_000,
      totalCaptured: 1440,
      frameCount: 1200,
      totalBytes: 180_000_000,
    },
    {
      id: 'rec_audit_price_watch',
      sessionId: 'ses_audit_berlin_price_watch',
      label: null,
      startedAt: now - 3 * 3_600_000,
      endedAt: now - 3 * 3_600_000 + 90_000,
      totalCaptured: 180,
      frameCount: 180,
      totalBytes: 27_000_000,
    },
    {
      id: 'rec_audit_login_probe',
      sessionId: 'ses_audit_lisbon_login',
      label: 'Login probe',
      startedAt: now - 2 * 86_400_000,
      endedAt: now - 2 * 86_400_000 + 12_000,
      totalCaptured: 0,
      frameCount: 0,
      totalBytes: 0,
    },
  ];
}

/** Saved chats (plugin-store agent-chats.json → chats) for the history rail. */
export function auditStoredChats(): StoredChat[] {
  const now = Date.parse(FROZEN_NOW_ISO);
  return [
    {
      id: 'chat_audit_jacket',
      title: 'Compare prices for a jacket',
      profileId: 'prof_audit_amsterdam',
      model: 'claude-opus-5',
      turns: [
        { id: 1, role: 'user', text: 'Compare prices for the jacket across the three shops.' },
      ],
      createdAt: now - 2 * 3_600_000,
      updatedAt: now - 3_600_000,
    },
    {
      id: 'chat_audit_newsletter',
      title: 'Sign up for the newsletter',
      profileId: '',
      model: 'claude-sonnet-5',
      turns: [
        { id: 1, role: 'user', text: 'Sign up for the newsletter with the profile address.' },
      ],
      createdAt: now - 86_400_000,
      updatedAt: now - 86_400_000 + 600_000,
    },
    // Stage 6 — the rail's THIRD group and its red outcome dot. Without a chat
    // older than yesterday the "Earlier" heading was never rendered, and
    // without one whose last turn ended badly neither the error dot nor the
    // "Didn’t finish" meta line was ever measured: the gate would have reported
    // a clean rail with two of its five states unseen. A stopped turn (the
    // customer pressed Stop) is the commonest of them.
    {
      id: 'chat_audit_cart',
      title: 'Add three items to the cart and stop',
      profileId: 'prof_audit_amsterdam',
      model: 'claude-sonnet-5',
      turns: [
        { id: 1, role: 'user', text: 'Add three items to the cart, then stop before checkout.' },
        {
          id: 2,
          role: 'agent',
          interrupted: {
            reason: 'Stopped after step 2 of 5, as you asked.',
            steps: [
              {
                kind: 'success',
                intent: { kind: 'navigate', url: 'https://shop.example.com' },
                summary: 'Opened the store',
              },
              {
                kind: 'success',
                intent: { kind: 'interact', action: 'tap', selector: '#add-to-cart' },
                summary: 'Added the first item to the cart',
              },
            ],
          },
        },
      ],
      createdAt: now - 4 * 86_400_000,
      updatedAt: now - 4 * 86_400_000 + 900_000,
    },
  ];
}

/** The saved proxies (plugin-store settings.json → proxies), as `listProxies`
 *  persists them: metadata only — the secret half is `auditProxySecrets`. One
 *  row per state the table has to hold; the probe cache below is keyed by these
 *  ids. The first row carries a `serverId` so the view's account-list sync
 *  actually fires (it is skipped when no row has one) against AUDIT_BASE_URL,
 *  which answers nothing — the scene shows that failing quietly. */
export function auditProxies(): ProxyMetadata[] {
  return [
    {
      id: 'px_audit_socks_fresh',
      label: 'Amsterdam residential',
      host: 'ams.proxy.example.com',
      port: 1080,
      username: null,
      createdAt: minutesBefore(60 * 24 * 21),
      serverId: 'apx_audit_socks_fresh',
      scheme: 'socks5',
    },
    {
      id: 'px_audit_socks_aged',
      label: 'Berlin datacenter',
      host: 'ber.proxy.example.com',
      port: 1080,
      username: null,
      createdAt: minutesBefore(60 * 24 * 18),
      scheme: 'socks5',
    },
    {
      id: 'px_audit_socks_failed',
      label: 'London mobile',
      host: 'lon.proxy.example.com',
      port: 1080,
      username: null,
      createdAt: minutesBefore(60 * 24 * 14),
      scheme: 'socks5',
    },
    {
      id: 'px_audit_wireguard_up',
      label: 'Tokyo tunnel',
      host: 'wg-tyo.example.com',
      port: 51820,
      username: null,
      createdAt: minutesBefore(60 * 24 * 9),
      scheme: 'wireguard',
    },
    {
      id: 'px_audit_openvpn_untested',
      label: 'Amsterdam OpenVPN',
      host: 'ovpn-ams.example.com',
      port: 1194,
      username: null,
      createdAt: minutesBefore(60 * 24 * 4),
      scheme: 'openvpn',
    },
    {
      id: 'px_audit_http',
      label: 'Office gateway',
      host: 'gateway.example.com',
      port: 8080,
      username: null,
      createdAt: minutesBefore(60 * 24 * 2),
      scheme: 'http',
    },
    {
      // Truncation: a label and a host that cannot fit the Proxy column at any
      // window size, and a username (it prints in the detail row only).
      id: 'px_audit_socks_long',
      label: 'Rotating residential pool · sticky 30 min · checkout and price-watch profiles',
      host: 'rotating-residential-sticky-sessions.eu-west.gateway.proxy.example.com',
      port: 10800,
      username: 'customer-audit-zone-eu-session-sticky30',
      createdAt: minutesBefore(60 * 24),
      scheme: 'socks5',
    },
  ];
}

/** `secret_load` answers, keyed as lib/proxies.ts asks (`proxy_secret:<id>`).
 *  `listProxies` refuses a row with no protected half ("Protected proxy
 *  credentials are missing"), so every fixture row gets one — holding NO
 *  credential: a null password and no tunnel config, bound to the row's own
 *  endpoint (a binding that does not match its metadata is refused too, hence
 *  built from `auditProxies` and never retyped). */
export function auditProxySecrets(): Record<string, string> {
  return Object.fromEntries(
    auditProxies().map((p) => [
      `proxy_secret:${p.id}`,
      JSON.stringify({
        version: 1,
        binding: { host: p.host, port: p.port, username: p.username, scheme: p.scheme ?? null },
        password: null,
      }),
    ]),
  );
}

/** The probe cache (plugin-store proxy-probe-cache.json → probes). Typed as the
 *  real CachedProbe because `cleanEntry` rebuilds each entry from an allowlist:
 *  a field it does not name is dropped on load, without an error, and the row
 *  then renders "untested" for a reason nothing on screen explains. The native
 *  `message`s are the shipped ones (src-tauri/src/lib.rs). */
export function auditProxyProbes(): Record<string, CachedProbe> {
  const now = Date.parse(FROZEN_NOW_ISO);
  const healthyMessage =
    'Working — CONNECT succeeded. UDP ASSOCIATE supported — QUIC / WebRTC / HTTP-3 tunnel through it too.';
  const healthy = (latency_ms: number): CachedProbe['result'] => ({
    reachable: true,
    auth_ok: true,
    udp_associate: true,
    can_route: true,
    connect_reply: 0,
    latency_ms,
    message: healthyMessage,
  });
  /** Everything the two healthy SOCKS5 rows hold, measured at `at`: both
   *  latencies, UDP + QUIC, the OS reading, the exit with its place.
   *  ⛔ Every reading rides with ITS OWN stamp (`exitAt`, `osFingerprint.at`,
   *  `serverProbeAt`, `quicMeasuredAt`, `quicProbeAt`, `udpProbeAt`). The stamps
   *  are optional on the type, so a reading without one still typechecks and
   *  still survives `cleanEntry` — and `deriveProbeViewState` then files it as
   *  neither fresh nor aged: it never reaches the screen, at any age. */
  const fullReading = (
    at: number,
    exit: { ip: string; country: string; city: string; region: string; timezone: string },
    latency: { native: number; server: number },
    os: { webPortVantage: boolean },
  ): CachedProbe => ({
    result: healthy(latency.native),
    at,
    exitIp: exit.ip,
    exitCountry: exit.country,
    exitCity: exit.city,
    exitRegion: exit.region,
    exitTimezone: exit.timezone,
    exitAsnOrg: 'Example Broadband',
    exitAt: at,
    osFingerprint: {
      os: 'macos-or-ios',
      confidence: 'high',
      reason: 'matches a Mac or iPhone network stack',
      at,
      observedVia: 'exit_ip',
      // Absent means FALSE (lib/os-fingerprint-verdict.ts): without a vantage
      // that describes the path a website gets, the chip names the OS behind a
      // "?" and asserts nothing. `true` is what unlocks the green match chip.
      ...(os.webPortVantage ? { webPortVantage: true as const } : {}),
    },
    serverLatencyMs: latency.server,
    serverProbeAt: at,
    measuredFrom: 'fleet',
    quicMeasured: 'h3',
    quicMeasuredAt: at,
    quicProbe: true,
    quicProbeAt: at,
    udpProbe: true,
    udpProbeAt: at,
  });
  const tunnelEndpoint = {
    resolved: true,
    ip: '198.51.100.44',
    message: 'Endpoint resolves to 198.51.100.44 — tunnel verified at launch.',
  };
  const gatewayEndpoint = {
    resolved: true,
    ip: '192.0.2.80',
    message: 'Endpoint resolves to 192.0.2.80 — tunnel verified at launch.',
  };
  return {
    // (a) every reading fresh — two minutes old, inside every 30-minute TTL.
    px_audit_socks_fresh: fullReading(
      now - 2 * 60_000,
      {
        ip: '203.0.113.24',
        country: 'NL',
        city: 'Amsterdam',
        region: 'North Holland',
        timezone: 'Europe/Amsterdam',
      },
      { native: 84, server: 41 },
      // The table's best case: the OS reading asserts (green match chip).
      { webPortVantage: true },
    ),
    // (b) the SAME readings five hours old: past the 30-minute TTLs (exit
    // identity, OS, QUIC, UDP), inside the six-hour PROBE_TTL_MS.
    px_audit_socks_aged: fullReading(
      now - 5 * 3_600_000,
      {
        ip: '198.51.100.61',
        country: 'DE',
        city: 'Berlin',
        region: 'Berlin',
        timezone: 'Europe/Berlin',
      },
      { native: 132, server: 96 },
      // No vantage: whenever this aged reading is shown, it is the "?" chip —
      // the two healthy rows cover both OS arms between them.
      { webPortVantage: false },
    ),
    // (c) authenticates and cannot route — the longest sentence the native
    // probe ships (SOCKS5 reply 0x02).
    px_audit_socks_failed: {
      result: {
        reachable: true,
        auth_ok: true,
        udp_associate: false,
        can_route: false,
        connect_reply: 0x02,
        latency_ms: 210,
        message:
          'Authenticates, but cannot route: the proxy refused it: not allowed by its ruleset (usually an expired plan, or a destination/port your provider blocks). Credentials are fine — this proxy will not carry traffic, so a profile launched through it cannot reach anything.',
      },
      at: now - 6 * 60_000,
    },
    // (d) a tunnel that came up: the endpoint verdict + the server-measured
    // fields beside it, UDP measured, QUIC never (no quicProbe / quicMeasured).
    px_audit_wireguard_up: {
      endpoint: tunnelEndpoint,
      result: endpointPlaceholderResult(tunnelEndpoint),
      at: now - 9 * 60_000,
      exitIp: '203.0.113.150',
      exitCountry: 'JP',
      exitCity: 'Tokyo',
      exitRegion: 'Tokyo',
      exitTimezone: 'Asia/Tokyo',
      exitAt: now - 9 * 60_000,
      osFingerprint: { ...unavailableOsFingerprint('vpn_tunnel'), at: now - 9 * 60_000 },
      serverLatencyMs: 58,
      serverProbeAt: now - 9 * 60_000,
      measuredFrom: 'fleet',
      udpProbe: true,
      udpProbeAt: now - 9 * 60_000,
    },
    // (e) px_audit_openvpn_untested has NO entry — never tested.
    // (f) an HTTP row's only check is the endpoint resolve.
    px_audit_http: {
      endpoint: gatewayEndpoint,
      result: endpointPlaceholderResult(gatewayEndpoint),
      at: now - 40 * 60_000,
    },
    // (g) healthy from this Mac, nothing else measured.
    px_audit_socks_long: { result: healthy(118), at: now - 15 * 60_000 },
  };
}

/** The fresh row's measured exit, read off the probe fixture rather than
 *  retyped. It throws when the fixture stops carrying one: an empty marker is
 *  contained in every string, so it would be satisfied by a blank table. */
function auditFreshExitIp(): string {
  const ip = auditProxyProbes()['px_audit_socks_fresh']?.exitIp;
  if (ip === undefined || ip === '')
    throw new Error('visual harness: px_audit_socks_fresh has no exitIp to mark as loaded');
  return ip;
}

/** What each audit scene must have RENDERED for it to count as loaded — the
 *  fixtures the view was fed, read back off the DOM (text nodes + attributes +
 *  input values). Both jsdom arms (tests/unit/marketing-scenes.test.tsx's
 *  privacy scan, tests/unit/profile-phone-card.test.tsx's every-scene stage
 *  arm) require every string here OUTSIDE the window chrome, so an audit scene
 *  whose data never arrived — a stub command that stopped answering, a client
 *  method the view no longer calls, a plugin mock that never reaches the stub
 *  — renders its empty / skeleton state and REDS instead of passing on the
 *  chrome's labels plus its own empty-state copy. Each string is the fixture's,
 *  not a copy of the view's markup; the two copy strings ('Run check',
 *  'Welcome to Driftstack') are the view's own for the two scenes whose loaded
 *  state carries no fixture row. One source: a fixture renamed here moves
 *  both arms with it. */
export function auditLoadedMarkers(name: AuditSceneName): ReadonlyArray<string> {
  switch (name) {
    case 'audit-sessions':
      return [
        ...auditSessions().map((s) => s.label ?? 'Untitled session'),
        ...auditSessions().map((s) => s.id),
      ];
    case 'audit-fleet':
      return auditFleetMembers().flatMap((m) => [m.label, m.baseUrl]);
    case 'audit-recordings':
      return auditRecordings().map((r) => r.label ?? r.sessionId);
    case 'audit-connectivity':
      return [AUDIT_BASE_URL, 'Run check'];
    case 'audit-settings':
      // The base URL the view's connection field holds and the bundled-LLM
      // cap the client returned. NOT FIXTURE_ACCOUNT.email: the account card
      // sits on its unreachable branch (header), so the only place that email
      // renders is the Sidebar's account row — chrome, present in every scene,
      // which would satisfy the marker with the view on its skeleton.
      return [AUDIT_BASE_URL, (auditAccountAi().bundled.monthly_cap_usd_cents / 100).toFixed(2)];
    case 'audit-first-run':
      return ['Welcome to Driftstack'];
    case 'audit-recipes':
      return auditRecipes().map((r) => r.label);
    case 'audit-agent-chat':
      return [...AUDIT_PROFILES.map((p) => p.name), ...auditStoredChats().map((c) => c.title)];
    case 'audit-agent-chat-nokey':
    case 'audit-agent-chat-planning':
    case 'audit-agent-chat-running':
    case 'audit-agent-chat-approval':
    case 'audit-agent-chat-done':
    case 'audit-agent-chat-trouble':
    case 'audit-agent-chat-stopping':
    case 'audit-agent-chat-small':
      // The scene's own fixture strings FIRST, then the two async loads every
      // AI-view scene shares. The order is the point (same reason as
      // audit-proxies below): the fixture chat renders synchronously, so a list
      // ending on one of its sentences would let the privacy scan snapshot the
      // DOM before the profile picker and the saved-chat rail had arrived —
      // green for having read less.
      return [
        ...agentChatFixtureFor(name).markers,
        ...AUDIT_PROFILES.map((p) => p.name),
        ...auditStoredChats().map((c) => c.title),
      ];
    case 'audit-team':
      return [
        ...auditTeam().members.map((m) => m.member_email),
        ...auditTeam().invites.map((i) => i.invitee_email),
      ];
    case 'audit-proxies':
      // The row's label and its endpoint — the endpoint in full even where the
      // cell truncates it, because the cell's own `title` carries it. Rows only
      // exist once `listProxies` has hydrated every secret through the stub.
      // ⛔ The fresh row's measured exit goes LAST, and the order is the point:
      // ProxiesView renders its rows and only THEN awaits the probe cache, and
      // the privacy arm snapshots the DOM the moment the last marker appears. A
      // list ending on a row string lets that scan run before any exit IP,
      // place, or failure sentence is on screen — green for having read less.
      return [
        ...auditProxies().flatMap((p) => [p.label, `${p.host}:${String(p.port)}`]),
        auditFreshExitIp(),
      ];
  }
}

/** The SDK surface the audit views call, answering from the fixtures. Typed
 *  through DriftstackClient so the views see the real shape; the cast is what
 *  every view test in tests/unit does. */
export function buildAuditClient(): DriftstackClient {
  const sessions = auditSessions();
  const agentSessions = auditAgentSessions();
  const team = auditTeam();
  const recipes = auditRecipes();
  const ai = auditAccountAi();
  const client = {
    sessions: {
      list: () => Promise.resolve({ data: sessions, has_more: false, next_cursor: null }),
    },
    agentSessions: {
      list: () => Promise.resolve({ data: agentSessions, has_more: false, next_cursor: null }),
    },
    team: {
      listMembers: () => Promise.resolve({ data: team.members }),
      listInvites: () => Promise.resolve({ data: team.invites }),
    },
    recipes: {
      list: () => Promise.resolve({ data: recipes, next_cursor: null }),
      get: (id: string) => {
        const found = recipes.find((r) => r.id === id);
        return found === undefined
          ? Promise.reject(new Error(`audit fixture: no recipe ${id}`))
          : Promise.resolve({ ...found, intent_log: [] });
      },
    },
    account: {
      getBundledLlmSettings: () => Promise.resolve(ai.bundled),
      getBundledLlmStatus: () => Promise.resolve(ai.status),
      getByokAnthropicKey: () => Promise.resolve(ai.byok),
    },
    profiles: {
      // A sync generator satisfies the view's `for await` (what the
      // agent-chat tests hand it too).
      iterate: function* iterate(): Generator<{ id: string; name: string }, void, void> {
        for (const p of AUDIT_PROFILES) yield p;
      },
    },
  };
  return client as unknown as DriftstackClient;
}

/** The AI-view state scene `name` stands for, and the fixture that drives it.
 *  THROWS on a name that is not one of them rather than falling back to the
 *  idle scene: a silent fallback would render `audit-agent-chat` under a
 *  different name and the gate would report a state it never measured. */
export function agentChatFixtureFor(name: AuditSceneName): AgentChatSceneFixture {
  const kind = AGENT_CHAT_SCENE_KINDS.find(
    (k: AgentChatSceneKind) => name === `audit-agent-chat-${k}`,
  );
  if (kind === undefined) {
    throw new Error(`visual harness: ${name} is not one of the AI view's state scenes`);
  }
  return agentChatSceneFixture(kind, Date.parse(FROZEN_NOW_ISO));
}

/** The audit client plus the ONE method the live view calls that the shared
 *  fixture client deliberately does not carry: the stream token.
 *
 *  A scene with a stand-in never gets here (the panel skips the whole fetch
 *  path). The two that do are the states the stand-in cannot express:
 *  `pending` never settles, which is what "the device is still coming up"
 *  actually looks like, and `failing` rejects the way a dropped connection
 *  does, which is the only route to `WatchPlaceholder`'s error copy and its
 *  `Retry` button — a pinned accessible name that no scene had ever rendered. */
function buildAgentChatClient(liveToken: AgentChatSceneFixture['liveToken']): DriftstackClient {
  const base = buildAuditClient() as unknown as { agentSessions: Record<string, unknown> };
  if (liveToken === undefined) return base as unknown as DriftstackClient;
  const livekitToken =
    liveToken === 'pending'
      ? (): Promise<never> => new Promise<never>(() => undefined)
      : (): Promise<never> => Promise.reject(new Error('Load failed'));
  return {
    ...base,
    agentSessions: { ...base.agentSessions, livekitToken },
  } as unknown as DriftstackClient;
}

// ─── The window-level Tauri stub ─────────────────────────────────────────────

interface TauriInternalsStub {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>;
  /** Marks OUR stub, so a real runtime is never touched and a stale one is
   *  recognised. */
  __auditStub: true;
}

type WindowWithTauri = Window & { __TAURI_INTERNALS__?: TauriInternalsStub | object };

/** Store files the views open, by path — the rid a `plugin:store|load` returns
 *  is the path's index + 1 here, so a Store the plugin cached under an earlier
 *  stub instance still resolves (LazyStore memoises its load per module). */
const STORE_PATHS = [
  'settings.json',
  'agent-chats.json',
  'assistant-templates.json',
  'proxy-probe-cache.json',
] as const;

interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

/** Everything the stub answers from. */
export interface TauriStubFixtures {
  stores: Record<(typeof STORE_PATHS)[number], Record<string, unknown>>;
  files: Record<string, string>;
  dirs: Record<string, ReadonlyArray<DirEntry>>;
  /** `secret_load` answers by key; a key that is not here reads null (nothing
   *  saved), which is what every scene but audit-proxies has always been told. */
  secrets: Record<string, string>;
  appVersion: string;
}

/** The saved proxies, their secrets and the probe cache are fed to the
 *  audit-proxies scene ONLY: the Sidebar counts saved proxies from the same
 *  settings.json in every stubbed scene, and the other scenes' chrome stays as
 *  the gate has always measured it. */
export function auditTauriFixtures(scene?: AuditSceneName): TauriStubFixtures {
  const recordings = auditRecordings();
  const withProxies = scene === 'audit-proxies';
  return {
    stores: {
      'settings.json': {
        fleetMembers: auditFleetMembers(),
        profile_bindings: [],
        proxies: withProxies ? auditProxies() : [],
      },
      'agent-chats.json': { chats: auditStoredChats() },
      'assistant-templates.json': { templates: [] },
      // `probes_schema` at the current version: the one-time backfill has
      // nothing to do, so the load is a pure read.
      'proxy-probe-cache.json': {
        probes: withProxies ? auditProxyProbes() : {},
        probes_schema: PROBE_CACHE_SCHEMA_VERSION,
      },
    },
    files: {
      'recordings/index.json': JSON.stringify(recordings),
    },
    dirs: {
      recordings: recordings.map((r) => ({
        name: `${r.id}.ndjson`,
        isDirectory: false,
        isFile: true,
        isSymlink: false,
      })),
    },
    secrets: withProxies ? auditProxySecrets() : {},
    appVersion: '0.1.49',
  };
}

function argOf(args: unknown, key: string): unknown {
  return typeof args === 'object' && args !== null
    ? (args as Record<string, unknown>)[key]
    : undefined;
}

function storePathForRid(rid: unknown): (typeof STORE_PATHS)[number] {
  const path = typeof rid === 'number' ? STORE_PATHS[rid - 1] : undefined;
  if (path === undefined)
    throw new Error(`audit-scenes Tauri stub: unknown store rid ${String(rid)}`);
  return path;
}

/** Builds the `invoke` the plugins call, answering from `f`. */
export function buildTauriInvoke(f: TauriStubFixtures): TauriInternalsStub['invoke'] {
  return (cmd, args) => {
    try {
      switch (cmd) {
        // plugin-store — Store.load / get / has / keys …; writes acknowledged, dropped.
        case 'plugin:store|load': {
          const path = argOf(args, 'path');
          const idx = (STORE_PATHS as ReadonlyArray<unknown>).indexOf(path);
          if (idx < 0) throw new Error(`audit-scenes Tauri stub: unknown store ${String(path)}`);
          return Promise.resolve(idx + 1);
        }
        case 'plugin:store|get': {
          const store = f.stores[storePathForRid(argOf(args, 'rid'))];
          const key = String(argOf(args, 'key'));
          const has = Object.prototype.hasOwnProperty.call(store, key);
          return Promise.resolve([has ? store[key] : null, has]);
        }
        case 'plugin:store|has': {
          const store = f.stores[storePathForRid(argOf(args, 'rid'))];
          return Promise.resolve(
            Object.prototype.hasOwnProperty.call(store, String(argOf(args, 'key'))),
          );
        }
        case 'plugin:store|keys':
          return Promise.resolve(Object.keys(f.stores[storePathForRid(argOf(args, 'rid'))]));
        case 'plugin:store|values':
          return Promise.resolve(Object.values(f.stores[storePathForRid(argOf(args, 'rid'))]));
        case 'plugin:store|entries':
          return Promise.resolve(Object.entries(f.stores[storePathForRid(argOf(args, 'rid'))]));
        case 'plugin:store|length':
          return Promise.resolve(Object.keys(f.stores[storePathForRid(argOf(args, 'rid'))]).length);
        case 'plugin:store|delete':
          return Promise.resolve(true);
        case 'plugin:store|set':
        case 'plugin:store|save':
        case 'plugin:store|reload':
        case 'plugin:store|clear':
        case 'plugin:store|reset':
          return Promise.resolve(null);
        // plugin-fs — the recordings index + dir, the dev-log mirror's writes.
        case 'plugin:fs|exists': {
          const path = String(argOf(args, 'path'));
          return Promise.resolve(
            Object.prototype.hasOwnProperty.call(f.files, path) ||
              Object.prototype.hasOwnProperty.call(f.dirs, path),
          );
        }
        case 'plugin:fs|read_text_file': {
          const path = String(argOf(args, 'path'));
          if (!Object.prototype.hasOwnProperty.call(f.files, path)) {
            throw new Error(`audit-scenes Tauri stub: no file ${path}`);
          }
          return Promise.resolve(new TextEncoder().encode(f.files[path]));
        }
        case 'plugin:fs|read_dir': {
          const path = String(argOf(args, 'path'));
          if (!Object.prototype.hasOwnProperty.call(f.dirs, path)) {
            throw new Error(`audit-scenes Tauri stub: no directory ${path}`);
          }
          return Promise.resolve(f.dirs[path]);
        }
        case 'plugin:fs|mkdir':
        case 'plugin:fs|write_text_file':
        case 'plugin:fs|write_file':
        case 'plugin:fs|remove':
          return Promise.resolve(null);
        // Commands the app's Rust side answers.
        case 'secret_load': {
          const key = String(argOf(args, 'key'));
          return Promise.resolve(
            Object.prototype.hasOwnProperty.call(f.secrets, key) ? f.secrets[key] : null,
          );
        }
        case 'secret_save':
        case 'secret_delete':
          return Promise.resolve(null);
        case 'plugin:app|version':
          return Promise.resolve(f.appVersion);
        case 'plugin:resources|close':
          return Promise.resolve(null);
        default:
          throw new Error(`audit-scenes Tauri stub: no handler for "${cmd}"`);
      }
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

let pendingRemoval: object | null = null;

/** Puts the stub on `window` unless a REAL runtime (no `__auditStub` mark) is
 *  there. Idempotent; cancels a removal scheduled by a just-unmounted scene. */
export function installTauriStub(fixtures: TauriStubFixtures): void {
  if (typeof window === 'undefined') return;
  pendingRemoval = null;
  const w = window as WindowWithTauri;
  const existing = w.__TAURI_INTERNALS__;
  if (existing !== undefined && !('__auditStub' in existing)) return;
  w.__TAURI_INTERNALS__ = { invoke: buildTauriInvoke(fixtures), __auditStub: true };
}

/** Removes OUR stub one microtask later — a StrictMode remount (or the next
 *  scene) re-installing before that keeps a window with the stub throughout. */
export function scheduleTauriStubRemoval(): void {
  if (typeof window === 'undefined') return;
  const token = {};
  pendingRemoval = token;
  queueMicrotask(() => {
    if (pendingRemoval !== token) return;
    pendingRemoval = null;
    const w = window as WindowWithTauri;
    const existing = w.__TAURI_INTERNALS__;
    if (existing !== undefined && '__auditStub' in existing) delete w.__TAURI_INTERNALS__;
  });
}

export function isAuditTauriStubInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const existing = (window as WindowWithTauri).__TAURI_INTERNALS__;
  return existing !== undefined && '__auditStub' in existing;
}

/** Install in the RENDER phase (a child's mount effect runs before this
 *  component's effects — an effect here would be too late for the first
 *  LazyStore.get), re-install on a StrictMode remount, remove on unmount. */
function useTauriStub(fixtures: TauriStubFixtures): void {
  useState(() => {
    installTauriStub(fixtures);
    return null;
  });
  useEffect(() => {
    installTauriStub(fixtures);
    return () => {
      scheduleTauriStubRemoval();
    };
  }, [fixtures]);
}

// ─── Compositions ────────────────────────────────────────────────────────────

/** SettingsContext overrides every audit window gets: the fixture client and
 *  the example.com base URL. `extra` is merged LAST, for the one view whose
 *  states differ by what the settings say (the AI view's no-key gate) and by
 *  what the client answers (the live view's stream token). */
function useAuditSettings(extra?: Partial<HarnessSettingsValue>): Partial<HarnessSettingsValue> {
  return useMemo(
    () => ({ settings: auditSettings(), client: buildAuditClient(), ...extra }),
    [extra],
  );
}

/** The window chrome + the providers the views need (`useToasts` throws
 *  without ToastProvider; ConfirmProvider is the real dialog). */
function AuditWindow({
  scene,
  current,
  children,
  settingsExtra,
}: {
  scene: AuditSceneName;
  current: Parameters<typeof AppWindow>[0]['current'];
  children: ReactNode;
  settingsExtra?: Partial<HarnessSettingsValue>;
}): JSX.Element {
  const settingsOverrides = useAuditSettings(settingsExtra);
  return (
    <AppWindow
      scene={scene}
      current={current}
      settingsOverrides={settingsOverrides}
      subtitle="self-hosted"
    >
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </AppWindow>
  );
}

/** Same window, with the Tauri stub installed before the view mounts. */
function StubbedAuditWindow(props: {
  scene: AuditSceneName;
  current: Parameters<typeof AppWindow>[0]['current'];
  children: ReactNode;
  settingsExtra?: Partial<HarnessSettingsValue>;
}): JSX.Element {
  const { scene } = props;
  const fixtures = useMemo(() => auditTauriFixtures(scene), [scene]);
  useTauriStub(fixtures);
  return <AuditWindow {...props} />;
}

/** FirstRunWizard replaces the whole window (it renders its own TitleBar and
 *  no Sidebar), so its stage is the bare one — the same data-* contract the
 *  gate and the scene test read, without AppWindow's chrome. The wizard sizes
 *  itself `h-screen w-screen`; the wrapper pins it to the stage instead. */
function FirstRunScene(): JSX.Element {
  const size = auditSceneSizes()['audit-first-run'];
  const settingsValue = useMemo<HarnessSettingsValue>(
    () => ({
      settings: { ...auditSettings(), apiKey: null },
      loading: false,
      client: null,
      activeWorkspace: null,
      setActiveWorkspace: noop,
      accountMe: null,
      refreshAccountMe: noopAsync,
      authExpired: false,
      dismissAuthExpired: noop,
      update: noopAsync,
    }),
    [],
  );
  return (
    <SettingsContext.Provider value={settingsValue}>
      <div
        data-scene="audit-first-run"
        data-ready="1"
        data-frozen-now={FROZEN_NOW_ISO}
        data-stage-width={size.width}
        data-stage-height={size.height}
        style={{ width: size.width, height: size.height }}
        className="relative shrink-0 overflow-hidden bg-surface-base font-sans text-ink-primary antialiased [&>div]:!h-full [&>div]:!w-full"
      >
        <FirstRunWizard onComplete={noop} />
      </div>
    </SettingsContext.Provider>
  );
}

/** The AI view in ONE of its states (spec §8). Everything that differs between
 *  the seven is data: what the chat hook would be publishing, what the settings
 *  say, what the screen is showing. The view, its provider, its window and its
 *  Tauri stub are the same ones `audit-agent-chat` mounts — which is the whole
 *  point, because a replica would pass the gates on its own copy. */
function AgentChatStateScene({ name }: { name: AuditSceneName }): JSX.Element {
  const fixture = useMemo(() => agentChatFixtureFor(name), [name]);
  const settingsExtra = useMemo<Partial<HarnessSettingsValue>>(
    () => ({
      settings: { ...auditSettings(), apiKey: fixture.apiKey },
      client: buildAgentChatClient(fixture.liveToken),
    }),
    [fixture],
  );
  // Only the keys this scene actually overrides — the provider keeps its real
  // `setChatOptions` / `setModel` / `createdAtRef`, so the view's effects run
  // exactly as they do in the app.
  const value = useMemo(() => {
    const v: Partial<AgentChatContextValue> = {};
    if (fixture.chat !== undefined) v.chat = fixture.chat;
    if (fixture.standIn !== undefined) v.standIn = fixture.standIn;
    if (fixture.captureSrc !== undefined) v.captureSrc = fixture.captureSrc;
    return v;
  }, [fixture]);
  return (
    <StubbedAuditWindow scene={name} current="ai" settingsExtra={settingsExtra}>
      <AgentChatProvider value={value}>
        <AgentChatView onGoToSettings={noop} />
      </AgentChatProvider>
    </StubbedAuditWindow>
  );
}

export function AuditScene({ name }: { name: AuditSceneName }): JSX.Element {
  switch (name) {
    case 'audit-sessions':
      return (
        <AuditWindow scene={name} current="sessions">
          <SessionsView onGoToSettings={noop} onGoToProxies={noop} />
        </AuditWindow>
      );
    case 'audit-fleet':
      return (
        <StubbedAuditWindow scene={name} current="fleet">
          <FleetView />
        </StubbedAuditWindow>
      );
    case 'audit-recordings':
      return (
        <StubbedAuditWindow scene={name} current="recordings">
          <RecordingsView onOpen={noop} />
        </StubbedAuditWindow>
      );
    case 'audit-connectivity':
      return (
        <AuditWindow scene={name} current="connectivity">
          <ConnectivityView />
        </AuditWindow>
      );
    case 'audit-settings':
      return (
        <StubbedAuditWindow scene={name} current="settings">
          <SettingsView />
        </StubbedAuditWindow>
      );
    case 'audit-first-run':
      return <FirstRunScene />;
    case 'audit-recipes':
      return (
        <AuditWindow scene={name} current="recipes">
          <RecipesView onGoToAI={noop} onGoToSettings={noop} />
        </AuditWindow>
      );
    case 'audit-agent-chat':
      return (
        <StubbedAuditWindow scene={name} current="ai">
          {/* The chat is owned above the view switch in the real app (B5), so
              the scene has to stand that provider up too — the view reads it
              from context and mounting it bare throws. */}
          <AgentChatProvider>
            <AgentChatView onGoToSettings={noop} />
          </AgentChatProvider>
        </StubbedAuditWindow>
      );
    case 'audit-agent-chat-nokey':
    case 'audit-agent-chat-planning':
    case 'audit-agent-chat-running':
    case 'audit-agent-chat-approval':
    case 'audit-agent-chat-done':
    case 'audit-agent-chat-trouble':
    case 'audit-agent-chat-stopping':
    case 'audit-agent-chat-small':
      return <AgentChatStateScene name={name} />;
    case 'audit-team':
      return (
        <AuditWindow scene={name} current="team">
          <TeamView onGoToSettings={noop} />
        </AuditWindow>
      );
    case 'audit-proxies':
      return (
        <StubbedAuditWindow scene={name} current="proxies">
          <ProxiesView />
        </StubbedAuditWindow>
      );
  }
}
