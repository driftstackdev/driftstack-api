// 2026-05-20 — auth-token sweeper service.
//
// Periodic DELETE of stale rows across the three auth-flow token
// tables (email_verify_tokens / magic_link_tokens / password_reset_
// tokens). Per the 2026-05-20 stale-row audit
// (docs/internal/2026-05-20-stale-row-audit.md), consumeAuthToken()
// only marks rows as consumed; nothing currently deletes them. Same
// shape of bug as the 2026-05-19 scheduled_jobs accumulation incident
// but pre-scale (~10 rows at 10 customers; ~70K rows at 10K). This
// sweeper closes the loop before scale.
//
// Retention policy:
//   - consumed rows kept ≥30 days post-consumption (forensic window
//     for support tickets — "the magic link expired but I clicked it"
//     diagnostics still work).
//   - expired-but-unconsumed rows kept ≥7 days post-expiration
//     (covers the typical retry window — customer abandons + comes
//     back later via the same email link).
//
// Scheduling: exposes `tickOnce(now)` for a future scheduled-jobs
// entry. Same pattern as agent-pair-mode-heartbeat-sweep.ts.

import type { AuthFlowsRepo, AuthFlowKind } from './auth-flows.js';

const CONSUMED_RETENTION_DAYS = 30;
const EXPIRED_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const KINDS: readonly AuthFlowKind[] = ['email_verify', 'magic_link', 'password_reset'];

export interface AuthTokensSweeperDeps {
  readonly repo: AuthFlowsRepo;
  readonly consumedRetentionDays?: number;
  readonly expiredRetentionDays?: number;
}

export interface SweepTickResult {
  readonly deletedByKind: Record<AuthFlowKind, number>;
  readonly totalDeleted: number;
}

export class AuthTokensSweeperService {
  private readonly consumedMs: number;
  private readonly expiredMs: number;

  constructor(private readonly deps: AuthTokensSweeperDeps) {
    this.consumedMs = (deps.consumedRetentionDays ?? CONSUMED_RETENTION_DAYS) * DAY_MS;
    this.expiredMs = (deps.expiredRetentionDays ?? EXPIRED_RETENTION_DAYS) * DAY_MS;
  }

  async tickOnce(now: Date): Promise<SweepTickResult> {
    const consumedBefore = new Date(now.getTime() - this.consumedMs);
    const expiredBefore = new Date(now.getTime() - this.expiredMs);

    const deletedByKind: Record<AuthFlowKind, number> = {
      email_verify: 0,
      magic_link: 0,
      password_reset: 0,
    };

    let totalDeleted = 0;
    for (const kind of KINDS) {
      const n = await this.deps.repo.deleteStaleAuthTokens({
        kind,
        consumedBefore,
        expiredBefore,
      });
      deletedByKind[kind] = n;
      totalDeleted += n;
    }

    return { deletedByKind, totalDeleted };
  }
}
