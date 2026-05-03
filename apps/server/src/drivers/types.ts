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

import type { CaptureKind, InteractAction, WaitCondition } from '@driftstack/api-types';
import type { GUIInputAction } from '../schemas/gui-input.js';

// ───────────────────────────────────────────────────────────────────────────
// Identity
// ───────────────────────────────────────────────────────────────────────────

export type DriverSessionId = string;

export interface CreateSessionInput {
  /** iPhone archetype slug, e.g. "iphone16pro_ios26_4_1". */
  archetype: string;
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
