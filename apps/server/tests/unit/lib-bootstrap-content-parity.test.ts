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
//     §3.10 90d post-unsubscribe zero-out; system-action audit with
//     adminAccountId=null).
//   • V-353b MFA gated by MFA_ENCRYPTION_KEY (32 random bytes b64).
//   • V-541.H real UsageAggregator over usage_records ledger.
//   • V-232 poller cadence 60s; founder-approved on V-202d ack
//     2026-05-06; setInterval wraps try/catch as defense-in-depth so
//     an unexpected throw NEVER kills the interval.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/bootstrap.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W439.B apps/server/src/lib/bootstrap.ts content parity', () => {
  const body = read(LIB);

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

  it('wires recipe payload encryption, runs a bounded boot conversion, and drains legacy rows without overlapping', () => {
    expect(body).toMatch(
      /const recipesRepo = new DrizzleRecipesRepo\(dbHandle, \{[\s\S]*?payloadEncryptionKeyBase64: config\.mfaEncryptionKey[\s\S]*?\}\);/,
    );
    expect(body).toMatch(/const upgraded = await recipesRepo\.encryptLegacyPayloads\(500\);/);
    expect(body).toMatch(/if \(recipePayloadUpgradeInFlight\) return;/);
    expect(body).toMatch(/\.encryptLegacyPayloads\(500\)/);
    expect(body).toMatch(
      /if \(recipePayloadUpgradeTimer\) clearInterval\(recipePayloadUpgradeTimer\);/,
    );
    expect(body).toMatch(/new recipe writes fail closed/);
  });

  it('wires and verifies webhook secret encryption, then runs a bounded legacy conversion batch before workers start', () => {
    expect(body).toMatch(
      /const webhooksRepo = new DrizzleWebhooksRepo\(dbHandle, \{[\s\S]*?secretEncryptionKeyBase64: config\.mfaEncryptionKey[\s\S]*?\}\);/,
    );
    expect(body).toMatch(/const upgraded = await webhooksRepo\.encryptLegacySecrets\(500\);/);
    expect(body).toMatch(
      /encrypted webhook secrets are unreadable and new secret writes fail closed/,
    );
    expect(body).toMatch(/const WEBHOOK_SECRET_UPGRADE_INTERVAL_MS = 60_000;/);
    expect(body).toMatch(/if \(webhookSecretUpgradeInFlight\) return;/);
    expect(body).toMatch(
      /if \(webhookSecretUpgradeTimer\) clearInterval\(webhookSecretUpgradeTimer\);/,
    );
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

  it('V-202d scheduled-jobs framing pinned: generic dispatcher; trial_pack.expired handler removed 2026-05-27; dispatcher remains for auth_tokens.sweep + cost.recompute_nightly; workerId `pid-${pid}@<host>` sufficient — single-replica today; multi-replica safety via SELECT FOR UPDATE SKIP LOCKED in repo (not workerId)', () => {
    expect(body).toMatch(
      /\/\/ V-202d — generic scheduled-jobs dispatcher\. The trial_pack\.expired\s*\n?\s*\/\/ handler was removed 2026-05-27 with the trial_pack retirement; the\s*\n?\s*\/\/ dispatcher remains for the other registered cron-shaped jobs\s*\n?\s*\/\/ \(auth_tokens\.sweep, cost\.recompute_nightly\) via `register\(\.\.\.\)`\./,
    );
    expect(body).toMatch(
      /\/\/ workerId composition: `<process-pid>@<host>` is sufficient here —\s*\n?\s*\/\/ production runs single-replica today; multi-replica safety still\s*\n?\s*\/\/ works because the SELECT FOR UPDATE SKIP LOCKED query in the repo\s*\n?\s*\/\/ is what guarantees mutual exclusion, not the workerId\./,
    );
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

  it('V-295c2 status-snapshot framing pinned: separate public-readable R2 bucket (recordings bucket intentionally NOT used — recordings contain Customer Data and must remain private); fall-back when live API fetch fails; active ONLY when R2_BUCKET_PUBLIC configured', () => {
    expect(body).toMatch(
      /\/\/ V-295c2 — public status snapshot writer\. Writes the same data the\s*\n?\s*\/\/ public \/v1\/status\/incidents endpoint surfaces to a SEPARATE\s*\n?\s*\/\/ public-readable R2 bucket so the status site can fall back to the\s*\n?\s*\/\/ snapshot when the live API fetch fails\. The recordings bucket is\s*\n?\s*\/\/ intentionally NOT used — recordings contain Customer Data and must\s*\n?\s*\/\/ remain private\. Active only when R2_BUCKET_PUBLIC is configured\./,
    );
  });

  it('V-295c3-tombstone framing pinned: Privacy §3.10 90d post-unsubscribe email zero-out; daily 24h cadence; first tick fires 24h after boot (acceptable — rows just unsubscribed have 90d before eligible); audit-logs each purge as system action with adminAccountId=null', () => {
    expect(body).toMatch(
      /\/\/ V-295c3-tombstone — daily status-subscriber email-purge poller\.\s*\n?\s*\/\/ Privacy §3\.10 promises 90d post-unsubscribe email zero-out\. Runs\s*\n?\s*\/\/ every 24 hours; first tick fires 24h after boot \(acceptable —\s*\n?\s*\/\/ rows that just unsubscribed have 90 days before they're eligible\s*\n?\s*\/\/ anyway\)\. Audit-logs each purge as a system action \(no admin actor\)\s*\n?\s*\/\/ — done via writes to admin_audit_log with the special\s*\n?\s*\/\/ 'status_subscriber\.purged' action and adminAccountId set to null\.\s*\n?\s*\/\/ The audit-log repo accepts null adminAccountId for system actions\./,
    );
    expect(body).toMatch(/const STATUS_PURGE_INTERVAL_MS = 24 \* 60 \* 60 \* 1000;/);
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

  it('Webhook delivery worker IS wired (drift-guard against the original unwired-in-prod gap): constructed with the webhooks repo + logger, driven by a 60s tickOnce poller, .unref()-ed, and clearInterval-ed in teardown — without this the worker would never run and configured webhooks would never deliver', () => {
    expect(body).toMatch(
      /const webhookDeliveryWorker = new WebhookDeliveryWorker\(\{ repo: webhooksRepo, logger \}\);/,
    );
    expect(body).toMatch(/await webhookDeliveryWorker\.tickOnce\(\);/);
    expect(body).toMatch(/webhookDeliveryTimer\.unref\(\);/);
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

  it("Teardown framing pinned: V-232 stop pollers BEFORE other teardown so in-flight tick doesn't try to acquire a closing redis/db handle; idempotent (torn flag); sentry flush+close 2s; swallow errors on redis.quit + dbHandle.close", () => {
    expect(body).toMatch(
      /\/\/ V-232 — stop pollers BEFORE other teardown so an in-flight tick\s*\n?\s*\/\/ doesn't try to acquire a closing redis\/db handle\./,
    );
    expect(body).toMatch(
      /let torn = false;\s*\n?\s*async function teardown\(\): Promise<void> \{\s*\n?\s*if \(torn\) return;\s*\n?\s*torn = true;/,
    );
    expect(body).toMatch(
      /try \{\s*\n?\s*await sentry\.flush\(2000\);\s*\n?\s*await sentry\.close\(2000\);\s*\n?\s*\} catch \{\s*\n?\s*\/\* swallow \*\/\s*\n?\s*\}/,
    );
  });

  it('v2-#17 rotation-reminder daily sweeps framing pinned: pure-sweep nags (no auto-rotation); 24h cadence matches the V-295c3-tombstone status-purge poller; default-on; DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1 opts out; both timers .unref()-ed; clearInterval in teardown', () => {
    expect(body).toMatch(
      /\/\/ v2-#17 — daily rotation-reminder sweeps for webhook signing secrets\s*\n?\s*\/\/ \(v2-#10\/#10\.5\/#10\.6\) and BYOK Anthropic API keys \(v2-#11\/#11\.5\/#11\.6\)\.\s*\n?\s*\/\/ Both reminder services are pure-sweep nags \(no auto-rotation\); the\s*\n?\s*\/\/ services skip rows that don't need a reminder yet, so the per-tick\s*\n?\s*\/\/ burst is bounded by perTickLimit \(default 50\)\. Default-on for\s*\n?\s*\/\/ production; the operator can flip\s*\n?\s*\/\/ DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1 to suppress when a\s*\n?\s*\/\/ customer-quiet account wants to silence the nag/,
    );
    expect(body).toMatch(/const ROTATION_REMINDER_INTERVAL_MS = 24 \* 60 \* 60 \* 1000;/);
    expect(body).toMatch(/process\.env\.DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS === '1'/);
    expect(body).toMatch(
      /new WebhookRotationReminderService\(\s*\n?\s*new DrizzleWebhookRotationReminderRepo\(dbHandle, \{[\s\S]*?secretEncryptionKeyBase64: config\.mfaEncryptionKey[\s\S]*?\}\),/,
    );
    expect(body).toMatch(
      /new ByokAnthropicRotationReminderService\(\s*\n?\s*new DrizzleByokAnthropicRotationReminderRepo\(dbHandle\),/,
    );
    expect(body).toMatch(/webhookRotationReminderTimer\?\.unref\(\);/);
    expect(body).toMatch(/byokAnthropicRotationReminderTimer\?\.unref\(\);/);
    expect(body).toMatch(
      /if \(webhookRotationReminderTimer\) clearInterval\(webhookRotationReminderTimer\);/,
    );
    expect(body).toMatch(
      /if \(byokAnthropicRotationReminderTimer\) clearInterval\(byokAnthropicRotationReminderTimer\);/,
    );
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

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
