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

import { useState } from 'react';
import { ConnectivityView } from './ConnectivityView';
import { useBrowserSignIn } from '../lib/browser-sign-in';
import { diagnosticFetchError } from '../lib/diagnostic-fetch-error';
import { useSettings } from '../lib/SettingsContext';
import { isCloudBaseUrl } from '../lib/telemetry';
import { rememberedKeyFor } from '../lib/settings';
import { useConfirm } from '../components/ConfirmProvider';
import { useToasts } from '../lib/toasts';

const CLOUD_URL = 'https://api.driftstack.dev';
const SELF_HOSTED_DEFAULT = 'http://localhost:3000';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; version: string }
  | { kind: 'fail'; message: string };

export function SettingsView(): JSX.Element {
  const confirm = useConfirm();
  const { push: pushToast } = useToasts();
  const { settings, update, loading } = useSettings();
  const [draftKey, setDraftKey] = useState(settings.apiKey ?? '');
  const [draftUrl, setDraftUrl] = useState(settings.baseUrl);
  const [draftMode, setDraftMode] = useState<'cloud' | 'self-hosted'>(
    isCloudBaseUrl(settings.baseUrl) ? 'cloud' : 'self-hosted',
  );
  const [draftTelemetry, setDraftTelemetry] = useState<boolean | null>(settings.telemetryOptIn);
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

  /** Flip mode + auto-fill the URL. Cloud locks the URL; self-hosted
   *  keeps whatever the customer last typed (or the default). W584 — also
   *  auto-restores that deployment's remembered key so switching modes never
   *  asks the customer to re-paste a key they already entered once. */
  function switchMode(next: 'cloud' | 'self-hosted'): void {
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
    setTestState({ kind: 'idle' });
    setKeyCheck({ kind: 'idle' });
    void rememberedKeyFor(target).then((remembered) => {
      setDraftKey(remembered ?? '');
    });
  }

  async function runConnectionTest(): Promise<void> {
    const target = draftUrl.trim().replace(/\/+$/, '');
    setTestState({ kind: 'testing' });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${target}/version`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      window.clearTimeout(timer);
      if (!res.ok) {
        setTestState({ kind: 'fail', message: `HTTP ${res.status.toString()}` });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { git_sha?: string };
      setTestState({ kind: 'ok', version: body.git_sha ?? 'unknown' });
    } catch (err) {
      window.clearTimeout(timer);
      const diag = diagnosticFetchError(err, target);
      setTestState({
        kind: 'fail',
        message: diag ?? (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  if (loading) {
    return (
      <div role="status" aria-label="Loading settings" className="flex h-full flex-col gap-6 p-6">
        <span className="sr-only">Loading settings</span>
        <header
          className="flex flex-col gap-1 border-b border-surface-divider pb-4"
          aria-hidden="true"
        >
          <span className="section-label">Settings</span>
          <div className="h-6 w-44 animate-pulse rounded bg-surface-inset" />
          <div className="mt-1 h-4 w-80 animate-pulse rounded bg-surface-inset" />
        </header>
        <div className="flex max-w-xl flex-col gap-4" aria-hidden="true">
          <div className="h-28 animate-pulse rounded-lg border border-surface-divider bg-surface-raised" />
          <div className="h-40 animate-pulse rounded-lg border border-surface-divider bg-surface-raised" />
        </div>
      </div>
    );
  }

  const isFirstRun = settings.apiKey === null;

  // V-274 — inline browser sign-in (re-uses V-268 plumbing). Lets the
  // customer re-authorize without restarting the app post-Sign-out.
  const browserSignIn = useBrowserSignIn({
    baseUrl: draftUrl.trim().replace(/\/+$/, '') || settings.baseUrl,
    onSuccess: async (issuedKey, _accountId) => {
      await update({
        apiKey: issuedKey,
        baseUrl: draftUrl.trim().replace(/\/+$/, '') || settings.baseUrl,
        telemetryOptIn: draftTelemetry,
      });
      setDraftKey(issuedKey);
      setSavedAt(Date.now());
    },
  });

  // Copy the REAL API key (not the 12+4 masked display) so a customer can
  // paste it into a script / CI secret without re-minting. Clipboard writes
  // can fail in locked-down WKWebView contexts — fail quietly, no toast.
  async function handleCopyKey(): Promise<void> {
    if (settings.apiKey === null) return;
    try {
      await navigator.clipboard.writeText(settings.apiKey);
      pushToast({ title: 'Copied', tone: 'success' });
    } catch {
      /* clipboard write can fail in locked-down envs; silent */
    }
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    const url = draftUrl.trim().replace(/\/+$/, '') || 'http://localhost:3000';
    try {
      await update({
        apiKey: draftKey.length > 0 ? draftKey : null,
        baseUrl: url,
        telemetryOptIn: draftTelemetry,
      });
      setSavedAt(Date.now());
    } finally {
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
      setKeyCheck({ kind: 'idle' });
      return;
    }
    setKeyCheck({ kind: 'checking' });
    // Bound the validation like runConnectionTest — without an abort, a server
    // that hangs (rather than refusing) leaves keyCheck stuck on 'checking'
    // ("Validating key…") forever with no resolution.
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(`${url}/v1/account/me`, {
        headers: { authorization: `Bearer ${draftKey}` },
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      if (res.ok) {
        setKeyCheck({ kind: 'ok' });
      } else if (res.status === 401) {
        setKeyCheck({
          kind: 'fail',
          message: isCloudBaseUrl(url)
            ? 'Saved, but the key failed authentication (401). Double-check it, or create a new one at app.driftstack.dev/api-keys.'
            : `Saved, but the key failed authentication (401) against ${url}. In self-hosted mode the key must be created on that server's own dashboard — a key from app.driftstack.dev won't authenticate here.`,
        });
      } else {
        setKeyCheck({
          kind: 'fail',
          message: `Saved, but validation got HTTP ${String(res.status)} from ${url}.`,
        });
      }
    } catch (err) {
      window.clearTimeout(timer);
      setKeyCheck({
        kind: 'fail',
        message:
          diagnosticFetchError(err, url) ??
          `Saved, but ${url} is unreachable — the key couldn't be validated.`,
      });
    }
  }

  const dirty =
    draftKey !== (settings.apiKey ?? '') ||
    draftUrl !== settings.baseUrl ||
    draftTelemetry !== settings.telemetryOptIn;

  // V-242 — surface the platform default to the customer so they
  // understand what the "use default" choice means in their context.
  const cloudBaseUrl = isCloudBaseUrl(draftUrl);
  const platformDefaultLabel = cloudBaseUrl ? 'on (cloud default)' : 'off (self-hosted default)';
  const effectiveTelemetry =
    draftTelemetry === null ? (cloudBaseUrl ? 'on' : 'off') : draftTelemetry ? 'on' : 'off';

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      {/* Console hero: section-label + title + at-a-glance connection status
          on the left; the primary Save action anchored on the right. */}
      <header className="flex flex-wrap items-start gap-4 border-b border-surface-divider pb-4">
        <div className="min-w-0">
          <span className="section-label">Settings</span>
          <h2 className="mt-1 text-[19px] font-semibold tracking-tight text-ink-primary">
            API connection
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
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
              disabled={saving || !dirty}
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
      </header>

      {isFirstRun && (
        <Panel className="border-accent/40 bg-accent-subtle">
          <span className="section-label text-accent dark:text-ink-primary">No API key yet</span>
          <p className="mt-1.5 text-sm text-ink-secondary">
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
            <div className="mt-3 flex items-center gap-3">
              <div className="h-3 w-3 animate-pulse rounded-full bg-accent" aria-hidden="true" />
              <p className="text-xs text-ink-secondary">Waiting for browser confirmation…</p>
              <button
                type="button"
                className="text-xs text-ink-muted underline"
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
        <span className="section-label">Appearance</span>
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
              <span className="section-label">Connected</span>
              <p className="mt-1.5 text-sm text-ink-secondary">
                Pointing at <span className="mono">{settings.baseUrl}</span> with key{' '}
                <span className="mono">
                  {settings.apiKey?.slice(0, 12) ?? ''}…{settings.apiKey?.slice(-4) ?? ''}
                </span>
                .
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
                    { confirmLabel: 'Sign out' },
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
                }
              })();
            }}
          >
            Sign out
          </button>
        </Panel>
      )}

      <Panel>
        <span className="section-label">Authentication</span>
        <div className="mt-4 flex flex-col gap-5">
          <Field label="API key">
            <div className="flex gap-2">
              <input
                type={reveal ? 'text' : 'password'}
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
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
              onChange={(e) => setDraftUrl(e.target.value)}
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
                  onClick={() => setDraftUrl(SELF_HOSTED_DEFAULT)}
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
        <span className="section-label">Connection test</span>
        <div className="mt-4">
          <ConnectivityView embedded />
        </div>
      </Panel>

      <Panel>
        <span className="section-label">Privacy</span>
        <div className="mt-4">
          <Field label="Crash reports">
            <div className="flex flex-col gap-2.5">
              <label className="flex items-center gap-2 text-sm text-ink-secondary">
                <input
                  type="radio"
                  name="telemetry"
                  className="accent-accent"
                  checked={draftTelemetry === null}
                  onChange={() => setDraftTelemetry(null)}
                />
                <span>
                  Use platform default <span className="mono">({platformDefaultLabel})</span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm text-ink-secondary">
                <input
                  type="radio"
                  name="telemetry"
                  className="accent-accent"
                  checked={draftTelemetry === true}
                  onChange={() => setDraftTelemetry(true)}
                />
                <span>Share crash reports with Driftstack</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-ink-secondary">
                <input
                  type="radio"
                  name="telemetry"
                  className="accent-accent"
                  checked={draftTelemetry === false}
                  onChange={() => setDraftTelemetry(false)}
                />
                <span>Don't share crash reports</span>
              </label>
            </div>
            <span className="mt-2.5 block text-2xs text-ink-muted">
              Crash-only: error messages, stack traces, app version, OS. Never API keys, profile
              data, or any session contents. Currently:{' '}
              <span className="mono">{effectiveTelemetry}</span>.
            </span>
          </Field>
        </div>
      </Panel>

      {keyCheck.kind === 'fail' && (
        <div
          className="max-w-xl rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-xs text-status-error"
          role="alert"
        >
          {keyCheck.message}
        </div>
      )}

      {/* V-324 — help links so customers don't have to dig through
          the marketing site to find status / docs / support contact
          from inside the app. */}
      <div className="max-w-xl border-t border-surface-divider pt-4">
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

// Console-style sectioned panel: a rounded, hairline-bordered raised card
// with tasteful elevation. The shared container for every settings group so
// the whole view reads with one consistent rhythm + density.
function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section
      className={`max-w-xl rounded-lg border border-surface-divider bg-surface-raised px-5 py-4 shadow-sm ${
        className ?? ''
      }`}
    >
      {children}
    </section>
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
