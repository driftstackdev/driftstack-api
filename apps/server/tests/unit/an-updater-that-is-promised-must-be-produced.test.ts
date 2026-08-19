// The desktop app shipped an auto-updater that could never have updated anything.
//
// Three things have to agree for the Tauri updater to work, and they were arranged so
// that two of them promised what the third never delivered:
//
//   1. `tauri.conf.json` → `plugins.updater.endpoints` points at
//      `…/releases/latest/download/latest.json`, and a pubkey is wired.
//   2. `.github/workflows/gui-release.yml` passes `TAURI_SIGNING_PRIVATE_KEY`, and its
//      generated release notes tell every customer: "Subsequent versions auto-update
//      via the Tauri Updater (public-key signed). The manifest at `latest.json` is
//      consumed by every running install."
//   3. `bundle.createUpdaterArtifacts` — which decides whether the signed `.nsis.zip` /
//      `.tar.gz` payloads and their `.sig` files exist at all — was ABSENT.
//
// Tauri v2 defaults that option to **false** (verified against the CLI's own shipped
// `config.schema.json`, `BundleConfig.properties.createUpdaterArtifacts.default`). So the
// first release would have produced installers, no `.sig` files, and therefore no
// `latest.json` for tauri-action to assemble — an endpoint 404ing forever against a
// manifest nobody generated, while the release notes said updates were signed and live.
//
// It went unnoticed for the most ordinary reason: no release has ever been cut. There
// are zero GitHub releases and zero `gui-v*` tags, so the updater has never had a chance
// to not work. The defect is real and simply had no opportunity to surface — which is
// exactly when a guard is cheap and after which it is an incident.
//
// ── the invariant ─────────────────────────────────────────────────────────────
//
// Not "createUpdaterArtifacts must be true" — that is the fix, and pinning a fix teaches
// nobody why. The invariant is the AGREEMENT: if the app declares an updater endpoint,
// AND the release workflow supplies a signing key, THEN the bundle must be configured to
// emit the artifacts that endpoint serves. Any one of the three may be removed; what is
// forbidden is two of them promising and the third staying silent.
//
// ⚠️ This does NOT prove the updater works end to end. That needs a real release, a real
// manifest fetch, and a real install — none of which exist yet. It proves the three
// declarations cannot silently disagree again.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const CONF = resolve(REPO, 'apps/gui-client/src-tauri/tauri.conf.json');
const RELEASE = resolve(REPO, '.github/workflows/gui-release.yml');
const SCHEMA = resolve(REPO, 'node_modules/@tauri-apps/cli/config.schema.json');

const read = (p: string): string => readFileSync(p, 'utf8');

interface TauriConf {
  bundle?: { createUpdaterArtifacts?: boolean; targets?: string[] };
  plugins?: { updater?: { endpoints?: string[]; pubkey?: string } };
}

const conf = (): TauriConf => JSON.parse(read(CONF)) as TauriConf;

describe('an updater that is promised must be produced', () => {
  it("CRITICAL Tauri really does default createUpdaterArtifacts to FALSE, read from the CLI's own schema rather than remembered. The whole defect rests on that default: if it were true, an absent key would be harmless and this file would be guarding nothing.", () => {
    const schema = JSON.parse(read(SCHEMA)) as {
      definitions: Record<string, { properties: Record<string, { default?: unknown }> }>;
    };
    const prop = schema.definitions.BundleConfig?.properties?.createUpdaterArtifacts;
    expect(
      prop,
      'the option vanished from the Tauri schema — this guard needs rewriting',
    ).toBeDefined();
    expect(
      prop?.default,
      'Tauri now defaults createUpdaterArtifacts to something other than false; re-derive whether an absent key is still a defect',
    ).toBe(false);
  });

  it('CRITICAL the three declarations agree: an updater endpoint plus a signing key in the release workflow REQUIRES the bundle to emit updater artifacts. This is the invariant, not the fix — remove any one leg and the requirement lifts; keep two and the third cannot stay silent.', () => {
    const c = conf();
    const endpoints = c.plugins?.updater?.endpoints ?? [];
    const workflow = read(RELEASE);
    const signs = workflow.includes('TAURI_SIGNING_PRIVATE_KEY');

    // Premise check: both promising legs are actually present, so the requirement
    // below is live rather than vacuously satisfied by a missing endpoint.
    expect(endpoints.length, 'the app declares no updater endpoint').toBeGreaterThan(0);
    expect(signs, 'the release workflow supplies no signing key').toBe(true);

    expect(
      c.bundle?.createUpdaterArtifacts,
      'the app points at an updater manifest and the release job signs artifacts, but the bundle does not produce them — the endpoint would 404 forever while the release notes promise signed auto-updates',
    ).toBe(true);
  });

  it('CRITICAL the endpoint filename matches what the release job actually publishes. tauri-action assembles the manifest as `latest.json`; an endpoint naming anything else is a 404 that looks like a working configuration, and the repo has carried a contradictory `gui-latest.json` reference elsewhere.', () => {
    const endpoints = conf().plugins?.updater?.endpoints ?? [];
    const bad = endpoints.filter((e) => !e.endsWith('/latest.json'));
    expect(
      bad,
      `updater endpoint(s) not naming latest.json, which is the only manifest tauri-action writes:\n  ${bad.join('\n  ')}`,
    ).toEqual([]);
  });

  it('CRITICAL the pubkey is a placeholder the release job substitutes, never a literal committed here. A hardcoded key would be both a rotation hazard and a silent mismatch with whatever the job signs with.', () => {
    const pubkey = conf().plugins?.updater?.pubkey ?? '';
    expect(pubkey, 'no updater pubkey is configured').not.toBe('');
    expect(
      pubkey.startsWith('$'),
      `the updater pubkey is a committed literal rather than a substituted placeholder: ${pubkey.slice(0, 24)}…`,
    ).toBe(true);
    expect(
      read(RELEASE).includes(pubkey.replace('$', '')),
      'the release workflow does not substitute the placeholder this config declares',
    ).toBe(true);
  });

  it('the Windows target that the updater capability is scoped to is actually built. The updater capability names windows and linux specifically, so a bundle that stopped emitting an installer for one of them would leave a capability pointing at a platform with nothing to update.', () => {
    const targets = conf().bundle?.targets ?? [];
    const cap = JSON.parse(
      read(resolve(REPO, 'apps/gui-client/src-tauri/capabilities/updater-windows-linux.json')),
    ) as { platforms?: string[] };
    const platforms = cap.platforms ?? [];
    // V-972 — every assertion used to sit inside an `if (platforms.includes(…))`,
    // so an empty or renamed `platforms` list made the arm pass having checked
    // nothing. The platform list is now asserted to be real, and the per-platform
    // checks are collected into one list that must be empty — so the arm asserts
    // on every run whatever `platforms` contains.
    expect(platforms.length, 'the updater capability still names platforms').toBeGreaterThan(0);
    const unbuilt: string[] = [];
    if (platforms.includes('windows') && !targets.some((t) => t === 'nsis' || t === 'msi')) {
      unbuilt.push('windows: the updater is scoped to it but no nsis/msi target is built');
    }
    if (
      platforms.includes('linux') &&
      !targets.some((t) => t === 'appimage' || t === 'deb' || t === 'rpm')
    ) {
      unbuilt.push('linux: the updater is scoped to it but no appimage/deb/rpm target is built');
    }
    expect(unbuilt, 'platform(s) the updater promises with nothing to install:').toEqual([]);
  });
});
