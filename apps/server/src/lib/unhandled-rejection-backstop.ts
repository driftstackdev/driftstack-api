// Process-level unhandled-rejection backstop (#2 defense-in-depth).
//
// Node 22 runs with --unhandled-rejections=throw by default, so a single missed
// `.catch()` on a fire-and-forget promise — e.g. the profileSaved persister,
// which fires on EVERY profile-backed teardown and awaits DB lookups that can
// reject on a Neon compute-quota block / blip — would terminate the Fastify
// process during exactly the worst window. Individual paths catch their own
// errors; this is the last line of defense so one slip can't take the whole
// control plane down. We log (+ count) the rejection and keep the process alive.

let unhandledRejectionCount = 0;

/**
 * Metric sink, attached AFTER install.
 *
 * The backstop is installed before any async wiring — deliberately, so a
 * rejection during bootstrap is caught — which is earlier than the metrics
 * registry exists. Rather than reorder that (and lose the bootstrap window), the
 * sink attaches later and is REPLAYED the count accumulated before it arrived,
 * so a rejection during bootstrap still reaches the metric.
 */
let sink: ((delta: number) => void) | null = null;

/** Count of unhandled rejections the backstop has swallowed (for tests + a
 *  future metrics scrape). The backstop logs each occurrence too. */
export function getUnhandledRejectionCount(): number {
  return unhandledRejectionCount;
}

/** Reset the counter — test helper only. */
export function resetUnhandledRejectionCount(): void {
  unhandledRejectionCount = 0;
  sink = null;
}

export interface BackstopLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Install the `process.on('unhandledRejection')` backstop. Logs + counts the
 * rejection instead of letting the default behaviour crash the process. Idempotent
 * is NOT guaranteed — call once at bootstrap.
 */
/**
 * Attach the metric sink and replay anything counted before now.
 *
 * Idempotent in the sense that re-attaching replaces the sink; the replay uses
 * the running total, so a second attach would double-count. Call once, from
 * bootstrap, after the counter is registered.
 */
export function attachUnhandledRejectionMetric(emit: (delta: number) => void): void {
  sink = emit;
  if (unhandledRejectionCount > 0) emit(unhandledRejectionCount);
}

export function installUnhandledRejectionBackstop(logger: BackstopLogger): void {
  process.on('unhandledRejection', (reason: unknown) => {
    unhandledRejectionCount += 1;
    sink?.(1);
    logger.error(
      {
        component: 'process',
        unhandled_rejection_count: unhandledRejectionCount,
        reason:
          reason instanceof Error
            ? { name: reason.name, message: reason.message, stack: reason.stack }
            : { value: reason },
      },
      'unhandled promise rejection (backstopped — process kept alive)',
    );
  });
}
