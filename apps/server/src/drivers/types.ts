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
  ExtractionSpec,
  InteractAction,
  PageState,
  WaitCondition,
} from '@driftstack/api-types';
import type { GUIInputAction } from '../schemas/gui-input.js';
import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// Identity
// ───────────────────────────────────────────────────────────────────────────

export type DriverSessionId = string;

/** Whether this driver can execute a customer-visible direct browser operation
 *  for real. Simulation is intentionally distinct from unavailable: both fail
 *  closed on the corresponding public search/login route, while tests/dev
 *  diagnostics can still identify why. A future authenticated FleetDriver is
 *  the first eligible `real` implementation. */
export type DriverOperationCapability = 'real' | 'simulation' | 'unavailable';

export interface CreateSessionInput {
  /** iPhone archetype slug, e.g. "iphone17_ios18_7_safari26_4". */
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
  /**
   * W615 — page lifecycle (loading/loaded/errored + error detail) as the
   * driver/harness sees it. null = the driver has nothing to report yet
   * (pre-navigation, or a driver that doesn't track lifecycle — the real
   * harness emit is the A3 side of the cross-agent contract).
   */
  pageState: PageState | null;
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

export interface ExtractInput {
  extractions: ExtractionSpec[];
}

export interface ExtractResult {
  /** Extracted values keyed by each extraction's `name` (heterogeneous:
   *  string | number | array, per the extraction type). The customer's own
   *  page data. */
  value: Record<string, unknown>;
  durationMs: number;
}

export interface SearchInput {
  query: string;
  searchSelector?: string;
  submit: boolean;
  waitForResultsSelector?: string;
  timeoutSeconds?: number;
}

export const DRIVER_SEARCH_DURATION_MAX_MS = 600_000;

const DriverSearchNormalResultSchema = z
  .object({
    submitted: z.boolean(),
    queryTruncated: z.literal(false),
    /** Present only when waitForResultsSelector was given (timeout → false). */
    resultsVisible: z.boolean().optional(),
    durationMs: z.number().int().min(0).max(DRIVER_SEARCH_DURATION_MAX_MS),
  })
  .strict();

const DriverSearchTruncatedResultSchema = z
  .object({
    submitted: z.literal(false),
    queryTruncated: z.literal(true),
    durationMs: z.number().int().min(0).max(DRIVER_SEARCH_DURATION_MAX_MS),
  })
  .strict();

/** A truncated query is a zero-submit refusal, never an ambiguous partial
 *  search. This is also the runtime trust boundary for future Fleet output. */
export const DriverSearchResultSchema = z.discriminatedUnion('queryTruncated', [
  DriverSearchNormalResultSchema,
  DriverSearchTruncatedResultSchema,
]);
export type SearchResult = z.infer<typeof DriverSearchResultSchema>;

export interface LoginInput {
  username: string;
  /** SENSITIVE — never logged. */
  password: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  successSelector?: string;
  timeoutSeconds?: number;
}

export const DRIVER_LOGIN_DURATION_MAX_MS = 600_000;
export const DRIVER_LOGIN_URL_MAX_LENGTH = 8192;

const DriverLoginSubmittedResultSchema = z
  .object({
    submitted: z.literal(true),
    credentialsTruncated: z.literal(false),
    loggedIn: z.boolean(),
    postLoginUrl: z.string().max(DRIVER_LOGIN_URL_MAX_LENGTH).optional(),
    durationMs: z.number().int().min(0).max(DRIVER_LOGIN_DURATION_MAX_MS),
  })
  .strict();

const DriverLoginTruncatedResultSchema = z
  .object({
    submitted: z.literal(false),
    credentialsTruncated: z.literal(true),
    loggedIn: z.literal(false),
    durationMs: z.number().int().min(0).max(DRIVER_LOGIN_DURATION_MAX_MS),
  })
  .strict();

/** Runtime trust boundary for the future authenticated FleetDriver. Driver
 *  implementations are process-local today, but their eventual result is
 *  decoded from a remote harness and must not rely on erased TypeScript types. */
export const DriverLoginResultSchema = z.discriminatedUnion('submitted', [
  DriverLoginSubmittedResultSchema,
  DriverLoginTruncatedResultSchema,
]);
export type LoginResult = z.infer<typeof DriverLoginResultSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Driver interface
// ───────────────────────────────────────────────────────────────────────────

export interface Driver {
  readonly searchCapability: DriverOperationCapability;
  readonly loginCapability: DriverOperationCapability;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  navigate(sessionId: DriverSessionId, input: NavigateInput): Promise<NavigateResult>;
  interact(sessionId: DriverSessionId, input: InteractInput): Promise<InteractResult>;
  /** GUI-control plane (L-001) — coordinate-level input. */
  guiInput(sessionId: DriverSessionId, input: GUIInputInput): Promise<GUIInputResult>;
  wait(sessionId: DriverSessionId, input: WaitInput): Promise<WaitResult>;
  getState(sessionId: DriverSessionId): Promise<SessionStateResult>;
  capture(sessionId: DriverSessionId, input: CaptureInput): Promise<CaptureResult>;
  extract(sessionId: DriverSessionId, input: ExtractInput): Promise<ExtractResult>;
  search(sessionId: DriverSessionId, input: SearchInput): Promise<SearchResult>;
  login(sessionId: DriverSessionId, input: LoginInput): Promise<LoginResult>;
  destroy(sessionId: DriverSessionId): Promise<void>;
}
