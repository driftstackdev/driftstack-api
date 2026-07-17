import { useCallback, useEffect, useRef, useState } from 'react';

const SAFE_MAPPER_FALLBACK = "Couldn't complete that action. Try again.";

export type ExclusiveAsyncActionResult<T> =
  { status: 'success'; value: T } | { status: 'error'; error: string } | { status: 'busy' };

export interface ExclusiveAsyncActionOptions {
  mapError: (error: unknown) => string;
}

export interface ExclusiveAsyncActionController {
  pending: boolean;
  error: string | null;
  reset: () => void;
  run: <T>(work: () => T | PromiseLike<T>) => Promise<ExclusiveAsyncActionResult<T>>;
}

/**
 * Own one async action at a time.
 *
 * Ownership is acquired synchronously, before `work` is invoked, so multiple
 * native events in the same tick cannot start duplicate work while React is
 * still waiting to publish `pending`. Errors are converted to caller-approved
 * copy and returned as values so an ignored `run()` promise cannot reject.
 */
export function useExclusiveAsyncAction({
  mapError,
}: ExclusiveAsyncActionOptions): ExclusiveAsyncActionController {
  const ownerRef = useRef(false);
  const mountedRef = useRef(true);
  const mapErrorRef = useRef(mapError);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  mapErrorRef.current = mapError;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reset = useCallback((): void => {
    if (mountedRef.current) setError(null);
  }, []);

  const run = useCallback(
    async <T>(work: () => T | PromiseLike<T>): Promise<ExclusiveAsyncActionResult<T>> => {
      if (ownerRef.current) return { status: 'busy' };

      // This ref, rather than the pending state, is the lock. Set it before
      // invoking work or crossing any async boundary.
      ownerRef.current = true;
      if (mountedRef.current) {
        setPending(true);
        setError(null);
      }

      try {
        const value = await work();
        return { status: 'success', value };
      } catch (rawError) {
        let safeError = SAFE_MAPPER_FALLBACK;
        try {
          const mapped = mapErrorRef.current(rawError);
          if (mapped.trim().length > 0) safeError = mapped;
        } catch {
          // A defensive fallback keeps run() non-rejecting even if a mapper
          // regresses. Raw exception details must never become customer copy.
        }
        if (mountedRef.current) setError(safeError);
        return { status: 'error', error: safeError };
      } finally {
        ownerRef.current = false;
        if (mountedRef.current) setPending(false);
      }
    },
    [],
  );

  return { pending, error, reset, run };
}
