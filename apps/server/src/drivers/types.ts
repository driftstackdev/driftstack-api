// Driver interface — abstraction over the WebKit substrate.
//
// Two implementations:
//   - mock.ts        in-memory, deterministic; used in dev + tests
//   - webkit.ts      real fork; throws DriverNotIntegratedError until the
//                    Driftstack WebKit fork closes Phase 2 and we wire it up
//
// The Zod-validated public types in @driftstack/api-types are *not* used as
// the driver's input shape — the driver works with already-validated objects
// (route layer parses, services pass through). This avoids re-validation cost
// on every driver call and keeps the driver pure of HTTP concerns.

import type {
  BehavioralProfile,
  CaptureKind,
  InteractAction,
  WaitCondition,
} from '@driftstack/api-types';
import type { GUIInputAction } from '../schemas/gui-input.js';

// ───────────────────────────────────────────────────────────────────────────
// Identity
// ───────────────────────────────────────────────────────────────────────────

export type DriverSessionId = string;

export interface CreateSessionInput {
  /** iPhone archetype slug, e.g. "iphone16pro_ios18_7_safari26_4". */
  archetype: string;
  /**
   * V-169 — harness purpose. Drives WebKit driver's harness-config
   * selection (persistent vs ephemeral context, _resourceLoad
   * StatisticsEnabled flag, ATFP firing). See
   * `docs/architecture/afp-harness-configuration.md` (Agent 1
   * cross-reference, Phase 3 work).
   *   - `production_customer` (default): ephemeral + ATFP-on.
   *   - `cumulative_rig_validation`: persistent, ATFP-off.
   *   - `test_domain_probe`: ephemeral, deterministic ATFP firing.
   * MockDriver accepts but doesn't act on this; the WebKit driver
   * is where the harness branching lives.
   */
  purpose: 'production_customer' | 'cumulative_rig_validation' | 'test_domain_probe';
  /**
   * 2026-06-05 — behavioural persona for the session (file 05 §"Persona
   * model"). The WebKit harness drives touch/scroll/typing with this
   * persona's profile from @driftstack/behavioural-simulation (the single
   * source of truth for the model). MockDriver accepts but doesn't act on it
   * (captured for test inspection); omitted → service applies the default.
   */
  behavioralProfile?: BehavioralProfile;
  /** Free-form metadata supplied by the customer. Driver may ignore. */
  metadata?: Record<string, unknown>;
}

export interface CreateSessionResult {
  driverSessionId: DriverSessionId;
}

// ───────────────────────────────────────────────────────────────────────────
// Operations
// ───────────────────────────────────────────────────────────────────────────

export interface NavigateInput {
  url: string;
  timeoutMs: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface NavigateResult {
  url: string;
  finalUrl: string;
  status: number;
  durationMs: number;
}

export interface InteractInput {
  action: InteractAction;
  timeoutMs: number;
}

export interface InteractResult {
  durationMs: number;
}

// GUI-control plane (L-001): coordinate primitives for the manual-
// control GUI, separate from intent-only InteractInput.
export interface GUIInputInput {
  action: GUIInputAction;
  timeoutMs: number;
}

export interface GUIInputResult {
  durationMs: number;
}

export interface WaitInput {
  condition: WaitCondition;
  timeoutMs: number;
}

export interface WaitResult {
  satisfied: boolean;
  durationMs: number;
}

export interface SessionStateResult {
  url: string | null;
  title: string | null;
  cookies: Array<Record<string, unknown>>;
  localStorage: Record<string, string>;
  capturedAt: Date;
}

export interface CaptureInput {
  kind: CaptureKind;
  fullPage: boolean;
}

export interface CaptureResult {
  kind: CaptureKind;
  data: string;
  encoding: 'base64' | 'utf8';
  byteSize: number;
  durationMs: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Driver interface
// ───────────────────────────────────────────────────────────────────────────

export interface Driver {
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  navigate(sessionId: DriverSessionId, input: NavigateInput): Promise<NavigateResult>;
  interact(sessionId: DriverSessionId, input: InteractInput): Promise<InteractResult>;
  /** GUI-control plane (L-001) — coordinate-level input. */
  guiInput(sessionId: DriverSessionId, input: GUIInputInput): Promise<GUIInputResult>;
  wait(sessionId: DriverSessionId, input: WaitInput): Promise<WaitResult>;
  getState(sessionId: DriverSessionId): Promise<SessionStateResult>;
  capture(sessionId: DriverSessionId, input: CaptureInput): Promise<CaptureResult>;
  destroy(sessionId: DriverSessionId): Promise<void>;
}
