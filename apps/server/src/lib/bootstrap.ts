// Production bootstrap.
//
// Constructs the full AppDeps graph from config + a logger, returning
// the deps + a teardown function for graceful shutdown. The shape is
// pure-factory: pass-in dependencies are not constructed lazily, and
// every external connection (Postgres pool, Redis client, R2 client,
// Sentry, Postmark) is opened here, so the SIGTERM handler can close
// them deterministically.
//
// Failure semantics:
//   - Postgres connection failure at boot → throw. The deploy
//     pipeline's /health probe will fail; orchestrator will not
//     promote.
//   - Redis connection failure at boot → throw (same reasoning;
//     auth-cache + rate-limit-store are load-bearing).
//   - R2 / Postmark / Sentry init failure at boot → log warn; the
//     service starts in degraded mode (those features no-op). These
//     are not on the request critical path.
//   - readinessChecks fire every /ready hit. /ready 503 on any
//     reachable-but-failing dep. Health checks are decoupled.

import { DEFAULT_BEHAVIORAL_PROFILE } from '@driftstack/api-types';
import { attachUnhandledRejectionMetric } from './unhandled-rejection-backstop.js';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb, type Database } from '../db/client.js';
import { DrizzleAccountAuthRepo } from '../db/auth-repo.js';
import { DrizzleFleetNodesRepo } from '../db/fleet-nodes-repo.js';
import { FleetNodeAuthImpl } from '../services/fleet-node-auth.js';
import { FleetControlRegistry } from '../services/fleet-control-registry.js';
import { UnknownResultKeyReporter } from '../services/harness-result-unknown-keys.js';
import { SessionPageStateStore } from '../services/session-page-state-store.js';
import { SessionLivenessStore } from '../services/session-liveness-store.js';
import { SessionCapabilityReportStore } from '../services/session-capability-report-store.js';
import { SessionNetworkLogStore } from '../services/session-network-log-store.js';
import { SessionCaptureStore } from '../services/session-capture-store.js';
import { makeProfileSavedPersister } from '../services/profile-store.js';
import { makeChallengeRelay } from '../services/challenge-relay.js';
import { makeProfileSaveFailedRelay } from '../services/profile-save-failed-relay.js';
import { makeSessionPageStateRelay } from '../services/session-page-state-relay.js';
import { makeSessionCapabilityReportRelay } from '../services/session-capability-report-relay.js';
import { makeSessionNetworkLogRelay } from '../services/session-network-log-relay.js';
import { makeSessionProvisioningDetailRelay } from '../services/session-provisioning-detail-relay.js';
import { makeSessionErrorEventRelay } from '../services/session-error-event-relay.js';
import { makeFleetHeartbeatConsumer } from '../services/fleet-heartbeat-consumer.js';
import { makeAgentSessionTerminalStatusRelay } from '../services/agent-session-terminal-close.js';
import { reconcileWorkerReportedOrphans } from '../services/cp-daemon-reconcile.js';
import { reconcileNodeBootChange } from '../services/node-boot-reconcile.js';
import { serializeSessionEnd } from '../services/harness-control-codec.js';
import { RedisFleetNonceCache } from '../lib/redis-fleet-nonce-cache.js';
import { canonicalOneTimeTokenUrl } from '../lib/canonical-one-time-token-url.js';
import { DrizzleAtlasPriorityEventsRepo } from '../db/atlas-priority-events-repo.js';
import { InternalFleetAuth } from './internal-fleet-auth.js';
import { DrizzleSessionRepo } from '../db/sessions-repo.js';
import { DrizzleApiKeysRepo } from '../db/api-keys-repo.js';
import { DrizzleUsageRepo } from '../db/usage-repo.js';
import { DrizzleWebhooksRepo } from '../db/webhooks-repo.js';
import { DrizzleWebhookRotationReminderRepo } from '../db/webhook-rotation-reminder-repo.js';
import { DrizzleByokAnthropicRotationReminderRepo } from '../db/byok-anthropic-rotation-reminder-repo.js';
import { WebhookRotationReminderService } from '../services/webhook-rotation-reminder.js';
import { ByokAnthropicRotationReminderService } from '../services/byok-anthropic-rotation-reminder.js';
import { WebhookGraceExpiringNoticeService } from '../services/webhook-grace-expiring-notice.js';
import { DrizzleAdminAuditLogRepo } from '../db/admin-audit-repo.js';
import { DrizzleAccountsAdminRepo } from '../db/admin-accounts-repo.js';
import { DrizzleAdminBillingRepo } from '../db/admin-billing-repo.js';
import { DrizzlePricingRepo } from '../db/pricing-repo.js';
import { DrizzlePlatformSecretsRepo } from '../db/platform-secrets-repo.js';
import { DrizzleEmailPreferencesRepo } from '../db/email-preferences-repo.js';
import { EmailPreferencesService } from '../services/email-preferences.js';
import { DrizzleAccountAuditRepo } from '../db/account-audit-repo.js';
import { AccountAuditService } from '../services/account-audit.js';
import { DrizzleAccountLifecycleRepo } from '../db/account-lifecycle-repo.js';
import { AccountLifecycleService } from '../services/account-lifecycle.js';
import { DrizzleScheduledJobsRepo } from '../db/scheduled-jobs-repo.js';
import { ScheduledJobsService } from '../services/scheduled-jobs.js';
import { DrizzleValidationSchedulesRepo } from '../db/validation-schedules-repo.js';
import {
  ValidationHarnessService,
  type ValidationHarnessRecaptureBridge,
} from '../services/validation-harness.js';
import { DrizzleRateLimitOverridesRepo } from '../db/rate-limit-overrides-repo.js';
import { DrizzleLegalRepo } from '../db/legal-repo.js';
import { DrizzleAuthFlowsRepo } from '../db/auth-flows-repo.js';
import { DrizzleOAuthLinksRepo, DrizzleOAuthPendingLinksRepo } from '../db/oauth-links-repo.js';
import { DrizzleOAuthStore } from '../db/oauth-store.js';
import { OAuthClientServiceImpl } from '../services/oauth-client-service.js';
import { DrizzleStripeWebhooksRepo } from '../db/stripe-webhooks-repo.js';
import { DrizzleProfilesRepo } from '../db/profiles-repo.js';
import { DrizzleAccountProxiesRepo } from '../db/account-proxies-repo.js';
import { AccountProxiesService } from '../services/account-proxies.js';
import { ProxyConnectivityProbe } from '../services/proxy-connectivity-probe.js';
import { DEFAULT_OS_OBSERVER_PORT, makeOsObserverLookup } from './os-observer-lookup.js';
import { SessionsService } from '../services/sessions.js';
import { ApiKeysService } from '../services/api-keys.js';
import { MfaService } from '../services/mfa.js';
import { DrizzleMfaRepo } from '../db/mfa-repo.js';
import { BYOKAnthropicService } from '../services/byok-anthropic.js';
import { DrizzleBYOKAnthropicRepo } from '../db/byok-anthropic-repo.js';
import { BundledLlmService } from '../services/bundled-llm.js';
import { DrizzleBundledLlmRepo } from '../db/bundled-llm-repo.js';
import { AgentSessionEventBus } from '../services/agent-session-event-bus.js';
import { RedisPairModeTakeoverLock } from '../services/agent-pair-mode-lock.js';
import {
  agentTurnStopRedisAdapter,
  RedisAgentTurnStopChannel,
} from '../services/agent-turn-stop-channel.js';
import { InMemoryPairModeHeartbeatTracker } from '../services/agent-pair-mode-heartbeat.js';
import { PairModeHeartbeatSweep } from '../services/agent-pair-mode-heartbeat-sweep.js';
import { MetricsRegistry, METRIC_NAMES } from '../services/metrics-registry.js';
import { refreshJobChainLiveness } from '../services/job-chain-liveness.js';
import {
  wireDailyMaintenanceSweep,
  ROTATION_REMINDER_JOB_TYPES,
  STATUS_SUBSCRIBER_PURGE_JOB_TYPE,
  WEBHOOK_ROTATION_REMINDER_JOB_TYPE,
  BYOK_ANTHROPIC_ROTATION_REMINDER_JOB_TYPE,
  WEBHOOK_GRACE_EXPIRING_NOTICE_JOB_TYPE,
  WEBHOOK_SECRET_PREV_CLEANUP_JOB_TYPE,
} from '../services/daily-maintenance-jobs.js';
import { SocksProxyBackend } from '../services/proxy-backends/socks5.js';
import { DrizzleRecipesRepo, purgeRecipesForTerminatedAccountsBefore } from '../db/recipes-repo.js';
import {
  DrizzleAgentSessionsRepo,
  purgeAgentSessionsForTerminatedAccountsBefore,
} from '../db/agent-sessions-repo.js';
import {
  DrizzleAgentTurnReceiptsRepo,
  purgeTurnReceiptsForTerminatedAccountsBefore,
} from '../db/agent-turn-receipts-repo.js';
import { DrizzleAgentDecomposerUsageRecorder } from '../db/agent-decomposer-usage-recorder.js';
import { DrizzleAgentTurnTelemetryRepo } from '../db/agent-turn-telemetry-repo.js';
import {
  AGENT_TURN_DURATION_BUCKETS_SECONDS,
  AGENT_TURN_FIRST_PROGRESS_BUCKETS_SECONDS,
  AGENT_TURN_REPLAN_BUCKETS,
  AgentTurnTelemetry,
  InProcessProfileAttachmentWindow,
  LOOK_TO_TAP_BUCKETS_SECONDS,
  PRE_TAP_LOOK_DURATION_BUCKETS_SECONDS,
} from '../services/agent-turn-telemetry.js';
import { AgentTurnSummaryService } from '../services/agent-turn-summary.js';
import {
  enqueueNextAgentTurnTelemetryPrune,
  registerAgentTurnTelemetryPruneJob,
} from '../services/agent-turn-telemetry-prune-job.js';
import {
  AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE,
  endAgentTurnHealthWatchdogChain,
  enqueueNextAgentTurnHealthWatchdog,
  registerAgentTurnHealthWatchdogJob,
} from '../services/agent-turn-health-watchdog.js';
import { createAgentTurnHealthEmailer } from '../services/agent-turn-health-email.js';
import { AgentRuntime } from '../services/agent-runtime.js';
import { resolveTaskRefusalConfig, type RefusalPattern } from '../services/task-refusal.js';
import { StubAgentExecutor, type AgentExecutor } from '../services/agent-executor.js';
import { ControlPlaneAgentExecutor } from '../services/agent-executor-control-plane.js';
import { FleetSessionRoutingDispatcher } from '../services/fleet-session-routing-dispatcher.js';
import { ClaudeAgentDecomposer } from '../services/agent-decomposer-claude.js';
import { DeterministicAgentDecomposer } from '../services/agent-decomposer-deterministic.js';
import type { AgentDecomposer } from '../services/agent-decomposer.js';
import { InMemoryByokKeyCache } from '../services/byok-anthropic-key-cache.js';
import { EXIT_IDENTITY_TTL_MS, RedisExitIdentityStore } from '../services/exit-identity-cache.js';
import { RedisMfaChallengeStore } from '../services/mfa-challenge-store.js';
import { UsageService } from '../services/usage.js';
import { WebhooksService, WebhooksAdminService } from '../services/webhooks.js';
import { WebhookDeliveryWorker } from '../services/webhook-worker.js';
import { AdminAuditService } from '../services/admin-audit.js';
import { AccountsAdminService } from '../services/admin-accounts.js';
import { AdminBillingService } from '../services/admin-billing.js';
import { PricingService } from '../services/pricing.js';
import { PlatformSecretsService } from '../services/platform-secrets.js';
import { IncidentsService, type IncidentRow } from '../services/incidents.js';
import { DrizzleIncidentsRepo } from '../db/incidents-repo.js';
import { DrizzleIncidentUpdateNotificationsRepo } from '../db/incident-update-notifications-repo.js';
import { FetchProber, HealthProbeService } from '../services/health-probe.js';
import { DrizzleProbesRepo } from '../db/health-probes-repo.js';
import { StatusSnapshotService } from '../services/status-snapshot.js';
import { StatusSubscribersService } from '../services/status-subscribers.js';
import { DrizzleStatusSubscribersRepo } from '../db/status-subscribers-repo.js';
import { TeamMembersService } from '../services/team-members.js';
import { DrizzleTeamMembersRepo } from '../db/team-members-repo.js';
import { IncidentNotificationsService } from '../services/incident-notifications.js';
import { IncidentBroadcastService } from '../services/incident-broadcast.js';
import { IncidentEventBus } from '../services/incident-event-bus.js';
import { SlaReportingService } from '../services/sla-reporting.js';
import { RateLimitOverridesService } from '../services/rate-limit-overrides.js';
import { LegalService } from '../services/legal.js';
import { AuthFlowsService, findAccountIdForSignInEmail } from '../services/auth-flows.js';
import {
  AuthTokensSweeperService,
  enqueueNextAuthTokensSweep,
  registerAuthTokensSweepJob,
} from '../services/auth-flows-sweeper.js';
import {
  OAuthRetentionSweeperService,
  enqueueNextOAuthRetentionSweep,
  registerOAuthRetentionSweepJob,
} from '../services/oauth-retention-sweeper.js';
import {
  ProfileTrashPurgeSweeperService,
  enqueueNextProfileTrashPurge,
  registerProfileTrashPurgeJob,
} from '../services/profile-trash-purge-sweeper.js';
import {
  AccountDeletionPurgeSweeperService,
  enqueueNextAccountDeletionPurge,
  registerAccountDeletionPurgeJob,
} from '../services/account-deletion-purge-sweeper.js';
import { DrizzleAccountDeletionPurgeRepo } from '../db/account-deletion-purge-repo.js';
import {
  AgentSessionOrphanSweeperService,
  enqueueNextAgentSessionOrphanReap,
  registerAgentSessionOrphanReapJob,
} from '../services/agent-session-orphan-sweeper.js';
import { WorkerDisconnectReaperService } from '../services/worker-disconnect-reaper.js';
import { ProfileBlobOrphanSweeperService } from '../services/profile-blob-orphan-sweeper.js';
import {
  SessionDurationSweeperService,
  enqueueNextSessionDurationSweep,
  registerSessionDurationSweepJob,
} from '../services/session-duration-sweeper.js';
import {
  CryptoEntitlementExpirySweeperService,
  enqueueNextCryptoEntitlementExpirySweep,
  registerCryptoEntitlementExpirySweepJob,
} from '../services/crypto-entitlement-expiry-sweeper.js';
import {
  PastDueGraceSweeperService,
  enqueueNextPastDueGraceSweep,
  registerPastDueGraceSweepJob,
} from '../services/past-due-grace-sweeper.js';
import {
  RetentionScrubSweeperService,
  registerRetentionScrubJob,
  enqueueNextRetentionScrub,
} from '../services/retention-scrub-sweeper.js';
import { DrizzleRetentionScrubRepo } from '../db/retention-scrub-repo.js';
import {
  enqueueNextScheduledJobsPrune,
  registerScheduledJobsPruneJob,
} from '../services/scheduled-jobs-prune-sweeper.js';
import { CliAuthorizeService } from '../services/cli-authorize.js';
import { StripeWebhooksService } from '../services/stripe-webhooks.js';
import { ProfilesService } from '../services/profiles.js';
import { ProfileSnapshotsService } from '../services/profile-snapshots.js';
import { DrizzleProfileSnapshotsRepo } from '../db/profile-snapshots-repo.js';
import { BillingService, type BillingProvider } from '../services/billing.js';
import { CryptoOrdersService } from '../services/crypto-orders.js';
import {
  registerCryptoOrderExpirySweepJob,
  enqueueNextCryptoOrderExpirySweep,
} from '../services/crypto-order-expiry-sweep-job.js';
import {
  registerProxyFreshnessJob,
  enqueueNextProxyFreshnessRefresh,
} from '../services/proxy-freshness-job.js';
import { AuditArchiveService } from '../services/audit-archive.js';
import { DrizzleArchiveTableRepo, DrizzleArchiveLedgerRepo } from '../db/audit-archive-repo.js';
import {
  registerSessionEventsArchiveJob,
  enqueueNextSessionEventsArchive,
} from '../services/session-events-archive-job.js';
import { CryptoTierActivationService } from '../services/crypto-tier-activation.js';
import { DrizzleCreditLedgerRepo } from '../db/credit-ledger-repo.js';
import { DrizzleCreditPlanOverridesRepo } from '../db/credit-plan-overrides-repo.js';
import { DrizzleCreditWindowsRepo } from '../db/credit-windows-repo.js';
import { DrizzleCreditRateCardRepo } from '../db/credit-rate-card-repo.js';
import { DrizzleCreditReservationsRepo } from '../db/credit-reservations-repo.js';
import { DrizzleCreditInvariantAuditRepo } from '../db/credit-invariant-audit-repo.js';
import { DrizzleCreditCutoverRepo } from '../db/credit-cutover-repo.js';
import { CreditClawbacksService } from '../services/credit-clawbacks.js';
import { CreditGrantsService, creditGrantsRun } from '../services/credit-grants.js';
import { CreditReservationsService } from '../services/credit-reservations.js';
import { CreditCutoverService } from '../services/credit-cutover.js';
import { DrizzleAiCreditsReportRepo } from '../db/ai-credits-report-repo.js';
import { aiCreditsCounters, type AiCreditsRuntime } from '../services/ai-credits-runtime.js';
import {
  AiCreditLeaseKeeper,
  CREDIT_LEASE_KEEPER_INTERVAL_MS,
} from '../services/ai-credit-lease-keeper.js';
import {
  enqueueNextCreditsInvariantAudit,
  registerCreditsInvariantAuditJob,
} from '../services/credit-invariant-audit.js';
import {
  CREDITS_RECURRING_JOB_TYPES,
  enqueueNextCreditsCoverageSweep,
  enqueueNextCreditsExpirySweep,
  registerCreditsCoverageSweepJob,
  registerCreditsExpirySweepJob,
  registerCreditsWindowBoundaryJob,
} from '../services/credit-grant-jobs.js';
import { DrizzleCryptoOrdersRepo } from '../db/crypto-orders-repo.js';
import {
  CryptoEntitlementReconcileSweeper,
  registerCryptoEntitlementReconcileJob,
  enqueueNextCryptoEntitlementReconcile,
} from '../services/crypto-entitlement-reconcile-sweeper.js';
import { NowPaymentsApiClient } from './nowpayments-api.js';
import { CostMonitoringService } from '../services/cost-monitoring.js';
import { UsageAggregatorFromUsageRepo } from '../services/cost-aggregator.js';
import { CostAlertDispatcher } from '../services/cost-alert-dispatcher.js';
import { registerCostNightlyJob, enqueueNextNightlyRun } from '../services/cost-nightly-job.js';
import { DrizzleCostNightlyAccountIdProvider } from '../db/cost-nightly-accounts-provider.js';
import { NotificationEventBus } from '../services/notification-event-bus.js';
import { DEFAULT_COST_RATES, DEFAULT_TIER_THRESHOLDS_DERIVED } from './cost-defaults.js';
import { StripeBillingProvider } from '../services/stripe-billing-provider.js';
import { StripeApiClient } from './stripe-api.js';
import { buildStripePriceMaps } from './stripe-billing-facts.js';
import { validateStripeKeyForLaunch } from './stripe-key-safety.js';
import { DrizzleBillingRepo } from '../db/billing-repo.js';
import { buildLegalCatalog } from '../services/legal-catalog.js';
import { RedisAuthCache } from '../services/auth-cache.js';
import { AuthCoalescer } from '../services/auth-coalescer.js';
import { InProcessNegativeAuthCache } from '../services/negative-auth-cache.js';
import { RedisRateLimitStore } from '../lib/redis-rate-limit-store.js';
import { createDriver } from '../drivers/index.js';
import { createR2Client, createR2PublicClient, r2ReadinessCheck, type R2 } from './r2.js';
import {
  createEmailService,
  createDrizzleAccountEmailDeliveryTracker,
  type EmailService,
} from '../services/email.js';
import { initSentry, type SentryClient } from './sentry.js';
import { isNewWorkerFault } from './worker-fault-log.js';
import type { AppDeps, ReadinessCheck } from './app.js';
import type { Config } from './config.js';
import { envFlag } from './config.js';
import { decodeMasterKey } from './profile-key-hierarchy.js';
import type { Logger } from './logger.js';
import { assertCorsPosture } from './cors-posture.js';

export interface BootstrapResult {
  deps: AppDeps;
  /** Live handles — exposed so SIGTERM can close them in order. */
  handles: {
    db: Database;
    redis: Redis;
    r2: R2 | null;
    email: EmailService;
    sentry: SentryClient;
  };
  /** Close everything in the right order; idempotent. */
  teardown: () => Promise<void>;
}

/**
 * Give an async lifecycle operation one synchronous first-call owner. Every
 * caller receives the exact same promise, including callers that arrive while
 * the operation is still settling. The microtask boundary also converts a
 * synchronous throw from `operation` into that shared rejection.
 */
export function shareFirstAsyncCall<TArgs extends unknown[]>(
  operation: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  let owner: Promise<void> | null = null;
  return (...args) => {
    owner ??= Promise.resolve().then(() => operation(...args));
    return owner;
  };
}

/**
 * Longest `redis.quit()` may take before teardown gives up on it.
 *
 * A clean quit is milliseconds. This bound exists for the unreachable-Redis
 * case, where quit waits on a socket that will never answer. 2s is comfortably
 * above any healthy quit and small enough that the whole teardown still fits
 * inside the systemd stop window with the request drain ahead of it.
 */
export const REDIS_QUIT_DEADLINE_MS = 2_000;

/**
 * Longest teardown waits for AI turn diagnostics rows that were decided but not
 * yet written.
 *
 * The row is written off the response path on purpose, so at SIGTERM the last
 * few turns' rows are still a deferred task or an open insert — and every deploy
 * is a SIGTERM. Without this they were lost uncounted. It runs BEFORE the
 * Postgres close (it needs the pool) and is short because it is the one step
 * that is in series with the closes: a healthy insert takes milliseconds, and a
 * sick database must not spend the stop window. `shutdown-budget-fits-systemd-
 * stop-window` adds this to the worst case; at 1.5s it did not fit.
 */
export const AGENT_TURN_TELEMETRY_FLUSH_DEADLINE_MS = 750;

/**
 * Longest teardown waits to hand this process's AI task leases back (H6).
 *
 * One UPDATE over a partial index, of at most a handful of rows — it takes
 * milliseconds when the database is healthy. It runs CONCURRENTLY with the
 * telemetry flush above, both before the Postgres close, so the pair costs the
 * longer of the two and not their sum; `shutdown-budget-fits-systemd-stop-
 * window` reads it that way, and the budget has only 250 ms of slack, so a
 * serial step here would not fit.
 *
 * Missing the deadline costs nothing anybody can see: the leases then lapse on
 * their own 90-second schedule, which is exactly what happens when a process is
 * killed outright.
 */
export const CREDIT_LEASE_RELEASE_DEADLINE_MS = 750;

/**
 * Run one teardown step with a deadline, resolving either way.
 *
 * Never rejects: teardown runs on the way to `process.exit(0)`, and a step that
 * throws there would abort the steps after it — turning one unreachable
 * dependency into a leaked one. Mirrors `destroyDriverSessionWithTimeout`,
 * including the `unref()` so a pending timer cannot itself hold the process
 * open, and the `clearTimeout` so the fast path leaves nothing behind.
 */
export async function withTeardownDeadline(
  timeoutMs: number,
  step: () => Promise<unknown>,
): Promise<{ timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([
      step().then(
        () => 'done' as const,
        () => 'done' as const,
      ),
      deadline,
    ]);
    return { timedOut: outcome === 'timeout' };
  } catch {
    // `step()` throwing synchronously lands here; same contract as a rejection.
    return { timedOut: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build the request-serving app after production dependencies are live. A
 * construction failure owns fatal cleanup: teardown must settle before exit,
 * and `null` tells the entrypoint to return before handlers or listen wiring.
 */
export async function buildAppWithFatalTeardown<T>(args: {
  build: () => Promise<T>;
  teardown: () => Promise<void>;
  onFailure: (error: unknown) => void;
  exit: (code: number) => void;
}): Promise<T | null> {
  try {
    return await args.build();
  } catch (error) {
    args.onFailure(error);
    await args.teardown();
    args.exit(1);
    return null;
  }
}

/**
 * Resolve the repo root that holds `docs/legal/*.md`. Prod (the V-051
 * Docker image) runs with cwd at the dir containing docs/legal, so
 * cwd-first preserves that exact behavior. Local dev (`npm run dev -w
 * apps/server`) runs with cwd=apps/server where docs/legal is absent —
 * fall back to walking up from THIS module's location until docs/legal
 * is found. Final fallback = cwd (unchanged from the original behavior,
 * so a genuinely-missing catalog still fails loudly the same way).
 */
function resolveRepoRoot(): string {
  const marker = 'docs/legal/terms-of-service.md';
  const candidates: string[] = [resolve(process.cwd())];
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      candidates.push(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* import.meta unavailable (non-ESM test shim) — cwd candidate stands */
  }
  for (const c of candidates) {
    if (existsSync(resolve(c, marker))) return c;
  }
  return resolve(process.cwd());
}

export async function createProductionDeps(
  config: Config,
  logger: Logger,
): Promise<BootstrapResult> {
  // Sentry first — so any later init exceptions surface there too.
  const sentry = initSentry({ config: config.sentry, logger });

  // Postgres pool. Fail-fast probe `SELECT 1` so a misconfigured
  // DATABASE_URL surfaces at boot, not on the first request.
  const dbHandle = createDb(config.databaseUrl, {
    ...(config.slowQueryLogThresholdMs !== undefined
      ? {
          slowQueryLog: {
            thresholdMs: config.slowQueryLogThresholdMs,
            logger,
          },
        }
      : {}),
    ...(config.dbStatementTimeoutMs !== undefined
      ? { statementTimeoutMs: config.dbStatementTimeoutMs }
      : {}),
  });
  await dbHandle.client`SELECT 1`;
  if (config.slowQueryLogThresholdMs !== undefined) {
    logger.info(
      {
        component: 'postgres',
        slowQueryLogThresholdMs: config.slowQueryLogThresholdMs,
      },
      'postgres connected (slow-query log enabled)',
    );
  } else {
    logger.info({ component: 'postgres' }, 'postgres connected');
  }

  // Redis (single client for both auth cache + rate limit store —
  // they share the same connection but use distinct key prefixes).
  // PING at boot for the same fail-fast posture as Postgres.
  const redis = new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  });
  redis.on('error', (err) => {
    logger.warn(
      {
        component: 'redis',
        err:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
            : { value: err },
      },
      'redis connection error',
    );
  });
  await redis.ping();
  logger.info({ component: 'redis' }, 'redis connected');

  // R2 — optional. Null if env not configured (logged below).
  const r2 = config.r2 !== null ? createR2Client(config.r2) : null;
  if (r2 === null) {
    logger.warn(
      { component: 'r2' },
      'R2 not configured — recordings durability + presigned URLs disabled. Set R2_* env vars to enable.',
    );
  } else {
    logger.info({ component: 'r2', bucket: r2.bucket }, 'R2 client initialized');
  }

  // Postmark email — optional. No-op if not configured. Constructed
  // lazily AFTER the metrics registry below so the metrics dep can
  // be threaded in at construction time.

  // Repos — Drizzle-backed.
  const authRepo = new DrizzleAccountAuthRepo(dbHandle);
  const oauthStore = new DrizzleOAuthStore(dbHandle);
  const sessionsRepo = new DrizzleSessionRepo(dbHandle);
  const apiKeysRepo = new DrizzleApiKeysRepo(dbHandle);
  const usageRepo = new DrizzleUsageRepo(dbHandle);
  const webhooksRepo = new DrizzleWebhooksRepo(dbHandle, {
    ...(config.mfaEncryptionKey !== undefined
      ? { secretEncryptionKeyBase64: config.mfaEncryptionKey }
      : {}),
    onUndecryptableSecret: ({ endpointId, accountId, error }) => {
      // A cross-account sweep skips this row rather than failing for every
      // other account. Logged at error so the wedged endpoint is findable.
      logger.error(
        { endpointId, accountId, err: error },
        'webhook endpoint secret could not be decrypted; skipped in sweep',
      );
    },
  });
  if (config.mfaEncryptionKey !== undefined) {
    const MAX_WEBHOOK_SECRET_BOOT_MIGRATION_ROWS = 10_000;
    let scanned = 0;
    let converted = 0;
    let remaining = 0;
    do {
      const batch = await webhooksRepo.encryptLegacySecrets(500);
      scanned += batch.scanned;
      converted += batch.converted;
      remaining = batch.remaining;
      if (remaining > 0 && (batch.scanned === 0 || batch.converted === 0)) {
        throw new Error(
          `Webhook signing-secret migration made no progress with ${remaining.toString()} ` +
            'legacy rows remaining.',
        );
      }
      if (remaining > 0 && scanned >= MAX_WEBHOOK_SECRET_BOOT_MIGRATION_ROWS) {
        throw new Error(
          `Webhook signing-secret migration exceeded the ` +
            `${MAX_WEBHOOK_SECRET_BOOT_MIGRATION_ROWS.toString()}-row boot bound with ` +
            `${remaining.toString()} legacy rows remaining.`,
        );
      }
    } while (remaining > 0);
    if (scanned > 0) {
      logger.info(
        { component: 'webhook-secret-encryption', scanned, converted, remaining },
        'legacy webhook signing secrets migrated to record-bound v2 before serving',
      );
    }
  } else {
    logger.warn(
      { component: 'webhook-secret-encryption' },
      'MFA_ENCRYPTION_KEY not set — encrypted webhook secrets are unreadable and new secret writes fail closed',
    );
  }
  const adminAuditRepo = new DrizzleAdminAuditLogRepo(dbHandle);
  // The plan an admin set by hand. NULL WHILE DRIFTSTACK_AI_CREDITS_MODE IS OFF,
  // like every other credits dependency: an admin tier change then ends no
  // override and writes no contract, which is exactly what it did before.
  const creditPlanOverridesRepo = creditGrantsRun(config.aiCreditsMode)
    ? new DrizzleCreditPlanOverridesRepo(dbHandle)
    : null;
  const accountsAdminRepo = new DrizzleAccountsAdminRepo(dbHandle, creditPlanOverridesRepo);
  const adminBillingRepo = new DrizzleAdminBillingRepo(dbHandle);
  const rateLimitOverridesRepo = new DrizzleRateLimitOverridesRepo(dbHandle);
  const legalRepo = new DrizzleLegalRepo(dbHandle);
  const emailPreferencesRepo = new DrizzleEmailPreferencesRepo(dbHandle);
  const accountAuditRepo = new DrizzleAccountAuditRepo(dbHandle);
  const validationSchedulesRepo = new DrizzleValidationSchedulesRepo(dbHandle);
  const accountLifecycleRepo = new DrizzleAccountLifecycleRepo(dbHandle);
  const scheduledJobsRepo = new DrizzleScheduledJobsRepo(dbHandle);

  // Auth cache + coalescer.
  const authCache = new RedisAuthCache(redis, logger);
  const authCoalescer = new AuthCoalescer();
  // DoS hardening — per-instance short-TTL negative auth cache so a flood
  // of the SAME bogus bearer token skips the prefix-lookup + scrypt verify
  // after the first rejection.
  const negativeAuthCache = new InProcessNegativeAuthCache();

  // 2026-05-19 — staff-emails allowlist. Web-session auth bumps
  // these accounts with `driftstack_internal_admin` scope so the
  // dashboard user can hit /v1/admin/*. Parsed once at boot;
  // rotation requires a server restart. Set DRIFTSTACK_STAFF_EMAILS
  // to a comma-separated list (whitespace + case normalized).
  const staffEmailsRaw = process.env.DRIFTSTACK_STAFF_EMAILS;
  const staffEmails: ReadonlySet<string> = staffEmailsRaw
    ? new Set(
        staffEmailsRaw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0),
      )
    : new Set();
  if (staffEmails.size > 0) {
    logger.info(
      { component: 'auth', count: staffEmails.size },
      'staff-emails allowlist wired (account email match → admin scope on web session)',
    );
  }

  // 2026-06-04 — project OWNER (master) account. The owner is the single
  // top-tier account with full control of the high-power admin surfaces
  // (pricing, secrets, project config), gated by the `requireOwner` guard.
  // Named ONLY by DRIFTSTACK_OWNER_EMAIL, set per environment. There is no
  // default: a personal address in the source of a public repository is a
  // disclosure, and a new deployment silently bound to someone else's account
  // is worse than one with no owner. Unset → no account is the owner, the
  // owner-only routes refuse every caller, and boot says so once.
  // The owner is ALWAYS unioned into the staff set, so they receive
  // `driftstack_internal_admin` on web-session auth (full admin) without
  // needing to also be listed in DRIFTSTACK_STAFF_EMAILS. Set-once at boot.
  const ownerEmail: string | null =
    (process.env.DRIFTSTACK_OWNER_EMAIL ?? '').trim().toLowerCase() || null;
  const effectiveStaffEmails: ReadonlySet<string> =
    ownerEmail !== null ? new Set([...staffEmails, ownerEmail]) : staffEmails;
  if (ownerEmail !== null) {
    logger.info(
      { component: 'auth' },
      'project owner account wired (requireOwner gate + always-admin)',
    );
  } else {
    logger.warn(
      { component: 'auth', event: 'owner_email_unset' },
      'DRIFTSTACK_OWNER_EMAIL is not set: no account is the owner, so the owner-only admin routes refuse every caller',
    );
  }

  // Rate limit store.
  const rateLimitStore = new RedisRateLimitStore(redis);

  // Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus metrics
  // registry. Constructed eagerly so downstream services can
  // accept a reference at construction time (audit service /
  // AgentRuntime / etc.); the `/metrics` route registration is
  // gated on metricsScrapeToken being present (much later, in the
  // AppDeps assembly), so an unwired deployment never exposes the
  // registry endpoint. Counter registration lives here so every
  // service sees a fully-populated registry.
  const metricsRegistry =
    config.metricsScrapeToken !== undefined ? new MetricsRegistry() : undefined;
  if (metricsRegistry !== undefined) {
    metricsRegistry.registerCounter(
      METRIC_NAMES.pairModeTransitionTotal,
      'Pair-mode state-machine transitions, labelled by from + to states.',
      ['from', 'to'],
    );
    metricsRegistry.registerGauge(
      METRIC_NAMES.scheduledJobChainPending,
      'Liveness of each self-re-arming job chain: 1 when a pending row exists for that job_type, 0 when the chain is dead and will not run again without a restart.',
      ['job_type'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.unhandledRejectionTotal,
      'Unhandled promise rejections swallowed by the process backstop. The backstop keeps the control plane ALIVE rather than crashing, so a path that starts rejecting on every request is otherwise invisible — this is the only signal that it is happening.',
    );
    // Replays anything counted before the registry existed: the backstop is
    // installed before any async wiring so a rejection during bootstrap is
    // caught, which is earlier than this point.
    attachUnhandledRejectionMetric((delta) => {
      metricsRegistry.inc(METRIC_NAMES.unhandledRejectionTotal, undefined, delta);
    });
    metricsRegistry.registerCounter(
      METRIC_NAMES.retentionPurgeTotal,
      'Account-deletion retention purge outcomes by arm. `skipped` means the arm was not wired at all — the signal for a §9 erasure promise that has silently stopped running.',
      ['arm', 'outcome'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.bundledLlmRequestTotal,
      'Bundled-LLM decompose requests, labelled by outcome.',
      ['outcome'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.bundledLlmErrorTotal,
      'Bundled-LLM decompose errors, labelled by error kind.',
      ['kind'],
    );
    // Arc 7 obs.3 — agent decompose result-kind counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentDecomposeTotal,
      'Agent decompose() call counter, labelled by result kind (plan / clarify / refuse).',
      ['result_kind'],
    );
    // Arc 7 obs.4 — BYOK Anthropic /test outcome counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.byokAnthropicTestTotal,
      'BYOK Anthropic /test endpoint outcomes (ok / invalid / quota_exceeded / not_set / not_wired / unknown).',
      ['outcome'],
    );
    // Arc 7 obs.5 — rate-limit consume counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.rateLimitTotal,
      'Rate-limit consume counter, labelled by bucket + outcome (allowed | exceeded).',
      ['bucket', 'outcome'],
    );
    // DoS hardening — rate-limit primary-store (Redis) failure counter.
    // Non-zero = degraded to the bounded per-instance memory fallback.
    metricsRegistry.registerCounter(
      METRIC_NAMES.rateLimitStoreFallbackTotal,
      'Rate-limit primary-store failures that degraded to the in-process memory fallback, labelled by limiter (account | ip).',
      ['limiter'],
    );
    // Arc 7 obs.6 — auth resolution outcome counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.authTotal,
      'Auth resolution outcomes (ok / unauthorized / invalid / revoked / expired / forbidden / error).',
      ['outcome'],
    );
    // Arc 7 obs.7 — OAuth /token exchange outcome counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.oauthTokenTotal,
      'OAuth /token exchange outcomes (ok + OAuthError codes + error).',
      ['outcome'],
    );
    // Arc 7 obs.8 — Stripe webhook receiver outcome counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.stripeWebhookTotal,
      'Stripe webhook receiver outcomes (handled / duplicate / ignored / error / signature_invalid / signature_missing / empty_body / malformed_event).',
      ['outcome'],
    );
    // Arc 7 obs.9 — NOWPayments IPN receiver outcome counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.nowpaymentsWebhookTotal,
      'NOWPayments IPN receiver outcomes (ok / signature_missing / signature_invalid / empty_body / malformed_event).',
      ['outcome'],
    );
    // Arc 7 obs.10 — account audit log emission counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.accountAuditEmitTotal,
      'Customer-facing audit log emissions, labelled by action prefix + actor type.',
      ['prefix', 'actor_type', 'outcome'],
    );
    // Arc 7 obs.11 — admin audit log emission counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.adminAuditEmitTotal,
      'Admin audit log emissions, labelled by action prefix.',
      ['prefix', 'outcome'],
    );
    // Arc 7 obs.12 — LiveKit token mint outcome counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.livekitTokenMintTotal,
      'LiveKit token mint outcomes, labelled by role + outcome (ok / not_found / validation / forbidden / no_mac / secret_unreadable). Emitted by exactly one route, /v1/agent-sessions/:id/livekit-token, which hardcodes a subscriber token -- so role is always subscriber and no series has ever carried publisher or unknown. The legacy session-livekit surface that emitted role=publisher was deleted in 58a0a2521; a matcher on role=publisher selects nothing and would sit green forever.',
      ['role', 'outcome'],
    );
    // Arc 7 obs.13 — outbound email send outcome counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.emailSendTotal,
      'Outbound email sends, labelled by template + outcome (ok + classifyEmailError categories).',
      ['template', 'outcome'],
    );
    // Arc 7 obs.14 — outbound webhook delivery counters (attempt + terminal).
    metricsRegistry.registerCounter(
      METRIC_NAMES.webhookDeliveryAttemptTotal,
      'Outbound webhook delivery attempts, labelled by outcome (success / http_error / timeout / transport_error).',
      ['outcome'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.webhookDeliveryTerminalTotal,
      'Outbound webhook delivery terminal state transitions, labelled by terminal_state (delivered | dlq).',
      ['terminal_state'],
    );
    // Arc 7 obs.15 — foundational HTTP request counter.
    metricsRegistry.registerCounter(
      METRIC_NAMES.httpRequestTotal,
      'HTTP requests, labelled by method × route template × status_class (1xx/2xx/3xx/4xx/5xx).',
      ['method', 'route', 'status_class'],
    );
    // Arc 7 obs.16 — LK.2 Mac LiveKit credential registration outcomes.
    metricsRegistry.registerCounter(
      METRIC_NAMES.macNodeLivekitRegisterTotal,
      'POST /v1/mac-nodes/register outcomes (ok | validation | encryption_error | not_found | unknown).',
      ['outcome'],
    );
    // AI agent turns. All nine are emitted from services/agent-turn-telemetry.ts
    // and every label value is a member of a closed union declared there.
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentTurnTotal,
      'Requests to the agent message route by outcome (completed | failed | halted_for_confirmation | clarified | refused | stopped | busy_409 | conflict_409 | rate_limited | rejected | error | manual_note | replayed).',
      ['outcome'],
    );
    metricsRegistry.registerHistogram(
      METRIC_NAMES.agentTurnDurationSeconds,
      'Wall time of one agent message request, by outcome.',
      AGENT_TURN_DURATION_BUCKETS_SECONDS,
      ['outcome'],
    );
    metricsRegistry.registerHistogram(
      METRIC_NAMES.agentTurnPhaseDurationSeconds,
      'Time one agent turn spent in a phase (planning | starting_browser | executing | reading_page | answering), summed over repeats.',
      AGENT_TURN_DURATION_BUCKETS_SECONDS,
      ['phase'],
    );
    metricsRegistry.registerHistogram(
      METRIC_NAMES.agentTurnTimeToFirstProgressSeconds,
      'Seconds from an agent message request arriving to the first progress event of its turn, by transport (stream | json).',
      AGENT_TURN_FIRST_PROGRESS_BUCKETS_SECONDS,
      ['transport'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentTurnModelCallTotal,
      'Settled model calls by call_kind (plan | re_plan | answer | unattributed) and model.',
      ['call_kind', 'model'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentTurnTokensTotal,
      'Model tokens by token_type (input | output | cache_read | cache_write), call_kind and model.',
      ['token_type', 'call_kind', 'model'],
    );
    metricsRegistry.registerHistogram(
      METRIC_NAMES.agentTurnReplans,
      'Re-plan attempts in one agent turn, by outcome.',
      AGENT_TURN_REPLAN_BUCKETS,
      ['outcome'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentTurnStepFailureTotal,
      'Failed agent steps by death-reason class and step_kind (the intent kind, or none).',
      ['reason', 'step_kind'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentTurnTelemetryWriteTotal,
      'Per-turn diagnostics row writes by outcome (ok | error | dropped | shed). The write is fire-and-forget, so error or dropped here is the only place its failure shows; shed is the row budget for turned-away requests under a storm.',
      ['outcome'],
    );
    // Was a behaviour profile attached to the session that acted? Emitted from
    // recordAgentActionProfileAttached in services/agent-turn-telemetry.ts.
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentActionProfileAttachedTotal,
      'Dispatched agent actions by verb (click | send_keys), profile_attached (true | false | unreported) and outcome (ok | failed | unknown). One count per dispatched attempt, retries included. A CONFIGURATION fact, not a detectability verdict: the device reports whether a behaviour profile was resolved for the session, so true is necessary and not sufficient for the human-like path to have run, and false is a misconfiguration the step succeeding would otherwise hide. unreported is a step with no usable result and is never read as true.',
      ['verb', 'profile_attached', 'outcome'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentScrollPathTotal,
      'Dispatched agent scrolls by which of the device two implementations ran (flick | segmented | unreported) and outcome. Selected by the SAME predicate as profile_attached, so it is not an independent signal and no dashboard may present the two as corroborating; both paths are native touch sequences and segmented differs only in a flatter cadence. Reported, never alerted on.',
      ['path', 'outcome'],
    );
    // The look before a tap (agent-executor-control-plane.ts), emitted from
    // recordPreTapLook in services/agent-turn-telemetry.ts.
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentPreTapLookTotal,
      'Looks before an agent tap by outcome (clear | covered | not_found | outside_viewport | unverified | fallback), resolved_by (native | script | none | unanswered) and then (tapped | typed | refused | not_sent). covered and not_found are taps that were not sent; fallback is a tap sent without a verdict. Recorded for every look, whether or not the tap was later sent.',
      ['outcome', 'resolved_by', 'then'],
    );
    metricsRegistry.registerHistogram(
      METRIC_NAMES.agentLookToTapSeconds,
      "Seconds from the look's answer to the moment the executor hands the tap to the dispatcher, by verb (click | send_keys).",
      LOOK_TO_TAP_BUCKETS_SECONDS,
      ['verb'],
    );
    metricsRegistry.registerHistogram(
      METRIC_NAMES.agentPreTapLookDeviceSeconds,
      'Device-reported duration of the look before an agent tap, by outcome. Absent when the look timed out.',
      PRE_TAP_LOOK_DURATION_BUCKETS_SECONDS,
      ['outcome'],
    );
    metricsRegistry.registerHistogram(
      METRIC_NAMES.agentPreTapLookRoundTripSeconds,
      'What an agent turn waited for the look before a tap, by outcome: the per-tap latency cost of the look.',
      PRE_TAP_LOOK_DURATION_BUCKETS_SECONDS,
      ['outcome'],
    );
    // Keys stripped from accepted harness intent results, emitted from
    // services/harness-result-unknown-keys.ts. `intent` is the closed intent
    // enum; the key NAMES are unbounded device text and live in the log line.
    metricsRegistry.registerCounter(
      METRIC_NAMES.harnessIntentResultUnknownKeyTotal,
      'Keys on accepted harness intent results that this build does not model, by intent. They were stripped before the executor saw the result, and the result was accepted. Non-zero means the device ships a field this build ignores; the intent_result_unknown_keys log line names it.',
      ['intent'],
    );
    // The device's own check at the real tap point, emitted from
    // recordTapUnoccludedCheck in services/agent-turn-telemetry.ts.
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentTapUnoccludedCheckTotal,
      'Agent taps sent with the device check at the real tap point, by verb (click | send_keys, whose check is on the tap that focuses the field), why (outside_viewport | consequential) and result (tapped, checked, no_tap, unconfirmed, a refusal reason, unrecognised_reason, failed_otherwise, no_answer). A refusal is a tap that was not made; occlusion_check_unavailable is the fail-closed rate; no_tap is typing with no tap to verify, not a pass.',
      ['verb', 'why', 'result'],
    );
    // The commitment arm of the consequential gate (services/agent-page-
    // commitment.ts), emitted from recordCommitmentFacts and
    // recordConsequentialHalt in services/agent-turn-telemetry.ts.
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentCommitmentFactsTotal,
      'What the commitment arm had to judge on, once per step it judged, by outcome (refreshed | unavailable | budget_spent | stale_used). unavailable means no facts at all, so the gate was the caption matcher alone — alert on it. budget_spent and stale_used both mean the last facts were used, which can only add halts; refreshed against those two is the cost of the extra page read.',
      ['outcome'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.agentConsequentialHaltTotal,
      'Agent steps halted for the customer to approve, by the arm that raised the halt: caption (the English phrases), structure (the page markup says the control submits a form that commits value) or declared (the planner said this step commits). Without the split a safety number cannot tell the gate stopping an action from the planner not attempting one.',
      ['arm'],
    );
  }

  // Arc 7 obs.13 — construct the email service after the metrics
  // registry so send() emits the email_send_total counter when
  // wired. No-op service when Postmark is unconfigured.
  //
  // 2026-07-01 security fix — accountEmailDeliveryTracker + sentry wire
  // up the 3 security-critical templates' retry/failure-tracking/
  // alerting (see services/email.ts). Both optional; email.ts is fully
  // backward-compatible without them (the feature was built additive).
  const email: EmailService = createEmailService({
    config: config.postmark,
    logger,
    ...(metricsRegistry !== undefined ? { metrics: metricsRegistry } : {}),
    accountEmailDeliveryTracker: createDrizzleAccountEmailDeliveryTracker(dbHandle),
    sentry,
  });

  // Driver — mock or real WebKit per config. The Playwright dev
  // driver is dynamically imported, so this is async.
  const driver = await createDriver(config);

  // 2026-05-20 — GUI panel notification bus. Constructed early so
  // emit-on-event services (audit, cost-alert) can publish via it
  // without an ordering dance. No deps; safe to construct before
  // anything else that needs a publisher.
  const notificationEventBus = new NotificationEventBus();

  // V-216 — customer-facing audit log; constructed early so all
  // emit-on-event services downstream (webhooks, sessions, api-keys,
  // profiles) can wire it.
  // 2026-05-20 — also takes the notificationEventBus so high-severity
  // actions (api_key.revoked, byok_anthropic.key_set, etc.) republish
  // to the panel notification stream alongside the durable audit row.
  const accountAuditService = new AccountAuditService(
    accountAuditRepo,
    metricsRegistry,
    notificationEventBus,
  );

  // V-204 — email notification preferences. Constructed early because
  // V-202c lifecycle service consumes it for opt-out checks.
  const emailPreferencesService = new EmailPreferencesService(emailPreferencesRepo);

  // V-202c / V-202b — account lifecycle dispatcher (paired audit emit +
  // email send for events that have both surfaces). Wires
  // `session.failed.first`, `subscription.tier_changed`. V-202b moved the V-226
  // tier-change audit emit from StripeWebhooksService into
  // lifecycle.handleTierChanged so the audit + email pair lives behind
  // one call (founder verdict 2026-05-05).
  const accountLifecycleService = new AccountLifecycleService(
    accountLifecycleRepo,
    email,
    emailPreferencesService,
    logger,
    {
      // V-057.E — both URLs derive from config so dev / staging /
      // production all get the right host without per-env literals
      // here. Same single-source-of-truth as the auth-flow URLs
      // (V-079.B): set DASHBOARD_ORIGIN once per env.
      docsBaseUrl: 'https://driftstack.io/docs',
      billingPortalUrl: config.stripe?.portalReturnUrl ?? `${config.dashboardOrigin}/billing`,
      dashboardUrl: config.dashboardOrigin,
    },
    accountAuditService, // V-202b — required for tier_changed audit emit
  );

  // V-202d — generic scheduled-jobs dispatcher. The trial_pack.expired
  // handler was removed 2026-05-27 with the trial_pack retirement; the
  // dispatcher remains for the other registered cron-shaped jobs
  // (auth_tokens.sweep, cost.recompute_nightly) via `register(...)`.
  // workerId composition. SELECT FOR UPDATE SKIP LOCKED is what guarantees
  // mutual exclusion at CLAIM time, and that part never depended on the
  // workerId. But V-747 made the workerId load-bearing for the settle fence
  // (`locked_by = workerId`), and it must therefore be unique per PROCESS:
  //   - the old `pid-<pid>` alone collides across replicas, because a
  //     containerised app is usually PID 1 — two replicas would both be
  //     `pid-1`, so one's stale write would satisfy the other's fence;
  //   - it was also STABLE across restarts for the same reason, and the
  //     comment here claimed a `@<host>` component the code never had.
  // hostname identifies the replica (the container id, in practice) and the
  // random suffix guarantees a restarted process gets a NEW id — which is
  // required, or a restarted worker could not reclaim its own orphaned rows.
  const scheduledJobsService = new ScheduledJobsService(scheduledJobsRepo, logger, {
    workerId: `pid-${process.pid.toString()}@${hostname()}-${randomUUID().slice(0, 8)}`,
  });

  // Monthly AI credits, granted from paid coverage. NULL WHILE
  // DRIFTSTACK_AI_CREDITS_MODE IS OFF (the default), and everything that would
  // run a grant hangs off this one value: the three billing callers below take
  // it as they would take null, and the credit jobs are registered only inside
  // `if (creditGrants !== null)`. So with the mode off nothing new runs at all.
  const creditGrants = creditGrantsRun(config.aiCreditsMode)
    ? new CreditGrantsService({
        ledger: new DrizzleCreditLedgerRepo(dbHandle),
        windows: new DrizzleCreditWindowsRepo(dbHandle),
        scheduledJobs: scheduledJobsService,
        logger,
      })
    : null;
  // S17 — refunds and disputes take credits back through the same repos; null
  // whenever grants are, so a deployment with AI credits off has neither.
  const creditClawbacks =
    creditGrants !== null
      ? new CreditClawbacksService({
          ledger: new DrizzleCreditLedgerRepo(dbHandle),
          windows: new DrizzleCreditWindowsRepo(dbHandle),
          grants: creditGrants,
          logger,
          sentry,
        })
      : null;

  // AI credits, the spending half (slices S7-S9). NULL WHILE THE MODE IS OFF,
  // on the same value as the grants above: with it off nothing sets credits
  // aside, no lease keeper ticks, and no boot pass runs a single query.
  //
  // ⛔ THE SERVICE AND THE KEEPER ARE ONE UNIT and neither may exist without the
  // other. The service is what puts credit beyond reach — an open reservation
  // holds one of the account's three slots and the credit backing it — and the
  // keeper is the ONLY thing that gives either back when the process running
  // the task goes away, which §5.3 calls the main path. Built alone, the
  // service would hold credit no code path could release; built alone, the
  // keeper would have nothing to keep. Two guards (`tick-services-are-wired-
  // invariant`, `every-service-is-wired-or-recorded-as-dormant`) recorded the
  // service as deliberately dormant until exactly this line existed.
  //
  // The boot id is the lease owner: this process owns the leases it takes and
  // no others, which is what lets any number of processes share the database
  // (H6). It is minted per boot, so a restart never inherits its own old
  // leases — those lapse and are settled from what each task recorded.
  const creditLeaseOwner = `boot-${randomUUID()}`;
  const creditLedgerRepo = creditGrants === null ? null : new DrizzleCreditLedgerRepo(dbHandle);
  // S13 — a second, independent read of `credit_windows` for the old
  // bundled-llm routes' moved-account shape (`AiCreditsRuntime.windows`,
  // §8.6). Gated on the same `creditGrants === null` check as every other
  // credits-mode-off local, so it is null exactly when `aiCredits` will be.
  const creditWindowsRepo = creditGrants === null ? null : new DrizzleCreditWindowsRepo(dbHandle);
  const creditReservationsRepo = creditGrants === null ? null : new DrizzleCreditReservationsRepo();
  // S14 — hoisted so `creditReservationsService` below and `aiCredits.stateReads`
  // share the SAME instance rather than each constructing their own (the repo
  // is stateless, so two instances would behave identically, but one is the
  // fewer thing to keep in sync).
  const creditRateCardRepo = creditGrants === null ? null : new DrizzleCreditRateCardRepo(dbHandle);
  // S16 — the `accounts`-table half of the cutover/rollback (tier, status,
  // legacy consent+cap, whether a key is stored, the C0 cohort listing).
  // Same guard as every other credits-mode-off local above.
  const creditCutoverRepo = creditGrants === null ? null : new DrizzleCreditCutoverRepo(dbHandle);
  // S11 — the two counters §8's shadow exit criteria are read from. Registered
  // ONLY when the mode is shadow or enforce, on the same value everything else
  // credits-related hangs off: a deployment running `off` must not render a
  // series that names a feature it is not running.
  //
  // ⛔ NOTHING COUNTS UNTIL THESE ARE PASSED. `CreditReservationsService` takes
  // both as dependencies precisely so that the slices that built it could ship
  // dark without adding a metric to the catalogue; until this line existed a
  // swallowed shadow reservation and a call that passed its bound were both
  // invisible, and "0 lost" — the criterion that lets the mode move to enforce —
  // was unreachable rather than met.
  if (metricsRegistry !== undefined && creditGrants !== null) {
    metricsRegistry.registerCounter(
      METRIC_NAMES.aiCreditsShadowLostTotal,
      'AI-credit measurements that were swallowed, by the leg they were lost on: reserve, call or turn. A shadow exit criterion — any non-zero value means the shadow numbers undercount what the turns really did.',
      ['leg'],
    );
    metricsRegistry.registerCounter(
      METRIC_NAMES.aiCreditsBoundExceededTotal,
      'Settled model calls whose measured cost passed the upper bound they were admitted under, by settle basis. The bound is meant to be an upper bound, never an estimate, so any non-zero value is an arithmetic defect rather than a busy period.',
      ['settle_basis'],
    );
  }
  const creditCounters = aiCreditsCounters(metricsRegistry);
  const creditReservationsService =
    creditGrants === null ||
    creditLedgerRepo === null ||
    creditReservationsRepo === null ||
    creditRateCardRepo === null
      ? null
      : new CreditReservationsService({
          ledger: creditLedgerRepo,
          reservations: creditReservationsRepo,
          rateCards: creditRateCardRepo,
          refresher: creditGrants,
          logger,
          sentry,
          // The §4.4 reserve is the one leg the service loses on its own; the
          // per-attempt legs are the meter's and are counted there.
          onShadowLost: () => {
            creditCounters.onShadowLost('reserve');
          },
          onBoundExceeded: creditCounters.onBoundExceeded,
        });
  const creditLeaseKeeper =
    creditLedgerRepo === null ||
    creditReservationsRepo === null ||
    creditReservationsService === null
      ? null
      : new AiCreditLeaseKeeper({
          ledger: creditLedgerRepo,
          reservations: creditReservationsRepo,
          settler: creditReservationsService,
          executor: dbHandle.db,
          leaseOwner: creditLeaseOwner,
          logger,
        });
  // S11 — the three as ONE AppDeps member, so a route that has it has a
  // consistent runtime and cannot be handed a keeper built on a different boot
  // id than the reservations it is asked to renew. Undefined while the mode is
  // off, which is the production default and today's code exactly.
  const aiCredits: AiCreditsRuntime | undefined =
    creditReservationsService === null ||
    creditLeaseKeeper === null ||
    // S12 — always non-null alongside `creditReservationsService` (both are
    // guarded by the same `creditGrants === null` check above); named
    // explicitly so TypeScript narrows `creditLedgerRepo` for the `accounts`
    // member below instead of requiring a cast.
    creditLedgerRepo === null ||
    // S13 — same guard, same reason, for `creditWindowsRepo` and `windows`.
    creditWindowsRepo === null ||
    config.aiCreditsMode === 'off'
      ? undefined
      : {
          mode: config.aiCreditsMode,
          bootId: creditLeaseOwner,
          reservations: creditReservationsService,
          leaseKeeper: creditLeaseKeeper,
          // The staff report's C0 cohort is the only one the database cannot
          // recognise on its own: "internal" is configuration, not a column.
          // `effectiveStaffEmails` is the same set the admin bump uses, so the
          // census counts exactly the accounts this deployment already treats
          // as its own.
          report: new DrizzleAiCreditsReportRepo(dbHandle, effectiveStaffEmails),
          // S12 — whether ONE account is moved (`billing_mode`) and its chosen
          // source (`ai_source`), read with no lock (§4.4: the tier/source read
          // takes none). The same ledger repo `reserve()` locks under its own
          // transaction; this is the unlocked read a route takes BEFORE it
          // decides which leg funds a turn.
          accounts: creditLedgerRepo,
          // S13 — the account's current credit window, the same no-lock way.
          windows: creditWindowsRepo,
          // S14 — the reads `GET /v1/account/me/ai`, its ledger page and
          // `GET /v1/ai/models` need beyond the above. `creditReservationsRepo`
          // and `creditRateCardRepo` are guaranteed non-null here: both are set
          // by the same `creditGrants === null` check this whole branch is
          // already inside. So are `creditPlanOverridesRepo` and
          // `creditGrants` itself (the S14 audit's `planOverride` and
          // `refreshCredits`), re-checked for TypeScript's narrowing only.
          stateReads:
            creditReservationsRepo === null ||
            creditRateCardRepo === null ||
            creditPlanOverridesRepo === null ||
            creditGrants === null
              ? undefined
              : {
                  heldMicro: creditLedgerRepo.heldMicro.bind(creditLedgerRepo),
                  latestDebtReason: creditLedgerRepo.latestDebtReason.bind(creditLedgerRepo),
                  monthlyLotForWindow: creditLedgerRepo.monthlyLotForWindow.bind(creditLedgerRepo),
                  liveExtraLots: creditLedgerRepo.liveExtraLots.bind(creditLedgerRepo),
                  ledgerPageWithBalance:
                    creditLedgerRepo.ledgerPageWithBalance.bind(creditLedgerRepo),
                  chargedForSessionMicro:
                    creditLedgerRepo.chargedForSessionMicro.bind(creditLedgerRepo),
                  pendingClaimTotalMicro:
                    creditWindowsRepo.pendingClaimTotalMicroNoLock.bind(creditWindowsRepo),
                  // `DrizzleCreditReservationsRepo` is stateless and its method
                  // takes the executor explicitly (see `AiCreditsStateReads`'s
                  // doc comment) — closed over `dbHandle.db` here rather than
                  // bound, since there is no `this.database` to bind it to.
                  openEnforceCountNoLock: (accountId: string) =>
                    creditReservationsRepo.openEnforceCountNoLock(accountId, dbHandle.db),
                  cardInForce: creditRateCardRepo.cardInForce.bind(creditRateCardRepo),
                  nextAnnouncedCard: creditRateCardRepo.nextAnnouncedCard.bind(creditRateCardRepo),
                  modelRow: creditRateCardRepo.modelRow.bind(creditRateCardRepo),
                  // S14 audit #6 — `plan.monthly_included_credits` reads a live override.
                  planOverride: creditPlanOverridesRepo.get.bind(creditPlanOverridesRepo),
                  // S14 audit #5 — §6.4's lazy refresh before `GET /v1/account/me/ai`
                  // reads a moved account.
                  refreshCredits: creditGrants.refreshCredits.bind(creditGrants),
                },
          // S15 — the admin mutation surface `routes/admin-ai-credits.ts`
          // needs: ledger writes for a goodwill grant/debt forgiveness, the
          // plan-overrides repo, the rate-card writer, and `refreshCredits`
          // itself. `creditPlanOverridesRepo`, `creditRateCardRepo` and
          // `creditGrants` are each set by the same `creditGrantsRun`/
          // `creditGrants === null` condition this whole branch is already
          // inside; checked again here (as `stateReads` above already checks
          // two of its own) so TypeScript narrows each to non-null instead of
          // requiring a cast.
          admin:
            creditPlanOverridesRepo === null || creditRateCardRepo === null || creditGrants === null
              ? undefined
              : {
                  transaction: creditLedgerRepo.transaction.bind(creditLedgerRepo),
                  lockAccount: creditLedgerRepo.lockAccount.bind(creditLedgerRepo),
                  insertLot: creditLedgerRepo.insertLot.bind(creditLedgerRepo),
                  getLot: creditLedgerRepo.getLot.bind(creditLedgerRepo),
                  append: creditLedgerRepo.append.bind(creditLedgerRepo),
                  settleDebtFromFree: creditLedgerRepo.settleDebtFromFree.bind(creditLedgerRepo),
                  planOverrides: creditPlanOverridesRepo,
                  rateCards: creditRateCardRepo,
                  refreshCredits: creditGrants.refreshCredits.bind(creditGrants),
                },
          // S16 — the cutover/rollback surface `routes/admin-ai-credits.ts`'s
          // two new routes need. `creditCutoverRepo` is set by the same
          // `creditGrants === null` guard as every other local above;
          // re-checked here so TypeScript narrows it (and `creditGrants`)
          // instead of requiring a cast, same as `admin` just above.
          cutover:
            creditCutoverRepo === null || creditGrants === null
              ? undefined
              : new CreditCutoverService({
                  ledger: creditLedgerRepo,
                  cutoverRepo: creditCutoverRepo,
                  creditGrants,
                  pool: dbHandle.db,
                  // The C0 cohort's own predicate — see the census's identical
                  // comment on the same set (`report: new
                  // DrizzleAiCreditsReportRepo(dbHandle, effectiveStaffEmails)`
                  // just above): "internal" is configuration, not a column.
                  internalEmails: effectiveStaffEmails,
                }),
        };

  // Webhooks first so sessions + api-keys can wire it.
  // V-225 — accountAudit wired for webhook_endpoint.{created,deleted}.
  const webhooksService = new WebhooksService(webhooksRepo, accountAuditService);
  const webhooksAdminService = new WebhooksAdminService(webhooksRepo);

  // Sessions, api-keys, usage.
  const sessionsService = new SessionsService({
    repo: sessionsRepo,
    driver,
    webhooks: webhooksService,
    accountAudit: accountAuditService,
    accountLifecycle: accountLifecycleService,
    // 2026-05-20 — third NotificationEventBus publisher: session.errored
    // (cost-alert + audit.high_severity are the other two). The bus
    // was constructed earlier in bootstrap — see comment near
    // accountAuditService.
    notifications: notificationEventBus,
    // Billing-integrity hardening — loud-log a post-dispatch slot release
    // (a leaked concurrent-session slot is otherwise silent).
    logger,
  });
  const usageService = new UsageService(usageRepo);

  // Admin services.
  const adminAuditService = new AdminAuditService(adminAuditRepo, metricsRegistry);
  // accountsAdminService itself is constructed further below (after
  // apiKeysService / authFlowsService / webhooksService all exist — its
  // GDPR Article 17 deleteAccount() reclaim path depends on all three).
  const adminBillingService = new AdminBillingService(adminBillingRepo);
  const pricingService = new PricingService(new DrizzlePricingRepo(dbHandle), logger);
  // Secrets Phase A (migration 0074): owner platform-secret store, encrypted
  // under the shared MFA_ENCRYPTION_KEY (Q1-verdict reuse, same as BYOK/MFA).
  // Prefixless legacy values synchronously drain to name-bound v2 before the
  // live owner routes are composed. Key unset -> service constructs DISABLED
  // (list works; set/reveal throw).
  const platformSecretsRepo = new DrizzlePlatformSecretsRepo(dbHandle);
  if (config.mfaEncryptionKey !== undefined) {
    const MAX_PLATFORM_SECRET_VALUE_BOOT_MIGRATION_ROWS = 10_000;
    let scanned = 0;
    let converted = 0;
    let remaining = 0;
    do {
      const batch = await platformSecretsRepo.migrateValueEnvelopes(config.mfaEncryptionKey, 500);
      scanned += batch.scanned;
      converted += batch.converted;
      remaining = batch.remaining;
      if (remaining > 0 && (batch.scanned === 0 || batch.converted === 0)) {
        throw new Error(
          `Platform-secret value migration made no progress with ${remaining.toString()} legacy rows remaining.`,
        );
      }
      if (remaining > 0 && scanned >= MAX_PLATFORM_SECRET_VALUE_BOOT_MIGRATION_ROWS) {
        throw new Error(
          `Platform-secret value migration exceeded the ` +
            `${MAX_PLATFORM_SECRET_VALUE_BOOT_MIGRATION_ROWS.toString()}-row boot bound with ` +
            `${remaining.toString()} legacy rows remaining.`,
        );
      }
    } while (remaining > 0);
    if (scanned > 0) {
      logger.info(
        { component: 'platform-secret-value-encryption', scanned, converted, remaining },
        'legacy platform-secret values migrated to name-bound v2 before serving',
      );
    }
  }
  const platformSecretsService = new PlatformSecretsService(
    platformSecretsRepo,
    config.mfaEncryptionKey ?? null,
  );
  const rateLimitOverridesService = new RateLimitOverridesService(
    rateLimitOverridesRepo,
    authCache,
  );
  // V-295c3 — public status-page email subscribers service. Always
  // active; emails no-op when Postmark is unconfigured (createEmailService
  // returns a stub that swallows sends). The status-page base URL is the
  // origin the subscribe-confirmation + unsubscribe emails embed; falls
  // back to https://status.driftstack.io when env-unset.
  const statusPageBaseUrl = process.env.PUBLIC_STATUS_PAGE_URL ?? 'https://status.driftstack.io';
  const statusSubscribersRepo = new DrizzleStatusSubscribersRepo(dbHandle);
  const statusSubscribersService = new StatusSubscribersService(statusSubscribersRepo, email, {
    statusPageBaseUrl,
  });

  // V-298b/c — Team RBAC v1 service. Routes wired in app.ts. The auth
  // path DOES honor team membership: services/auth.ts loads memberships on
  // every authenticated path and resolveEffectiveAccount maps
  // X-Driftstack-Account to the owner account and the member's role.
  // Nothing is granted implicitly — absent that header a caller acts on
  // their own account.
  // V-057.E — sourced from `config.dashboardOrigin`, which is driven
  // by `DASHBOARD_ORIGIN` and prod-guarded against localhost. The
  // legacy `PUBLIC_DASHBOARD_URL` env var was redundant once
  // `DASHBOARD_ORIGIN` became the single source of truth and is no
  // longer read here.
  const dashboardBaseUrl = config.dashboardOrigin;
  const teamMembersRepo = new DrizzleTeamMembersRepo(dbHandle);
  const teamMembersService = new TeamMembersService(
    teamMembersRepo,
    email,
    { dashboardBaseUrl },
    accountAuditService,
    authCache,
    webhooksService,
    logger, // webhooks audit #5 — a lost api_key.revoked is logged, not swallowed
  );

  // V-295c3-followup — incident-notification fan-out. Wired into the
  // IncidentsService lifecycle below so admin-posted AND auto-created
  // public incidents both fan out emails to confirmed subscribers.
  // V-545.B Phase 2 — throttle repo passed so notifyUpdated enforces
  // the 1-per-subscriber-per-incident-per-hour cap on per-update
  // emails.
  const incidentUpdateNotificationsRepo = new DrizzleIncidentUpdateNotificationsRepo(dbHandle);
  const incidentNotifications = new IncidentNotificationsService(
    statusSubscribersService,
    email,
    logger,
    { statusPageBaseUrl },
    incidentUpdateNotificationsRepo,
  );

  // V-295d — outbound incident broadcasts (Slack incoming-webhook +
  // generic JSON envelope for Twitter/Discord/N8N relays). Both env
  // vars optional: when unset, that channel is silently skipped.
  const incidentBroadcast = new IncidentBroadcastService(
    {
      slackWebhookUrl: process.env.BROADCAST_SLACK_WEBHOOK_URL ?? null,
      genericWebhookUrl: process.env.BROADCAST_GENERIC_WEBHOOK_URL ?? null,
      statusPageBaseUrl,
    },
    logger,
  );

  // V-295e — incident event bus (in-process pub/sub for SSE clients).
  // SlaReportingService constructed below once probesRepo exists.
  const incidentEventBus = new IncidentEventBus();

  // V-295a — public-status incidents service. Lifecycle dispatches both
  // email fan-out AND outbound broadcasts in parallel; one failing
  // doesn't stall the other.
  // S45 2026-07-07 (founder-approved) — each public-incident lifecycle
  // hook ALSO publishes an `incident.broadcast` NotificationEvent to
  // the customer SSE bus (GET /v1/account/me/notifications), retiring
  // the kind's zero-publisher state. publishBroadcast fans the frame
  // out to every account with a live stream, stamped per-subscriber
  // with its own accountId; the emit is sync + best-effort (the bus
  // swallows handler throws) so it can never stall the email/webhook
  // fan-out.
  const publishIncidentNotification = (incident: IncidentRow): void => {
    notificationEventBus.publishBroadcast({
      kind: 'incident.broadcast',
      // Customer-facing incident id shape (`inc_<uuid>`) — same
      // prefixing the status routes + generic webhook envelope use.
      incidentId: `inc_${incident.id}`,
      severity: incident.severity,
      title: incident.title,
      at: new Date().toISOString(),
    });
  };
  const incidentsRepo = new DrizzleIncidentsRepo(dbHandle);
  const incidentsService = new IncidentsService(
    incidentsRepo,
    {
      onPublicCreated: async (incident, update) => {
        // V-295e — bus emit is sync + in-process; doesn't need awaiting.
        incidentEventBus.publishCreated(incident, update);
        publishIncidentNotification(incident);
        await Promise.all([
          incidentNotifications.notifyCreated(incident, update),
          incidentBroadcast.notifyCreated(incident, update),
        ]);
      },
      onPublicResolved: async (incident, update) => {
        incidentEventBus.publishResolved(incident, update);
        publishIncidentNotification(incident);
        await Promise.all([
          incidentNotifications.notifyResolved(incident, update),
          incidentBroadcast.notifyResolved(incident, update),
        ]);
      },
      // V-545.B Phase 2 — per-update fan-out. notifyUpdated enforces
      // the throttle internally so a long-running incident can't spam
      // subscribers. Broadcast surface unchanged (Slack/generic webhooks
      // don't have the per-recipient throttle semantics email does).
      // S45 — the SSE frame is NOT throttled: it's a live in-memory
      // stream (no inbox to spam), and the dashboard wants every update.
      onPublicUpdated: async (incident, update) => {
        publishIncidentNotification(incident);
        await incidentNotifications.notifyUpdated(incident, update);
      },
    },
    logger,
  );

  // V-295b — health-probe poller. The default probe target is this
  // server's own /health endpoint via env-configured PUBLIC_API_BASE_URL.
  // When unset, we skip probing — there's no useful target to probe from
  // inside the same process.
  //
  // ⛔ THIS COMMENT USED TO SAY "(Hetzner deploy sets this)". MEASURED 2026-09-17
  // ON PRODUCTION: it does not. PUBLIC_API_BASE_URL is absent from both
  // /opt/driftstack/api/.env and the running process environment, so
  // `healthProbeService` is null there and the poller has never run in
  // production — no probe row has ever been written, `GET /v1/status/sla`
  // returns `{"data":[]}`, and the auto-incident path below (which opens a
  // PUBLIC major incident after `failureThreshold` consecutive failures) has
  // never been able to fire. A comment asserting a deployment fact is not a
  // check on it, and this one had been false long enough that nothing noticed:
  // the only symptom is an empty list, which reads as healthy.
  //
  // Turning it on is a product decision, not a config typo, because the
  // consequence is customer-visible: it publishes major incidents to the public
  // status page. It is recorded for the owner rather than flipped here — the
  // same call that was made for the metrics layer, which is inert in prod for
  // exactly this shape of reason.
  const publicApiBaseUrl = process.env.PUBLIC_API_BASE_URL;
  const probesRepo = new DrizzleProbesRepo(dbHandle);
  // Declared OUTSIDE the conditional so the SLA report knows which targets this
  // deployment is configured to probe, and can say "configured but unmeasured"
  // instead of omitting them. When probing is off this is empty, and the report
  // is then honestly empty rather than misleadingly so.
  const healthProbeTargets = publicApiBaseUrl
    ? [
        {
          id: 'api',
          label: 'API server',
          url: `${publicApiBaseUrl.replace(/\/+$/, '')}/health`,
        },
      ]
    : [];
  const slaReportingService = new SlaReportingService(
    probesRepo,
    healthProbeTargets.map((t) => t.id),
  );
  const healthProbeService = publicApiBaseUrl
    ? new HealthProbeService(probesRepo, incidentsService, new FetchProber(), logger, {
        targets: healthProbeTargets,
      })
    : null;

  // V-295c2 — public status snapshot writer. Writes the same data the
  // public /v1/status/incidents endpoint surfaces to a SEPARATE
  // public-readable R2 bucket so the status site can fall back to the
  // snapshot when the live API fetch fails. The recordings bucket is
  // intentionally NOT used — recordings contain Customer Data and must
  // remain private. Active only when R2_BUCKET_PUBLIC is configured.
  const r2Public = config.r2 !== null ? createR2PublicClient(config.r2) : null;
  if (config.r2 !== null && r2Public === null) {
    logger.warn(
      { component: 'r2-public' },
      'R2_BUCKET_PUBLIC not set — status-snapshot writer disabled. ' +
        'Status page will fail open when API is unreachable. ' +
        'Set R2_BUCKET_PUBLIC + a public custom domain to enable V-295c2 fallback.',
    );
  }
  const statusSnapshotService = r2Public
    ? new StatusSnapshotService(incidentsService, r2Public, logger)
    : null;

  // Legal catalog — reads docs/legal/*.md from the runtime image.
  // V-051 Dockerfile copies these into the image at build time.
  const legalCatalog = buildLegalCatalog({ repoRoot: resolveRepoRoot() });
  const legalService = new LegalService(legalCatalog, legalRepo);

  // V-218 — continuous validation harness.
  // The recapture bridge is a stub until Agent 1's V-203 Phase 2A
  // vendor probes land. Until then, dispatched runs return synthetic
  // run ids and don't execute actual probe traffic. The schedule +
  // ledger logic is real; only the validation execution is mocked.
  const recaptureBridge: ValidationHarnessRecaptureBridge = {
    triggerRecapture: () => Promise.resolve({ id: `run_${randomUUID()}` }),
  };
  const validationHarnessService = new ValidationHarnessService(
    validationSchedulesRepo,
    recaptureBridge,
    { iosVersion: '18.7', safariVersion: '26.4' },
  );

  // ApiKeysService needs legalService (V-049 issuance gate).
  // V-216: also wires accountAuditService for customer-facing audit emit.
  const apiKeysService = new ApiKeysService(
    apiKeysRepo,
    authCache,
    webhooksService,
    legalService,
    accountAuditService,
    logger, // webhooks audit #5 — a lost api_key.revoked is logged, not swallowed
  );

  // V-353b — MFA service. Active only when MFA_ENCRYPTION_KEY is
  // configured (32 random bytes, base64-encoded). When unset, the
  // /v1/account/mfa/* routes simply don't register and customers
  // can't enroll. Generate the key with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  // and set as MFA_ENCRYPTION_KEY in deploy env.
  // LK.2 — construct the fleet repository before route composition so its
  // context-free legacy LiveKit envelopes can be drained to record-bound v2
  // before any token mint or publisher dispatch can read them.
  const drizzleFleetNodesRepo = new DrizzleFleetNodesRepo(dbHandle);
  if (config.mfaEncryptionKey !== undefined) {
    const MAX_LIVEKIT_SECRET_BOOT_MIGRATION_ROWS = 10_000;
    let scanned = 0;
    let converted = 0;
    let remaining = 0;
    do {
      const batch = await drizzleFleetNodesRepo.migrateLivekitSecretEnvelopes(
        config.mfaEncryptionKey,
        500,
      );
      scanned += batch.scanned;
      converted += batch.converted;
      remaining = batch.remaining;
      if (remaining > 0 && (batch.scanned === 0 || batch.converted === 0)) {
        throw new Error(
          `LiveKit API secret migration made no progress with ${remaining.toString()} legacy rows remaining.`,
        );
      }
      if (remaining > 0 && scanned >= MAX_LIVEKIT_SECRET_BOOT_MIGRATION_ROWS) {
        throw new Error(
          `LiveKit API secret migration exceeded the ${MAX_LIVEKIT_SECRET_BOOT_MIGRATION_ROWS.toString()}-row boot bound with ${remaining.toString()} legacy rows remaining.`,
        );
      }
    } while (remaining > 0);
    if (scanned > 0) {
      logger.info(
        { component: 'livekit-api-secret-encryption', scanned, converted, remaining },
        'legacy LiveKit API secrets migrated to node-bound v2 before serving',
      );
    }
  }
  const mfaRepo = new DrizzleMfaRepo(dbHandle);
  if (config.mfaEncryptionKey !== undefined) {
    const MAX_MFA_SECRET_BOOT_MIGRATION_ROWS = 10_000;
    let scanned = 0;
    let converted = 0;
    let remaining = 0;
    do {
      const batch = await mfaRepo.migrateTotpSecretEnvelopes(config.mfaEncryptionKey, 500);
      scanned += batch.scanned;
      converted += batch.converted;
      remaining = batch.remaining;
      if (remaining > 0 && (batch.scanned === 0 || batch.converted === 0)) {
        throw new Error(
          `MFA TOTP secret migration made no progress with ${remaining.toString()} legacy rows remaining.`,
        );
      }
      if (remaining > 0 && scanned >= MAX_MFA_SECRET_BOOT_MIGRATION_ROWS) {
        throw new Error(
          `MFA TOTP secret migration exceeded the ${MAX_MFA_SECRET_BOOT_MIGRATION_ROWS.toString()}-row boot bound with ${remaining.toString()} legacy rows remaining.`,
        );
      }
    } while (remaining > 0);
    if (scanned > 0) {
      logger.info(
        { component: 'mfa-totp-secret-encryption', scanned, converted, remaining },
        'legacy MFA TOTP secrets migrated to account-bound v2 before serving',
      );
    }
  }
  const mfaService = config.mfaEncryptionKey
    ? new MfaService(
        mfaRepo,
        { encryptionKey: config.mfaEncryptionKey },
        accountAuditService,
        authCache,
        email,
      )
    : null;
  if (!mfaService) {
    logger.warn(
      { component: 'mfa' },
      'MFA_ENCRYPTION_KEY not set — /v1/account/mfa/* routes disabled. ' +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" " +
        'and set in deploy env to enable customer MFA enrollment.',
    );
  }
  // AI-CHAT BYOK Anthropic — per-customer key storage. Activation-
  // gated on MFA_ENCRYPTION_KEY (same env var; Q1 verdict 2026-05-17
  // reuses the MFA key for operational simplicity). When absent, the
  // /v1/account/me/byok-anthropic-key* routes register their 503
  // disabled stubs via the activation-gate pattern.
  const byokAnthropicRepo = new DrizzleBYOKAnthropicRepo(dbHandle);
  if (config.mfaEncryptionKey !== undefined) {
    const MAX_BYOK_ANTHROPIC_BOOT_MIGRATION_ROWS = 10_000;
    let scanned = 0;
    let converted = 0;
    let remaining = 0;
    do {
      const batch = await byokAnthropicRepo.migrateCiphertextEnvelopes(
        config.mfaEncryptionKey,
        500,
      );
      scanned += batch.scanned;
      converted += batch.converted;
      remaining = batch.remaining;
      if (remaining > 0 && (batch.scanned === 0 || batch.converted === 0)) {
        throw new Error(
          `BYOK Anthropic key migration made no progress with ${remaining.toString()} legacy rows remaining.`,
        );
      }
      if (remaining > 0 && scanned >= MAX_BYOK_ANTHROPIC_BOOT_MIGRATION_ROWS) {
        throw new Error(
          `BYOK Anthropic key migration exceeded the ${MAX_BYOK_ANTHROPIC_BOOT_MIGRATION_ROWS.toString()}-row boot bound with ${remaining.toString()} legacy rows remaining.`,
        );
      }
    } while (remaining > 0);
    if (scanned > 0) {
      logger.info(
        { component: 'byok-anthropic-key-encryption', scanned, converted, remaining },
        'legacy BYOK Anthropic keys migrated to account-bound v2 before serving',
      );
    }
  }
  const byokAnthropicService = config.mfaEncryptionKey
    ? new BYOKAnthropicService(byokAnthropicRepo, {
        encryptionKey: config.mfaEncryptionKey,
        // v2-#32 — warn-log when the v2-#21 TTL gate fires so ops can
        // correlate stale-key fall-throughs with downstream 502
        // ByokAnthropicRequired responses. Stays in the warn band
        // (not error) — the customer can recover via header or by
        // re-uploading a fresh key on the dashboard.
        onKeyExpired: ({ accountId, ageMs, maxAgeMs }) => {
          logger.warn(
            {
              component: 'byok-anthropic',
              accountId,
              ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
              maxAgeDays: Math.floor(maxAgeMs / (24 * 60 * 60 * 1000)),
            },
            'BYOK Anthropic stored key expired by TTL; resolution chain falling through to header / fallback / 502',
          );
        },
      })
    : null;

  // Arc 1 sub-slice 6.3 (v2-#6) — bundled-LLM settings service.
  // Wired unconditionally (the route layer separately gates on
  // deploymentFallbackKey being set, so a deploy without the key
  // never resolves the bundled-LLM leg even if a customer has
  // consent=true).
  const bundledLlmService = new BundledLlmService(new DrizzleBundledLlmRepo(dbHandle));

  // EG-API-1.6 — SocksProxyBackend is pure config-to-env-var with
  // no external deps; instantiate eagerly so the route surface
  // activates from process start. The backend itself accepts
  // SOCKS5 + rejects OpenVPN/WireGuard with a typed error.
  //
  // V-823 — what "activates" buys today is the ACTIVE registrar's
  // request validation (schema + body/URL session_id match), and then a
  // 503: routes/session-proxy.ts takes this service and never calls it,
  // and applyToSession() has no caller anywhere. Wiring that edge is
  // planning-133 work, not a config change.
  const sessionEgressService = new SocksProxyBackend();

  // AI-B4 — recipes repo (write-only at v1.0). Backed by Postgres
  // via migration 0044. Now activates because Q.1 wires
  // agentSessionsRepo below.
  const recipesRepo = new DrizzleRecipesRepo(dbHandle, {
    ...(config.mfaEncryptionKey !== undefined
      ? { payloadEncryptionKeyBase64: config.mfaEncryptionKey }
      : {}),
  });
  if (config.mfaEncryptionKey !== undefined) {
    const MAX_RECIPE_PAYLOAD_BOOT_MIGRATION_ROWS = 10_000;
    let scanned = 0;
    let converted = 0;
    let remaining = 0;
    do {
      const batch = await recipesRepo.migratePayloadEnvelopes(500);
      scanned += batch.scanned;
      converted += batch.converted;
      remaining = batch.remaining;
      if (remaining > 0 && (batch.scanned === 0 || batch.converted === 0)) {
        throw new Error(
          `Recipe payload migration made no progress with ${remaining.toString()} legacy rows remaining.`,
        );
      }
      if (remaining > 0 && scanned >= MAX_RECIPE_PAYLOAD_BOOT_MIGRATION_ROWS) {
        throw new Error(
          `Recipe payload migration exceeded the ${MAX_RECIPE_PAYLOAD_BOOT_MIGRATION_ROWS.toString()}-row boot bound with ${remaining.toString()} legacy rows remaining.`,
        );
      }
    } while (remaining > 0);
    if (scanned > 0) {
      logger.info(
        { component: 'recipe-payload-encryption', scanned, converted, remaining },
        'legacy recipe payloads migrated to record-bound v2 before serving',
      );
    }
  } else {
    logger.warn(
      { component: 'recipe-payload-encryption' },
      'MFA_ENCRYPTION_KEY not set — encrypted recipes are unreadable and new recipe writes fail closed',
    );
  }

  // Q.1 AI-B1.b — agent-runtime composition. All 6 design questions
  // verdicted by orchestrator 2026-05-17; this wire implements:
  //
  //   Q.1.a — Keying: option 4. Claude wires when EITHER
  //           `BYOK_ANTHROPIC_FALLBACK_KEY` OR `byokAnthropicService`
  //           can resolve a key. Open-answer: explicit operator
  //           override env `DRIFTSTACK_AGENT_DECOMPOSER_FORCE=deterministic`
  //           forces the deterministic path regardless of key state
  //           (escape hatch for staging tests + prod incidents).
  //
  //   Q.1.b — Runtime fallthrough is wired in agent-runtime.ts; the
  //           bootstrap just picks the decomposer impl.
  //
  //   Q.1.d — Deployment-fallback is HARD 502 in prod (force BYOK
  //           per Tier-3 verdict 2026-05-16). Staging opt-in via
  //           `DRIFTSTACK_AGENT_DECOMPOSER_USE_FALLBACK=true`.
  //
  // The DeterministicAgentDecomposer remains the safe-default when
  // neither key path is available — agent-sessions routes still
  // return planned/clarified output rather than 503ing the customer.
  const agentSessionsRepo = new DrizzleAgentSessionsRepo(dbHandle, {
    ...(config.mfaEncryptionKey !== undefined
      ? { transcriptEncryptionKeyBase64: config.mfaEncryptionKey }
      : {}),
  });
  if (config.mfaEncryptionKey !== undefined) {
    const MAX_AGENT_TRANSCRIPT_BOOT_MIGRATION_ROWS = 10_000;
    let scanned = 0;
    let converted = 0;
    let remaining = 0;
    do {
      const batch = await agentSessionsRepo.migrateTranscriptEnvelopes(500);
      scanned += batch.scanned;
      converted += batch.converted;
      remaining = batch.remaining;
      if (remaining > 0 && (batch.scanned === 0 || batch.converted === 0)) {
        throw new Error(
          `Agent transcript migration made no progress with ${remaining.toString()} legacy rows remaining.`,
        );
      }
      if (remaining > 0 && scanned >= MAX_AGENT_TRANSCRIPT_BOOT_MIGRATION_ROWS) {
        throw new Error(
          `Agent transcript migration exceeded the ${MAX_AGENT_TRANSCRIPT_BOOT_MIGRATION_ROWS.toString()}-row boot bound with ${remaining.toString()} legacy rows remaining.`,
        );
      }
    } while (remaining > 0);
    if (scanned > 0) {
      logger.info(
        { component: 'agent-session-transcript-encryption', scanned, converted, remaining },
        'legacy agent-session transcripts migrated to record-bound v2 before serving',
      );
    }
  } else {
    logger.warn(
      { component: 'agent-session-transcript-encryption' },
      'MFA_ENCRYPTION_KEY not set — encrypted agent transcripts are unreadable and new writes fail closed',
    );
  }
  const agentTurnReceiptsRepo =
    config.mfaEncryptionKey === undefined
      ? undefined
      : new DrizzleAgentTurnReceiptsRepo(dbHandle, config.mfaEncryptionKey);
  // W2808 — forward holder for the fleet control registry, constructed later in
  // the fleet-control-plane deps block. Declared HERE (moved up from that block)
  // so the #139 go-live routing dispatcher can read it lazily. `current` is unset
  // until the registry is built; the dispatcher tolerates that (fails honestly).
  const fleetRegistryHolder: { current?: FleetControlRegistry } = {};
  // #139 go-live — AI-Browser-Automation execution path. When the fleet control
  // plane is enabled, run each decomposed plan over the REAL fleet dispatch:
  // ControlPlaneAgentExecutor → FleetSessionRoutingDispatcher routes every intent
  // to the box the session was dispatched to (agent_sessions.node_id → the node's
  // IntentDispatchCorrelator) → the harness IntentExecutor runs it for real. When
  // no box is connected it fails HONESTLY (session_error), never a fake success —
  // replacing the StubAgentExecutor's synthetic per-intent successes (the founder-
  // reported "returns a response without completing steps one by one" / "mock").
  // Without the flag (local/test/pre-fleet), the stub stays — preserving the
  // pre-launch demo path + every existing decompose→execute test.
  //
  // ⛔ THE CONFIRMATION GATE IS NOT THE SAME ON BOTH SIDES OF THE SWAP, and this
  // comment used to say it was. Both executors call the same `consequentialHalt`
  // and so both apply the CAPTION arm, which is all there was when that was
  // written. The other two arms need things only this executor has: the page's
  // structural facts (it reads the page before a step that could submit a form)
  // and the turn's commitment budget (the runtime threads one only here). The
  // stub reads no pages and is threaded no budget, so it halts on the fourteen
  // English phrases and nothing else. That is the right posture — the stub
  // dispatches nothing to a real device — but it is a NARROWER gate, not the
  // same one, and a reader who believed otherwise would be measuring the wrong
  // executor.
  // #7 — per-agent-session screenshot capture store: the control-plane executor
  // stashes a screenshot's bytes here + mints a captureId; GET /v1/agent-sessions/
  // :id/captures/:id serves them. Constructed here so the SAME instance is shared
  // with the executor (writer) and the agent-sessions route (reader) below.
  const sessionCaptureStore = new SessionCaptureStore();
  const agentExecutor: AgentExecutor = config.fleetControlPlaneEnabled
    ? new ControlPlaneAgentExecutor(
        new FleetSessionRoutingDispatcher(
          () => fleetRegistryHolder.current,
          agentSessionsRepo,
          logger,
        ),
        undefined,
        // The look before a tap counts its cost and outcome here when a
        // registry exists; without one it runs uncounted.
        metricsRegistry !== undefined ? { metrics: metricsRegistry } : {},
        sessionCaptureStore,
      )
    : new StubAgentExecutor();
  const agentDecomposer = selectAgentDecomposer(config, logger);
  const agentDecomposerKind: 'claude' | 'deterministic' =
    agentDecomposer instanceof ClaudeAgentDecomposer ? 'claude' : 'deterministic';
  // v2-#4 Q.1.e — record one usage_records row per decompose() call.
  // Wired unconditionally; even the deterministic decomposer fires
  // it (with zero costs) so the audit trail is uniform.
  // v2-#5 Q.1.f — same recorder also emits the operator-only
  // `agent.decompose.{claude,deterministic}` audit event per turn.
  const agentDecomposerUsageRecorder = new DrizzleAgentDecomposerUsageRecorder(
    dbHandle,
    logger,
    accountAuditService,
  );
  // Per-request AI telemetry. Constructed unconditionally — the diagnostics
  // rows and the admin summary must work on a deployment with no metrics
  // scraper, which is what production is today — and the metrics half switches
  // on by itself when the registry exists.
  const agentTurnTelemetryRepo = new DrizzleAgentTurnTelemetryRepo(dbHandle);
  // Where the health watchdog's fourth condition reads its numbers. The SAME
  // instance is handed to the telemetry service (which fills it at the end of
  // each turn, from the counts its `agent_turn_action_paths` line carries) and
  // to the watchdog (which reads it a tick later) — one source, so the alert and
  // the log line can never disagree. In-process on purpose: see
  // AGENT_TURN_HEALTH_CONDITIONS for what that costs and why a column would be
  // a migration.
  const profileAttachmentWindow = new InProcessProfileAttachmentWindow();
  const agentTurnTelemetry = new AgentTurnTelemetry({
    writer: agentTurnTelemetryRepo,
    logger,
    profileAttachmentWindow,
    ...(metricsRegistry !== undefined ? { metrics: metricsRegistry } : {}),
  });
  const agentTurnSummaryService = new AgentTurnSummaryService({ repo: agentTurnTelemetryRepo });
  // Arc 2 sub-slice 8.3 (v2-#8) — in-process transcript event bus.
  // Single-replica today; future redis-backed swap drops in here.
  const agentSessionEventBus = new AgentSessionEventBus();
  // Arc 2 sub-slice 8.8 (v2-#8) — pair-mode takeover lock backed by
  // the existing Redis client. SET NX EX semantics; per-session
  // contention shards on the session id so per-account locking
  // never blocks unrelated sessions. ioredis' .set overloads use
  // positional flag arguments (`EX <ttl> NX`); narrow the seam here.
  const pairModeLock = new RedisPairModeTakeoverLock({
    set: (key, value, _nx, _ex, ttl) => redis.set(key, value, 'EX', ttl, 'NX'),
    get: (key) => redis.get(key),
    del: (key) => redis.del(key),
    // Arc 4 Wave 2.B sub-slice 8.20.j (v2-#8) — atomic CAS-DEL on
    // release via Lua script. ioredis.eval signature is (script,
    // numKeys, ...args); the adapter shape matches our
    // RedisLikeClient.eval contract.
    eval: (script, numKeys, ...args) =>
      redis.eval(script, numKeys, ...args) as Promise<string | number | null>,
  });
  // Arc 4 Wave 2.B sub-slice 8.13d (v2-#8) — heartbeat tracker +
  // sweep wire. In-memory tracker (single-replica today); the sweep
  // walks stale sessions every 5s + fires the heartbeat-timeout
  // state-machine transition + agent_session.pair_mode.timeout
  // audit emit. Routes call tracker.recordHeartbeat on takeover /
  // handback / message so customer activity counts as a heartbeat.
  const pairModeHeartbeatTracker = new InMemoryPairModeHeartbeatTracker();
  // V-785 — seed the tracker from the database so a restart does not strand a
  // parked pair-mode session forever.
  //
  // `pair_mode_state` is persisted; the tracker that clears it is the Map above,
  // rebuilt empty on every boot. The 5s sweep only walks what the tracker knows,
  // so after a restart a session parked in `takeover-pending` is invisible to it
  // and the revert `docs/api/agent-sessions.md` promises — "returns to
  // `ai-driving` after 30s without a client heartbeat" — never fires. The session
  // cannot rescue itself either: the input-event route 409s on every parked state
  // BEFORE it reaches `recordHeartbeat`, and per V-757 nothing emits
  // `takeover-grant`, so the only remaining exit is the orphan reaper closing the
  // session outright. Recovery becomes eventual death.
  //
  // Seeding at boot time gives every parked session the ordinary 30s grace: a
  // client still there sends an input event and re-heartbeats normally, and one
  // that is gone times out 30 seconds from now instead of never. Failure is
  // logged and swallowed — a seed that cannot read the database must not stop the
  // server from starting, and the next restart tries again.
  try {
    const parked = await agentSessionsRepo.listActivePairModeSessionIds();
    const seededAt = new Date();
    for (const sessionId of parked) {
      pairModeHeartbeatTracker.recordHeartbeat({ sessionId, at: seededAt });
    }
    if (parked.length > 0) {
      logger.info(
        { component: 'pair-mode-heartbeat-seed', seeded: parked.length },
        'seeded the pair-mode heartbeat tracker from parked sessions — each gets the ordinary grace window before auto-revert',
      );
    }
  } catch (err) {
    logger.warn(
      {
        component: 'pair-mode-heartbeat-seed',
        err:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
            : { value: err },
      },
      'could not seed the pair-mode heartbeat tracker — sessions parked before this boot will not auto-revert until a client sends input',
    );
  }
  // Arc 4 Wave 2.B sub-slice 8.18 — metrics registry is now constructed
  // earlier (before the audit service) so every downstream service can
  // accept it at construction time. See the construction block above.
  // W592 — task-refusal start-gate ACTIVATION path (file-06 guardrail #3).
  // The mechanism (W582) + run-loop wiring (W589) are in place; this is the
  // pure-DATA on-switch: set DRIFTSTACK_TASK_REFUSAL_PATTERNS to a JSON array
  // of { id, category, pattern, flags?, reason } (the policy authored by the
  // founder/AUP — Tier-3) and restart. Unset/blank intentionally leaves the
  // gate off. Once configured, production requires a complete valid list and
  // refuses boot rather than silently weakening policy; development/test keep
  // the loader's skip-and-warn authoring ergonomics.
  const refusalPatternsRaw = process.env.DRIFTSTACK_TASK_REFUSAL_PATTERNS;
  let refusalPatterns: readonly RefusalPattern[] = [];
  if (refusalPatternsRaw && refusalPatternsRaw.trim().length > 0) {
    const resolved = resolveTaskRefusalConfig(refusalPatternsRaw, config.nodeEnv);
    refusalPatterns = resolved.patterns;
    if (resolved.issue !== null && resolved.issue !== 'skipped_entries') {
      logger.warn(
        { component: 'agent-runtime', issue: resolved.issue },
        'DRIFTSTACK_TASK_REFUSAL_PATTERNS is configured but invalid — task-refusal gate stays OFF',
      );
    }
    if (resolved.skipped.length > 0) {
      logger.warn(
        { component: 'agent-runtime', skipped: resolved.skipped },
        'task-refusal: some pattern entries were skipped (malformed) — they will NOT fire',
      );
    }
    logger.info(
      { component: 'agent-runtime', active_patterns: refusalPatterns.length },
      refusalPatterns.length > 0
        ? 'task-refusal start-gate ACTIVE'
        : 'task-refusal start-gate configured but no valid patterns — gate is a no-op',
    );
  }

  const agentRuntime = new AgentRuntime({
    decomposer: agentDecomposer,
    executor: agentExecutor,
    sessions: agentSessionsRepo,
    // FALLBACK only — used when an agent session has NEITHER an attached
    // driftstack session NOR a bound profile, i.e. nothing has been launched yet
    // so there is no real device to name. The resolver below supersedes it in
    // every other case.
    archetype: 'iphone17_ios18_7_safari26_4',
    // P-15 follow-up (a) — plan against the device this session is really running
    // instead of the literal above. Two sources, in order of authority:
    //
    //   1. the ATTACHED driftstack session, when the caller supplied one — that
    //      row is what the box launched, so it is the ground truth;
    //   2. the BOUND PROFILE, which is what a session actually carries in the
    //      normal case (`driftstack_session_id` is an optional create-body field
    //      and everything the desktop app creates leaves it null). The dispatch
    //      computes the launch archetype from this profile, so reading it here
    //      reproduces the same answer without persisting a second copy that could
    //      drift.
    //
    // Both reads are ACCOUNT-SCOPED. `findSessionUnscoped` is pinned at zero
    // callers by the unscoped-finders sweep because it skips the account check,
    // and a device hint is nowhere near worth an IDOR-shaped escape hatch — so a
    // cross-account id resolves to null and the planner falls back to the
    // default. Both ids come off the agent-session row the turn already loaded,
    // never from request input.
    // `profilesRepo` is declared below this construction. That forward reference is
    // deliberate and safe: the closure is only ever called while serving a turn,
    // long after bootstrap has finished evaluating.
    resolveSessionArchetype: async ({ accountId, driftstackSessionId, profileId }) => {
      if (driftstackSessionId !== null) {
        const attached = await sessionsRepo.findSession(driftstackSessionId, accountId);
        if (attached !== null) return attached.archetype;
      }
      if (profileId !== null) {
        const profile = await profilesRepo.findById({ id: profileId, accountId });
        if (profile !== null) return profile.archetype;
      }
      return undefined;
    },
    maxConcurrentTurnsPerAccount: config.agentTurnMaxAccountInFlight,
    // S6 — the pace band every turn this process runs. `fast` (the default, and
    // what an unset DRIFTSTACK_AI_PACE parses to) is the policy inserting
    // nothing: the runtime builds no budget, the executor is threaded no
    // `pace`, and the dispatch path is what it is today. `medium` and `slow`
    // are the two arms of the offline experiment, not a customer setting.
    pace: config.aiPace,
    // Experiment switch (default OFF) — DRIFTSTACK_PLANNING_READ. `text` (the
    // default, and what an unset value parses to) is today's planning read,
    // byte for byte. See AgentRuntimeDeps.planningRead.
    planningRead: config.planningRead,
    // Observed on its way through: the usage recorder is the one seam that
    // sees EVERY settled model call of a turn (the turn result carries only the
    // plan's), so telemetry stands in front of it. The inner recorder is called
    // exactly as before.
    usageRecorder: agentTurnTelemetry.wrapUsageRecorder(agentDecomposerUsageRecorder),
    eventBus: agentSessionEventBus,
    ...(metricsRegistry !== undefined ? { metrics: metricsRegistry } : {}),
    // W589 — task-refusal audit logger (which rule fired → audit trail).
    logger,
    // W592 — the curated pattern list (founder/AUP via env). Empty ⇒ no-op.
    ...(refusalPatterns.length > 0 ? { refusalPatterns } : {}),
    // B2 — Stop across processes, on the same Redis client as the pair-mode
    // lock. One API process today, so every Stop is answered from memory; this
    // is what keeps a second process from answering "nothing is running" for a
    // turn that is running next door.
    turnStopChannel: new RedisAgentTurnStopChannel(agentTurnStopRedisAdapter(redis)),
  });
  // Q.1.c — per-session BYOK key cache. Pure in-memory; wired
  // unconditionally so the route can stash decrypted plaintexts
  // on session-create when byokAnthropicService is also wired.
  const byokKeyCache = new InMemoryByokKeyCache();
  // #128 — per-proxy exit-identity cache. Pure in-memory; wired unconditionally so
  // the pre-launch proxy probe can stash the observed exit identity for the dispatch
  // build to emit as exit_identity (box new-tab IP panel). A cold cache (restart) or
  // a probe that saw no identity simply omits the optional block.
  // #128 follow-up — Redis-backed so a dispatch served by a DIFFERENT replica than
  // the one that probed, or one that follows a restart, still emits exit_identity.
  // A single miss blanks the new-tab panel for the session's WHOLE life, because the
  // identity is baked into the box fork's environment once at launch.
  // TTL passed explicitly, not defaulted: an optional dep the production graph
  // never supplies is a feature that exists only in tests.
  const exitIdentityCache = new RedisExitIdentityStore(redis, { ttlMs: EXIT_IDENTITY_TTL_MS });

  // V-079: user-facing auth flows.
  const authFlowsRepo = new DrizzleAuthFlowsRepo(dbHandle);
  // V-353d — Redis-backed challenge-token store for the MFA login
  // hand-off. Always wired (lightweight); gated by MFA being
  // enrolled per-account in login(). Five-minute TTL; single-use.
  const mfaChallengeStore = new RedisMfaChallengeStore(redis);
  const authFlowsService = new AuthFlowsService(
    authFlowsRepo,
    email,
    logger,
    {
      verifyEmailUrl: config.authFlowUrls.verifyEmail,
      magicLinkUrl: config.authFlowUrls.magicLink,
      passwordResetUrl: config.authFlowUrls.passwordReset,
      exposeDebugToken: config.authFlowUrls.exposeDebugToken,
    },
    authCache, // V-168 — cache invalidation on logout
    accountAuditService, // V-224 — emit account.{email_verified,login,logout,password_changed}
    mfaService, // V-353d — branch login() on enrollment status
    mfaChallengeStore, // V-353d — short-lived challenge store
    emailPreferencesService, // C9 — honor the 'signup-welcome' opt-out
    webhooksService, // api_key.revoked for each desktop credential a password reset revokes
  );

  // accountsAdminService — constructed here (not up near adminAuditService)
  // because its GDPR Article 17 deleteAccount() reclaim path depends on
  // apiKeysService / authFlowsService / webhooksService, all of which are
  // defined by this point. suspend()/unsuspend() only ever needed
  // sessionsService, which was available earlier, but delete() extends the
  // reclaim to web sessions + API keys + webhooks too.
  // V-758 — hoisted above accountsAdminService. BillingService is constructed much later
  // and only inside the Stripe-configured branch, but the suspension lifecycle needs to
  // reach it, so the declaration must precede the closure that captures it. The adapter
  // below resolves lazily at request time, which is also the honest shape: billing may
  // never be configured on a given deployment.
  let billingService: BillingService | undefined;

  const accountsAdminService = new AccountsAdminService(
    accountsAdminRepo,
    authCache,
    sessionsService,
    authFlowsService,
    apiKeysService,
    webhooksService,
    // Every reclaim step in suspend/deleteAccount is best-effort by design, so
    // a GDPR termination returns success whether or not each surface was
    // actually reclaimed. Without this the failure is written down nowhere.
    logger,
    // V-758 — AUP §5.2 promises suspension pauses billing. Resolved lazily because
    // BillingService is built later and only when Stripe is configured; when it is not,
    // pauseCollectionForAccount reports no_subscription and suspension behaves as before.
    {
      pauseCollectionForAccount: async (accountId: string) =>
        billingService === undefined
          ? ('no_subscription' as const)
          : billingService.pauseCollectionForAccount(accountId),
      resumeCollectionForAccount: async (accountId: string) =>
        billingService === undefined
          ? ('no_subscription' as const)
          : billingService.resumeCollectionForAccount(accountId),
      // Live-billing audit #1 — terminating an account cancels whatever still
      // collects. With Stripe unconfigured there is no subscription to cancel.
      cancelCollectionForAccount: async (accountId: string) =>
        billingService === undefined
          ? { cancelled: [] }
          : billingService.cancelCollectionForAccount(accountId),
      // Live-billing audit #6 — an admin tier change is refused while the account
      // still pays. Without Stripe only crypto terms can be live.
      liveBillingForAccount: async (accountId: string) =>
        billingService === undefined
          ? {
              collectingSubscriptions: [],
              cryptoTerms: await new DrizzleBillingRepo(dbHandle).findRunningCryptoTerms(accountId),
            }
          : billingService.liveBillingForAccount(accountId),
    },
    // Null while AI credits are off; then a tier change does exactly what it did.
    creditGrants,
    // Live-billing audit #1 — tells staff a terminated account's subscription was
    // cancelled (refund owed under ToS 14.5?) or could not be.
    sentry,
  );

  // 2026-05-20 — auth-tokens sweeper. Periodic DELETE of stale rows
  // across email_verify_tokens / magic_link_tokens / password_reset_
  // tokens. Closes the audit follow-up from docs/internal/2026-05-20-
  // stale-row-audit.md (consumeAuthToken sets consumed_at but never
  // deletes; same shape of bug as the 2026-05-19 scheduled_jobs
  // accumulation incident, pre-scale today). Daily 03:00 UTC cadence;
  // re-arms itself after each successful run. See docs/runbooks/auth-
  // token-sweeper.md.
  const authTokensSweeper = new AuthTokensSweeperService({ repo: authFlowsRepo });
  registerAuthTokensSweepJob({
    scheduledJobs: scheduledJobsService,
    sweeper: authTokensSweeper,
    logger,
  });
  await enqueueNextAuthTokensSweep({ scheduledJobs: scheduledJobsService });

  // V-620 — provider-state retention. Authorization handles/codes and OAuth
  // token rows are filtered on every read, but without active deletion those
  // digest-only rows still grow forever. Hourly cleanup uses the exact existing
  // 5-minute / 1-hour validity boundaries. Backing api_keys actor rows remain
  // retained for session/audit foreign-key integrity and are expiry-inert.
  const oauthRetentionSweeper = new OAuthRetentionSweeperService(oauthStore);
  registerOAuthRetentionSweepJob({
    scheduledJobs: scheduledJobsService,
    sweeper: oauthRetentionSweeper,
    logger,
  });
  await enqueueNextOAuthRetentionSweep({ scheduledJobs: scheduledJobsService });

  // 6.g — free-tier session-duration auto-destroy sweep. The free tier caps
  // a single session at MAX_SESSION_MINUTES_PER_TIER.free (20 min); a free
  // session pins an expensive fleet slot, so the cap is enforced by an
  // ACTIVE background sweep (not lazy-on-access). Every 2 min the sweeper
  // finds active sessions past their tier's cutoff (paid = null = never)
  // and auto-destroys them via sessionsService.autoDestroyExpired. Re-arms
  // itself; idempotent via the V-202d dedup-on-account-and-type flag
  // (job_type 'sessions.duration_sweep', account_id NULL).
  const sessionDurationSweeper = new SessionDurationSweeperService({
    repo: sessionsRepo,
    sessions: sessionsService,
    logger,
  });
  registerSessionDurationSweepJob({
    scheduledJobs: scheduledJobsService,
    sweeper: sessionDurationSweeper,
    logger,
  });
  await enqueueNextSessionDurationSweep({ scheduledJobs: scheduledJobsService });
  // W441 — scheduled_jobs retention prune (daily; deletes finished rows > 30d).
  registerScheduledJobsPruneJob({
    scheduledJobs: scheduledJobsService,
    repo: scheduledJobsRepo,
    logger,
  });
  await enqueueNextScheduledJobsPrune({ scheduledJobs: scheduledJobsService });
  // AI turn diagnostics retention (daily; deletes rows older than 90 days).
  registerAgentTurnTelemetryPruneJob({
    scheduledJobs: scheduledJobsService,
    repo: agentTurnTelemetryRepo,
    logger,
  });
  await enqueueNextAgentTurnTelemetryPrune({ scheduledJobs: scheduledJobsService });
  // AI turn health, evaluated from the diagnostics table every 5 minutes and
  // reported through Sentry. Production has no metrics scraper, so the
  // runbook's PromQL alerts are inert there; this is what actually watches the
  // AI automation. On by default; DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_WATCHDOG
  // switches it off (and ends the chain rather than orphaning its row).
  const agentTurnHealthWatchdogDisabled = envFlag(
    process.env.DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_WATCHDOG,
  );
  // Sentry alone notifies nobody on a repeat breach (see
  // agent-turn-health-email.ts), so every notice is also mailed to the owner
  // (the same `ownerEmail` the requireOwner gate uses) through Postmark. Off
  // without Postmark or an owner address, or when switched off; it logs which,
  // once.
  const agentTurnHealthEmail = agentTurnHealthWatchdogDisabled
    ? null
    : createAgentTurnHealthEmailer({
        postmark: config.postmark,
        ownerEmail,
        // Read by name, not through the exported constant, so the env-var
        // census (every-env-var-the-server-reads-is-documented) sees it.
        disabled: envFlag(process.env.DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_EMAIL),
        environment: config.sentry?.environment ?? null,
        logger,
      });
  if (agentTurnHealthWatchdogDisabled) {
    endAgentTurnHealthWatchdogChain({ scheduledJobs: scheduledJobsService, logger });
  } else {
    registerAgentTurnHealthWatchdogJob({
      scheduledJobs: scheduledJobsService,
      summary: agentTurnSummaryService,
      profileAttachmentWindow,
      sentry,
      email: agentTurnHealthEmail,
      logger,
    });
    await enqueueNextAgentTurnHealthWatchdog({ scheduledJobs: scheduledJobsService });
  }

  // V-266: browser-OAuth-style CLI / GUI activation flow. The bind step
  // temporarily stores a freshly minted API key in Redis, so the feature
  // fails closed when MFA_ENCRYPTION_KEY is absent instead of falling back
  // to plaintext at rest. buildApp already omits these routes when the
  // optional service is absent.
  const cliAuthorizeService = config.mfaEncryptionKey
    ? new CliAuthorizeService({
        redis,
        dashboardOrigin: config.dashboardOrigin,
        secretEncryptionKeyBase64: config.mfaEncryptionKey,
      })
    : undefined;

  // V-080: inbound Stripe webhook handler. Optional — only wired when
  // STRIPE_WEBHOOK_SECRET is configured. When absent, /v1/webhooks/stripe
  // is not registered and inbound deliveries 404 (Stripe will retry, but
  // that's a deploy misconfig signal, not a normal state).
  const stripeWebhooksRepo = new DrizzleStripeWebhooksRepo(dbHandle);
  // V-089: invert the tierPrices config to drive subscription event
  // tier resolution. Each (monthly | annual) price id maps back to the
  // same tier; the webhook handler uses this to determine which tier
  // to set on the account when a subscription created/updated event
  // arrives. `priceToInterval` is built beside it from the same config:
  // the monthly id bills by the month, the annual id by the year.
  const { priceToTier, priceToInterval } = buildStripePriceMaps(config.stripe?.tierPrices);
  // A paid-invoice event that names no subscription line this server can read
  // is fetched once from Stripe before it is recorded with no period. Needs
  // only the secret key, so it is wired apart from the billing service below
  // (which also needs the tier prices). Constructing the client calls nothing.
  const stripeInvoiceFetcher =
    config.stripe?.secretKey !== undefined
      ? new StripeApiClient({
          secretKey: config.stripe.secretKey,
          ...(config.stripe.apiVersion !== undefined
            ? { apiVersion: config.stripe.apiVersion }
            : {}),
          logger,
        })
      : undefined;
  const stripeWebhooksService = new StripeWebhooksService(
    stripeWebhooksRepo,
    {
      logger,
      priceToTier,
      priceToInterval,
      ...(stripeInvoiceFetcher !== undefined ? { invoiceFetcher: stripeInvoiceFetcher } : {}),
      // Live-billing audit #4 — cancels an older subscription a new plan replaced
      // (at once, prorated). Needs only the secret key, like the fetcher above.
      ...(stripeInvoiceFetcher !== undefined
        ? { subscriptionCanceller: new StripeBillingProvider(stripeInvoiceFetcher) }
        : {}),
      sentry,
      creditsRefresher: creditGrants, // null while AI credits are off
      creditClawbacks, // S17 — null while AI credits are off
    },
    accountLifecycleService, // V-202b — fans out tier_changed audit + email at one call site
    authCache, // invalidate the cached AccountContext on a Stripe-driven tier change (rate-limit tier freshness)
  );

  // C1 — crypto entitlement expiry sweep. A crypto tier payment grants the
  // tier for a fixed 31-day window (crypto_entitlements); when the last
  // unexpired entitlement for an account lapses, the account must fall back to
  // its best remaining entitlement (a live Stripe sub / another valid crypto
  // entitlement / free) — the mirror of Stripe's cancel-driven downgrade. Every
  // 15 min the sweeper recomputes each newly-expired account's tier via the
  // SAME downgradeAccountTierToBestRemaining path Stripe uses. Wired
  // UNCONDITIONALLY (not behind the crypto/IPN config gate): backfilled
  // entitlements can exist and must expire even in a deploy where the live IPN
  // intake path is currently unconfigured. With an empty entitlements table the
  // sweep is a no-op every tick. Re-arms itself; dedup on (job_type, NULL).
  const cryptoEntitlementExpirySweeper = new CryptoEntitlementExpirySweeperService({
    repo: stripeWebhooksRepo,
    logger,
    accountLifecycle: accountLifecycleService,
    authCache,
  });
  registerCryptoEntitlementExpirySweepJob({
    scheduledJobs: scheduledJobsService,
    sweeper: cryptoEntitlementExpirySweeper,
    logger, // chain survival: a swallowed tick failure is logged, then re-armed
  });
  await enqueueNextCryptoEntitlementExpirySweep({ scheduledJobs: scheduledJobsService });

  // Live-billing audit #3 — the past-due grace sweep. A failed renewal keeps the
  // paid plan for seven days (ToS 8.5); when Stripe sends nothing after that, this
  // takes it away through the same downgradeAccountTierToBestRemaining. Wired
  // UNCONDITIONALLY, as the crypto expiry sweep above: a past_due subscription can
  // exist from a deploy where the Stripe webhook was configured and must lose its
  // plan in one where it currently is not. With none past its grace the tick is
  // a no-op. Re-arms itself; dedup on (job_type, NULL); failures alert.
  registerPastDueGraceSweepJob({
    scheduledJobs: scheduledJobsService,
    sweeper: new PastDueGraceSweeperService({
      repo: stripeWebhooksRepo,
      logger,
      sentry,
      accountLifecycle: accountLifecycleService,
      authCache,
    }),
    logger, // chain survival: a swallowed tick failure is logged and alerted, then re-armed
  });
  await enqueueNextPastDueGraceSweep({ scheduledJobs: scheduledJobsService });

  // V-779 — recover paid crypto orders whose entitlement never landed. The IPN handler commits
  // status='paid' in one transaction and calls the tier activator in a LATER one; a process
  // death in that window strands a PAYING customer with no entitlement and no tier, and it
  // cannot self-heal — a re-delivered IPN reads status='paid', computes firePaid=false and
  // skips activation forever. The handler's alarm only fires when the activator THROWS, so an
  // abrupt death is silent.
  //
  // Wired UNCONDITIONALLY for the same reason as the expiry sweep directly above: a stranded
  // paid order can exist from a deploy where the IPN intake path was configured, and must be
  // recoverable in one where it currently is not. With no such orders the tick is a no-op.
  // Its own repo instance because the conditional block below builds one only when NOWPAYMENTS
  // is configured; this one takes just the db handle.
  const cryptoEntitlementReconcileSweeper = new CryptoEntitlementReconcileSweeper({
    repo: new DrizzleCryptoOrdersRepo(dbHandle),
    activator: new CryptoTierActivationService(
      stripeWebhooksRepo,
      logger,
      accountLifecycleService,
      authCache,
      creditGrants, // null while AI credits are off
      creditClawbacks, // S17 — null while AI credits are off
    ),
    logger,
  });
  registerCryptoEntitlementReconcileJob({
    scheduledJobs: scheduledJobsService,
    sweeper: cryptoEntitlementReconcileSweeper,
    logger, // chain survival: a swallowed tick failure is logged, then re-armed
  });
  await enqueueNextCryptoEntitlementReconcile({ scheduledJobs: scheduledJobsService });

  // Expire abandoned pending crypto orders. `sweepExpiredOrders` has always
  // worked; nothing ever RAN it — its only caller was the manual admin sweep
  // route — so an order abandoned before payment sat `pending` on the
  // customer's billing page forever, with no payment behind it and no route to
  // a terminal state. Production carried exactly such a row.
  //
  // Wired UNCONDITIONALLY, and its own service instance for the same reason the
  // reconcile sweeper above builds its own repo: the NOWPAYMENTS block far
  // below constructs one only when the IPN intake path is configured. An
  // abandoned order can exist from a deploy where it WAS configured and must
  // still expire in one where it currently is not — and a sweep behind a config
  // gate fails silently, which is the whole shape
  // retention-sweeps-are-unconditional-invariant exists to reject. With no
  // orders the tick is a no-op.
  const cryptoOrderSweepService = new CryptoOrdersService({
    repo: new DrizzleCryptoOrdersRepo(dbHandle),
    webhooks: {
      enqueueEvent: (accountId, eventType, data) =>
        webhooksService.enqueueEvent(accountId, eventType, data),
    },
    tierActivator: new CryptoTierActivationService(
      stripeWebhooksRepo,
      logger,
      accountLifecycleService,
      authCache,
      creditGrants, // null while AI credits are off
      creditClawbacks, // S17 — null while AI credits are off
    ),
    logger,
  });
  registerCryptoOrderExpirySweepJob({
    scheduledJobs: scheduledJobsService,
    service: cryptoOrderSweepService,
    logger, // chain survival: a swallowed tick failure is logged, then re-armed
  });
  await enqueueNextCryptoOrderExpirySweep({ scheduledJobs: scheduledJobsService });

  // Monthly AI credits: the three jobs that grant the next month when the
  // current one ends, catch an account whose billing event never came, and write
  // the ledger row for credit whose term has ended (see credit-grant-jobs.ts).
  //
  // ⛔ CONDITIONAL ON PURPOSE, unlike the retention sweeps around it. While
  // DRIFTSTACK_AI_CREDITS_MODE is off `creditGrants` is null, no credit window or
  // lot can exist, and there is nothing for these to grant or expire: they keep
  // no promise that applies with the mode off. With it off no handler is
  // registered and no row is enqueued. The window-boundary job is registered but
  // not seeded: it is armed per account, when a window is granted.
  if (creditGrants !== null) {
    registerCreditsCoverageSweepJob({
      scheduledJobs: scheduledJobsService,
      grants: creditGrants,
      logger,
    });
    await enqueueNextCreditsCoverageSweep({ scheduledJobs: scheduledJobsService });
    registerCreditsExpirySweepJob({
      scheduledJobs: scheduledJobsService,
      grants: creditGrants,
      logger,
    });
    await enqueueNextCreditsExpirySweep({ scheduledJobs: scheduledJobsService });
    registerCreditsWindowBoundaryJob({
      scheduledJobs: scheduledJobsService,
      grants: creditGrants,
      logger,
    });
    // The daily invariant audit (§5.3). It writes nothing and asks nine
    // questions the enforcement already answers — which is the point: a guard
    // that has been dropped, worked around or restored from a backup taken
    // mid-transaction leaves records that no longer add up and nothing that
    // asks. Its alert carries rule names and counts only.
    registerCreditsInvariantAuditJob({
      scheduledJobs: scheduledJobsService,
      audit: new DrizzleCreditInvariantAuditRepo(dbHandle),
      logger,
      sentry,
    });
    await enqueueNextCreditsInvariantAudit({ scheduledJobs: scheduledJobsService });
  }

  // THE BOOT PASS (H6). Step (b) of the lease keeper, once, before this process
  // serves anything: every task whose lease has already lapsed or whose ceiling
  // has passed is settled from what it recorded, so a deploy's predecessor
  // frees its customers' slots and credit at once rather than 90 seconds later.
  //
  // ⛔ IT SETTLES ONLY LAPSED LEASES, AND THERE IS NO SINGLE-PROCESS FLAG. A
  // second boot, a canary, a manual `node dist/index.js` during an incident and
  // a deploy running migrations while the old process still serves are all
  // ordinary here, because the only tasks this can touch are ones whose owner
  // has stopped saying it is there. The earlier design settled every task owned
  // by another boot id and would have charged live turns their full bound.
  //
  // A failure is logged and boot continues: the ordinary 15-second tick does
  // the same work, so the cost of a bad boot pass is 15 seconds, and refusing
  // to come up over it would turn a bookkeeping delay into an outage.
  if (creditLeaseKeeper !== null) {
    try {
      const swept = await creditLeaseKeeper.bootPass();
      if (swept.settled > 0 || swept.failed > 0) {
        logger.info(
          { component: 'ai-credit-lease-keeper', event: 'ai_credits_boot_pass', ...swept },
          'boot pass settled AI tasks whose lease had lapsed',
        );
      }
    } catch (err) {
      logger.warn(
        {
          component: 'ai-credit-lease-keeper',
          event: 'ai_credits_boot_pass_failed',
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
              : { value: err },
        },
        'the AI credit boot pass failed (the 15-second keeper does the same work)',
      );
    }
  }

  // V-1591 — bound session_events on the 90-day window (archive to R2, then
  // delete). AuditArchiveService has existed since V-163 and had never run:
  // `audit_archive_runs` was empty, so the privacy policy's "session metadata 90
  // days operational" line had no enforcer and the table grew for the lifetime
  // of the deployment.
  //
  // ⛔ ONLY session_events is scheduled. The service can archive four other
  // tables — admin_audit_log, processed_stripe_events, legal_acceptances,
  // webhook_deliveries — and those stay unscheduled deliberately: they are legal
  // and financial records that grow slowly, and DELETING them is a decision with
  // consequences well past disk usage. session_events is an internal action log
  // and is the only one of the five with genuinely unbounded growth.
  //
  // Registered UNCONDITIONALLY (the `service` is null when R2 is unconfigured,
  // and the tick reports that). Gating the registration on R2 would let an unset
  // env var silently switch off a published retention promise — see
  // `retention-sweeps-are-unconditional-invariant`.
  const auditArchiveService =
    r2 === null
      ? null
      : new AuditArchiveService({
          r2,
          rows: new DrizzleArchiveTableRepo(dbHandle),
          ledger: new DrizzleArchiveLedgerRepo(dbHandle),
        });
  registerSessionEventsArchiveJob({
    scheduledJobs: scheduledJobsService,
    service: auditArchiveService,
    logger, // chain survival: a swallowed tick failure is logged, then re-armed
  });
  await enqueueNextSessionEventsArchive({ scheduledJobs: scheduledJobsService });

  // V-759 — privacy-policy §9 retention enforcement. ANONYMISES rather than deletes:
  // usage_records cascades from sessions and §9 requires billing data be kept 7 years, and
  // revoked api_keys are RESTRICT-referenced by admin_audit_log so the row cannot be
  // removed at all. §9's closing paragraph authorises anonymisation as the alternative.
  // Daily; a no-op on a deployment with nothing past the 90-day window. Re-arms itself.
  const retentionScrubSweeper = new RetentionScrubSweeperService({
    repo: new DrizzleRetentionScrubRepo(dbHandle),
    logger,
  });
  registerRetentionScrubJob({
    scheduledJobs: scheduledJobsService,
    sweeper: retentionScrubSweeper,
    logger, // a failed retention step means data held past its disclosed window — alarm it
  });
  await enqueueNextRetentionScrub({ scheduledJobs: scheduledJobsService });

  // V-081: Profiles service.
  // V-225 — accountAudit wired for profile.{created,deleted}.
  const profilesRepo = new DrizzleProfilesRepo(dbHandle);
  const accountProxiesRepo = new DrizzleAccountProxiesRepo(dbHandle);
  // L4b Step 4 — recycle-bin retention purge. Daily 04:00 UTC sweep that
  // hard-deletes trashed profiles (+ their wrapped DEK) older than 30 days;
  // re-arms after each run. Without it, soft-deleted rows accumulate forever.
  const profileTrashPurgeSweeper = new ProfileTrashPurgeSweeperService({
    repo: profilesRepo,
    // FIX 2 — best-effort delete each purged profile's R2 sealed blob so the
    // encrypted bytes don't orphan forever (no-op when R2 isn't configured).
    r2,
    logger,
  });
  registerProfileTrashPurgeJob({
    scheduledJobs: scheduledJobsService,
    sweeper: profileTrashPurgeSweeper,
    logger,
  });
  await enqueueNextProfileTrashPurge({ scheduledJobs: scheduledJobsService });
  // 2026-07-01 — account-deletion retention purge (GDPR Article 17 close-out).
  // Daily 05:00 UTC sweep (staggered an hour after the 04:00 profile-trash
  // sweep) over everything privacy-policy.md §9 promises to erase 30 days after
  // account termination: the BYOK Anthropic key, the wrapped proxy credentials,
  // and the account's profiles + snapshots.
  //
  // Deliberately NOT gated on byokAnthropicService any more. It was, back when
  // the BYOK key was the only thing purged here and "no key storage configured"
  // genuinely meant "nothing to do". Two more §9 commitments now hang off this
  // sweeper — proxy secrets are wrapped under PROFILE_MASTER_KEY, and the
  // profile/snapshot purge needs no key at all — so that gate had quietly become
  // "an unset MFA_ENCRYPTION_KEY switches off three retention promises, two of
  // them unrelated to it". The BYOK arm now no-ops on its own when unwired,
  // which is the narrow, correct scope for that flag.
  const accountDeletionPurgeSweeper = new AccountDeletionPurgeSweeperService({
    repo: new DrizzleAccountDeletionPurgeRepo(dbHandle),
    ...(byokAnthropicService ? { byok: byokAnthropicService } : {}),
    // privacy-policy.md §3.5 names "HTTP/SOCKS5 proxy credentials" as
    // Customer-Provided Secrets, and §9 commits to erasing them within 30
    // days of account termination. Before this they were retained
    // indefinitely: the account delete is a soft status flip, the accounts
    // row is never hard-deleted so ON DELETE CASCADE never fires, and the
    // only other retention sweeper keys off a profile's own deletedAt.
    proxySecrets: accountProxiesRepo,
    // The other half of the same §9 line: "Profile metadata + Profile
    // Snapshots ... All deleted within 30 days of Customer Account
    // termination." Snapshots are listed separately because purging profiles
    // does not reach them — parent_profile_id is ON DELETE SET NULL, so they
    // survive with a null parent still holding the captured state inline.
    profiles: {
      purgeProfilesForTerminatedAccountsBefore: (cutoff) =>
        profilesRepo.purgeForTerminatedAccountsBefore(cutoff),
      purgeSnapshotsForTerminatedAccountsBefore: (cutoff) =>
        new DrizzleProfileSnapshotsRepo(dbHandle).purgeForTerminatedAccountsBefore(cutoff),
    },
    // agent_turn_receipts.response_ciphertext is the response BODY of a
    // customer's agent turn — content, not metadata — and NOTHING deleted it on
    // any schedule. Same root cause as the two arms above: the account delete is
    // a soft status flip, so the ON DELETE CASCADE on account_id never fires.
    //
    // Deliberately NOT wired to `agentTurnReceiptsRepo`, which exists only when
    // MFA_ENCRYPTION_KEY is set. A DELETE decrypts nothing, so binding this arm
    // to that key would make an unrelated flag switch off a fourth retention
    // promise — the exact defect 2eeddefa7 fixed for the other three.
    turnReceipts: {
      purgeForTerminatedAccountsBefore: (cutoff, maxPerTick) =>
        purgeTurnReceiptsForTerminatedAccountsBefore(dbHandle, cutoff, maxPerTick),
    },
    // agent_sessions.transcript is the customer's agent conversation and
    // gui_control_key_ciphertext a session credential. Neither was ever deleted.
    // Purging a session cascades its turn receipts and only NULLs the link on
    // saved recipes, so a customer's recipes survive the erasure; nothing
    // billing-related references this table, so the 7-year retention is
    // untouched. Key-free for the same reason as the receipts arm above.
    agentSessions: {
      purgeForTerminatedAccountsBefore: (cutoff, maxPerTick) =>
        purgeAgentSessionsForTerminatedAccountsBefore(dbHandle, cutoff, maxPerTick),
    },
    // V-1607 — the arm the one above HIDES. `recipes.agent_session_id` is
    // ON DELETE SET NULL so a recipe deliberately survives agent-session
    // cleanup; purging the sessions therefore leaves `intent_log` +
    // `transcript_snapshot` behind, holding full customer URLs (path and query)
    // for a terminated account. Correct survival for a live account, exactly
    // wrong for a deleted one. Key-free like the two arms above — a DELETE
    // decrypts nothing.
    recipes: {
      purgeForTerminatedAccountsBefore: (cutoff, maxPerTick) =>
        purgeRecipesForTerminatedAccountsBefore(dbHandle, cutoff, maxPerTick),
    },
    // Drops each purged profile's sealed blob; a blob outliving its row is
    // the customer's data outliving the erasure we committed to.
    r2,
    logger,
    // Four §9 commitments ride on this sweep and it emitted nothing until now.
    // The `skipped` label is what makes an unwired arm visible: a promise that
    // quietly stops running otherwise looks exactly like one with nothing to do.
    ...(metricsRegistry !== undefined ? { metrics: metricsRegistry } : {}),
  });
  registerAccountDeletionPurgeJob({
    scheduledJobs: scheduledJobsService,
    sweeper: accountDeletionPurgeSweeper,
    logger,
  });
  await enqueueNextAccountDeletionPurge({ scheduledJobs: scheduledJobsService });
  // Orphaned agent-session backstop (2026-06-19) — agent sessions only flip to
  // 'closed' on explicit DELETE or budget exhaustion, so a session orphaned by
  // a dead worker would linger status='active' forever. Hourly wall-clock sweep
  // closes any session that has been 'active' past the generous lifetime cap
  // (DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS, default 12h); re-arms after
  // each run. Reuses the agentSessionsRepo wired above.
  const agentSessionOrphanSweeper = new AgentSessionOrphanSweeperService({
    repo: agentSessionsRepo,
  });
  registerAgentSessionOrphanReapJob({
    scheduledJobs: scheduledJobsService,
    sweeper: agentSessionOrphanSweeper,
    logger,
  });
  await enqueueNextAgentSessionOrphanReap({ scheduledJobs: scheduledJobsService });
  // #158 — R2 orphaned profile sealed-blob reaper (GDPR erasure backstop). A
  // purge can hard-delete a profile row + its R2 blob while a just-closed
  // session's final save-back PUT is still in flight; the harness's direct PUT
  // then recreates `profiles/<uuid>.sealed` with NO DB row — a permanent orphan
  // no other sweep reaps. This 6h self-arming sweep lists profiles/*.sealed and
  // deletes any object OLDER than a 2h grace (safely exceeds the max presigned
  // save-back PUT TTL) whose uuid has no profiles row at all (trashed-inclusive
  // existence check → a trashed profile's blob survives). Gated on R2 being
  // configured; needs the s3:ListBucket permission — a missing grant makes each
  // pass a logged no-op (never a crash). Uses the same profilesRepo wired above.
  if (r2 !== null) {
    const profileBlobOrphanSweeper = new ProfileBlobOrphanSweeperService({
      r2,
      profiles: profilesRepo,
      logger,
    });
    profileBlobOrphanSweeper.start();
  }
  // Profile-backed sessions (file 57): decode the master key once at boot (null
  // when PROFILE_MASTER_KEY unset → profiles created without a DEK; feature inert).
  const profileMasterKeyBuf =
    config.profileMasterKey !== undefined ? decodeMasterKey(config.profileMasterKey) : null;
  if (profileMasterKeyBuf !== null) {
    const MAX_PROFILE_DEK_BOOT_MIGRATION_ROWS = 10_000;
    let scanned = 0;
    let converted = 0;
    let remaining = 0;
    do {
      const batch = await profilesRepo.migrateWrappedDekEnvelopes(profileMasterKeyBuf, 500);
      scanned += batch.scanned;
      converted += batch.converted;
      remaining = batch.remaining;
      if (remaining > 0 && (batch.scanned === 0 || batch.converted === 0)) {
        throw new Error(
          `Profile DEK migration made no progress with ${remaining.toString()} legacy rows remaining.`,
        );
      }
      if (remaining > 0 && scanned >= MAX_PROFILE_DEK_BOOT_MIGRATION_ROWS) {
        throw new Error(
          `Profile DEK migration exceeded the ${MAX_PROFILE_DEK_BOOT_MIGRATION_ROWS.toString()}-row boot bound with ${remaining.toString()} legacy rows remaining.`,
        );
      }
    } while (remaining > 0);
    if (scanned > 0) {
      logger.info(
        { component: 'profile-dek-encryption', scanned, converted, remaining },
        'legacy profile DEKs migrated to profile-bound v2 before serving',
      );
    }
    const MAX_ACCOUNT_PROXY_SECRET_BOOT_MIGRATION_ROWS = 10_000;
    let proxyScanned = 0;
    let proxyConverted = 0;
    let proxyRemaining = 0;
    do {
      const batch = await accountProxiesRepo.migrateSecretEnvelopes(profileMasterKeyBuf, 500);
      proxyScanned += batch.scanned;
      proxyConverted += batch.converted;
      proxyRemaining = batch.remaining;
      if (proxyRemaining > 0 && (batch.scanned === 0 || batch.converted === 0)) {
        throw new Error(
          `Account proxy secret migration made no progress with ${proxyRemaining.toString()} legacy rows remaining.`,
        );
      }
      if (proxyRemaining > 0 && proxyScanned >= MAX_ACCOUNT_PROXY_SECRET_BOOT_MIGRATION_ROWS) {
        throw new Error(
          `Account proxy secret migration exceeded the ${MAX_ACCOUNT_PROXY_SECRET_BOOT_MIGRATION_ROWS.toString()}-row boot bound with ${proxyRemaining.toString()} legacy rows remaining.`,
        );
      }
    } while (proxyRemaining > 0);
    if (proxyScanned > 0) {
      logger.info(
        {
          component: 'account-proxy-secret-encryption',
          scanned: proxyScanned,
          converted: proxyConverted,
          remaining: proxyRemaining,
        },
        'legacy account proxy secrets migrated to record-bound v2 before serving',
      );
    }
  } else {
    logger.warn(
      { component: 'account-proxy-secret-encryption' },
      'PROFILE_MASTER_KEY not set — encrypted account proxies are unreadable and credentialed writes fail closed',
    );
  }
  // ARC A — proxies service (owner-scoped resolve + unwrap + SSRF guard) shares
  // the same master key as the profile DEK.
  const accountProxiesService = new AccountProxiesService(accountProxiesRepo, profileMasterKeyBuf);
  // Founder directive #63 — CP-side LIVE proxy connectivity probe. Gates every
  // proxied agent-session launch on a real egress round-trip BEFORE dispatch (a
  // failed live test → 422, no session row, no worker). ON by default (the
  // founder's ask: validate EVERY proxied launch live); set
  // DRIFTSTACK_PROXY_PRELAUNCH_PROBE=0 (or =false) to disable if it ever
  // false-negatives a working proxy. DRIFTSTACK_PROXY_PROBE_TARGET_URL overrides
  // the neutral egress target (default the Driftstack exit-IP echo).
  const proxyPrelaunchProbeEnabled = !['0', 'false'].includes(
    (process.env.DRIFTSTACK_PROXY_PRELAUNCH_PROBE ?? '').toLowerCase(),
  );
  // Overall probe deadline (dial + handshake + egress round-trip), env-tunable so
  // the budget can be retuned for slow residential/mobile proxies without a code
  // change. A non-numeric / non-positive value falls back to the default (12s).
  const proxyProbeTimeoutMs = ((): number | undefined => {
    const raw = process.env.DRIFTSTACK_PROXY_PROBE_TIMEOUT_MS;
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();
  // N-2 — passive OS fingerprint observer. DS_OS_OBSERVER_HOST unset = off:
  // no second CONNECT, no lookup, and the Test response carries no
  // os_fingerprint field. A bad PORT falls back to the observer's default
  // rather than disabling the feature silently.
  const osObserverHost = process.env.DS_OS_OBSERVER_HOST;
  const osObserverPort = ((): number => {
    const n = Number(process.env.DS_OS_OBSERVER_PORT ?? '');
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_OS_OBSERVER_PORT;
  })();
  const proxyConnectivityProbe = new ProxyConnectivityProbe({
    ...(process.env.DRIFTSTACK_PROXY_PROBE_TARGET_URL !== undefined
      ? { targetUrl: process.env.DRIFTSTACK_PROXY_PROBE_TARGET_URL }
      : {}),
    ...(proxyProbeTimeoutMs !== undefined ? { timeoutMs: proxyProbeTimeoutMs } : {}),
    ...(osObserverHost !== undefined && osObserverHost !== ''
      ? {
          osObserver: {
            host: osObserverHost,
            port: osObserverPort,
            // The lookup reads the record for the port the probe DIALS; see
            // `makeOsObserverLookup`'s port parameter for what happened when it
            // did not.
            lookup: makeOsObserverLookup(
              process.env.DS_OS_OBSERVER_LOOKUP,
              fetch,
              undefined,
              osObserverPort,
            ),
          },
        }
      : {}),
  });
  // ITEM 4 — background freshness refresher for saved SOCKS5/HTTP proxies. A
  // reading is only ever TAKEN when someone presses Test on one machine, so on a
  // second Mac (or after a reinstall) the row's exit identity and OS fingerprint
  // can be months old. This re-takes them on a 6-hour per-proxy cadence, five at
  // a time, serially, with a 2-minute wall-clock budget against the scheduler's
  // 5-minute lease — see the job's header for the arithmetic and for why a
  // failed background probe never changes anything a customer can see.
  //
  // Registered UNCONDITIONALLY, like the retention sweeps: the probe is passed
  // through and a deployment without one simply claims nothing, rather than the
  // chain vanishing from the liveness roster because an env var is unset.
  registerProxyFreshnessJob({
    scheduledJobs: scheduledJobsService,
    proxies: accountProxiesRepo,
    resolver: accountProxiesService,
    probe: proxyConnectivityProbe,
    logger, // chain survival: a swallowed tick failure is logged, then re-armed
  });
  await enqueueNextProxyFreshnessRefresh({ scheduledJobs: scheduledJobsService });
  const profilesService = new ProfilesService(
    profilesRepo,
    accountAuditService,
    profileMasterKeyBuf,
    // FIX 2 — manual purge (DELETE /:id/purge) best-effort deletes the purged
    // profile's R2 sealed blob (no-op when R2 isn't configured).
    r2,
    logger,
    // Security fix (2026-06-30 audit) — without this, purge()/transferProfile()'s
    // live-session guard is wired but INERT (the 6th param defaults to null,
    // fail-open): a profile could be hard-deleted (or its identity transferred
    // away) while an agent session still held it bound, silently orphaning the
    // session and resurrecting the "permanently deleted" R2 blob via the
    // session's independently-minted, long-TTL save-back PUT URL.
    agentSessionsRepo,
  );
  // V-312 — profile snapshots service shares the profiles repo for
  // tier-cap + name-conflict enforcement on restore.
  const profileSnapshotsService = new ProfileSnapshotsService(
    new DrizzleProfileSnapshotsRepo(dbHandle),
    profilesRepo,
    accountAuditService,
    profileMasterKeyBuf,
  );

  // Q.2 — fail-fast safety: refuse to boot if STRIPE_SECRET_KEY is
  // sk_live_ before the BV KvK launch cutover (2026-05-21). Catches
  // an accidental live-key-before-entity-in-place misconfiguration
  // BEFORE any routes register or any HTTP traffic starts.
  const stripeKeySafety = validateStripeKeyForLaunch({
    secretKey: config.stripe?.secretKey,
  });
  if (!stripeKeySafety.ok) {
    throw new Error(stripeKeySafety.reason);
  }

  // V-082 + V-088: Billing service. Activates only when both
  // STRIPE_SECRET_KEY + DRIFTSTACK_TIER_PRICE_IDS are configured (the
  // StripeBillingProvider needs the secret key for API calls; tier
  // price ids are needed to map tier → Stripe Checkout price). When
  // either is missing, billingService is undefined and routes simply
  // don't register.
  if (config.stripe?.secretKey !== undefined && config.stripe.tierPrices !== undefined) {
    const stripeApi = new StripeApiClient({
      secretKey: config.stripe.secretKey,
      ...(config.stripe.apiVersion !== undefined ? { apiVersion: config.stripe.apiVersion } : {}),
      logger,
    });
    const billingProvider: BillingProvider = new StripeBillingProvider(stripeApi);
    const billingRepo = new DrizzleBillingRepo(dbHandle);
    billingService = new BillingService(billingRepo, billingProvider, {
      tierPrices: config.stripe.tierPrices,
      // V-057.E — derived from DASHBOARD_ORIGIN-driven config
      // instead of a per-env literal, same pattern as the email
      // URLs above. Explicit STRIPE_*_URL env vars still win.
      defaultSuccessUrl: config.stripe.successUrl ?? `${config.dashboardOrigin}/billing/success`,
      defaultCancelUrl: config.stripe.cancelUrl ?? `${config.dashboardOrigin}/billing/cancel`,
      portalReturnUrl: config.stripe.portalReturnUrl ?? `${config.dashboardOrigin}/billing`,
    });
    logger.info({ component: 'billing' }, 'BillingService wired with StripeBillingProvider');
  } else {
    logger.warn(
      { component: 'billing' },
      'BillingService NOT wired (STRIPE_SECRET_KEY + DRIFTSTACK_TIER_PRICE_IDS required); /v1/billing/* routes will not register',
    );
  }

  // V-666 — CryptoOrdersService wired against the Postgres-backed
  // DrizzleCryptoOrdersRepo (migration 0060). Activates the
  // /v1/billing/crypto-checkout family when NOWPAYMENTS_IPN_SECRET is
  // configured (same gate as the IPN webhook route). When IPN secret
  // is unset, the service can still be wired safely — orders just
  // never receive status transitions from upstream — but matches the
  // route-gate convention by staying undefined.
  let cryptoOrdersService: CryptoOrdersService | undefined;
  let nowpaymentsApiClient: NowPaymentsApiClient | undefined;
  if (config.nowpayments?.ipnSecret !== undefined && config.nowpayments.ipnSecret.length > 0) {
    const cryptoRepo = new DrizzleCryptoOrdersRepo(dbHandle);
    // 2026-05-22 — migration 0064 added crypto.order.paid +
    // crypto.order.failed to the webhook_event_type enum. The
    // CryptoOrdersService's emitter intent (V-666.I + V-666.AN)
    // can finally land in the WebhooksService sink without the
    // 22P02 invalid-input error that previously kept this
    // deferred. Customers subscribed to either event get a real
    // webhook delivery on every applyIpnStatus terminal transition.
    // S41 2026-07-07 (founder-approved: wire crypto activation) — paid crypto
    // orders now activate the purchased tier. Reuses the Stripe account-tier
    // mechanism (stripeWebhooksRepo.setAccountTierIfUpgrade — same accounts
    // row-lock as setAccountTier) + the same fan-out (auth-cache
    // invalidation, subscription.tier_changed lifecycle event → audit row +
    // tier-changed email). Upgrade-only: the activator enforces the
    // no-downgrade precedence rule (see CryptoTierActivationService).
    const cryptoTierActivation = new CryptoTierActivationService(
      stripeWebhooksRepo,
      logger,
      accountLifecycleService,
      authCache,
      creditGrants, // null while AI credits are off
      creditClawbacks, // S17 — null while AI credits are off
    );
    cryptoOrdersService = new CryptoOrdersService({
      repo: cryptoRepo,
      webhooks: {
        enqueueEvent: (accountId, eventType, data) =>
          webhooksService.enqueueEvent(accountId, eventType, data),
      },
      tierActivator: cryptoTierActivation,
      // Billing-integrity — surface the payment_id-mismatch alarm to the logs.
      logger,
    });
    logger.info(
      { component: 'crypto-orders' },
      'CryptoOrdersService wired with DrizzleCryptoOrdersRepo',
    );
    // V-666.D — NowPayments HTTP client. Used by the checkout route to
    // mint a real `pay_address` instead of the stub `null`. Only wires
    // when NOWPAYMENTS_API_KEY is present (separate env var from
    // IPN_SECRET — the API key authenticates outbound calls, IPN
    // secret verifies inbound webhook signatures).
    if (config.nowpayments?.apiKey !== undefined && config.nowpayments.apiKey.length > 0) {
      nowpaymentsApiClient = new NowPaymentsApiClient({
        apiKey: config.nowpayments.apiKey,
        logger,
      });
      logger.info(
        { component: 'crypto-orders' },
        'NowPaymentsApiClient wired — /v1/billing/crypto-checkout will mint real payment addresses',
      );
    } else {
      logger.warn(
        { component: 'crypto-orders' },
        'NOWPAYMENTS_API_KEY missing — /v1/billing/crypto-checkout returns stub posture (payment_address: null)',
      );
    }
  } else {
    logger.warn(
      { component: 'crypto-orders' },
      'CryptoOrdersService NOT wired (NOWPAYMENTS_IPN_SECRET required); /v1/billing/crypto-checkout routes will not register',
    );
  }
  // IPN callback URL derives from the OAuth callback base when
  // available (same API origin); otherwise hard-codes prod. Both
  // app.driftstack.io (dashboard) and api.driftstack.dev (this
  // server) are deployed; NowPayments posts to the API origin.
  const nowpaymentsIpnCallbackUrl: string =
    process.env.NOWPAYMENTS_IPN_CALLBACK_URL ??
    'https://api.driftstack.dev/v1/webhooks/nowpayments';

  // V-541.G — CostMonitoringService wired against the production
  // defaults from `cost-defaults.ts`. V-541.H then replaced the stub
  // aggregator with a real one over the V-073 usage_records ledger — see
  // the paragraph below, which describes what actually ships — so the
  // admin and customer cost routes return measured usage rather than an
  // empty cycle. The superseded "always returns no usage" wording lived
  // here for one release because the V-541.H note was ADDED below it
  // instead of replacing it.
  //
  // Tier resolution leans on the billing repo's getAccount → tier
  // field; this is the same source the existing billingService
  // uses, so the cost service can't drift away from the tier the
  // customer actually pays for.
  // V-541.H — real UsageAggregator over the V-073 usage_records
  // ledger. Fills `sessionMinutes` from real data; other dimensions
  // (storage, egress, email, llm) are zero placeholders until their
  // per-account meters land (V-541.I/J/K follow-ups).
  const costMonitoringService = new CostMonitoringService({
    aggregator: new UsageAggregatorFromUsageRepo({ repo: usageRepo }),
    rates: DEFAULT_COST_RATES,
    tierThresholds: DEFAULT_TIER_THRESHOLDS_DERIVED,
    resolveTier: async (accountId) => {
      const acc = await new DrizzleBillingRepo(dbHandle).getAccount(accountId);
      return acc?.tier ?? null;
    },
  });
  logger.info(
    { component: 'cost-monitoring' },
    'CostMonitoringService wired with DEFAULT_COST_RATES + DEFAULT_TIER_THRESHOLDS_DERIVED (real UsageAggregator over usage_records; storage/egress/email/llm dimensions zero until V-541.I/J/K land)',
  );

  // notificationEventBus moved earlier in bootstrap so AccountAudit
  // can publish high-severity actions onto it. See the construction
  // site near accountAuditService above. Full design: docs/internal/
  // driftstack-telemetry-event-schema-for-gui-panel.md.

  // 2026-05-20 — V-541.E nightly cost-recompute. Per-account spend
  // evaluated at UTC midnight; threshold transitions fire alerts via
  // the CostAlertDispatcher. Until Postmark / Slack channels are
  // wired (post-launch), the sink is logger-only: every fired alert
  // lands as a structured `cost.threshold_alert` log line that ops
  // can grep / page on. Re-arms idempotently via the V-202d dedup-
  // on-account-and-type flag (job_type 'cost.recompute_nightly',
  // account_id NULL) — same pattern the auth-tokens sweeper uses,
  // with the post-2026-05-20 isNull-aware dedup fix (incident #47)
  // already in place at the scheduled_jobs layer.
  const costAlertDispatcher = new CostAlertDispatcher({
    service: costMonitoringService,
    sendAlert: (alert) => {
      logger.info(
        {
          component: 'cost-alert',
          account_id: alert.account_id,
          billing_cycle: alert.billing_cycle,
          tier: alert.tier,
          severity: alert.severity,
          previous_state: alert.previous_state,
          current_state: alert.current_state,
          total_cents: alert.total_cents,
          threshold_soft_cents: alert.threshold_soft_cents,
          threshold_hard_cents: alert.threshold_hard_cents,
        },
        'cost.threshold_alert',
      );
      // Dual-publish to the GUI notification bus (v0). Drops on the
      // floor today (no SSE subscribers yet) — same shape will fan
      // out to the desktop panel once the v0.1 SSE route lands.
      notificationEventBus.publish({
        kind: 'cost.threshold_alert',
        accountId: alert.account_id,
        severity: alert.severity,
        billingCycle: alert.billing_cycle,
        previousState: alert.previous_state,
        currentState: alert.current_state,
        totalCents: alert.total_cents,
        thresholdSoftCents: alert.threshold_soft_cents,
        thresholdHardCents: alert.threshold_hard_cents,
        at: new Date().toISOString(),
      });
      return Promise.resolve();
    },
  });
  registerCostNightlyJob({
    scheduledJobs: scheduledJobsService,
    service: costMonitoringService,
    dispatcher: costAlertDispatcher,
    accounts: new DrizzleCostNightlyAccountIdProvider(dbHandle),
    logger,
  });
  await enqueueNextNightlyRun({ scheduledJobs: scheduledJobsService });

  // v2-#17 — daily rotation-reminder sweeps for webhook signing secrets
  // (v2-#10/#10.5/#10.6) and BYOK Anthropic API keys (v2-#11/#11.5/#11.6).
  // Both reminder services are pure-sweep nags (no auto-rotation); the
  // services skip rows that don't need a reminder yet, so the per-tick
  // burst is bounded by perTickLimit (default 50). Default-on for
  // production; the operator can flip
  // DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1 to suppress when a
  // customer-quiet account wants to silence the nag (e.g. canary
  // deployments).
  const rotationRemindersDisabled = envFlag(process.env.DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS);
  const webhookRotationReminderService = new WebhookRotationReminderService(
    new DrizzleWebhookRotationReminderRepo(dbHandle, {
      ...(config.mfaEncryptionKey !== undefined
        ? { secretEncryptionKeyBase64: config.mfaEncryptionKey }
        : {}),
      onUndecryptableSecret: ({ endpointId, accountId, error }) => {
        logger.error(
          { endpointId, accountId, err: error },
          'webhook endpoint secret could not be decrypted; skipped in rotation-reminder sweep',
        );
      },
    }),
    email,
    logger,
    // v2-#36 — thread DASHBOARD_ORIGIN-driven config so rotation
    // reminder emails link to the right host on each env.
    { dashboardUrl: config.dashboardOrigin },
  );
  const byokAnthropicRotationReminderService = new ByokAnthropicRotationReminderService(
    new DrizzleByokAnthropicRotationReminderRepo(dbHandle),
    email,
    logger,
    { dashboardUrl: config.dashboardOrigin },
  );
  // Arc 3 sub-slice 28.5 follow-up (v2-#28) — 24h-before-grace-expiry
  // last-chance email for any already-persisted force-rotation window.
  // Keep this recovery path and secret-prev cleanup active even though the
  // unrecoverable 91-day force-rotation producer is deliberately not wired:
  // the plaintext-once API has no authenticated channel that can reveal the
  // producer's generated secret to its customer. Reuses webhooksRepo directly
  // (DrizzleWebhooksRepo structurally satisfies
  // WebhookGraceExpiringNoticeRepo) and shares the reminder opt-out/cadence.
  const webhookGraceExpiringNoticeService = new WebhookGraceExpiringNoticeService(
    webhooksRepo,
    email,
    logger,
    { dashboardUrl: config.dashboardOrigin },
  );

  // V-784 — the five daily sweeps below run as durable, self-re-arming
  // scheduled_jobs rows rather than the bare 24h setInterval timers they used
  // to be. A setInterval fires its first tick a full period after it is
  // created, so a process that restarts more often than once a day never
  // reached the first tick and these did not run at all; the schedule also
  // lived only in process memory, and none of them appeared on the
  // job-chain-liveness roster, which is derived from the *_JOB_TYPE constants
  // and therefore watched exactly the sweeps that were already durable. See
  // services/daily-maintenance-jobs.ts.
  //
  // Wired HERE, alongside the other eleven chains and above the poller that
  // dispatches them, because ScheduledJobsService.processTick markFailed()s a
  // job whose type has no registered handler — a claim that lands before
  // registration does not retry, it kills the chain.
  //
  // V-295c3-tombstone — status-subscriber email purge. Privacy §3.10 promises
  // 90d post-unsubscribe email zero-out.
  //
  // V-783 — this used to claim the purge records each row in the admin audit
  // log as an actor-less system action. That was false, and unachievable:
  // admin_audit_log.admin_account_id is NOT NULL with an FK and every row must
  // name exactly one acting key or web session (0138's CHECK), account_audit_log
  // requires an accountId, and a status subscriber is an
  // anonymous email fired at by a sweep with no actor — there is no row that
  // could be inserted. Migration 0027 reserved the 'status_subscriber.purged'
  // enum value for a write that nothing has ever performed. The log line below
  // is the only evidence the purge ran; see the admin-audit reachability guard.
  await wireDailyMaintenanceSweep({
    scheduledJobs: scheduledJobsService,
    logger,
    sweep: {
      jobType: STATUS_SUBSCRIBER_PURGE_JOB_TYPE,
      component: 'status-subscriber-purge',
      run: async (now) => {
        const result = await statusSubscribersService.processPurge(now);
        if (result.purged.length > 0) {
          logger.info(
            { component: 'status-subscriber-purge', count: result.purged.length },
            'purged status-subscriber emails (90d post-unsubscribe)',
          );
        }
      },
    },
  });

  if (rotationRemindersDisabled) {
    logger.warn(
      { component: 'rotation-reminders' },
      'DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1 — webhook + BYOK Anthropic key rotation reminder sweeps disabled at boot',
    );
  } else {
    await wireDailyMaintenanceSweep({
      scheduledJobs: scheduledJobsService,
      logger,
      sweep: {
        jobType: WEBHOOK_ROTATION_REMINDER_JOB_TYPE,
        component: 'webhook-rotation-reminder',
        run: async (now) => {
          await webhookRotationReminderService.tickOnce(now);
        },
      },
    });
    await wireDailyMaintenanceSweep({
      scheduledJobs: scheduledJobsService,
      logger,
      sweep: {
        jobType: BYOK_ANTHROPIC_ROTATION_REMINDER_JOB_TYPE,
        component: 'byok-anthropic-rotation-reminder',
        run: async (now) => {
          await byokAnthropicRotationReminderService.tickOnce(now);
        },
      },
    });
    await wireDailyMaintenanceSweep({
      scheduledJobs: scheduledJobsService,
      logger,
      sweep: {
        jobType: WEBHOOK_GRACE_EXPIRING_NOTICE_JOB_TYPE,
        component: 'webhook-grace-expiring-notice',
        run: async (now) => {
          await webhookGraceExpiringNoticeService.tickOnce(now);
        },
      },
    });
    // v2-#29 — daily stale-secret_prev cleanup. v2-#20's worker fix
    // already stops emitting the prev signature past the grace window;
    // this sweep is a data-hygiene follow-up that nulls the row columns
    // so a leaked DB snapshot can no longer surface the old plaintext.
    // Shares the same daily cadence + opt-out as the rotation reminders;
    // a deploy that wants no automatic mutations sets
    // DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1.
    await wireDailyMaintenanceSweep({
      scheduledJobs: scheduledJobsService,
      logger,
      sweep: {
        jobType: WEBHOOK_SECRET_PREV_CLEANUP_JOB_TYPE,
        component: 'webhook-secret-prev-cleanup',
        run: async (now) => {
          const result = await webhooksRepo.clearStaleSecretPrev({ now });
          if (result.cleared > 0) {
            logger.info(
              { component: 'webhook-secret-prev-cleanup', cleared: result.cleared },
              'webhook secret_prev cleanup nulled stale rows',
            );
          }
        },
      },
    });
  }

  // Readiness checks. Postgres + Redis are required; R2 only checked
  // if configured. Postmark + Sentry are never readiness-gated.
  const readinessChecks: ReadinessCheck[] = [
    {
      name: 'postgres',
      timeoutMs: 1500,
      fn: async () => {
        await dbHandle.client`SELECT 1`;
      },
    },
    {
      name: 'redis',
      timeoutMs: 1500,
      fn: async () => {
        await redis.ping();
      },
    },
  ];
  if (r2 !== null) {
    readinessChecks.push(r2ReadinessCheck(r2));
  }

  // CORS posture guard — PERMISSIVE_CORS=true echoes any Origin while
  // credentials:true remains enabled. The complete first-party allow-list is
  // the production boundary, so refuse boot if an env regression bypasses it.
  const permissiveCors = envFlag(process.env.PERMISSIVE_CORS);
  assertCorsPosture(permissiveCors, config.nodeEnv);

  // LK.2 + V-820 — the Drizzle fleet_nodes repo constructed before the
  // record-bound secret migration backs BOTH the
  // /v1/mac-nodes/register LiveKit-credential writes AND the fleet-node
  // JWT verifier. Hoisted to a const so the control-plane deps below can
  // share the instance.

  // V-820 — fleet-node control-plane deps. Constructed (boot-safe: redis
  // is already ping-validated above + dbHandle is live, so neither opens
  // a new connection) ONLY when FLEET_CONTROL_PLANE_ENABLED=true. When
  // omitted, app.ts registers the 503 disabled stub — the prod posture
  // until fleet nodes are deployed (nothing connects yet, so a
  // live-by-default endpoint would be exposed with no consumer). The
  // nonce cache instance is shared between the verifier (replay defence)
  // and AppDeps.fleetNonceCache — app.ts's activation gate requires all
  // three (fleetNodeAuth + fleetNonceCache + fleetControlRegistry).
  // W2808 — forward holder (fleetRegistryHolder) is declared EARLIER now (just
  // above the agentExecutor wiring), because the #139 go-live routing dispatcher
  // also reads it lazily. It's still assigned inline at registry construction
  // below and read only at heartbeat/dispatch fire-time (long after boot).
  // W2813 — last-seen per-process bootId per node, for the CP bootId consumer (restart
  // detection). Process-lifetime map; reset on CP restart is intentional (the consumer
  // records-only on the first beat after a reset, so it never mass-closes — see
  // node-boot-reconcile.ts). Read+mutated only in the heartbeat handler below.
  const bootIdByNode = new Map<string, string>();
  // W2821 — per-node deadline (server-time ms) for the bootId consumer's post-restart
  // re-sweep window (audit w93vi1teq #2: re-check recency-skipped young orphans on later
  // beats instead of leaking them to the 12h reap). Bounded by fleet size; the consumer
  // clears entries once each window elapses.
  const restartSweepUntil = new Map<string, number>();
  const fleetControlPlaneDeps = config.fleetControlPlaneEnabled
    ? (() => {
        const fleetNonceCache = new RedisFleetNonceCache(redis);
        // W413 — go-live config summary at boot. The flag is on; surface which
        // optional go-live deps are actually configured so an operator catches a
        // half-config (e.g. flag on but PROFILE_MASTER_KEY / LiveKit unset →
        // those features degrade inert) at boot, not at first dispatch.
        logger.info(
          {
            component: 'go-live-config',
            livekitReady:
              config.livekit?.apiKey !== undefined &&
              config.livekit?.apiSecret !== undefined &&
              config.livekit?.wsUrl !== undefined,
            profileDekReady: config.profileMasterKey !== undefined,
            fleetInternalTokenSet: config.fleetInternalToken !== undefined,
          },
          'fleet control plane ENABLED',
        );
        // W650/A3-W1254 — latest pageState per AGENT session, written by the
        // registry's onPageState consumer + read by GET /v1/agent-sessions/
        // :id/page-state (the GUI loading-bar/error-overlay source).
        const sessionPageStateStore = new SessionPageStateStore();
        // A2 W2679 re-base — latest worker-liveness per AGENT session, written
        // by the registry's onHeartbeat consumer (below, alongside
        // recordHeartbeat) from Heartbeat.activeSessionStates + read by the
        // agent-sessions `liveness` read-shape field. Lets the GUI tell a
        // genuinely-running session from a status='active' row whose worker
        // crashed/never-started (the "always says open session" bug), replacing
        // the GUI's client-side page-state probe + 90s grace heuristic. Bounded
        // + in-memory (same posture as sessionPageStateStore); absent in prod
        // (no fleet control plane) → the read field defaults to "unknown".
        const sessionLivenessStore = new SessionLivenessStore();
        // HIGH #21 — latest ownership-gated capability report per AGENT
        // session. Public agent-session reads expose the view-only/streaming/
        // egress state to the installed GUI; the same relay persists the raw +
        // derived report on its linked driver session.
        const sessionCapabilityReportStore = new SessionCapabilityReportStore();
        // T-9 — per-agent-session bounded ring of network-log entries, written
        // by the registry's onNetworkRequests consumer (below) + read by GET
        // /v1/agent-sessions/:id/network (the simulator's Network pane). The fork
        // emitter lands later, so this is legitimately empty in prod today.
        const sessionNetworkLogStore = new SessionNetworkLogStore();
        // Worker-disconnect fix (2026-06-19) — close a node's active agent
        // sessions when its control-plane connection drops and doesn't
        // reconnect within DRIFTSTACK_WORKER_DISCONNECT_GRACE_SECONDS (default
        // 120). The PRECISE complement to the 12h orphan_reap backstop: frees
        // the worker's concurrent-session slot in minutes. The reaper's
        // register/disconnect hooks are threaded into the registry below
        // (positional args 6 + 7) so the live WS lifecycle arms/cancels the
        // per-node grace timers. A re-register within the grace cancels the
        // close (so a transient blip / deliberate restart never false-closes a
        // live session). Reuses the agentSessionsRepo wired above.
        const workerDisconnectReaper = new WorkerDisconnectReaperService({
          repo: agentSessionsRepo,
          logger,
        });
        return {
          fleetNodeAuth: new FleetNodeAuthImpl(drizzleFleetNodesRepo, fleetNonceCache),
          fleetNonceCache,
          sessionPageStateStore,
          sessionLivenessStore,
          sessionCapabilityReportStore,
          sessionNetworkLogStore,
          sessionCaptureStore,
          // Profile-backed session persistence (A3 W417): when R2 is configured,
          // a `profileSaved` frame from a node writes the customer's sealed store
          // to R2; without R2 the frame is accepted + ignored (stateless).
          // W393 challenge-handling: a `challengeDetected` frame relays to the
          // customer-facing `session.challenge_detected` webhook (resolves the
          // owning account from the session id).
          fleetControlRegistry: (fleetRegistryHolder.current = new FleetControlRegistry(
            r2 !== null
              ? makeProfileSavedPersister(r2, logger, {
                  agentSessions: agentSessionsRepo,
                  profiles: profilesRepo,
                })
              : undefined,
            makeChallengeRelay(agentSessionsRepo, webhooksService, logger),
            // W650/A3-W1254: a pageState frame (agent-initiated navigate) → store
            // the latest per agent session for GET /v1/agent-sessions/:id/page-state.
            // audit M1 — gated so a non-owning node can't fake another session's overlay.
            makeSessionPageStateRelay(agentSessionsRepo, sessionPageStateStore, logger),
            // A3 W1364: a profileSaveFailed frame (save-back failed at teardown)
            // → relay as the customer-facing session.profile_save_failed webhook.
            makeProfileSaveFailedRelay(agentSessionsRepo, webhooksService, logger),
            // Fleet-admin panel (file-48 §A5): a heartbeat (macNodeId already
            // cross-checked against the JWT nodeId in the connection) → bump
            // fleet_nodes.last_seen_at AND persist the latest telemetry snapshot
            // (migration 0083) for the panel's resource/capacity/uptime/drain
            // columns. Best-effort + fire-and-forget off the receive loop;
            // recordHeartbeat is an UPDATE-by-id (no-op for an unregistered
            // node), so a self-seeded/unknown node is harmless. A failed write
            // just leaves the snapshot stale until the next 10s beat — never
            // throws into the socket loop. Optional fields are omitted when the
            // node doesn't emit them (jsonb drops undefined keys).
            makeFleetHeartbeatConsumer({
              logger,
              persistSnapshot: async (frame) => {
                const snapshot = {
                  beatAt: frame.timestamp,
                  cpuPercent: frame.cpuPercent,
                  memoryPercent: frame.memoryPercent,
                  activeSessionCount: frame.activeSessionCount,
                  ...(frame.maxConcurrent !== undefined && {
                    maxConcurrent: frame.maxConcurrent,
                  }),
                  ...(frame.uptimeSeconds !== undefined && { uptimeSeconds: frame.uptimeSeconds }),
                  ...(frame.drainState !== undefined && { drainState: frame.drainState }),
                  ...(frame.sessionOutcomeCounts !== undefined && {
                    sessionOutcomeCounts: frame.sessionOutcomeCounts,
                  }),
                  ...(frame.thermalState !== undefined && { thermalState: frame.thermalState }),
                  ...(frame.memoryPressureLevel !== undefined && {
                    memoryPressureLevel: frame.memoryPressureLevel,
                  }),
                  ...(frame.busiestCorePercent !== undefined && {
                    busiestCorePercent: frame.busiestCorePercent,
                  }),
                  ...(frame.diskFreePercent !== undefined && {
                    diskFreePercent: frame.diskFreePercent,
                  }),
                  ...(frame.harnessVersion !== undefined && {
                    harnessVersion: frame.harnessVersion,
                  }),
                  // A3 2026-09-19 — the MEASURED digests beside the DECLARED
                  // `harnessVersion` above. Persisted in the same jsonb snapshot,
                  // so no column and no migration; an older node's beat simply
                  // lacks the keys and the drift report reads that as absent.
                  // Spread-when-defined like every field above: an absent key must
                  // never be written as null, because null is a value and "we were
                  // told nothing" is not.
                  ...(frame.harnessBinarySha256 !== undefined && {
                    harnessBinarySha256: frame.harnessBinarySha256,
                  }),
                  ...(frame.webkitFrameworkSha256 !== undefined && {
                    webkitFrameworkSha256: frame.webkitFrameworkSha256,
                  }),
                };
                await drizzleFleetNodesRepo.recordHeartbeat(frame.macNodeId, snapshot);
                // V-1742 — the worker ships its latest fault on every beat so an
                // operator can see it WITHOUT log-scraping, and the control plane
                // used to strip it: the field was never in the schema, and Zod's
                // default object drops unknown keys silently. It is present only
                // when a worker has actually faulted, so this is rare by
                // construction and is exactly the beat worth keeping.
                //
                // NOT persisted — a column needs a migration, which is the owner's
                // call. Logged so the next unexplained fault leaves a trace.
                //
                // 2026-09-23 — logged ONCE per distinct fault per node, not on
                // every beat: the worker repeats its latest fault on every beat
                // until it faults again, so logging each beat turned one fault
                // into 7,873 identical warnings in a day. See worker-fault-log.ts.
                if (
                  frame.lastErrorSummary !== undefined &&
                  isNewWorkerFault(frame.macNodeId, frame.lastErrorSummary, frame.lastErrorAtMs)
                ) {
                  logger.warn(
                    {
                      component: 'fleet-heartbeat',
                      macNodeId: frame.macNodeId,
                      lastErrorSummary: frame.lastErrorSummary,
                      ...(frame.lastErrorAtMs !== undefined && {
                        lastErrorAtMs: frame.lastErrorAtMs,
                      }),
                    },
                    'worker reported a recent fault on its heartbeat',
                  );
                }
              },
              // A2 W2679 re-base — feed the per-session liveness map into the
              // store the agent-sessions `liveness` field reads. Stamp receive
              // time from the server clock, never the node's wall clock.
              recordLiveness: (frame) => {
                if (frame.activeSessionStates) {
                  sessionLivenessStore.recordBeat(
                    frame.macNodeId,
                    frame.activeSessionStates,
                    Date.now(),
                  );
                }
              },
              // CP↔daemon reconcile: re-issue sessionEnd for worker-reported
              // sessions the control plane already holds terminal.
              reconcileWorkerOrphans: async (frame) => {
                if (!frame.activeSessionStates) return;
                await reconcileWorkerReportedOrphans({
                  agentSessions: agentSessionsRepo,
                  activeSessionStates: frame.activeSessionStates,
                  macNodeId: frame.macNodeId,
                  sendSessionEnd: (sessionId) =>
                    fleetRegistryHolder.current
                      ?.get(frame.macNodeId)
                      ?.sendSessionEnd(serializeSessionEnd(sessionId)),
                  logger,
                });
              },
              // Track bootId changes even when a restarted node reports zero
              // sessions; close CP-active sessions it does not reaffirm.
              reconcileNodeBoot: (frame) =>
                reconcileNodeBootChange({
                  agentSessions: agentSessionsRepo,
                  macNodeId: frame.macNodeId,
                  bootId: frame.bootId,
                  reaffirmedSessionIds: Object.keys(frame.activeSessionStates ?? {}),
                  bootIdByNode,
                  restartSweepUntil,
                  now: Date.now(),
                  logger,
                }),
            }),
            // Worker-disconnect fix (2026-06-19) — liveness hooks (positional
            // args 6 + 7): a (re)connect CANCELS the node's pending grace timer;
            // a disconnect ARMS it. On grace expiry the reaper closes the node's
            // status='active' sessions (reason='worker-disconnected').
            (nodeId) => workerDisconnectReaper.onNodeRegistered(nodeId),
            (nodeId) => workerDisconnectReaper.onNodeDisconnected(nodeId),
            // Worker-CONNECTED orphan auto-close (A3 W2682, positional arg 8): a
            // TERMINAL sessionStatus frame (status ∈ {ended, errored}) from a
            // still-connected worker → close the matching agent_sessions row in
            // seconds (frees the slot, clears the GUI's phantom "open session").
            // Fire-and-forget off the receive loop (the helper swallows+logs
            // internally + is idempotent via an 'active'-guard); the
            // worker-disconnect reaper + 12h orphan_reap stay the backstops.
            makeAgentSessionTerminalStatusRelay({
              agentSessions: agentSessionsRepo,
              logger,
              livenessStore: sessionLivenessStore,
              sessionPageStateStore,
              sessionCapabilityReportStore,
            }),
            // Cross-session spoof guard (audit M1 extended to the correlated reply
            // path) — threaded into every connection's request correlators so a
            // dropped result frame (sessionId mismatch) logs one warn.
            logger,
            makeSessionCapabilityReportRelay(
              agentSessionsRepo,
              sessionsService,
              sessionCapabilityReportStore,
              logger,
              // T-6 — activate the measured-QUIC back-fill: a live session's
              // capabilityReport (h2-and-h3 + interpose loaded) writes a real
              // quic_measured verdict onto the account_proxies row it ran
              // through, so the proxy test shows measured QUIC instead of an
              // inference. Owner-scoped; a session on the operator default
              // egress (no proxy row) no-ops.
              accountProxiesRepo,
            ),
            makeSessionErrorEventRelay(agentSessionsRepo, notificationEventBus, logger),
            // T-9: a networkRequests frame (per-request log on an agent-initiated
            // browse) → append the rows to the per-session ring for GET
            // /v1/agent-sessions/:id/network. Ownership-gated so a non-owning node
            // can't inject fabricated rows into another session's Network pane.
            makeSessionNetworkLogRelay(agentSessionsRepo, sessionNetworkLogStore, logger),
            // (c) 2026-09-10: a `provisioning` frame's detail (vpn_egress_active —
            // tunnel up, browser not attached yet) → agent_sessions.provisioning_detail,
            // cleared by `active`. Ownership-gated like the terminal-close relay.
            makeSessionProvisioningDetailRelay(agentSessionsRepo, logger),
            // Keys a device adds to an intent result that this build does not
            // model are stripped (not fatal); this counts them by intent and
            // logs their names, rate-limited, so an operator sees what the
            // device started sending. See services/harness-result-unknown-keys.ts.
            new UnknownResultKeyReporter({
              ...(metricsRegistry !== undefined ? { metrics: metricsRegistry } : {}),
              logger,
            }).observe,
          )),
          // The config a dispatched session browses with when it names no
          // proxy_id.
          //
          // ⛔ THE COMMENT THAT USED TO BE HERE SAID "so inert in prod". IT WAS
          // FALSE. This block is assembled whenever FLEET_CONTROL_PLANE_ENABLED
          // is true, and that flag ALSO gates ControlPlaneAgentExecutor (:1353)
          // — so it must be true for agent sessions to work at all, and prod
          // sets it. The local-demo `127.0.0.1:1080` below was therefore the
          // LIVE PRODUCTION default egress: nothing listens on 1080 on the
          // fleet box, so every session without an explicit proxy_id was
          // dispatched onto a dead loopback route and presented to the customer
          // as an unexplained freeze. A flag that is both a demo gate and
          // load-bearing cannot be turned off, so the demo config ships.
          //
          // `proxy` is now OPTIONAL (see SessionDispatchConfig): omit it and the
          // assign carries no egress, which a REQUIRE_PROXY=1 node refuses with
          // a named `no_proxy_configured` instead of misrouting. The value below
          // is UNCHANGED pending the operator's choice of a real default; the
          // startup check under it makes the current state loud meanwhile. The
          // archetype is the canonical current-code iPhone (NOT the canvas-gated
          // iphone17 cutover); the SOCKS5 proxy is the local gost (udp_associate
          // on for h3/QUIC = iPhone-coherent). Edit here to point a demo session
          // at a different landing URL / proxy.
          sessionDispatch: {
            archetype: 'iphone16pro_ios18_6_safari18_6',
            // ⛔ A PERSONA SOMEBODY CHOSE (2026-09-20). This was the literal
            // 'default', which is neither a persona nor a speed the device knows.
            // The device's resolver lets an unknown name fall through to the
            // `regular` persona, so behaviour does not change with this line —
            // what changes is that the value is now the one ordinary sessions use,
            // from the same constant, instead of a string that named nothing and
            // worked by accident. Pace modes will choose it per session.
            behaviorProfile: DEFAULT_BEHAVIORAL_PROFILE,
            initialUrl: 'https://driftstack.io',
            // From env, or ABSENT. The literal that used to sit here
            // (127.0.0.1:1080) was a local fleet-demo value that became the
            // live production default; unset now means "no default egress",
            // which a REQUIRE_PROXY=1 node refuses by name instead of routing
            // a session into an address nothing listens on.
            ...(config.defaultEgressHost !== undefined && config.defaultEgressPort !== undefined
              ? {
                  proxy: {
                    host: config.defaultEgressHost,
                    port: config.defaultEgressPort,
                    udp_associate: true,
                    require_remote_dns: false,
                    ...(config.defaultEgressUsername !== undefined
                      ? { username: config.defaultEgressUsername }
                      : {}),
                    ...(config.defaultEgressPassword !== undefined
                      ? { password: config.defaultEgressPassword }
                      : {}),
                  },
                }
              : {}),
          },
        };
      })()
    : {};

  // A default egress on a loopback or link-local address cannot reach the
  // public internet from the fleet node. It is not rejected here: a loopback
  // CAN be legitimate (a local SOCKS forwarder onto a real upstream), so
  // refusing it would break that deployment and is not this function's call.
  // But on a node that requires a proxy it is overwhelmingly the cause of
  // "every page is frozen", and it shipped once already behind a comment
  // claiming the block was inert in production. So it is stated LOUDLY at boot
  // rather than left for someone to find in a per-session transport log.
  // Mirrors the box-side per-session warning A3 added in 4149f6080.
  if (config.fleetControlPlaneEnabled) {
    const defaultEgress = (
      fleetControlPlaneDeps as { sessionDispatch?: { proxy?: { host?: string } } }
    ).sessionDispatch?.proxy;
    const host = defaultEgress?.host ?? null;
    if (host === null) {
      logger.warn(
        'NO DEFAULT EGRESS CONFIGURED — agent sessions created without an explicit proxy_id will be REFUSED by a require-proxy node with no_proxy_configured. That is the intended failure (a named error beats a dead route), but those sessions do not run. Set DEFAULT_EGRESS_HOST/PORT (+ USERNAME/PASSWORD if it authenticates) to give them one.',
      );
    }
    if (
      host !== null &&
      (host === 'localhost' ||
        host.startsWith('127.') ||
        host === '::1' ||
        host.startsWith('169.254.'))
    ) {
      logger.warn(
        { host, port: (defaultEgress as { port?: number } | undefined)?.port },
        'DEFAULT EGRESS IS A LOOPBACK ADDRESS — every agent session created without an explicit proxy_id will be dispatched onto it. If nothing is forwarding on that address from the fleet node, those sessions load no page and present as an unexplained freeze. Set a real default egress, or omit sessionDispatch.proxy so the node refuses with no_proxy_configured instead of misrouting.',
      );
    }
  }

  const deps: AppDeps = {
    logger,
    authRepo,
    authCache,
    authCoalescer,
    negativeAuthCache,
    oauthStore,
    ...(effectiveStaffEmails.size > 0 ? { staffEmails: effectiveStaffEmails } : {}),
    ...(ownerEmail !== null ? { ownerEmail } : {}),
    rateLimitStore,
    // DoS hardening — global IP gate (app-wide, before auth). Configurable
    // via GLOBAL_IP_RATE_LIMIT_PER_MIN; 0 disables. undefined → app.ts
    // default (600/min/IP).
    ...(config.globalIpRateLimitPerMin !== undefined
      ? {
          globalIpRateLimit:
            config.globalIpRateLimitPerMin <= 0
              ? null
              : {
                  capacity: config.globalIpRateLimitPerMin,
                  refillPerSecond: config.globalIpRateLimitPerMin / 60,
                },
        }
      : {}),
    sessionsService,
    apiKeysService,
    usageService,
    webhooksService,
    webhooksAdminService,
    adminAuditService,
    accountsAdminService,
    adminBillingService,
    pricingService,
    platformSecretsService,
    incidentsService,
    statusSubscribersService,
    incidentEventBus,
    slaReportingService,
    teamMembersService,
    rateLimitOverridesService,
    legalService,
    emailPreferencesService,
    accountAuditService,
    validationHarnessService,
    accountLifecycleService,
    scheduledJobsService,
    authFlowsService,
    ...(cliAuthorizeService !== undefined ? { cliAuthorizeService } : {}),
    profilesService,
    profileSnapshotsService,
    // V-100: admin force-actions take direct repo + driver access.
    // V-237: profilesRepo also feeds /v1/account/me.
    sessionRepo: sessionsRepo,
    apiKeysRepo,
    driver,
    profilesRepo,
    // ARC A — per-account customer proxies repo + the decoded master key for
    // wrapping proxy passwords; both feed /v1/account/me/proxies.
    accountProxiesRepo,
    accountProxiesService,
    // Founder directive #63 — live pre-launch proxy probe + its on/off flag.
    proxyConnectivityProbe,
    proxyPrelaunchProbeEnabled,
    profileMasterKey: profileMasterKeyBuf,
    // V-352b — public-bucket R2 client used by avatar upload + the
    // presigned-GET URL on /v1/account/me. Same client the V-295c2
    // status-snapshot writer uses; null when R2_BUCKET_PUBLIC isn't
    // configured (avatar endpoints fall back to 503 / null).
    r2Public,
    // Private R2 (sealed-profile-blob bucket) — threaded to the agent-session
    // dispatch for profile-backed restore/save-back URLs. null when R2 unset.
    r2,
    // V-353b — MFA service; null when MFA_ENCRYPTION_KEY isn't set
    // (avoids registering enrollment routes that would write to a
    // table we can't decrypt back from).
    ...(mfaService !== null ? { mfaService } : {}),
    // AI-CHAT BYOK Anthropic — per-customer key storage. Shares the
    // MFA_ENCRYPTION_KEY gate (one less env var to manage; Q1 verdict
    // 2026-05-17). When unset, app.ts registers 503 stubs.
    ...(byokAnthropicService !== null ? { byokAnthropicService } : {}),
    // LK.2 — POST /v1/mac-nodes/register depends on the Drizzle-backed
    // fleet_nodes repo (writes the per-Mac LiveKit credentials) +
    // MFA_ENCRYPTION_KEY for the AES-256-GCM envelope. Both wired
    // unconditionally when the env vars permit; app.ts gates the
    // route registration on both being non-undefined here.
    drizzleFleetNodesRepo,
    // V-820 — fleet control-plane WS deps (empty unless
    // FLEET_CONTROL_PLANE_ENABLED=true; see fleetControlPlaneDeps above).
    ...fleetControlPlaneDeps,
    // Wave 29-400 §8.5 — atlas-priority observability surface. Repo
    // is always constructed (Drizzle path against the migrated
    // atlas_priority_events table); the InternalFleetAuth activation
    // flag is what gates route registration in app.ts. When the env
    // var is unset, registerInternalAtlasPriorityDisabledRoutes runs
    // and every internal route 503s.
    atlasPriorityEventsRepo: new DrizzleAtlasPriorityEventsRepo(dbHandle),
    internalFleetAuth: new InternalFleetAuth({
      internalToken: config.fleetInternalToken ?? null,
    }),
    ...(config.mfaEncryptionKey !== undefined
      ? { livekitSecretEncryptionKey: config.mfaEncryptionKey }
      : {}),
    // Arc 1 sub-slice 6.3 (v2-#6) — bundled-LLM consent gate. Wired
    // unconditionally; the route's resolution chain skips this leg
    // unless deploymentFallbackKey is also configured.
    bundledLlmService,
    // Billing-integrity hardening — per-account concurrent bundled-LLM-turn
    // ceiling (bounds the soft-cap TOCTOU overshoot). Only consulted when
    // the bundled-LLM leg is live.
    bundledTurnMaxConcurrency: config.bundledTurnMaxConcurrency,
    // EG-API-1.6 — concrete SocksProxyBackend for the Phase 1 SOCKS5
    // customer-egress path. Wired unconditionally: the backend is pure
    // config-to-env-var translation with no external deps, so it
    // activates as soon as the bootstrap mounts AppDeps. OpenVPN +
    // WireGuard are Phase 2/3 (rejected at the backend with a typed
    // error that the route layer maps to 503). When this wire lands,
    // the W247.A drift-sweep gate flips hasEgressImpl=true and the
    // marketing copy can update from "roadmap" to "live" per the
    // Path-1 autoflip plan (orchestrator handoff 2026-05-17). 2026-05-22 —
    // explicit `key: key` form so the W247.A regex matches (shorthand
    // syntax silently failed the gate detection).
    sessionEgressService: sessionEgressService,
    // W615 — SESSION_PROXY_REQUIRED explicit override (tri-state; unset →
    // inferred from the egress backend, the existing prod posture).
    sessionProxyRequired: config.sessionProxyRequired,
    // AI-B4 — recipes repo. Wired unconditionally; now activates
    // because Q.1 wires agentSessionsRepo below.
    recipesRepo,
    // Q.1 — agent-runtime + agent-sessions repo wired unconditionally.
    // Decomposer selection (Claude vs deterministic) is per
    // `selectAgentDecomposer` below; runtime composition + sessions
    // repo are always wired so the /v1/agent-sessions/* routes
    // activate from process start.
    agentRuntime,
    agentSessionsRepo,
    agentTurnReceiptsRepo,
    byokKeyCache,
    exitIdentityCache,
    agentDecomposerKind,
    // S14 — customer-facing `credits`/`credits_spent` fields, default off.
    aiCreditsResponseFields: config.aiCreditsResponseFields,
    // Arc 2 sub-slice 8.3 (v2-#8) — SSE transcript bus wired
    // unconditionally; route registration is gated on agentRuntime
    // being wired (same activation pattern as the rest).
    agentSessionEventBus,
    // 2026-05-20 — GUI panel notification bus. Wired
    // unconditionally; the SSE route registration in app.ts is
    // already gated on this dep being present, so this single
    // line activates the customer-facing stream.
    notificationEventBus,
    pairModeLock,
    pairModeHeartbeatTracker,
    // Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — Prometheus metrics
    // registry. Activated when METRICS_SCRAPE_TOKEN is wired; routes
    // emit counters into it + /metrics returns the rendered text.
    // Without the token, the registry is omitted and counter call
    // sites silently no-op (the optional chain `metrics?.inc(...)`
    // matters here). The registry itself is constructed earlier (so
    // AgentRuntime can take a reference for obs.3); the `/metrics`
    // route registration is what this branch gates.
    ...(metricsRegistry !== undefined && config.metricsScrapeToken !== undefined
      ? {
          metricsRegistry,
          metricsScrapeToken: config.metricsScrapeToken,
          // Chain-liveness gauge, refreshed at scrape time. Deliberately NOT
          // driven from a job tick: a watchdog that rides on a chain dies with
          // the chain it is meant to be watching.
          // V-784 — a deployment with the rotation-reminder kill-switch set
          // neither registers nor enqueues those four chains, so they are
          // OMITTED rather than reported as 0: zero means "this chain died"
          // and would page for a sweep that was switched off on purpose.
          metricsRefreshGauges: () =>
            refreshJobChainLiveness({
              repo: scheduledJobsRepo,
              metrics: metricsRegistry,
              ...(rotationRemindersDisabled ||
              agentTurnHealthWatchdogDisabled ||
              creditGrants === null
                ? {
                    notRunHere: new Set([
                      ...(rotationRemindersDisabled ? ROTATION_REMINDER_JOB_TYPES : []),
                      ...(agentTurnHealthWatchdogDisabled
                        ? [AGENT_TURN_HEALTH_WATCHDOG_JOB_TYPE]
                        : []),
                      // With AI credits off every credit chain — the two
                      // sweeps and the daily invariant audit — is neither
                      // registered nor enqueued, so they are omitted, not 0.
                      // The list is imported rather than written out here, so
                      // a chain added under the same switch is covered on the
                      // day it lands.
                      ...(creditGrants === null ? CREDITS_RECURRING_JOB_TYPES : []),
                    ]),
                  }
                : {}),
            }),
        }
      : {}),
    // Arc 2 sub-slice 8.4 (v2-#8) — gui_control_key encryption.
    // Shares MFA_ENCRYPTION_KEY per Q2=C pattern; route gates on
    // this being present in AppDeps.
    ...(config.mfaEncryptionKey !== undefined
      ? { guiControlKeyEncryptionKey: config.mfaEncryptionKey }
      : {}),
    // Q.1.d — staging opts in to consuming the deployment fallback
    // for unconfigured customers; prod (default false) hard-502s
    // ByokAnthropicRequired per the BYOK-for-v1.0 Tier-3 verdict.
    ...(config.byokAnthropic?.fallbackApiKey !== undefined
      ? { agentDecomposerFallbackKey: config.byokAnthropic.fallbackApiKey }
      : {}),
    agentDecomposerAllowFallback:
      config.agentDecomposer?.useFallbackForUnconfiguredCustomers ?? false,
    // Founder safeguard (2026-06-24) — per-account in-flight upload cap (bytes);
    // config-defaulted to 512 MB, tunable via AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_BYTES.
    agentUploadMaxAccountInFlightBytes: config.agentUploadMaxAccountInFlightBytes,
    // Hardening (2026-06-24) — per-account concurrent-relay COUNT cap (default 16,
    // AGENT_RELAY_MAX_ACCOUNT_INFLIGHT) + concurrent-upload COUNT cap (default 4,
    // AGENT_UPLOAD_MAX_ACCOUNT_INFLIGHT_COUNT).
    agentRelayMaxAccountInFlight: config.agentRelayMaxAccountInFlight,
    agentUploadMaxAccountInFlightCount: config.agentUploadMaxAccountInFlightCount,
    ...(config.stripe?.webhookSecret !== undefined
      ? {
          stripeWebhooksService,
          stripeWebhookSigningSecret: config.stripe.webhookSecret,
        }
      : {}),
    // V-666 / V-487 — NowPayments IPN secret. Without this, the
    // /v1/webhooks/nowpayments route stays unregistered (route file
    // header documents the wire-ready posture explicitly). app.ts
    // gates registration on a non-empty string so the empty-string
    // accident reads the same as "not configured".
    ...(config.nowpayments?.ipnSecret !== undefined && config.nowpayments.ipnSecret.length > 0
      ? { nowpaymentsIpnSecret: config.nowpayments.ipnSecret }
      : {}),
    // LiveKit token-mint surface. Same all-or-nothing semantics as
    // nowpayments: the route only registers when all three fields are
    // present. Partial config = unregistered route = 404 = client falls
    // back to HTTP polling.
    //
    // ⛔ This said "the route's ownership check uses
    // sessionsService.findOwnedSessionLite". That has been false since
    // 58a0a2521, which DELETED the V-531.B route it described
    // (/v1/sessions/:id/livekit-token, an owner-greenlit fix for a
    // customer-mintable publisher token). The surviving route is
    // /v1/agent-sessions/:id/livekit-token, over a DIFFERENT subject
    // (agent sessions, not browser SessionRecords), and it checks access
    // with callerCanAccessAgentSession — the canonical helper its four
    // sibling routes use, which admits a team admin where raw
    // owner-equality wrongly 404'd. `findOwnedSessionLite` is now
    // called from nowhere.
    //
    // ⚠️ The stale sentence was not merely misleading. It wrapped the
    // method name across a line break so that a dot-qualified receiver
    // was followed by an open paren, and a caller census matching a
    // dotted call therefore counted the COMMENT as a call site and
    // reported the dead method as live. Deliberately paraphrased rather
    // than quoted here: reproducing the offending spelling would
    // re-poison the same census. Prose that names a symbol joins the
    // population every name-based instrument measures, so such a census
    // must strip comments (see tests/unit/_helpers/code-only.ts).
    ...(config.livekit?.apiKey !== undefined &&
    config.livekit?.apiSecret !== undefined &&
    config.livekit?.wsUrl !== undefined
      ? {
          livekit: {
            apiKey: config.livekit.apiKey,
            apiSecret: config.livekit.apiSecret,
            wsUrl: config.livekit.wsUrl,
          },
        }
      : {}),
    // V-667.C — OAuth-client service + provider config. The route
    // registration gate is at app.ts; we wire the service whenever
    // signingSecret + callbackUrl + ≥1 provider are present. Pending-
    // mailer is a thin wrapper around the existing email service;
    // accounts lookup wraps authFlowsRepo.findAccountByEmail + a
    // simple createAccount call (passwordHash=null since IDP signup
    // doesn't set a password).
    ...(config.oauthClient !== undefined &&
    config.oauthClient.signingSecret !== undefined &&
    config.oauthClient.callbackUrlBase !== undefined &&
    (config.oauthClient.google !== undefined || config.oauthClient.github !== undefined)
      ? (() => {
          // V-667.C-followup — extract the links repo so it's also
          // passed as `oauthLinksRepo` for the customer-facing
          // /v1/account/me/oauth-links read endpoint. Same instance
          // both sides → no risk of read/write divergence.
          const oauthLinksRepo = new DrizzleOAuthLinksRepo(dbHandle);
          return {
            oauthLinksRepo,
            oauthClient: {
              signingSecret: config.oauthClient.signingSecret,
              callbackUrlBase: config.oauthClient.callbackUrlBase,
              dashboardOrigin: config.dashboardOrigin,
              // 2026-09-11 — v2 OAuth flow store (PKCE verifier + hand-off
              // code, single-use via GETDEL). The same Redis store as the MFA
              // login hand-off; fails closed on a Redis outage, like MFA.
              flowStore: mfaChallengeStore,
              ...(config.oauthClient.google !== undefined
                ? { google: config.oauthClient.google }
                : {}),
              ...(config.oauthClient.github !== undefined
                ? { github: config.oauthClient.github }
                : {}),
            },
            oauthClientService: new OAuthClientServiceImpl({
              links: oauthLinksRepo,
              pending: new DrizzleOAuthPendingLinksRepo(dbHandle),
              accounts: {
                // ⛔ V-1724 — this consulted ONLY the literal column, and that
                // produced a customer-facing 500 on an auth path. Observed on a
                // real database, not reasoned about: an account created as
                // `first.last@gmail.com` stores `canonical_email` =
                // `firstlast@gmail.com`; signing in through Google with the
                // undotted spelling MISSED here, fell through to
                // `createFromIdp`, and the insert died on
                // `accounts_canonical_email_unique`. The merge flow that
                // should handle a collision is already built and correct — it
                // was simply never reached.
                //
                // ⚠️ The drift is dated and the lesson is about WHERE a sweep
                // looks. This wiring is 2026-05-15; canonical dedup and the
                // `findAccountByEmailOrCanonical` helper arrived 2026-07-01 and
                // moved four callers in `auth-flows.ts` onto the safe path. The
                // fifth caller lives HERE, and neither file shows the problem
                // alone: `auth-flows.ts` looks fully migrated and this looks
                // like ordinary wiring. A hardening that adds a safe helper has
                // to be swept by every file calling the unsafe primitive.
                //
                // Both lookups run unconditionally, mirroring the service
                // helper. Short-circuiting on the literal hit would make query
                // count vary with which spelling matched.
                //
                // Sign-in audit #6 — and the address is lowercased BEFORE it is
                // canonicalised: the Gmail rules key on the literal domain, so a
                // provider asserting `First.Last@Gmail.com` missed the stored
                // `firstlast@gmail.com` here and died on the same unique index
                // (V-1724 again, for mixed case). The lookup is now ONE function
                // that the test app's OAuth wiring calls too, so the in-memory
                // suites see this class instead of a literal-only copy of their own.
                findIdByEmail: (e) => findAccountIdForSignInEmail(authFlowsRepo, e),
                createFromIdp: async (args) => {
                  // IDP-asserted email is verified per Verdict 1 trust
                  // contract; mark emailVerifiedAt at creation time
                  // separately (createAccount doesn't set it). Tier
                  // defaults to 'free' — matches password signup.
                  const row = await authFlowsRepo.createAccount({
                    email: args.email,
                    name: args.name,
                    passwordHash: '', // sentinel — column is nullable,
                    // route layer treats empty hash as "no password set";
                    // user adds a password via /account/security later.
                    initialTier: 'free',
                  });
                  await authFlowsRepo.markEmailVerified(row.id, new Date());
                  return row.id;
                },
              },
              mailer: {
                // V-667.C — verify-merge email. Builds the confirm
                // link from the customer-facing dashboard origin so
                // the recipient lands on the dashboard's confirm-merge
                // page (which POSTs back to /v1/auth/oauth-client
                // /confirm-merge). DASHBOARD_ORIGIN strips its trailing
                // slash at schema-level; the shared helper restores the
                // page's canonical slash and URL-encodes the token.
                sendVerifyMergeEmail: async (args) => {
                  const confirmLink = canonicalOneTimeTokenUrl(
                    `${config.dashboardOrigin}/auth/oauth-client/confirm-merge`,
                    args.plaintextToken,
                  );
                  await email.sendOauthPendingLinkVerification({
                    to: args.to,
                    provider: args.provider,
                    confirmLink,
                    expiresAt: args.expiresAt,
                  });
                },
              },
            }),
          };
        })()
      : {}),
    ...(billingService !== undefined ? { billingService } : {}),
    ...(cryptoOrdersService !== undefined ? { cryptoOrdersService } : {}),
    ...(nowpaymentsApiClient !== undefined
      ? { nowpaymentsApiClient, nowpaymentsIpnCallbackUrl }
      : {}),
    costMonitoringService,
    agentTurnTelemetry,
    agentTurnSummaryService,
    // S11 — absent while DRIFTSTACK_AI_CREDITS_MODE is off (the default and the
    // production posture), which is what keeps the AI turn byte for byte what
    // it was and the admin credits routes unregistered.
    ...(aiCredits !== undefined ? { aiCredits } : {}),
    readinessChecks,
    // 2026-05-20 — env-var-controlled escape hatch. Some webview
    // contexts (Tauri custom-scheme pages, certain mobile in-app
    // browsers) send Origin variants the allowlist regex doesn't
    // catch; toggling PERMISSIVE_CORS=true lets @fastify/cors echo
    // the request Origin so the response satisfies the credentials-
    // mode spec without us guessing every variant. Stays opt-in
    // because it widens the CSRF surface.
    permissiveCors,
    // req.ip / X-Forwarded-For resolution behind Cloudflare→nginx (prod
    // TRUST_PROXY=1). Without this req.ip is the loopback peer → broken per-IP
    // rate-limiting + 127.0.0.1 audit IPs.
    trustProxy: config.trustProxy,
    corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    // V-278.C — auto-allow the canonical dashboard origin in the strict CORS
    // posture so flipping PERMISSIVE_CORS=false can't lock out the primary
    // dashboard even if CORS_ALLOWED_ORIGINS omits it.
    dashboardOrigin: config.dashboardOrigin,
    // V-117: pass through to buildApp so it installs the Sentry
    // error-capture + breadcrumb hooks. Both are no-ops when
    // sentry.isInitialized is false (i.e. SENTRY_DSN unset).
    sentry,
    // V-337 — driver name + playwright browser surface on /version
    // for client observability (GUI Connectivity test, ops tooling).
    driverName: config.driver,
    playwrightBrowser: config.playwrightBrowser,
    // #139 — whether AI Browser Automation EXECUTES for real. This is the fleet
    // control-plane gate (the SAME condition that wires ControlPlaneAgentExecutor
    // over the fleet dispatch above), NOT the local `driver` (which stays 'mock'
    // in prod because the real path is the fleet correlator, not the in-process
    // driver). The GUI reads it to drop the stale "actions are simulated" note.
    agentExecutionLive: config.fleetControlPlaneEnabled,
  };

  // V-232 — background poller startup. Both processTick methods own
  // their own claim/dispatch/retry semantics; the bootstrap layer just
  // calls them on a 60s timer. 60s cadence is the V-173 webhook-worker
  // convention; trial-pack expiry and validation-harness scheduling
  // both have minute-level latency tolerance, so this matches.
  // Founder-approved cadence on V-202d ack (2026-05-06).
  //
  // Errors inside the tick are caught + logged warn-level by the
  // services themselves; the setInterval handler still wraps in a
  // try/catch as a defense-in-depth: an unexpected throw must NEVER
  // kill the interval, or background work silently stops.
  const POLLER_INTERVAL_MS = 60_000;
  const scheduledJobsTimer = setInterval(() => {
    void (async () => {
      try {
        await scheduledJobsService.processTick(new Date());
      } catch (err) {
        logger.warn(
          {
            component: 'scheduled-jobs-poller',
            err:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                : { value: err },
          },
          'scheduled-jobs processTick threw unexpectedly (interval continues)',
        );
      }
    })();
  }, POLLER_INTERVAL_MS);
  // Don't keep the event loop alive just for the poller — let the
  // app close cleanly on SIGINT without waiting on the next tick.
  scheduledJobsTimer.unref();

  const validationHarnessTimer = setInterval(() => {
    void (async () => {
      try {
        await validationHarnessService.processTick({ now: new Date() });
      } catch (err) {
        logger.warn(
          {
            component: 'validation-harness-poller',
            err:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                : { value: err },
          },
          'validation-harness processTick threw unexpectedly (interval continues)',
        );
      }
    })();
  }, POLLER_INTERVAL_MS);
  validationHarnessTimer.unref();

  // V-295b — health probe poller. Same 60s cadence; guarded by the
  // same try/catch so a one-tick failure never kills the interval.
  // Only runs in environments where PUBLIC_API_BASE_URL is set
  // (production via Hetzner deploy). Local dev = no-op.
  const healthProbeTimer = healthProbeService
    ? setInterval(() => {
        void (async () => {
          try {
            await healthProbeService.processTick(new Date());
          } catch (err) {
            logger.warn(
              {
                component: 'health-probe-poller',
                err:
                  err instanceof Error
                    ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                    : { value: err },
              },
              'health-probe processTick threw unexpectedly (interval continues)',
            );
          }
        })();
      }, POLLER_INTERVAL_MS)
    : null;
  healthProbeTimer?.unref();

  // V-295c2 — status snapshot poller. Same 60s cadence; independent
  // of the probe poller so a snapshot failure doesn't stall probe
  // ticks (and vice versa). Only runs when R2 is configured.
  const statusSnapshotTimer = statusSnapshotService
    ? setInterval(() => {
        void (async () => {
          try {
            await statusSnapshotService.processSnapshot(new Date());
          } catch (err) {
            logger.warn(
              {
                component: 'status-snapshot-poller',
                err:
                  err instanceof Error
                    ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                    : { value: err },
              },
              'status-snapshot processSnapshot threw unexpectedly (interval continues)',
            );
          }
        })();
      }, POLLER_INTERVAL_MS)
    : null;
  statusSnapshotTimer?.unref();

  // Arc 4 Wave 2.B sub-slice 8.13d (v2-#8) — pair-mode heartbeat
  // sweep. Tick every 5 seconds: walks tracker.findStaleSessions()
  // + fires heartbeat-timeout transition + agent_session.pair_mode.timeout
  // audit emit on each. The 5s cadence is much tighter than the
  // 60s scheduled-jobs poller because the user-visible behavior
  // (auto-handback to AI after 30s of no client heartbeat) is
  // interactive and needs sub-minute responsiveness.
  const PAIR_MODE_HEARTBEAT_SWEEP_INTERVAL_MS = 5_000;
  const pairModeHeartbeatSweep = new PairModeHeartbeatSweep({
    tracker: pairModeHeartbeatTracker,
    sessions: agentSessionsRepo,
    accountAudit: accountAuditService,
  });
  const pairModeHeartbeatSweepTimer = setInterval(() => {
    void (async () => {
      try {
        await pairModeHeartbeatSweep.tickOnce(new Date());
      } catch (err) {
        logger.warn(
          {
            component: 'pair-mode-heartbeat-sweep',
            err:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                : { value: err },
          },
          'pair-mode-heartbeat-sweep tickOnce threw unexpectedly (interval continues)',
        );
      }
    })();
  }, PAIR_MODE_HEARTBEAT_SWEEP_INTERVAL_MS);
  pairModeHeartbeatSweepTimer.unref();

  // AI credits slice S9 — the lease keeper. Every 15 seconds it renews the
  // leases of the tasks this process is running and settles up to fifty that
  // nobody is coming back for (§4.7, §5.3). Same shape as the pair-mode sweep
  // above and for the same reason: a 15-second promise cannot be made by a
  // 60-second poller, and a keeper that rode on `scheduled_jobs` would be
  // waiting on the very poller a stuck process is not running.
  //
  // NULL WHILE THE MODE IS OFF, so no timer is created and no query is made.
  const creditLeaseKeeperTimer =
    creditLeaseKeeper === null
      ? null
      : setInterval(() => {
          void (async () => {
            try {
              await creditLeaseKeeper.tickOnce();
            } catch (err) {
              logger.warn(
                {
                  component: 'ai-credit-lease-keeper',
                  err:
                    err instanceof Error
                      ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                      : { value: err },
                },
                'ai-credit-lease-keeper tickOnce threw unexpectedly (interval continues)',
              );
            }
          })();
        }, CREDIT_LEASE_KEEPER_INTERVAL_MS);
  creditLeaseKeeperTimer?.unref();

  // Webhook delivery worker — claims due deliveries (FOR UPDATE SKIP LOCKED,
  // multi-instance-safe) and POSTs the signed payload to the customer endpoint,
  // recording delivered / retry / DLQ. 60s tickOnce, mirroring the other
  // pollers. Outbound is SSRF-pinned at connect time (lib/ssrf-guarded-fetch)
  // and the failure-response read is size-capped. Without this poller, every
  // configured webhook enqueues but is never delivered (and replay routes that
  // re-set 'pending' never re-fire).
  // Pinned here rather than left to the worker's default so the ceiling is
  // explicit at the call site. It is the drain's POOL size — the most
  // deliveries in flight at once — and NOT its stop signal: see
  // drainWebhookDeliveries for why a short claim does not mean the queue is
  // empty.
  const WEBHOOK_DELIVERY_BATCH_SIZE = 25;
  const webhookDeliveryWorker = new WebhookDeliveryWorker({
    repo: webhooksRepo,
    batchSize: WEBHOOK_DELIVERY_BATCH_SIZE,
    logger,
    // Both delivery counters were registered at boot and emitted only from the
    // unwired successor, so they could never increment in production.
    ...(metricsRegistry !== undefined ? { metrics: metricsRegistry } : {}),
  });
  // Throughput. `tickOnce` claims at most DEFAULT_BATCH_SIZE (25) rows, so a
  // single tick on the 60s poller capped GLOBAL webhook delivery at ~25 per
  // minute across the whole deployment — a backlog from one busy account, or a
  // brief receiver outage anywhere, could never drain, and every other
  // customer's events queued behind it. That is a deployment-wide ceiling, not
  // a per-account one, so it does not scale with anything.
  //
  // The tick now DRAINS, through a bounded POOL of WEBHOOK_DELIVERY_BATCH_SIZE
  // slots: each slot that frees claims again at once. Bounded twice so a hot
  // queue cannot monopolise the process — a maximum number of deliveries per
  // tick (the old 20 batches' worth), and a wall-clock budget well inside the
  // poll interval; deliveries already started finish before the drain returns,
  // each bounded by the per-attempt timeout.
  //
  // Webhooks audit #2 (2026-09-24): it drained in BATCHES, and a batch lasted as
  // long as its slowest delivery, so one slow-but-succeeding endpoint with a
  // backlog set the length of every batch — about 3 batches per 30 s budget
  // instead of 20, for every account. In the pool a straggler holds only its
  // own capped share of the slots.
  const WEBHOOK_DRAIN_MAX_DELIVERIES = 20 * WEBHOOK_DELIVERY_BATCH_SIZE;
  const WEBHOOK_DRAIN_BUDGET_MS = 30_000;
  // setInterval does not await the previous tick, so a slow drain could
  // otherwise overlap itself and multiply in-flight deliveries. `claim` is
  // fenced on in_flight so overlap is not corrupting, but it is unbounded
  // concurrency against customer endpoints, which is its own problem.
  let webhookDeliveryRunning = false;
  const webhookDeliveryTimer = setInterval(() => {
    void (async () => {
      if (webhookDeliveryRunning) return;
      webhookDeliveryRunning = true;
      try {
        await webhookDeliveryWorker.drain({
          maxDeliveries: WEBHOOK_DRAIN_MAX_DELIVERIES,
          budgetMs: WEBHOOK_DRAIN_BUDGET_MS,
        });
      } catch (err) {
        logger.warn(
          {
            component: 'webhook-delivery-poller',
            err:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                : { value: err },
          },
          'webhook-delivery tickOnce threw unexpectedly (interval continues)',
        );
      } finally {
        webhookDeliveryRunning = false;
      }
    })();
  }, POLLER_INTERVAL_MS);
  webhookDeliveryTimer.unref();

  const teardown = shareFirstAsyncCall(async () => {
    logger.info({ component: 'bootstrap' }, 'tearing down');
    // V-232 — stop pollers BEFORE other teardown so no new tick is admitted
    // while Redis/Postgres close. clearInterval cannot cancel a tick that
    // already started; individual services retain their bounded best-effort
    // failure handling for that honest race.
    clearInterval(scheduledJobsTimer);
    clearInterval(validationHarnessTimer);
    if (healthProbeTimer) clearInterval(healthProbeTimer);
    if (statusSnapshotTimer) clearInterval(statusSnapshotTimer);
    clearInterval(pairModeHeartbeatSweepTimer);
    if (creditLeaseKeeperTimer) clearInterval(creditLeaseKeeperTimer);
    clearInterval(webhookDeliveryTimer);
    // The three closes are INDEPENDENT — a Redis client, a Postgres pool and
    // the Sentry transport share nothing — so they run CONCURRENTLY. In series
    // their budgets add, and the sum did not fit: index.ts already spends up to
    // CLOSE_DEADLINE_MS (10s) draining in-flight requests before teardown even
    // starts, and TimeoutStopSec is 20s.
    //
    // The sharper bug was that `redis.quit()` carried NO timeout and ran BEFORE
    // the Postgres close. An unreachable Redis — precisely the condition during
    // an incident deploy — blocked teardown indefinitely, so systemd SIGKILLed
    // the process before `dbHandle.close()` ever ran, leaking the Postgres
    // connections server-side until the backend timed them out. The bounded
    // close race in index.ts guarantees teardown STARTS inside the stop window;
    // it says nothing about teardown FINISHING, which is what this fixes.
    //
    // Concurrency also means one hung client can no longer starve the others:
    // the worst case is the LONGEST step, not the sum. Errors stay swallowed —
    // allSettled never rejects — because a failed close must not prevent
    // process.exit(0); a teardown that throws is a teardown that leaves the
    // deploy hanging.
    // H6 — hand this process's AI task leases back before the pool closes, so
    // the next boot's pass frees a deploy's slots and credit at once instead of
    // waiting out each 90-second lease. It settles nothing: only the lease
    // moves, and what each task costs is still decided by what it recorded.
    //
    // ⛔ STARTED HERE AND AWAITED BELOW, so it runs CONCURRENTLY with the
    // telemetry flush rather than after it. Both are one bounded write against
    // the same pool, and in series their deadlines would ADD to a shutdown
    // budget that already sits 250 ms inside the systemd stop window —
    // `shutdown-budget-fits-systemd-stop-window` does that arithmetic and reads
    // the maximum of the two from this shape. `withTeardownDeadline` never
    // rejects, so a promise held across the flush cannot become an unhandled
    // rejection, and a deadline that expires leaves exactly today's behaviour:
    // the leases lapse on their own 90-second schedule.
    const creditLeasesReleased =
      creditLeaseKeeper === null
        ? null
        : withTeardownDeadline(CREDIT_LEASE_RELEASE_DEADLINE_MS, () =>
            creditLeaseKeeper.releaseOwnLeases(),
          );
    await withTeardownDeadline(AGENT_TURN_TELEMETRY_FLUSH_DEADLINE_MS, () =>
      agentTurnTelemetry.flush(),
    );
    if (creditLeasesReleased !== null) await creditLeasesReleased;
    await Promise.allSettled([
      (async () => {
        await sentry.flush(2000);
        await sentry.close(2000);
      })(),
      withTeardownDeadline(REDIS_QUIT_DEADLINE_MS, () => redis.quit()),
      dbHandle.close(),
    ]);
    logger.info({ component: 'bootstrap' }, 'teardown complete');
  });

  // Log a one-line summary of the SDK init state at boot — easy
  // sanity check in production logs.
  // V-667.C — log which optional integrations registered at boot so
  // ops can confirm OAuth-client activation flipped on.
  const livekitActive =
    config.livekit?.apiKey !== undefined &&
    config.livekit?.apiSecret !== undefined &&
    config.livekit?.wsUrl !== undefined;
  const oauthClientActive =
    config.oauthClient !== undefined &&
    config.oauthClient.signingSecret !== undefined &&
    config.oauthClient.callbackUrlBase !== undefined &&
    (config.oauthClient.google !== undefined || config.oauthClient.github !== undefined);
  logger.info(
    {
      component: 'bootstrap',
      sentry: sentry.isInitialized,
      r2: r2 !== null,
      email: email.isConfigured,
      livekit: livekitActive,
      oauthClient: oauthClientActive,
      // v2-#27 — rotation-reminder activation state. ops uses this
      // line to confirm the v2-#17 daily sweeps are running in
      // production. `true` when neither timer was opt-out-disabled
      // via DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1.
      rotationReminders: !rotationRemindersDisabled,
      // `true` unless DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_WATCHDOG is set: the
      // line to check when no AI turn health issue has ever reached Sentry.
      agentTurnHealthWatchdog: !agentTurnHealthWatchdogDisabled,
      driver: config.driver,
      env: config.nodeEnv,
    },
    'bootstrap complete',
  );

  return {
    deps,
    handles: { db: dbHandle, redis, r2, email, sentry },
    teardown,
  };
}

/**
 * Q.1 — agent-decomposer selection. Returns the impl bootstrap
 * should wire into AppDeps per the Q.1.a + Q.1.a-open-answer
 * verdicts (2026-05-17):
 *
 *   1. If `DRIFTSTACK_AGENT_DECOMPOSER_FORCE=deterministic` is set,
 *      return DeterministicAgentDecomposer regardless of key state.
 *      Operator escape hatch for staging tests + prod incidents.
 *
 *   2. Otherwise, if EITHER the deployment fallback key
 *      (`config.byokAnthropic.fallbackApiKey`) OR per-customer BYOK
 *      storage (`MFA_ENCRYPTION_KEY` set, byokAnthropicService
 *      wired) is configured, return ClaudeAgentDecomposer. The
 *      route layer's key-resolution chain decides per-turn which
 *      path actually serves the request.
 *
 *   3. Otherwise return DeterministicAgentDecomposer as the safe
 *      default — agent-sessions routes still return planned /
 *      clarified output rather than 503ing the customer.
 *
 * Logs the choice at info level so the operator can verify which
 * impl wired without grepping env vars.
 */
export function selectAgentDecomposer(config: Config, logger: Logger): AgentDecomposer {
  if (config.agentDecomposer?.forceImpl === 'deterministic') {
    logger.info(
      { component: 'agent-decomposer' },
      'agentDecomposer wired as DeterministicAgentDecomposer (forced via DRIFTSTACK_AGENT_DECOMPOSER_FORCE=deterministic)',
    );
    return new DeterministicAgentDecomposer();
  }
  const hasFallbackKey = config.byokAnthropic?.fallbackApiKey !== undefined;
  const hasCustomerKeyStorage = config.mfaEncryptionKey !== undefined;
  if (hasFallbackKey || hasCustomerKeyStorage) {
    logger.info(
      {
        component: 'agent-decomposer',
        keying: { hasFallbackKey, hasCustomerKeyStorage },
      },
      'agentDecomposer wired as ClaudeAgentDecomposer',
    );
    return new ClaudeAgentDecomposer();
  }
  logger.info(
    { component: 'agent-decomposer' },
    'agentDecomposer wired as DeterministicAgentDecomposer (no Anthropic key path configured)',
  );
  return new DeterministicAgentDecomposer();
}
