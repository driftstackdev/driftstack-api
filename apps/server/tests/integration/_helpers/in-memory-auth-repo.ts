// In-memory implementation of AccountAuthRepo, used by integration tests so
// they can run without a real Postgres. Mirrors DrizzleAccountAuthRepo
// behaviour exactly.

import type {
  AccountAuthRepo,
  AccountRow,
  ApiKeyRow,
  RateLimitOverride,
  TeamMembership,
  WebSessionAuthRow,
} from '../../../src/services/auth.js';

export interface WebSessionFinder {
  findActiveWebSession(args: { tokenHash: string; now: Date }): Promise<WebSessionAuthRow | null>;
  touchWebSessionLastUsed?(id: string, at: Date): Promise<void>;
  /**
   * V-168 — fallback account lookup for accounts created via
   * AuthFlowsRepo.createAccount that haven't been mirrored into
   * InMemoryAuthRepo's accounts map. Web session auth resolves the
   * account via this if the local map misses.
   */
  getAccount?(id: string): Promise<AccountRow | null>;
}

export class InMemoryAuthRepo implements AccountAuthRepo {
  private readonly accounts = new Map<string, AccountRow>();
  private readonly keysById = new Map<string, ApiKeyRow>();
  private readonly keysByPrefix = new Map<string, ApiKeyRow>();
  private readonly overrides = new Map<string, Map<string, RateLimitOverride>>();
  // V-326 — test seam for team memberships indexed by member account id.
  private readonly teamMemberships = new Map<string, TeamMembership[]>();
  // V-168 — web session lookup. Local map for direct test seeding; if a
  // webSessionFinder is wired (production-shaped fixture: buildTestApp
  // passes the auth-flows-repo so web sessions issued by AuthFlowsService
  // flow through to the auth path), the finder takes precedence.
  private readonly webSessionsByTokenHash = new Map<string, WebSessionAuthRow>();
  private webSessionFinder: WebSessionFinder | null = null;

  /** V-168 — wire an external web-session finder (e.g. InMemoryAuthFlowsRepo). */
  setWebSessionFinder(finder: WebSessionFinder | null): void {
    this.webSessionFinder = finder;
  }

  upsertAccount(row: AccountRow): void {
    this.accounts.set(row.id, row);
  }

  upsertApiKey(row: ApiKeyRow): void {
    this.keysById.set(row.id, row);
    this.keysByPrefix.set(row.keyPrefix, row);
  }

  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
    return Promise.resolve(this.keysByPrefix.get(prefix) ?? null);
  }

  async getAccount(id: string): Promise<AccountRow | null> {
    const local = this.accounts.get(id);
    if (local) return local;
    if (this.webSessionFinder?.getAccount) {
      return this.webSessionFinder.getAccount(id);
    }
    return null;
  }

  /** Test seam: snapshot of all account rows. Used by InMemoryAccountsAdminRepo.list. */
  allAccounts(): AccountRow[] {
    return Array.from(this.accounts.values());
  }

  touchApiKeyLastUsed(id: string, at: Date): Promise<void> {
    const row = this.keysById.get(id);
    if (row) {
      const updated: ApiKeyRow = { ...row, lastUsedAt: at };
      this.keysById.set(id, updated);
      this.keysByPrefix.set(updated.keyPrefix, updated);
    }
    return Promise.resolve();
  }

  findActiveRateLimitOverrides(accountId: string, now: Date): Promise<RateLimitOverride[]> {
    const buckets = this.overrides.get(accountId);
    if (!buckets) return Promise.resolve([]);
    const out: RateLimitOverride[] = [];
    for (const o of buckets.values()) {
      if (o.expiresAt.getTime() > now.getTime()) out.push(o);
    }
    return Promise.resolve(out);
  }

  /** Test helper: set/clear overrides for an account. Mirrors what the
   * RateLimitOverridesService does via its repo in production. */
  setRateLimitOverride(accountId: string, override: RateLimitOverride): void {
    let buckets = this.overrides.get(accountId);
    if (!buckets) {
      buckets = new Map();
      this.overrides.set(accountId, buckets);
    }
    buckets.set(override.bucketKey, override);
  }

  clearRateLimitOverride(accountId: string, bucketKey: string): void {
    this.overrides.get(accountId)?.delete(bucketKey);
  }

  // V-168 — web session test seam.
  upsertWebSession(row: WebSessionAuthRow & { tokenHash: string }): void {
    this.webSessionsByTokenHash.set(row.tokenHash, row);
  }

  findActiveWebSession(args: { tokenHash: string; now: Date }): Promise<WebSessionAuthRow | null> {
    if (this.webSessionFinder) return this.webSessionFinder.findActiveWebSession(args);
    const row = this.webSessionsByTokenHash.get(args.tokenHash);
    if (!row) return Promise.resolve(null);
    if (row.revokedAt !== null) return Promise.resolve(null);
    if (row.expiresAt.getTime() <= args.now.getTime()) return Promise.resolve(null);
    return Promise.resolve(row);
  }

  touchWebSessionLastUsed(id: string, at: Date): Promise<void> {
    if (this.webSessionFinder?.touchWebSessionLastUsed) {
      return this.webSessionFinder.touchWebSessionLastUsed(id, at);
    }
    for (const [hash, row] of this.webSessionsByTokenHash.entries()) {
      if (row.id === id) {
        this.webSessionsByTokenHash.set(hash, { ...row, lastUsedAt: at });
        break;
      }
    }
    return Promise.resolve();
  }

  // ── V-326 team memberships ────────────────────────────────────────
  findTeamMemberships(memberAccountId: string): Promise<TeamMembership[]> {
    return Promise.resolve(this.teamMemberships.get(memberAccountId) ?? []);
  }

  /** Test helper: seed team memberships for a member account. */
  setTeamMemberships(memberAccountId: string, rows: TeamMembership[]): void {
    this.teamMemberships.set(memberAccountId, rows);
  }

  /** V-168 test helper: revoke a web session by id. */
  revokeWebSessionById(id: string, at: Date): void {
    for (const [hash, row] of this.webSessionsByTokenHash.entries()) {
      if (row.id === id) {
        this.webSessionsByTokenHash.set(hash, { ...row, revokedAt: at });
        break;
      }
    }
  }
}
