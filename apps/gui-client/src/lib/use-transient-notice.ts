import { useCallback, useEffect, useRef, useState } from 'react';

export interface TransientNoticeController {
  notice: string | null;
  showNotice: (message: string, durationMs?: number) => void;
  clearNotice: () => void;
}

/** Owns the simulator's one-at-a-time transient notice lifecycle.
 *
 * Every new message cancels the prior message's expiry. Without that ownership,
 * an older timeout can erase a newer success/error notice almost immediately.
 */
export function useTransientNotice(): TransientNoticeController {
  const [notice, setNotice] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearNotice = useCallback((): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setNotice(null);
  }, []);

  const showNotice = useCallback((message: string, durationMs = 4_000): void => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setNotice(message);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setNotice(null);
    }, durationMs);
  }, []);

  useEffect(() => clearNotice, [clearNotice]);

  return { notice, showNotice, clearNotice };
}
