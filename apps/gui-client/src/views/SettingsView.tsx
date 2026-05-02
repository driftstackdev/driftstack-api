// Settings view — API key + base URL editor.
//
// This is the first surface a fresh installation lands on. The API key
// is masked by default; "Show" reveals it for verification while
// editing. Both fields persist to the Tauri store on save.

import { useState } from 'react';
import { useSettings } from '../lib/SettingsContext';

export function SettingsView(): JSX.Element {
  const { settings, update, loading } = useSettings();
  const [draftKey, setDraftKey] = useState(settings.apiKey ?? '');
  const [draftUrl, setDraftUrl] = useState(settings.baseUrl);
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

  async function handleSave(): Promise<void> {
    setSaving(true);
    try {
      await update({
        apiKey: draftKey.length > 0 ? draftKey : null,
        baseUrl: draftUrl.trim().replace(/\/+$/, '') || 'http://localhost:7780',
      });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  const dirty = draftKey !== (settings.apiKey ?? '') || draftUrl !== settings.baseUrl;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <span className="section-label">Settings</span>
        <h2 className="text-lg font-medium text-ink-primary">API connection</h2>
        <p className="text-sm text-ink-secondary">
          Point the GUI at your Driftstack API server and authenticate with an API key.
        </p>
      </header>

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
            Stored in{' '}
            <span className="mono">~/Library/Application Support/dev.driftstack.gui/</span>; never
            sent to anywhere except your configured API server.
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
