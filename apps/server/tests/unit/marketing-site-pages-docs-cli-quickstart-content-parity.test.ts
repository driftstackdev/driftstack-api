// W513.A — drift guard for apps/marketing-site/src/pages/docs/cli-quickstart.astro.
// V-699 CLI quickstart. Drift here either changes the V-266 browser-OAuth
// activation flow (would create marketing↔CLI-auth-endpoint divergence) or
// shifts the install matrix (would mislead Homebrew/npm users).
//
//   • V-699 doc-comment framing + V-266 anchor.
//   • Install: brew install driftstack/tap/driftstack + npm -g @driftstack/cli.
//   • driftstack login 5-step flow: initiate → URL → browser → exchange → keyring.
//   • Activation codes expire 5 minutes + single-use.
//   • Common-commands surface: sessions list/create/navigate/destroy +
//     profiles snapshot + api-keys list/create/rotate.
//   • Profile config: --profile + --base-url + use-profile.
//   • --json flag + jq + exit code 0 success/non-zero error.
//   • DRIFTSTACK_API_KEY env-override + ds_live_ prefix.
//   • OS keyring service name 'driftstack-cli' + never-plaintext-on-disk.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/cli-quickstart.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W513.A apps/marketing-site/src/pages/docs/cli-quickstart.astro content parity', () => {
  const body = read(LIB);

  it("V-699 + V-266 framing pinned: 'CLI quickstart docs. Covers the install, the V-266 browser-OAuth-style activation flow, and the most common commands. Companion to /docs/api-quickstart (which targets direct-curl usage).' — pinned so the V-699 anchor + V-266-cross-ref + /docs/api-quickstart companion all survive (drift to dropping V-266 would orphan the auth-flow anchor from the source-of-truth endpoint)", () => {
    expect(body).toMatch(
      /\/\/ V-699 — CLI quickstart docs\. Covers the install, the V-266\s*\n?\s*\/\/ browser-OAuth-style activation flow, and the most common\s*\n?\s*\/\/ commands\. Companion to https:\/\/docs\.driftstack\.dev\/quickstart-curl\/ \(which targets\s*\n?\s*\/\/ direct-curl usage\)\./,
    );
  });

  it('3-install matrix pinned: brew install driftstack/tap/driftstack + npm install -g @driftstack/cli + driftstack --version → 2.3.x — pinned so the 3-install paths + version-floor stay consistent (drift to dropping the brew tap would orphan Homebrew users; drift to a different npm package name would create marketing↔npm divergence)', () => {
    expect(body).toMatch(/brew install driftstack\/tap\/driftstack/);
    expect(body).toMatch(/npm install -g @driftstack\/cli/);
    expect(body).toMatch(/driftstack --version/);
    expect(body).toMatch(/→ driftstack\/2\.3\.x/);
  });

  it('V-266 5-step browser-OAuth-style flow pinned: 1) POST /v1/auth/cli-authorize/initiate + 2) https://app.driftstack.dev/cli/authorize?code=…&state=… browser URL + 3) open or copy-paste + 4) sign-in + Authorize this CLI binding + 5) poll POST /v1/auth/cli-authorize/exchange + OS-keyring storage — pinned so the 5-step flow + 2-endpoint surface + Keychain/libsecret/Credential Manager triplet survive (drift to a different auth endpoint would create marketing↔CLI-route divergence; drift to dropping the keyring triplet would let customers think keys land in plaintext)', () => {
    expect(body).toMatch(
      /Mint a one-time activation code via\s*\n?\s*<code>POST \/v1\/auth\/cli-authorize\/initiate<\/code>/,
    );
    expect(body).toMatch(
      /Print a browser URL like\s*\n?\s*<code>https:\/\/app\.driftstack\.dev\/cli\/authorize\?code=…&amp;state=…<\/code>/,
    );
    expect(body).toMatch(
      /The CLI polls <code>POST \/v1\/auth\/cli-authorize\/exchange<\/code>\s*\n?\s*and once the binding lands, stores the plaintext API key in\s*\n?\s*the OS keyring \(macOS Keychain \/ Linux libsecret \/ Windows\s*\n?\s*Credential Manager\)/,
    );
  });

  it("Activation-code 5-minute expiry + single-use framing pinned: 'Activation codes expire in 5 minutes' + 'single-use — once the CLI binds + retrieves the key, the code is deleted so a second authorize attempt against the same code fails fast.' — pinned so the 5-min-expiry + single-use-on-bind commitments survive (drift to a longer window would create marketing↔auth-code-TTL divergence; drift to softening 'single-use' would let customers attempt replay attacks)", () => {
    expect(body).toMatch(
      /Activation codes expire in <strong>5 minutes<\/strong>\. If you\s*\n?\s*get an "expired" error, just re-run <code>driftstack login<\/code>\./,
    );
    expect(body).toMatch(
      /The flow is single-use — once the CLI binds \+ retrieves the\s*\n?\s*key, the code is deleted so a second authorize attempt\s*\n?\s*against the same code fails fast\./,
    );
  });

  it('Common-commands 7-verb surface: sessions list + sessions create --label + sessions navigate --url + profiles snapshot --session + sessions destroy + api-keys list + api-keys create --name + --scopes read,write — pinned so the 7-verb surface + scope-ladder pair survive (drift to dropping any verb would shrink the user-facing surface; drift to changing the scope pair would create marketing↔scope-enum divergence)', () => {
    expect(body).toMatch(/driftstack sessions list/);
    expect(body).toMatch(/driftstack sessions create --label "qa-run-001"/);
    expect(body).toMatch(/driftstack sessions navigate ses_… --url https:\/\/example\.com/);
    expect(body).toMatch(/driftstack profiles snapshot --session ses_… --label "post-login"/);
    expect(body).toMatch(/driftstack sessions destroy ses_…/);
    expect(body).toMatch(/driftstack api-keys list/);
    expect(body).toMatch(/driftstack api-keys create --name ci-bot --scopes read,write/);
  });

  it('Profile-config 3-flag surface: --profile + --base-url + config use-profile — pinned so the named-profile + staging-base-URL + default-profile-set commitments stay consistent (drift to dropping --base-url would force staging users to fork the CLI; drift to dropping the named-profile system would orphan multi-account setups)', () => {
    expect(body).toMatch(/driftstack login --profile team-prod/);
    expect(body).toMatch(/driftstack --profile team-prod sessions list/);
    expect(body).toMatch(/driftstack config use-profile team-prod/);
    expect(body).toMatch(/--base-url https:\/\/staging\.driftstack\.dev/);
  });

  it("--json + exit-code framing pinned: 'Add --json to any command to get the raw API response. Errors go to stderr; exit code 0 on success, non-zero on any HTTP error.' — pinned so the --json + stderr-routing + 0/non-zero exit-code contract survives (drift to dropping the exit-code contract would break shell-script integrations)", () => {
    expect(body).toMatch(
      /Add <code>--json<\/code> to any command to get the raw API\s*\n?\s*response\. Errors go to stderr; exit code 0 on success, non-\s*\n?\s*zero on any HTTP error\./,
    );
    expect(body).toMatch(/driftstack sessions list --json \| jq '\.data\[\] \| \.id'/);
  });

  it("Env-var override framing pinned: DRIFTSTACK_API_KEY=ds_live_… + DRIFTSTACK_BASE_URL + 'Env vars override the OS-keyring-stored profile. If both are set, env wins — useful for tests that want to ignore your personal profile without touching its config.' — pinned so the 2-env-var surface + env-overrides-keyring precedence survives (drift to flipping the precedence would create marketing↔CLI-config-precedence divergence)", () => {
    expect(body).toMatch(/export DRIFTSTACK_API_KEY=ds_live_…/);
    expect(body).toMatch(/export DRIFTSTACK_BASE_URL=https:\/\/api\.driftstack\.dev/);
    expect(body).toMatch(
      /Env vars override the OS-keyring-stored profile\. If both are\s*\n?\s*set, env wins/,
    );
  });

  it("Config storage 3-location framing: ~/.config/driftstack/profiles.toml (Linux) + macOS Application Support + OS keyring under driftstack-cli service name + 'Never plaintext on disk.' — pinned so the 3-location surface + never-plaintext-on-disk commitment survives (drift to dropping the never-plaintext claim would mislead about key-at-rest posture)", () => {
    expect(body).toMatch(/<code>~\/\.config\/driftstack\/profiles\.toml<\/code>/);
    expect(body).toMatch(
      /<code>~\/Library\/Application Support\/driftstack\/profiles\.toml<\/code> \(macOS\)/,
    );
    expect(body).toMatch(
      /OS keyring under the\s*\n?\s*<code>driftstack-cli<\/code> service name\. Never plaintext on disk\./,
    );
  });

  it('Troubleshooting 4-symptom framing: command-not-found + Authorization code expired + Keyring locked on Linux + Slow on first command — pinned so the 4-troubleshooting-symptom cluster + DRIFTSTACK_NO_KEYRING=1 env-fallback + Bun-warm-cache framing survive (drift to dropping the keyring-locked fallback would orphan headless-Linux users)', () => {
    expect(body).toMatch(/<dt><code>driftstack: command not found<\/code><\/dt>/);
    expect(body).toMatch(/<dt>"Authorization code expired" during login<\/dt>/);
    expect(body).toMatch(/<dt>"Keyring locked" on Linux<\/dt>/);
    expect(body).toMatch(
      /set <code>DRIFTSTACK_NO_KEYRING=1<\/code> \+ use env-var\s*\n?\s*auth instead/,
    );
    expect(body).toMatch(/<dt>Slow on first command after install<\/dt>/);
  });

  it("3-where-to-go-next: /docs/api-quickstart + /docs/api-keys + /docs/sessions — pinned so the 3-doc downstream navigation stays complete (drift to dropping /docs/sessions would orphan session-lifecycle discovery from the CLI's primary use-case)", () => {
    // S47 2026-07-07 (founder-approved: mirror deprecation): href re-pinned to the docs successor (display text keeps the historical path, which 301s to the same target).
    expect(body).toMatch(
      /<a href="https:\/\/docs\.driftstack\.dev\/quickstart-curl\/">\/docs\/api-quickstart<\/a>/,
    );
    expect(body).toMatch(/<a href="\/docs\/api-keys\/">\/docs\/api-keys<\/a>/);
    expect(body).toMatch(/<a href="\/docs\/sessions\/">\/docs\/sessions<\/a>/);
  });

  it('Support 2-channel framing: github.com/driftstackdev/driftstack-api/issues for CLI bugs + developers@driftstack.dev for auth-flow — pinned so the 2-channel routing stays consistent (drift to a different repo URL would create marketing↔GitHub divergence)', () => {
    expect(body).toMatch(
      /<a href="https:\/\/github\.com\/driftstackdev\/driftstack-api\/issues">github\.com\/driftstackdev\/driftstack-api<\/a>/,
    );
    expect(body).toMatch(
      /<a href="mailto:developers@driftstack\.dev">developers@driftstack\.dev<\/a>/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
