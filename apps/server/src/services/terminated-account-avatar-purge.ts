// Security sweep E-23 (2026-09-24) — the avatar arm of the account-deletion purge.
//
// A customer-uploaded avatar lives on the PUBLIC bucket at
// `avatars/<account_id>.<ext>`, and account deletion never removed it, so a
// terminated account's image stayed publicly readable for good. This binds the
// candidate query to the public bucket so the sweeper can delete those objects
// without itself holding a second R2 client: its own `r2` is the PRIVATE bucket
// (sealed profile blobs), and two clients in one dependency list are one
// identifier away from a swap.

import { deleteAvatarObjects, type R2 } from '../lib/r2.js';
import type {
  TerminatedAccountAvatarPurgeArm,
  TerminatedAccountAvatarPurgeRepo,
} from './account-deletion-purge-sweeper.js';

export class TerminatedAccountAvatarPurge implements TerminatedAccountAvatarPurgeArm {
  constructor(
    private readonly publicBucket: R2,
    private readonly candidates: TerminatedAccountAvatarPurgeRepo,
  ) {}

  findTerminatedAccountIdsWithAvatarBefore(cutoff: Date, maxPerTick?: number): Promise<string[]> {
    return this.candidates.findTerminatedAccountIdsWithAvatarBefore(cutoff, maxPerTick);
  }

  deleteAvatarObjects(accountId: string): Promise<void> {
    return deleteAvatarObjects(this.publicBucket, accountId);
  }

  clearAvatarKey(accountId: string): Promise<void> {
    return this.candidates.clearAvatarKey(accountId);
  }
}
