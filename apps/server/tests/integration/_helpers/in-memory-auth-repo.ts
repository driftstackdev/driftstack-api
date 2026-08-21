// In-memory implementation of AccountAuthRepo, used by integration tests so
// they can run without a real Postgres. Mirrors DrizzleAccountAuthRepo
// behaviour exactly.

import type { AccountOrganization } from '@driftstack/api-types';
import type {
  AccountAuthRepo,
  AccountRow,
  ApiKeyRow,
  RateLimitOverride,
  TeamMembership,
  WebSessionAuthRow,
} from '../../../src/services/auth.js';
import { API_KEY_LAST_USED_THROTTLE_MS } from '../../../src/db/auth-repo.js';

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
    // V-1240 — the throttle window is READ from DrizzleAccountAuthRepo rather than
    // restated here. It used to be a local `const THROTTLE_MS = 30_000` with a comment
    // saying it mirrored that one: the same number twice, consistent only until one
    // side moved. The throttle has to exist at all because an unthrottled in-memory
    // write once masked a real Drizzle bug where last_used_at never updated.
    const THROTTLE_MS = API_KEY_LAST_USED_THROTTLE_MS;
    if (row && (row.lastUsedAt === null || row.lastUsedAt.getTime() < at.getTime() - THROTTLE_MS)) {
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

  /**
   * V-168 — web session test seam. V-1268: no caller today, kept deliberately.
   *
   * It is the only writer of `webSessionsByTokenHash`, which the local fallbacks in
   * `findActiveWebSession`, `touchWebSessionLastUsed` and `revokeWebSessionById` all read. With
   * no writer those paths cannot return a row, so removing this seam would not delete dead code
   * — it would leave three methods whose bodies can never do anything, which reads as working.
   */
  upsertWebSession(row: WebSessionAuthRow & { tokenHash: string }): void {
    this.webSessionsByTokenHash.set(row.tokenHash, row);
  }

  /**
   * V-1226 — the local fallback below knows about expiry and revocation and NOTHING about auth
   * epochs. `DrizzleAuthRepo` joins `accounts.auth_epoch = web_sessions.auth_epoch`, so a password
   * change invalidates every existing session without revoking any of them; a session seeded
   * through `upsertWebSession` survives that here and would keep authenticating.
   *
   * It is unreachable today — `buildTestApp` wires `setWebSessionFinder` to the auth-flows double,
   * which DOES compare epochs, and `upsertWebSession` has no callers. Kept because the seam is
   * documented as a direct-seeding path, but anything testing session INVALIDATION must go through
   * the finder. See `web-session-authority-repo-contract.test.ts` for the pinned behaviour.
   */
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
    const rows = this.teamMemberships.get(memberAccountId) ?? [];
    // Mirror the DB repo's join: enrich ownerEmail/ownerName from the owner
    // account when present, so a test that seeds memberships + accounts gets
    // the same shape the Drizzle path produces, including exclusion of known
    // inactive owners. Falls back to whatever the membership already carries
    // (or a synthetic email) when the owner account wasn't seeded into the map.
    return Promise.resolve(
      rows.flatMap<TeamMembership>((r) => {
        const owner = this.accounts.get(r.ownerAccountId);
        if (owner && owner.status !== 'active') return [];
        return [
          {
            ...r,
            ownerEmail: owner?.email ?? r.ownerEmail ?? `${r.ownerAccountId}@example.test`,
            ownerName: owner ? owner.name : (r.ownerName ?? null),
          },
        ];
      }),
    );
  }

  // ── V-352 / V-352b / V-298a / V-298b account basics update ──
  updateAccountBasics(
    id: string,
    patch: {
      name?: string | null;
      timezone?: string | null;
      avatarR2Key?: string | null;
      slug?: string | null;
      region?: 'us' | 'eu' | 'apac' | null;
    },
  ): Promise<AccountRow | null> {
    const r = this.accounts.get(id);
    if (!r) return Promise.resolve(null);
    if (patch.slug !== undefined && patch.slug !== null) {
      for (const other of this.accounts.values()) {
        if (other.id !== id && other.slug === patch.slug) {
          return Promise.reject(new Error('SLUG_TAKEN'));
        }
      }
    }
    const updated: AccountRow = {
      ...r,
      name: patch.name !== undefined ? patch.name : r.name,
      timezone: patch.timezone !== undefined ? patch.timezone : r.timezone,
      avatarR2Key: patch.avatarR2Key !== undefined ? patch.avatarR2Key : r.avatarR2Key,
      slug: patch.slug !== undefined ? patch.slug : r.slug,
      region: patch.region !== undefined ? patch.region : r.region,
      updatedAt: new Date(),
    };
    this.accounts.set(id, updated);
    return Promise.resolve(updated);
  }

  // Per-account org-sync (0079) — in-memory taxonomy store.
  private readonly organizations = new Map<string, AccountOrganization>();

  getOrganization(id: string): Promise<AccountOrganization | null> {
    if (!this.accounts.has(id)) return Promise.resolve(null);
    return Promise.resolve(this.organizations.get(id) ?? { folders: [], tags: [] });
  }

  setOrganization(id: string, org: AccountOrganization): Promise<void> {
    this.organizations.set(id, org);
    return Promise.resolve();
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
