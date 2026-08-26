// 2026-07-10 — R2 orphaned profile sealed-blob reaper (#158; GDPR erasure
// backstop).
//
// THE RACE this closes (verified HIGH, task #158). A customer PURGE
// (DELETE /:id/purge → ProfilesService.purge → purgeTrashed) hard-deletes the
// profile row + its wrapped DEK and best-effort deletes the R2
// `profiles/<uuid>.sealed` blob. But a just-closed session for that same
// profile holds a presigned save-back PUT URL minted independently at
// session-assign (buildAssignProfileBlock, profile-store.ts) whose final PUT
// can still be IN FLIGHT. If that PUT lands AFTER the purge, the harness's
// direct PUT to R2 RE-CREATES `profiles/<uuid>.sealed` with NO DB row behind
// it — a permanent orphan the purge path can never reap (it already ran) and
// no other sweep touches. "Permanent delete" then isn't permanent: the
// customer's encrypted browser state lingers in R2 forever after erasure.
//
// The #1/#3 (2026-06-30) live-session guard (ProfilesService.assertNoActive
// Session) refuses a purge while a session is still `active`, which shrinks the
// window — but a session that flips to closed a hair before its final save-back
// PUT lands still slips through (the guard sees no active session, the purge
// runs, then the late PUT recreates the blob). This reaper is the wall-clock
// BACKSTOP for exactly that residual: it enumerates `profiles/*.sealed` in R2,
// and any object OLDER than a grace window whose uuid has NO profiles row at
// all (hard-deleted / never existed) is deleted.
//
// CONSERVATIVE BY DESIGN — it must NEVER reap a live or in-flight blob:
//   • GRACE WINDOW (DEFAULT_ORPHAN_GRACE_MS, 6h). An object is only a reap
//     candidate if its lastModified is non-null AND older than the grace window.
//     This MUST exceed the max presigned save-back PUT TTL so an in-flight
//     save-back is never reaped mid-flight. An object with a null lastModified,
//     or younger than the grace, is SKIPPED.
//
//     ⛔ V-1736 — this paragraph used to say the grace was 2h and that "the
//     current max minted TTL is DEFAULT_PROFILE_URL_TTL_SECONDS = 3600s (1h) —
//     both dispatch call sites use the default and nothing passes a larger
//     urlTtlSeconds". BOTH halves were wrong: the grace is 6h, and
//     routes/agent-sessions.ts DOES pass a larger value —
//     PROFILE_SAVE_BACK_PUT_TTL_SECONDS, currently 16200s (4.5h), because that
//     PUT is consumed at session TEARDOWN and must outlive the session. The two
//     errors cancelled and the invariant held (6h > 4.5h), which is exactly why
//     nobody noticed: a safety comment can be false in both directions and still
//     read as reassuring. The margin is 1.5h, not the 1h-against-1h the text
//     implied, and the relation is now asserted against the imported constant
//     rather than against literals retyped in the test.
//   • EXISTENCE CHECK is soft-delete-INCLUSIVE (findExistingProfileIds returns
//     trashed rows too): a trashed profile still owns its blob until the 30-day
//     retention purge, so we only reap a blob whose uuid has NO row whatsoever.
//   • The whole pass is wrapped so a listObjects AccessDenied (missing
//     s3:ListBucket) — or ANY throw — is caught + logged as a warn and the
//     sweeper re-arms for the next cycle. No crash, no chain death, no deletes.
//   • Per-key deleteObject is best-effort (catch + log); one failure never
//     aborts the rest of the pass.
//
// No key material or blob contents are ever logged (the blob is opaque anyway —
// LZFSE + AES-GCM-256 under a per-profile DEK) — only keys / uuids / counts.
//
// Scheduling: a self-contained self-re-arming setTimeout chain (start() →
// tickOnce → re-arm), .unref()'d so it never keeps the event loop alive on
// shutdown. Modelled on worker-disconnect-reaper.ts's in-process timer shape +
// the tick-failure-survival pattern the scheduled-jobs sweepers use (commit
// 82a9ea226): a per-tick failure is swallowed + logged and the chain always
// re-arms, so one bad pass can never silently stop the reaper forever.

import type { R2 } from '../lib/r2.js';
import type { Logger } from '../lib/logger.js';

/** Minimal profiles-repo surface the reaper needs (existence check, trashed-inclusive). */
export interface ProfileBlobOrphanExistenceRepo {
  /** #158 — which of `ids` still have a profiles row (any account, INCLUDING trashed). */
  findExistingProfileIds(ids: string[]): Promise<Set<string>>;
}

/** `profiles/<uuid>.sealed` — anchored, lowercase hex + dashes, exactly 36 chars. */
const SEALED_KEY_RE = /^profiles\/([0-9a-f-]{36})\.sealed$/;

const SEALED_PREFIX = 'profiles/';

/**
 * Default grace window (6h). MUST exceed the max presigned save-back PUT TTL so
 * an in-flight save-back is never reaped mid-flight: a blob's lastModified only
 * advances while a valid PUT URL exists, so once a blob is grace-old no live PUT
 * could still be writing it. The save-back PUT is minted for the session
 * lifetime — up to MANUAL_SESSION_MAX_DURATION_SECONDS (4h) plus a teardown
 * margin (~4.5h max; see buildAssignProfileBlock in profile-store.ts). 6h leaves
 * headroom over that ceiling. ⚠️ If any caller ever mints a LONGER save-back PUT
 * TTL, raise this to stay above it.
 */
export const DEFAULT_ORPHAN_GRACE_MS = 6 * 60 * 60 * 1000;

/** Default sweep interval (6h). */
export const DEFAULT_ORPHAN_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface ProfileBlobOrphanSweeperDeps {
  readonly r2: R2;
  readonly profiles: ProfileBlobOrphanExistenceRepo;
  readonly logger: Logger;
  /** Grace window in ms; only objects older than this are reap candidates. Default 2h. */
  readonly graceMs?: number;
  /** Sweep interval in ms for the self-arming chain. Default 6h. */
  readonly intervalMs?: number;
  /** Test seam — defaults to `Date.now`. */
  readonly nowFn?: () => number;
  /**
   * Timer seam — defaults to global setTimeout. Overridden in tests (fake
   * timers). Typed to accept the Node return so a real setTimeout slots in.
   */
  readonly setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

export interface ProfileBlobOrphanReapResult {
  readonly scanned: number;
  readonly reaped: number;
}

export class ProfileBlobOrphanSweeperService {
  private readonly graceMs: number;
  private readonly intervalMs: number;
  private readonly nowFn: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly deps: ProfileBlobOrphanSweeperDeps) {
    this.graceMs = deps.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
    this.intervalMs = deps.intervalMs ?? DEFAULT_ORPHAN_SWEEP_INTERVAL_MS;
    this.nowFn = deps.nowFn ?? Date.now;
    this.setTimeoutFn = deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  }

  /**
   * Run one reap pass. NEVER throws — a listObjects failure (AccessDenied for a
   * missing s3:ListBucket, or any other error) is caught + logged as a warn and
   * the pass returns { scanned: 0, reaped: 0 }; the caller's chain re-arms. A
   * per-key delete failure is caught + logged and does not abort the pass.
   */
  async tickOnce(): Promise<ProfileBlobOrphanReapResult> {
    const now = this.nowFn();
    let objects: Array<{ key: string; lastModified: Date | null }>;
    try {
      objects = await this.deps.r2.listObjects(SEALED_PREFIX);
    } catch (err) {
      this.deps.logger.warn?.(
        {
          component: 'profile-blob-orphan-reaper',
          err: err instanceof Error ? err.message : String(err),
        },
        'profile-blob-orphan-reaper: list failed — needs s3:ListBucket?',
      );
      return { scanned: 0, reaped: 0 };
    }

    // Collect reap CANDIDATES: a well-formed `profiles/<uuid>.sealed` key whose
    // lastModified is non-null AND older than the grace window. A null or too-
    // young lastModified is skipped (never reaped) — the in-flight-create guard.
    const graceCutoff = now - this.graceMs;
    const candidates: Array<{ key: string; uuid: string }> = [];
    for (const obj of objects) {
      const m = SEALED_KEY_RE.exec(obj.key);
      if (m === null) continue;
      if (obj.lastModified === null) continue;
      if (obj.lastModified.getTime() >= graceCutoff) continue;
      candidates.push({ key: obj.key, uuid: m[1]! });
    }

    if (candidates.length === 0) {
      this.deps.logger.info?.(
        { component: 'profile-blob-orphan-reaper', scanned: objects.length, reaped: 0 },
        'profile-blob-orphan reap sweep complete',
      );
      return { scanned: objects.length, reaped: 0 };
    }

    // Batch existence check (trashed-inclusive). A uuid NOT in the returned set
    // has no DB row at all → the blob is a genuine orphan to reap.
    const existing = await this.deps.profiles.findExistingProfileIds(candidates.map((c) => c.uuid));

    let reaped = 0;
    for (const { key, uuid } of candidates) {
      if (existing.has(uuid)) continue;
      try {
        await this.deps.r2.deleteObject(key);
        reaped += 1;
      } catch (err) {
        // A per-key delete failure must not abort the pass — log + move on; the
        // next sweep re-lists + retries the survivor.
        this.deps.logger.warn?.(
          {
            component: 'profile-blob-orphan-reaper',
            key,
            err: err instanceof Error ? err.message : String(err),
          },
          'profile-blob-orphan-reaper: delete failed (will retry next sweep)',
        );
      }
    }

    this.deps.logger.info?.(
      { component: 'profile-blob-orphan-reaper', scanned: objects.length, reaped },
      'profile-blob-orphan reap sweep complete',
    );
    return { scanned: objects.length, reaped };
  }

  /**
   * Arm the self-re-arming sweep chain. The first tick runs after `intervalMs`
   * (not immediately — boot is busy; there's no urgency, the orphan already
   * lingered). Each tick swallows its own errors (tickOnce never throws) but we
   * still wrap the re-arm so ANY unexpected throw can't kill the chain — a dead
   * chain would silently stop reaping and the GDPR-erasure backstop would be
   * gone until a process restart. The timer is .unref()'d so it never keeps the
   * process alive on shutdown.
   */
  start(): void {
    this.stopped = false;
    this.arm();
  }

  /** Cancel the pending timer (graceful-shutdown helper). */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private arm(): void {
    if (this.stopped) return;
    const handle = this.setTimeoutFn(() => {
      void (async () => {
        try {
          await this.tickOnce();
        } catch (err) {
          // tickOnce is designed never to throw; this is defense-in-depth so a
          // future refactor / an unexpected throw can never break the chain.
          this.deps.logger.error?.(
            {
              component: 'profile-blob-orphan-reaper',
              event: 'profile_blob_orphan_reap_tick_failed',
              err: err instanceof Error ? err.message : String(err),
            },
            'profile-blob-orphan reap tick threw unexpectedly — re-arming',
          );
        } finally {
          // ALWAYS re-arm (outside the try above via finally) so a swallowed OR
          // thrown tick still schedules the next pass. This is the chain-death
          // guard: the reaper must keep running for the life of the process.
          this.arm();
        }
      })();
    }, this.intervalMs);
    // Don't keep the event loop alive just for the reaper — the app closes
    // cleanly on SIGINT without waiting on the next sweep.
    if (typeof handle.unref === 'function') handle.unref();
    this.timer = handle;
  }
}
