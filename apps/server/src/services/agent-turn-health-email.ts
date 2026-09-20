// The owner's email for the AI turn health watchdog.
//
// WHY EMAIL AS WELL AS SENTRY. Sentry notifies on a NEW issue or a regression,
// and the watchdog deliberately keeps one issue per condition — so a second
// incident, and every reminder, lands in an issue that is already open and
// tells nobody unless a per-event alert rule exists in the Sentry project. No
// Sentry auth token exists anywhere (only DSNs), so that rule cannot be created
// from code, and the owner asked for alerts that need no configuring. Postmark
// is configured in production and the owner's address is already known to the
// server, so every notice the watchdog sends to Sentry is also mailed to the
// owner.
//
// CONTENT-FREE, BY CONSTRUCTION. The email is rendered from
// `agentTurnHealthPayload(notice).extra` — the very object that goes to Sentry,
// already built from closed vocabularies and numbers — and every word around it
// comes from the fixed tables below. Nothing is read from the summary or the job
// row here, so the email can carry no more than the Sentry event does.
//
// NEVER HURTS THE PRODUCT. This module only renders and hands one message to
// Postmark; the watchdog decides WHEN to send (its rate limit and restart
// idempotency live in the job row it already persists), bounds each send with a
// deadline, and swallows every failure.

import { ServerClient as PostmarkClient } from 'postmark';
import type { PostmarkConfig } from '../lib/config.js';
import { classifyEmailError, escapeHtml, wrapHtmlDocument, type PostmarkSendApi } from './email.js';
import {
  agentTurnHealthPayload,
  type AgentTurnHealthEmailer,
  type AgentTurnHealthLogger,
  type AgentTurnHealthNotice,
} from './agent-turn-health-watchdog.js';

/** The admin panel's AI turns page (apps/admin-panel, `site` in its
 *  astro.config.mjs, page `agent-turns.astro`). */
export const AGENT_TURN_HEALTH_ADMIN_URL = 'https://admin.driftstack.io/agent-turns';

/** Where the runbook explains every notice. A path and a heading rather than a
 *  link: the runbook lives in the repository, not on a public site. */
export const AGENT_TURN_HEALTH_RUNBOOK_REF =
  'docs/runbooks/agent-turn-monitoring.md, section "Getting notified" (under "In production today: the health watchdog")';

/** The env switch. Named here so the email body, the boot log and bootstrap
 *  cannot disagree about it. */
export const AGENT_TURN_HEALTH_EMAIL_DISABLE_ENV = 'DRIFTSTACK_DISABLE_AGENT_TURN_HEALTH_EMAIL';

interface SignalWords {
  /** Plain name, lower case, for the subject line. */
  readonly title: string;
  /** One sentence: what a breach means for customers. */
  readonly meaning: string;
}

const SIGNAL_WORDS: Readonly<Record<string, SignalWords>> = {
  completion_rate_low: {
    title: 'completion rate low',
    meaning:
      'Too few AI turns are finishing the task they were given, so customers are asking the AI for work it is not completing.',
  },
  conflict_rate_high: {
    title: 'busy/conflict rate high',
    meaning:
      'Too many requests to the AI are answered 409 (busy or conflicting), so customers are turned away before their turn starts.',
  },
  first_progress_slow: {
    title: 'first progress slow',
    meaning:
      'Streaming AI turns are slow to show their first progress, so customers wait with nothing happening on screen.',
  },
  no_profile_attached: {
    title: 'AI session ran with no behaviour profile attached',
    meaning:
      'An AI session acted on a page with no behaviour profile attached to it, which is a SESSION SET-UP fault on the device side: the step ran before the session’s profile was recorded, or after the session ended. It is not a verdict on how the action looked — a profile being attached is necessary, not sufficient. The runbook says what to check first; the counts by action below say how many and which kind.',
  },
  evaluation_failing: {
    title: 'health watchdog blind',
    meaning:
      'The health watchdog cannot read the AI turn records, so it cannot tell whether the AI automation is healthy: silence from it now means nothing.',
  },
};

const FALLBACK_WORDS: SignalWords = {
  title: 'health check',
  meaning: 'An AI turn health check changed state.',
};

/** Labels for the figures, by the payload's closed key list. */
const FIGURE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['samples', 'Samples in the window'],
  ['completed', 'Completed turns'],
  ['busy_409', 'Answered 409 busy'],
  ['conflict_409', 'Answered 409 conflict'],
  ['p50_ms', 'First progress p50'],
  ['p95_ms', 'First progress p95'],
  ['consecutive_failed_ticks', 'Consecutive unreadable checks'],
  ['no_profile_click', 'Taps with no behaviour profile attached'],
  ['no_profile_send_keys', 'Typing with no behaviour profile attached'],
];

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** "14:05 UTC", or "2026-09-19 14:05 UTC" with the date. The input is the
 *  payload's re-serialised ISO timestamp; anything else renders as nothing. */
function utc(iso: string | null, withDate: boolean): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms).toISOString();
  return withDate ? `${d.slice(0, 10)} ${d.slice(11, 16)} UTC` : `${d.slice(11, 16)} UTC`;
}

function formatMeasure(value: number | null, unit: string | null): string {
  if (value === null) return 'n/a';
  switch (unit) {
    case 'ratio':
      return `${(value * 100).toFixed(1)}%`;
    case 'ms':
      return `${String(Math.round(value))} ms`;
    case 'ticks':
      return `${String(Math.round(value))} checks`;
    case 'count':
      return `${String(Math.round(value))} actions`;
    default:
      return String(value);
  }
}

function formatWindow(minutes: number | null): string | null {
  if (minutes === null) return null;
  return minutes >= 60 && minutes % 60 === 0
    ? `${String(minutes / 60)} h`
    : `${String(minutes)} min`;
}

/** An operator-set environment name, shown only when it is not production so
 *  a staging alert is never mistaken for a production one. Restricted to a
 *  plain token: it goes into a subject line. */
function environmentPrefix(environment: string | null | undefined): string {
  if (environment === null || environment === undefined) return '';
  const e = environment.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(e) || e === 'production' || e === 'prod') return '';
  return `[${e}] `;
}

export interface AgentTurnHealthEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Render one notice. Pure. `withheld` is how many alert emails the rate limit
 * held back since the last one was sent, so the owner knows the inbox is not
 * the whole story.
 */
export function renderAgentTurnHealthEmail(
  notice: AgentTurnHealthNotice,
  opts: { withheld?: number; environment?: string | null } = {},
): AgentTurnHealthEmail {
  const payload = agentTurnHealthPayload(notice);
  const x = payload.extra;
  const condition = str(x['condition']) ?? '';
  const words = SIGNAL_WORDS[condition] ?? FALLBACK_WORDS;
  const alertName = payload.message.split(' ')[2] ?? '';
  const transition = str(x['transition']);
  const clearedBy = str(x['cleared_by']);
  const since = str(x['breaching_since']);
  const unit = str(x['unit']);

  let state: string;
  let stateLine: string;
  switch (transition) {
    case 'breach': {
      const at = utc(since, false);
      state = at === null ? 'started' : `started ${at}`;
      stateLine = 'Breach: the condition has held for its full hold time.';
      break;
    }
    case 'still_breaching': {
      const at = utc(since, true);
      state = at === null ? 'still breaching' : `still breaching since ${at}`;
      stateLine = 'Reminder: still breaching (a reminder is sent at most every 6 hours).';
      break;
    }
    case 'recovered': {
      const at = utc(since, true);
      state = at === null ? 'recovered' : `recovered (began ${at})`;
      stateLine =
        clearedBy === 'insufficient_data'
          ? 'Recovered: traffic fell below the volume floor, so there is too little data to call it a breach any longer.'
          : 'Recovered: the value has been back on the healthy side of the threshold for the full hold time.';
      break;
    }
    default:
      state = 'changed';
      stateLine = 'State changed.';
  }
  const subject = `${environmentPrefix(opts.environment)}AI automation: ${words.title} — ${state}`;

  const lines: string[] = [];
  const add = (label: string, value: string | null): void => {
    if (value !== null) lines.push(`${label}: ${value}`);
  };
  add('Condition', `${words.title} (${alertName})`);
  add('Breaching since', utc(since, true));
  const windowSince = utc(str(x['window_since']), true);
  const windowUntil = utc(str(x['window_until']), true);
  const windowLen = formatWindow(num(x['window_minutes']));
  if (windowLen !== null || windowSince !== null) {
    const span =
      windowSince !== null && windowUntil !== null ? ` (${windowSince} to ${windowUntil})` : '';
    add('Window', `${windowLen === null ? '' : `last ${windowLen}`}${span}`.trim());
  }
  if (unit !== 'ticks') add('Measured', formatMeasure(num(x['value']), unit));
  for (const [key, label] of FIGURE_LABELS) {
    const v = num(x[key]);
    if (v === null) continue;
    add(label, key.endsWith('_ms') ? formatMeasure(v, 'ms') : String(v));
  }
  const threshold = num(x['threshold']);
  if (unit === 'ticks') {
    add('Threshold', `blind after ${formatMeasure(threshold, 'ticks')} in a row (5 minutes apart)`);
  } else {
    const side = str(x['breach_when']) === 'below' ? 'below' : 'above';
    const floor = num(x['min_samples']);
    const hold = num(x['for_minutes']);
    add(
      'Threshold',
      `breach when ${side} ${formatMeasure(threshold, unit)}` +
        (floor === null ? '' : `, with at least ${String(floor)} samples`) +
        (hold === null ? '' : `, held for ${String(hold)} min`),
    );
  }

  const withheld = opts.withheld !== undefined && opts.withheld > 0 ? opts.withheld : 0;
  const withheldLine =
    withheld > 0
      ? `${String(withheld)} earlier alert email(s) were held back by the rate limit; each is still in Sentry and the server log.`
      : null;
  const whereTo = [
    `Admin panel, AI turns: ${AGENT_TURN_HEALTH_ADMIN_URL}`,
    `Runbook: ${AGENT_TURN_HEALTH_RUNBOOK_REF}`,
  ];
  const footer = `Sent automatically to the project owner by the AI turn health watchdog. Set ${AGENT_TURN_HEALTH_EMAIL_DISABLE_ENV}=true to stop these emails.`;

  const text = [
    stateLine,
    '',
    `What it means: ${words.meaning}`,
    '',
    ...lines,
    '',
    'Where to look:',
    ...whereTo.map((w) => `- ${w}`),
    ...(withheldLine === null ? [] : ['', withheldLine]),
    '',
    footer,
    '',
    '— Driftstack',
  ].join('\n');

  const e = escapeHtml;
  const inner =
    `<p><strong>${e(stateLine)}</strong></p>` +
    `<p>What it means: ${e(words.meaning)}</p>` +
    `<ul>${lines.map((l) => `<li>${e(l)}</li>`).join('')}</ul>` +
    `<p>Where to look:</p>` +
    `<ul><li>Admin panel, AI turns: <a href="${e(AGENT_TURN_HEALTH_ADMIN_URL)}">${e(AGENT_TURN_HEALTH_ADMIN_URL)}</a></li>` +
    `<li>Runbook: ${e(AGENT_TURN_HEALTH_RUNBOOK_REF)}</li></ul>` +
    (withheldLine === null ? '' : `<p>${e(withheldLine)}</p>`) +
    `<p style="color:#666;font-size:13px;">${e(footer)}</p>` +
    '<p>— Driftstack</p>';

  return { subject, text, html: wrapHtmlDocument(inner, subject) };
}

/** Why alert email is off — logged once at boot, never per tick. */
export type AgentTurnHealthEmailOffReason =
  | 'switched_off'
  | 'postmark_not_configured'
  | 'no_owner_address';

/**
 * The emailer, or null when alert email is off. Logs exactly one line either
 * way, at construction (i.e. once per boot): the watchdog ticks every five
 * minutes and must not repeat "email is off" on each of them.
 *
 * The owner's address is never logged, and a Postmark failure is rethrown
 * carrying only its category and code: Postmark's own messages can quote the
 * recipient.
 */
export function createAgentTurnHealthEmailer(opts: {
  postmark: PostmarkConfig | null;
  ownerEmail: string | null;
  disabled: boolean;
  environment?: string | null;
  logger?: AgentTurnHealthLogger;
  /** Test seam: a stub Postmark client. Defaults to a real one. */
  client?: PostmarkSendApi;
  messageStream?: string;
}): AgentTurnHealthEmailer | null {
  const owner = opts.ownerEmail?.trim() ?? '';
  const reason: AgentTurnHealthEmailOffReason | null = opts.disabled
    ? 'switched_off'
    : opts.postmark === null
      ? 'postmark_not_configured'
      : owner === ''
        ? 'no_owner_address'
        : null;
  if (reason !== null || opts.postmark === null) {
    opts.logger?.info?.(
      {
        component: 'agent-turn-health',
        event: 'agent_turn_health_email_off',
        reason: reason ?? 'postmark_not_configured',
      },
      'agent turn health: alert email is off; notices still go to Sentry and the log',
    );
    return null;
  }
  const config = opts.postmark;
  const client: PostmarkSendApi = opts.client ?? new PostmarkClient(config.apiToken);
  const messageStream = opts.messageStream ?? 'outbound';
  opts.logger?.info?.(
    { component: 'agent-turn-health', event: 'agent_turn_health_email_on' },
    'agent turn health: alert email to the project owner is on',
  );
  return {
    async send(notice, context) {
      const mail = renderAgentTurnHealthEmail(notice, {
        withheld: context.withheld,
        environment: opts.environment ?? null,
      });
      try {
        await client.sendEmail({
          From: config.from,
          To: owner,
          Subject: mail.subject,
          TextBody: mail.text,
          HtmlBody: mail.html,
          ReplyTo: config.replyTo,
          MessageStream: messageStream,
        });
      } catch (err) {
        const { category, postmarkCode } = classifyEmailError(err);
        throw new Error(
          `alert email not sent (${category}${postmarkCode === null ? '' : `, postmark ${String(postmarkCode)}`})`,
        );
      }
    },
  };
}
