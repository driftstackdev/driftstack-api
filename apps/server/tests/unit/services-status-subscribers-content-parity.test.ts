// W409.A — drift guard for apps/server/src/services/status-subscribers.ts.
// V-295c3 public status-page email-subscriber service with double-
// opt-in + V-295c3-tombstone 90d post-unsubscribe email purge.
// Drift here either lets unconfirmed signups onto the notification
// list (double-opt-in bypass) or scrambles the 90d purge cutoff
// (regulatory tombstone risk).
//
//   • V-295c3 framing pinned: 3-flow (subscribe / confirm /
//     unsubscribe); double-opt-in gate; re-subscribe refreshes only
//     pending proof and preserves current notification/opt-out authority.
//   • V-295c3-tombstone framing: 90d post-unsubscribe email purge
//     (NULLs email column); row persists for re-subscription fresh
//     double-opt-in.
//   • CONFIRM_TOKEN_TTL_MS = 24h.
//   • subscribe: lowercase + @-check (BadRequestError); upsertPending
//     with 24h TTL; sendStatusSubscriptionConfirmation.
//   • confirm: NotFoundError on unknown/stale hash; BadRequestError on
//     expired; atomic hash-bound claim, then one welcome email.
//   • unsubscribe: NotFoundError on unknown/stale hash; atomic
//     hash-bound transition.
//   • V-295c3-followup rotateUnsubscribeToken: per-email fresh
//     token; old token invalidated as soon as new one issued
//     (one-click unsub targets most recent email).
//   • V-295c3-tombstone forceUnsubscribe: admin no-token gate;
//     idempotent on already-unsubscribed (returns email for audit).
//   • V-295c3-tombstone processPurge: retentionMs default 90d;
//     snapshot id+email BEFORE in-place mutation so in-memory repos
//     are stable.
//   • statusPageBaseUrl trailing-slash stripped at construction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W409.A apps/server/src/services/status-subscribers.ts content parity', () => {
  const body = read(LIB);

  it('V-295c3 framing pinned: 3-flow + double-opt-in gate + re-subscribe semantics', () => {
    expect(body).toMatch(/V-295c3 — public status-page email subscriber service\./);
    expect(body).toMatch(
      /1\. subscribe\(email\) — generates confirm token, stores sha256 hash \+\s*\n?\s*\/\/\s*24h expiry, returns the plaintext token to the caller \(route\s*\n?\s*\/\/\s*hands it to email\.sendStatusSubscriptionConfirmation\)\./,
    );
    expect(body).toMatch(
      /Re-subscribe semantics: if the email already exists, we update only the\s*\n?\s*\/\/\s*pending confirm token\. Existing confirmed\/unsubscribed state remains\s*\n?\s*\/\/\s*authoritative until the mailbox owner uses that token\./,
    );
  });

  it('CONFIRM_TOKEN_TTL_MS = 24h', () => {
    expect(body).toMatch(/export const CONFIRM_TOKEN_TTL_MS = 24 \* 60 \* 60 \* 1000; \/\/ 24h/);
  });

  it('V-295c3-tombstone framing: email column NULL after 90d purge; row persists for re-subscription fresh double-opt-in', () => {
    expect(body).toMatch(
      /\/\*\* Null only when V-295c3-tombstone purge has zeroed the email out\s*\n?\s*\*\s*\(90d post-unsubscribe\)\. The row persists so re-subscription kicks\s*\n?\s*\*\s*off a fresh double-opt-in flow\. \*\/\s*\n?\s*email: string \| null;/,
    );
  });

  it('subscribe: email lowercase + @-check → BadRequestError; upsertPending with 24h TTL; sendStatusSubscriptionConfirmation', () => {
    expect(body).toMatch(/const normalized = rawEmail\.trim\(\)\.toLowerCase\(\);/);
    expect(body).toMatch(
      /if \(!normalized \|\| !normalized\.includes\('@'\)\) \{\s*\n?\s*throw new BadRequestError\('Invalid email address\.'\);/,
    );
    expect(body).toMatch(/const expiresAt = new Date\(now\.getTime\(\) \+ CONFIRM_TOKEN_TTL_MS\);/);
    expect(body).toMatch(
      /const confirmLink = `\$\{this\.baseUrl\}\/subscribe\/confirm\/\?token=\$\{encodeURIComponent\(plaintext\)\}`;/,
    );
    expect(body).not.toMatch(/\/subscribe\/confirm\?token=/);
    expect(body).toMatch(
      /await this\.email\.sendStatusSubscriptionConfirmation\(\{\s*\n?\s*to: normalized,\s*\n?\s*confirmLink,\s*\n?\s*expiresAt,\s*\n?\s*\}\);/,
    );
  });

  it('confirm: validates expiry and atomically consumes the exact hash before sending one welcome', () => {
    expect(body).toMatch(
      /if \(!row\) \{\s*\n?\s*throw new NotFoundError\('Confirmation link is invalid or has been used\.'\);/,
    );
    expect(body).toMatch(
      /if \(row\.confirmExpiresAt && row\.confirmExpiresAt < now\) \{\s*\n?\s*throw new BadRequestError\(\s*\n?\s*'Confirmation link has expired\. Please subscribe again to receive a fresh link\.',\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /\/\/ V-295c3-tombstone — purged rows clear confirmTokenHash, so this\s*\n?\s*\/\/ branch should be unreachable\. Guard for type-narrowing only\./,
    );
    expect(body).toMatch(
      /const confirmed = await this\.repo\.markConfirmed\(\{\s*\n?\s*id: row\.id,\s*\n?\s*expectedConfirmTokenHash: hash,/,
    );
    expect(body).toMatch(
      /if \(confirmed === null\) \{[\s\S]*?throw new NotFoundError\('Confirmation link is invalid or has been used\.'\);/,
    );
    expect(body).toMatch(
      /await this\.email\.sendStatusSubscriptionWelcome\(\{\s*\n?\s*to: email,\s*\n?\s*statusPageUrl: this\.baseUrl,\s*\n?\s*unsubscribeLink,\s*\n?\s*\}\);/,
    );
    expect(body.match(/\/subscribe\/unsubscribe\/\?token=/g)).toHaveLength(2);
    expect(body).not.toMatch(/\/subscribe\/unsubscribe\?token=/);
  });

  it('unsubscribe: NotFoundError on unknown/stale hash + atomic exact-hash transition', () => {
    expect(body).toMatch(
      /if \(!row\) \{\s*\n?\s*throw new NotFoundError\('Unsubscribe link is invalid\.'\);/,
    );
    expect(body).toMatch(/\/\/ Same purge-row defensive guard as confirm\(\) above\./);
    expect(body).toMatch(
      /const unsubscribed = await this\.repo\.markUnsubscribed\(\{\s*\n?\s*id: row\.id,\s*\n?\s*expectedUnsubscribeTokenHash: hash,\s*\n?\s*unsubscribedAt: now,\s*\n?\s*\}\);\s*\n?\s*if \(unsubscribed === null\) \{\s*\n?\s*throw new NotFoundError\('Unsubscribe link is invalid\.'\);/,
    );
  });

  it('V-295c3-followup rotateUnsubscribeToken: per-email fresh token; old token invalidated as soon as new one issued (one-click unsub targets most recent email)', () => {
    expect(body).toMatch(
      /V-295c3-followup — rotate the unsubscribe token for a subscriber \+\s*\n?\s*\*\s*return the fresh plaintext\. The fan-out caller embeds this in the\s*\n?\s*\*\s*unsubscribe URL of one outgoing email; the next notification\s*\n?\s*\*\s*rotates it again\./,
    );
    expect(body).toMatch(
      /Old tokens become invalid as soon as a new one\s*\n?\s*\*\s*is issued — acceptable because one-click unsubscribe is meant to\s*\n?\s*\*\s*target the most recent email a recipient received\./,
    );
    expect(body).toMatch(
      /async rotateUnsubscribeToken\(subscriberId: string\): Promise<string> \{\s*\n?\s*const plaintext = generateAuthToken\(\);\s*\n?\s*const hash = tokenHash\(plaintext\);\s*\n?\s*await this\.repo\.rotateUnsubscribeTokenHash\(\{ id: subscriberId, hash \}\);/,
    );
  });

  it('V-295c3-tombstone forceUnsubscribe: admin no-token authority; idempotent on already-unsubscribed (returns email for audit)', () => {
    expect(body).toMatch(
      /V-295c3-tombstone — admin force-unsubscribe \(no token; admin\s*\n?\s*\*\s*authority\)\. Returns the row before the change so the route can\s*\n?\s*\*\s*audit-log the email value\./,
    );
    expect(body).toMatch(
      /if \(row\.unsubscribedAt !== null\) \{\s*\n?\s*\/\/ Idempotent — already unsubscribed; no-op but return the email\s*\n?\s*\/\/ so the audit-log entry is still informative\.\s*\n?\s*return \{ email: row\.email \};/,
    );
  });

  it('V-295c3-tombstone processPurge: retentionMs default 90d; snapshot id+email BEFORE in-place mutation (stable for in-memory repos)', () => {
    expect(body).toMatch(
      /V-295c3-tombstone — 90d purge of email column on rows that\s*\n?\s*\*\s*unsubscribed >= retentionMs ago\. Returns the purged subscribers\s*\n?\s*\*\s*\(with their pre-purge email\)/,
    );
    expect(body).toMatch(
      /Snapshots id\+email BEFORE the in-place mutation so the return value\s*\n?\s*\*\s*is stable even with in-memory repos that mutate live row objects\./,
    );
    expect(body).toMatch(
      /async processPurge\(\s*\n?\s*now: Date,\s*\n?\s*retentionMs: number = 90 \* 24 \* 60 \* 60 \* 1000,\s*\n?\s*\): Promise<\{ purged: \{ id: string; email: string \| null \}\[\] \}> \{/,
    );
    expect(body).toMatch(/const cutoff = new Date\(now\.getTime\(\) - retentionMs\);/);
    expect(body).toMatch(
      /const snapshot = candidates\.map\(\(r\) => \(\{ id: r\.id, email: r\.email \}\)\);\s*\n?\s*await this\.repo\.purgeEmails\(snapshot\.map\(\(r\) => r\.id\)\);/,
    );
  });

  it('StatusSubscribersRepo: 10-method (upsertPending + 2 findByHash + markConfirmed + markUnsubscribed + V-295c3-followup rotateUnsubscribeTokenHash + listConfirmed + V-295c3-tombstone listAll/getById/listPurgeCandidates/purgeEmails)', () => {
    expect(body).toMatch(/export interface StatusSubscribersRepo \{/);
    expect(body).toMatch(/upsertPending\(input: \{/);
    expect(body).toMatch(
      /findByConfirmTokenHash\(hash: string\): Promise<StatusSubscriberRow \| null>;/,
    );
    expect(body).toMatch(
      /findByUnsubscribeTokenHash\(hash: string\): Promise<StatusSubscriberRow \| null>;/,
    );
    expect(body).toMatch(/markConfirmed\(input: \{/);
    expect(body).toMatch(
      /expectedConfirmTokenHash: string;[\s\S]*?\}\): Promise<StatusSubscriberRow \| null>;/,
    );
    expect(body).toMatch(
      /markUnsubscribed\(input: \{\s*\n?\s*id: string;[\s\S]*?expectedUnsubscribeTokenHash: string \| null;[\s\S]*?\}\): Promise<StatusSubscriberRow \| null>;/,
    );
    expect(body).toMatch(
      /V-295c3-followup — replaces ONLY `unsubscribe_token_hash` for an\s*\n?\s*\*\s*already-confirmed row\. Used by the fan-out path to issue a fresh\s*\n?\s*\*\s*per-email unsubscribe token\. Does NOT touch confirmed_at\./,
    );
    expect(body).toMatch(
      /rotateUnsubscribeTokenHash\(input: \{ id: string; hash: string \}\): Promise<void>;/,
    );
    expect(body).toMatch(/listConfirmed\(\): Promise<StatusSubscriberRow\[\]>;/);
    expect(body).toMatch(
      /\/\*\* V-295c3-tombstone — admin endpoint paginated read\. \*\/\s*\n?\s*listAll\(opts: \{ limit: number; offset: number \}\): Promise<StatusSubscriberRow\[\]>;/,
    );
    expect(body).toMatch(
      /\/\*\* V-295c3-tombstone — admin endpoint single read by id\. \*\/\s*\n?\s*getById\(id: string\): Promise<StatusSubscriberRow \| null>;/,
    );
    expect(body).toMatch(
      /\/\*\* V-295c3-tombstone — purge candidates \(rows where unsubscribed_at < cutoff\s*\n?\s*\*\s*AND email IS NOT NULL\)\.[\s\S]+?listPurgeCandidates\(cutoff: Date\): Promise<StatusSubscriberRow\[\]>;/,
    );
    expect(body).toMatch(
      /\/\*\* V-295c3-tombstone — NULLs the email column for the given ids\. \*\/\s*\n?\s*purgeEmails\(ids: readonly string\[\]\): Promise<number>;/,
    );
  });

  it('Constructor: statusPageBaseUrl trailing-slash stripped; listAll defaults limit=50 + offset=0', () => {
    expect(body).toMatch(/this\.baseUrl = config\.statusPageBaseUrl\.replace\(\/\\\/\+\$\/, ''\);/);
    expect(body).toMatch(
      /return this\.repo\.listAll\(\{ limit: opts\.limit \?\? 50, offset: opts\.offset \?\? 0 \}\);/,
    );
  });

  it('StatusSubscriberRow: 8 fields with all nullable except id+createdAt (post-tombstone purge state)', () => {
    expect(body).toMatch(/export interface StatusSubscriberRow \{/);
    expect(body).toMatch(/confirmTokenHash: string \| null;/);
    expect(body).toMatch(/confirmExpiresAt: Date \| null;/);
    expect(body).toMatch(/confirmedAt: Date \| null;/);
    expect(body).toMatch(/unsubscribeTokenHash: string \| null;/);
    expect(body).toMatch(/unsubscribedAt: Date \| null;/);
  });

  it('imports: generateAuthToken+tokenHash + BadRequestError+NotFoundError + EmailService type', () => {
    expect(body).toMatch(
      /import \{ generateAuthToken, tokenHash \} from '\.\.\/lib\/auth-tokens\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import type \{ EmailService \} from '\.\/email\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
