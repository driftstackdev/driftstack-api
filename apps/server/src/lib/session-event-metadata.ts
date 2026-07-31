import {
  CaptureKindSchema,
  SelectableArchetypeIdSchema,
  SessionPurposeSchema,
} from '@driftstack/api-types';
import { DriverError, DriverNotIntegratedError, SessionTimeoutError } from './errors.js';
import type { SessionEventInput } from '../services/sessions.js';

export const SESSION_EVENT_TYPES = [
  'created',
  'navigated',
  'interacted',
  'gui_input',
  'waited',
  'state_captured',
  'screenshot_captured',
  'destroyed',
  'errored',
] as const satisfies readonly SessionEventInput['type'][];
const sessionEventTypeCoverage: Exclude<
  SessionEventInput['type'],
  (typeof SESSION_EVENT_TYPES)[number]
> extends never
  ? true
  : never = true;
void sessionEventTypeCoverage;

export type SessionFailureClass =
  | 'session_timeout'
  | 'driver_error'
  | 'driver_unavailable'
  | 'unknown';

export type SessionDestroyReasonCode =
  | 'customer_request'
  | 'duration_limit'
  | 'account_suspended'
  | 'admin_forced'
  | 'unspecified';

export type ProjectedSessionEvent = Omit<SessionEventInput, 'sessionId'>;

export interface ClosedSessionFailedData extends Record<string, unknown> {
  session_id?: string;
  duration_ms?: number;
  operation: SessionOperation | 'unknown';
  error_name: 'SessionTimeoutError' | 'DriverError' | 'DriverNotIntegratedError' | 'UnknownError';
  error_message:
    | 'The session operation timed out.'
    | 'The browser operation failed.'
    | 'The browser driver was unavailable.'
    | 'The session operation failed.';
}

const SESSION_OPERATIONS = [
  'navigate',
  'interact',
  'gui_input',
  'wait',
  'state_capture',
  'capture',
  'extract',
  'search',
  'login',
] as const;
type SessionOperation = (typeof SESSION_OPERATIONS)[number];

const INTERACT_KINDS = ['tap', 'type', 'scroll', 'press'] as const;
const GUI_INPUT_KINDS = ['tap_at', 'type_focused'] as const;
const WAIT_KINDS = ['selector', 'selector_hidden', 'url_matches', 'time'] as const;
const FAILURE_CLASSES = [
  'session_timeout',
  'driver_error',
  'driver_unavailable',
  'unknown',
] as const satisfies readonly SessionFailureClass[];
const DESTROY_REASON_CODES = [
  'customer_request',
  'duration_limit',
  'account_suspended',
  'admin_forced',
  'unspecified',
] as const satisfies readonly SessionDestroyReasonCode[];

const MAX_DURATION_MS = 2_147_483_647;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_MINUTES = 31 * 24 * 60;

/**
 * Reduce a session event to a closed, non-secret metadata contract.
 *
 * The function is deliberately total for every known event type and idempotent
 * over its own output. Malformed known payloads collapse to safe null/unknown
 * fields; an unknown event type throws so archival stops before upload/delete.
 */
export function projectSessionEventMetadata<const T extends SessionEventInput['type']>(input: {
  type: T;
  payload: unknown;
  durationMs?: unknown;
}): ProjectedSessionEvent & { type: T };
export function projectSessionEventMetadata(input: {
  type: string;
  payload: unknown;
  durationMs?: unknown;
}): ProjectedSessionEvent;
export function projectSessionEventMetadata(input: {
  type: string;
  payload: unknown;
  durationMs?: unknown;
}): ProjectedSessionEvent {
  if (!isOneOf(input.type, SESSION_EVENT_TYPES)) {
    throw new Error('Unknown session event type.');
  }

  try {
    const payload = asRecord(input.payload);
    const durationMs = boundedInteger(input.durationMs, 0, MAX_DURATION_MS);
    switch (input.type) {
      case 'created': {
        const purpose = SessionPurposeSchema.safeParse(payload.purpose);
        return {
          type: input.type,
          payload: {
            archetype: selectableArchetype(payload.archetype),
            purpose: purpose.success ? purpose.data : null,
          },
          durationMs,
        };
      }
      case 'navigated':
        return {
          type: input.type,
          payload: {
            requested_origin: httpOrigin(payload.requested_origin ?? payload.url),
            final_origin: httpOrigin(payload.final_origin ?? payload.final_url),
            status: boundedInteger(payload.status, 100, 599),
          },
          durationMs,
        };
      case 'interacted': {
        const action = asRecord(payload.action ?? payload);
        const actionKind = oneOfOrUnknown(action.action_kind ?? action.kind, INTERACT_KINDS);
        return {
          type: input.type,
          payload: {
            action_kind: actionKind,
            ...(actionKind === 'type'
              ? {
                  sensitive: booleanOrNull(action.sensitive),
                  delay_ms: boundedInteger(action.delay_ms, 0, 500),
                }
              : {}),
            ...(actionKind === 'scroll'
              ? { targeted: booleanOrDerived(action.targeted, action.selector) }
              : {}),
          },
          durationMs,
        };
      }
      case 'gui_input': {
        const action = asRecord(payload.action ?? payload);
        const actionKind = oneOfOrUnknown(action.action_kind ?? action.kind, GUI_INPUT_KINDS);
        return {
          type: input.type,
          payload: {
            action_kind: actionKind,
            ...(actionKind === 'type_focused'
              ? { delay_ms: boundedInteger(action.delay_ms, 0, 500) }
              : {}),
          },
          durationMs,
        };
      }
      case 'waited': {
        const condition = asRecord(payload.condition ?? payload);
        const conditionKind = oneOfOrUnknown(
          condition.condition_kind ?? condition.kind,
          WAIT_KINDS,
        );
        return {
          type: input.type,
          payload: {
            condition_kind: conditionKind,
            satisfied: booleanOrNull(payload.satisfied ?? condition.satisfied),
            ...(conditionKind === 'time'
              ? { wait_ms: boundedInteger(condition.wait_ms ?? condition.ms, 0, 60_000) }
              : {}),
          },
          durationMs,
        };
      }
      case 'state_captured': {
        const captureKind = captureKindOrNull(payload.kind);
        if (payload.source === 'capture' || captureKind !== null) {
          return {
            type: input.type,
            payload: {
              source: 'capture',
              kind: captureKind,
              byte_size: boundedInteger(payload.byte_size, 0, MAX_CAPTURE_BYTES),
            },
            durationMs,
          };
        }
        return {
          type: input.type,
          payload: {
            source: 'page_state',
            origin: httpOrigin(payload.origin ?? payload.url),
          },
          durationMs,
        };
      }
      case 'screenshot_captured':
        return {
          type: input.type,
          payload: {
            kind: captureKindOrNull(payload.kind),
            byte_size: boundedInteger(payload.byte_size, 0, MAX_CAPTURE_BYTES),
          },
          durationMs,
        };
      case 'destroyed': {
        const reasonCode = destroyReasonCode(payload);
        return {
          type: input.type,
          payload: {
            reason_code: reasonCode,
            auto_destroyed: payload.auto_destroyed === true,
            by_admin: payload.by_admin === true || payload.force === true,
            max_session_minutes: boundedInteger(
              payload.max_session_minutes,
              1,
              MAX_SESSION_MINUTES,
            ),
          },
          durationMs,
        };
      }
      case 'errored': {
        const failureClass = failureClassFromPayload(payload);
        return {
          type: input.type,
          payload: {
            operation: sessionOperation(payload.operation),
            failure_class: failureClass,
          },
          durationMs,
        };
      }
    }
  } catch {
    return emptySessionEvent(input.type);
  }
}

export function classifySessionFailure(error: unknown): SessionFailureClass {
  try {
    if (error instanceof SessionTimeoutError) return 'session_timeout';
    if (error instanceof DriverNotIntegratedError) return 'driver_unavailable';
    if (error instanceof DriverError) return 'driver_error';
    const name = safeErrorName(error);
    if (name === 'SessionTimeoutError') return 'session_timeout';
    if (name === 'DriverNotIntegratedError') return 'driver_unavailable';
    if (name === 'DriverError') return 'driver_error';
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

export function sessionFailureCopy(
  failureClass: SessionFailureClass,
): Pick<ClosedSessionFailedData, 'error_name' | 'error_message'> {
  switch (failureClass) {
    case 'session_timeout':
      return {
        error_name: 'SessionTimeoutError',
        error_message: 'The session operation timed out.',
      };
    case 'driver_error':
      return { error_name: 'DriverError', error_message: 'The browser operation failed.' };
    case 'driver_unavailable':
      return {
        error_name: 'DriverNotIntegratedError',
        error_message: 'The browser driver was unavailable.',
      };
    case 'unknown':
      return { error_name: 'UnknownError', error_message: 'The session operation failed.' };
  }
}

/** Close arbitrary session.failed data before webhook persistence or archival. */
export function projectSessionFailedData(input: unknown): ClosedSessionFailedData {
  try {
    const data = asRecord(input);
    const sessionId = safeOpaqueId(data.session_id);
    const durationMs = boundedInteger(data.duration_ms, 0, MAX_DURATION_MS);
    const operation = sessionOperation(data.operation);
    const failureClass = failureClassFromPayload(data);
    return {
      ...(sessionId === null ? {} : { session_id: sessionId }),
      ...(durationMs === null ? {} : { duration_ms: durationMs }),
      operation,
      ...sessionFailureCopy(failureClass),
    };
  } catch {
    return {
      operation: 'unknown',
      ...sessionFailureCopy('unknown'),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function booleanOrDerived(value: unknown, selector: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return typeof selector === 'string' && selector.length > 0;
}

function httpOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function selectableArchetype(value: unknown): string | null {
  const parsed = SelectableArchetypeIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function captureKindOrNull(value: unknown): 'screenshot' | 'dom_snapshot' | 'pdf' | null {
  const parsed = CaptureKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function destroyReasonCode(payload: Record<string, unknown>): SessionDestroyReasonCode {
  if (isOneOf(payload.reason_code, DESTROY_REASON_CODES)) return payload.reason_code;
  if (payload.by_admin === true || payload.force === true) return 'admin_forced';
  if (payload.reason === 'auto-destroyed: free-tier session duration cap') return 'duration_limit';
  if (payload.reason === 'account suspended') return 'account_suspended';
  if (payload.auto_destroyed === true) return 'duration_limit';
  return 'unspecified';
}

function failureClassFromPayload(payload: Record<string, unknown>): SessionFailureClass {
  if (isOneOf(payload.failure_class, FAILURE_CLASSES)) return payload.failure_class;
  return classifySessionFailureName(payload.error_name);
}

function classifySessionFailureName(value: unknown): SessionFailureClass {
  if (value === 'SessionTimeoutError') return 'session_timeout';
  if (value === 'DriverNotIntegratedError') return 'driver_unavailable';
  if (value === 'DriverError') return 'driver_error';
  return 'unknown';
}

function safeErrorName(error: unknown): string | null {
  try {
    if (!(error instanceof Error)) return null;
    const name = error.name as unknown;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

function sessionOperation(value: unknown): SessionOperation | 'unknown' {
  return isOneOf(value, SESSION_OPERATIONS) ? value : 'unknown';
}

function oneOfOrUnknown<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] | 'unknown' {
  return isOneOf(value, values) ? value : 'unknown';
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function safeOpaqueId(value: unknown): string | null {
  return typeof value === 'string' &&
    /^ses_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
    ? value
    : null;
}

function emptySessionEvent(type: SessionEventInput['type']): ProjectedSessionEvent {
  switch (type) {
    case 'created':
      return { type, payload: { archetype: null, purpose: null }, durationMs: null };
    case 'navigated':
      return {
        type,
        payload: { requested_origin: null, final_origin: null, status: null },
        durationMs: null,
      };
    case 'interacted':
      return { type, payload: { action_kind: 'unknown' }, durationMs: null };
    case 'gui_input':
      return { type, payload: { action_kind: 'unknown' }, durationMs: null };
    case 'waited':
      return {
        type,
        payload: { condition_kind: 'unknown', satisfied: null },
        durationMs: null,
      };
    case 'state_captured':
      return { type, payload: { source: 'page_state', origin: null }, durationMs: null };
    case 'screenshot_captured':
      return { type, payload: { kind: null, byte_size: null }, durationMs: null };
    case 'destroyed':
      return {
        type,
        payload: {
          reason_code: 'unspecified',
          auto_destroyed: false,
          by_admin: false,
          max_session_minutes: null,
        },
        durationMs: null,
      };
    case 'errored':
      return {
        type,
        payload: { operation: 'unknown', failure_class: 'unknown' },
        durationMs: null,
      };
  }
}
