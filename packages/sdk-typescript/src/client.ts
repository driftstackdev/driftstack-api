// Driftstack client — single entry point. Composes the resources and the
// HTTP layer. Customers instantiate one of these and use the resource
// accessors (`client.sessions`, `client.apiKeys`, `client.usage`).

import { HttpClient, type HttpClientConfig } from './http.js';
import { SessionsResource } from './resources/sessions.js';
import { ApiKeysResource } from './resources/api-keys.js';
import { UsageResource } from './resources/usage.js';
import { WebhooksResource } from './resources/webhooks.js';
import { ProfilesResource } from './resources/profiles.js';
import { BillingResource } from './resources/billing.js';
import { AuthResource } from './resources/auth.js';
import { AccountResource } from './resources/account.js';
import { TeamResource } from './resources/team.js';
import type { RetryConfig } from './retry.js';

export interface DriftstackOptions {
  /** Long-lived API key (`ds_live_…` or `ds_test_…`). */
  apiKey: string;
  /** API base URL. Defaults to the production URL once it's live. */
  baseUrl?: string;
  /** Per-request retry configuration. */
  retry?: RetryConfig;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Override the global fetch implementation (test seams, polyfills). */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.driftstack.dev';

export class Driftstack {
  readonly sessions: SessionsResource;
  readonly apiKeys: ApiKeysResource;
  readonly usage: UsageResource;
  readonly webhooks: WebhooksResource;
  readonly profiles: ProfilesResource;
  readonly billing: BillingResource;
  readonly auth: AuthResource;
  readonly account: AccountResource;
  /** V-298c — Team RBAC. Auth path integration is V-298d. */
  readonly team: TeamResource;

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
    };
    this.http = new HttpClient(httpConfig);

    this.sessions = new SessionsResource(this.http);
    this.apiKeys = new ApiKeysResource(this.http);
    this.usage = new UsageResource(this.http);
    this.webhooks = new WebhooksResource(this.http);
    this.profiles = new ProfilesResource(this.http);
    this.billing = new BillingResource(this.http);
    this.auth = new AuthResource(this.http);
    this.account = new AccountResource(this.http);
    this.team = new TeamResource(this.http);
  }
}
