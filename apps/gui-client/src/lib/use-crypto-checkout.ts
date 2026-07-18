// V-534.J — useCryptoCheckout hook.
//
// Mints a CryptoOrder via POST /v1/billing/crypto-checkout (V-666.C).
// Single-shot state machine — idle → loading → (ready | error |
// outcome_unknown). The
// component using the hook decides what to do with the returned
// payment context, including a non-payable fallback when the provider
// has not returned complete crypto instructions.
//
// No SDK method yet — fetches the endpoint directly using the
// baseUrl + apiKey from SettingsContext, mirroring useAccountCost
// (V-534.H).
//
// V-534.AY — auto-sends an Idempotency-Key (V-666.AO). A dispatched
// request captures its exact key, body, endpoint, and credential. If
// delivery succeeds but the response is lost or cannot be trusted,
// retry() replays that exact request rather than minting a second
// order. reset() is deliberately unavailable while the outcome is
// unknown; after an authoritative result it rotates the key for a
// genuinely fresh checkout.
// V-534.AZ — exposes `replayed: boolean` on the ready state, sourced
// from the `Idempotent-Replayed` response header. Views can show a
// subtle "restored from your earlier attempt" notice when true.

import { useCallback, useEffect, useRef, useState } from 'react';
import { readApiErrorMessage } from './api-errors';
import { fetchWithDeadline } from './fetch-with-deadline';
import { readBoundedApiJson } from './read-bounded-json';
import { useSettings } from './SettingsContext';

const OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether this checkout was created. Retry the same checkout to restore its result safely.";
const REPLAY_WINDOW_EXPIRED_MESSAGE =
  "This checkout still can't be confirmed, and its safe replay window has expired. Review Orders or contact billing@driftstack.dev before trying another checkout.";
const CRYPTO_CHECKOUT_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_RECOVERABLE_CHECKOUTS = 8;
const MIN_CRYPTO_PAYMENT_AMOUNT = 1e-18;
const MAX_PAYMENT_ADDRESS_LENGTH = 512;
const MAX_PAY_CURRENCY_LENGTH = 32;

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (older test
  // shims). Not cryptographic strength, just a unique-enough token.
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface CryptoCheckoutResponse {
  order_id: string;
  product: string;
  price_cents: number;
  price_currency: string;
  status: 'pending' | 'confirming' | 'paid' | 'failed' | 'partial' | 'cancelled';
  provider: 'stub' | 'nowpayments';
  payment_address: string | null;
  pay_currency: string | null;
  pay_amount: number | null;
  created_at: string;
}

export interface UseCryptoCheckoutArgs {
  product: string;
  price_cents: number;
  price_currency: string;
}

type CryptoCheckoutAttemptResolution =
  | { kind: 'in_flight' }
  | { kind: 'outcome_unknown' }
  | { kind: 'ready'; order: CryptoCheckoutResponse; replayed: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'expired' };

interface CryptoCheckoutAttempt {
  accountId: string;
  args: Readonly<UseCryptoCheckoutArgs>;
  ambiguous: boolean;
  apiKey: string | null;
  baseUrl: string;
  body: string;
  dispatchOwner: symbol | null;
  expiryTimer: ReturnType<typeof globalThis.setTimeout> | null;
  inFlight: boolean;
  inFlightPromise: Promise<void> | null;
  idempotencyKey: string;
  replayUntilMs: number;
  retryPromise: Promise<void> | null;
  resolution: CryptoCheckoutAttemptResolution;
  scopeKey: string;
}

// Navigation between Billing tabs and App views unmounts this hook. Keep one
// bounded, process-memory-only recovery owner per account/deployment so that an
// uncertain K1 cannot disappear and silently become a fresh K2 on remount.
// Never persist this registry: it temporarily contains the exact API credential
// needed to replay against the original account, and drops that credential at
// success or before the public 24-hour idempotency guarantee can expire.
const recoverableCheckouts = new Map<string, CryptoCheckoutAttempt>();
type CryptoCheckoutAttemptListener = (attempt: CryptoCheckoutAttempt) => void;
const recoverableCheckoutListeners = new Map<string, Set<CryptoCheckoutAttemptListener>>();

function checkoutScopeKey(baseUrl: string, accountId: string): string {
  return `${baseUrl}\u0000${accountId}`;
}

function stateFromAttempt(attempt: CryptoCheckoutAttempt): CryptoCheckoutState {
  if (attempt.resolution.kind === 'ready') {
    return {
      kind: 'ready',
      order: attempt.resolution.order,
      replayed: attempt.resolution.replayed,
    };
  }
  if (attempt.resolution.kind === 'in_flight') return { kind: 'loading' };
  if (attempt.resolution.kind === 'error') {
    return { kind: 'error', message: attempt.resolution.message };
  }
  return {
    kind: 'outcome_unknown',
    retryable: attempt.resolution.kind !== 'expired',
    message:
      attempt.resolution.kind === 'expired'
        ? REPLAY_WINDOW_EXPIRED_MESSAGE
        : OUTCOME_UNKNOWN_MESSAGE,
  };
}

function publishRecoverableAttempt(attempt: CryptoCheckoutAttempt): void {
  for (const listener of recoverableCheckoutListeners.get(attempt.scopeKey) ?? []) {
    listener(attempt);
  }
}

function subscribeToRecoverableAttempt(
  scopeKey: string,
  listener: CryptoCheckoutAttemptListener,
): () => void {
  const listeners = recoverableCheckoutListeners.get(scopeKey) ?? new Set();
  listeners.add(listener);
  recoverableCheckoutListeners.set(scopeKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) recoverableCheckoutListeners.delete(scopeKey);
  };
}

function clearAttemptExpiryTimer(attempt: CryptoCheckoutAttempt): void {
  if (attempt.expiryTimer === null) return;
  globalThis.clearTimeout(attempt.expiryTimer);
  attempt.expiryTimer = null;
}

function removeRecoverableAttempt(attempt: CryptoCheckoutAttempt): void {
  if (recoverableCheckouts.get(attempt.scopeKey) === attempt) {
    recoverableCheckouts.delete(attempt.scopeKey);
  }
  clearAttemptExpiryTimer(attempt);
  attempt.apiKey = null;
}

function evictOldestReadyAttempt(): boolean {
  for (const attempt of recoverableCheckouts.values()) {
    if (attempt.resolution.kind !== 'ready') continue;
    removeRecoverableAttempt(attempt);
    return true;
  }
  return false;
}

function expireRecoverableAttempt(attempt: CryptoCheckoutAttempt): void {
  clearAttemptExpiryTimer(attempt);
  attempt.apiKey = null;
  attempt.resolution = { kind: 'expired' };
  publishRecoverableAttempt(attempt);
}

// `dispatch()` deliberately permits the module-owned expiry timer to replace
// the resolution while the async request is suspended. Keep that external
// mutation visible to TypeScript instead of letting its local control-flow
// analysis incorrectly freeze the discriminant at `in_flight`.
function isAttemptExpired(attempt: CryptoCheckoutAttempt): boolean {
  return attempt.resolution.kind === 'expired';
}

function armAttemptExpiryTimer(attempt: CryptoCheckoutAttempt): void {
  clearAttemptExpiryTimer(attempt);
  attempt.expiryTimer = globalThis.setTimeout(
    () => {
      if (attempt.resolution.kind === 'ready' || attempt.resolution.kind === 'error') return;
      expireRecoverableAttempt(attempt);
    },
    Math.max(0, attempt.replayUntilMs - Date.now()),
  );
}

/** Test isolation for the module-owned volatile registry; never persists data. */
export function resetCryptoCheckoutRecoveryForTesting(): void {
  for (const attempt of recoverableCheckouts.values()) {
    clearAttemptExpiryTimer(attempt);
    attempt.apiKey = null;
  }
  recoverableCheckouts.clear();
}

export type CryptoCheckoutState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; order: CryptoCheckoutResponse; replayed: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'outcome_unknown'; message: string; retryable: boolean };

export interface UseCryptoCheckoutResult {
  state: CryptoCheckoutState;
  /** Non-secret immutable request context while an attempt is locked/recoverable. */
  lockedArgs: Readonly<UseCryptoCheckoutArgs> | null;
  start: (args: UseCryptoCheckoutArgs) => Promise<void>;
  retry: () => Promise<void>;
  reset: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function hasValidPaymentContext(value: Record<string, unknown>): boolean {
  if (value.provider === 'stub') {
    return (
      value.payment_address === null && value.pay_currency === null && value.pay_amount === null
    );
  }
  return (
    value.provider === 'nowpayments' &&
    (value.payment_address === null ||
      (typeof value.payment_address === 'string' &&
        value.payment_address === value.payment_address.trim() &&
        value.payment_address.length > 0 &&
        value.payment_address.length <= MAX_PAYMENT_ADDRESS_LENGTH &&
        /^[\x21-\x7e]+$/.test(value.payment_address))) &&
    (value.pay_currency === null ||
      (typeof value.pay_currency === 'string' &&
        value.pay_currency === value.pay_currency.trim() &&
        value.pay_currency.length > 0 &&
        value.pay_currency.length <= MAX_PAY_CURRENCY_LENGTH &&
        /^[A-Za-z0-9._-]+$/.test(value.pay_currency))) &&
    (value.pay_amount === null ||
      (typeof value.pay_amount === 'number' &&
        Number.isFinite(value.pay_amount) &&
        value.pay_amount >= MIN_CRYPTO_PAYMENT_AMOUNT))
  );
}

function isCryptoOrderStatus(value: unknown): value is CryptoCheckoutResponse['status'] {
  return (
    value === 'pending' ||
    value === 'confirming' ||
    value === 'paid' ||
    value === 'failed' ||
    value === 'partial' ||
    value === 'cancelled'
  );
}

/**
 * A 2xx response is authoritative only when its customer-visible order envelope
 * is structurally valid and still describes the exact request we dispatched.
 * Treating malformed success as a normal error would let reset() rotate the key
 * even though the server may already have committed the order.
 */
function decodeCryptoCheckoutResponse(
  value: unknown,
  expected: Readonly<UseCryptoCheckoutArgs>,
): CryptoCheckoutResponse {
  if (
    !isRecord(value) ||
    typeof value.order_id !== 'string' ||
    !/^ord_[0-9a-f]{12}$/.test(value.order_id) ||
    value.product !== expected.product ||
    typeof value.price_cents !== 'number' ||
    !Number.isSafeInteger(value.price_cents) ||
    value.price_cents <= 0 ||
    typeof value.price_currency !== 'string' ||
    !/^[A-Z]{3}$/.test(value.price_currency) ||
    !isCryptoOrderStatus(value.status) ||
    (value.provider !== 'stub' && value.provider !== 'nowpayments') ||
    !isNullableString(value.payment_address) ||
    !isNullableString(value.pay_currency) ||
    !isNullableFiniteNumber(value.pay_amount) ||
    !hasValidPaymentContext(value) ||
    typeof value.created_at !== 'string' ||
    value.created_at.length > 32 ||
    Number.isNaN(Date.parse(value.created_at)) ||
    new Date(value.created_at).toISOString() !== value.created_at
  ) {
    throw new TypeError('Invalid crypto checkout response.');
  }
  return {
    order_id: value.order_id,
    product: value.product,
    price_cents: value.price_cents,
    price_currency: value.price_currency,
    status: value.status,
    provider: value.provider,
    payment_address: value.payment_address,
    pay_currency: value.pay_currency,
    pay_amount: value.pay_amount,
    created_at: value.created_at,
  };
}

function isDefinitiveInitialRejectionStatus(status: number): boolean {
  return status >= 400 && status <= 499 && status !== 408 && status !== 429;
}

export function useCryptoCheckout(): UseCryptoCheckoutResult {
  const { settings, accountMe } = useSettings();
  const normalizedBaseUrl = settings.baseUrl.replace(/\/+$/, '');
  const currentScopeKey =
    accountMe === null ? null : checkoutScopeKey(normalizedBaseUrl, accountMe.id);
  const initialAttemptRef = useRef<CryptoCheckoutAttempt | null>(
    currentScopeKey === null ? null : (recoverableCheckouts.get(currentScopeKey) ?? null),
  );
  const [state, setState] = useState<CryptoCheckoutState>(() =>
    initialAttemptRef.current === null
      ? { kind: 'idle' }
      : stateFromAttempt(initialAttemptRef.current),
  );
  const idempotencyKeyRef = useRef<string>(
    initialAttemptRef.current?.idempotencyKey ?? newIdempotencyKey(),
  );
  const attemptRef = initialAttemptRef;
  const requestRef = useRef<{
    attempt: CryptoCheckoutAttempt;
    controller: AbortController;
    owner: symbol;
  } | null>(null);
  const inFlightRef = useRef(false);
  const stateKindRef = useRef<CryptoCheckoutState['kind']>(state.kind);
  const sequenceRef = useRef(0);
  const scopeRef = useRef<string | null>(currentScopeKey);

  const commitState = useCallback((next: CryptoCheckoutState): void => {
    stateKindRef.current = next.kind;
    setState(next);
  }, []);

  const dispatch = useCallback(
    async (attempt: CryptoCheckoutAttempt): Promise<void> => {
      if (inFlightRef.current || attempt.inFlight || attempt.apiKey === null) return;
      if (Date.now() >= attempt.replayUntilMs) {
        expireRecoverableAttempt(attempt);
        if (attemptRef.current === attempt) commitState(stateFromAttempt(attempt));
        return;
      }
      inFlightRef.current = true;
      attempt.inFlight = true;
      attempt.resolution = { kind: 'in_flight' };
      const owner = Symbol('crypto-checkout-dispatch');
      attempt.dispatchOwner = owner;
      let finishInFlight!: () => void;
      attempt.inFlightPromise = new Promise<void>((resolve) => {
        finishInFlight = resolve;
      });
      const sequence = ++sequenceRef.current;
      const controller = new AbortController();
      requestRef.current = { attempt, controller, owner };
      publishRecoverableAttempt(attempt);
      commitState({ kind: 'loading' });
      try {
        const res = await fetchWithDeadline(`${attempt.baseUrl}/v1/billing/crypto-checkout`, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${attempt.apiKey}`,
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': attempt.idempotencyKey,
          },
          body: attempt.body,
        });
        if (!res.ok) {
          // Response headers settle whether this *dispatch* is a definitive
          // initial rejection. A later unmount can abort the diagnostic body,
          // but must not reinterpret an already-received ordinary 4xx as an
          // outcome-unknown write.
          const definitiveInitialRejection =
            !attempt.ambiguous && isDefinitiveInitialRejectionStatus(res.status);
          const message = await readApiErrorMessage(res);
          if (definitiveInitialRejection) {
            attempt.resolution = { kind: 'error', message };
            publishRecoverableAttempt(attempt);
            removeRecoverableAttempt(attempt);
            if (attemptRef.current === attempt) attemptRef.current = null;
            if (sequence === sequenceRef.current) commitState({ kind: 'error', message });
            return;
          }
          if (isAttemptExpired(attempt)) {
            publishRecoverableAttempt(attempt);
            return;
          }
          attempt.ambiguous = true;
          attempt.resolution = { kind: 'outcome_unknown' };
          publishRecoverableAttempt(attempt);
          if (sequence === sequenceRef.current && attemptRef.current === attempt) {
            commitState(stateFromAttempt(attempt));
          }
          return;
        }
        const rawOrder = await readBoundedApiJson<unknown>(res);
        const order = decodeCryptoCheckoutResponse(rawOrder, attempt.args);
        const replayed = res.headers.get('idempotent-replayed') === '1';
        clearAttemptExpiryTimer(attempt);
        attempt.apiKey = null;
        attempt.resolution = { kind: 'ready', order, replayed };
        publishRecoverableAttempt(attempt);
        if (sequence === sequenceRef.current && attemptRef.current === attempt) {
          commitState({ kind: 'ready', order, replayed });
        }
      } catch {
        if (isAttemptExpired(attempt)) {
          publishRecoverableAttempt(attempt);
          return;
        }
        attempt.ambiguous = true;
        attempt.resolution = { kind: 'outcome_unknown' };
        publishRecoverableAttempt(attempt);
        if (sequence === sequenceRef.current && attemptRef.current === attempt) {
          commitState(stateFromAttempt(attempt));
        }
      } finally {
        if (attempt.dispatchOwner === owner) {
          attempt.inFlight = false;
          attempt.dispatchOwner = null;
          attempt.inFlightPromise = null;
          finishInFlight();
          publishRecoverableAttempt(attempt);
        }
        if (requestRef.current?.owner === owner) {
          requestRef.current = null;
          inFlightRef.current = false;
        }
      }
    },
    [commitState],
  );

  const start = useCallback(
    async (args: UseCryptoCheckoutArgs): Promise<void> => {
      // A fresh attempt is legal only from idle. Authoritative errors and
      // completed orders must be explicitly reset; ambiguous work can only be
      // retried through retry(), which has no arguments to accidentally change.
      if (inFlightRef.current || stateKindRef.current !== 'idle') return;
      if (!settings.apiKey) {
        attemptRef.current = null;
        commitState({ kind: 'error', message: 'No API key configured.' });
        return;
      }
      if (accountMe === null || currentScopeKey === null) {
        attemptRef.current = null;
        commitState({
          kind: 'error',
          message: 'Account details are still loading. Wait a moment and try again.',
        });
        return;
      }
      const existing = recoverableCheckouts.get(currentScopeKey);
      if (existing !== undefined) {
        attemptRef.current = existing;
        idempotencyKeyRef.current = existing.idempotencyKey;
        commitState(stateFromAttempt(existing));
        return;
      }
      if (recoverableCheckouts.size >= MAX_RECOVERABLE_CHECKOUTS && !evictOldestReadyAttempt()) {
        commitState({
          kind: 'error',
          message:
            'Too many checkouts are awaiting confirmation. Resolve an existing checkout before starting another.',
        });
        return;
      }
      const requestArgs = Object.freeze({ ...args });
      const attempt: CryptoCheckoutAttempt = {
        accountId: accountMe.id,
        args: requestArgs,
        ambiguous: false,
        apiKey: settings.apiKey,
        baseUrl: normalizedBaseUrl,
        body: JSON.stringify(requestArgs),
        dispatchOwner: null,
        expiryTimer: null,
        inFlight: false,
        inFlightPromise: null,
        idempotencyKey: idempotencyKeyRef.current,
        replayUntilMs: Date.now() + CRYPTO_CHECKOUT_REPLAY_WINDOW_MS,
        retryPromise: null,
        resolution: { kind: 'in_flight' },
        scopeKey: currentScopeKey,
      };
      // Reserve before any await/POST so a concurrent mount in the same scope
      // adopts K1 instead of creating K2.
      recoverableCheckouts.set(currentScopeKey, attempt);
      armAttemptExpiryTimer(attempt);
      attemptRef.current = attempt;
      publishRecoverableAttempt(attempt);
      await dispatch(attempt);
    },
    [accountMe, commitState, currentScopeKey, dispatch, normalizedBaseUrl, settings.apiKey],
  );

  const retry = useCallback(async (): Promise<void> => {
    const attempt = attemptRef.current;
    if (attempt === null || attempt.scopeKey !== currentScopeKey) return;
    if (attempt.retryPromise !== null) {
      await attempt.retryPromise;
      if (attemptRef.current === attempt) commitState(stateFromAttempt(attempt));
      return;
    }
    if (stateKindRef.current !== 'outcome_unknown') return;
    const retryPromise = (async (): Promise<void> => {
      const originalOwner = attempt.inFlightPromise;
      if (originalOwner !== null) await originalOwner;
      if (attempt.resolution.kind !== 'outcome_unknown') return;
      if (Date.now() >= attempt.replayUntilMs || attempt.apiKey === null) {
        expireRecoverableAttempt(attempt);
        return;
      }
      await dispatch(attempt);
    })();
    // Publish the whole wait-for-owner + one-replay transaction synchronously.
    // Every mounted observer joins this exact promise instead of arming a
    // successor replay after the first observer's failed replay settles.
    attempt.retryPromise = retryPromise;
    try {
      await retryPromise;
    } finally {
      if (attempt.retryPromise === retryPromise) attempt.retryPromise = null;
      if (attemptRef.current === attempt) commitState(stateFromAttempt(attempt));
    }
  }, [commitState, currentScopeKey, dispatch]);

  const reset = useCallback(() => {
    if (stateKindRef.current === 'loading' || stateKindRef.current === 'outcome_unknown') return;
    const attempt = attemptRef.current;
    if (attempt !== null && attempt.scopeKey !== currentScopeKey) return;
    sequenceRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current = null;
    inFlightRef.current = false;
    if (attempt !== null) removeRecoverableAttempt(attempt);
    attemptRef.current = null;
    idempotencyKeyRef.current = newIdempotencyKey();
    commitState({ kind: 'idle' });
  }, [commitState, currentScopeKey]);

  // Keep every mounted observer reconciled with the single process-owned
  // attempt. This closes the late-owner response race where a remounted view
  // could otherwise remain unknown after the original request became ready.
  useEffect(() => {
    if (currentScopeKey === null) return undefined;
    const reconcile = (attempt: CryptoCheckoutAttempt): void => {
      if (scopeRef.current !== currentScopeKey) return;
      if (attemptRef.current !== null && attemptRef.current !== attempt) return;
      attemptRef.current = attempt;
      idempotencyKeyRef.current = attempt.idempotencyKey;
      commitState(stateFromAttempt(attempt));
    };
    const unsubscribe = subscribeToRecoverableAttempt(currentScopeKey, reconcile);
    const snapshot = recoverableCheckouts.get(currentScopeKey) ?? attemptRef.current;
    if (snapshot?.scopeKey === currentScopeKey) reconcile(snapshot);
    return unsubscribe;
  }, [commitState, currentScopeKey]);

  // Adopt an unresolved/ready checkout when AccountSelfProfile finishes loading
  // or the customer returns to an earlier account/deployment. A scope switch
  // revokes local callbacks and aborts only this mount's request; the old scope's
  // recovery owner remains in the bounded registry.
  useEffect(() => {
    if (scopeRef.current !== currentScopeKey) {
      const previous = attemptRef.current;
      const activeRequest = requestRef.current;
      if (
        previous?.resolution.kind === 'in_flight' &&
        activeRequest?.attempt === previous &&
        previous.dispatchOwner === activeRequest.owner
      ) {
        previous.ambiguous = true;
        previous.resolution = { kind: 'outcome_unknown' };
        publishRecoverableAttempt(previous);
      }
      sequenceRef.current += 1;
      requestRef.current?.controller.abort();
      requestRef.current = null;
      inFlightRef.current = false;
      attemptRef.current = null;
      scopeRef.current = currentScopeKey;
      idempotencyKeyRef.current = newIdempotencyKey();
      commitState({ kind: 'idle' });
    }
    if (currentScopeKey === null || attemptRef.current !== null) return;
    const recovered = recoverableCheckouts.get(currentScopeKey);
    if (recovered === undefined) return;
    attemptRef.current = recovered;
    idempotencyKeyRef.current = recovered.idempotencyKey;
    commitState(stateFromAttempt(recovered));
  }, [commitState, currentScopeKey]);

  useEffect(
    () => () => {
      const attempt = attemptRef.current;
      const activeRequest = requestRef.current;
      if (
        attempt?.resolution.kind === 'in_flight' &&
        activeRequest?.attempt === attempt &&
        attempt.dispatchOwner === activeRequest.owner
      ) {
        attempt.ambiguous = true;
        attempt.resolution = { kind: 'outcome_unknown' };
        publishRecoverableAttempt(attempt);
      }
      sequenceRef.current += 1;
      requestRef.current?.controller.abort();
      requestRef.current = null;
      inFlightRef.current = false;
    },
    [],
  );

  // Account/base-url changes are visible during render, before passive cleanup.
  // Never expose the prior scope's order or immutable request args for that
  // intermediate frame; the effect above will then adopt the new scope.
  const hasVisibleScopeAuthority =
    scopeRef.current === currentScopeKey &&
    (attemptRef.current === null || attemptRef.current.scopeKey === currentScopeKey);
  const visibleAttempt = hasVisibleScopeAuthority ? attemptRef.current : null;
  const visibleState: CryptoCheckoutState = hasVisibleScopeAuthority ? state : { kind: 'idle' };
  return { state: visibleState, lockedArgs: visibleAttempt?.args ?? null, start, retry, reset };
}
