// V-553.B-10 — unit tests for StatusSubscribersService (V-295c3 + tombstone).
//
// Surface under test:
//   - subscribe(): validation, plaintext token issuance, email fires
//   - confirm(): expired token, unknown hash, success path, unsub-link
//     mint, welcome email side-effect
//   - unsubscribe(): unknown hash, success path
//   - listConfirmed(), listAll(), rotateUnsubscribeToken()
//   - forceUnsubscribe() idempotency
//   - processPurge(): cutoff math, snapshot stability across mutations

import { describe, expect, it, vi } from 'vitest';
import {
  StatusSubscribersService,
  type StatusSubscriberRow,
  type StatusSubscribersRepo,
} from '../../src/services/status-subscribers.js';
import { tokenHash } from '../../src/lib/auth-tokens.js';
import type { EmailService } from '../../src/services/email.js';

interface CapturedEmail {
  template: 'confirmation' | 'welcome';
  to: string;
  payload: Record<string, unknown>;
}

function makeEmail(): { service: EmailService; sends: CapturedEmail[] } {
  const sends: CapturedEmail[] = [];
  const service = {
    sendStatusSubscriptionConfirmation: (args: {
      to: string;
      confirmLink: string;
      expiresAt: Date;
    }) => {
      sends.push({ template: 'confirmation', to: args.to, payload: { ...args } });
      return Promise.resolve();
    },
    sendStatusSubscriptionWelcome: (args: {
      to: string;
      statusPageUrl: string;
      unsubscribeLink: string;
    }) => {
      sends.push({ template: 'welcome', to: args.to, payload: { ...args } });
      return Promise.resolve();
    },
  } as unknown as EmailService;
  return { service, sends };
}

function makeRepo(initial: StatusSubscriberRow[] = []): {
  repo: StatusSubscribersRepo;
  rows: StatusSubscriberRow[];
} {
  const rows: StatusSubscriberRow[] = [...initial];
  const repo: StatusSubscribersRepo = {
    upsertPending: (input) => {
      const existing = rows.find((r) => r.email === input.email);
      if (existing) {
        existing.confirmTokenHash = input.confirmTokenHash;
        existing.confirmExpiresAt = input.confirmExpiresAt;
        return Promise.resolve(existing);
      }
      const row: StatusSubscriberRow = {
        id: `sub_${(rows.length + 1).toString()}`,
        email: input.email,
        confirmTokenHash: input.confirmTokenHash,
        confirmExpiresAt: input.confirmExpiresAt,
        confirmedAt: null,
        unsubscribeTokenHash: null,
        unsubscribedAt: null,
        createdAt: new Date(),
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    findByConfirmTokenHash: (hash) =>
      Promise.resolve(rows.find((r) => r.confirmTokenHash === hash) ?? null),
    findByUnsubscribeTokenHash: (hash) =>
      Promise.resolve(rows.find((r) => r.unsubscribeTokenHash === hash) ?? null),
    markConfirmed: ({ id, expectedConfirmTokenHash, confirmedAt, unsubscribeTokenHash }) => {
      const row = rows.find(
        (candidate) =>
          candidate.id === id && candidate.confirmTokenHash === expectedConfirmTokenHash,
      );
      if (!row) return Promise.resolve(null);
      row.confirmedAt = confirmedAt;
      row.unsubscribeTokenHash = unsubscribeTokenHash;
      row.confirmTokenHash = null;
      row.confirmExpiresAt = null;
      row.unsubscribedAt = null;
      return Promise.resolve(row);
    },
    markUnsubscribed: ({ id, expectedUnsubscribeTokenHash, unsubscribedAt }) => {
      const row = rows.find(
        (candidate) =>
          candidate.id === id &&
          (expectedUnsubscribeTokenHash === null ||
            candidate.unsubscribeTokenHash === expectedUnsubscribeTokenHash),
      );
      if (!row) return Promise.resolve(null);
      row.unsubscribedAt = unsubscribedAt;
      return Promise.resolve(row);
    },
    rotateUnsubscribeTokenHash: ({ id, hash }) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error('row not found');
      row.unsubscribeTokenHash = hash;
      return Promise.resolve();
    },
    listConfirmed: () =>
      Promise.resolve(rows.filter((r) => r.confirmedAt !== null && r.unsubscribedAt === null)),
    listAll: ({ limit, offset }) => Promise.resolve(rows.slice(offset, offset + limit)),
    getById: (id) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
    listPurgeCandidates: (cutoff) =>
      Promise.resolve(
        rows.filter(
          (r) => r.unsubscribedAt !== null && r.unsubscribedAt < cutoff && r.email !== null,
        ),
      ),
    purgeEmails: (ids) => {
      let n = 0;
      for (const id of ids) {
        const row = rows.find((r) => r.id === id);
        if (row && row.email !== null) {
          row.email = null;
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
  };
  return { repo, rows };
}

const NOW = new Date('2026-05-11T12:00:00Z');
const CONFIG = { statusPageBaseUrl: 'https://status.driftstack.dev/' };

describe('V-553.B-10 StatusSubscribersService.subscribe', () => {
  it('rejects invalid emails before touching the repo', async () => {
    const { service: email, sends } = makeEmail();
    const { repo, rows } = makeRepo();
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    await expect(svc.subscribe('not-an-email', NOW)).rejects.toThrow(/Invalid email/);
    expect(rows).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it('lowercases + trims the email; stores the token HASH (not plaintext); fires the confirmation email', async () => {
    const { service: email, sends } = makeEmail();
    const { repo, rows } = makeRepo();
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    await svc.subscribe('  USER@Example.COM ', NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('user@example.com');
    expect(rows[0]?.confirmTokenHash?.length).toBeGreaterThan(0);
    // Plaintext token is never persisted — only the hash is.
    expect(sends).toHaveLength(1);
    const sent = sends[0];
    expect(sent?.template).toBe('confirmation');
    expect(sent?.to).toBe('user@example.com');
    const link = String(sent?.payload.confirmLink);
    expect(link).toMatch(/^https:\/\/status\.driftstack\.dev\/subscribe\/confirm\/\?token=/);
    // Confirm URL strips any trailing slash from the configured base url.
    expect(link).not.toContain('driftstack.dev//');
  });

  it('keeps an active subscription and its unsubscribe credential live until re-confirmation', async () => {
    const { service: email, sends } = makeEmail();
    const { repo, rows } = makeRepo();
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    await svc.subscribe('user@example.com', NOW);
    const firstToken = new URL(String(sends[0]?.payload.confirmLink)).searchParams.get('token');
    await svc.confirm(firstToken ?? '', NOW);
    const confirmedAt = rows[0]?.confirmedAt;
    const unsubscribeTokenHash = rows[0]?.unsubscribeTokenHash;

    // An anonymous re-subscribe starts a new pending proof, but must not let
    // the submitter suppress incident notifications or invalidate the
    // mailbox owner's current unsubscribe link before that proof is used.
    await svc.subscribe('user@example.com', NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.confirmedAt).toEqual(confirmedAt);
    expect(rows[0]?.unsubscribedAt).toBeNull();
    expect(rows[0]?.unsubscribeTokenHash).toBe(unsubscribeTokenHash);
    await expect(svc.listConfirmed()).resolves.toHaveLength(1);
  });
});

describe('V-553.B-10 StatusSubscribersService.confirm', () => {
  it('rejects unknown confirm tokens', async () => {
    const { service: email } = makeEmail();
    const { repo } = makeRepo();
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    await expect(svc.confirm('totally-random', NOW)).rejects.toThrow(/invalid or has been used/);
  });

  it('rejects expired confirm tokens (BadRequest, not NotFound)', async () => {
    const { service: email } = makeEmail();
    const expired: StatusSubscriberRow = {
      id: 'sub_1',
      email: 'a@b.test',
      confirmTokenHash: tokenHash('plain-tok'),
      confirmExpiresAt: new Date('2026-05-11T00:00:00Z'),
      confirmedAt: null,
      unsubscribeTokenHash: null,
      unsubscribedAt: null,
      createdAt: new Date(),
    };
    const { repo } = makeRepo([expired]);
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    await expect(svc.confirm('plain-tok', NOW)).rejects.toThrow(/expired/);
  });

  it('on success: stores confirmedAt + unsub-token hash + sends welcome email', async () => {
    const { service: email, sends } = makeEmail();
    const { repo, rows } = makeRepo();
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    await svc.subscribe('user@example.com', NOW);
    const confirmLink = String(sends[0]?.payload.confirmLink);
    const plaintext = decodeURIComponent(confirmLink.split('token=')[1] ?? '');
    const result = await svc.confirm(plaintext, NOW);
    expect(result.email).toBe('user@example.com');
    expect(rows[0]?.confirmedAt).toBeTruthy();
    expect(rows[0]?.unsubscribeTokenHash).toBeTruthy();
    // Welcome email is the 2nd send.
    expect(sends).toHaveLength(2);
    expect(sends[1]?.template).toBe('welcome');
    expect(sends[1]?.payload.unsubscribeLink).toMatch(/\/subscribe\/unsubscribe\/\?token=/);
  });

  it('atomically claims a confirmation token so only one concurrent caller sends welcome', async () => {
    const { service: email, sends } = makeEmail();
    const { repo } = makeRepo();
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    await svc.subscribe('race@example.com', NOW);
    const plaintext = new URL(String(sends[0]?.payload.confirmLink)).searchParams.get('token');

    const results = await Promise.allSettled([
      svc.confirm(plaintext ?? '', NOW),
      svc.confirm(plaintext ?? '', NOW),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(sends.filter((send) => send.template === 'welcome')).toHaveLength(1);
  });
});

describe('V-553.B-10 StatusSubscribersService.unsubscribe', () => {
  it('rejects unknown unsubscribe tokens', async () => {
    const { service: email } = makeEmail();
    const { repo } = makeRepo();
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    await expect(svc.unsubscribe('nope', NOW)).rejects.toThrow(/invalid/);
  });

  it('on success marks unsubscribedAt + returns the email for audit', async () => {
    const { service: email } = makeEmail();
    const row: StatusSubscriberRow = {
      id: 'sub_1',
      email: 'a@b.test',
      confirmTokenHash: null,
      confirmExpiresAt: null,
      confirmedAt: new Date('2026-04-01Z'),
      unsubscribeTokenHash: tokenHash('unsub-plain'),
      unsubscribedAt: null,
      createdAt: new Date(),
    };
    const { repo, rows } = makeRepo([row]);
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    const result = await svc.unsubscribe('unsub-plain', NOW);
    expect(result.email).toBe('a@b.test');
    expect(rows[0]?.unsubscribedAt).toEqual(NOW);
  });
});

describe('V-553.B-10 StatusSubscribersService — admin + housekeeping', () => {
  it('listConfirmed returns only confirmed + still-subscribed rows', async () => {
    const { service: email } = makeEmail();
    const rows: StatusSubscriberRow[] = [
      {
        id: 's1',
        email: 'kept@b.test',
        confirmTokenHash: null,
        confirmExpiresAt: null,
        confirmedAt: new Date('2026-04-01Z'),
        unsubscribeTokenHash: 'h1',
        unsubscribedAt: null,
        createdAt: new Date(),
      },
      {
        id: 's2',
        email: 'gone@b.test',
        confirmTokenHash: null,
        confirmExpiresAt: null,
        confirmedAt: new Date('2026-04-01Z'),
        unsubscribeTokenHash: 'h2',
        unsubscribedAt: new Date('2026-04-15Z'),
        createdAt: new Date(),
      },
    ];
    const { repo } = makeRepo(rows);
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    const confirmed = await svc.listConfirmed();
    expect(confirmed.map((r) => r.email)).toEqual(['kept@b.test']);
  });

  it('rotateUnsubscribeToken issues a fresh plaintext + invalidates old token via hash swap', async () => {
    const { service: email } = makeEmail();
    const row: StatusSubscriberRow = {
      id: 'sub_1',
      email: 'a@b.test',
      confirmTokenHash: null,
      confirmExpiresAt: null,
      confirmedAt: new Date(),
      unsubscribeTokenHash: tokenHash('old-tok'),
      unsubscribedAt: null,
      createdAt: new Date(),
    };
    const { repo, rows } = makeRepo([row]);
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    const fresh = await svc.rotateUnsubscribeToken('sub_1');
    expect(fresh.length).toBeGreaterThan(0);
    expect(rows[0]?.unsubscribeTokenHash).toBe(tokenHash(fresh));
    expect(rows[0]?.unsubscribeTokenHash).not.toBe(tokenHash('old-tok'));
  });

  it('forceUnsubscribe is idempotent — already-unsubscribed rows return the email without re-writing', async () => {
    const { service: email } = makeEmail();
    const alreadyOut = new Date('2026-04-15Z');
    const row: StatusSubscriberRow = {
      id: 's1',
      email: 'a@b.test',
      confirmTokenHash: null,
      confirmExpiresAt: null,
      confirmedAt: new Date('2026-04-01Z'),
      unsubscribeTokenHash: 'h',
      unsubscribedAt: alreadyOut,
      createdAt: new Date(),
    };
    const { repo, rows } = makeRepo([row]);
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    const result = await svc.forceUnsubscribe('s1', NOW);
    expect(result.email).toBe('a@b.test');
    // The original unsubscribedAt is preserved.
    expect(rows[0]?.unsubscribedAt).toEqual(alreadyOut);
  });

  it('adminForceSubscribe (fresh email): confirms without an email + returns a WORKING /subscribe/unsubscribe link', async () => {
    const { service: email, sends } = makeEmail();
    const { repo, rows } = makeRepo();
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    const out = await svc.adminForceSubscribe('  Admin@Example.COM ', NOW);
    // Bypasses double-opt-in: no confirmation/welcome email fired.
    expect(sends).toHaveLength(0);
    expect(out.email).toBe('admin@example.com');
    expect(out.confirmedAt).toEqual(NOW);
    // CRITICAL — the unsubscribe link must use the SAME path the status-site
    // routes (`/subscribe/unsubscribe/`), not a bare `/unsubscribe` (404). This
    // is the link the docstring says staff copy/share with the subscriber.
    const url = new URL(out.unsubscribeLink);
    expect(url.pathname).toBe('/subscribe/unsubscribe/');
    // The link is functional end-to-end: its token hashes to the stored hash.
    const token = url.searchParams.get('token');
    expect(token).toBeTruthy();
    expect(rows[0]?.unsubscribeTokenHash).toBe(tokenHash(token ?? ''));
  });

  it('adminForceSubscribe (re-adding an active subscriber): preserves confirmation + mints a fresh WORKING unsubscribe link', async () => {
    const { service: email } = makeEmail();
    const row: StatusSubscriberRow = {
      id: 'sub_1',
      email: 'admin@example.com',
      confirmTokenHash: null,
      confirmExpiresAt: null,
      confirmedAt: new Date('2026-04-01Z'),
      unsubscribeTokenHash: tokenHash('old-tok'),
      unsubscribedAt: null,
      createdAt: new Date(),
    };
    const { repo, rows } = makeRepo([row]);
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    const out = await svc.adminForceSubscribe('admin@example.com', NOW);
    expect(out.confirmedAt).toEqual(new Date('2026-04-01Z'));
    expect(rows[0]?.confirmTokenHash).toBeNull();
    expect(rows[0]?.confirmExpiresAt).toBeNull();
    const url = new URL(out.unsubscribeLink);
    expect(url.pathname).toBe('/subscribe/unsubscribe/');
    const token = url.searchParams.get('token');
    expect(token).toBeTruthy();
    // The link carries the freshly-minted token (old one invalidated).
    expect(rows[0]?.unsubscribeTokenHash).toBe(tokenHash(token ?? ''));
    expect(rows[0]?.unsubscribeTokenHash).not.toBe(tokenHash('old-tok'));
  });
});

describe('V-553.B-10 StatusSubscribersService.processPurge', () => {
  it('returns empty when no rows are eligible', async () => {
    const { service: email } = makeEmail();
    const { repo } = makeRepo();
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    const result = await svc.processPurge(NOW);
    expect(result.purged).toEqual([]);
  });

  it('snapshots id + email BEFORE the in-place mutation (stable return value)', async () => {
    const { service: email } = makeEmail();
    // Row unsubscribed 100 days ago — past the 90d retention.
    const oldUnsub = new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000);
    const row: StatusSubscriberRow = {
      id: 's1',
      email: 'gone@b.test',
      confirmTokenHash: null,
      confirmExpiresAt: null,
      confirmedAt: new Date('2026-01-01Z'),
      unsubscribeTokenHash: 'h',
      unsubscribedAt: oldUnsub,
      createdAt: new Date('2025-12-01Z'),
    };
    const { repo, rows } = makeRepo([row]);
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    const result = await svc.processPurge(NOW);
    // The repo mutated the row in place (email is now null), but the
    // snapshot returned by processPurge carries the pre-mutation email.
    expect(rows[0]?.email).toBeNull();
    expect(result.purged).toEqual([{ id: 's1', email: 'gone@b.test' }]);
  });

  it('honours the custom retention window override', async () => {
    const { service: email } = makeEmail();
    const oneDayAgo = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    const row: StatusSubscriberRow = {
      id: 's1',
      email: 'gone@b.test',
      confirmTokenHash: null,
      confirmExpiresAt: null,
      confirmedAt: new Date('2026-04-01Z'),
      unsubscribeTokenHash: 'h',
      unsubscribedAt: oneDayAgo,
      createdAt: new Date(),
    };
    const { repo, rows } = makeRepo([row]);
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    // 12h retention — unsubscribed 24h ago is past the cutoff.
    const result = await svc.processPurge(NOW, 12 * 60 * 60 * 1000);
    expect(result.purged).toHaveLength(1);
    expect(rows[0]?.email).toBeNull();
  });
});

describe('V-553.B-10 — vi.fn-style observability spy is not strictly required', () => {
  it('uses the real tokenHash helper so the test exercises the same hashing the route does', () => {
    // Sanity check — if tokenHash were swapped out the rest of the
    // suite would silently pass with mismatched hashes. We assert
    // the hash is non-trivial here so the suite documents what it depends on.
    const h = tokenHash('abc');
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(16);
    // Ensures vi import is exercised; placeholder so a stale import
    // doesn't sneak in.
    const noop = vi.fn();
    noop();
    expect(noop).toHaveBeenCalled();
  });
});

// ─── the refusals the customer path has and the admin path did not ─────────
//
// Swept this service's 13 refusal sites. Eight were uncovered, and they sort
// into the shapes this codebase keeps producing:
//
//   the ADMIN copy of a rule whose CUSTOMER copy is tested (:220, :260)
//   the atomic-claim loser, distinct from the pre-read (:176)
//   defensive purge-row guards (:133, :168)
//   internal invariants that say they cannot happen (:233, :244)
//
// These three are the ones with behaviour behind them.
//
// LEDGER — control 21/21:
//
//   :176 unsubscribe lost-CAS neutralized   1 red
//   :220 admin email check neutralized      1 red
//   :260 forceUnsubscribe not-found         1 red
//   :220 narrowed to empty-string only      1 red
//
// The narrowing is the row worth keeping. Reduced to `!normalized`, the guard is
// still present and still rejects blank input — the case anyone would try by
// hand — while `not-an-email` passes and a staff tool creates a subscriber whose
// address can never receive a confirm or unsubscribe mail. That is why the arm
// sends three shapes rather than one.
describe('status-subscriber refusals that were cold', () => {
  it('CRITICAL an unsubscribe whose token changed between the read and the WRITE is refused. The lookup succeeded, so the pre-read cannot catch this — only the conditional update can, and without it a rotated-away token still unsubscribes the address it used to name.', async () => {
    const { service: email } = makeEmail();
    const token = 'live-unsub-token';
    const row: StatusSubscriberRow = {
      id: 's-cas',
      email: 'racer@b.test',
      confirmTokenHash: null,
      confirmExpiresAt: null,
      confirmedAt: new Date('2026-04-01Z'),
      unsubscribeTokenHash: tokenHash(token),
      unsubscribedAt: null,
      createdAt: new Date(),
    };
    const { repo } = makeRepo([row]);
    // The row is findable by the presented token, and the conditional write then
    // matches nothing — exactly what a rotation landing mid-request looks like.
    const racingRepo = {
      ...repo,
      markUnsubscribed: () => Promise.resolve(null),
    };
    const svc = new StatusSubscribersService(racingRepo, email, CONFIG);
    await expect(svc.unsubscribe(token, NOW)).rejects.toThrow(/Unsubscribe link is invalid/i);
  });

  it('CRITICAL adminForceSubscribe rejects a malformed address — the staff copy of the check the public subscribe path already has. Two entry points, one rule, and only the public one was tested.', async () => {
    const { service: email } = makeEmail();
    const { repo, rows } = makeRepo([]);
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    for (const bad of ['', '   ', 'not-an-email']) {
      await expect(svc.adminForceSubscribe(bad, NOW)).rejects.toThrow(/Invalid email address/i);
    }
    // The property, not the message: a refused address creates no row. A staff
    // tool that half-created a subscriber on bad input would leave a record
    // nobody can confirm or unsubscribe.
    expect(rows).toHaveLength(0);
  });

  it('forceUnsubscribe refuses an unknown subscriber id rather than reporting success for a row that does not exist', async () => {
    const { service: email } = makeEmail();
    const { repo } = makeRepo([]);
    const svc = new StatusSubscribersService(repo, email, CONFIG);
    await expect(svc.forceUnsubscribe('s-missing', NOW)).rejects.toThrow(/not found/i);
  });
});
