// Proxy management — protected local registry plus encrypted account sync.
//
// Credentials stay in protected local storage while the GUI is idle. When a
// proxy is selected for a session, the launch path creates or refreshes an
// owner-scoped account_proxies record whose secret fields are encrypted under
// the account key hierarchy.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { EmptyState } from '../components/EmptyState';
import { RelativeTime } from '../components/RelativeTime';
import { Skeleton, SkeletonRegion } from '../components/Skeleton';
import { ProxyCapabilityChips } from '../components/ProxyCapabilities';
import {
  isProxyUsable,
  addProxy,
  listProxies,
  removeProxy,
  resolveEndpoint,
  testProxy,
  updateProxy,
  validateDraft,
  type DraftValidation,
  type EndpointResolveResult,
  type ProxyConfig,
  type ProxyDraft,
  type ProxyTestResult,
} from '../lib/proxies';
import {
  invalidateProbe,
  loadProbeCache,
  saveExitResult,
  saveProbeResult,
} from '../lib/proxy-probe-cache';
import { probeProxyExit, type ProxyExitProbeResult } from '../lib/proxies';
import { parseProxyString } from '../lib/parse-proxy';
import { parseWireGuardConfig } from '../lib/parse-wireguard';
import { validateOpenVpnConfig } from '../lib/parse-openvpn';
import {
  buildWireGuardProxyInput,
  buildOpenVpnProxyInput,
  deleteProxy as deleteAccountProxy,
  type AccountProxyScheme,
} from '../lib/account-proxies';
import { clearBindingsForProxy } from '../lib/profile-bindings';
import { useSettings } from '../lib/SettingsContext';
import { useConfirm } from '../components/ConfirmProvider';
import { humanizeError } from '../lib/humanize-error';

interface ListState {
  proxies: ProxyConfig[];
  loading: boolean;
  error: string | null;
  /** Transient confirmation, e.g. "N profiles were unbound from the deleted proxy". */
  notice: string | null;
}

interface TestAllSummary {
  runId: number;
  text: string;
}

/** Per-scheme display label + icon for a saved-proxy card (P2 #3 — the card used to
 *  hardcode "🔒 SOCKS5" so a VPN/HTTP proxy was MISLABELED). `undefined` scheme is the
 *  legacy SOCKS5 default. */
function schemeLabel(scheme: AccountProxyScheme | undefined): { icon: string; text: string } {
  switch (scheme) {
    case 'openvpn':
      return { icon: '🛡️', text: 'OpenVPN' };
    case 'wireguard':
      return { icon: '🛡️', text: 'WireGuard' };
    case 'http':
      return { icon: '🌐', text: 'HTTP' };
    case 'socks5':
    default:
      return { icon: '🔒', text: 'SOCKS5' };
  }
}

/** Whether the saved-proxy card's Test button can honestly run the native SOCKS5
 *  probe. Only a SOCKS5 (or legacy-undefined) proxy is socks5-probeable; a VPN/HTTP
 *  endpoint has no honest SOCKS5 reachability/auth check (the create flow already
 *  gates Test the same way — VPN does an endpoint DNS resolve, not a SOCKS5 probe). */
function isSocks5Probeable(scheme: AccountProxyScheme | undefined): boolean {
  return scheme === undefined || scheme === 'socks5';
}

function formatTestAllSummary(results: ProxyTestResult[]): string {
  if (results.length === 0) {
    return 'No proxy results landed — run Test all again.';
  }
  const healthy = results.filter((result) => isProxyUsable(result)).length;
  const unreachable = results.filter((result) => !result.reachable).length;
  const authFailed = results.filter((result) => result.reachable && !result.auth_ok).length;
  // Authenticates but will not carry traffic. Counted separately because
  // "auth failed" sends someone to re-check a password that was accepted.
  const cannotRoute = results.filter(
    (result) => result.reachable && result.auth_ok && !result.can_route,
  ).length;
  const parts = [`${String(healthy)} healthy`];
  if (unreachable > 0) parts.push(`${String(unreachable)} unreachable`);
  if (cannotRoute > 0) parts.push(`${String(cannotRoute)} can't route`);
  if (authFailed > 0) {
    parts.push(`${String(authFailed)} auth failure${authFailed === 1 ? '' : 's'}`);
  }
  return `Tested ${String(results.length)} — ${parts.join(', ')}`;
}

const EMPTY_DRAFT: ProxyDraft = {
  label: '',
  scheme: 'socks5',
  host: '',
  port: 1080,
  username: null,
  password: null,
};

export function ProxiesView(): JSX.Element {
  const { settings } = useSettings();
  const confirm = useConfirm();
  const [state, setState] = useState<ListState>({
    proxies: [],
    loading: true,
    error: null,
    notice: null,
  });
  const [editor, setEditor] = useState<
    { kind: 'idle' } | { kind: 'add' } | { kind: 'edit'; id: string }
  >({ kind: 'idle' });
  const [busyId, setBusyId] = useState<string | null>(null);
  // Saving a proxy can write the encrypted local vault and then refresh the
  // registry. A state-only guard lands one render too late for two same-turn
  // submit events, so the ref is the authoritative single-flight latch while
  // `saving` drives the visible/accessible busy state.
  const saveInFlightRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // Native SOCKS5 probe per saved proxy — reachability + UDP-associate
  // support. Keyed by proxy id so each row keeps its own last result.
  const [testingId, setTestingId] = useState<string | null>(null);
  // Epoch token for in-flight probes: bumped when a proxy is edited (endpoint
  // changed) or removed, so a slow probe that started against the OLD endpoint
  // discards its result instead of re-advertising stale reachability/geo.
  const testEpochRef = useRef(0);
  // E-2 exit-geo: per-proxy echo result. A null entry means the probe ran and
  // returned nothing. Both dependencies this note once blamed shipped on
  // 2026-06-12 (V-857), so a null now means this proxy did not complete the
  // echo round-trip — a real fault on the customer's side, not pending work.
  const [exitResults, setExitResults] = useState<Record<string, ProxyExitProbeResult | null>>({});
  const [testResults, setTestResults] = useState<Record<string, ProxyTestResult>>({});
  // Epoch-ms timestamp of each proxy's last probe (from the cache `at` field), so
  // the card can show "tested <relative>" — a green 'healthy' pill is meaningless
  // without knowing whether the test ran 30s or 30 days ago (audit).
  const [testedAt, setTestedAt] = useState<Record<string, number>>({});
  const [testAllSummary, setTestAllSummary] = useState<TestAllSummary | null>(null);
  // A ref closes the one-render gap before `testingAll` disables the button. It
  // also owns the eventual summary, so an abandoned/stale sweep cannot announce
  // after a newer one has taken its place.
  const activeTestAllRunRef = useRef<number | null>(null);
  const nextTestAllRunRef = useRef(1);

  useEffect(() => {
    if (testAllSummary === null) return;
    const { runId } = testAllSummary;
    const id = window.setTimeout(() => {
      setTestAllSummary((current) => (current?.runId === runId ? null : current));
    }, 5000);
    return () => window.clearTimeout(id);
  }, [testAllSummary]);

  useEffect(
    () => () => {
      activeTestAllRunRef.current = null;
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const proxies = await listProxies();
      setState((s) => ({ ...s, proxies, loading: false, error: null }));
      // Hydrate the LAST persisted probe result per proxy so a tested proxy
      // keeps showing its reachability / UDP / exit-geo across visits instead
      // of reverting to "untested" + needing a re-test every time (the cache
      // was written by saveProbeResult/saveExitResult but never read back here).
      const cache = await loadProbeCache();
      const tr: Record<string, ProxyTestResult> = {};
      const er: Record<string, ProxyExitProbeResult | null> = {};
      const ta: Record<string, number> = {};
      for (const [id, c] of Object.entries(cache)) {
        tr[id] = c.result;
        if (typeof c.at === 'number') ta[id] = c.at;
        // Only re-hydrate exit-geo when the LAST capability probe was healthy.
        // saveProbeResult preserves the prior exitIp/country across a failed
        // re-test (capability + exit probes are separate), so a proxy that was
        // healthy (exit IP cached) then went down would, after a reload, show its
        // STALE exit IP + country flag next to the red "unreachable" pill — a
        // misleading "exits from US 1.2.3.4" for a dead proxy. In-session
        // handleTest already drops the exit on a failed probe; this matches that
        // for the reload path.
        if (c.exitIp !== undefined && isProxyUsable(c.result)) {
          er[id] = {
            ip: c.exitIp,
            country: c.exitCountry ?? null,
            ...(c.exitCity !== undefined ? { city: c.exitCity } : {}),
            ...(c.exitRegion !== undefined ? { region: c.exitRegion } : {}),
            ...(c.exitTimezone !== undefined ? { timezone: c.exitTimezone } : {}),
            ...(c.exitAsnOrg !== undefined ? { asn_org: c.exitAsnOrg } : {}),
          };
        }
      }
      setTestResults(tr);
      setExitResults(er);
      setTestedAt(ta);
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: friendlyError(err, "Couldn't load proxies. Try again."),
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSave(draft: ProxyDraft): Promise<void> {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      // Which proxy, if any, to test once this save lands. The moment a customer
      // enters a proxy is the moment to find out it cannot route — not the moment
      // they launch a profile through it and watch the session fail.
      let testAfterSave: 'added' | 'edited' | null = null;
      if (editor.kind === 'add') {
        await addProxy(draft);
        testAfterSave = 'added';
      } else if (editor.kind === 'edit') {
        const editId = editor.id;
        const prev = state.proxies.find((p) => p.id === editId);
        await updateProxy(editId, draft);
        // If the connection target changed, the cached probe (capability +
        // exit-geo) no longer describes this proxy — drop it so cards fall
        // back to the honest "untested" state until the next Test, rather
        // than advertising the OLD endpoint's reachability/UDP/exit-geo.
        // A label-only rename keeps the probe (same endpoint).
        const connChanged =
          prev === undefined ||
          prev.host !== draft.host ||
          prev.port !== draft.port ||
          prev.username !== draft.username ||
          prev.password !== draft.password;
        if (connChanged) {
          testEpochRef.current++; // discard any in-flight probe against the old endpoint
          void invalidateProbe(editId).catch(() => undefined);
          setTestResults((r) => dropKey(r, editId));
          setExitResults((r) => dropKey(r, editId));
          // Invalidating alone leaves the row with NO verdict, which reads as
          // "untested" rather than "the endpoint changed" — and the next launch
          // is where that gets discovered. Re-test instead.
          testAfterSave = 'edited';
        }
      }
      await refresh();
      // Keep the form mounted and locked through refresh so the customer never
      // sees an editable draft while the just-saved registry is still settling.
      const editedId = editor.kind === 'edit' ? editor.id : null;
      setEditor({ kind: 'idle' });
      if (testAfterSave !== null) {
        // Re-list rather than reading component state: setState from refresh has
        // not committed yet, so state.proxies here is still the PREVIOUS registry
        // and would not contain a row that was just added.
        const fresh = await listProxies().catch(() => null);
        const target =
          fresh === null
            ? undefined
            : testAfterSave === 'added'
              ? // addProxy does not return the created row, so match on the tuple
                // the customer just entered. Host+port+username is what identifies
                // an endpoint here; two rows differing only by password would be
                // the same endpoint anyway.
                fresh.find(
                  (p) =>
                    p.host === draft.host && p.port === draft.port && p.username === draft.username,
                )
              : fresh.find((p) => p.id === editedId);
        // Best-effort: a probe that cannot run must never make a successful save
        // look failed. This block IS inside the save's try — it has to be, so it
        // runs only on a save that actually landed — so the isolation comes from
        // the two catches above and below, not from the structure: `listProxies`
        // degrades to null and the probe is fire-and-forget. Drop either catch
        // and a proxy that saved fine reports "Couldn't save this proxy", which
        // is the one outcome this whole path exists to avoid.
        // handleTest owns its own epoch guard, so an edit or removal landing
        // mid-probe discards the result rather than writing it to the wrong row.
        if (target !== undefined) void handleTest(target).catch(() => undefined);
      }
    } catch (err) {
      setState((s) => ({
        ...s,
        error: friendlyError(err, "Couldn't save this proxy. Check the details and try again."),
      }));
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  async function handleRemove(id: string): Promise<void> {
    if (
      !(await confirm(
        'Remove this proxy? Any profiles using it as a default will be unbound and must be re-bound before launching.',
        { confirmLabel: 'Remove', tone: 'danger' },
      ))
    )
      return;
    setBusyId(id);
    try {
      // Capture the server-side account_proxies id (set on first launch-sync)
      // BEFORE the local entry is wiped, so we can also delete the encrypted
      // server row. Without this the wrapped password / VPN secret orphans on
      // the server forever after a local delete — a credential-hygiene leak for
      // an anti-detect tool, and a CRUD desync (the proxy is "gone" locally but
      // still resolvable server-side by its id).
      const removed = state.proxies.find((p) => p.id === id);
      await removeProxy(id);
      // Best-effort server delete: the account row deletion must not block the
      // local remove (offline / unauth still leaves the operator with the proxy
      // gone locally). deleteAccountProxy treats a 404 as already-gone.
      if (
        removed?.serverId !== undefined &&
        settings.apiKey !== null &&
        settings.apiKey.length > 0
      ) {
        void deleteAccountProxy(settings.baseUrl, settings.apiKey, removed.serverId).catch(
          (err: unknown) => {
            console.warn('[proxies] failed to delete server-side proxy row', err);
          },
        );
      }
      testEpochRef.current++; // discard any in-flight probe for the removed proxy
      // Drop the cached probe too, else its exit-IP/geo orphans in the
      // cache (and a future re-minted id could inherit stale geo).
      void invalidateProbe(id).catch(() => undefined);
      setTestResults((r) => dropKey(r, id));
      setExitResults((r) => dropKey(r, id));
      // Clear any profile default-proxy bindings that referenced this proxy, so a
      // profile bound to it doesn't keep a DANGLING defaultProxyId. Without this,
      // Launch would silently reroute that profile's egress to a different proxy
      // (or, post-fix, refuse to launch) with no trace of why — a privacy hazard
      // for an anti-detect tool. Surface which profiles were unbound so the
      // operator knows to re-bind a proxy on purpose.
      let unbound: string[] = [];
      try {
        unbound = await clearBindingsForProxy(id);
      } catch (err) {
        console.warn('[proxies] failed to clear dangling bindings for deleted proxy', err);
      }
      await refresh();
      if (unbound.length > 0) {
        const n = unbound.length;
        setState((s) => ({
          ...s,
          notice: `${String(n)} profile${n === 1 ? '' : 's'} ${
            n === 1 ? 'was' : 'were'
          } using this proxy as a default — they now have no default proxy. Re-bind one before launching.`,
        }));
      }
    } catch (err) {
      setState((s) => ({
        ...s,
        error: friendlyError(err, "Couldn't remove this proxy. Try again."),
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleTest(p: ProxyConfig): Promise<ProxyTestResult | null> {
    const epoch = ++testEpochRef.current; // claim this probe; an edit/remove bumps it
    const stale = (): boolean => testEpochRef.current !== epoch;
    setTestingId(p.id);
    try {
      const result = await testProxy({
        host: p.host,
        port: p.port,
        username: p.username,
        password: p.password,
      });
      if (stale()) return null; // proxy endpoint changed/removed mid-probe → discard
      const probedAt = Date.now();
      setTestResults((r) => ({ ...r, [p.id]: result }));
      setTestedAt((t) => ({ ...t, [p.id]: probedAt }));
      // Night-arc B: persist so profile cards can render egress
      // capability (UDP badge) without re-probing. Best-effort.
      void saveProbeResult(p.id, result, probedAt).catch(() => undefined);
      // E-2: exit-geo through the proxy. A null result is a genuine probe
      // failure (V-857) rather than a missing dependency, and the card says so.
      if (isProxyUsable(result)) {
        const exit = await probeProxyExit({
          host: p.host,
          port: p.port,
          username: p.username,
          password: p.password,
        });
        if (stale()) return null;
        setExitResults((r) => ({ ...r, [p.id]: exit }));
        if (exit !== null) {
          // Persist the FULL geo enrichment (city/region/timezone/asn), not just
          // ip/country — mirrors ProfilesView so the Profiles hub + a reload show
          // the same exit location for a proxy tested from here.
          void saveExitResult(p.id, exit.ip, exit.country, {
            city: exit.city ?? null,
            region: exit.region ?? null,
            timezone: exit.timezone ?? null,
            asnOrg: exit.asn_org ?? null,
          }).catch(() => undefined);
        }
      } else {
        // Proxy is no longer usable (not reachable / auth failed) — drop any
        // exit-geo from a prior successful probe so the card can't show a
        // stale "exit IP · country" next to "Auth failed" / "Not reachable".
        setExitResults((r) => dropKey(r, p.id));
      }
      return result;
    } catch (err) {
      if (stale()) return null;
      const result: ProxyTestResult = {
        reachable: false,
        auth_ok: false,
        udp_associate: false,
        // A synthesised result is not evidence of routing. Fail closed: an
        // unknown proxy must never inherit a usable verdict by omission.
        can_route: false,
        connect_reply: 0xff,
        latency_ms: 0,
        message: humanizeError(err, "Couldn't test this proxy. Check the details and try again."),
      };
      setTestResults((r) => ({ ...r, [p.id]: result }));
      setExitResults((r) => dropKey(r, p.id));
      return result;
    } finally {
      // Always clear the spinner for the id THIS probe owns — even when a
      // mid-probe edit/remove bumped the epoch (stale()). The stale-guard's
      // early returns above skip the state writes, but the card must not stay
      // pinned on a spinning 'Testing…'; scope the clear so a newer probe that
      // re-armed testingId to another id isn't stomped.
      setTestingId((cur) => (cur === p.id ? null : cur));
    }
  }

  // Capability-board port (approved proxy-health demo, 2026-06-12):
  // probe ALL saved proxies sequentially. Sequential by design — the
  // native probe opens real sockets; parallel probes through consumer
  // egress endpoints skew each other's latency numbers.
  const [testingAll, setTestingAll] = useState(false);
  async function handleTestAll(): Promise<void> {
    // `disabled` is state-driven and therefore takes one render to land. Guard
    // synchronously too, so a double activation cannot start two socket sweeps.
    if (activeTestAllRunRef.current !== null) return;
    const targets = state.proxies.filter((p) => isSocks5Probeable(p.scheme));
    // Normally unreachable through the disabled button, but keep direct/rapid
    // invocation honest: zero probes should not flash busy or claim completion.
    if (targets.length === 0) return;

    const runId = nextTestAllRunRef.current++;
    activeTestAllRunRef.current = runId;
    setTestAllSummary(null);
    setTestingAll(true);
    const results: ProxyTestResult[] = [];
    try {
      // Only SOCKS5 (or legacy-undefined) proxies have an honest native SOCKS5
      // probe. Running it against a VPN/HTTP endpoint always returns a false
      // negative, so `targets` deliberately excludes them.
      for (const p of targets) {
        const result = await handleTest(p);
        // A proxy edited/removed during its probe returns null. Do not inflate
        // the completed count with a result that was deliberately discarded.
        if (result !== null) results.push(result);
      }
    } finally {
      if (activeTestAllRunRef.current === runId) {
        activeTestAllRunRef.current = null;
        setTestingAll(false);
        setTestAllSummary({ runId, text: formatTestAllSummary(results) });
      }
    }
  }

  // Only SOCKS5 proxies have an honest native probe (VPN/HTTP verify at launch). When
  // NONE are probeable, "Test all" would flip on→off running zero probes with no feedback
  // — a dead button (audit 2026-07-08); disable it with an explaining title instead.
  const probeableCount = state.proxies.filter((p) => isSocks5Probeable(p.scheme)).length;
  const tested = state.proxies.filter((p) => testResults[p.id] !== undefined);
  const healthy = tested.filter((p) => {
    const r = testResults[p.id];
    return r !== undefined && r.reachable && r.auth_ok;
  });
  const udpCapable = tested.filter((p) => {
    const r = testResults[p.id];
    return r !== undefined && r.udp_associate;
  });

  const editing =
    editor.kind === 'edit' ? (state.proxies.find((p) => p.id === editor.id) ?? null) : null;

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* HERO strip (console.html) — section-label + title with at-a-glance
          context on the left; quiet Test-all + primary New-proxy on the
          right. Mirrors the Profiles hub hero rhythm. */}
      <div
        data-component="proxies-hero"
        className="flex flex-wrap items-start gap-4 border-b border-surface-divider pb-3"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-lg text-accent ring-1 ring-accent/25">
            🌍
          </span>
          <div className="min-w-0">
            <span className="section-label text-accent">Network egress</span>
            <h2 className="mt-0.5 text-[19px] font-semibold tracking-tight text-ink-primary">
              Egress proxies
              <span className="mono ml-2 text-base font-normal text-ink-muted">
                {state.proxies.length}
              </span>
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
              {tested.length > 0 ? (
                <>
                  <b className="font-semibold text-status-ready">{healthy.length}</b> healthy
                  <span className="text-surface-divider">·</span>
                  <b className="font-semibold text-ink-primary">{udpCapable.length}</b> WebRTC +
                  QUIC
                  <span className="text-surface-divider">·</span>
                  <span className="text-ink-muted">
                    protected locally · encrypted sync at launch
                  </span>
                </>
              ) : (
                <span className="text-ink-muted">
                  Protected locally on this device · synced encrypted when used for a session.
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {state.proxies.length > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleTestAll()}
              disabled={testingAll || testingId !== null || probeableCount === 0}
              title={
                probeableCount === 0
                  ? 'No SOCKS5 proxies to test — VPN/HTTP endpoints are verified at launch'
                  : undefined
              }
            >
              {testingAll ? 'Testing all…' : 'Test all'}
            </button>
          )}
          <button
            type="button"
            className="btn-primary flex items-center gap-1.5"
            onClick={() => {
              if (!saveInFlightRef.current) setEditor({ kind: 'add' });
            }}
            disabled={saving}
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
            <span>New proxy</span>
          </button>
        </div>
      </div>

      {/* Add/Edit form renders FIRST (right under the hero) when open, so it's
          immediately in view — no scrolling past the list, no clipped bottom
          (the whole page scrolls inside the app's <main overflow-auto>). */}
      {(editor.kind === 'add' || editor.kind === 'edit') && (
        <ProxyForm
          // Identity-bound key → the form REMOUNTS when the edit target changes,
          // so switching Edit A → Edit B (the list stays clickable below) reseeds
          // the draft instead of writing A's host/port/creds onto B.
          key={editor.kind === 'edit' ? editor.id : 'add'}
          initial={editing !== null ? toDraft(editing) : EMPTY_DRAFT}
          mode={editor.kind}
          saving={saving}
          onCancel={() => {
            if (!saveInFlightRef.current) setEditor({ kind: 'idle' });
          }}
          onSave={handleSave}
        />
      )}

      {/* Pool summary — hidden while the form is open (it's noise then; founder:
          the stats shouldn't show when New proxy is clicked) + only over TESTED
          proxies (no fabricated health for never-probed entries). */}
      {tested.length > 0 && editor.kind === 'idle' && (
        <div
          data-component="proxy-pool-stats"
          className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-surface-divider bg-surface-divider"
        >
          <PoolStat k="Tested" v={`${String(tested.length)} / ${String(state.proxies.length)}`} />
          <PoolStat k="Healthy" v={String(healthy.length)} tone="ok" />
          <PoolStat k="WebRTC + QUIC" v={String(udpCapable.length)} tone="ok" />
        </div>
      )}

      {state.error !== null && (
        <ErrorBanner
          message={state.error}
          onRetry={() => void refresh()}
          retrying={state.loading}
          onDismiss={() => setState((s) => ({ ...s, error: null }))}
        />
      )}

      {state.notice !== null && (
        <div
          role="status"
          data-component="proxy-notice"
          className="flex items-start justify-between gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-xs text-ink-primary"
        >
          <span>{state.notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="px-1 leading-none text-ink-muted hover:text-ink-primary"
            onClick={() => setState((s) => ({ ...s, notice: null }))}
          >
            ×
          </button>
        </div>
      )}

      {testAllSummary !== null && (
        <div
          role="status"
          aria-live="polite"
          data-component="proxy-test-all-summary"
          className="flex items-start justify-between gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-xs text-ink-primary"
        >
          <span>{testAllSummary.text}</span>
          <button
            type="button"
            aria-label="Dismiss test summary"
            className="px-1 leading-none text-ink-muted hover:text-ink-primary"
            onClick={() => setTestAllSummary(null)}
          >
            ×
          </button>
        </div>
      )}

      {state.proxies.length === 0 ? (
        <Empty loading={state.loading} onAdd={() => setEditor({ kind: 'add' })} />
      ) : (
        <ProxyList
          proxies={state.proxies}
          busyId={busyId}
          testingId={testingId}
          testingAll={testingAll}
          testResults={testResults}
          exitResults={exitResults}
          testedAt={testedAt}
          onEdit={(id) => setEditor({ kind: 'edit', id })}
          onRemove={(id) => void handleRemove(id)}
          onTest={(p) => void handleTest(p)}
        />
      )}
    </div>
  );
}

// ─── subcomponents ────────────────────────────────────────────────

function Empty({ loading, onAdd }: { loading: boolean; onAdd: () => void }): JSX.Element {
  if (loading) {
    return <ProxyListSkeleton />;
  }
  return (
    <EmptyState
      icon={
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2v6m0 8v6M4.93 4.93l4.24 4.24m5.66 5.66l4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66l4.24-4.24" />
        </svg>
      }
      title="No proxies configured"
      description="Add a SOCKS5 endpoint to route session traffic through your own egress IP. Proxy credentials are protected locally and synced in encrypted form to your account when used for a session."
      action={
        <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={onAdd}>
          Add a proxy
        </button>
      }
    />
  );
}

/** Card-shaped first-load state that occupies the same responsive grid as ProxyList. */
function ProxyListSkeleton(): JSX.Element {
  return (
    <SkeletonRegion label="Loading proxies">
      <div
        data-component="proxy-list-skeleton"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {Array.from({ length: 4 }).map((_, index) => (
          <article
            key={index}
            className="flex min-h-40 flex-col gap-2.5 rounded-lg border border-surface-divider bg-surface-raised p-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-2.5 w-2/5" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>

            <div className="flex flex-col gap-2 rounded-lg border border-surface-divider/60 p-2">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-2.5 w-14" />
              </div>
              <Skeleton className="h-2.5 w-3/4" />
              <div className="flex gap-1.5">
                <Skeleton className="h-4 w-14 rounded-sm" />
                <Skeleton className="h-4 w-10 rounded-sm" />
                <Skeleton className="h-4 w-12 rounded-sm" />
              </div>
            </div>

            <div className="mt-auto flex items-center gap-2 pt-1">
              <Skeleton className="h-7 flex-1" />
              <Skeleton className="h-7 w-10" />
              <Skeleton className="h-7 w-14" />
            </div>
          </article>
        ))}
      </div>
    </SkeletonRegion>
  );
}

function ProxyList({
  proxies,
  busyId,
  testingId,
  testingAll,
  testResults,
  exitResults,
  testedAt,
  onEdit,
  onRemove,
  onTest,
}: {
  proxies: ProxyConfig[];
  busyId: string | null;
  testingId: string | null;
  testingAll: boolean;
  testResults: Record<string, ProxyTestResult>;
  exitResults: Record<string, ProxyExitProbeResult | null>;
  testedAt: Record<string, number>;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onTest: (p: ProxyConfig) => void;
}): JSX.Element {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {proxies.map((p) => (
        <ProxyCard
          key={p.id}
          proxy={p}
          busy={busyId === p.id}
          testing={testingId === p.id}
          // During a Test-all the whole row is locked so a stray per-card click
          // can't spawn a concurrent probe that clobbers the shared spinner.
          testingAll={testingAll}
          result={testResults[p.id]}
          exit={p.id in exitResults ? exitResults[p.id] : undefined}
          testedAt={testedAt[p.id]}
          onEdit={() => onEdit(p.id)}
          onRemove={() => onRemove(p.id)}
          onTest={() => onTest(p)}
        />
      ))}
    </div>
  );
}

// Console proxy card — mirrors the Profiles hub proxy-row treatment:
// country flag + exit IP (mono) + latency + inline meter + health pill +
// UDP badge + last-checked, with Test / Edit / Remove as quiet actions.
// All facts come from the REAL probe result (no fabricated health).
function ProxyCard({
  proxy: p,
  busy,
  testing,
  testingAll,
  result,
  exit,
  testedAt,
  onEdit,
  onRemove,
  onTest,
}: {
  proxy: ProxyConfig;
  busy: boolean;
  testing: boolean;
  testingAll: boolean;
  result: ProxyTestResult | undefined;
  // undefined = exit-geo never recorded for this proxy; null = probed, and the
  // echo round-trip did not complete through this proxy (V-857).
  exit: ProxyExitProbeResult | null | undefined;
  /** Epoch-ms of the last probe (undefined = never tested). Drives the
   *  "tested <relative>" staleness line so a green pill isn't read as fresh. */
  testedAt: number | undefined;
  onEdit: () => void;
  onRemove: () => void;
  onTest: () => void;
}): JSX.Element {
  const reachable = result?.reachable ?? false;
  const authOk = result?.auth_ok ?? false;
  const healthy = reachable && authOk;
  const lat = result?.latency_ms;
  // latency meter fill: 0–250ms mapped to 0–100% (clamped). Mirrors the
  // hub card's latFill mapping.
  const latFill = lat !== undefined && lat > 0 ? Math.max(6, Math.min(100, (lat / 250) * 100)) : 0;
  const latGood = lat !== undefined && lat <= 100;
  const exitIp = exit?.ip;
  const exitCountry = exit?.country ?? null;

  return (
    <article
      className={`group flex flex-col gap-2.5 rounded-lg border bg-surface-raised p-3 transition-all hover:-translate-y-px hover:shadow-md ${
        result === undefined
          ? 'border-surface-divider hover:border-ink-muted/60'
          : healthy
            ? 'border-status-ready/50 hover:border-status-ready'
            : 'border-status-error/40 hover:border-status-error/60'
      }`}
    >
      {/* HEADER — label + health pill on the right. */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold tracking-tight text-ink-primary">
            {p.label}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-[10.5px] text-ink-muted">
            {/* P2 #3 — label by the proxy's ACTUAL scheme (was hardcoded SOCKS5 →
                a VPN/HTTP proxy read as SOCKS5). */}
            <span aria-hidden="true">{schemeLabel(p.scheme).icon}</span>
            {schemeLabel(p.scheme).text}
            {p.username !== null && p.username.length > 0 && (
              <>
                <span className="text-surface-divider">·</span>
                <span className="mono truncate">{p.username}</span>
              </>
            )}
          </p>
        </div>
        <HealthPill result={result} healthy={healthy} latGood={latGood} />
      </div>

      {/* PROXY row — flag + exit IP (mono) + latency + inline meter, on a
          surface-inset panel, exactly like the hub card. Honest 'untested'
          when never probed. */}
      <div className="flex flex-col gap-1 rounded-lg bg-surface-inset px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-[13px] leading-none">
            {exitCountry !== null ? flagEmoji(exitCountry) : '🌍'}
          </span>
          <span
            className={`min-w-0 truncate text-[10.5px] ${
              exitIp !== undefined ? 'mono text-ink-secondary' : 'italic text-ink-muted'
            }`}
          >
            {/* Real EXIT IP from the geo probe, not the local SOCKS5 forward. */}
            {exitIp ?? 'run Test for exit IP'}
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-ink-muted">
            {lat !== undefined && reachable ? (
              <>
                <span className="mono">{lat}ms</span>
                <span className="inline-block h-1 w-[34px] overflow-hidden rounded-[2px] bg-surface-divider">
                  <span
                    className="block h-full rounded-[2px]"
                    style={{
                      width: `${latFill.toFixed(0)}%`,
                      background: latGood
                        ? 'rgb(var(--status-ready-rgb))'
                        : 'rgb(var(--status-busy-rgb))',
                    }}
                  />
                </span>
              </>
            ) : (
              <span className="mono opacity-60">{result !== undefined ? 'down' : '—'}</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="mono truncate text-[10px] text-ink-muted">
            {p.host}:{p.port}
          </span>
          <span className="ml-auto shrink-0 text-[9.5px] text-ink-muted">
            {/* Show when the probe last ran (not when the proxy was ADDED) once
                tested — a green pill is meaningless without it. Falls back to the
                Added time only when never tested. */}
            {result !== undefined && testedAt !== undefined ? (
              <RelativeTime iso={new Date(testedAt).toISOString()} tooltipPrefix="Tested" />
            ) : (
              <RelativeTime iso={p.createdAt} tooltipPrefix="Added" />
            )}
          </span>
        </div>
        {/* Protocol capabilities — honest "Has WebRTC / QUIC / HTTP-2"
            breakdown derived from the probe (replaces the bare UDP badge). */}
        {result !== undefined && reachable ? (
          <ProxyCapabilityChips result={result} size="xs" />
        ) : (
          <span
            className="w-fit rounded-sm bg-surface-divider/60 px-1 py-px text-[9px] text-ink-muted"
            title={
              result !== undefined
                ? 'Exit down on last test — no protocols verified.'
                : 'Never probed — click Test to check egress protocols.'
            }
          >
            {result !== undefined ? 'no egress' : 'untested'}
          </span>
        )}
      </div>

      {/* TEST DETAIL — shown only once probed. Exit-geo line + QUIC/WebRTC
          derivation + the raw probe message, all from the real result. */}
      {result !== undefined && (
        <div role="status" className="flex flex-col gap-1 text-[10px]">
          {healthy && exit !== undefined && (
            <span className="text-ink-secondary">
              {exit !== null ? (
                <>
                  exit <span className="mono">{exit.ip}</span>
                  {exit.country !== null && ` · ${exit.country}`}
                </>
              ) : (
                'exit geo unavailable — the probe did not complete'
              )}
            </span>
          )}
          {result.message.length > 0 && (
            <span
              className={`truncate ${healthy ? 'text-ink-muted' : 'text-status-error'}`}
              title={result.message}
            >
              {result.message}
            </span>
          )}
        </div>
      )}

      {/* ACTIONS — Test is the primary affordance; Edit / Remove are quiet. */}
      <div className="mt-auto flex items-center gap-2 pt-1">
        {/* P2 #3 — the card Test runs a SOCKS5 probe, which is meaningless for a
            VPN/HTTP endpoint (it always read "unreachable"). Only offer it for a
            SOCKS5 proxy; otherwise show a clear note (the tunnel verifies at launch),
            mirroring the create flow which gates the SOCKS5 probe to socks5. */}
        {isSocks5Probeable(p.scheme) ? (
          <button
            type="button"
            className="btn-primary flex-1 text-xs"
            onClick={onTest}
            disabled={testing || testingAll}
          >
            {testing ? 'Testing…' : result !== undefined ? 'Re-test' : 'Test'}
          </button>
        ) : (
          <span
            className="flex-1 text-[10px] italic text-ink-muted"
            title="A VPN/HTTP endpoint has no SOCKS5 reachability probe — the tunnel verifies when a session launches."
          >
            Verified at launch
          </span>
        )}
        <button
          type="button"
          className="text-xs text-ink-muted transition-colors hover:text-ink-primary"
          onClick={onEdit}
        >
          Edit
        </button>
        <button
          type="button"
          className="text-xs text-ink-muted transition-colors hover:text-status-error disabled:opacity-60"
          onClick={onRemove}
          disabled={busy}
        >
          {busy ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </article>
  );
}

// Health pill — the single at-a-glance verdict for a proxy card. Quiet
// 'untested' before the first probe; ready/error tone after.
function HealthPill({
  result,
  healthy,
  latGood,
}: {
  result: ProxyTestResult | undefined;
  healthy: boolean;
  latGood: boolean;
}): JSX.Element {
  if (result === undefined) {
    return (
      <span className="shrink-0 rounded-[5px] bg-surface-inset px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink-muted">
        untested
      </span>
    );
  }
  if (!healthy) {
    const label = result.reachable ? 'auth fail' : 'unreachable';
    return (
      <span className="shrink-0 rounded-[5px] bg-status-error/12 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-status-error">
        {label}
      </span>
    );
  }
  return (
    <span
      className={`shrink-0 rounded-[5px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
        latGood ? 'bg-status-ready/12 text-status-ready' : 'bg-status-busy/14 text-status-busy'
      }`}
    >
      {latGood ? 'healthy' : 'slow'}
    </span>
  );
}

export function ProxyForm({
  initial,
  mode,
  saving = false,
  onCancel,
  onSave,
}: {
  initial: ProxyDraft;
  mode: 'add' | 'edit';
  saving?: boolean;
  onCancel: () => void;
  onSave: (d: ProxyDraft) => void | Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState<ProxyDraft>(initial);
  const [validation, setValidation] = useState<DraftValidation>({ ok: true, errors: {} });
  const [pasteVal, setPasteVal] = useState('');
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  // OVPN/WG — the wg0.conf textarea text (the parsed WG block doesn't retain
  // the raw conf; OpenVPN keeps its blob in draft.openvpn.config_blob) + a
  // parse-feedback hint.
  const [wgText, setWgText] = useState(initial.wireguard ? '(saved WireGuard config)' : '');
  const [vpnHint, setVpnHint] = useState<string | null>(null);
  const submitInFlightRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = saving || submitting;
  const formRef = useRef<HTMLFormElement>(null);

  // React 18's DOM types do not expose the standard `inert` attribute yet.
  // Apply its presence imperatively so every draft control (including file
  // inputs and a field that retained keyboard focus) is genuinely non-interactive
  // while the save settles, without re-indenting the whole form in a fieldset.
  useEffect(() => {
    const form = formRef.current;
    if (form === null) return;
    if (locked) form.setAttribute('inert', '');
    else form.removeAttribute('inert');
  }, [locked]);

  const scheme = draft.scheme ?? 'socks5';
  const isVpn = scheme === 'openvpn' || scheme === 'wireguard';

  function setField<K extends keyof ProxyDraft>(key: K, value: ProxyDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // Switch proxy type — clear the now-irrelevant fields so a half-typed socks5
  // password can't ride along on a VPN proxy (and vice versa).
  function handleSchemeChange(next: NonNullable<ProxyDraft['scheme']>): void {
    setVpnHint(null);
    setWgText('');
    setDraft((d) => ({
      ...d,
      scheme: next,
      ...(next === 'openvpn' || next === 'wireguard'
        ? { username: null, password: null }
        : { openvpn: undefined, wireguard: undefined }),
    }));
  }

  // wg0.conf paste → parse + build → fill host/port (endpoint) + the WG block.
  function handleWgPaste(text: string): void {
    setWgText(text);
    if (text.trim() === '') {
      setVpnHint(null);
      setDraft((d) => ({ ...d, wireguard: undefined }));
      return;
    }
    const built = buildWireGuardProxyInput(draft.label, parseWireGuardConfig(text));
    if ('error' in built) {
      setVpnHint(built.error);
      setDraft((d) => ({ ...d, wireguard: undefined }));
      return;
    }
    setDraft((d) => ({
      ...d,
      scheme: 'wireguard',
      host: built.host,
      port: built.port,
      wireguard: built.wireguard,
    }));
    setVpnHint(`✓ endpoint ${built.host}:${built.port.toString()}`);
  }

  // .ovpn paste → validate + extract remote → fill host/port + the OVPN block
  // (config_blob = the pasted text; optional username/password ride alongside).
  function handleOvpnPaste(text: string): void {
    if (text.trim() === '') {
      setVpnHint(null);
      setDraft((d) => ({ ...d, openvpn: undefined }));
      return;
    }
    const v = validateOpenVpnConfig(text);
    if (!v.ok) {
      setVpnHint(v.reason);
      // Keep the blob so the user can fix it, but don't mark it valid. The spread
      // must come FIRST so the NEW text wins — `{ config_blob: text, ...(d.openvpn) }`
      // let the stale `config_blob` inside d.openvpn override every keystroke (the
      // textarea reverted on each edit when invalid).
      setDraft((d) => ({ ...d, openvpn: { ...(d.openvpn ?? {}), config_blob: text } }));
      return;
    }
    const built = buildOpenVpnProxyInput(
      draft.label,
      text,
      { host: v.remoteHost, port: v.remotePort },
      {
        username: draft.openvpn?.username,
        password: draft.openvpn?.password,
      },
    );
    if ('error' in built) {
      setVpnHint(built.error);
      return;
    }
    setDraft((d) => ({
      ...d,
      scheme: 'openvpn',
      host: built.host,
      port: built.port,
      openvpn: built.openvpn,
    }));
    setVpnHint(`✓ remote ${built.host}:${built.port.toString()}`);
  }

  // Upload a .ovpn / wg0.conf file instead of pasting — reads it as text and
  // routes through the same parse handler. Resets the input so re-picking the
  // same file fires onChange again.
  function handleVpnFile(
    e: React.ChangeEvent<HTMLInputElement>,
    apply: (text: string) => void,
  ): void {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') apply(reader.result);
    };
    reader.onerror = () => setVpnHint('Could not read that file.');
    reader.readAsText(file);
  }

  // Quick-paste: accept a proxy in any common format and auto-fill the four
  // fields. Clears itself on a successful parse so a pasted password doesn't
  // linger in a visible field.
  function handlePaste(value: string): void {
    setPasteVal(value);
    if (value.trim() === '') {
      setPasteHint(null);
      return;
    }
    const parsed = parseProxyString(value);
    if (parsed === null) {
      setPasteHint('Could not parse — fill the fields below manually.');
      return;
    }
    setDraft((d) => ({
      ...d,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      password: parsed.password,
    }));
    setPasteVal('');
    setPasteHint(
      `Filled ${parsed.host}:${parsed.port}${parsed.username !== null ? ' (with auth)' : ''}.`,
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitInFlightRef.current) return;
    const v = validateDraft(draft);
    setValidation(v);
    if (!v.ok) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      await onSave(draft);
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  }

  // In-form connection test — validate before you save, so a bad host/port or
  // wrong creds surfaces here instead of failing on first launch.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);

  // VPN endpoint pre-flight — VPN endpoints are mostly UDP (no honest TCP/SOCKS5
  // probe), so we DNS-resolve the endpoint host: catches a typo'd/dead host
  // without claiming the tunnel works (full tunnel verifies at launch).
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<EndpointResolveResult | null>(null);
  async function handleTestEndpoint(): Promise<void> {
    const v = validateDraft(draft);
    setValidation(v);
    if (!v.ok) return;
    setResolving(true);
    setResolveResult(null);
    try {
      setResolveResult(await resolveEndpoint(draft.host, draft.port));
    } catch (err) {
      setResolveResult({
        resolved: false,
        ip: '',
        message: humanizeError(
          err,
          "Couldn't resolve this endpoint. Check the details and try again.",
        ),
      });
    } finally {
      setResolving(false);
    }
  }
  async function handleTestConnection(): Promise<void> {
    const v = validateDraft(draft);
    setValidation(v);
    if (!v.ok) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProxy({
        host: draft.host,
        port: draft.port,
        username: draft.username,
        password: draft.password,
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

  return (
    <form
      ref={formRef}
      onSubmit={(e) => void handleSubmit(e)}
      aria-busy={locked}
      aria-disabled={locked}
      className="relative flex flex-col gap-3 overflow-hidden rounded-xl border border-surface-divider bg-surface-raised p-4 shadow-lg"
    >
      {/* Soft accent glow (matches the Command Center hero) so the form reads as
          a premium surface rather than a flat dark box. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-16 h-36 w-36 rounded-full opacity-40"
        style={{
          background: 'radial-gradient(circle, rgb(var(--accent-rgb)/0.45), transparent 70%)',
        }}
      />
      <header className="flex items-start gap-3 border-b border-surface-divider pb-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 text-base text-accent ring-1 ring-accent/25">
          🌍
        </span>
        <div className="min-w-0 flex-1">
          <span className="section-label text-accent">
            {mode === 'add' ? 'Add proxy' : 'Edit proxy'}
          </span>
          <p className="mt-0.5 text-xs text-ink-muted">
            Route sessions through your own egress — SOCKS5, OpenVPN or WireGuard.
          </p>
        </div>
        <span className="mono shrink-0 rounded-full border border-surface-divider bg-surface-inset px-2 py-0.5 text-2xs font-semibold text-ink-secondary">
          {scheme.toUpperCase()}
        </span>
      </header>
      <Field label="Type">
        <select
          className="form-input"
          value={scheme}
          onChange={(e) => handleSchemeChange(e.target.value as NonNullable<ProxyDraft['scheme']>)}
        >
          <option value="socks5">SOCKS5</option>
          <option value="http">HTTP</option>
          <option value="openvpn">OpenVPN</option>
          <option value="wireguard">WireGuard</option>
        </select>
      </Field>
      <Field label="Label" error={validation.errors.label}>
        <input
          type="text"
          className="form-input"
          value={draft.label}
          onChange={(e) => setField('label', e.target.value)}
          placeholder="prod-eu-west"
        />
      </Field>
      {!isVpn && (
        <>
          <Field label="Quick paste — host:port:user:pass or user:pass@host:port">
            <input
              type="text"
              className="form-input mono"
              value={pasteVal}
              onChange={(e) => handlePaste(e.target.value)}
              placeholder="paste a proxy line to auto-fill the fields below"
              autoComplete="off"
              spellCheck={false}
            />
            {pasteHint !== null && (
              <span className="mt-1 text-2xs text-ink-muted">{pasteHint}</span>
            )}
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Host" error={validation.errors.host}>
                <input
                  type="text"
                  className="form-input mono"
                  value={draft.host}
                  onChange={(e) => setField('host', e.target.value)}
                  placeholder="proxy.example.com"
                />
              </Field>
            </div>
            <Field label="Port" error={validation.errors.port}>
              <input
                type="number"
                className="form-input mono"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(e) => setField('port', Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username (optional)">
              <input
                type="text"
                className="form-input mono"
                value={draft.username ?? ''}
                onChange={(e) =>
                  setField('username', e.target.value.length > 0 ? e.target.value : null)
                }
                autoComplete="off"
              />
            </Field>
            <Field label="Password (optional)">
              <input
                type="password"
                className="form-input mono"
                value={draft.password ?? ''}
                onChange={(e) =>
                  setField('password', e.target.value.length > 0 ? e.target.value : null)
                }
                autoComplete="off"
              />
            </Field>
          </div>
        </>
      )}
      {scheme === 'wireguard' && (
        <Field
          label="Paste your wg0.conf — keys, endpoint + allowed IPs auto-fill"
          error={validation.errors.wireguard}
        >
          <textarea
            className="form-input mono min-h-[120px]"
            value={wgText}
            onChange={(e) => handleWgPaste(e.target.value)}
            placeholder={'[Interface]\nPrivateKey = …\n[Peer]\nPublicKey = …\nEndpoint = host:port'}
            autoComplete="off"
            spellCheck={false}
          />
          <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/20 focus-within:ring-2 focus-within:ring-accent-ring">
            <span aria-hidden>⤓</span> Upload a wg0.conf file
            <input
              type="file"
              accept=".conf,.txt,text/plain"
              className="sr-only"
              onChange={(e) => handleVpnFile(e, handleWgPaste)}
            />
          </label>
          {vpnHint !== null && <span className="mt-1 text-2xs text-ink-muted">{vpnHint}</span>}
        </Field>
      )}
      {scheme === 'openvpn' && (
        <>
          <Field
            label="Paste your .ovpn — the remote endpoint auto-fills"
            error={validation.errors.openvpn}
          >
            <textarea
              className="form-input mono min-h-[120px]"
              value={draft.openvpn?.config_blob ?? ''}
              onChange={(e) => handleOvpnPaste(e.target.value)}
              placeholder={'client\nremote vpn.example.com 1194 udp\ndev tun\n…'}
              autoComplete="off"
              spellCheck={false}
            />
            <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/20 focus-within:ring-2 focus-within:ring-accent-ring">
              <span aria-hidden>⤓</span> Upload a .ovpn file
              <input
                type="file"
                accept=".ovpn,.conf,.txt,text/plain"
                className="sr-only"
                onChange={(e) => handleVpnFile(e, handleOvpnPaste)}
              />
            </label>
            {vpnHint !== null && <span className="mt-1 text-2xs text-ink-muted">{vpnHint}</span>}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Auth username (optional)">
              <input
                type="text"
                className="form-input mono"
                value={draft.openvpn?.username ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    openvpn: {
                      config_blob: d.openvpn?.config_blob ?? '',
                      ...(d.openvpn ?? {}),
                      username: e.target.value.length > 0 ? e.target.value : undefined,
                    },
                  }))
                }
                autoComplete="off"
              />
            </Field>
            <Field label="Auth password (optional)">
              <input
                type="password"
                className="form-input mono"
                value={draft.openvpn?.password ?? ''}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    openvpn: {
                      config_blob: d.openvpn?.config_blob ?? '',
                      ...(d.openvpn ?? {}),
                      password: e.target.value.length > 0 ? e.target.value : undefined,
                    },
                  }))
                }
                autoComplete="off"
              />
            </Field>
          </div>
        </>
      )}
      {testResult !== null && (
        <div
          data-component="form-test-result"
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs ${
            testResult.reachable && testResult.auth_ok
              ? 'border-status-ready/40 bg-status-ready/10 text-status-ready'
              : 'border-status-error/40 bg-status-error/10 text-status-error'
          }`}
        >
          <span className="font-semibold">
            {testResult.reachable && testResult.auth_ok ? '✓ Connected' : '✗ Failed'}
          </span>
          {testResult.reachable && (
            <span className="text-ink-secondary">
              {testResult.auth_ok ? 'auth ok' : 'auth failed'} · {testResult.latency_ms}ms · UDP{' '}
              {testResult.udp_associate ? '✓' : '✗'}
            </span>
          )}
          {!testResult.reachable && (
            <span className="text-ink-secondary">{testResult.message}</span>
          )}
        </div>
      )}
      {resolveResult !== null && (
        <div
          data-component="form-endpoint-result"
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs ${
            resolveResult.resolved
              ? 'border-status-ready/40 bg-status-ready/10 text-status-ready'
              : 'border-status-error/40 bg-status-error/10 text-status-error'
          }`}
        >
          <span className="font-semibold">
            {resolveResult.resolved ? '✓ Endpoint reachable' : '✗ Endpoint not found'}
          </span>
          <span className="text-ink-secondary">{resolveResult.message}</span>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 pt-2">
        {!isVpn ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleTestConnection()}
            disabled={testing || locked}
            title="Probe this proxy — reachability, auth, latency, UDP — before saving"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        ) : (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleTestEndpoint()}
            disabled={resolving || locked}
            title="Check the VPN endpoint host resolves — full tunnel verifies at launch"
          >
            {resolving ? 'Checking…' : 'Test endpoint'}
          </button>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={locked}
            onClick={() => {
              if (!submitInFlightRef.current) onCancel();
            }}
          >
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={locked} aria-busy={locked}>
            {locked
              ? mode === 'add'
                ? 'Adding…'
                : 'Saving…'
              : mode === 'add'
                ? 'Add proxy'
                : 'Save changes'}
          </button>
        </div>
      </div>
    </form>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-ink-muted">{label}</span>
      {children}
      {error !== undefined && <span className="text-2xs text-status-error">{error}</span>}
    </label>
  );
}

function PoolStat({ k, v, tone }: { k: string; v: string; tone?: 'ok' }): JSX.Element {
  // Opaque surface-raised on every cell (matches the status-site card surface
  // the founder asked us to mirror); the "healthy" signal comes from the green
  // label + value, not a translucent tint that washes out over the grid divider.
  return (
    <div className="bg-surface-raised px-3 py-2.5">
      <p className={`section-label ${tone === 'ok' ? 'text-status-ready/80' : ''}`}>{k}</p>
      <p
        className={`mono mt-0.5 text-2xl font-bold tracking-tight ${
          tone === 'ok' ? 'text-status-ready' : 'text-ink-primary'
        }`}
      >
        {v}
      </p>
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────

/** Map an ISO-3166 alpha-2 country code to its flag emoji (mirrors the
 *  Profiles hub helper). Returns a globe for an unrecognised code. */
function flagEmoji(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '🌍';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function toDraft(p: ProxyConfig): ProxyDraft {
  // Carry the scheme + the VPN config block forward (only when present, matching
  // addProxy/updateProxy's optional-field style). Without this an OpenVPN/
  // WireGuard proxy editing through the form — even a label-only rename — saved
  // back with scheme + config DROPPED, silently reverting a working VPN proxy
  // into a broken SOCKS5 one (the editor then renders the SOCKS5 fields and
  // updateProxy persists no scheme/openvpn/wireguard).
  return {
    label: p.label,
    host: p.host,
    port: p.port,
    username: p.username,
    password: p.password,
    ...(p.scheme !== undefined ? { scheme: p.scheme } : {}),
    ...(p.openvpn !== undefined ? { openvpn: p.openvpn } : {}),
    ...(p.wireguard !== undefined ? { wireguard: p.wireguard } : {}),
  };
}

function friendlyError(err: unknown, fallback: string): string {
  return humanizeError(err, fallback);
}

/** Return a copy of `rec` without `key` (same reference if absent, so React
 *  state updates short-circuit). Used to evict a proxy's in-memory probe
 *  results when its endpoint changes or it is deleted. */
function dropKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}
