// W485.C — drift guard for apps/gui-client/src/views/FirstRunWizard.tsx.
// V-244 first-run setup wizard. Drift here either drops the V-241 +
// V-184a 'no credentials yet' framing (the trigger condition for
// showing this wizard at all silently shifts) or breaks the V-274
// browser-sign-in fallback to API-key paste (customers without a
// reachable dashboard get stuck on the welcome screen).
//
//   • Framing pinned: 'V-244 — first-run setup wizard.' + 'Replaces
//     the V-184a-era show-Settings + a-banner first-run flow with
//     a guided multi-step path. Triggered when settings.apiKey is
//     null at app boot (the canonical no-credentials-yet signal —
//     V-241 keychain absence + no settings.json apiKey field).'
//   • CLOUD_DEFAULT_URL = 'https://api.driftstack.dev' +
//     SELF_HOSTED_DEFAULT_URL = 'http://localhost:7780'.
//   • STEP_ORDER 4-step list (welcome / mode / apikey / profile,
//     done excluded from stepper).
//   • V-268 sign-in framing pinned + V-274 'moved state-machine to
//     lib/browser-sign-in.ts so SettingsView can reuse it'.
//   • baseUrl trailing-slash strip (.replace(/\/+$/, '')) before
//     persist.
//   • V-669 PROFILE_ARCHETYPE_OPTIONS 2-option catalog with
//     iphone16pro 'Most popular' + iphone15pro 'Legacy' framing.
//   • Browser sign-in 4-state surface (idle / opening / waiting /
//     success / error).
//   • Anonymity (V-211 mirror): 'no founder name; no AI / Anthropic
//     references in any visible string.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/views/FirstRunWizard.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W485.C apps/gui-client/src/views/FirstRunWizard.tsx content parity', () => {
  const body = read(LIB);

  it("Framing pinned: 'V-244 — first-run setup wizard.' + 'Replaces the V-184a-era show-Settings + a-banner first-run flow with a guided multi-step path. Triggered when settings.apiKey is null at app boot (the canonical no-credentials-yet signal — V-241 keychain absence + no settings.json apiKey field).'", () => {
    expect(body).toMatch(/\/\/ V-244 — first-run setup wizard\./);
    expect(body).toMatch(
      /\/\/ Replaces the V-184a-era "show Settings \+ a banner" first-run flow\s*\/\/ with a guided multi-step path\. Triggered when `settings\.apiKey` is\s*\/\/ null at app boot \(the canonical "no credentials yet" signal —\s*\/\/ V-241 keychain absence \+ no settings\.json apiKey field\)\./,
    );
  });

  it("Steps framing pinned: 5-step list 'Welcome' / 'Deployment mode' (cloud vs self-hosted radio) / 'API key' (validated via client.account.me() so customer sees valid/wrong-key/unreachable before advancing) / 'First profile (skippable)' / 'Done' — pinned so the validation-before-advance UX stays documented", () => {
    expect(body).toMatch(
      /\/\/ {3}3\. API key — paste the key; validated via `client\.account\.me\(\)`\s*\/\/ {6}so the customer sees a clear "valid \/ wrong key \/ unreachable"\s*\/\/ {6}response before the wizard advances\./,
    );
    expect(body).toMatch(
      /\/\/ {3}4\. First profile \(skippable\) — name \+ archetype picker; calls\s*\/\/ {6}`client\.profiles\.create\(\)` against the just-validated client\./,
    );
  });

  it("Anonymity framing pinned (V-211 mirror): 'Driftstack voice everywhere; no founder name; no AI / Anthropic references in any visible string.' — pinned so the voice-discipline rule survives + visible strings don't accidentally leak AI/Anthropic references", () => {
    expect(body).toMatch(
      /\/\/ Anonymity \(V-211 mirror\): "Driftstack" voice everywhere; no\s*\/\/ founder name; no AI \/ Anthropic references in any visible string\./,
    );
  });

  it("CLOUD_DEFAULT_URL = 'https://api.driftstack.dev' + SELF_HOSTED_DEFAULT_URL = 'http://localhost:3000' module constants pinned (2026-05-20: SDK default port — was 7780, shifted to align with packages/sdk-typescript default) — pinned so cloud URL doesn't drift to a staging/dev host + self-hosted default stays consistent with the SDK base", () => {
    expect(body).toMatch(/const CLOUD_DEFAULT_URL = 'https:\/\/api\.driftstack\.dev';/);
    expect(body).toMatch(/const SELF_HOSTED_DEFAULT_URL = 'http:\/\/localhost:3000';/);
  });

  it("STEP_ORDER 4-step array ['welcome', 'mode', 'apikey', 'profile'] + STEP_LABELS 5-key record (welcome:Welcome / mode:Deployment / apikey:Sign in / profile:First profile / done:Done) — pinned so the stepper progression matches the WizardStep union and 'done' is intentionally excluded from STEP_ORDER (no stepper entry past the final step)", () => {
    expect(body).toMatch(
      /const STEP_ORDER: WizardStep\[\] = \['welcome', 'mode', 'apikey', 'profile'\];/,
    );
    expect(body).toMatch(
      /const STEP_LABELS: Record<WizardStep, string> = \{\s*welcome: 'Welcome',\s*mode: 'Deployment',\s*apikey: 'Sign in',\s*profile: 'First profile',\s*done: 'Done',\s*\};/,
    );
  });

  it('Stepper is accessible: <nav aria-label="Setup progress"> wrapping an <ol> of <li> steps, the active step carries aria-current="step" + an sr-only "(current step)" cue, and the connector rule is aria-hidden — pinned so a screen-reader user can tell which setup step they are on (the progress was previously conveyed by colour alone)', () => {
    expect(body).toMatch(/<nav aria-label="Setup progress" className="mb-8">\s*<ol /);
    expect(body).toMatch(/aria-current=\{active \? 'step' : undefined\}/);
    expect(body).toMatch(/\{active && <span className="sr-only"> \(current step\)<\/span>\}/);
    expect(body).toMatch(
      /<span aria-hidden="true" className="mx-2 h-px w-6 bg-surface-divider" \/>/,
    );
  });

  it("validateAndSave: baseUrl trimmed + trailing-slash stripped (.replace(/\\/+$/, '')) + apiKey trimmed (with ffe8bfa4 overrideKey-first fallback for the browser-sign-in stale-closure fix) before constructing one-shot Driftstack client + calling client.account.me() — pinned so a trailing-slash-typed URL doesn't double-slash in the SDK request path (which a strict server would 404 on), AND so the stale-closure bug (validateAndSave reading apiKey from old render closure → 401) can't re-emerge", () => {
    expect(body).toMatch(
      /const trimmedUrl = baseUrl\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\);\s*const trimmedKey = \(overrideKey \?\? apiKey\)\.trim\(\);/,
    );
    expect(body).toMatch(
      /const client = new Driftstack\(\{ apiKey: trimmedKey, baseUrl: trimmedUrl \}\);\s*await client\.account\.me\(\);/,
    );
    // 2026-05-20 — inline comment was dropped when the validateAndSave
    // function was rearchitected ffe8bfa4; pin the await update call
    // shape directly so the persist-through-settings flow stays load-bearing.
    expect(body).toMatch(
      /await update\(\s*\{ apiKey: trimmedKey, baseUrl: trimmedUrl \},\s*\{ reportPersistenceFailure: true \},?\s*\);/,
    );
  });

  it("baseUrl-mode sync useEffect: mode === 'cloud' → CLOUD_DEFAULT_URL else lastSelfHostedUrlRef.current — pinned so the URL field updates when the radio flips, and a cloud round-trip no longer clobbers the customer's custom self-hosted URL back to the default (audit): the last self-hosted URL the user typed is stashed in a ref (seeded from SELF_HOSTED_DEFAULT_URL) and restored when switching back to self-hosted", () => {
    expect(body).toMatch(/const lastSelfHostedUrlRef = useRef\(SELF_HOSTED_DEFAULT_URL\);/);
    expect(body).toMatch(
      /setBaseUrl\(mode === 'cloud' \? CLOUD_DEFAULT_URL : lastSelfHostedUrlRef\.current\);/,
    );
    expect(body).toMatch(/if \(mode === 'self-hosted'\) lastSelfHostedUrlRef\.current = next;/);
    expect(body).not.toMatch(
      /setBaseUrl\(mode === 'cloud' \? CLOUD_DEFAULT_URL : SELF_HOSTED_DEFAULT_URL\);/,
    );
  });

  it("V-268 + V-274 sign-in framing pinned: 'Default path: browser-OAuth handshake against the V-266 backend (initiate → user signs in via dashboard → poll exchange). Fallback path: paste an API key manually (for power users who already have a key, or self-hosted deployments where the dashboard isn't reachable).' + 'V-274 — moved the state-machine + poll logic to lib/browser-sign-in.ts so SettingsView can reuse it.' — pinned so the OAuth handshake + paste fallback dual-path stays documented", () => {
    expect(body).toMatch(
      /\/\/ V-268 — Sign-in step\. Default path: browser-OAuth handshake against\s*\/\/ the V-266 backend \(initiate → user signs in via dashboard → poll\s*\/\/ exchange\)\. Fallback path: paste an API key manually \(for power users\s*\/\/ who already have a key, or self-hosted deployments where the\s*\/\/ dashboard isn't reachable\)\./,
    );
    expect(body).toMatch(
      /\/\/ V-274 — moved the state-machine \+ poll logic to\s*\/\/ `lib\/browser-sign-in\.ts` so SettingsView can reuse it\./,
    );
  });

  it("Browser sign-in 5-kind state surface: idle (button) / opening (Opening browser…) / waiting (animated pulse + Cancel) / success (Authorized. Continuing…) / error (message + Try again) — pinned so all 5 visual states stay covered + the 'idle' branch contains the 'Sign in with browser' CTA that mints the API key bound to your account and stores it in the OS keychain", () => {
    expect(body).toMatch(/browserState\.kind === 'idle'/);
    expect(body).toMatch(/browserState\.kind === 'opening'/);
    expect(body).toMatch(/browserState\.kind === 'waiting'/);
    expect(body).toMatch(/\{browserState\.userCode\}/);
    expect(body).toMatch(/Never share it with someone who\s*contacted you/);
    expect(body).toMatch(/browserState\.kind === 'success'/);
    expect(body).toMatch(/browserState\.kind === 'error'/);
    expect(body).toMatch(/mint an API key bound to your account and store it in the OS keychain/);
  });

  it("Mode-step framing pinned: 'Almost everyone should choose Cloud. Self-hosted is for advanced teams running their own Mac fleet — much higher cost and operational overhead.' + cloud 'Free to start, or $79/mo Personal' + self-hosted 'License from $1,000/mo on top of the Mac hardware you provide' — pinned so the cloud-recommended framing + pricing anchors don't drift (trial pack retired 2026-05-27)", () => {
    expect(body).toMatch(
      /Almost everyone should choose <strong>Cloud<\/strong>\. Self-hosted is for advanced teams\s*running their own Mac fleet — much higher cost and operational overhead\./,
    );
    expect(body).toMatch(
      /<strong>Free<\/strong> to start, or <strong>\$79\/mo<\/strong> Personal\./,
    );
    expect(body).toMatch(
      /License from <strong>\$1,000\/mo<\/strong> on top of the Mac hardware you provide and\s*operate yourself\./,
    );
  });

  it("V-669 PROFILE_ARCHETYPE_OPTIONS derived from ARCHETYPE_REGISTRY (2026-06-19 de-dup): the catalog is no longer a hardcoded literal — it filters ARCHETYPE_REGISTRY by SELECTABLE_STATUSES ('launch' | 'available'), exactly as ProfilesView does, so a future promoted archetype appears automatically with zero wizard change. Per-id label + description lookups keep the customer-facing copy (launch-archetype iPhone 17 blurb) with a generic fallback for future entries. Pinned so the wizard stays registry-driven + never offers a non-selectable/detectably-wrong archetype.", () => {
    expect(body).toMatch(
      /\/\/ V-669 — archetype picker in the first-run wizard\. Aligns with the\s*\/\/ existing ARCHETYPES catalogue elsewhere in the GUI; selecting one\s*\/\/ here pre-seeds the profile's archetype field\./,
    );
    // Derivation: import the registry + filter on the selectable statuses
    // (prettier may reflow this import across lines, so match flexibly).
    expect(body).toMatch(/ARCHETYPE_REGISTRY,/);
    expect(body).toMatch(/type ArchetypeStatus,?\s*\}? from '@driftstack\/sdk';/);
    expect(body).toMatch(
      /const SELECTABLE_STATUSES = new Set<ArchetypeStatus>\(\['launch', 'available'\]\);/,
    );
    expect(body).toMatch(
      /const PROFILE_ARCHETYPE_OPTIONS = ARCHETYPE_REGISTRY\.filter\(\(a\) =>\s*SELECTABLE_STATUSES\.has\(a\.status\),\s*\)\.map\(\(a\) => \(\{/,
    );
    // The launch-archetype customer copy survives in the per-id lookup.
    expect(body).toMatch(
      /'The default launch archetype — verified bit-for-bit against a real iPhone 17\. Choose another verified device from the live catalog when its model or Safari version better matches your traffic\.',/,
    );
    expect(body).not.toMatch(/coming soon/i);
    // No hardcoded option-object literals remain (the source-of-truth is the
    // registry now, not a parallel list).
    expect(body).not.toMatch(/value: 'iphone17_ios18_7_safari26_4',/);
    expect(body).not.toMatch(/value: 'iphone16pro_ios18_7_safari26_4',/);
    expect(body).not.toMatch(/value: 'iphone15pro_ios17_5_safari17_5',/);
  });

  it("ProfileStep: default archetype state = 'iphone17_ios18_7_safari26_4' + Skip-for-now path (onSkip=completeSetup) flips step to 'done' — where the success screen's 'Go to Profiles' button calls onComplete — so skipping the optional profile step still lands on the 'You're all set' confirmation rather than dropping straight into the shell; the mode/apikey escape-hatch finish() just calls onComplete; name input maxLength=120 matches server schema bound", () => {
    expect(body).toMatch(/useState<ProfileArchetype>\('iphone17_ios18_7_safari26_4'\)/);
    // completeSetup flips to the 'done' confirmation (profile created OR skipped).
    expect(body).toMatch(/function completeSetup\(\): void \{\s*setStep\('done'\);\s*\}/);
    expect(body).toMatch(
      /\{step === 'profile' && <ProfileStep onSkip=\{completeSetup\} onCreated=\{completeSetup\} \/>\}/,
    );
    // The done screen's primary CTA is now 'Go to Profiles' (was 'Get started'),
    // wired straight to onComplete to hand off into the shell.
    expect(body).toMatch(
      /<button type="button" className="btn-primary mt-6" onClick=\{onComplete\}>\s*Go to Profiles\s*<\/button>/,
    );
    // The mode/apikey escape hatch simply completes without a 'done' detour.
    expect(body).toMatch(/function finish\(\): void \{\s*onComplete\(\);\s*\}/);
    expect(body).toMatch(/maxLength=\{120\}/);
  });

  it("Welcome step value-prop pinned: 'Real iPhone Safari sessions, on demand. Spin them up, drive them with the SDK or this desktop control panel, save profile state across runs, capture recordings.' + Cloud bullet 'No hardware, no setup — just a key and you're live.' + Self-hosted bullet 'For advanced teams running their own Mac fleet.' — pinned so the brand promise on first impression stays consistent", () => {
    expect(body).toMatch(
      /Real iPhone Safari sessions, on demand\. Spin them up, drive them with the SDK or this\s*desktop control panel, save profile state across runs, capture recordings\./,
    );
    expect(body).toMatch(/iPhone fleet\. No hardware, no setup — just a key and you're live\./);
    expect(body).toMatch(
      /server you operate yourself\. For advanced teams running their own Mac fleet\./,
    );
  });

  it("W566: friendlyError gives mode-aware 401 guidance — self-hosted mode tells the customer the key must come from their own server's dashboard (a cloud key won't authenticate), cloud mode points at app.driftstack.io/api-keys. Pinned so the most common onboarding 401 stumble keeps a deployment-correct fix instead of a bare 'unauthorized'", () => {
    expect(body).toMatch(/err instanceof DriftstackError && err\.status === 401/);
    expect(body).toMatch(
      /In self-hosted mode the API key must be created on \$\{where\} — a key from\s*app\.driftstack\.io won't authenticate against your own server\./,
    );
    expect(body).toMatch(
      /Authentication failed \(401\)\. Double-check the key, or create a new one at\s*app\.driftstack\.io\/api-keys\./,
    );
    // DriftstackError must be imported for the instanceof check to be real
    // (the SDK import also carries ARCHETYPE_REGISTRY since the 2026-06-19
    // archetype-derivation de-dup — see the V-669 pin above). Prettier may
    // reflow this import across lines, so match the members flexibly.
    expect(body).toMatch(/import \{\s*Driftstack,\s*DriftstackError,/);
    expect(body).toMatch(/type ArchetypeStatus,?\s*\}? from '@driftstack\/sdk';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
