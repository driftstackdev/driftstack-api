// Settings view — API key + base URL + telemetry toggle.
//
// V-241: API key now stored in OS keychain (macOS Keychain / Windows
// Credential Manager / Linux Secret Service); the masked input edits
// the keychain entry transparently via Tauri commands.
//
// V-242: telemetry toggle — Sentry crash-only opt-in. Defaults ON for
// cloud customers, OFF for self-hosted. Customer can override either
// direction.
//
// V-272: account info block + sign-out button. First-run hint
// rewritten to point at the V-268 browser sign-in flow instead of the
// stale "npm run admin:create-key" instruction.

import { useEffect, useRef, useState } from 'react';
import type {
  BundledLlmSettings,
  BundledLlmStatus,
  ByokAnthropicKeyMetadata,
} from '@driftstack/sdk';
import { DriftstackError } from '@driftstack/sdk';
import { ConnectivityView } from './ConnectivityView';
import { RelativeTime } from '../components/RelativeTime';
import { useBrowserSignIn } from '../lib/browser-sign-in';
import { diagnosticFetchError } from '../lib/diagnostic-fetch-error';
import { humanizeError } from '../lib/humanize-error';
import { disposeResponseBody } from '../lib/dispose-response-body';
import { readBoundedDiagnosticJson } from '../lib/read-bounded-json';
import { friendlySettingsActionError } from '../lib/settings-error-copy';
import { useSettings } from '../lib/SettingsContext';
import { isCloudBaseUrl } from '../lib/telemetry';
import { DEFAULT_SETTINGS, rememberedKeyFor } from '../lib/settings';
import { normalizeNavigateUrl } from '../lib/address-bar';
import { useConfirm } from '../components/ConfirmProvider';
import { maskApiKey } from '../components/ApiKeyMaskedSpan';
import { SettingsAccountCard } from '../components/SettingsAccountCard';
import { useToasts } from '../lib/toasts';
import { useAppVersion } from '../lib/app-version';
import { checkForUpdate, type AvailableUpdate } from '../lib/updater';

const CLOUD_URL = 'https://api.driftstack.dev';
const SELF_HOSTED_DEFAULT = 'http://localhost:3000';

function formatCentsAsUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; version: string }
  | { kind: 'fail'; message: string };

type ByokActionKind = 'saving' | 'testing' | 'clearing';

export function SettingsView(): JSX.Element {
  const confirm = useConfirm();
  const { push: pushToast } = useToasts();
  const { settings, update, loading, client } = useSettings();
  const [draftKey, setDraftKey] = useState(settings.apiKey ?? '');
  const [draftUrl, setDraftUrl] = useState(settings.baseUrl);
  const [draftMode, setDraftMode] = useState<'cloud' | 'self-hosted'>(
    isCloudBaseUrl(settings.baseUrl) ? 'cloud' : 'self-hosted',
  );
  const [draftTelemetry, setDraftTelemetry] = useState<boolean | null>(settings.telemetryOptIn);
  // Manual update check. Separate from the silent startup check in App so a
  // customer who wants to know NOW gets an answer either way — "you are on the
  // latest" is a real result, and the startup path can only ever surface the
  // other one.
  const appVersion = useAppVersion();
  const [updateCheck, setUpdateCheck] = useState<'idle' | 'checking' | 'none' | 'found' | 'error'>(
    'idle',
  );
  const [foundUpdate, setFoundUpdate] = useState<AvailableUpdate | null>(null);
  const runUpdateCheck = async (): Promise<void> => {
    setUpdateCheck('checking');
    setFoundUpdate(null);
    try {
      const u = await checkForUpdate();
      setFoundUpdate(u);
      setUpdateCheck(u === null ? 'none' : 'found');
    } catch {
      // checkForUpdate is documented not to throw, but a manual check must not
      // be able to strand the button on "Checking…" if that ever changes.
      setUpdateCheck('error');
    }
  };
  const [draftStartUrl, setDraftStartUrl] = useState(settings.startUrl);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  // W577 — post-save key validation result. Save itself never blocks (a
  // customer may intentionally pre-set a URL before their server is up);
  // we validate after persisting and surface the outcome here.
  const [keyCheck, setKeyCheck] = useState<
    { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok' } | { kind: 'fail'; message: string }
  >({ kind: 'idle' });

  // AI & billing — bundled-LLM consent/cap + BYOK Anthropic key. Loaded
  // straight from the server (not the local settings store) since both are
  // account-level, not per-install.
  // Held only to drive the consent/cap drafts + status below; the raw settings
  // object itself isn't read directly (audit #15 load-state refactor).
  const [, setBundledLlm] = useState<BundledLlmSettings | null>(null);
  // Distinct load state so the "ask the owner" hint fires ONLY on a real 403,
  // not while still loading or on a transient network/error (audit #15). The
  // consent/cap/Save controls stay disabled until we know the account-level
  // settings actually loaded.
  const [bundledLlmLoad, setBundledLlmLoad] = useState<
    'loading' | 'loaded' | 'forbidden' | 'error'
  >('loading');
  const [bundledLlmStatus, setBundledLlmStatus] = useState<BundledLlmStatus | null>(null);
  const [bundledLlmConsentDraft, setBundledLlmConsentDraft] = useState(false);
  const [bundledLlmCapDraft, setBundledLlmCapDraft] = useState('0.00');
  const [bundledLlmSaving, setBundledLlmSaving] = useState(false);
  const [bundledLlmSaveError, setBundledLlmSaveError] = useState<string | null>(null);
  const [bundledLlmSavedAt, setBundledLlmSavedAt] = useState<number | null>(null);
  const bundledLlmSaveRef = useRef<{ token: number } | null>(null);
  const bundledLlmSaveTokenRef = useRef(0);

  const [byok, setByok] = useState<ByokAnthropicKeyMetadata | null>(null);
  const [byokKeyDraft, setByokKeyDraft] = useState('');
  const [byokSaveError, setByokSaveError] = useState<string | null>(null);
  const [byokActionKind, setByokActionKind] = useState<ByokActionKind | null>(null);
  const byokActionRef = useRef<{ token: number; kind: ByokActionKind } | null>(null);
  const byokActionTokenRef = useRef(0);
  const byokBusy = byokActionKind !== null;
  const [byokTestState, setByokTestState] = useState<
    { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'fail'; reason: string }
  >({ kind: 'idle' });

  function claimByokAction(kind: ByokActionKind): number | null {
    if (byokActionRef.current !== null) return null;
    const token = ++byokActionTokenRef.current;
    byokActionRef.current = { token, kind };
    setByokActionKind(kind);
    return token;
  }

  function ownsByokAction(token: number): boolean {
    return byokActionRef.current?.token === token;
  }

  function setByokActionPhase(token: number, kind: ByokActionKind): void {
    if (!ownsByokAction(token)) return;
    byokActionRef.current = { token, kind };
    setByokActionKind(kind);
  }

  function releaseByokAction(token: number): void {
    if (!ownsByokAction(token)) return;
    byokActionRef.current = null;
    setByokActionKind(null);
  }

  useEffect(() => {
    // A replacement SDK client invalidates every result owned by the prior
    // deployment/account. The token check below also makes unmount harmless.
    bundledLlmSaveTokenRef.current += 1;
    bundledLlmSaveRef.current = null;
    setBundledLlmSaving(false);
    byokActionTokenRef.current += 1;
    byokActionRef.current = null;
    setByokActionKind(null);
    if (!client) return;
    let cancelled = false;
    setBundledLlmLoad('loading');
    void client.account.getBundledLlmSettings().then(
      (s) => {
        if (cancelled) return;
        setBundledLlm(s);
        setBundledLlmConsentDraft(s.consent);
        setBundledLlmCapDraft((s.monthly_cap_usd_cents / 100).toFixed(2));
        setBundledLlmLoad('loaded');
      },
      (err: unknown) => {
        if (cancelled) return;
        // A real 403 means the caller isn't the account owner → show the
        // "ask the owner" hint. Anything else is a transient/network failure.
        setBundledLlmLoad(
          err instanceof DriftstackError && err.status === 403 ? 'forbidden' : 'error',
        );
      },
    );
    void client.account.getBundledLlmStatus().then(
      (s) => {
        if (!cancelled) setBundledLlmStatus(s);
      },
      () => undefined,
    );
    void client.account.getByokAnthropicKey().then(
      (k) => {
        if (!cancelled) setByok(k);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      bundledLlmSaveTokenRef.current += 1;
      bundledLlmSaveRef.current = null;
      byokActionTokenRef.current += 1;
      byokActionRef.current = null;
    };
  }, [client]);

  async function handleSaveBundledLlm(): Promise<void> {
    if (!client) return;
    const capCents = Math.round(Number.parseFloat(bundledLlmCapDraft) * 100);
    if (!Number.isFinite(capCents) || capCents < 0) {
      setBundledLlmSaveError('Enter a valid monthly limit.');
      return;
    }
    // React's disabled state lands after the event returns. Claim the write
    // synchronously so a rapid click cannot start a second whole-object PATCH.
    if (bundledLlmSaveRef.current !== null) return;
    const token = ++bundledLlmSaveTokenRef.current;
    bundledLlmSaveRef.current = { token };
    setBundledLlmSaving(true);
    setBundledLlmSaveError(null);
    try {
      const updated = await client.account.updateBundledLlmSettings({
        consent: bundledLlmConsentDraft,
        monthly_cap_usd_cents: capCents,
      });
      if (bundledLlmSaveRef.current?.token !== token) return;
      setBundledLlm(updated);
      setBundledLlmConsentDraft(updated.consent);
      setBundledLlmCapDraft((updated.monthly_cap_usd_cents / 100).toFixed(2));
      setBundledLlmSavedAt(Date.now());
      pushToast({ title: 'AI billing settings saved', tone: 'success' });
    } catch (err) {
      if (bundledLlmSaveRef.current?.token === token) {
        setBundledLlmSaveError(friendlySettingsActionError(err, 'save-ai-billing'));
      }
    } finally {
      if (bundledLlmSaveRef.current?.token === token) {
        bundledLlmSaveRef.current = null;
        setBundledLlmSaving(false);
      }
    }
  }

  async function handleSetByokKey(): Promise<void> {
    const key = byokKeyDraft.trim();
    if (!client || key.length === 0) return;
    const token = claimByokAction('saving');
    if (token === null) return;
    setByokSaveError(null);
    setByokTestState({ kind: 'idle' });
    try {
      await client.account.setByokAnthropicKey(key);
      if (!ownsByokAction(token)) return;
      const meta = await client.account.getByokAnthropicKey();
      if (!ownsByokAction(token)) return;
      setByok(meta);
      setByokKeyDraft('');
      pushToast({ title: 'Your Anthropic key is saved', tone: 'success' });

      // Auto-verify under the SAME owner as the save. Releasing between the
      // write and test lets Clear race the test and later render a stale
      // "Working" result for a key that no longer exists.
      setByokActionPhase(token, 'testing');
      await runByokTest(token);
    } catch (err) {
      if (ownsByokAction(token)) {
        setByokSaveError(friendlySettingsActionError(err, 'save-provider-key'));
      }
    } finally {
      releaseByokAction(token);
    }
  }

  async function runByokTest(token: number): Promise<void> {
    if (!client || !ownsByokAction(token)) return;
    setByokTestState({ kind: 'testing' });
    try {
      const result = await client.account.testByokAnthropicKey();
      if (!ownsByokAction(token)) return;
      setByokTestState(result.ok ? { kind: 'ok' } : { kind: 'fail', reason: result.reason });
    } catch (err) {
      if (!ownsByokAction(token)) return;
      setByokTestState({
        kind: 'fail',
        reason: friendlySettingsActionError(err, 'test-provider-key'),
      });
    }
  }

  async function handleTestByokKey(): Promise<void> {
    if (!client) return;
    const token = claimByokAction('testing');
    if (token === null) return;
    try {
      await runByokTest(token);
    } finally {
      releaseByokAction(token);
    }
  }

  async function handleClearByokKey(): Promise<void> {
    if (!client) return;
    if (
      !(await confirm(
        'Clear your saved Anthropic key? Automations will fall back to platform billing (or stop if none is set). You can paste the key again anytime.',
        { confirmLabel: 'Clear key', tone: 'danger' },
      ))
    )
      return;
    const token = claimByokAction('clearing');
    if (token === null) return;
    try {
      await client.account.clearByokAnthropicKey();
      if (!ownsByokAction(token)) return;
      setByok({ has_key: false, set_at: null, last_used_at: null });
      setByokTestState({ kind: 'idle' });
      pushToast({ title: 'Key cleared', tone: 'success' });
    } catch (err) {
      if (!ownsByokAction(token)) return;
      pushToast({
        title: 'Could not clear key',
        body: friendlySettingsActionError(err, 'clear-provider-key'),
        tone: 'error',
      });
    } finally {
      releaseByokAction(token);
    }
  }

  /** Flip mode + auto-fill the URL. Cloud locks the URL; self-hosted
   *  keeps whatever the customer last typed (or the default). W584 — also
   *  auto-restores that deployment's remembered key so switching modes never
   *  asks the customer to re-paste a key they already entered once. */
  // Monotonic token guarding the async remembered-key restore: bumped on every
  // mode switch AND on a manual key edit, so an out-of-order rememberedKeyFor
  // resolution (rapid toggling, different keychain/store latencies) or a key the
  // user typed after switching can't clobber the latest intent (audit wja3dfl5t).
  const keyRestoreTokenRef = useRef(0);
  // React state does not commit synchronously, so `saving` alone cannot stop
  // two clicks dispatched in the same turn. Keep the persistence boundary in
  // a ref as well: this is especially important when `update` opens the OS
  // credential store, where duplicate writes can multiply authorization UI.
  const saveInFlightRef = useRef(false);
  // Monotonic token for the post-save key validation (see handleSave) — a newer
  // Save supersedes an older in-flight validation so a stale verdict can't land.
  const validateTokenRef = useRef(0);
  const validateControllerRef = useRef<AbortController | null>(null);
  const connectionTestTokenRef = useRef(0);
  const connectionTestControllerRef = useRef<AbortController | null>(null);

  function invalidateConnectionTest(): void {
    connectionTestTokenRef.current += 1;
    connectionTestControllerRef.current?.abort();
    connectionTestControllerRef.current = null;
    setTestState({ kind: 'idle' });
  }

  function invalidateKeyValidation(): void {
    validateTokenRef.current += 1;
    validateControllerRef.current?.abort();
    validateControllerRef.current = null;
    setKeyCheck({ kind: 'idle' });
  }

  useEffect(
    () => () => {
      connectionTestTokenRef.current += 1;
      validateTokenRef.current += 1;
      connectionTestControllerRef.current?.abort();
      validateControllerRef.current?.abort();
      connectionTestControllerRef.current = null;
      validateControllerRef.current = null;
    },
    [],
  );

  function switchMode(next: 'cloud' | 'self-hosted'): void {
    invalidateConnectionTest();
    invalidateKeyValidation();
    const token = ++keyRestoreTokenRef.current;
    setDraftMode(next);
    let target: string;
    if (next === 'cloud') {
      target = CLOUD_URL;
      setDraftUrl(CLOUD_URL);
    } else if (draftUrl === CLOUD_URL || draftUrl.length === 0) {
      target = SELF_HOSTED_DEFAULT;
      setDraftUrl(SELF_HOSTED_DEFAULT);
    } else {
      target = draftUrl;
    }
    void rememberedKeyFor(target).then((remembered) => {
      // Only apply if this is still the latest switch and the user hasn't typed.
      if (keyRestoreTokenRef.current === token) setDraftKey(remembered ?? '');
    });
  }

  async function runConnectionTest(): Promise<void> {
    const target = draftUrl.trim().replace(/\/+$/, '');
    connectionTestControllerRef.current?.abort();
    const token = ++connectionTestTokenRef.current;
    const controller = new AbortController();
    connectionTestControllerRef.current = controller;
    setTestState({ kind: 'testing' });
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${target}/version`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (connectionTestTokenRef.current !== token) {
        await disposeResponseBody(res);
        return;
      }
      if (!res.ok) {
        await disposeResponseBody(res);
        setTestState({ kind: 'fail', message: settingsProbeResponseError(res.status) });
        return;
      }
      const body = await readBoundedDiagnosticJson<{ git_sha?: string }>(res).catch(
        (): { git_sha?: string } => ({}),
      );
      if (connectionTestTokenRef.current !== token) return;
      setTestState({ kind: 'ok', version: body.git_sha ?? 'unknown' });
    } catch (err) {
      if (connectionTestTokenRef.current !== token) return;
      const diag = diagnosticFetchError(err, target);
      setTestState({
        kind: 'fail',
        message:
          diag ?? humanizeError(err, 'Connection test failed. Check the server URL and try again.'),
      });
    } finally {
      window.clearTimeout(timer);
      if (connectionTestControllerRef.current === controller) {
        connectionTestControllerRef.current = null;
      }
    }
  }

  // ⛔ V-1611 — these MUST stay above the `loading` early-return below.
  //
  // `useBrowserSignIn` calls useState/useRef/useEffect internally. With it
  // BELOW the early return, a mount during the boot window — `loading` starts
  // true and flips false while children render — takes the short path on the
  // first render and the long path on the second, so React sees a different
  // number of hooks and throws "Rendered more hooks than during the previous
  // render". That lands in the same error boundary as the crash this commit
  // fixes, from a different cause, and only on a timing window.
  const isFirstRun = settings.apiKey === null;

  // V-274 — inline browser sign-in (re-uses V-268 plumbing). Lets the
  // customer re-authorize without restarting the app post-Sign-out.
  const browserSignIn = useBrowserSignIn({
    baseUrl: draftUrl.trim().replace(/\/+$/, '') || settings.baseUrl,
    onSuccess: async (issuedKey, _accountId) => {
      await update(
        {
          apiKey: issuedKey,
          baseUrl: draftUrl.trim().replace(/\/+$/, '') || settings.baseUrl,
          telemetryOptIn: draftTelemetry,
        },
        { reportPersistenceFailure: true },
      );
      setDraftKey(issuedKey);
      setSavedAt(Date.now());
    },
  });

  if (loading) {
    return (
      <div
        role="status"
        aria-label="Loading settings"
        className="mx-auto flex h-full w-full max-w-2xl flex-col gap-6 p-6"
      >
        <span className="sr-only">Loading settings</span>
        <header
          className="flex items-start gap-4 rounded-2xl border border-surface-divider bg-surface-raised p-5"
          aria-hidden="true"
        >
          <div className="h-11 w-11 shrink-0 animate-pulse rounded-xl bg-surface-inset" />
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
              Settings
            </span>
            <div className="h-6 w-44 animate-pulse rounded bg-surface-inset" />
            <div className="mt-1 h-4 w-80 animate-pulse rounded bg-surface-inset" />
          </div>
        </header>
        <div className="flex flex-col gap-4" aria-hidden="true">
          <div className="h-28 animate-pulse rounded-xl border border-surface-divider bg-surface-raised" />
          <div className="h-40 animate-pulse rounded-xl border border-surface-divider bg-surface-raised" />
        </div>
      </div>
    );
  }

  // Copy the REAL API key (not the 12+4 masked display) so a customer can
  // paste it into a script / CI secret without re-minting. Clipboard writes
  // can fail in locked-down WKWebView contexts — surface that instead of
  // leaving the customer to wonder whether the (invisible) key was copied.
  async function handleCopyKey(): Promise<void> {
    if (settings.apiKey === null) return;
    try {
      if (navigator.clipboard === undefined) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(settings.apiKey);
      pushToast({ title: 'Copied', tone: 'success' });
    } catch {
      pushToast({ title: "Couldn't copy — clipboard blocked", tone: 'error' });
    }
  }

  async function handleSave(): Promise<void> {
    // Guard a non-empty-but-invalid Start URL: don't run the save (which would
    // silently keep the old value while showing 'Saved.'). The button is also
    // disabled on this, but a programmatic call still bails for safety.
    if (startUrlInvalid || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    const url = draftUrl.trim().replace(/\/+$/, '') || 'http://localhost:3000';
    // A blank field clears to the default; a non-empty field is guaranteed valid
    // here (the startUrlInvalid guard blocked an invalid one above), so
    // normalizeNavigateUrl can't return null for a non-empty value. Fall back to
    // the DEFAULT start URL (not settings.startUrl): a customer who clears the
    // field intends to reset to the default — keeping the OLD value left the
    // field blank while the save silently retained the previous custom URL, so
    // `dirty` stayed true ('' !== saved) and the field looked stuck/unsaved
    // forever. (audit)
    const nextStartUrl = normalizeNavigateUrl(draftStartUrl) ?? DEFAULT_SETTINGS.startUrl;
    try {
      await update(
        {
          apiKey: draftKey.length > 0 ? draftKey : null,
          baseUrl: url,
          telemetryOptIn: draftTelemetry,
          startUrl: nextStartUrl,
        },
        { reportPersistenceFailure: true },
      );
      // Reflect the persisted value back into the field so a blank-clear shows the
      // default it reset to (instead of staying blank + re-arming `dirty`).
      setDraftStartUrl(nextStartUrl);
      setSavedAt(Date.now());
    } catch (err) {
      pushToast({
        title: "Couldn't save settings",
        body: humanizeError(
          err,
          'Check that Driftstack can access your system credential store, then try again.',
        ),
        tone: 'error',
      });
      return;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }

    // W577 — validate the saved key against the saved server, AFTER the
    // non-blocking persist. Previously a wrong key saved silently and only
    // surfaced as 401s in other views with no hint why; the most common
    // cause is a key minted on a different deployment (cloud key against a
    // self-hosted server or vice-versa — keys are bound to the server they
    // were minted on), so the failure message is mode-aware like the
    // first-run wizard's (W566).
    if (draftKey.length === 0) {
      invalidateKeyValidation();
      return;
    }
    setKeyCheck({ kind: 'checking' });
    // Token this validation so a SLOWER older validation (a second Save fired
    // before the first's /account/me resolved) can't clobber the newer key's
    // verdict — its result is discarded on resolve (audit wja3dfl5t).
    const token = ++validateTokenRef.current;
    // Bound the validation like runConnectionTest — without an abort, a server
    // that hangs (rather than refusing) leaves keyCheck stuck on 'checking'
    // ("Validating key…") forever with no resolution.
    validateControllerRef.current?.abort();
    const controller = new AbortController();
    validateControllerRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${url}/v1/account/me`, {
        headers: { authorization: `Bearer ${draftKey}` },
        signal: controller.signal,
      });
      await disposeResponseBody(res);
      if (validateTokenRef.current !== token) return; // superseded by a newer Save
      if (res.ok) {
        setKeyCheck({ kind: 'ok' });
      } else if (res.status === 401) {
        setKeyCheck({
          kind: 'fail',
          message: isCloudBaseUrl(url)
            ? 'Saved, but the key was not accepted. Double-check it, or create a new one at app.driftstack.dev/api-keys.'
            : `Saved, but the key was not accepted by ${url}. In self-hosted mode the key must be created on that server's own dashboard — a key from app.driftstack.dev won't authenticate here.`,
        });
      } else {
        setKeyCheck({
          kind: 'fail',
          message: `Saved. ${settingsProbeResponseError(res.status)}`,
        });
      }
    } catch (err) {
      if (validateTokenRef.current !== token) return; // superseded by a newer Save
      setKeyCheck({
        kind: 'fail',
        message:
          diagnosticFetchError(err, url) ??
          `Saved, but ${url} is unreachable — the key couldn't be validated.`,
      });
    } finally {
      window.clearTimeout(timer);
      if (validateControllerRef.current === controller) {
        validateControllerRef.current = null;
      }
    }
  }

  const dirty =
    draftKey !== (settings.apiKey ?? '') ||
    draftUrl !== settings.baseUrl ||
    draftTelemetry !== settings.telemetryOptIn ||
    draftStartUrl !== settings.startUrl;

  // The Start URL is normalized on save (prepends https://, rejects non-http(s)
  // → null). A non-empty value that normalizes to null (file://, about:blank,
  // javascript:, …) was previously SAVED SILENTLY as the OLD value while the
  // field kept showing the rejected text + 'Saved.' fired — the customer
  // believed it stuck when it didn't. Surface it inline and block the save.
  const startUrlInvalid =
    (draftStartUrl ?? '').trim().length > 0 && normalizeNavigateUrl(draftStartUrl ?? '') === null;

  // V-242 — surface the platform default to the customer so they
  // understand what the "use default" choice means in their context.
  const cloudBaseUrl = isCloudBaseUrl(draftUrl);
  const platformDefaultLabel = cloudBaseUrl ? 'on (cloud default)' : 'off (self-hosted default)';
  const effectiveTelemetry =
    draftTelemetry === null ? (cloudBaseUrl ? 'on' : 'off') : draftTelemetry ? 'on' : 'off';

  // ⛔ `[&>*]:shrink-0` on the scroller below is load-bearing, not decoration.
  //
  // It is a FIXED-HEIGHT flex column (`h-full`) whose content runs ~2500px, so
  // flex resolves the overflow by SHRINKING its children before the scroll
  // container ever sees it. A flex item is normally protected by
  // `min-height: auto` — but that automatic minimum applies only while the
  // item's own `overflow` is `visible`. The hero <header> sets `overflow-hidden`
  // for its rounded corners, which disables that protection, so it alone
  // collapsed from 118px of content into a 42px bar and clipped its own
  // contents: the owner saw the "API connection / Connected /
  // https://api.driftstack.dev" block disappear and only "a small bar" remain.
  // Every sibling card survived purely because none of them clips. Applied at
  // the CONTAINER so the next child that sets overflow-hidden cannot inherit it.
  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-6 overflow-y-auto p-6 [&>*]:shrink-0">
      {/* Page hero: an icon-led title + subtitle, with the live API-connection
          status and the primary Save action anchored on the right — matching the
          Command Center's gradient card language. */}
      <header className="relative overflow-hidden rounded-2xl border border-surface-divider bg-surface-raised p-5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full opacity-40 blur-3xl"
          style={{
            background: 'radial-gradient(circle, rgb(var(--accent-rgb)/0.55), transparent 70%)',
          }}
        />
        <div className="relative flex flex-wrap items-start gap-4">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent"
            aria-hidden="true"
          >
            <IconCog />
          </span>
          <div className="min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wider text-accent">
              Settings
            </span>
            <h2 className="mt-0.5 text-2xl font-semibold tracking-tight text-ink-primary">
              API connection
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
              {isFirstRun ? (
                <span className="text-ink-muted">not connected · add a key to begin</span>
              ) : keyCheck.kind === 'fail' ? (
                // A saved key that just failed validation must NOT read "Connected"
                // while the 401/unreachable banner sits right below it. (Idle/ok/
                // checking keep the green state — we don't re-validate on load, so
                // the common case is unaffected.)
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block h-1.5 w-1.5 rounded-full bg-status-error"
                  />
                  <span className="font-semibold text-status-error">Key set · check failed</span>
                  <span className="text-surface-divider">·</span>
                  <span className="mono text-ink-secondary">{settings.baseUrl}</span>
                </>
              ) : (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block h-1.5 w-1.5 rounded-full bg-status-ready"
                  />
                  <span className="font-semibold text-status-ready">Connected</span>
                  <span className="text-surface-divider">·</span>
                  <span className="mono text-ink-secondary">{settings.baseUrl}</span>
                </>
              )}
            </p>
          </div>
          <div className="ml-auto flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleSave()}
                disabled={saving || !dirty || startUrlInvalid}
                title={startUrlInvalid ? 'Fix the Start URL before saving' : undefined}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {savedAt !== null && !dirty && keyCheck.kind === 'idle' && (
              <span className="text-2xs text-ink-muted">Saved.</span>
            )}
            {keyCheck.kind === 'checking' && (
              <span className="text-2xs text-ink-muted">Saved. Validating key…</span>
            )}
            {keyCheck.kind === 'ok' && (
              <span className="text-2xs text-status-ready">Saved. Key authenticated ✓</span>
            )}
          </div>
        </div>
      </header>

      {/* Account identity + tier + billing link — previously the card existed but was never
          mounted, so nowhere in the desktop app showed who you're signed in as or your plan
          (audit 2026-07-08). Only once a key is configured (it self-fetches /v1/account/me). */}
      {!isFirstRun && <SettingsAccountCard />}

      {isFirstRun && (
        <Panel className="border-accent/40 bg-accent-subtle">
          <SectionHeader
            icon={<IconKey />}
            title="No API key yet"
            titleClassName="text-accent dark:text-ink-primary"
          />
          <p className="mt-3 text-sm text-ink-secondary">
            {draftMode === 'cloud' ? (
              <>
                Sign in with your browser to mint a fresh API key bound to your account, or paste an
                existing key from <span className="mono">app.driftstack.dev/api-keys</span> below.
              </>
            ) : (
              <>
                Paste a key created on your own server's dashboard. A key from{' '}
                <span className="mono">app.driftstack.dev</span> won't authenticate against a
                self-hosted server — keys are bound to the deployment that minted them.
              </>
            )}
          </p>

          {browserSignIn.state.kind === 'idle' && (
            <button
              type="button"
              className="btn-primary mt-3"
              onClick={() => void browserSignIn.start()}
            >
              Sign in with browser
            </button>
          )}
          {browserSignIn.state.kind === 'opening' && (
            <p className="mt-3 text-xs text-ink-secondary">Opening browser…</p>
          )}
          {browserSignIn.state.kind === 'waiting' && (
            <div className="mt-3" role="status" aria-live="polite">
              <p className="text-xs text-ink-secondary">
                Enter this verification code in the browser. Never share it with someone who
                contacted you.
              </p>
              <p className="mono mt-2 text-lg font-semibold tracking-[0.18em] text-ink-primary">
                {browserSignIn.state.userCode}
              </p>
              <button
                type="button"
                className="mt-2 text-xs text-ink-muted underline"
                onClick={browserSignIn.cancel}
              >
                Cancel
              </button>
            </div>
          )}
          {browserSignIn.state.kind === 'success' && (
            <p className="mt-3 text-xs text-status-success">Authorized. Key saved.</p>
          )}
          {browserSignIn.state.kind === 'error' && (
            <div className="mt-3">
              <p className="whitespace-pre-line text-xs text-status-error">
                {browserSignIn.state.message}
              </p>
              <button
                type="button"
                className="btn-primary mt-2"
                onClick={() => void browserSignIn.start()}
              >
                Try again
              </button>
            </div>
          )}
        </Panel>
      )}

      {/* Appearance — Fleet two-axis theme (2026-06-12 rework). Mode +
          accent persist in settings.json and apply instantly via the
          SettingsProvider effect (document.documentElement data attrs). */}
      <Panel>
        <SectionHeader
          icon={<IconSwatch />}
          title="Appearance"
          description="Theme + accent apply instantly and persist on this device."
        />
        <div className="mt-4 flex items-center gap-3">
          <span className="w-24 text-sm text-ink-secondary">Mode</span>
          <div className="flex overflow-hidden rounded-lg border border-surface-divider">
            {(['light', 'dark'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => void update({ themeMode: m })}
                className={
                  settings.themeMode === m
                    ? 'bg-accent px-3 py-1.5 text-xs font-semibold text-ink-inverted'
                    : 'bg-surface-inset px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:text-ink-primary'
                }
              >
                {m === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <span className="w-24 text-sm text-ink-secondary">Accent</span>
          <div className="flex items-center gap-2.5">
            {(
              [
                ['violet', '#6d5efc'],
                ['oxblood', '#722f37'],
                ['teal', '#109a82'],
              ] as const
            ).map(([a, hex]) => (
              <button
                key={a}
                type="button"
                aria-label={`${a} accent`}
                onClick={() => void update({ themeAccent: a })}
                className={
                  settings.themeAccent === a
                    ? 'h-5 w-5 rounded-full ring-2 ring-ink-primary ring-offset-2 ring-offset-surface-raised transition-transform'
                    : 'h-5 w-5 rounded-full opacity-70 transition-all hover:scale-110 hover:opacity-100'
                }
                style={{ background: hex }}
              />
            ))}
          </div>
        </div>
      </Panel>

      {!isFirstRun && (
        <Panel>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <span className="flex items-center gap-2">
                <span
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-inset text-ink-secondary"
                  aria-hidden="true"
                >
                  <IconLink />
                </span>
                <span className="section-label">Connected</span>
              </span>
              <p className="mt-2 text-sm text-ink-secondary">
                Pointing at <span className="mono">{settings.baseUrl}</span> with key{' '}
                {/* Use the shared, prefix-aware maskApiKey (strips the known
                    ds_live_ prefix + shows only 4+4 of the body) so on-screen
                    exposure matches the project's masking standard — the inline
                    slice(0,12)+slice(-4) leaked 16 contiguous real chars. (audit) */}
                <span className="mono">{maskApiKey(settings.apiKey)}</span>.
              </p>
              {settings.apiKey !== null && (
                <button
                  type="button"
                  className="btn-secondary mt-2 text-xs"
                  onClick={() => void handleCopyKey()}
                >
                  Copy key
                </button>
              )}
            </div>
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-status-ready/30 bg-status-ready/10 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-status-ready"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-status-ready" />
              Live
            </span>
          </div>
          <button
            type="button"
            className="btn-secondary mt-3"
            onClick={() => {
              void (async () => {
                if (
                  await confirm(
                    'Sign out of this device? This forgets the API key locally; the key is NOT revoked on the server. Revoke it from the dashboard if you want to fully invalidate it.',
                    { confirmLabel: 'Sign out', tone: 'danger' },
                  )
                ) {
                  // Await the keychain write BEFORE clearing the draft — a
                  // fire-and-forget update that fails would leave the UI signed
                  // out while the key is still stored (UI/keychain desync).
                  await update({
                    apiKey: null,
                    baseUrl: settings.baseUrl,
                    telemetryOptIn: settings.telemetryOptIn,
                  });
                  setDraftKey('');
                  // Clean re-entry state: re-mask the field + drop stale verdicts
                  // so the next key isn't typed into a revealed field beside a
                  // prior account's "reachable"/"check failed" lines. (audit wja3dfl5t)
                  setReveal(false);
                  invalidateKeyValidation();
                  invalidateConnectionTest();
                  setSavedAt(null);
                }
              })();
            }}
          >
            Sign out
          </button>
        </Panel>
      )}

      <Panel>
        <SectionHeader
          icon={<IconKey />}
          title="API & connection"
          description="Your key and the server the GUI talks to."
        />
        <div className="mt-4 flex flex-col gap-5">
          <Field label="API key">
            <div className="flex gap-2">
              <input
                type={reveal ? 'text' : 'password'}
                value={draftKey}
                onChange={(e) => {
                  setDraftKey(e.target.value);
                  // Editing invalidates a prior validation verdict (so the header
                  // doesn't show "check failed" for a key that's since been
                  // changed) AND any pending mode-switch key restore (so it can't
                  // overwrite what the user just typed). (audit wja3dfl5t)
                  invalidateKeyValidation();
                  keyRestoreTokenRef.current += 1;
                }}
                placeholder="ds_live_…"
                className="form-input mono flex-1"
                spellCheck={false}
                autoComplete="off"
              />
              <button type="button" className="btn-secondary" onClick={() => setReveal((r) => !r)}>
                {reveal ? 'Hide' : 'Show'}
              </button>
            </div>
            <span className="mt-1.5 block text-2xs text-ink-muted">
              Stored in your OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret
              Service); never sent anywhere except your configured API server.
            </span>
          </Field>

          <Field label="Deployment">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => switchMode('cloud')}
                className={`flex-1 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  draftMode === 'cloud'
                    ? 'border-accent bg-accent-subtle text-ink-primary'
                    : 'border-surface-divider bg-surface-base text-ink-secondary hover:border-ink-muted/50 hover:text-ink-primary'
                }`}
              >
                <div className="font-semibold">Cloud</div>
                <div className="mt-0.5 text-2xs text-ink-muted">
                  api.driftstack.dev · managed fleet
                </div>
              </button>
              <button
                type="button"
                onClick={() => switchMode('self-hosted')}
                className={`flex-1 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  draftMode === 'self-hosted'
                    ? 'border-accent bg-accent-subtle text-ink-primary'
                    : 'border-surface-divider bg-surface-base text-ink-secondary hover:border-ink-muted/50 hover:text-ink-primary'
                }`}
              >
                <div className="font-semibold">Self-hosted</div>
                <div className="mt-0.5 text-2xs text-ink-muted">Your own server</div>
              </button>
            </div>
            <input
              type="url"
              value={draftUrl}
              onChange={(e) => {
                setDraftUrl(e.target.value);
                invalidateConnectionTest();
                invalidateKeyValidation();
              }}
              placeholder="http://localhost:3000"
              disabled={draftMode === 'cloud'}
              className="form-input mono mt-3 disabled:cursor-not-allowed disabled:opacity-60"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void runConnectionTest()}
                disabled={testState.kind === 'testing'}
                className="btn-secondary text-xs disabled:cursor-not-allowed disabled:opacity-60"
              >
                {testState.kind === 'testing' ? 'Testing…' : 'Test connection'}
              </button>
              {draftMode === 'self-hosted' && draftUrl !== SELF_HOSTED_DEFAULT && (
                <button
                  type="button"
                  onClick={() => {
                    setDraftUrl(SELF_HOSTED_DEFAULT);
                    invalidateConnectionTest();
                    invalidateKeyValidation();
                  }}
                  className="btn-secondary text-xs"
                >
                  Reset to default
                </button>
              )}
              {testState.kind === 'ok' && (
                <span className="text-2xs text-status-ready">
                  ✓ Reachable · <span className="mono">{testState.version.slice(0, 7)}</span>
                </span>
              )}
              {testState.kind === 'fail' && (
                <span className="whitespace-pre-line text-2xs text-status-error">
                  ✗ {testState.message}
                </span>
              )}
            </div>
            {draftMode === 'self-hosted' && (
              <span className="mt-2 block text-2xs text-ink-muted">
                The GUI is a control panel — it does NOT run the API server. Self-hosted means you
                run apps/server yourself (clone driftstackdev/driftstack-api +{' '}
                <span className="mono">npm install && cd apps/server && npm run dev</span>). The URL
                above tells the GUI where to find it.
              </span>
            )}
          </Field>
        </div>
      </Panel>

      <Panel>
        <SectionHeader
          icon={<IconActivity />}
          title="Connection test"
          description="Check the GUI can reach your configured API server."
        />
        <div className="mt-4">
          <ConnectivityView embedded />
        </div>
      </Panel>

      <Panel>
        <SectionHeader
          icon={<IconWindow />}
          title="Default session"
          description="What a freshly launched remote browser opens with."
        />
        <div className="mt-4">
          <Field label="Start URL">
            <input
              type="url"
              value={draftStartUrl}
              onChange={(e) => setDraftStartUrl(e.target.value)}
              placeholder="https://driftstack.dev"
              className={`form-input mono ${startUrlInvalid ? 'border-status-error' : ''}`}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={startUrlInvalid}
            />
            {startUrlInvalid ? (
              <span role="alert" className="mt-2 block text-2xs text-status-error">
                That isn’t a valid http(s) URL. Use something like https://example.com — file://,
                about:, and javascript: aren’t allowed.
              </span>
            ) : (
              <span className="mt-2 block text-2xs text-ink-muted">
                The page the remote browser opens when a session launches. http(s) only — saved as a
                full URL (https:// is added if you omit it).
              </span>
            )}
          </Field>
        </div>
      </Panel>

      <Panel>
        <SectionHeader
          icon={<IconShield />}
          title="Telemetry & diagnostics"
          description="Crash-only reporting — fully opt-in, never any session data."
        />
        <div className="mt-4">
          <Field label="Crash reports">
            <div className="flex flex-col gap-2">
              <RadioRow checked={draftTelemetry === null} onChange={() => setDraftTelemetry(null)}>
                Use platform default <span className="mono">({platformDefaultLabel})</span>
              </RadioRow>
              <RadioRow checked={draftTelemetry === true} onChange={() => setDraftTelemetry(true)}>
                Share crash reports with Driftstack
              </RadioRow>
              <RadioRow
                checked={draftTelemetry === false}
                onChange={() => setDraftTelemetry(false)}
              >
                Don't share crash reports
              </RadioRow>
            </div>
            <span className="mt-2.5 block text-2xs text-ink-muted">
              Crash-only: error messages, stack traces, app version, OS. Never API keys, profile
              data, or any session contents. Currently:{' '}
              <span className="mono">{effectiveTelemetry}</span>.
            </span>
          </Field>
        </div>
      </Panel>

      <Panel>
        <SectionHeader
          icon={<IconShield />}
          title="Updates"
          description="Signed builds, verified against Driftstack's key before anything is installed."
        />
        <div className="mt-4 flex flex-col gap-4">
          <Field label="Automatic updates">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                aria-label="Install updates automatically"
                data-field="auto-update"
                checked={settings.autoUpdate}
                onChange={(e) => void update({ autoUpdate: e.target.checked })}
                className="mt-0.5"
              />
              <span className="text-sm text-ink-secondary">Install updates without asking</span>
            </label>
            <span className="mt-2.5 block text-2xs text-ink-muted">
              Off by default: when an update is available you get a prompt naming the new version,
              and you choose when to install. Installing restarts the app, so even with this on an
              update is never applied while a session is running — a relaunch mid-session would lose
              live browser state.
            </span>
          </Field>

          <Field label="Version">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="mono text-sm text-ink-primary">{appVersion}</span>
              <button
                type="button"
                data-action="check-for-updates"
                disabled={updateCheck === 'checking'}
                onClick={() => void runUpdateCheck()}
                className="btn-secondary text-xs disabled:opacity-50"
              >
                {updateCheck === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
            {updateCheck !== 'idle' && updateCheck !== 'checking' && (
              <span
                role="status"
                data-field="update-check-result"
                className={`mt-2.5 block text-2xs ${
                  updateCheck === 'error' ? 'text-status-error' : 'text-ink-muted'
                }`}
              >
                {updateCheck === 'none' && 'You are on the latest version.'}
                {updateCheck === 'found' &&
                  `Version ${foundUpdate?.version ?? ''} is available — it will install shortly.`}
                {/* Say WHY rather than "check failed": offline and a blocked
                    endpoint are the common cases and neither is the app's fault. */}
                {updateCheck === 'error' &&
                  "Couldn't reach the update server. Check your connection and try again."}
              </span>
            )}
          </Field>
        </div>
      </Panel>

      <Panel>
        <SectionHeader
          icon={<IconSparkle />}
          title="AI & billing"
          description="How the AI chat's Claude usage gets paid for."
        />
        <div className="mt-4 flex flex-col gap-5">
          <Field label="Bundled AI usage">
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                // Both checkboxes on this page need a name a screen reader (and
                // a role query) can tell apart; neither had one.
                aria-label="Use bundled AI billing"
                data-field="bundled-llm-consent"
                checked={bundledLlmConsentDraft}
                disabled={bundledLlmSaving || bundledLlmLoad !== 'loaded'}
                onChange={(e) => {
                  setBundledLlmConsentDraft(e.target.checked);
                  setBundledLlmSavedAt(null); // #GUI-sweep — drop the stale "Saved." on edit
                }}
                className="mt-0.5 disabled:opacity-50"
              />
              <span className="text-sm text-ink-secondary">
                Let this deployment bill Claude usage to my account, up to a monthly limit.
              </span>
            </label>
            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs text-ink-muted">Monthly limit</span>
              <div className="flex items-center gap-1">
                <span className="text-sm text-ink-muted">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={bundledLlmCapDraft}
                  disabled={bundledLlmSaving || bundledLlmLoad !== 'loaded'}
                  onChange={(e) => {
                    setBundledLlmCapDraft(e.target.value);
                    setBundledLlmSavedAt(null); // #GUI-sweep — drop the stale "Saved." on edit
                  }}
                  className="form-input mono w-24 disabled:opacity-50"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleSaveBundledLlm()}
                disabled={bundledLlmSaving || bundledLlmLoad !== 'loaded'}
                aria-label="Save AI billing settings"
                className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {bundledLlmSaving ? 'Saving…' : 'Save'}
              </button>
              {bundledLlmSaveError === null && bundledLlmSavedAt !== null && (
                <span className="text-2xs text-status-ready">Saved.</span>
              )}
            </div>
            {bundledLlmSaveError !== null && (
              <span role="alert" className="mt-1.5 block text-2xs text-status-error">
                {bundledLlmSaveError}
              </span>
            )}
            {bundledLlmStatus !== null && (
              <span className="mt-2 block text-2xs text-ink-muted">
                Used {formatCentsAsUsd(bundledLlmStatus.used_this_month_cents)} of{' '}
                {formatCentsAsUsd(bundledLlmStatus.cap_cents)} this month (
                {formatCentsAsUsd(bundledLlmStatus.remaining_cents)} left).
              </span>
            )}
            {bundledLlmLoad === 'forbidden' && (
              <span className="mt-2 block text-2xs text-ink-muted">
                Only the account owner can change this — ask them if this control is unavailable.
              </span>
            )}
            {bundledLlmLoad === 'error' && (
              <span role="alert" className="mt-2 block text-2xs text-status-error">
                Couldn't load your AI billing settings — check your connection and reopen Settings.
              </span>
            )}
          </Field>

          <Field label="Bring your own Anthropic key">
            <span className="mb-2 block text-2xs text-ink-muted">
              BYOK always wins over bundled usage — set a key here and every AI chat message runs on
              it instead, billed directly by Anthropic to you.
            </span>
            {byok?.has_key === true ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-status-ready/10 px-2.5 py-1 text-status-ready">
                    ✓ Key set
                  </span>
                  {byok.last_used_at !== null && (
                    <span className="text-2xs text-ink-muted">
                      Last used <RelativeTime iso={byok.last_used_at} />
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleTestByokKey()}
                    disabled={byokBusy}
                    aria-label="Test Anthropic key"
                    className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    {byokActionKind === 'testing' ? 'Testing…' : 'Test connection'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleClearByokKey()}
                    disabled={byokBusy}
                    className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-50"
                  >
                    {byokActionKind === 'clearing' ? 'Clearing…' : 'Clear'}
                  </button>
                  {byokTestState.kind === 'ok' && (
                    <span className="text-2xs text-status-ready">✓ Working</span>
                  )}
                  {byokTestState.kind === 'fail' && (
                    <span className="text-2xs text-status-error">✗ {byokTestState.reason}</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="password"
                  value={byokKeyDraft}
                  onChange={(e) => setByokKeyDraft(e.target.value)}
                  placeholder="sk-ant-…"
                  className="form-input mono flex-1"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => void handleSetByokKey()}
                  disabled={byokBusy || byokKeyDraft.trim().length === 0}
                  className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  {byokActionKind === 'saving' ? 'Saving…' : 'Set key'}
                </button>
              </div>
            )}
            {byokSaveError !== null && (
              <span role="alert" className="mt-1.5 block text-2xs text-status-error">
                {byokSaveError}
              </span>
            )}
          </Field>
        </div>
      </Panel>

      {keyCheck.kind === 'fail' && (
        <div
          className="rounded-xl border border-status-error/30 bg-status-error/10 px-4 py-3 text-xs text-status-error"
          role="alert"
        >
          {keyCheck.message}
        </div>
      )}

      {/* V-324 — help links so customers don't have to dig through
          the marketing site to find status / docs / support contact
          from inside the app. */}
      <div className="border-t border-surface-divider pt-4">
        <span className="section-label">Need help?</span>
        <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-ink-secondary">
          <li>
            <a
              href="https://status.driftstack.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Status
            </a>
            <span className="ml-1 text-2xs text-ink-muted">— uptime + incidents</span>
          </li>
          <li>
            <a
              href="https://docs.driftstack.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Docs
            </a>
            <span className="ml-1 text-2xs text-ink-muted">— quickstart + reference</span>
          </li>
          <li>
            <a href="mailto:support@driftstack.dev" className="text-accent hover:underline">
              support@driftstack.dev
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}

function settingsProbeResponseError(status: number): string {
  if (status === 401 || status === 403) {
    return 'The server did not accept the sign-in or API key. Check it and try again.';
  }
  if (status === 429) return 'The server is receiving too many requests. Try again shortly.';
  if (status >= 500) return 'The service is temporarily unavailable. Try again shortly.';
  return 'The server returned an unexpected response. Check the URL and try again.';
}

// Console-style sectioned panel: a rounded, hairline-bordered raised card
// with tasteful elevation. The shared container for every settings group so
// the whole view reads with one consistent rhythm + density. Matches the
// Command Center's rounded-xl card language.
function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section
      className={`rounded-xl border border-surface-divider bg-surface-raised px-5 py-4 shadow-sm ${
        className ?? ''
      }`}
    >
      {children}
    </section>
  );
}

// Icon-led card header — an accent-tinted icon chip + a section label, with an
// optional one-line description. The shared heading idiom across every settings
// card so the page reads with one consistent rhythm (mirrors the Command
// Center's icon-chip + label pattern).
function SectionHeader({
  icon,
  title,
  description,
  titleClassName,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  titleClassName?: string;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-inset text-ink-secondary"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <span className={`section-label ${titleClassName ?? ''}`}>{title}</span>
        {description !== undefined && (
          <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {children}
    </label>
  );
}

// Selectable radio row — a bordered, accent-washed card when checked; preserves
// the native radio (name="telemetry") + its checked/onChange semantics exactly,
// only restyling the surrounding affordance.
function RadioRow({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
        checked
          ? 'border-accent bg-accent-subtle text-ink-primary'
          : 'border-surface-divider bg-surface-base text-ink-secondary hover:border-ink-muted/50 hover:text-ink-primary'
      }`}
    >
      <input
        type="radio"
        name="telemetry"
        className="accent-accent"
        checked={checked}
        onChange={onChange}
      />
      <span>{children}</span>
    </label>
  );
}

// ─── icons (Lucide-shape, inline, no dependency) — matches CommandCenterView ──
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
function IconCog(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="17" height="17" {...stroke}>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.25v1.5M8 13.25v1.5M14.75 8h-1.5M2.75 8h-1.5M12.77 3.23l-1.06 1.06M4.29 11.71l-1.06 1.06M12.77 12.77l-1.06-1.06M4.29 4.29 3.23 3.23" />
    </svg>
  );
}
function IconKey(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <circle cx="5" cy="11" r="2.5" />
      <path d="M6.75 9.25 13 3M11 5l1.5 1.5M9.5 6.5 11 8" />
    </svg>
  );
}
function IconLink(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" {...stroke}>
      <path d="M6.5 9.5a2.5 2.5 0 0 0 3.54 0l2-2a2.5 2.5 0 1 0-3.54-3.54l-1 1" />
      <path d="M9.5 6.5a2.5 2.5 0 0 0-3.54 0l-2 2a2.5 2.5 0 1 0 3.54 3.54l1-1" />
    </svg>
  );
}
function IconSwatch(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <circle cx="5.5" cy="5" r="1.75" />
      <path d="M8.5 2.25h5.25v5.25M13.75 2.25 8 8M2.25 8.5v3a2.25 2.25 0 0 0 4.5 0 2.25 2.25 0 0 0-4.5 0Z" />
    </svg>
  );
}
function IconWindow(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6h12M4.25 4.5h.01M5.75 4.5h.01" />
    </svg>
  );
}
function IconShield(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <path d="M8 1.75 13 3.5v4c0 3-2.1 5.4-5 6.75C5.1 12.9 3 10.5 3 7.5v-4Z" />
      <path d="M6 8l1.5 1.5L10.5 6.5" />
    </svg>
  );
}
function IconSparkle(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <path d="M8 1.5c.4 2.4 1.1 3.6 3.5 4.5C9.1 6.9 8.4 8.1 8 10.5c-.4-2.4-1.1-3.6-3.5-4.5C6.9 5.1 7.6 3.9 8 1.5Z" />
      <path d="M13 9.5c.2 1.1.5 1.6 1.5 2-1 .4-1.3.9-1.5 2-.2-1.1-.5-1.6-1.5-2 1-.4 1.3-.9 1.5-2Z" />
    </svg>
  );
}
function IconActivity(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" {...stroke}>
      <path d="M1.5 8h2.75l1.5-4.5 3 9 1.5-4.5h4.25" />
    </svg>
  );
}
