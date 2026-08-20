// W984 — drivers/types V-169 + L-001 cross-source invariant. Three-
// hundred-tenth in the drift-guard series. Pins the apps/server/src/
// drivers/types.ts driver-abstraction-interface primitive:
//
//   Driver-abstraction framing — 'Driver interface — abstraction over
//   the WebKit substrate. Three implementations: mock.ts in-memory,
//   deterministic; used in dev + tests + playwright.ts dev and E2E only,
//   imported lazily + webkit.ts real fork; throws
//   DriverNotIntegratedError until the Driftstack WebKit fork closes
//   Phase 2 and we wire it up'. V-1096 — the roster read as two here and
//   in the source comment, long after DRIVER accepted playwright.
//
//   Zod-not-at-driver-boundary framing — 'The Zod-validated public
//   types in @driftstack/api-types are *not* used as the driver's
//   input shape — the driver works with already-validated objects
//   (route layer parses, services pass through). This avoids re-
//   validation cost on every driver call and keeps the driver pure
//   of HTTP concerns'.
//
//   CreateSessionInput 3-field shape — archetype + V-169 purpose
//     (3-value union) + optional metadata.
//
//   V-169 purpose framing — 'V-169 — harness purpose. Drives WebKit
//   driver's harness-config selection (persistent vs ephemeral
//   context, _resourceLoadStatisticsEnabled flag, ATFP firing). See
//   docs/architecture/afp-harness-configuration.md (Agent 1 cross-
//   reference, Phase 3 work). production_customer (default):
//   ephemeral + ATFP-on. cumulative_rig_validation: persistent, ATFP-
//   off. test_domain_probe: ephemeral, deterministic ATFP firing'.
//
//   3-value purpose union: 'production_customer' |
//     'cumulative_rig_validation' | 'test_domain_probe'.
//
//   MockDriver-vs-WebKit framing — 'MockDriver accepts but doesn't
//   act on this; the WebKit driver is where the harness branching
//   lives'.
//
//   NavigateInput 3-field shape — url + timeoutMs + waitUntil (3-
//     value union: 'load' | 'domcontentloaded' | 'networkidle').
//
//   InteractInput 2-field shape — action: InteractAction + timeoutMs.
//
//   L-001 GUI-control-plane framing — 'GUI-control plane (L-001):
//   coordinate primitives for the manual-control GUI, separate from
//   intent-only InteractInput'.
//
//   GUIInputInput 2-field shape — action: GUIInputAction + timeoutMs.
//
//   Driver interface 8-method surface — createSession + navigate +
//     interact + guiInput (L-001) + wait + getState + capture +
//     destroy.
//
// stays in lockstep across apps/server/src/drivers/types.ts.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W984 drivers/types V-169 + L-001 cross-source invariant', () => {
  // ─── Driver-abstraction framing ──────────────────────────────

  it('CRITICAL apps/server/src/drivers/types.ts header pins the driver roster and the DriverNotIntegratedError-until-Phase-2 design, which is the V-156 driver-abstraction contract. V-1096: this pinned a two-implementation roster naming mock and webkit. The DRIVER enum had accepted playwright since V-333b and docs/architecture.md described all three, so the source comment was the last place still saying two — and two pins held it there.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/Driver interface — abstraction over the WebKit substrate\./);
    expect(p).toMatch(/Three implementations:/);
    expect(p).toMatch(/- playwright\.ts\s+V-333b; dev and E2E only, imported lazily so production/);
    expect(p, 'the two-implementation claim must not return').not.toMatch(/Two implementations:/);
    expect(p).toMatch(/- mock\.ts\s+in-memory, deterministic; used in dev \+ tests/);
    expect(p).toMatch(/- webkit\.ts\s+real fork; throws DriverNotIntegratedError until the/);
    expect(p).toMatch(/Driftstack WebKit fork closes Phase 2 and we wire it up/);
  });

  // ─── Zod-not-at-driver-boundary framing ──────────────────────

  it("CRITICAL Zod-boundary framing — 'The Zod-validated public types in @driftstack/api-types are *not* used as the driver's input shape — the driver works with already-validated objects (route layer parses, services pass through). This avoids re-validation cost on every driver call and keeps the driver pure of HTTP concerns'. The no-revalidation + driver-pure-of-HTTP design is the V-156 + V-204 layering contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(
      /The Zod-validated public types in @driftstack\/api-types are \*not\* used as/,
    );
    expect(p).toMatch(/the driver's input shape — the driver works with already-validated objects/);
    expect(p).toMatch(
      /\(route layer parses, services pass through\)\. This avoids re-validation cost/,
    );
    expect(p).toMatch(/on every driver call and keeps the driver pure of HTTP concerns\./);
  });

  // ─── CreateSessionInput shape ────────────────────────────────

  it('CRITICAL CreateSessionInput 4-field shape — archetype + V-169 purpose + optional behavioralProfile + optional metadata. The shape is what services-level pass to the driver (2026-06-05: behavioralProfile added — the per-session persona the harness drives the session with).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/export interface CreateSessionInput \{/);
    expect(p).toMatch(/archetype: string;/);
    expect(p).toMatch(
      /purpose: 'production_customer' \| 'cumulative_rig_validation' \| 'test_domain_probe';/,
    );
    expect(p).toMatch(/behavioralProfile\?: BehavioralProfile;/);
    expect(p).toMatch(/metadata\?: Record<string, unknown>;/);
  });

  it("CRITICAL archetype slug example — 'iPhone archetype slug, e.g. iphone17_ios18_7_safari26_4'. The 4-component slug shape (model_ios_safari_revision) is the archetype-identity contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/iPhone archetype slug, e\.g\. "iphone17_ios18_7_safari26_4"\./);
  });

  // ─── V-169 purpose framing ───────────────────────────────────

  it("CRITICAL V-169 purpose framing — 'V-169 — harness purpose. Drives WebKit driver's harness-config selection (persistent vs ephemeral context, _resourceLoadStatisticsEnabled flag, ATFP firing). See docs/architecture/afp-harness-configuration.md (Agent 1 cross-reference, Phase 3 work). production_customer (default): ephemeral + ATFP-on. cumulative_rig_validation: persistent, ATFP-off. test_domain_probe: ephemeral, deterministic ATFP firing. MockDriver accepts but doesn't act on this; the WebKit driver is where the harness branching lives'. The 3-purpose × 3-ATFP-config matrix is the V-169 harness-selection contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/V-169 — harness purpose\. Drives WebKit driver's harness-config/);
    expect(p).toMatch(/selection \(persistent vs ephemeral context, _resourceLoad/);
    expect(p).toMatch(/StatisticsEnabled flag, ATFP firing\)\. See/);
    expect(p).toMatch(/`docs\/architecture\/afp-harness-configuration\.md` \(Agent 1/);
    expect(p).toMatch(/cross-reference, Phase 3 work\)\./);
    expect(p).toMatch(/- `production_customer` \(default\): ephemeral \+ ATFP-on\./);
    expect(p).toMatch(/- `cumulative_rig_validation`: persistent, ATFP-off\./);
    expect(p).toMatch(/- `test_domain_probe`: ephemeral, deterministic ATFP firing\./);
    expect(p).toMatch(/MockDriver accepts but doesn't act on this; the WebKit driver/);
    expect(p).toMatch(/is where the harness branching lives\./);
  });

  // ─── NavigateInput 3-value waitUntil ─────────────────────────

  it("CRITICAL NavigateInput waitUntil = 'load' | 'domcontentloaded' | 'networkidle'. The 3-value union mirrors Playwright/WebKit's standard navigation-completion signals.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/export interface NavigateInput \{/);
    expect(p).toMatch(/url: string;/);
    expect(p).toMatch(/timeoutMs: number;/);
    expect(p).toMatch(/waitUntil: 'load' \| 'domcontentloaded' \| 'networkidle';/);
  });

  // ─── NavigateResult 4-field ──────────────────────────────────

  it('CRITICAL NavigateResult has 4 fields — url + finalUrl + status + durationMs. The url-vs-finalUrl split lets callers detect redirect chains.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/export interface NavigateResult \{/);
    expect(p).toMatch(/finalUrl: string;/);
    expect(p).toMatch(/status: number;/);
    expect(p).toMatch(/durationMs: number;/);
  });

  // ─── L-001 GUI-control plane framing ─────────────────────────

  it("CRITICAL L-001 GUI-control plane framing — 'GUI-control plane (L-001): coordinate primitives for the manual-control GUI, separate from intent-only InteractInput'. The GUI-coords-separate-from-intent design is the L-001 dual-pathway architecture.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/\/\/ GUI-control plane \(L-001\): coordinate primitives for the manual-/);
    expect(p).toMatch(/\/\/ control GUI, separate from intent-only InteractInput\./);
  });

  it('CRITICAL GUIInputInput shape — action: GUIInputAction + timeoutMs. The 2-field shape mirrors InteractInput so MockDriver + WebKit driver have a uniform operation envelope.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/export interface GUIInputInput \{/);
    expect(p).toMatch(/action: GUIInputAction;/);
    expect(p).toMatch(/timeoutMs: number;/);
  });

  // ─── SessionStateResult 5-field ──────────────────────────────

  it('CRITICAL SessionStateResult has 6 fields, and this arm pins 5 of them — url|null + title|null + cookies (array of opaque records) + localStorage (Record<string, string>) + capturedAt: Date. The 5-field shape is what V-666.I session-state-export captures.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/export interface SessionStateResult \{/);
    expect(p).toMatch(/url: string \| null;/);
    expect(p).toMatch(/title: string \| null;/);
    expect(p).toMatch(/cookies: Array<Record<string, unknown>>;/);
    expect(p).toMatch(/localStorage: Record<string, string>;/);
    expect(p).toMatch(/capturedAt: Date;/);
  });

  // ─── CaptureResult 5-field ───────────────────────────────────

  it("CRITICAL CaptureResult has 5 fields — kind: CaptureKind + data: string + encoding: 'base64'|'utf8' + byteSize + durationMs. The data+encoding pair lets callers handle both binary (png base64) and text (dom utf8) without separate methods.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/export interface CaptureResult \{/);
    expect(p).toMatch(/kind: CaptureKind;/);
    expect(p).toMatch(/data: string;/);
    expect(p).toMatch(/encoding: 'base64' \| 'utf8';/);
    expect(p).toMatch(/byteSize: number;/);
    expect(p).toMatch(/durationMs: number;/);
  });

  // ─── Driver 8-method surface ─────────────────────────────────

  it('CRITICAL Driver interface has 8 methods — createSession + navigate + interact + guiInput (L-001) + wait + getState + capture + destroy. The 8-method surface is the V-156 driver-abstraction contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/export interface Driver \{/);
    expect(p).toMatch(/createSession\(input: CreateSessionInput\): Promise<CreateSessionResult>;/);
    expect(p).toMatch(
      /navigate\(sessionId: DriverSessionId, input: NavigateInput\): Promise<NavigateResult>;/,
    );
    expect(p).toMatch(
      /interact\(sessionId: DriverSessionId, input: InteractInput\): Promise<InteractResult>;/,
    );
    expect(p).toMatch(
      /guiInput\(sessionId: DriverSessionId, input: GUIInputInput\): Promise<GUIInputResult>;/,
    );
    expect(p).toMatch(/wait\(sessionId: DriverSessionId, input: WaitInput\): Promise<WaitResult>;/);
    expect(p).toMatch(/getState\(sessionId: DriverSessionId\): Promise<SessionStateResult>;/);
    expect(p).toMatch(
      /capture\(sessionId: DriverSessionId, input: CaptureInput\): Promise<CaptureResult>;/,
    );
    expect(p).toMatch(/destroy\(sessionId: DriverSessionId\): Promise<void>;/);
  });

  it("CRITICAL guiInput method has /** GUI-control plane (L-001) — coordinate-level input. */ JSDoc. The L-001-anchored doc-comment makes the method's provenance scannable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/\/\*\* GUI-control plane \(L-001\) — coordinate-level input\. \*\//);
  });

  // ─── DriverSessionId type alias ──────────────────────────────

  it('CRITICAL DriverSessionId = string. The string-alias keeps the driver-session-id type-safe at the call site (cannot accidentally pass an account-id).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    expect(p).toMatch(/export type DriverSessionId = string;/);
  });

  it('CRITICAL V-1096 the driver roster is the same in the directory, the DRIVER enum, and both places that describe it. Correcting the prose to say three fixes today and not the next one: a fourth driver lands as a new file and an enum member, and every hand-written roster stays a member behind while the code runs fine. The three sources are compared to each other so the omission is what fails, not the count.', () => {
    const dir = resolve(REPO_ROOT, 'apps/server/src/drivers');
    const onDisk = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts' && f !== 'types.ts')
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
    expect(onDisk.length, 'driver implementation files found').toBeGreaterThanOrEqual(3);

    const config = read(resolve(REPO_ROOT, 'apps/server/src/lib/config.ts'));
    const enumM = /driver: z\.enum\(\[([^\]]*)\]\)/.exec(config);
    expect(enumM, 'the DRIVER enum is no longer declared as driver: z.enum([...])').not.toBeNull();
    const inEnum = [...(enumM?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]!).sort();

    expect(
      inEnum,
      'DRIVER accepts a different set of drivers than the directory implements — one of them is ' +
        'either unreachable or unimplemented:',
    ).toEqual(onDisk);

    // …and every implementation is named in both descriptions of the set.
    const types = read(resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts'));
    const arch = read(resolve(REPO_ROOT, 'docs/architecture.md'));
    const unnamed: string[] = [];
    for (const d of onDisk) {
      if (!types.includes(`- ${d}.ts`)) unnamed.push(`drivers/types.ts does not list ${d}.ts`);
      if (!new RegExp(`\`${d}\``).test(arch))
        unnamed.push(`docs/architecture.md does not name ${d}`);
    }
    expect(
      unnamed.sort(),
      'a driver is implemented and selectable but missing from a roster that reads as complete:',
    ).toEqual([]);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/drivers-types-v169-l001-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
