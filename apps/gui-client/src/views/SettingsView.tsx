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
import { useBrowserSignIn } from '../lib/browser-sign-in';
import { useSettings } from '../lib/SettingsContext';
import { isCloudBaseUrl } from '../lib/telemetry';

export function SettingsView(): JSX.Element {
  const { settings, update, loading } = useSettings();
  const [draftKey, setDraftKey] = useState(settings.apiKey ?? '');
  const [draftUrl, setDraftUrl] = useState(settings.baseUrl);
  const [draftTelemetry, setDraftTelemetry] = useState<boolean | null>(settings.telemetryOptIn);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  if (loading) {
    return (
      <div className="p-6 text-ink-muted">
        <span className="section-label">Loading settings…</span>
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

  async function handleSave(): Promise<void> {
    setSaving(true);
    try {
      await update({
        apiKey: draftKey.length > 0 ? draftKey : null,
        baseUrl: draftUrl.trim().replace(/\/+$/, '') || 'http://localhost:3000',
        telemetryOptIn: draftTelemetry,
      });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
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
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <span className="section-label">Settings</span>
        <h2 className="text-lg font-medium text-ink-primary">API connection</h2>
        <p className="text-sm text-ink-secondary">
          Point the GUI at your Driftstack API server and authenticate with an API key.
        </p>
      </header>

      {isFirstRun && (
        <div className="max-w-xl rounded border border-accent/30 bg-accent-subtle/40 px-4 py-3">
          <span className="section-label text-accent">No API key yet</span>
          <p className="mt-1 text-sm text-ink-secondary">
            Sign in with your browser to mint a fresh API key bound to your account, or paste an
            existing key from <span className="mono">app.driftstack.dev/api-keys</span> below.
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
        </div>
      )}

      {!isFirstRun && (
        <div className="max-w-xl rounded border border-surface-divider bg-surface-raised px-4 py-3">
          <span className="section-label">Connected</span>
          <p className="mt-1 text-sm text-ink-secondary">
            Pointing at <span className="mono">{settings.baseUrl}</span> with key{' '}
            <span className="mono">
              {settings.apiKey?.slice(0, 12) ?? ''}…{settings.apiKey?.slice(-4) ?? ''}
            </span>
            .
          </p>
          <button
            type="button"
            className="btn-secondary mt-3"
            onClick={() => {
              if (
                window.confirm(
                  'Sign out of this device? This forgets the API key locally; the key is NOT revoked on the server. Revoke it from the dashboard if you want to fully invalidate it.',
                )
              ) {
                setDraftKey('');
                void update({
                  apiKey: null,
                  baseUrl: settings.baseUrl,
                  telemetryOptIn: settings.telemetryOptIn,
                });
              }
            }}
          >
            Sign out
          </button>
        </div>
      )}

      <div className="flex flex-col gap-4 max-w-xl">
        <Field label="API key">
          <div className="flex gap-2">
            <input
              type={reveal ? 'text' : 'password'}
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              placeholder="ds_live_…"
              className="mono flex-1 rounded bg-surface-inset px-2.5 py-1.5
                         text-ink-primary
                         placeholder:text-ink-muted
                         border border-surface-divider
                         focus-visible:border-accent
                         focus-visible:ring-1 focus-visible:ring-accent-ring"
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" className="btn-secondary" onClick={() => setReveal((r) => !r)}>
              {reveal ? 'Hide' : 'Show'}
            </button>
          </div>
          <span className="mt-1 block text-2xs text-ink-muted">
            Stored in your OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret
            Service); never sent anywhere except your configured API server.
          </span>
        </Field>

        <Field label="API base URL">
          <input
            type="url"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="http://localhost:3000"
            className="mono w-full rounded bg-surface-inset px-2.5 py-1.5
                       text-ink-primary
                       placeholder:text-ink-muted
                       border border-surface-divider
                       focus-visible:border-accent
                       focus-visible:ring-1 focus-visible:ring-accent-ring"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="mt-1 block text-2xs text-ink-muted">
            <span className="mono">https://api.driftstack.dev</span> for cloud (default for new
            installs). Self-hosted points at a Driftstack server you run yourself —{' '}
            <span className="mono">http://localhost:3000</span> matches{' '}
            <span className="mono">npm run dev</span> from apps/server, change the port if your
            deployment binds elsewhere.
          </span>
        </Field>

        <Field label="Crash reports">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-ink-secondary">
              <input
                type="radio"
                name="telemetry"
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
                checked={draftTelemetry === true}
                onChange={() => setDraftTelemetry(true)}
              />
              <span>Share crash reports with Driftstack</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-secondary">
              <input
                type="radio"
                name="telemetry"
                checked={draftTelemetry === false}
                onChange={() => setDraftTelemetry(false)}
              />
              <span>Don't share crash reports</span>
            </label>
          </div>
          <span className="mt-2 block text-2xs text-ink-muted">
            Crash-only: error messages, stack traces, app version, OS. Never API keys, profile data,
            or any session contents. Currently: <span className="mono">{effectiveTelemetry}</span>.
          </span>
        </Field>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {savedAt !== null && !dirty && <span className="text-2xs text-ink-muted">Saved.</span>}
        </div>

        {/* V-324 — help links so customers don't have to dig through
            the marketing site to find status / docs / support contact
            from inside the app. */}
        <div className="mt-8 max-w-xl border-t border-surface-divider pt-4">
          <span className="section-label">Need help?</span>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-secondary">
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
