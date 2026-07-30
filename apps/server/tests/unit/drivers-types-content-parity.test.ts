// W430.B — drift guard for apps/server/src/drivers/types.ts.
// Driver interface — the abstraction boundary between the API and
// the WebKit substrate. Drift here either widens the Driver
// interface (forces every implementation to grow) or changes the
// CreateSessionInput.purpose union (WebKit harness-config branch
// loses a case).
//
//   • Framing pinned: abstraction over WebKit substrate; mock.ts
//     in-memory deterministic; webkit.ts throws
//     DriverNotIntegratedError until Phase 2 + wiring.
//   • Pure-of-HTTP rationale: route layer parses Zod, services pass
//     through pre-validated; driver works with validated objects.
//   • CreateSessionInput.purpose union: production_customer (default
//     ephemeral+ATFP-on) | cumulative_rig_validation (persistent
//     ATFP-off) | test_domain_probe (ephemeral deterministic ATFP)
//     — V-169 harness purpose.
//   • Driver interface: 8 methods (createSession + navigate +
//     interact + guiInput L-001 + wait + getState + capture +
//     destroy).
//   • NavigateInput.waitUntil union: load|domcontentloaded|networkidle.
//   • CaptureResult.encoding union: base64|utf8.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DRIVER_LOGIN_DURATION_MAX_MS,
  DRIVER_SEARCH_DURATION_MAX_MS,
  DriverLoginResultSchema,
  DriverSearchResultSchema,
} from '../../src/drivers/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/drivers/types.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W430.B apps/server/src/drivers/types.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: Driver interface — abstraction over WebKit substrate; mock.ts in-memory deterministic; webkit.ts throws DriverNotIntegratedError until Phase 2 + wiring', () => {
    expect(body).toMatch(/\/\/ Driver interface — abstraction over the WebKit substrate\./);
    expect(body).toMatch(
      /\/\/ Two implementations:\s*\n?\s*\/\/\s*- mock\.ts\s+in-memory, deterministic; used in dev \+ tests\s*\n?\s*\/\/\s*- webkit\.ts\s+real fork; throws DriverNotIntegratedError until the\s*\n?\s*\/\/\s+Driftstack WebKit fork closes Phase 2 and we wire it up/,
    );
  });

  it('Pure-of-HTTP rationale: Zod-validated public types from api-types NOT used as driver input (route parses, service passes through pre-validated)', () => {
    expect(body).toMatch(
      /\/\/ The Zod-validated public types in @driftstack\/api-types are \*not\* used as\s*\n?\s*\/\/ the driver's input shape — the driver works with already-validated objects\s*\n?\s*\/\/ \(route layer parses, services pass through\)\. This avoids re-validation cost\s*\n?\s*\/\/ on every driver call and keeps the driver pure of HTTP concerns\./,
    );
  });

  it('imports: BehavioralProfile + CaptureKind + ExtractionSpec + InteractAction + WaitCondition (api-types) + GUIInputAction (schemas/gui-input)', () => {
    expect(body).toMatch(
      /import type \{\s*\n?\s*BehavioralProfile,\s*\n?\s*CaptureKind,\s*\n?\s*ExtractionSpec,\s*\n?\s*InteractAction,\s*\n?\s*PageState,\s*\n?\s*WaitCondition,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ GUIInputAction \} from '\.\.\/schemas\/gui-input\.js';/);
  });

  it('DriverSessionId = string + CreateSessionInput: archetype iPhone slug + purpose union (V-169) + optional metadata', () => {
    expect(body).toMatch(/export type DriverSessionId = string;/);
    expect(body).toMatch(
      /export interface CreateSessionInput \{\s*\n?\s*\/\*\* iPhone archetype slug, e\.g\. "iphone17_ios18_7_safari26_4"\. \*\/\s*\n?\s*archetype: string;/,
    );
    expect(body).toMatch(
      /\*\s*V-169 — harness purpose\. Drives WebKit driver's harness-config\s*\n?\s*\*\s*selection \(persistent vs ephemeral context, _resourceLoad\s*\n?\s*\*\s*StatisticsEnabled flag, ATFP firing\)/,
    );
    expect(body).toMatch(
      /\*\s*- `production_customer` \(default\): ephemeral \+ ATFP-on\.\s*\n?\s*\*\s*- `cumulative_rig_validation`: persistent, ATFP-off\.\s*\n?\s*\*\s*- `test_domain_probe`: ephemeral, deterministic ATFP firing\./,
    );
    expect(body).toMatch(
      /purpose: 'production_customer' \| 'cumulative_rig_validation' \| 'test_domain_probe';/,
    );
    expect(body).toMatch(/metadata\?: Record<string, unknown>;/);
  });

  it('CreateSessionResult: driverSessionId only', () => {
    expect(body).toMatch(
      /export interface CreateSessionResult \{\s*\n?\s*driverSessionId: DriverSessionId;\s*\n?\s*\}/,
    );
  });

  it('NavigateInput: url + timeoutMs + waitUntil union (load|domcontentloaded|networkidle); NavigateResult: url + finalUrl + status + durationMs', () => {
    expect(body).toMatch(
      /export interface NavigateInput \{\s*\n?\s*url: string;\s*\n?\s*timeoutMs: number;\s*\n?\s*waitUntil: 'load' \| 'domcontentloaded' \| 'networkidle';\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface NavigateResult \{\s*\n?\s*url: string;\s*\n?\s*finalUrl: string;\s*\n?\s*status: number;\s*\n?\s*durationMs: number;\s*\n?\s*\}/,
    );
  });

  it('InteractInput/Result + L-001 GUIInputInput/Result (coordinate primitives, separate from intent-only InteractInput)', () => {
    expect(body).toMatch(
      /export interface InteractInput \{\s*\n?\s*action: InteractAction;\s*\n?\s*timeoutMs: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface InteractResult \{\s*\n?\s*durationMs: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\/\/ GUI-control plane \(L-001\): coordinate primitives for the manual-\s*\n?\s*\/\/ control GUI, separate from intent-only InteractInput\./,
    );
    expect(body).toMatch(
      /export interface GUIInputInput \{\s*\n?\s*action: GUIInputAction;\s*\n?\s*timeoutMs: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface GUIInputResult \{\s*\n?\s*durationMs: number;\s*\n?\s*\}/,
    );
  });

  it('WaitInput: condition + timeoutMs; WaitResult: satisfied + durationMs', () => {
    expect(body).toMatch(
      /export interface WaitInput \{\s*\n?\s*condition: WaitCondition;\s*\n?\s*timeoutMs: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface WaitResult \{\s*\n?\s*satisfied: boolean;\s*\n?\s*durationMs: number;\s*\n?\s*\}/,
    );
  });

  it('SessionStateResult: url + title (both nullable) + cookies + localStorage + capturedAt; CaptureInput: kind + fullPage; CaptureResult: kind + data + encoding union (base64|utf8) + byteSize + durationMs', () => {
    expect(body).toMatch(
      /export interface SessionStateResult \{\s*\n?\s*url: string \| null;\s*\n?\s*title: string \| null;\s*\n?\s*cookies: Array<Record<string, unknown>>;\s*\n?\s*localStorage: Record<string, string>;[\s\S]{0,520}?pageState: PageState \| null;\s*\n?\s*capturedAt: Date;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface CaptureInput \{\s*\n?\s*kind: CaptureKind;\s*\n?\s*fullPage: boolean;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export interface CaptureResult \{\s*\n?\s*kind: CaptureKind;\s*\n?\s*data: string;\s*\n?\s*encoding: 'base64' \| 'utf8';\s*\n?\s*byteSize: number;\s*\n?\s*durationMs: number;\s*\n?\s*\}/,
    );
  });

  it('Driver interface: 11 methods (createSession + navigate + interact + guiInput L-001 + wait + getState + capture + extract + search + login + destroy)', () => {
    expect(body).toContain(
      "export type DriverOperationCapability = 'real' | 'simulation' | 'unavailable';",
    );
    expect(body).toMatch(
      /export interface Driver \{\s*\n?\s*readonly searchCapability: DriverOperationCapability;\s*\n?\s*readonly loginCapability: DriverOperationCapability;\s*\n?\s*createSession\(input: CreateSessionInput\): Promise<CreateSessionResult>;\s*\n?\s*navigate\(sessionId: DriverSessionId, input: NavigateInput\): Promise<NavigateResult>;\s*\n?\s*interact\(sessionId: DriverSessionId, input: InteractInput\): Promise<InteractResult>;\s*\n?\s*\/\*\* GUI-control plane \(L-001\) — coordinate-level input\. \*\/\s*\n?\s*guiInput\(sessionId: DriverSessionId, input: GUIInputInput\): Promise<GUIInputResult>;\s*\n?\s*wait\(sessionId: DriverSessionId, input: WaitInput\): Promise<WaitResult>;\s*\n?\s*getState\(sessionId: DriverSessionId\): Promise<SessionStateResult>;\s*\n?\s*capture\(sessionId: DriverSessionId, input: CaptureInput\): Promise<CaptureResult>;\s*\n?\s*extract\(sessionId: DriverSessionId, input: ExtractInput\): Promise<ExtractResult>;\s*\n?\s*search\(sessionId: DriverSessionId, input: SearchInput\): Promise<SearchResult>;\s*\n?\s*login\(sessionId: DriverSessionId, input: LoginInput\): Promise<LoginResult>;\s*\n?\s*destroy\(sessionId: DriverSessionId\): Promise<void>;\s*\n?\s*\}/,
    );
  });

  it('SearchResult preserves exact normal versus zero-submit query-truncation terminals', () => {
    expect(DRIVER_SEARCH_DURATION_MAX_MS).toBe(600_000);
    for (const valid of [
      { submitted: true, queryTruncated: false, resultsVisible: false, durationMs: 600_000 },
      { submitted: false, queryTruncated: false, durationMs: 1 },
      { submitted: false, queryTruncated: true, durationMs: 0 },
    ]) {
      expect(DriverSearchResultSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      { submitted: true, queryTruncated: true, durationMs: 1 },
      { submitted: false, queryTruncated: true, resultsVisible: false, durationMs: 1 },
      { submitted: false, queryTruncated: false, durationMs: -1 },
      { submitted: true, queryTruncated: false, durationMs: 600_001 },
      { submitted: true, queryTruncated: false, durationMs: 1, query: 'must-not-survive' },
    ]) {
      expect(DriverSearchResultSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('LoginResult preserves the exact submitted versus zero-submit truncation branch', () => {
    expect(body).toContain('export const DRIVER_LOGIN_DURATION_MAX_MS = 600_000;');
    expect(body).toContain("z.discriminatedUnion('submitted'");
    expect(DRIVER_LOGIN_DURATION_MAX_MS).toBe(600_000);
    for (const valid of [
      {
        submitted: true,
        credentialsTruncated: false,
        loggedIn: true,
        durationMs: 600_000,
      },
      {
        submitted: false,
        credentialsTruncated: true,
        loggedIn: false,
        durationMs: 0,
      },
    ]) {
      expect(DriverLoginResultSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      { submitted: true, credentialsTruncated: true, loggedIn: true, durationMs: 1 },
      { submitted: false, credentialsTruncated: true, loggedIn: true, durationMs: 1 },
      {
        submitted: false,
        credentialsTruncated: true,
        loggedIn: false,
        postLoginUrl: 'https://example.com',
        durationMs: 1,
      },
      { submitted: true, credentialsTruncated: false, loggedIn: true, durationMs: -1 },
      { submitted: true, credentialsTruncated: false, loggedIn: true, durationMs: 600_001 },
      {
        submitted: true,
        credentialsTruncated: false,
        loggedIn: true,
        durationMs: 1,
        password: 'must-never-survive',
      },
    ]) {
      expect(DriverLoginResultSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
