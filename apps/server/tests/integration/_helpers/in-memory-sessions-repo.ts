// In-memory SessionRepo for integration tests.

import { randomUUID } from 'node:crypto';
import { SessionStatusSchema, type AccountTier } from '@driftstack/api-types';
import { ProfileInUseError } from '../../../src/lib/errors.js';
import type {
  NewSessionInput,
  SessionEventInput,
  SessionListPage,
  SessionRecord,
  SessionRepo,
  SerializedSessionDestroyInput,
  SerializedSessionDestroyResult,
} from '../../../src/services/sessions.js';

interface StoredEvent extends SessionEventInput {
  id: string;
  createdAt: Date;
}

export class InMemorySessionsRepo implements SessionRepo {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events: StoredEvent[] = [];
  private readonly destroyTails = new Map<string, Promise<void>>();
  /**
   * 6.g — account_id → tier. The real Drizzle repo JOINs sessions to the
   * `accounts` table to resolve tier for `listExpiredForAutoDestroy`; this
   * map stands in for that join. Tests register a tier per account via
   * `setAccountTier` (defaults to 'free' when an account is unseen, matching
   * the accounts-table default). Other repo methods don't need tier.
   */
  private readonly accountTiers = new Map<string, AccountTier>();

  insertSession(input: NewSessionInput): Promise<SessionRecord> {
    const now = new Date();
    const record: SessionRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      apiKeyId: input.apiKeyId,
      driverSessionId: input.driverSessionId,
      status: 'creating',
      archetype: input.archetype,
      purpose: input.purpose,
      label: input.label,
      metadata: input.metadata,
      egressCapabilities: null,
      egressCapabilityReport: null,
      createdAt: now,
      updatedAt: now,
      lastStateAt: null,
      destroyedAt: null,
    };
    this.sessions.set(record.id, record);
    return Promise.resolve(record);
  }

  // Synchronous twin of the Drizzle atomic insert-if-under-cap: the in-memory
  // count+insert has no await gap, so it's naturally atomic (the real race the
  // advisory lock guards lives only in the multi-connection Postgres path,
  // covered by db-sessions-concurrency-drizzle).
  //
  // A3 finding #7 (W2979/W2980) — mirrors the Drizzle single-active-session-per-
  // profile guard: when opts.profileId is set, refuse a second bind against a
  // NON-TERMINAL (status not destroyed/errored AND destroyed_at null) session
  // whose metadata.profile_id matches for the same account, by throwing
  // ProfileInUseError(ses_<id>). No profileId → no guard (fail-safe).
  insertSessionIfUnderLimit(
    input: NewSessionInput,
    limit: number,
    opts: { profileId?: string } = {},
  ): Promise<SessionRecord | null> {
    if (opts.profileId !== undefined) {
      for (const s of this.sessions.values()) {
        if (
          s.accountId === input.accountId &&
          s.destroyedAt === null &&
          s.status !== 'destroyed' &&
          s.status !== 'errored' &&
          typeof s.metadata?.['profile_id'] === 'string' &&
          s.metadata['profile_id'] === opts.profileId
        ) {
          return Promise.reject(new ProfileInUseError(`ses_${s.id}`));
        }
      }
    }
    let active = 0;
    for (const s of this.sessions.values()) {
      if (s.accountId === input.accountId && s.destroyedAt === null) active += 1;
    }
    if (active >= limit) return Promise.resolve(null);
    return this.insertSession(input);
  }

  // Atomic twin of the Drizzle exact-reservation activation CAS.
  activateSessionReservation(input: {
    id: string;
    reservationDriverSessionId: string;
    driverSessionId: string;
  }): Promise<SessionRecord | null> {
    const s = this.sessions.get(input.id);
    if (
      !s ||
      s.driverSessionId !== input.reservationDriverSessionId ||
      s.status !== 'creating' ||
      s.destroyedAt !== null
    ) {
      return Promise.resolve(null);
    }
    const updated: SessionRecord = {
      ...s,
      driverSessionId: input.driverSessionId,
      status: 'ready',
      updatedAt: new Date(),
    };
    this.sessions.set(input.id, updated);
    return Promise.resolve(updated);
  }

  findSession(id: string, accountId: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(id);
    if (!s || s.accountId !== accountId) return Promise.resolve(null);
    return Promise.resolve(s);
  }

  findSessionUnscoped(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  async destroySessionSerialized(
    input: SerializedSessionDestroyInput,
    destroyDriverSession: (session: SessionRecord) => Promise<void>,
  ): Promise<SerializedSessionDestroyResult> {
    const previous = this.destroyTails.get(input.id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.destroyTails.set(input.id, tail);
    await previous;
    try {
      const current = this.sessions.get(input.id);
      if (!current || (input.accountId !== null && current.accountId !== input.accountId)) {
        return { kind: 'not_found' };
      }
      if (current.status === 'destroyed' || current.status === 'errored') {
        return { kind: 'already_terminal', session: { ...current } };
      }
      if (current.destroyedAt !== null) {
        throw new Error('destroySessionSerialized found a non-terminal row with destroyedAt');
      }

      let driverFailed = false;
      let driverError: unknown;
      try {
        await destroyDriverSession({ ...current });
      } catch (err) {
        driverFailed = true;
        driverError = err;
      }
      const updated: SessionRecord = {
        ...current,
        status: 'destroyed',
        destroyedAt: input.destroyedAt,
        updatedAt: new Date(),
      };
      this.sessions.set(input.id, updated);
      if (driverFailed)
        return { kind: 'driver_error', session: { ...updated }, error: driverError };
      this.events.push({
        sessionId: updated.id,
        ...input.event,
        id: randomUUID(),
        createdAt: new Date(),
      });
      return { kind: 'destroyed', session: { ...updated } };
    } finally {
      release();
      if (this.destroyTails.get(input.id) === tail) this.destroyTails.delete(input.id);
    }
  }

  // Terminal statuses ('destroyed', 'errored') are STICKY — mirrors the
  // Drizzle repo's notInArray(status, ['destroyed','errored']) WHERE clause so
  // service tests exercise the real concurrent-destroy resurrection guard: a
  // write onto an already-terminal row is a silent no-op.
  updateSessionStatus(
    id: string,
    status: SessionRecord['status'],
    extra?: { lastStateAt?: Date; destroyedAt?: Date },
  ): Promise<void> {
    const s = this.sessions.get(id);
    if (s && s.status !== 'destroyed' && s.status !== 'errored') {
      const updated: SessionRecord = {
        ...s,
        status,
        updatedAt: new Date(),
        lastStateAt: extra?.lastStateAt ?? s.lastStateAt,
        destroyedAt: extra?.destroyedAt ?? s.destroyedAt,
      };
      this.sessions.set(id, updated);
    }
    return Promise.resolve();
  }

  countActiveSessions(accountId: string): Promise<number> {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.accountId === accountId && s.destroyedAt === null) count += 1;
    }
    return Promise.resolve(count);
  }

  countAllByStatus(): Promise<Record<SessionRecord['status'], number>> {
    const out = {} as Record<SessionRecord['status'], number>;
    for (const status of SessionStatusSchema.options) out[status] = 0;
    for (const s of this.sessions.values()) out[s.status] += 1;
    return Promise.resolve(out);
  }

  listActiveByAccount(accountId: string): Promise<SessionRecord[]> {
    const active = Array.from(this.sessions.values()).filter(
      (s) =>
        s.accountId === accountId &&
        (s.status === 'creating' || s.status === 'ready' || s.status === 'busy'),
    );
    return Promise.resolve(active);
  }

  listSessions(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<SessionListPage> {
    // Keyset (createdAt desc, id desc): stable sort then resume after
    // the cursor row's position — mirrors the Drizzle repo.
    let all = Array.from(this.sessions.values())
      .filter((s) => s.accountId === accountId)
      .sort((a, b) => {
        const dt = b.createdAt.getTime() - a.createdAt.getTime();
        if (dt !== 0) return dt;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    if (opts.cursor !== undefined) {
      const idx = all.findIndex((s) => s.id === opts.cursor);
      if (idx >= 0) all = all.slice(idx + 1);
    }
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.id : null,
    });
  }

  listAllSessions(opts: {
    limit: number;
    cursor?: string;
    status?: SessionRecord['status'];
    accountId?: string;
  }): Promise<SessionListPage> {
    // Keyset (createdAt desc, id desc) — see listSessions.
    let all = Array.from(this.sessions.values())
      .filter((s) => (opts.accountId ? s.accountId === opts.accountId : true))
      .filter((s) => (opts.status ? s.status === opts.status : true))
      .sort((a, b) => {
        const dt = b.createdAt.getTime() - a.createdAt.getTime();
        if (dt !== 0) return dt;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    if (opts.cursor !== undefined) {
      const idx = all.findIndex((s) => s.id === opts.cursor);
      if (idx >= 0) all = all.slice(idx + 1);
    }
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.id : null,
    });
  }

  listExpiredForAutoDestroy(opts: {
    tierCutoffs: ReadonlyArray<{ tier: AccountTier; expiredBefore: Date }>;
    limit: number;
  }): Promise<SessionRecord[]> {
    // Mirrors the Drizzle query: active (creating/ready/busy) sessions whose
    // account tier matches one of the supplied cutoffs AND whose createdAt
    // is strictly before that tier's cutoff. Oldest-first, capped at limit.
    if (opts.tierCutoffs.length === 0) return Promise.resolve([]);
    const cutoffByTier = new Map<AccountTier, Date>();
    for (const c of opts.tierCutoffs) cutoffByTier.set(c.tier, c.expiredBefore);

    const matches = Array.from(this.sessions.values())
      .filter((s) => s.status === 'creating' || s.status === 'ready' || s.status === 'busy')
      .filter((s) => {
        // Unseen accounts default to 'free' — mirrors the accounts.tier
        // column default so the join semantics match the Drizzle repo.
        const tier = this.accountTiers.get(s.accountId) ?? 'free';
        const cutoff = cutoffByTier.get(tier);
        return cutoff !== undefined && s.createdAt.getTime() < cutoff.getTime();
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    return Promise.resolve(matches.slice(0, opts.limit));
  }

  recordEvent(input: SessionEventInput): Promise<void> {
    this.events.push({
      ...input,
      id: randomUUID(),
      createdAt: new Date(),
    });
    return Promise.resolve();
  }

  setEgressCapabilityReport(args: {
    sessionId: string;
    derived: {
      udp_associate: boolean;
      quic_route: 'proxy' | 'direct' | 'disabled';
      dns_remote_resolve: boolean;
      warnings: string[];
    };
    raw: Record<string, unknown>;
  }): Promise<SessionRecord | null> {
    const s = this.sessions.get(args.sessionId);
    if (!s) return Promise.resolve(null);
    const updated: SessionRecord = {
      ...s,
      egressCapabilities: args.derived,
      egressCapabilityReport: args.raw,
      updatedAt: new Date(),
    };
    this.sessions.set(args.sessionId, updated);
    return Promise.resolve(updated);
  }

  /** Test helper: read all events ever recorded. */
  getEvents(): StoredEvent[] {
    return [...this.events];
  }

  /** Test helper: read a session by id (account-unscoped). */
  getSession(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  /**
   * 6.g test helper: register the tier of an account so
   * `listExpiredForAutoDestroy` can resolve it (stand-in for the
   * sessions→accounts join in the Drizzle repo).
   */
  setAccountTier(accountId: string, tier: AccountTier): void {
    this.accountTiers.set(accountId, tier);
  }

  /**
   * 6.g test helper: insert a session with a caller-controlled `createdAt`
   * + `status`. `insertSession` always stamps `new Date()`; the duration
   * sweep is time-driven, so tests need to plant rows at arbitrary ages.
   */
  seedSession(input: {
    accountId: string;
    status?: SessionRecord['status'];
    createdAt: Date;
    apiKeyId?: string;
    driverSessionId?: string;
    archetype?: string;
  }): SessionRecord {
    const record: SessionRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      apiKeyId: input.apiKeyId ?? randomUUID(),
      driverSessionId: input.driverSessionId ?? `drv_${randomUUID()}`,
      status: input.status ?? 'ready',
      archetype: input.archetype ?? 'iphone16pro_ios18_7_safari26_4',
      purpose: 'production_customer',
      label: null,
      metadata: null,
      egressCapabilities: null,
      egressCapabilityReport: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      lastStateAt: null,
      destroyedAt:
        input.status === 'destroyed' || input.status === 'errored' ? input.createdAt : null,
    };
    this.sessions.set(record.id, record);
    return record;
  }
}
