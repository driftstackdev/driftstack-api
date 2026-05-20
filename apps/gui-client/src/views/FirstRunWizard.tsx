// V-244 — first-run setup wizard.
//
// Replaces the V-184a-era "show Settings + a banner" first-run flow
// with a guided multi-step path. Triggered when `settings.apiKey` is
// null at app boot (the canonical "no credentials yet" signal —
// V-241 keychain absence + no settings.json apiKey field).
//
// Steps:
//   1. Welcome — brand intro + value prop ("control panel for the
//      Driftstack iPhone Safari fleet").
//   2. Deployment mode — cloud vs self-hosted radio. Sets baseUrl
//      to `https://api.driftstack.dev` or whatever the customer types.
//   3. API key — paste the key; validated via `client.account.me()`
//      so the customer sees a clear "valid / wrong key / unreachable"
//      response before the wizard advances.
//   4. First profile (skippable) — name + archetype picker; calls
//      `client.profiles.create()` against the just-validated client.
//   5. Done — flips a flag; main app shell takes over.
//
// Cross-platform: pure React + Tailwind; identical Win/Mac/Linux.
// Brand: oxblood D-badge + lowercase mono "driftstack" wordmark +
// slate palette (matches V-219* dashboard treatment + App.tsx
// TitleBar).
//
// Anonymity (V-211 mirror): "Driftstack" voice everywhere; no
// founder name; no AI / Anthropic references in any visible string.

import { useEffect, useState } from 'react';
import { Driftstack } from '@driftstack/sdk';
import { TitleBar } from '../components/TitleBar';
import { useBrowserSignIn } from '../lib/browser-sign-in';
import { useSettings } from '../lib/SettingsContext';
import { diagnosticFetchError } from '../lib/diagnostic-fetch-error';

type WizardStep = 'welcome' | 'mode' | 'apikey' | 'profile' | 'done';
type DeploymentMode = 'cloud' | 'self-hosted';

const CLOUD_DEFAULT_URL = 'https://api.driftstack.dev';
const SELF_HOSTED_DEFAULT_URL = 'http://localhost:7780';

export interface FirstRunWizardProps {
  /** Called when the wizard finishes (success or skip-to-app). */
  onComplete: () => void;
}

export function FirstRunWizard({ onComplete }: FirstRunWizardProps): JSX.Element {
  const { update } = useSettings();
  const [step, setStep] = useState<WizardStep>('welcome');
  const [mode, setMode] = useState<DeploymentMode>('cloud');
  const [baseUrl, setBaseUrl] = useState(CLOUD_DEFAULT_URL);
  const [apiKey, setApiKey] = useState('');
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Keep baseUrl in sync with the mode selection.
  useEffect(() => {
    setBaseUrl(mode === 'cloud' ? CLOUD_DEFAULT_URL : SELF_HOSTED_DEFAULT_URL);
  }, [mode]);

  async function validateAndSave(): Promise<void> {
    setValidating(true);
    setValidationError(null);
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, '');
    const trimmedKey = apiKey.trim();
    try {
      // Build a one-shot SDK client with the just-entered creds and
      // hit /v1/account/me. Any failure (invalid key, unreachable,
      // tier-suspended) surfaces as DriftstackError or fetch rejection.
      const client = new Driftstack({ apiKey: trimmedKey, baseUrl: trimmedUrl });
      await client.account.me();
      // Persist via the real settings flow (keychain for key, store
      // for baseUrl).
      await update({ apiKey: trimmedKey, baseUrl: trimmedUrl });
      setStep('profile');
    } catch (err) {
      setValidationError(diagnosticFetchError(err, trimmedUrl) ?? friendlyError(err));
    } finally {
      setValidating(false);
    }
  }

  function finish(): void {
    setStep('done');
    onComplete();
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-surface-base">
      <TitleBar subtitle="setup" />
      <main className="flex flex-1 items-center justify-center overflow-auto p-8">
        <div className="w-full max-w-xl">
          <Stepper current={step} />
          {step === 'welcome' && <WelcomeStep onNext={() => setStep('mode')} />}
          {step === 'mode' && (
            <ModeStep
              mode={mode}
              baseUrl={baseUrl}
              onModeChange={setMode}
              onBaseUrlChange={setBaseUrl}
              onBack={() => setStep('welcome')}
              onNext={() => setStep('apikey')}
            />
          )}
          {step === 'apikey' && (
            <ApiKeyStep
              mode={mode}
              baseUrl={baseUrl}
              apiKey={apiKey}
              validating={validating}
              error={validationError}
              onApiKeyChange={setApiKey}
              onBack={() => setStep('mode')}
              onValidate={() => void validateAndSave()}
            />
          )}
          {step === 'profile' && <ProfileStep onSkip={finish} onCreated={finish} />}
        </div>
      </main>
    </div>
  );
}

const STEP_ORDER: WizardStep[] = ['welcome', 'mode', 'apikey', 'profile'];
const STEP_LABELS: Record<WizardStep, string> = {
  welcome: 'Welcome',
  mode: 'Deployment',
  apikey: 'Sign in',
  profile: 'First profile',
  done: 'Done',
};

function Stepper({ current }: { current: WizardStep }): JSX.Element {
  const currentIdx = STEP_ORDER.indexOf(current);
  return (
    <div className="mb-8 flex items-center gap-2">
      {STEP_ORDER.map((s, i) => {
        const active = i === currentIdx;
        const done = i < currentIdx;
        return (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                active
                  ? 'bg-accent text-white'
                  : done
                    ? 'bg-accent-subtle text-accent'
                    : 'bg-surface-raised text-ink-muted'
              }`}
            >
              {i + 1}
            </div>
            <span
              className={`text-xs ${
                active ? 'text-ink-primary' : done ? 'text-ink-secondary' : 'text-ink-muted'
              }`}
            >
              {STEP_LABELS[s]}
            </span>
            {i < STEP_ORDER.length - 1 && <span className="mx-2 h-px w-6 bg-surface-divider" />}
          </div>
        );
      })}
    </div>
  );
}

// ─── steps ────────────────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }): JSX.Element {
  return (
    <section>
      <h1 className="text-2xl font-semibold text-ink-primary">Welcome to Driftstack</h1>
      <p className="mt-3 text-sm text-ink-secondary">
        Real iPhone Safari sessions, on demand. Spin them up, drive them with the SDK or this
        desktop control panel, save profile state across runs, capture recordings.
      </p>
      <ul className="mt-4 space-y-2 text-sm text-ink-secondary">
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-accent">•</span>
          <span>
            <strong className="text-ink-primary">Cloud sessions</strong> run on Driftstack's managed
            iPhone fleet. No hardware, no setup — just a key and you're live.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-accent">•</span>
          <span>
            <strong className="text-ink-primary">Self-hosted</strong> connects to a Driftstack
            server you operate yourself. For advanced teams running their own Mac fleet.
          </span>
        </li>
      </ul>
      <p className="mt-4 text-sm text-ink-secondary">
        Setup takes about a minute: pick deployment, paste your API key, optionally create a first
        profile.
      </p>
      <div className="mt-6 flex justify-end">
        <button type="button" className="btn-primary" onClick={onNext}>
          Get started
        </button>
      </div>
    </section>
  );
}

function ModeStep({
  mode,
  baseUrl,
  onModeChange,
  onBaseUrlChange,
  onBack,
  onNext,
}: {
  mode: DeploymentMode;
  baseUrl: string;
  onModeChange: (m: DeploymentMode) => void;
  onBaseUrlChange: (u: string) => void;
  onBack: () => void;
  onNext: () => void;
}): JSX.Element {
  return (
    <section>
      <h2 className="text-xl font-semibold text-ink-primary">Cloud or self-hosted?</h2>
      <p className="mt-2 text-sm text-ink-secondary">
        Almost everyone should choose <strong>Cloud</strong>. Self-hosted is for advanced teams
        running their own Mac fleet — much higher cost and operational overhead.
      </p>

      <div className="mt-6 flex flex-col gap-3">
        <label
          className={`flex cursor-pointer items-start gap-3 rounded-md border p-4 transition ${
            mode === 'cloud'
              ? 'border-accent bg-surface-raised'
              : 'border-surface-divider bg-surface-raised hover:border-accent'
          }`}
        >
          <input
            type="radio"
            name="mode"
            checked={mode === 'cloud'}
            onChange={() => onModeChange('cloud')}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="flex items-baseline gap-2">
              <div className="text-sm font-medium text-ink-primary">Cloud</div>
              <span className="rounded-sm bg-accent-subtle px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                Recommended
              </span>
            </div>
            <div className="mt-1 text-xs text-ink-secondary">
              From <strong>$2.99 trial pack</strong> or <strong>$79/mo</strong> Solo Manual.
              Driftstack runs the fleet, handles updates, and bills via Stripe. Connects to{' '}
              <span className="mono">api.driftstack.dev</span>.
            </div>
            <ul className="mt-2 space-y-0.5 text-[11px] text-ink-muted">
              <li>• No hardware to buy or maintain</li>
              <li>• Sessions ready in seconds</li>
              <li>• Auto-updates, monitoring, and support included</li>
            </ul>
          </div>
        </label>

        <label
          className={`flex cursor-pointer items-start gap-3 rounded-md border p-4 transition ${
            mode === 'self-hosted'
              ? 'border-accent bg-surface-raised'
              : 'border-surface-divider bg-surface-base hover:border-surface-divider'
          }`}
        >
          <input
            type="radio"
            name="mode"
            checked={mode === 'self-hosted'}
            onChange={() => onModeChange('self-hosted')}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="flex items-baseline gap-2">
              <div className="text-sm font-medium text-ink-primary">Self-hosted</div>
              <span className="rounded-sm border border-surface-divider px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                Advanced
              </span>
            </div>
            <div className="mt-1 text-xs text-ink-secondary">
              License from <strong>$1,000/mo</strong> on top of the Mac hardware you provide and
              operate yourself. Pick this only if you already run your own Driftstack server.
              Default <span className="mono">http://localhost:7780</span>; override below if your
              server lives elsewhere.
            </div>
            <ul className="mt-2 space-y-0.5 text-[11px] text-ink-muted">
              <li>• Bring your own Mac mini / Studio fleet</li>
              <li>• Operate updates, backups, and capacity yourself</li>
              <li>
                • Pricing details: <span className="mono">driftstack.dev/pricing</span>
              </li>
            </ul>
            {mode === 'self-hosted' && (
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => onBaseUrlChange(e.target.value)}
                className="mono mt-3 w-full rounded-sm border border-surface-divider bg-surface-base px-2 py-1 text-sm text-ink-primary"
                placeholder="http://localhost:7780"
                spellCheck={false}
                autoComplete="off"
              />
            )}
          </div>
        </label>
      </div>

      <div className="mt-6 flex justify-between">
        <button type="button" className="btn-secondary" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn-primary" onClick={onNext}>
          Next
        </button>
      </div>
    </section>
  );
}

// V-268 — Sign-in step. Default path: browser-OAuth handshake against
// the V-266 backend (initiate → user signs in via dashboard → poll
// exchange). Fallback path: paste an API key manually (for power users
// who already have a key, or self-hosted deployments where the
// dashboard isn't reachable).
//
// V-274 — moved the state-machine + poll logic to
// `lib/browser-sign-in.ts` so SettingsView can reuse it.

export function ApiKeyStep({
  mode,
  baseUrl,
  apiKey,
  validating,
  error,
  onApiKeyChange,
  onBack,
  onValidate,
}: {
  mode: DeploymentMode;
  baseUrl: string;
  apiKey: string;
  validating: boolean;
  error: string | null;
  onApiKeyChange: (s: string) => void;
  onBack: () => void;
  onValidate: () => void;
}): JSX.Element {
  const [path, setPath] = useState<'browser' | 'paste'>('browser');

  const {
    state: browserState,
    start: startBrowserSignIn,
    cancel: cancelBrowserSignIn,
  } = useBrowserSignIn({
    baseUrl,
    onSuccess: (issuedKey) => {
      // Hand the plaintext key off to the existing paste/validate
      // flow so the same code path persists to keychain + advances
      // the wizard.
      onApiKeyChange(issuedKey);
      // Defer one tick so React commits the apiKey state before
      // onValidate reads it.
      window.setTimeout(() => onValidate(), 0);
    },
  });

  return (
    <section>
      <h2 className="text-xl font-semibold text-ink-primary">Sign in to Driftstack</h2>
      <p className="mt-2 text-sm text-ink-secondary">
        {mode === 'cloud'
          ? 'Open the dashboard in your browser to authorize this device. We never see your password.'
          : 'Open your self-hosted dashboard to authorize this device. Falls back to API-key paste below if your dashboard isn’t reachable from this machine.'}
      </p>

      {path === 'browser' && (
        <div className="mt-6 flex flex-col gap-4">
          {browserState.kind === 'idle' && (
            <>
              <button
                type="button"
                className="btn-primary w-full"
                onClick={() => void startBrowserSignIn()}
              >
                Sign in with browser
              </button>
              <p className="text-2xs text-ink-muted">
                Opens <span className="mono">{baseUrl}</span> in your browser. After you confirm, we
                mint an API key bound to your account and store it in the OS keychain.
              </p>
            </>
          )}

          {browserState.kind === 'opening' && (
            <div className="rounded-md border border-surface-divider bg-surface-raised p-4 text-sm text-ink-secondary">
              Opening browser…
            </div>
          )}

          {browserState.kind === 'waiting' && (
            <div className="rounded-md border border-surface-divider bg-surface-raised p-4">
              <div className="flex items-center gap-3">
                <div className="h-3 w-3 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                <p className="text-sm text-ink-primary">Waiting for browser confirmation…</p>
              </div>
              <p className="mt-2 text-xs text-ink-secondary">
                Complete the authorization in your browser tab. This page updates automatically once
                you confirm.
              </p>
              <button type="button" className="btn-secondary mt-3" onClick={cancelBrowserSignIn}>
                Cancel
              </button>
            </div>
          )}

          {browserState.kind === 'success' && (
            <div className="rounded-md border border-status-success/30 bg-status-success/5 p-4 text-sm text-ink-primary">
              Authorized. Continuing…
            </div>
          )}

          {browserState.kind === 'error' && (
            <div className="rounded-md border border-status-error/30 bg-status-error/5 p-4">
              <p className="whitespace-pre-line text-sm text-status-error">
                {browserState.message}
              </p>
              <button
                type="button"
                className="btn-primary mt-3"
                onClick={() => void startBrowserSignIn()}
              >
                Try again
              </button>
            </div>
          )}

          <button
            type="button"
            className="self-start text-xs text-ink-muted underline hover:text-ink-secondary"
            onClick={() => {
              cancelBrowserSignIn();
              setPath('paste');
            }}
          >
            Have an API key? Paste it instead
          </button>
        </div>
      )}

      {path === 'paste' && (
        <>
          <div className="mt-6">
            <label className="flex flex-col gap-1.5">
              <span className="section-label">API key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                className="mono w-full rounded-sm border border-surface-divider bg-surface-base px-2 py-1.5 text-sm text-ink-primary"
                placeholder="ds_live_…"
                spellCheck={false}
                autoComplete="off"
                autoFocus
              />
              <span className="text-2xs text-ink-muted">
                {mode === 'cloud' ? (
                  <>
                    Find your API key at <span className="mono">app.driftstack.dev/api-keys</span>.
                  </>
                ) : (
                  <>Mint a key against your self-hosted server.</>
                )}{' '}
                Stored in your OS keychain (macOS Keychain / Windows Credential Manager / Linux
                Secret Service).
              </span>
            </label>
          </div>

          {error !== null && (
            <p className="mt-4 whitespace-pre-line text-xs text-status-error" role="alert">
              {error}
            </p>
          )}

          <button
            type="button"
            className="mt-4 self-start text-xs text-ink-muted underline hover:text-ink-secondary"
            onClick={() => setPath('browser')}
          >
            ← Use browser sign-in instead
          </button>
        </>
      )}

      <div className="mt-8 flex justify-between">
        <button type="button" className="btn-secondary" onClick={onBack} disabled={validating}>
          Back
        </button>
        {path === 'paste' && (
          <button
            type="button"
            className="btn-primary"
            onClick={onValidate}
            disabled={validating || apiKey.trim().length === 0}
          >
            {validating ? 'Validating…' : 'Validate + continue'}
          </button>
        )}
      </div>
    </section>
  );
}

// V-669 — archetype picker in the first-run wizard. Aligns with the
// existing ARCHETYPES catalogue elsewhere in the GUI; selecting one
// here pre-seeds the profile's archetype field.
const PROFILE_ARCHETYPE_OPTIONS = [
  {
    value: 'iphone16pro_ios18_7_safari26_4',
    label: 'iPhone 16 Pro · iOS 18.7 · Safari 26.4',
    description:
      'Most popular — matches the default fleet image. Pick this unless you know you need something else.',
  },
  {
    value: 'iphone15pro_ios17_5_safari17_5',
    label: 'iPhone 15 Pro · iOS 17.5 · Safari 17.5',
    description: 'Legacy archetype — match a production user base still on the prior generation.',
  },
] as const;

type ProfileArchetype = (typeof PROFILE_ARCHETYPE_OPTIONS)[number]['value'];

export function ProfileStep({
  onSkip,
  onCreated,
}: {
  onSkip: () => void;
  onCreated: () => void;
}): JSX.Element {
  const { client } = useSettings();
  const [name, setName] = useState('');
  const [archetype, setArchetype] = useState<ProfileArchetype>('iphone16pro_ios18_7_safari26_4');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(): Promise<void> {
    if (!client) {
      setError('No client configured.');
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await client.profiles.create({ name: trimmed, archetype });
      onCreated();
    } catch (err) {
      setError(friendlyError(err));
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h2 className="text-xl font-semibold text-ink-primary">Create your first profile</h2>
      <p className="mt-2 text-sm text-ink-secondary">
        Profiles are persistent identity slots — cookies, localStorage, and other browser state
        carry across sessions tied to the same profile. You can skip this and create profiles later;
        the customer dashboard + GUI both support it.
      </p>

      <div className="mt-6">
        <label className="flex flex-col gap-1.5">
          <span className="section-label">Profile name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-sm border border-surface-divider bg-surface-base px-2 py-1.5 text-sm text-ink-primary"
            placeholder="my-recurring-workflow"
            maxLength={120}
            disabled={submitting}
            autoFocus
          />
        </label>
      </div>

      <fieldset className="mt-4">
        <legend className="section-label">Archetype</legend>
        <div className="mt-2 space-y-2">
          {PROFILE_ARCHETYPE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition ${
                archetype === opt.value
                  ? 'border-accent bg-accent-subtle'
                  : 'border-surface-divider bg-surface-raised hover:border-surface-strong'
              }`}
            >
              <input
                type="radio"
                name="profile-archetype"
                value={opt.value}
                checked={archetype === opt.value}
                onChange={() => setArchetype(opt.value)}
                disabled={submitting}
                className="mt-0.5"
              />
              <span className="flex-1">
                <span className="block text-sm font-medium text-ink-primary">{opt.label}</span>
                <span className="mt-0.5 block text-xs text-ink-secondary">{opt.description}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-2xs text-ink-muted">
          Additional archetypes can be added later from the Profiles view.
        </p>
      </fieldset>

      {error !== null && (
        <p className="mt-4 text-xs text-status-error" role="alert">
          {error}
        </p>
      )}

      <div className="mt-6 flex justify-between">
        <button type="button" className="btn-secondary" onClick={onSkip} disabled={submitting}>
          Skip for now
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void handleCreate()}
          disabled={submitting || name.trim().length === 0}
        >
          {submitting ? 'Creating…' : 'Create profile'}
        </button>
      </div>
    </section>
  );
}

// ─── helpers ───────────────────────────────────────────────────────

function friendlyError(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}
