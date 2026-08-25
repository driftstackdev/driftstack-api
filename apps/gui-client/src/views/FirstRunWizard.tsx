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

import { useEffect, useRef, useState } from 'react';
import {
  Driftstack,
  DriftstackError,
  ARCHETYPE_REGISTRY,
  type ArchetypeStatus,
} from '@driftstack/sdk';
import { TitleBar } from '../components/TitleBar';
import { useBrowserSignIn } from '../lib/browser-sign-in';
import { useSettings } from '../lib/SettingsContext';
import { diagnosticFetchError } from '../lib/diagnostic-fetch-error';
import { humanizeError } from '../lib/humanize-error';
import { addProxy, type ProxyDraft } from '../lib/proxies';
import { setDefaultProxy } from '../lib/profile-bindings';
import { buildWireGuardProxyInput, buildOpenVpnProxyInput } from '../lib/account-proxies';
import { parseWireGuardConfig } from '../lib/parse-wireguard';
import { validateOpenVpnConfig } from '../lib/parse-openvpn';

type WizardStep = 'welcome' | 'mode' | 'apikey' | 'profile' | 'done';
type DeploymentMode = 'cloud' | 'self-hosted';

const CLOUD_DEFAULT_URL = 'https://api.driftstack.dev';
// 2026-05-20 — port flipped from 7780 → 3000 to match
// apps/server/src/lib/config.ts (Fastify listens on 3000 by default).
// The old 7780 was an aspirational separate-from-dev-port choice that
// never matched what `npm run dev` actually bound to.
const SELF_HOSTED_DEFAULT_URL = 'http://localhost:3000';

// How long to wait in the "waiting for browser confirmation" state before we
// nudge the user toward the API-key paste fallback. A closed/lost OAuth tab
// otherwise leaves them staring at an indefinite spinner with no way forward
// unless they spot the small paste link (M10, first-run friendliness).
const SIGN_IN_SLOW_MS = 40_000;

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

  // Remember the last self-hosted URL the user typed so a cloud round-trip
  // doesn't lose it. Previously the mode effect reset baseUrl unconditionally, so
  // a self-hosted user who typed a custom URL, toggled to cloud, then back to
  // self-hosted got http://localhost:3000 instead of their URL (audit).
  const lastSelfHostedUrlRef = useRef(SELF_HOSTED_DEFAULT_URL);

  // Keep baseUrl in sync with the mode selection without clobbering a custom
  // self-hosted URL. Switching INTO cloud pins the (non-customizable) cloud URL;
  // switching INTO self-hosted restores the last self-hosted URL the user had.
  useEffect(() => {
    setBaseUrl(mode === 'cloud' ? CLOUD_DEFAULT_URL : lastSelfHostedUrlRef.current);
  }, [mode]);

  // 2026-05-20 — accept an explicit key override so the browser-sign-in
  // success callback can validate the JUST-issued key without waiting
  // for React state to commit (the prior setTimeout(0) + closure-read
  // pattern was unreliable and the wizard hung on "Authorized.
  // Continuing…" because validateAndSave read a stale apiKey from
  // closure).
  async function validateAndSave(overrideKey?: string): Promise<void> {
    setValidating(true);
    setValidationError(null);
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, '');
    const trimmedKey = (overrideKey ?? apiKey).trim();
    try {
      const client = new Driftstack({ apiKey: trimmedKey, baseUrl: trimmedUrl });
      await client.account.me();
      await update({ apiKey: trimmedKey, baseUrl: trimmedUrl }, { reportPersistenceFailure: true });
      setStep('profile');
    } catch (err) {
      setValidationError(
        diagnosticFetchError(err, trimmedUrl) ?? friendlyError(err, mode, trimmedUrl),
      );
    } finally {
      setValidating(false);
    }
  }

  function finish(): void {
    onComplete();
  }

  // Success path (signed in; profile created or skipped): show the "you're all
  // set" screen before handing off, so a first-time user gets a clear next step
  // instead of dropping straight into the shell (journey audit L1).
  function completeSetup(): void {
    setStep('done');
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-surface-base">
      <TitleBar subtitle="setup" />
      {/*
        `items-center` centres the card on the cross axis, which is right until the card
        is TALLER than the viewport. Then centring pushes its top ABOVE the scroll
        origin, and scrollTop cannot go below 0 — so the overflow is unreachable rather
        than scrollable. The profile step renders 81 archetype cards with no height cap,
        which on a laptop viewport put the heading and the profile-name input roughly
        2500px above the top of the scrollable area. Measured in headless Chromium (the
        WebView2 engine family): child height 5814px, child top -2508px, scrollHeight
        3300 against 5814 of content.
        The visible result was the reported bug: a wall of archetypes with the
        explanatory text missing and a permanently greyed-out Create button — greyed
        because `disabled={submitting || name.trim().length === 0}` and the name input
        was in the clipped region, so it could never be typed into. autoFocus did not
        rescue it either; the browser does not scroll a focused element into a region
        that negative scrollTop cannot reach.
        `items-start` with `my-auto` keeps the centring for cards that FIT and degrades
        to top-aligned, fully scrollable, when they do not.
      */}
      <main className="flex flex-1 items-start justify-center overflow-auto p-8">
        <div className="my-auto w-full max-w-xl">
          {step !== 'done' && <Stepper current={step} />}
          {step === 'welcome' && <WelcomeStep onNext={() => setStep('mode')} />}
          {step === 'mode' && (
            <ModeStep
              mode={mode}
              baseUrl={baseUrl}
              onModeChange={setMode}
              onBaseUrlChange={(next) => {
                setBaseUrl(next);
                // Stash the user's self-hosted URL so a cloud round-trip restores
                // it (the URL field is only editable in self-hosted mode).
                if (mode === 'self-hosted') lastSelfHostedUrlRef.current = next;
              }}
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
              onApiKeyChange={(v) => {
                setApiKey(v);
                // Editing the key invalidates a prior validation verdict so the
                // (possibly mode-specific) error doesn't linger against new input
                // until the next submit. (audit wiq542bfj P3)
                setValidationError(null);
              }}
              onBack={() => setStep('mode')}
              onValidate={(override) => void validateAndSave(override)}
            />
          )}
          {step === 'profile' && <ProfileStep onSkip={completeSetup} onCreated={completeSetup} />}
          {step === 'done' && (
            <section className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-status-success/15 text-2xl text-status-success">
                ✓
              </div>
              <h2 className="mt-4 text-xl font-semibold text-ink-primary">You’re all set</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm text-ink-secondary">
                Your account is connected. Head to{' '}
                <span className="font-medium text-ink-primary">Profiles</span> to launch your first
                live iPhone session.
              </p>
              <button type="button" className="btn-primary mt-6" onClick={onComplete}>
                Go to Profiles
              </button>
            </section>
          )}
          {(step === 'mode' || step === 'apikey') && (
            // Escape hatch: without this, a customer whose key/server won't
            // validate is trapped on the sign-in step with no way into the app
            // (onComplete was only reachable past validation). Skipping drops
            // them into the shell (unconnected, everything shows "Not connected")
            // where they can fix it in Settings; the wizard re-arms next launch
            // while the key is still unset.
            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={finish}
                className="text-xs text-ink-muted underline-offset-2 hover:text-ink-secondary hover:underline"
              >
                Skip for now — set this up later in Settings
              </button>
            </div>
          )}
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
    <nav aria-label="Setup progress" className="mb-8">
      <ol className="flex items-center gap-2">
        {STEP_ORDER.map((s, i) => {
          const active = i === currentIdx;
          const done = i < currentIdx;
          return (
            <li
              key={s}
              className="flex items-center gap-2"
              aria-current={active ? 'step' : undefined}
            >
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
                {active && <span className="sr-only"> (current step)</span>}
              </span>
              {i < STEP_ORDER.length - 1 && (
                <span aria-hidden="true" className="mx-2 h-px w-6 bg-surface-divider" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
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
              <strong>Free</strong> to start, or <strong>$79/mo</strong> Personal. Driftstack runs
              the fleet, handles updates, and bills via Stripe. Connects to{' '}
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
              operate yourself.{' '}
              <strong className="text-ink-primary">
                This GUI is just a control panel — it does NOT run the server.
              </strong>{' '}
              Pick this only if you already run a Driftstack server somewhere (this machine or
              elsewhere on your network); the URL below points the GUI at it.
            </div>
            <ul className="mt-2 space-y-0.5 text-[11px] text-ink-muted">
              <li>
                • Local dev: clone driftstackdev/driftstack-api, then{' '}
                <span className="mono">npm install && cd apps/server && npm run dev</span> (defaults
                to <span className="mono">http://localhost:3000</span>).
              </li>
              <li>
                • Production: bring your own Mac mini / Studio fleet + Postgres + Redis; operate
                updates yourself.
              </li>
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
                placeholder="http://localhost:3000"
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
  /** Optional override lets the browser-sign-in success callback
   *  pass the just-issued key directly, bypassing React state. */
  onValidate: (override?: string) => void;
}): JSX.Element {
  const [path, setPath] = useState<'browser' | 'paste'>('browser');
  // Flips true after SIGN_IN_SLOW_MS in the "waiting" state so we can surface
  // the paste fallback prominently (M10).
  const [signInSlow, setSignInSlow] = useState(false);

  const {
    state: browserState,
    start: startBrowserSignIn,
    cancel: cancelBrowserSignIn,
  } = useBrowserSignIn({
    baseUrl,
    onSuccess: (issuedKey) => {
      // Hand the plaintext key off to the existing paste/validate
      // flow so the same code path persists to keychain + advances
      // the wizard. 2026-05-20 — pass the key as an explicit override
      // to validateAndSave so it doesn't depend on React state being
      // committed (the setTimeout(0) + closure-read pattern was the
      // root cause of the wizard hanging on "Authorized. Continuing…"
      // — validateAndSave saw the stale apiKey from its closure, hit
      // /v1/account/me with an empty Bearer token, 401'd, and silently
      // stayed on the success state).
      onApiKeyChange(issuedKey);
      onValidate(issuedKey);
    },
  });

  // Arm the "taking a while" nudge only while we're actually waiting on the
  // browser tab; reset the moment we leave that state (success/error/cancel).
  useEffect(() => {
    if (browserState.kind !== 'waiting') {
      setSignInSlow(false);
      return;
    }
    const timer = setTimeout(() => setSignInSlow(true), SIGN_IN_SLOW_MS);
    return () => clearTimeout(timer);
  }, [browserState.kind]);

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
            <div className="rounded-md border border-surface-divider bg-surface-raised p-4">
              <div className="flex items-center gap-3">
                <div className="h-3 w-3 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                <p className="text-sm text-ink-secondary">Opening browser…</p>
              </div>
              <button type="button" className="btn-secondary mt-3" onClick={cancelBrowserSignIn}>
                Cancel
              </button>
            </div>
          )}

          {browserState.kind === 'waiting' && (
            <div
              className="rounded-md border border-surface-divider bg-surface-raised p-4"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center gap-3">
                <div className="h-3 w-3 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                <p className="text-sm text-ink-primary">Waiting for browser confirmation…</p>
              </div>
              <p className="mt-2 text-xs text-ink-secondary">
                Enter this verification code in the browser. Never share it with someone who
                contacted you.
              </p>
              <p className="mono mt-3 text-center text-2xl font-semibold tracking-[0.2em] text-ink-primary">
                {browserState.userCode}
              </p>
              <p className="mt-2 text-xs text-ink-secondary">
                The page updates automatically after you enter the code and confirm.
              </p>
              <button type="button" className="btn-secondary mt-3" onClick={cancelBrowserSignIn}>
                Cancel
              </button>
              {signInSlow && (
                <div className="mt-3 border-t border-surface-divider pt-3">
                  <p className="text-xs text-ink-secondary">
                    Taking longer than expected? If the browser tab didn’t open or you can’t finish
                    there, you can paste an API key instead.
                  </p>
                  <button
                    type="button"
                    className="btn-secondary mt-2"
                    onClick={() => {
                      cancelBrowserSignIn();
                      setPath('paste');
                    }}
                  >
                    Paste an API key instead
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Show "Authorized. Continuing…" ONLY while the post-auth key validation
              is still pending — if validateAndSave failed (error !== null), the auth
              succeeded but the key couldn't be validated, so the success line is
              suppressed and the error block below takes over (audit wiq542bfj: the
              wizard used to sit forever on a misleading "Authorized. Continuing…"). */}
          {browserState.kind === 'success' && error === null && (
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

          {/* Validation failed AFTER browser auth succeeded (transient /account/me
              error, or a self-hosted server rejecting a cloud key). Surface it in
              the browser path too — it was previously only rendered in paste mode,
              so a browser-path failure showed no error at all. */}
          {error !== null && (
            <div className="rounded-md border border-status-error/30 bg-status-error/5 p-4">
              <p className="whitespace-pre-line text-sm text-status-error" role="alert">
                {error}
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
          {/* Wrap the paste controls in a form so Enter in the key field submits
              (guarded identically to the footer button). The footer's primary
              button lives outside this element and targets it via form="…". */}
          <form
            id="apikey-paste-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (validating || apiKey.trim().length === 0) return;
              onValidate();
            }}
            className="mt-6"
          >
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
          </form>

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
            type="submit"
            form="apikey-paste-form"
            className="btn-primary"
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
//
// Derived from ARCHETYPE_REGISTRY (single source of truth) filtered to the
// customer-selectable statuses — 'launch' (the locked reference) + 'available'
// (fingerprint-atlas-ready) — exactly as ProfilesView does. 'reference' /
// 'planned' entries are intentionally excluded; a newly-promoted archetype
// lights up here automatically the moment A1 flips its status, with zero
// wizard change. The customer-facing copy lives in a per-id lookup with a
// generic fallback so a future archetype still renders a sensible blurb.
const SELECTABLE_STATUSES = new Set<ArchetypeStatus>(['launch', 'available']);
// Customer-facing copy per known archetype. A future promoted archetype with
// no entry here falls back to the registry's displayLabel + a generic blurb,
// so it still renders — the wizard never silently drops a selectable option.
const ARCHETYPE_LABELS: Record<string, string> = {
  iphone17_ios18_7_safari26_4: 'iPhone 17 · iOS 18.7 · Safari 26.4',
  iphone17_ios18_7_safari26_5: 'iPhone 17 · iOS 18.7 · Safari 26.5',
};
const ARCHETYPE_DESCRIPTIONS: Record<string, string> = {
  iphone17_ios18_7_safari26_4:
    'The default launch archetype — verified bit-for-bit against a real iPhone 17. Choose another verified device from the live catalog when its model or Safari version better matches your traffic.',
  iphone17_ios18_7_safari26_5:
    'iPhone 17 on the Safari 26.5 point release — verified bit-for-bit against a real device. Pick this to match visitors on the latest Safari.',
};
const PROFILE_ARCHETYPE_OPTIONS = ARCHETYPE_REGISTRY.filter((a) =>
  SELECTABLE_STATUSES.has(a.status),
).map((a) => ({
  value: a.id,
  label: ARCHETYPE_LABELS[a.id] ?? a.displayLabel,
  description:
    ARCHETYPE_DESCRIPTIONS[a.id] ??
    `${a.displayLabel} — verified bit-for-bit against a real device.`,
}));

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
  const [archetype, setArchetype] = useState<ProfileArchetype>('iphone17_ios18_7_safari26_4');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // V-1592 — attaching a proxy was possible from the Profiles modal and NOT
  // here, so the very first profile a customer creates was the one profile that
  // could not be given an egress. Collapsed by default: the wizard's job is to
  // get someone to a working app, and a profile with no proxy is still valid
  // (launch falls back to the first available one).
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxy, setProxy] = useState<{
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
  const isFileScheme = proxy.scheme === 'wireguard' || proxy.scheme === 'openvpn';

  /**
   * Turn the form into a ProxyDraft, or a message naming what is wrong.
   *
   * Parsing and validation are the SHARED lib helpers the Profiles modal uses —
   * `parseWireGuardConfig`, `validateOpenVpnConfig`, `build*ProxyInput`. Only
   * the presentation differs between the two surfaces, deliberately: a
   * first-run step should not look like the power-user modal. Re-implementing
   * the parsing here is what would make them diverge.
   */
  function buildProxyDraft(): ProxyDraft | { error: string } {
    const label = proxy.label.trim();
    if (label.length === 0) return { error: 'Proxy label is required.' };
    if (proxy.scheme === 'wireguard') {
      const built = buildWireGuardProxyInput(label, parseWireGuardConfig(proxy.configBlob));
      if ('error' in built) return { error: `WireGuard config: ${built.error}` };
      return {
        label,
        scheme: 'wireguard',
        host: built.host,
        port: built.port,
        username: null,
        password: null,
        wireguard: built.wireguard,
      };
    }
    if (proxy.scheme === 'openvpn') {
      const v = validateOpenVpnConfig(proxy.configBlob);
      if (!v.ok) return { error: `OpenVPN config: ${v.reason}` };
      const built = buildOpenVpnProxyInput(label, proxy.configBlob, {
        host: v.remoteHost,
        port: v.remotePort,
      });
      if ('error' in built) return { error: `OpenVPN config: ${built.error}` };
      return {
        label,
        scheme: 'openvpn',
        host: built.host,
        port: built.port,
        username: null,
        password: null,
        openvpn: built.openvpn,
      };
    }
    const portNum = Number.parseInt(proxy.port, 10);
    if (proxy.host.trim().length === 0 || Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return { error: 'Proxy host and a port between 1-65535 are all required.' };
    }
    return {
      label,
      scheme: proxy.scheme,
      host: proxy.host.trim(),
      port: portNum,
      username: proxy.username.trim().length > 0 ? proxy.username.trim() : null,
      password: proxy.password.length > 0 ? proxy.password : null,
    };
  }

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
      // 1. Mint the proxy FIRST, if one was configured. Ordering matters: a
      //    malformed .ovpn must not leave a billed profile behind, so the
      //    config is validated and created before anything else happens.
      let mintedProxyId: string | null = null;
      if (proxyOpen) {
        const draft = buildProxyDraft();
        if ('error' in draft) {
          setError(draft.error);
          setSubmitting(false);
          return;
        }
        const created = await addProxy(draft);
        mintedProxyId = created.id;
      }
      // 2. Create the profile.
      const profile = await client.profiles.create({ name: trimmed, archetype });
      // 3. Bind the proxy as the profile's default. BEST-EFFORT, mirroring the
      //    Profiles modal: the profile exists and is already billed, so a
      //    binding failure must not fail the wizard or re-create it. Launch
      //    falls back to the first available proxy, and the customer can
      //    re-bind from the profile row.
      if (mintedProxyId !== null) {
        await setDefaultProxy(profile.id, mintedProxyId).catch((err: unknown) => {
          console.warn('[first-run] setDefaultProxy failed (profile created):', err);
        });
      }
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

      {/* Wrap the name field in a form so Enter submits (guarded identically to
          the footer button). The Create button lives outside and targets it via
          form="…". */}
      <form
        id="first-profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (submitting || name.trim().length === 0) return;
          void handleCreate();
        }}
        className="mt-6"
      >
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
      </form>

      <fieldset className="mt-4">
        <legend className="section-label">Archetype</legend>
        <div className="mt-2 space-y-2">
          {PROFILE_ARCHETYPE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition ${
                archetype === opt.value
                  ? 'border-accent bg-accent-subtle'
                  : 'border-surface-divider bg-surface-raised hover:border-ink-muted/50'
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

      {/* V-1592 — optional egress. Collapsed so the default path stays two
          fields, but every scheme the Profiles modal accepts is reachable here,
          including a pasted or uploaded .ovpn / wg0.conf. */}
      <div className="mt-4" data-component="first-run-proxy">
        <button
          type="button"
          className="btn-secondary text-xs"
          aria-expanded={proxyOpen}
          onClick={() => setProxyOpen((v) => !v)}
          disabled={submitting}
        >
          {proxyOpen ? 'Remove proxy' : 'Attach a proxy (optional)'}
        </button>

        {proxyOpen && (
          <div className="mt-3 space-y-3 rounded-md border border-surface-divider bg-surface-raised p-3">
            <label className="flex flex-col gap-1.5">
              <span className="section-label">Proxy label</span>
              <input
                type="text"
                value={proxy.label}
                onChange={(e) => setProxy((p) => ({ ...p, label: e.target.value }))}
                className="w-full rounded-sm border border-surface-divider bg-surface-base px-2 py-1.5 text-sm text-ink-primary"
                placeholder="residential-uk"
                maxLength={120}
                disabled={submitting}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="section-label">Type</span>
              <select
                value={proxy.scheme}
                onChange={(e) =>
                  setProxy((p) => ({
                    ...p,
                    scheme: e.target.value as NonNullable<ProxyDraft['scheme']>,
                  }))
                }
                className="w-full rounded-sm border border-surface-divider bg-surface-base px-2 py-1.5 text-sm text-ink-primary"
                disabled={submitting}
              >
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP</option>
                <option value="openvpn">OpenVPN (.ovpn)</option>
                <option value="wireguard">WireGuard (wg0.conf)</option>
              </select>
            </label>

            {isFileScheme ? (
              <div className="space-y-2">
                <label className="flex flex-col gap-1.5">
                  <span className="section-label">
                    Paste your {proxy.scheme === 'wireguard' ? 'wg0.conf' : '.ovpn'}
                  </span>
                  <textarea
                    value={proxy.configBlob}
                    onChange={(e) => setProxy((p) => ({ ...p, configBlob: e.target.value }))}
                    rows={6}
                    className="w-full rounded-sm border border-surface-divider bg-surface-base px-2 py-1.5 font-mono text-2xs text-ink-primary"
                    placeholder={
                      proxy.scheme === 'wireguard'
                        ? '[Interface]\nPrivateKey = ...\n[Peer]\nEndpoint = host:51820'
                        : 'client\nremote vpn.example.com 1194\n...'
                    }
                    disabled={submitting}
                  />
                </label>
                <label className="block text-2xs text-ink-secondary">
                  …or upload the {proxy.scheme === 'wireguard' ? 'wg0.conf' : '.ovpn'} file
                  <input
                    type="file"
                    accept={
                      proxy.scheme === 'wireguard'
                        ? '.conf,.txt,text/plain'
                        : '.ovpn,.conf,.txt,text/plain'
                    }
                    className="mt-1 block w-full text-2xs text-ink-secondary"
                    disabled={submitting}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      // Clear FIRST so re-picking the same file fires change
                      // again — mirrors the Profiles modal.
                      e.target.value = '';
                      if (!file) return;
                      // FileReader rather than file.text(): it is what the
                      // Profiles modal uses, and it is the surface with the
                      // wider support floor.
                      const reader = new FileReader();
                      reader.onload = () => {
                        if (typeof reader.result !== 'string') return;
                        const text = reader.result;
                        setProxy((p) => ({
                          ...p,
                          configBlob: text,
                          // A label the customer has not typed yet is better
                          // filled from the filename than left empty — it is
                          // required, and the file already names the thing.
                          label:
                            p.label.trim().length > 0 ? p.label : file.name.replace(/\.[^.]+$/, ''),
                        }));
                      };
                      reader.onerror = () => setError('Could not read that file.');
                      reader.readAsText(file);
                    }}
                  />
                </label>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1.5">
                  <span className="section-label">Host</span>
                  <input
                    type="text"
                    value={proxy.host}
                    onChange={(e) => setProxy((p) => ({ ...p, host: e.target.value }))}
                    className="w-full rounded-sm border border-surface-divider bg-surface-base px-2 py-1.5 text-sm text-ink-primary"
                    placeholder="127.0.0.1"
                    disabled={submitting}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="section-label">Port</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={proxy.port}
                    onChange={(e) => setProxy((p) => ({ ...p, port: e.target.value }))}
                    className="w-full rounded-sm border border-surface-divider bg-surface-base px-2 py-1.5 text-sm text-ink-primary"
                    disabled={submitting}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="section-label">Username (optional)</span>
                  <input
                    type="text"
                    value={proxy.username}
                    onChange={(e) => setProxy((p) => ({ ...p, username: e.target.value }))}
                    className="w-full rounded-sm border border-surface-divider bg-surface-base px-2 py-1.5 text-sm text-ink-primary"
                    disabled={submitting}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="section-label">Password (optional)</span>
                  <input
                    type="password"
                    value={proxy.password}
                    onChange={(e) => setProxy((p) => ({ ...p, password: e.target.value }))}
                    className="w-full rounded-sm border border-surface-divider bg-surface-base px-2 py-1.5 text-sm text-ink-primary"
                    disabled={submitting}
                  />
                </label>
              </div>
            )}
          </div>
        )}
      </div>

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
          type="submit"
          form="first-profile-form"
          className="btn-primary"
          disabled={submitting || name.trim().length === 0}
        >
          {submitting ? 'Creating…' : 'Create profile'}
        </button>
      </div>
    </section>
  );
}

// ─── helpers ───────────────────────────────────────────────────────

function friendlyError(err: unknown, mode?: 'cloud' | 'self-hosted', baseUrl?: string): string {
  // W566 — a 401 on the key-validation call is the single most common
  // onboarding stumble, and the fix differs by deployment mode. A key is
  // bound to the server (and DB) it was minted on, so a cloud key fails
  // against a self-hosted server and vice-versa. Point the customer at the
  // RIGHT place instead of leaving them with a bare "unauthorized".
  if (err instanceof DriftstackError && err.status === 401) {
    if (mode === 'self-hosted') {
      const where = baseUrl
        ? `your own server's dashboard (${baseUrl})`
        : "your own server's dashboard";
      return `Authentication failed (401). In self-hosted mode the API key must be created on ${where} — a key from app.driftstack.dev won't authenticate against your own server.`;
    }
    return 'Authentication failed (401). Double-check the key, or create a new one at app.driftstack.dev/api-keys.';
  }
  return humanizeError(err, "Couldn't complete setup. Check the details and try again.");
}
