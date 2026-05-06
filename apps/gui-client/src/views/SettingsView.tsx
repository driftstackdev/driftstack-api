// Settings view — API key + base URL + telemetry toggle.
//
// V-241: API key now stored in OS keychain (macOS Keychain / Windows
// Credential Manager / Linux Secret Service); the masked input edits
// the keychain entry transparently via Tauri commands.
//
// V-242: telemetry toggle — Sentry crash-only opt-in. Defaults ON for
// cloud customers, OFF for self-hosted. Customer can override either
// direction.

import { useState } from 'react';
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

  async function handleSave(): Promise<void> {
    setSaving(true);
    try {
      await update({
        apiKey: draftKey.length > 0 ? draftKey : null,
        baseUrl: draftUrl.trim().replace(/\/+$/, '') || 'http://localhost:7780',
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
          <span className="section-label text-accent">First run</span>
          <p className="mt-1 text-sm text-ink-secondary">
            Don't have an API key yet? Mint one against your self-hosted server with{' '}
            <span className="mono">npm run admin:create-key</span> in the{' '}
            <span className="mono">driftstack-api</span> repo, or{' '}
            <span className="mono">POST /v1/admin/accounts/&lt;id&gt;/keys</span> against a running
            instance.
          </p>
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
            placeholder="http://localhost:7780"
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
            Default targets a local server on port 7780. Set to{' '}
            <span className="mono">https://api.driftstack.dev</span> for the cloud tier.
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
