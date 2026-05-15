// V-667.C — unit tests for OAuthClientServiceImpl using the in-memory
// repo helpers. Exercises all 4 LinkOrCreateAccountResult branches
// + the confirmPendingLink completion flow.

import { describe, expect, it } from 'vitest';
import { OAuthClientServiceImpl } from '../../src/services/oauth-client-service.js';
import type {
  AccountsLookup,
  OAuthPendingMailer,
} from '../../src/services/oauth-client-service.js';
import {
  InMemoryOAuthLinksRepo,
  InMemoryOAuthPendingLinksRepo,
} from '../integration/_helpers/in-memory-oauth-links-repo.js';

interface MailCall {
  to: string;
  provider: string;
  plaintextToken: string;
  expiresAt: Date;
}

function makeAccountsLookup(opts: { existingEmails?: Record<string, string> }): AccountsLookup {
  const existing = new Map<string, string>(Object.entries(opts.existingEmails ?? {}));
  let nextId = 1000;
  return {
    findIdByEmail(email: string) {
      return Promise.resolve(existing.get(email.toLowerCase()) ?? null);
    },
    createFromIdp(args) {
      const id = `acc-${nextId++}`;
      existing.set(args.email.toLowerCase(), id);
      return Promise.resolve(id);
    },
  };
}

function makeMailer(): OAuthPendingMailer & { calls: MailCall[] } {
  const calls: MailCall[] = [];
  return {
    calls,
    sendVerifyMergeEmail(args) {
      calls.push(args);
      return Promise.resolve();
    },
  };
}

function makeService(opts: { existingEmails?: Record<string, string> } = {}): {
  service: OAuthClientServiceImpl;
  links: InMemoryOAuthLinksRepo;
  pending: InMemoryOAuthPendingLinksRepo;
  accounts: AccountsLookup;
  mailer: OAuthPendingMailer & { calls: MailCall[] };
} {
  const links = new InMemoryOAuthLinksRepo();
  const pending = new InMemoryOAuthPendingLinksRepo();
  const accounts = makeAccountsLookup({ existingEmails: opts.existingEmails });
  const mailer = makeMailer();
  const service = new OAuthClientServiceImpl({ links, pending, accounts, mailer });
  return { service, links, pending, accounts, mailer };
}

const BASE_ARGS = {
  provider: 'google' as const,
  providerSub: 'google-sub-12345',
  email: 'user@example.test',
  name: 'Test User',
  avatarUrl: 'https://lh3.googleusercontent.com/a/abc',
};

describe('OAuthClientServiceImpl.linkOrCreateAccount', () => {
  it('no link + no colliding account → kind: created-new-account + link inserted + markLoginAt', async () => {
    const { service, links } = makeService();
    const res = await service.linkOrCreateAccount(BASE_ARGS);
    expect(res.kind).toBe('created-new-account');
    expect(links.rows.length).toBe(1);
    expect(links.rows[0]?.lastLoginAt).not.toBe(null);
  });

  it('existing link (same provider+sub) → kind: signed-in-existing-link + markLoginAt bumped', async () => {
    const { service, links } = makeService();
    await service.linkOrCreateAccount(BASE_ARGS); // creates account + link
    const firstLogin = links.rows[0]?.lastLoginAt;
    expect(firstLogin).not.toBe(null);
    // Sign in again — should resolve to the same link, bump login time.
    const later = new Date(Date.now() + 1000);
    const res = await service.linkOrCreateAccount({ ...BASE_ARGS, now: later });
    expect(res.kind).toBe('signed-in-existing-link');
    expect(links.rows.length).toBe(1); // no new link
    expect(links.rows[0]?.lastLoginAt?.getTime()).toBe(later.getTime());
  });

  it('existing link marked revoked → kind: existing-link-revoked (Verdict 2 graceful fallback)', async () => {
    const { service, links } = makeService();
    await service.linkOrCreateAccount(BASE_ARGS);
    const linkId = links.rows[0]?.id ?? '';
    await links.markRevokedAt(linkId, new Date());
    const res = await service.linkOrCreateAccount(BASE_ARGS);
    expect(res.kind).toBe('existing-link-revoked');
    if (res.kind === 'existing-link-revoked') expect(res.accountId).toBe(links.rows[0]?.accountId);
  });

  it('email already has password account, no link → kind: collision-pending-verification + email sent (Verdict 1)', async () => {
    const { service, pending, mailer } = makeService({
      existingEmails: { 'user@example.test': 'existing-acc-99' },
    });
    const now = new Date('2026-05-15T16:00:00Z');
    const res = await service.linkOrCreateAccount({ ...BASE_ARGS, now });
    expect(res.kind).toBe('collision-pending-verification');
    if (res.kind === 'collision-pending-verification') {
      expect(res.expiresAt.getTime() - now.getTime()).toBe(60 * 60 * 1000);
    }
    expect(pending.rows.length).toBe(1);
    expect(pending.rows[0]?.accountId).toBe('existing-acc-99');
    expect(mailer.calls.length).toBe(1);
    expect(mailer.calls[0]?.to).toBe('user@example.test');
    expect(mailer.calls[0]?.provider).toBe('google');
    // Token hash != plaintext (plaintext is only in the mail).
    expect(pending.rows[0]?.tokenHash).not.toBe(mailer.calls[0]?.plaintextToken);
  });
});

describe('OAuthClientServiceImpl.confirmPendingLink', () => {
  it('happy path — consumes pending + inserts link + returns accountId', async () => {
    const { service, links, pending, mailer } = makeService({
      existingEmails: { 'user@example.test': 'existing-acc-99' },
    });
    const res = await service.linkOrCreateAccount(BASE_ARGS);
    expect(res.kind).toBe('collision-pending-verification');
    const plaintext = mailer.calls[0]?.plaintextToken ?? '';
    expect(plaintext.length).toBe(64);

    const confirm = await service.confirmPendingLink(plaintext);
    expect(confirm).not.toBe(null);
    expect(confirm?.accountId).toBe('existing-acc-99');
    expect(links.rows.length).toBe(1);
    expect(pending.rows[0]?.consumedAt).not.toBe(null);
  });

  it('expired token → null', async () => {
    const { service, mailer } = makeService({
      existingEmails: { 'user@example.test': 'a' },
    });
    const issuedAt = new Date('2026-05-15T16:00:00Z');
    await service.linkOrCreateAccount({ ...BASE_ARGS, now: issuedAt });
    const plaintext = mailer.calls[0]?.plaintextToken ?? '';
    // 61 minutes later — past the 60-min TTL.
    const tooLate = new Date(issuedAt.getTime() + 61 * 60 * 1000);
    const confirm = await service.confirmPendingLink(plaintext, tooLate);
    expect(confirm).toBe(null);
  });

  it('already-consumed token → null (single-use)', async () => {
    const { service, mailer } = makeService({
      existingEmails: { 'user@example.test': 'a' },
    });
    await service.linkOrCreateAccount(BASE_ARGS);
    const plaintext = mailer.calls[0]?.plaintextToken ?? '';
    const first = await service.confirmPendingLink(plaintext);
    expect(first).not.toBe(null);
    const second = await service.confirmPendingLink(plaintext);
    expect(second).toBe(null);
  });

  it('unknown token → null', async () => {
    const { service } = makeService();
    const res = await service.confirmPendingLink('a'.repeat(64));
    expect(res).toBe(null);
  });
});
