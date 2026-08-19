// Driftstack client — single entry point. Composes the resources and the
// HTTP layer. Customers instantiate one of these and use the resource
// accessors (`client.sessions`, `client.apiKeys`, `client.usage`).

import { HttpClient, type HttpClientConfig } from './http.js';
import { SessionsResource } from './resources/sessions.js';
import { ApiKeysResource } from './resources/api-keys.js';
import { UsageResource } from './resources/usage.js';
import { WebhooksResource } from './resources/webhooks.js';
import { ProfilesResource } from './resources/profiles.js';
import { ProfileSnapshotsResource } from './resources/profile-snapshots.js';
import { BillingResource } from './resources/billing.js';
import { CryptoOrdersResource } from './resources/crypto-orders.js';
import { AuthResource } from './resources/auth.js';
import { AccountResource } from './resources/account.js';
import { AuditLogResource } from './resources/audit-log.js';
import { EmailPreferencesResource } from './resources/email-preferences.js';
import { LegalResource } from './resources/legal.js';
import { MfaResource } from './resources/mfa.js';
import { TeamResource } from './resources/team.js';
import { EgressResource } from './resources/egress.js';
import { AgentSessionsResource } from './resources/agent-sessions.js';
import { RecipesResource } from './resources/recipes.js';
import { ArchetypesResource } from './resources/archetypes.js';
import type { RetryConfig } from './retry.js';

export interface DriftstackOptions {
  /** Long-lived API key (`ds_live_…` or `ds_test_…`). */
  apiKey: string;
  /** API base URL. Defaults to the production URL once it's live. */
  baseUrl?: string;
  /** Per-request retry configuration. */
  retry?: RetryConfig;
  /**
   * Team workspace to operate in: the owner's account id
   * (`acc_<uuid>`). Sends `X-Driftstack-Account` on every request —
   * reads resolve against that workspace; writes need the admin role
   * (server-enforced). Omit for your own account.
   */
  effectiveAccount?: string;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Override the global fetch implementation (test seams, polyfills). */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.driftstack.dev';

export class Driftstack {
  /** Server-authoritative customer-selectable browser archetypes. */
  readonly archetypes: ArchetypesResource;
  readonly sessions: SessionsResource;
  readonly apiKeys: ApiKeysResource;
  readonly usage: UsageResource;
  readonly webhooks: WebhooksResource;
  readonly profiles: ProfilesResource;
  /** V-312 — immutable point-in-time profile snapshots. */
  readonly profileSnapshots: ProfileSnapshotsResource;
  readonly billing: BillingResource;
  /** V-666 — crypto-payment orders (customer surface). */
  readonly cryptoOrders: CryptoOrdersResource;
  readonly auth: AuthResource;
  readonly account: AccountResource;
  /** V-353b — MFA enrollment management. Pairs with `auth.mfaChallenge` + `auth.mfaStepUp`. */
  readonly mfa: MfaResource;
  /** V-216 — append-only customer audit log read + iterate. */
  readonly auditLog: AuditLogResource;
  /** V-204 — non-critical email opt-in/opt-out preferences. */
  readonly emailPreferences: EmailPreferencesResource;
  /** V-049 — legal-document acceptance machinery. */
  readonly legal: LegalResource;
  /** V-298c — Team RBAC. Act on an owner's account via X-Driftstack-Account. */
  readonly team: TeamResource;
  /** EG-API-1.2/1.3 — customer-configurable egress (planning 133). */
  readonly egress: EgressResource;
  /** Agent sessions: create, inspect, control, stream, and close browser-agent work. */
  readonly agentSessions: AgentSessionsResource;
  /** Saved recipes: create, list, inspect, delete, and request reusable suggestions. */
  readonly recipes: RecipesResource;

  private readonly http: HttpClient;

  constructor(opts: DriftstackOptions) {
    if (!opts.apiKey || typeof opts.apiKey !== 'string') {
      throw new TypeError('Driftstack: apiKey is required and must be a string');
    }

    const httpConfig: HttpClientConfig = {
      apiKey: opts.apiKey,
      baseUrl: (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.effectiveAccount !== undefined ? { effectiveAccount: opts.effectiveAccount } : {}),
    };
    this.http = new HttpClient(httpConfig);

    this.sessions = new SessionsResource(this.http);
    this.archetypes = new ArchetypesResource(this.http);
    this.apiKeys = new ApiKeysResource(this.http);
    this.usage = new UsageResource(this.http);
    this.webhooks = new WebhooksResource(this.http);
    this.profiles = new ProfilesResource(this.http);
    this.profileSnapshots = new ProfileSnapshotsResource(this.http);
    this.billing = new BillingResource(this.http);
    this.cryptoOrders = new CryptoOrdersResource(this.http);
    this.auth = new AuthResource(this.http);
    this.account = new AccountResource(this.http);
    this.mfa = new MfaResource(this.http);
    this.auditLog = new AuditLogResource(this.http);
    this.emailPreferences = new EmailPreferencesResource(this.http);
    this.legal = new LegalResource(this.http);
    this.team = new TeamResource(this.http);
    this.egress = new EgressResource(this.http);
    this.agentSessions = new AgentSessionsResource(this.http);
    this.recipes = new RecipesResource(this.http);
  }
}
