// W439.B — drift guard for apps/server/src/lib/bootstrap.ts.
// Production AppDeps graph constructor + teardown. Drift here either
// turns a load-bearing dep (Postgres / Redis) into a degraded warn
// (deploy promotes broken) or skips a SIGTERM teardown step (zombie
// handles after shutdown).
//
//   • Pure-factory framing: external connections opened HERE so
//     SIGTERM closes them deterministically.
//   • Failure semantics: Postgres + Redis fail-fast (throw → /health
//     fails → orchestrator doesn't promote); R2 / Postmark / Sentry
//     init failure → warn + degraded (not request-critical-path);
//     readinessChecks per-/ready hit (decoupled).
//   • BootstrapResult: deps + handles (db/redis/r2/email/sentry) +
//     idempotent teardown.
//   • Sentry first (later init exceptions surface there).
//   • Fail-fast probes: SELECT 1 on Postgres; PING on Redis.
//   • V-216 accountAudit constructed early.
//   • V-204 emailPreferences constructed early (V-202c lifecycle
//     consumes it).
//   • V-202b/c lifecycle service (paired audit emit + email send);
//     founder verdict 2026-05-05 moved tier-change audit into
//     lifecycle.handleTierChanged.
//   • V-202d scheduled-jobs dispatcher (the `trial_pack.expired`
//     handler was removed 2026-05-27 with the trial_pack retirement).
//   • V-225 audit wiring for webhook + profile lifecycle.
//   • V-100 admin force-actions take direct repo + driver access.
//   • V-237 profilesRepo feeds /v1/account/me.
//   • V-295c2 status-snapshot writer (R2_BUCKET_PUBLIC gated).
//   • V-295c3-tombstone daily 24h status-subscriber purge (Privacy
//     §3.10 90d post-unsubscribe zero-out). This header used to repeat
//     the source's claim that the purge writes an actor-less admin
//     audit row; V-783 established that no such write exists or can —
//     both actor columns are NOT NULL with FKs and the purge has no
//     actor — so the claim is retracted here too.
//   • V-353b MFA gated by MFA_ENCRYPTION_KEY (32 random bytes b64).
//   • V-541.H real UsageAggregator over usage_records ledger.
//   • V-232 poller cadence 60s; founder-approved on V-202d ack
//     2026-05-06; setInterval wraps try/catch as defense-in-depth so
//     an unexpected throw NEVER kills the interval.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { shareFirstAsyncCall } from '../../src/lib/bootstrap.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W439.B apps/server/src/lib/bootstrap.ts content parity', () => {
  const body = read(LIB);

  it('gives concurrent lifecycle callers the exact first in-flight promise', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async (_signal: string) => held);
    const shared = shareFirstAsyncCall(operation);

    const first = shared('SIGTERM');
    const second = shared('SIGINT');

    expect(second).toBe(first);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    expect(operation).toHaveBeenCalledWith('SIGTERM');
    release?.();
    await Promise.all([first, second]);
  });

  it('builds the OAuth merge bearer link at the canonical static-page path', () => {
    expect(body).toMatch(/const confirmLink = canonicalOneTimeTokenUrl\(/);
    expect(body).toMatch(/`\$\{config\.dashboardOrigin\}\/auth\/oauth-client\/confirm-merge`/);
    expect(body).not.toMatch(/\/auth\/oauth-client\/confirm-merge\?token=/);
  });

  it('CLI authorization is activation-gated on MFA_ENCRYPTION_KEY so Redis never receives plaintext API keys', () => {
    expect(body).toMatch(
      /const cliAuthorizeService = config\.mfaEncryptionKey\s*\n?\s*\? new CliAuthorizeService\(\{/,
    );
    expect(body).toMatch(/secretEncryptionKeyBase64: config\.mfaEncryptionKey,/);
    expect(body).toMatch(
      /\.\.\.\(cliAuthorizeService !== undefined \? \{ cliAuthorizeService \} : \{\}\),/,
    );
  });

  it('wires the validated platform encryption key into the production agent-session repository', () => {
    expect(body).toMatch(
      /const agentSessionsRepo = new DrizzleAgentSessionsRepo\(dbHandle, \{\s*\.\.\.\(config\.mfaEncryptionKey !== undefined\s*\? \{ transcriptEncryptionKeyBase64: config\.mfaEncryptionKey \}\s*: \{\}\),\s*\}\);/,
    );
  });

  it('authenticates and synchronously drains legacy agent transcripts to v2 before serving', () => {
    expect(body).toMatch(/const MAX_AGENT_TRANSCRIPT_BOOT_MIGRATION_ROWS = 10_000;/);
    expect(body).toMatch(/await agentSessionsRepo\.migrateTranscriptEnvelopes\(500\)/);
    expect(body).toMatch(/while \(remaining > 0\);/);
    expect(body).toMatch(/batch\.scanned === 0 \|\| batch\.converted === 0/);
    expect(body).toMatch(/scanned >= MAX_AGENT_TRANSCRIPT_BOOT_MIGRATION_ROWS/);
    expect(body).toMatch(/record-bound v2 before serving/);
    expect(body).toMatch(/new writes fail closed/);
  });

  it('wires recipe payload encryption and synchronously drains legacy rows to record-bound v2', () => {
    expect(body).toMatch(
      /const recipesRepo = new DrizzleRecipesRepo\(dbHandle, \{[\s\S]*?payloadEncryptionKeyBase64: config\.mfaEncryptionKey[\s\S]*?\}\);/,
    );
    expect(body).toMatch(/const MAX_RECIPE_PAYLOAD_BOOT_MIGRATION_ROWS = 10_000;/);
    expect(body).toMatch(/await recipesRepo\.migratePayloadEnvelopes\(500\)/);
    expect(body).toMatch(/while \(remaining > 0\);/);
    expect(body).toMatch(/batch\.scanned === 0 \|\| batch\.converted === 0/);
    expect(body).toMatch(/scanned >= MAX_RECIPE_PAYLOAD_BOOT_MIGRATION_ROWS/);
    expect(body).toMatch(/record-bound v2 before serving/);
    expect(body).not.toMatch(/recipePayloadUpgradeTimer/);
    expect(body).toMatch(/new recipe writes fail closed/);
  });

  it('wires webhook encryption and synchronously drains every legacy row to record-bound v2 before serving', () => {
    expect(body).toMatch(
      /const webhooksRepo = new DrizzleWebhooksRepo\(dbHandle, \{[\s\S]*?secretEncryptionKeyBase64: config\.mfaEncryptionKey[\s\S]*?\}\);/,
    );
    expect(body).toMatch(/const MAX_WEBHOOK_SECRET_BOOT_MIGRATION_ROWS = 10_000;/);
    expect(body).toMatch(/const batch = await webhooksRepo\.encryptLegacySecrets\(500\);/);
    expect(body).toMatch(/while \(remaining > 0\);/);
    expect(body).toMatch(/batch\.scanned === 0 \|\| batch\.converted === 0/);
    expect(body).toMatch(/scanned >= MAX_WEBHOOK_SECRET_BOOT_MIGRATION_ROWS/);
    expect(body).toMatch(/record-bound v2 before serving/);
    expect(body).toMatch(
      /encrypted webhook secrets are unreadable and new secret writes fail closed/,
    );
    expect(body).not.toMatch(/WEBHOOK_SECRET_UPGRADE_INTERVAL_MS/);
    expect(body).not.toMatch(/webhookSecretUpgradeTimer/);
    expect(body).not.toMatch(/webhookSecretUpgradeInFlight/);
  });

  it('synchronously drains platform-secret values to name-bound v2 before service construction', () => {
    expect(body).toContain('const platformSecretsRepo = new DrizzlePlatformSecretsRepo(dbHandle);');
    expect(body).toContain('const MAX_PLATFORM_SECRET_VALUE_BOOT_MIGRATION_ROWS = 10_000;');
    expect(body).toContain('await platformSecretsRepo.migrateValueEnvelopes(');
    expect(body).toContain('Platform-secret value migration made no progress');
    expect(body).toContain(
      'legacy platform-secret values migrated to name-bound v2 before serving',
    );
    expect(body.indexOf('migrateValueEnvelopes')).toBeLessThan(
      body.indexOf('new PlatformSecretsService('),
    );
    expect(body).not.toMatch(/platformSecretValueUpgradeTimer/);
  });

  it('header framing pinned: pure-factory; pass-in deps NOT lazy; every external connection (Postgres pool, Redis, R2, Sentry, Postmark) opened HERE so SIGTERM handler closes them deterministically', () => {
    expect(body).toMatch(/\/\/ Production bootstrap\./);
    expect(body).toMatch(
      /\/\/ Constructs the full AppDeps graph from config \+ a logger, returning\s*\n?\s*\/\/ the deps \+ a teardown function for graceful shutdown\. The shape is\s*\n?\s*\/\/ pure-factory: pass-in dependencies are not constructed lazily, and\s*\n?\s*\/\/ every external connection \(Postgres pool, Redis client, R2 client,\s*\n?\s*\/\/ Sentry, Postmark\) is opened here, so the SIGTERM handler can close\s*\n?\s*\/\/ them deterministically\./,
    );
  });

  it('Failure semantics framing pinned: Postgres connection failure → throw (deploy /health fails → orchestrator does not promote); Redis fail → throw (auth-cache + rate-limit-store load-bearing); R2/Postmark/Sentry init fail → log warn → degraded mode no-op (NOT request critical path); readinessChecks per /ready hit (Health checks decoupled)', () => {
    expect(body).toMatch(
      /\/\/ Failure semantics:\s*\n?\s*\/\/\s*- Postgres connection failure at boot → throw\. The deploy\s*\n?\s*\/\/\s*pipeline's \/health probe will fail; orchestrator will not\s*\n?\s*\/\/\s*promote\.\s*\n?\s*\/\/\s*- Redis connection failure at boot → throw \(same reasoning;\s*\n?\s*\/\/\s*auth-cache \+ rate-limit-store are load-bearing\)\.\s*\n?\s*\/\/\s*- R2 \/ Postmark \/ Sentry init failure at boot → log warn; the\s*\n?\s*\/\/\s*service starts in degraded mode \(those features no-op\)\. These\s*\n?\s*\/\/\s*are not on the request critical path\.\s*\n?\s*\/\/\s*- readinessChecks fire every \/ready hit\. \/ready 503 on any\s*\n?\s*\/\/\s*reachable-but-failing dep\. Health checks are decoupled\./,
    );
  });

  it('BootstrapResult: deps + handles (db/redis/r2/email/sentry) for SIGTERM ordered close + idempotent teardown rationale', () => {
    expect(body).toMatch(
      /export interface BootstrapResult \{\s*\n?\s*deps: AppDeps;\s*\n?\s*\/\*\* Live handles — exposed so SIGTERM can close them in order\. \*\/\s*\n?\s*handles: \{\s*\n?\s*db: Database;\s*\n?\s*redis: Redis;\s*\n?\s*r2: R2 \| null;\s*\n?\s*email: EmailService;\s*\n?\s*sentry: SentryClient;\s*\n?\s*\};\s*\n?\s*\/\*\* Close everything in the right order; idempotent\. \*\/\s*\n?\s*teardown: \(\) => Promise<void>;\s*\n?\s*\}/,
    );
  });

  it('Sentry first rationale + Postgres SELECT 1 fail-fast probe + Redis lazyConnect:false maxRetries 3 + PING; explicit logger.info on each connect', () => {
    expect(body).toMatch(
      /\/\/ Sentry first — so any later init exceptions surface there too\.\s*\n?\s*const sentry = initSentry\(\{ config: config\.sentry, logger \}\);/,
    );
    expect(body).toMatch(
      /\/\/ Postgres pool\. Fail-fast probe `SELECT 1` so a misconfigured\s*\n?\s*\/\/ DATABASE_URL surfaces at boot, not on the first request\./,
    );
    expect(body).toMatch(/await dbHandle\.client`SELECT 1`;/);
    expect(body).toMatch(
      /\/\/ Redis \(single client for both auth cache \+ rate limit store —\s*\n?\s*\/\/ they share the same connection but use distinct key prefixes\)\.\s*\n?\s*\/\/ PING at boot for the same fail-fast posture as Postgres\./,
    );
    expect(body).toMatch(
      /const redis = new Redis\(config\.redisUrl, \{\s*\n?\s*lazyConnect: false,\s*\n?\s*maxRetriesPerRequest: 3,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/await redis\.ping\(\);/);
  });

  it("R2/Postmark optional + warn-when-unconfigured framing: 'R2 not configured — recordings durability + presigned URLs disabled. Set R2_* env vars to enable.'", () => {
    expect(body).toMatch(
      /\/\/ R2 — optional\. Null if env not configured \(logged below\)\.\s*\n?\s*const r2 = config\.r2 !== null \? createR2Client\(config\.r2\) : null;/,
    );
    expect(body).toMatch(
      /'R2 not configured — recordings durability \+ presigned URLs disabled\. Set R2_\* env vars to enable\.',/,
    );
    // Arc 7 obs.13 — email service construction moved later in
    // bootstrap so the metrics registry can be threaded in at
    // construction time (email_send_total counter). The earlier
    // "Postmark email — optional. No-op if not configured." comment
    // is retained at the original location as a deferred-construction
    // marker; the actual createEmailService() call now happens after
    // the metrics registry block with the metrics dep wired in.
    expect(body).toMatch(
      /\/\/ Postmark email — optional\. No-op if not configured\. Constructed\s*\n?\s*\/\/ lazily AFTER the metrics registry below/,
    );
    expect(body).toMatch(
      /const email: EmailService = createEmailService\(\{\s*\n?\s*config: config\.postmark,\s*\n?\s*logger,\s*\n?\s*\.\.\.\(metricsRegistry !== undefined \? \{ metrics: metricsRegistry \} : \{\}\),\s*\n?\s*accountEmailDeliveryTracker: createDrizzleAccountEmailDeliveryTracker\(dbHandle\),\s*\n?\s*sentry,\s*\n?\s*\}\);/,
    );
  });

  it('V-216 framing pinned: accountAudit constructed early so emit-on-event services downstream (webhooks, sessions, api-keys, profiles) can wire it; V-204 emailPreferences constructed early because V-202c lifecycle consumes it for opt-out checks', () => {
    expect(body).toMatch(
      /\/\/ V-216 — customer-facing audit log; constructed early so all\s*\n?\s*\/\/ emit-on-event services downstream \(webhooks, sessions, api-keys,\s*\n?\s*\/\/ profiles\) can wire it\./,
    );
    expect(body).toMatch(
      /\/\/ V-204 — email notification preferences\. Constructed early because\s*\n?\s*\/\/ V-202c lifecycle service consumes it for opt-out checks\./,
    );
  });

  it('V-202c/V-202b lifecycle framing pinned: paired audit-emit + email-send for events with both surfaces (session.failed.first / subscription.tier_changed); V-202b moved V-226 tier-change audit emit from StripeWebhooksService into lifecycle.handleTierChanged (founder verdict 2026-05-05) — pair behind ONE call. (trial_pack_purchased removed with the dead trial_pack lifecycle.)', () => {
    expect(body).toMatch(
      /\/\/ V-202c \/ V-202b — account lifecycle dispatcher \(paired audit emit \+\s*\n?\s*\/\/ email send for events that have both surfaces\)\. Wires\s*\n?\s*\/\/ `session\.failed\.first`, `subscription\.tier_changed`\. V-202b moved the V-226\s*\n?\s*\/\/ tier-change audit emit from StripeWebhooksService into\s*\n?\s*\/\/ lifecycle\.handleTierChanged so the audit \+ email pair lives behind\s*\n?\s*\/\/ one call \(founder verdict 2026-05-05\)\./,
    );
    expect(body).not.toMatch(/`subscription\.trial_pack_purchased`/);
    expect(body).toMatch(/accountAuditService, \/\/ V-202b — required for tier_changed audit emit/);
  });

  it('V-202d scheduled-jobs framing pinned: generic dispatcher; trial_pack.expired handler removed 2026-05-27; dispatcher remains for auth_tokens.sweep + cost.recompute_nightly; V-747 workerId is unique PER PROCESS (pid@host-random) because the settle fence keys on it — pid alone is PID 1 in a container, so it collided across replicas and was stable across restarts', () => {
    expect(body).toMatch(
      /\/\/ V-202d — generic scheduled-jobs dispatcher\. The trial_pack\.expired\s*\n?\s*\/\/ handler was removed 2026-05-27 with the trial_pack retirement; the\s*\n?\s*\/\/ dispatcher remains for the other registered cron-shaped jobs\s*\n?\s*\/\/ \(auth_tokens\.sweep, cost\.recompute_nightly\) via `register\(\.\.\.\)`\./,
    );
    // V-747 — this pinned "`<process-pid>@<host>` is sufficient ... multi-replica
    // safety still works because SELECT FOR UPDATE SKIP LOCKED ... not the
    // workerId". Two problems: the code never had the `@<host>` part the comment
    // described, and the SKIP-LOCKED argument only covers the CLAIM — the settle
    // fence added in V-747 keys on locked_by, so uniqueness became load-bearing.
    expect(body).toMatch(
      /SKIP LOCKED is what guarantees\s*\n?\s*\/\/ mutual exclusion at CLAIM time/,
    );
    expect(body).toMatch(/must therefore be unique per PROCESS/);
    expect(body).toMatch(/a\s*\n?\s*\/\/\s*containerised app is usually PID 1/);
    expect(body).toMatch(
      /workerId: `pid-\$\{process\.pid\.toString\(\)\}@\$\{hostname\(\)\}-\$\{randomUUID\(\)\.slice\(0, 8\)\}`/,
    );
    // The old "sufficient" framing must not come back.
    expect(body).not.toMatch(/is sufficient here —/);
  });

  it('V-225 wiring framing pinned for both webhooks (created/deleted) and profiles (created/deleted); V-049 legalService gate on ApiKeysService; V-216 accountAudit wired for api-keys customer-facing audit emit', () => {
    expect(body).toMatch(
      /\/\/ Webhooks first so sessions \+ api-keys can wire it\.\s*\n?\s*\/\/ V-225 — accountAudit wired for webhook_endpoint\.\{created,deleted\}\./,
    );
    expect(body).toMatch(
      /\/\/ V-081: Profiles service\.\s*\n?\s*\/\/ V-225 — accountAudit wired for profile\.\{created,deleted\}\./,
    );
    expect(body).toMatch(
      /\/\/ ApiKeysService needs legalService \(V-049 issuance gate\)\.\s*\n?\s*\/\/ V-216: also wires accountAuditService for customer-facing audit emit\./,
    );
  });

  it("V-353b MFA gate framing pinned: active ONLY when MFA_ENCRYPTION_KEY configured (32 random bytes base64); when unset, /v1/account/mfa/* routes simply don't register (avoids registering routes that would write to a table we can't decrypt back from); explicit generate-key recipe in warn message", () => {
    expect(body).toMatch(
      /\/\/ V-353b — MFA service\. Active only when MFA_ENCRYPTION_KEY is\s*\n?\s*\/\/ configured \(32 random bytes, base64-encoded\)\. When unset, the\s*\n?\s*\/\/ \/v1\/account\/mfa\/\* routes simply don't register and customers\s*\n?\s*\/\/ can't enroll\. Generate the key with:\s*\n?\s*\/\/\s*node -e "console\.log\(require\('crypto'\)\.randomBytes\(32\)\.toString\('base64'\)\)"\s*\n?\s*\/\/ and set as MFA_ENCRYPTION_KEY in deploy env\./,
    );
    expect(body).toMatch(
      /'MFA_ENCRYPTION_KEY not set — \/v1\/account\/mfa\/\* routes disabled\. ' \+/,
    );
  });

  it('synchronously drains legacy MFA tuples to account-bound v2 before constructing the service', () => {
    expect(body).toMatch(/const mfaRepo = new DrizzleMfaRepo\(dbHandle\);/);
    expect(body).toMatch(/const MAX_MFA_SECRET_BOOT_MIGRATION_ROWS = 10_000;/);
    expect(body).toMatch(
      /await mfaRepo\.migrateTotpSecretEnvelopes\(config\.mfaEncryptionKey, 500\)/,
    );
    expect(body).toMatch(/batch\.scanned === 0 \|\| batch\.converted === 0/);
    expect(body).toMatch(/scanned >= MAX_MFA_SECRET_BOOT_MIGRATION_ROWS/);
    expect(body).toMatch(/account-bound v2 before serving/);
    expect(body).toMatch(/new MfaService\(\s*mfaRepo,/);
  });

  it('drains legacy LiveKit API secrets to node-bound v2 before route composition', () => {
    expect(body).toMatch(/const drizzleFleetNodesRepo = new DrizzleFleetNodesRepo\(dbHandle\);/);
    expect(body).toMatch(/const MAX_LIVEKIT_SECRET_BOOT_MIGRATION_ROWS = 10_000;/);
    expect(body).toMatch(
      /await drizzleFleetNodesRepo\.migrateLivekitSecretEnvelopes\(\s*config\.mfaEncryptionKey,\s*500,\s*\)/,
    );
    expect(body).toMatch(/batch\.scanned === 0 \|\| batch\.converted === 0/);
    expect(body).toMatch(/scanned >= MAX_LIVEKIT_SECRET_BOOT_MIGRATION_ROWS/);
    expect(body).toContain('legacy LiveKit API secrets migrated to node-bound v2 before serving');
  });

  it('drains legacy profile DEK wrappers to profile-bound v2 before constructing profile/proxy services', () => {
    expect(body).toContain('const profilesRepo = new DrizzleProfilesRepo(dbHandle);');
    expect(body).toContain('const MAX_PROFILE_DEK_BOOT_MIGRATION_ROWS = 10_000;');
    expect(body).toContain(
      'await profilesRepo.migrateWrappedDekEnvelopes(profileMasterKeyBuf, 500)',
    );
    expect(body).toContain('batch.scanned === 0 || batch.converted === 0');
    expect(body).toContain('scanned >= MAX_PROFILE_DEK_BOOT_MIGRATION_ROWS');
    expect(body).toContain('legacy profile DEKs migrated to profile-bound v2 before serving');
    expect(body.indexOf('migrateWrappedDekEnvelopes')).toBeLessThan(
      body.indexOf('const accountProxiesService = new AccountProxiesService'),
    );
    expect(body.indexOf('migrateWrappedDekEnvelopes')).toBeLessThan(
      body.indexOf('const profilesService = new ProfilesService'),
    );
    expect(body).toMatch(
      /const profileSnapshotsService = new ProfileSnapshotsService\(\s*new DrizzleProfileSnapshotsRepo\(dbHandle\),\s*profilesRepo,\s*accountAuditService,\s*profileMasterKeyBuf,\s*\);/,
    );
  });

  it('synchronously drains legacy account-proxy secrets to record-bound v2 before constructing the dispatch service', () => {
    expect(body).toContain('const accountProxiesRepo = new DrizzleAccountProxiesRepo(dbHandle);');
    expect(body).toContain('const MAX_ACCOUNT_PROXY_SECRET_BOOT_MIGRATION_ROWS = 10_000;');
    expect(body).toContain(
      'await accountProxiesRepo.migrateSecretEnvelopes(profileMasterKeyBuf, 500)',
    );
    expect(body).toContain('batch.scanned === 0 || batch.converted === 0');
    expect(body).toContain('proxyScanned >= MAX_ACCOUNT_PROXY_SECRET_BOOT_MIGRATION_ROWS');
    expect(body).toContain(
      'legacy account proxy secrets migrated to record-bound v2 before serving',
    );
    expect(body.indexOf('migrateSecretEnvelopes')).toBeLessThan(
      body.indexOf('const accountProxiesService = new AccountProxiesService'),
    );
    expect(body).toContain('encrypted account proxies are unreadable');
  });

  it('V-295c2 status-snapshot framing pinned: separate public-readable R2 bucket (recordings bucket intentionally NOT used — recordings contain Customer Data and must remain private); fall-back when live API fetch fails; active ONLY when R2_BUCKET_PUBLIC configured', () => {
    expect(body).toMatch(
      /\/\/ V-295c2 — public status snapshot writer\. Writes the same data the\s*\n?\s*\/\/ public \/v1\/status\/incidents endpoint surfaces to a SEPARATE\s*\n?\s*\/\/ public-readable R2 bucket so the status site can fall back to the\s*\n?\s*\/\/ snapshot when the live API fetch fails\. The recordings bucket is\s*\n?\s*\/\/ intentionally NOT used — recordings contain Customer Data and must\s*\n?\s*\/\/ remain private\. Active only when R2_BUCKET_PUBLIC is configured\./,
    );
  });

  it('V-295c3-tombstone framing pinned: Privacy §3.10 90d post-unsubscribe email zero-out, now a durable daily job chain. TWO claims were retracted here and both are held down per-occurrence. V-783: the comment asserted the purge writes admin_audit_log with a null adminAccountId and that the repo accepts null for system actions — both false, the column is NOT NULL with an FK, so no such write has ever happened or could. V-784: it also said the first tick fires 24h after boot and called that acceptable, which was true of the setInterval and was exactly the bug — a process restarting more often than daily never reached the first tick, so the §3.10 sweep did not run at all.', () => {
    expect(body).toMatch(
      /\/\/ V-295c3-tombstone — status-subscriber email purge\. Privacy §3\.10 promises\s*\n?\s*\/\/ 90d post-unsubscribe email zero-out\./,
    );
    expect(body).toMatch(/jobType: STATUS_SUBSCRIBER_PURGE_JOB_TYPE,/);

    // Per-occurrence negatives on both retracted claims. A positive regex would
    // still match if the false sentences were merely moved further down, so the
    // corrections are asserted as the ABSENCE of each half of each one.
    expect(body).not.toMatch(/Audit-logs each purge as a system action/);
    expect(body).not.toMatch(/adminAccountId set to null/);
    expect(body).not.toMatch(/audit-log repo accepts null adminAccountId/);
    expect(body).not.toMatch(/first tick fires 24h after boot/);
    expect(body).not.toMatch(/STATUS_PURGE_INTERVAL_MS/);
    expect(body).not.toMatch(/statusPurgeTimer/);
    expect(
      body,
      'the V-783 retraction itself must be present, not just the old text absent',
    ).toMatch(/V-783 — this used to claim the purge records each row in the admin audit/);
    expect(body, 'and the V-784 reason the timer had to go').toMatch(
      /a process that restarts more often than once a day never/,
    );
  });

  it('V-232 poller framing pinned: 60s cadence (V-173 webhook-worker convention; minute-level latency tolerance); founder-approved on V-202d ack 2026-05-06; setInterval wraps try/catch as defense-in-depth — unexpected throw must NEVER kill the interval, or background work silently stops; .unref() so app close cleanly on SIGINT without waiting next tick', () => {
    expect(body).toMatch(
      /\/\/ V-232 — background poller startup\. Both processTick methods own\s*\n?\s*\/\/ their own claim\/dispatch\/retry semantics; the bootstrap layer just\s*\n?\s*\/\/ calls them on a 60s timer\. 60s cadence is the V-173 webhook-worker\s*\n?\s*\/\/ convention; trial-pack expiry and validation-harness scheduling\s*\n?\s*\/\/ both have minute-level latency tolerance, so this matches\./,
    );
    expect(body).toMatch(/\/\/ Founder-approved cadence on V-202d ack \(2026-05-06\)\./);
    expect(body).toMatch(
      /\/\/ Errors inside the tick are caught \+ logged warn-level by the\s*\n?\s*\/\/ services themselves; the setInterval handler still wraps in a\s*\n?\s*\/\/ try\/catch as a defense-in-depth: an unexpected throw must NEVER\s*\n?\s*\/\/ kill the interval, or background work silently stops\./,
    );
    expect(body).toMatch(/const POLLER_INTERVAL_MS = 60_000;/);
    expect(body).toMatch(/scheduledJobsTimer\.unref\(\);/);
  });

  it('Webhook delivery worker IS wired (drift-guard against the original unwired-in-prod gap): constructed with the webhooks repo + logger, driven by a 60s draining poller, .unref()-ed, and clearInterval-ed in teardown — without this the worker would never run and configured webhooks would never deliver', () => {
    // Re-pinned when the worker gained a metrics dependency. Both delivery
    // counters were registered at boot and emitted only from the unwired
    // DurableWebhookWorker, so in production they could never increment.
    // Asserted as the construction and its wiring rather than one exact
    // argument rendering, which reformatting breaks while proving nothing.
    expect(body).toMatch(/const webhookDeliveryWorker = new WebhookDeliveryWorker\(\{/);
    expect(body).toMatch(/repo: webhooksRepo,/);
    expect(body).toMatch(/metrics: metricsRegistry/);
    // The poller now DRAINS rather than running a single tick: `claim` caps at
    // 5 rows per endpoint, so one tick left a single backlogged endpoint
    // delivering 5/minute. The loop and its stop condition live in
    // drainWebhookDeliveries so they are behaviourally testable — pinned
    // here only as the wiring.
    expect(body).toMatch(/await drainWebhookDeliveries\(\{/);
    expect(body).toMatch(/tick: \(\) => webhookDeliveryWorker\.tickOnce\(\),/);
    expect(body).toMatch(/webhookDeliveryTimer\.unref\(\);/);
    // The drain loop (a469de115) has no behavioural coverage anywhere — it lives
    // inline in a setInterval closure that no test constructs, so these are
    // wiring pins rather than proofs. Stated plainly because a text pin is the
    // weaker instrument: it proves the line exists, not that it works.
    //
    // The one that matters is the `finally`. `webhookDeliveryRunning` is a
    // module-scoped latch: set before the drain, and if it is ever not cleared,
    // EVERY later tick returns at the guard and webhook delivery stops for the
    // life of the process — no error, no metric, no log. A reset that lives
    // anywhere but a `finally` is one thrown exception away from that, and the
    // catch above it does not cover a throw from the catch itself.
    expect(body).toMatch(/\} finally \{\s*\n?\s*webhookDeliveryRunning = false;/);
    // The latch itself: without the early return, ticks overlap and a slow drain
    // stacks on the next interval.
    expect(body).toMatch(/if \(webhookDeliveryRunning\) return;/);
    // Both bounds must reach the drain, but this pins that they are WIRED, not
    // where the loop lives. The first version asserted the `break` statements
    // inline — which promptly failed the moment the loop was extracted into a
    // testable `drainWebhookDeliveries`, i.e. a guard of mine blocking someone
    // else's strictly better refactor. Pinning a structure dictates an
    // implementation; pinning that bootstrap supplies both bounds does not, and
    // holds whether the loop is inline or delegated.
    // Counted, not merely present. `toContain` matched the DECLARATION even
    // after the constant stopped being passed anywhere — found by mutation, and
    // it is the same "a pin proves the line exists, not that it does anything"
    // trap this file warns about elsewhere. A declared-but-unused constant
    // appears once; a wired one appears at least twice.
    for (const name of [
      'WEBHOOK_DRAIN_MAX_BATCHES',
      'WEBHOOK_DRAIN_BUDGET_MS',
      'WEBHOOK_DELIVERY_BATCH_SIZE',
    ]) {
      const uses = body.split(name).length - 1;
      expect(uses, `${name} must be declared AND used, not just declared`).toBeGreaterThan(1);
    }
    // The budget must stay inside the poll interval, or a tick can still be
    // draining when the next one is due. Computed, not pinned as a literal.
    const drainBudget = Number(
      /const WEBHOOK_DRAIN_BUDGET_MS = ([\d_]+);/.exec(body)?.[1]?.replace(/_/g, '') ?? '0',
    );
    const pollInterval = Number(
      /const POLLER_INTERVAL_MS = ([\d_ *]+);/
        .exec(body)?.[1]
        ?.replace(/_/g, '')
        ?.split('*')
        .reduce((a, b) => a * Number(b.trim()), 1) ?? 0,
    );
    expect(drainBudget, 'drain budget parsed').toBeGreaterThan(0);
    expect(pollInterval, 'poll interval parsed').toBeGreaterThan(0);
    expect(
      drainBudget,
      `drain budget ${String(drainBudget)}ms must stay inside the ${String(pollInterval)}ms poll interval`,
    ).toBeLessThan(pollInterval);

    expect(body).toMatch(/clearInterval\(webhookDeliveryTimer\);/);
  });

  it("V-541.H framing pinned: real UsageAggregator over V-073 usage_records ledger; fills sessionMinutes from real data; other dimensions (storage/egress/email/llm) zero placeholders until per-account meters land (V-541.I/J/K follow-ups); CostMonitoring resolveTier reads from billingRepo.getAccount.tier — same source billingService uses → can't drift", () => {
    expect(body).toMatch(
      /\/\/ V-541\.H — real UsageAggregator over the V-073 usage_records\s*\n?\s*\/\/ ledger\. Fills `sessionMinutes` from real data; other dimensions\s*\n?\s*\/\/ \(storage, egress, email, llm\) are zero placeholders until their\s*\n?\s*\/\/ per-account meters land \(V-541\.I\/J\/K follow-ups\)\./,
    );
    expect(body).toMatch(
      /resolveTier: async \(accountId\) => \{\s*\n?\s*const acc = await new DrizzleBillingRepo\(dbHandle\)\.getAccount\(accountId\);\s*\n?\s*return acc\?\.tier \?\? null;\s*\n?\s*\},/,
    );
  });

  it('Teardown framing pinned: one shared first-call promise; no new poller ticks after cleanup starts; the three independent closes run CONCURRENTLY via allSettled (sentry flush+close 2s, a deadline-bounded redis.quit, dbHandle.close) so their budgets no longer add and one hung client cannot starve the others', () => {
    expect(body).toMatch(
      /\/\/ V-232 — stop pollers BEFORE other teardown so no new tick is admitted\s*\n?\s*\/\/ while Redis\/Postgres close\. clearInterval cannot cancel a tick that\s*\n?\s*\/\/ already started;/,
    );
    expect(body).toMatch(
      /const teardown = shareFirstAsyncCall\(async \(\) => \{\s*\n?\s*logger\.info\(\{ component: 'bootstrap' \}, 'tearing down'\);/,
    );
    expect(body).toContain('owner ??= Promise.resolve().then(() => operation(...args));');
    // Sentry's own two calls stay sequential with each other inside one arm;
    // it is the three ARMS that are concurrent. The budget arithmetic in
    // shutdown-budget-fits-systemd-stop-window depends on exactly that shape.
    expect(body).toMatch(
      /await Promise\.allSettled\(\[\s*\n?\s*\(async \(\) => \{\s*\n?\s*await sentry\.flush\(2000\);\s*\n?\s*await sentry\.close\(2000\);\s*\n?\s*\}\)\(\),/,
    );
    expect(body).toContain('withTeardownDeadline(REDIS_QUIT_DEADLINE_MS, () => redis.quit()),');
    expect(body).toContain('export const REDIS_QUIT_DEADLINE_MS = 2_000;');
  });

  it('v2-#17 rotation-reminder daily sweeps framing pinned: pure-sweep nags (no auto-rotation); default-on; DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS opts out via envFlag (true/1/yes/on). V-784 replaced the two 24h setInterval timers with durable job chains, so the interval constant, the .unref()s and the teardown clearIntervals this used to pin are gone and are asserted absent instead — a reintroduced timer would mean a reminder that never fires on a sub-daily deploy cadence.', () => {
    expect(body).toMatch(
      /\/\/ v2-#17 — daily rotation-reminder sweeps for webhook signing secrets\s*\n?\s*\/\/ \(v2-#10\/#10\.5\/#10\.6\) and BYOK Anthropic API keys \(v2-#11\/#11\.5\/#11\.6\)\.\s*\n?\s*\/\/ Both reminder services are pure-sweep nags \(no auto-rotation\); the\s*\n?\s*\/\/ services skip rows that don't need a reminder yet, so the per-tick\s*\n?\s*\/\/ burst is bounded by perTickLimit \(default 50\)\. Default-on for\s*\n?\s*\/\/ production; the operator can flip\s*\n?\s*\/\/ DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1 to suppress when a\s*\n?\s*\/\/ customer-quiet account wants to silence the nag/,
    );
    expect(body).toMatch(
      /envFlag\(\s*process\.env\.DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS,?\s*\)/,
    );
    expect(body).toMatch(
      /new WebhookRotationReminderService\(\s*\n?\s*new DrizzleWebhookRotationReminderRepo\(dbHandle, \{[\s\S]*?secretEncryptionKeyBase64: config\.mfaEncryptionKey[\s\S]*?\}\),/,
    );
    expect(body).toMatch(
      /new ByokAnthropicRotationReminderService\(\s*\n?\s*new DrizzleByokAnthropicRotationReminderRepo\(dbHandle\),/,
    );
    // V-784 — both reminders are now durable chains, armed at boot alongside
    // the other eleven. Asserted as the wiring call plus the per-occurrence
    // absence of every timer artefact this pin used to freeze.
    expect(body).toMatch(/jobType: WEBHOOK_ROTATION_REMINDER_JOB_TYPE,/);
    expect(body).toMatch(/jobType: BYOK_ANTHROPIC_ROTATION_REMINDER_JOB_TYPE,/);
    expect(body).not.toMatch(/ROTATION_REMINDER_INTERVAL_MS/);
    expect(body).not.toMatch(/webhookRotationReminderTimer/);
    expect(body).not.toMatch(/byokAnthropicRotationReminderTimer/);
  });

  it('v2-#27 bootstrap-complete log line surfaces rotationReminders state alongside the other activation flags so ops can confirm the v2-#17 daily sweeps are live', () => {
    // The log line carries `rotationReminders: !rotationRemindersDisabled`
    // — pinned as a substring match because the surrounding object
    // literal already has its shape pinned by the activation-flag
    // tests.
    expect(body).toMatch(/rotationReminders:\s*!rotationRemindersDisabled/);
  });

  it("V-541.E cost-nightly-job wired in bootstrap: CostAlertDispatcher with logger-only sendAlert sink + DrizzleCostNightlyAccountIdProvider + registerCostNightlyJob + enqueueNextNightlyRun on app start. Pinned 2026-05-20 so a future refactor can't silently drop the wire-up and leave the V-541.E nightly recompute unfired (memory rule: cost-nightly-job had the right shape but was unwired until this slice).", () => {
    expect(body).toMatch(
      /import \{ CostAlertDispatcher \} from '\.\.\/services\/cost-alert-dispatcher\.js';/,
    );
    expect(body).toMatch(
      /import \{ registerCostNightlyJob, enqueueNextNightlyRun \} from '\.\.\/services\/cost-nightly-job\.js';/,
    );
    expect(body).toMatch(
      /import \{ DrizzleCostNightlyAccountIdProvider \} from '\.\.\/db\/cost-nightly-accounts-provider\.js';/,
    );
    expect(body).toMatch(/const costAlertDispatcher = new CostAlertDispatcher\(\{/);
    expect(body).toMatch(/service: costMonitoringService,/);
    // Logger-only sink: structured `cost.threshold_alert` line; pin
    // the component name + alert field set so a refactor can't silently
    // drop the per-alert log without explicit intent.
    expect(body).toMatch(/component: 'cost-alert',/);
    expect(body).toMatch(/'cost\.threshold_alert'/);
    expect(body).toMatch(/registerCostNightlyJob\(\{/);
    expect(body).toMatch(/accounts: new DrizzleCostNightlyAccountIdProvider\(dbHandle\),/);
    expect(body).toMatch(
      /await enqueueNextNightlyRun\(\{ scheduledJobs: scheduledJobsService \}\);/,
    );
  });

  it("2026-05-20 GUI panel NotificationEventBus wired in bootstrap + cost-alert dispatcher dual-publishes to bus (logger + bus, both load-bearing) — pinned so a refactor can't silently drop the bus publish and leave the GUI notification stream without its first source", () => {
    expect(body).toMatch(
      /import \{ NotificationEventBus \} from '\.\.\/services\/notification-event-bus\.js';/,
    );
    expect(body).toMatch(/const notificationEventBus = new NotificationEventBus\(\);/);
    // Pin the cost-alert dual-publish — must include kind + accountId
    // + the one-to-one mapping from the dispatcher's CostAlertPayload.
    expect(body).toMatch(/notificationEventBus\.publish\(\{/);
    expect(body).toMatch(/kind: 'cost\.threshold_alert',/);
    expect(body).toMatch(/accountId: alert\.account_id,/);
    expect(body).toMatch(/severity: alert\.severity,/);
    expect(body).toMatch(/billingCycle: alert\.billing_cycle,/);
    expect(body).toMatch(/previousState: alert\.previous_state,/);
    expect(body).toMatch(/currentState: alert\.current_state,/);
    expect(body).toMatch(/totalCents: alert\.total_cents,/);
    expect(body).toMatch(/thresholdSoftCents: alert\.threshold_soft_cents,/);
    expect(body).toMatch(/thresholdHardCents: alert\.threshold_hard_cents,/);
    expect(body).toMatch(/at: new Date\(\)\.toISOString\(\),/);
  });

  it("2026-05-20 accountAuditService takes the notificationEventBus as its 3rd constructor arg so high-severity actions (api_key.revoked, byok_anthropic.key_set, team.member_removed, account.mfa_disabled, account.password_changed) republish onto the panel stream — pinned so a refactor can't silently drop the third arg and break the audit→panel feed", () => {
    expect(body).toMatch(
      /const accountAuditService = new AccountAuditService\(\s*\n?\s*accountAuditRepo,\s*\n?\s*metricsRegistry,\s*\n?\s*notificationEventBus,\s*\n?\s*\);/,
    );
  });

  it("2026-05-20 sessionsService takes notificationEventBus as the `notifications` dep so driver failures publish session.errored — third bus publisher (cost-alert + audit.high_severity + this one). Pinned so a refactor can't silently drop the dep and break the GUI panel toast for driver failures", () => {
    expect(body).toMatch(/notifications: notificationEventBus,/);
  });

  it("6.g session-duration auto-destroy sweep wired in bootstrap: SessionDurationSweeperService(repo+sessions) + registerSessionDurationSweepJob + enqueueNextSessionDurationSweep on app start. Pinned so a refactor can't silently drop the wire-up and let free-tier sessions pin fleet slots forever.", () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*SessionDurationSweeperService,\s*\n?\s*enqueueNextSessionDurationSweep,\s*\n?\s*registerSessionDurationSweepJob,\s*\n?\s*\} from '\.\.\/services\/session-duration-sweeper\.js';/,
    );
    expect(body).toMatch(/const sessionDurationSweeper = new SessionDurationSweeperService\(\{/);
    expect(body).toMatch(/repo: sessionsRepo,/);
    expect(body).toMatch(/sessions: sessionsService,/);
    expect(body).toMatch(/registerSessionDurationSweepJob\(\{/);
    expect(body).toMatch(
      /await enqueueNextSessionDurationSweep\(\{ scheduledJobs: scheduledJobsService \}\);/,
    );
  });

  it("V-820 fleet control-plane WS deps are gated on config.fleetControlPlaneEnabled: the FleetNodeAuthImpl (over the hoisted drizzleFleetNodesRepo + a RedisFleetNonceCache) + FleetControlRegistry are constructed ONLY when the flag is on, and the nonce cache instance is SHARED between the verifier and AppDeps.fleetNonceCache. Pinned so a refactor can't silently flip the route live-by-default (an unguarded prod WS endpoint) or split the nonce cache (replay-defence gap).", () => {
    // The repo is hoisted (shared by mac-nodes-register + the verifier).
    expect(body).toMatch(/const drizzleFleetNodesRepo = new DrizzleFleetNodesRepo\(dbHandle\);/);
    // Gated on the activation flag.
    expect(body).toMatch(/const fleetControlPlaneDeps = config\.fleetControlPlaneEnabled/);
    // Shared nonce cache instance (constructed once, used by both).
    expect(body).toMatch(/const fleetNonceCache = new RedisFleetNonceCache\(redis\);/);
    expect(body).toMatch(
      /fleetNodeAuth: new FleetNodeAuthImpl\(drizzleFleetNodesRepo, fleetNonceCache\),/,
    );
    // W413 — go-live config summary logged at boot when the flag is on, so an
    // operator catches a half-config (LiveKit/PROFILE_MASTER_KEY unset → inert)
    // at boot rather than at first dispatch.
    expect(body).toMatch(/component: 'go-live-config',/);
    expect(body).toMatch(/livekitReady:/);
    expect(body).toMatch(/'fleet control plane ENABLED',/);
    // Registry takes the profileSaved→R2 persister when R2 is configured, else
    // undefined (frame accepted + ignored). Pinned so the persistence wiring
    // can't be silently dropped (a profile-backed session would lose its store).
    // W2808: the registry is assigned inline to a forward holder
    // (fleetRegistryHolder.current) so the onHeartbeat CP↔daemon reconcile can
    // resolve the reporting node's connection to re-issue sessionEnd.
    expect(body).toContain(
      'fleetControlRegistry: (fleetRegistryHolder.current = new FleetControlRegistry(',
    );
    // ARC-A-followup: the persister now takes a cross-account ownership guard
    // (session→account + profile-ownership) so a node can't overwrite another
    // account's profile blob. Pinned via fragments (prettier-reflow-robust).
    expect(body).toContain('makeProfileSavedPersister(r2, logger, {');
    expect(body).toContain('agentSessions: agentSessionsRepo,');
    expect(body).toContain('profiles: profilesRepo,');
    expect(body).toContain('makeChallengeRelay(agentSessionsRepo, webhooksService, logger)');
    // audit M1 — the pageState consumer is now a node-ownership-gated relay
    // (was a bare `(frame) => sessionPageStateStore.set(frame)`).
    expect(body).toContain(
      'makeSessionPageStateRelay(agentSessionsRepo, sessionPageStateStore, logger)',
    );
    expect(body).toContain(
      'makeProfileSaveFailedRelay(agentSessionsRepo, webhooksService, logger)',
    );
    // Authenticated heartbeat DB/reconcile work must stay behind the per-node
    // latest-state coalescer; a bare inline callback recreates unbounded work.
    expect(body).toContain('makeFleetHeartbeatConsumer({');
    expect(body).toContain('persistSnapshot: async (frame) => {');
    expect(body).toContain('reconcileWorkerOrphans: async (frame) => {');
    expect(body).toContain('reconcileNodeBoot: (frame) =>');
    // Terminal statuses use the bounded authenticated relay and evict all three
    // live-state stores; omitting pageState leaves stale terminal overlays.
    expect(body).toContain('makeAgentSessionTerminalStatusRelay({');
    expect(body).toContain('livenessStore: sessionLivenessStore,');
    expect(body).toContain('sessionPageStateStore,');
    expect(body).toContain('sessionCapabilityReportStore,');
    // W650/A3-W1254 — the pageState store is constructed alongside the registry
    // (behind the same flag) + wired as the registry's onPageState consumer.
    expect(body).toMatch(/const sessionPageStateStore = new SessionPageStateStore\(\);/);
    // Local fleet-demo session-dispatch config (only assembled behind the flag).
    // Discrete pins (no long \s*\n? chain — backtracking rule). Locks the demo
    // archetype (current-code iphone16pro, NOT the canvas-gated iphone17 cutover)
    // + the local gost proxy w/ h3 (udp_associate) on.
    expect(body).toMatch(/sessionDispatch: \{/);
    expect(body).toMatch(/archetype: 'iphone16pro_ios18_6_safari18_6',/);
    expect(body).toMatch(/behaviorProfile: 'default',/);
    expect(body).toMatch(/initialUrl: 'https:\/\/driftstack\.dev',/);
    expect(body).toMatch(/host: '127\.0\.0\.1',/);
    expect(body).toMatch(/port: 1080,/);
    expect(body).toMatch(/udp_associate: true,/);
    expect(body).toMatch(/require_remote_dns: false,/);
    // Spread into AppDeps (empty object when the flag is off → 503 stub).
    expect(body).toMatch(/\.\.\.fleetControlPlaneDeps,/);
  });

  it('W592 task-refusal activation: production resolves the configured policy atomically; unset stays off', () => {
    expect(body).toMatch(/process\.env\.DRIFTSTACK_TASK_REFUSAL_PATTERNS/);
    expect(body).toMatch(/resolveTaskRefusalConfig\(refusalPatternsRaw, config\.nodeEnv\)/);
    expect(body).toMatch(/production requires a complete valid list and/);
    expect(body).toMatch(/task-refusal gate stays OFF/);
    expect(body).not.toMatch(/parsed = JSON\.parse\(refusalPatternsRaw\)/);
    expect(body).toMatch(/\.\.\.\(refusalPatterns\.length > 0 \? \{ refusalPatterns \} : \{\}\)/);
  });

  it('BYOK Anthropic byte envelopes migrate to account-bound v2 before service construction', () => {
    expect(body).toContain('const byokAnthropicRepo = new DrizzleBYOKAnthropicRepo(dbHandle);');
    expect(body).toContain('await byokAnthropicRepo.migrateCiphertextEnvelopes(');
    expect(body).toContain('const MAX_BYOK_ANTHROPIC_BOOT_MIGRATION_ROWS = 10_000;');
    expect(body).toContain('BYOK Anthropic key migration made no progress');
    expect(body).toContain("component: 'byok-anthropic-key-encryption'");
    expect(body).toContain('new BYOKAnthropicService(byokAnthropicRepo, {');
  });

  it('AccountsAdminService receives the logger, without which every reclaim failure is unrecorded in production', () => {
    // suspend()/deleteAccount() reclaim sessions, web sessions, API keys and
    // webhooks, each best-effort so a GDPR Article 17 termination returns
    // success whether or not the surface was actually reclaimed. The service
    // reports those failures only if a logger was injected, and its logger
    // parameter is optional — so dropping this argument leaves every unit test
    // for that reporting green while production goes silent again.
    expect(body).toMatch(
      /const accountsAdminService = new AccountsAdminService\(\s*\n?\s*accountsAdminRepo,[\s\S]*?webhooksService,[\s\S]*?\n\s*logger,/,
    );
    // V-758 — the suspension lifecycle now also needs a billing pauser, or the AUP's
    // "billing pauses" promise silently becomes untrue again. Resolved lazily because
    // BillingService is constructed later and only when Stripe is configured.
    expect(body).toMatch(/pauseCollectionForAccount: async \(accountId: string\) =>/);
    expect(body).toMatch(/resumeCollectionForAccount: async \(accountId: string\) =>/);
    expect(body).toMatch(/let billingService: BillingService \| undefined;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
