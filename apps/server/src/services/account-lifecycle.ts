// V-202c — central dispatcher for customer-facing lifecycle events
// that pair an audit-log emit and/or a transactional email send.
//
// Per founder verdict (2026-05-05 ack of V-228 follow-up): the V-202b/c
// wires use a single `emit(accountId, event)` abstraction so call sites
// stay consistent as the set of lifecycle events grows. V-202c lands
// the first event (`session.failed.first`); V-202b will extend the
// discriminated `LifecycleEvent` union with subscription/billing events.
//
// Contract notes:
//   - Best-effort by design. Errors during dispatch are caught + logged
//     warn and never propagate to the calling service. The caller's
//     primary responsibility (handling the underlying customer event —
//     a webhook delivery, a Stripe handler, a session failure) must
//     never be blocked on lifecycle-side work.
//   - Dedup is handled per-event-kind. `session.failed.first` uses the
//     `accounts.first_failure_email_sent_at` column with an atomic
//     check-and-set to ensure exactly one email per account regardless
//     of how many concurrent first-failures fire.
//   - Email-preference opt-outs are honored via `EmailPreferencesService.shouldSend`.

import type { Logger } from '../lib/logger.js';
import type { EmailService } from './email.js';
import type { EmailPreferencesService } from './email-preferences.js';

export interface AccountLifecycleRow {
  id: string;
  email: string;
  firstFailureEmailSentAt: Date | null;
}

export interface AccountLifecycleRepo {
  /** Look up the per-account lifecycle context (email + dedup flags). */
  findForLifecycle(accountId: string): Promise<AccountLifecycleRow | null>;
  /**
   * Atomic dedup gate for `session.failed.first`. Sets
   * `first_failure_email_sent_at = at` IF AND ONLY IF the column is
   * currently NULL. Returns true when the caller won the race (proceed
   * with the email send), false when another concurrent caller had
   * already set it (skip the email).
   */
  markFirstFailureEmailSent(accountId: string, at: Date): Promise<boolean>;
}

export type LifecycleEvent = {
  kind: 'session.failed.first';
  sessionId: string;
  errorMessage: string;
};

export interface AccountLifecycleServiceConfig {
  /**
   * Base URL for the customer-facing docs surface, used to template
   * deep-links into specific sections from outbound emails. Trailing
   * slashes are stripped at construction time. e.g. `https://driftstack.dev/docs`.
   */
  docsBaseUrl: string;
}

export class AccountLifecycleService {
  private readonly docsBaseUrl: string;

  constructor(
    private readonly repo: AccountLifecycleRepo,
    private readonly email: EmailService,
    private readonly emailPreferences: EmailPreferencesService,
    private readonly logger: Logger,
    config: AccountLifecycleServiceConfig,
  ) {
    this.docsBaseUrl = config.docsBaseUrl.replace(/\/+$/, '');
  }

  async emit(accountId: string, event: LifecycleEvent): Promise<void> {
    try {
      switch (event.kind) {
        case 'session.failed.first':
          await this.handleSessionFailedFirst(accountId, event);
          return;
      }
    } catch (err) {
      this.logger.warn(
        {
          component: 'account-lifecycle',
          accountId,
          eventKind: event.kind,
          err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
        },
        'lifecycle event dispatch failed (best-effort, swallowed)',
      );
    }
  }

  private async handleSessionFailedFirst(
    accountId: string,
    event: { sessionId: string; errorMessage: string },
  ): Promise<void> {
    const account = await this.repo.findForLifecycle(accountId);
    if (account === null) return;
    if (account.firstFailureEmailSentAt !== null) return;

    const allowed = await this.emailPreferences.shouldSend(accountId, 'session-failed-first');
    if (!allowed) return;

    // Atomic mark BEFORE send. If two concurrent first-failures race, the
    // second one's UPDATE finds the column already set and returns false;
    // the second caller skips the email. The successful caller then
    // does the email send. Worst case on email-service failure: one
    // first-failure passes silently (column set, email never sent) —
    // acceptable given the email is informational, not critical.
    const won = await this.repo.markFirstFailureEmailSent(accountId, new Date());
    if (!won) return;

    await this.email.sendSessionFailedFirst({
      to: account.email,
      sessionId: event.sessionId,
      errorMessage: event.errorMessage,
      docsUrl: `${this.docsBaseUrl}/sessions#failure-handling`,
    });
  }
}
