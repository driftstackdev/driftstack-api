// W401.B — drift guard for apps/server/src/services/incident-broadcast.ts.
// V-295d outbound incident broadcast: Slack incoming-webhook payload +
// generic JSON envelope. Both fire-and-forget; incident writes must
// never roll back because of a webhook delivery failure. Drift here
// either changes the Slack payload shape (breaks customer Slack
// integration) or quietly removes the AbortController timeout (slow
// webhook stalls the lifecycle callback chain).
//
//   • V-295d framing + 2-channel format (Slack incoming-webhook + JSON
//     envelope generic) + dispatched-alongside-V-295c3-email fan-out.
//   • Fire-and-forget posture pinned: errors logged at warn-level, never
//     throw to caller; incident writes never roll back on webhook fail.
//   • BroadcastChannelsConfig: slackWebhookUrl? + genericWebhookUrl? +
//     statusPageBaseUrl + timeoutMs? (default 5000).
//   • Parallel dispatch (Promise.all) — channels independent; one
//     failure doesn't stall the other.
//   • Slack payload: 3-severity emoji (outage=red_circle, major=
//     warning, else=information_source); statusEmoji=resolved override
//     to white_check_mark; 4 color codes (resolved=#2ea44f, outage=
//     #d73a4a, major=#f85149, else=#daaa3f); 3 fields (Severity /
//     Status / Update) + 1 action button (View status page).
//   • Generic JSON: event ('incident.created'|'incident.resolved') +
//     generated_at + incident (inc_<id> prefix, snake_case ISO) +
//     update (message/status/posted_at).
//   • AbortController timeout + JSON.stringify body + content-type
//     header.
//   • Non-2xx and exception → warn log; no throw.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W401.B apps/server/src/services/incident-broadcast.ts content parity', () => {
  const body = read(LIB);

  it('V-295d framing pinned + 2-channel format (slack incoming-webhook + generic JSON envelope)', () => {
    expect(body).toMatch(/V-295d — outbound incident broadcast service\./);
    expect(body).toMatch(
      /- 'slack' — Slack incoming-webhook payload shape `\{ text \}` plus\s*\/\/\s*an attachments block with severity \/ status \/ title \/ link\./,
    );
    expect(body).toMatch(
      /- 'generic' — JSON envelope `\{ event, incident, generated_at \}`\s*\/\/\s*for arbitrary relays \(Twitter via Zapier\/IFTTT\/N8N, Discord\s*\/\/\s*via webhook proxy, custom integrations\)/,
    );
  });

  it("Dispatched-from-IncidentsService-lifecycle framing: parallel to V-295c3-followup email fan-out (one channel failing doesn't stall the other)", () => {
    expect(body).toMatch(
      /The service is dispatched from the IncidentsService lifecycle\s*\/\/\s*callbacks alongside V-295c3-followup email fan-out — both fire on\s*\/\/\s*the same lifecycle event; one channel failing does not stall the\s*\/\/\s*other\./,
    );
  });

  it('Fire-and-forget framing pinned: errors logged at warn-level; incident writes never roll back', () => {
    expect(body).toMatch(
      /All HTTP calls are fire-and-forget: errors are logged at warn-level\s*\/\/\s*but never throw to the caller\. Incident writes must never roll back\s*\/\/\s*because of a webhook delivery failure\./,
    );
  });

  it('BroadcastChannelsConfig: 4 fields (slackWebhookUrl? / genericWebhookUrl? / statusPageBaseUrl / timeoutMs? default 5000)', () => {
    expect(body).toMatch(/export interface BroadcastChannelsConfig \{/);
    expect(body).toMatch(
      /\/\*\* Slack incoming-webhook URL \(`https:\/\/hooks\.slack\.com\/services\/\.\.\.`\)\. \*\/\s*slackWebhookUrl\?: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* Generic outbound webhook URL — JSON envelope\. \*\/\s*genericWebhookUrl\?: string \| null;/,
    );
    expect(body).toMatch(
      /\/\*\* Public origin of the status site, embedded in payloads\. \*\/\s*statusPageBaseUrl: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Per-channel HTTP timeout in ms\. Default 5000\. \*\/\s*timeoutMs\?: number;/,
    );
  });

  it('Constructor: statusPageBaseUrl trailing-slash strip; default timeoutMs=5000; default fetcher = global fetch', () => {
    expect(body).toMatch(
      /this\.statusPageBaseUrl = config\.statusPageBaseUrl\.replace\(\/\\\/\+\$\/, ''\);/,
    );
    expect(body).toMatch(/this\.timeoutMs = config\.timeoutMs \?\? 5000;/);
    expect(body).toMatch(
      /this\.fetcher = fetcher \?\? \(\(input, init\) => fetch\(input, init\)\);/,
    );
  });

  it('broadcast: parallel dispatch via Promise.all; null-channel → Promise.resolve()', () => {
    expect(body).toMatch(
      /\/\/ Dispatch in parallel — channels are independent\.\s*await Promise\.all\(\[\s*this\.slack \? this\.sendSlack\(this\.slack, incident, update, kind\) : Promise\.resolve\(\),\s*this\.generic \? this\.sendGeneric\(this\.generic, incident, update, kind\) : Promise\.resolve\(\),\s*\]\);/,
    );
  });

  it('sendSlack: 3-severity emoji (outage=red_circle, major=warning, else=info) + resolved override = white_check_mark', () => {
    expect(body).toMatch(
      /const severityEmoji =\s*incident\.severity === 'outage'\s*\?\s*':red_circle:'\s*:\s*incident\.severity === 'major'\s*\?\s*':warning:'\s*:\s*':information_source:';/,
    );
    expect(body).toMatch(
      /const statusEmoji = kind === 'resolved' \? ':white_check_mark:' : severityEmoji;/,
    );
  });

  it('sendSlack: 4 color codes (resolved=#2ea44f / outage=#d73a4a / major=#f85149 / else=#daaa3f)', () => {
    expect(body).toMatch(
      /color:\s*kind === 'resolved'\s*\?\s*'#2ea44f'\s*:\s*incident\.severity === 'outage'\s*\?\s*'#d73a4a'\s*:\s*incident\.severity === 'major'\s*\?\s*'#f85149'\s*:\s*'#daaa3f',/,
    );
  });

  it('sendSlack: 3 fields (Severity / Status / Update short=true,true,false) + 1 action button "View status page"', () => {
    expect(body).toMatch(/\{ title: 'Severity', value: incident\.severity, short: true \},/);
    expect(body).toMatch(/\{ title: 'Status', value: incident\.status, short: true \},/);
    expect(body).toMatch(/\{ title: 'Update', value: update\.message, short: false \},/);
    expect(body).toMatch(/actions: \[\{ type: 'button', text: 'View status page', url: link \}\],/);
  });

  it('sendGeneric: JSON envelope with event 2-literal + generated_at + nested incident (inc_<id> prefix) + update', () => {
    expect(body).toMatch(
      /event: kind === 'created' \? 'incident\.created' : 'incident\.resolved',/,
    );
    expect(body).toMatch(/generated_at: new Date\(\)\.toISOString\(\),/);
    expect(body).toMatch(/id: `inc_\$\{incident\.id\}`,/);
    expect(body).toMatch(/started_at: incident\.startedAt\.toISOString\(\),/);
    expect(body).toMatch(
      /resolved_at: incident\.resolvedAt \? incident\.resolvedAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/affected_components: \[\.\.\.incident\.affectedComponents\],/);
    expect(body).toMatch(/status_page_url: this\.statusPageBaseUrl,/);
    expect(body).toMatch(
      /update: \{\s*message: update\.message,\s*status: update\.status,\s*posted_at: update\.postedAt\.toISOString\(\),/,
    );
  });

  it('post(): AbortController timeout + content-type application/json + JSON.stringify body + warn log on !res.ok', () => {
    expect(body).toMatch(/const controller = new AbortController\(\);/);
    expect(body).toMatch(
      /const timer = setTimeout\(\(\) => controller\.abort\(\), this\.timeoutMs\);/,
    );
    expect(body).toMatch(
      /const res = await this\.fetcher\(url, \{\s*method: 'POST',\s*headers: \{ 'content-type': 'application\/json' \},\s*body: JSON\.stringify\(payload\),\s*redirect: 'error',\s*signal: controller\.signal,\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(!res\.ok\) \{\s*this\.logger\.warn\(\s*\{ component: 'incident-broadcast', channel, status: res\.status \},\s*'broadcast webhook returned non-2xx',/,
    );
  });

  it('post(): catch absorbs throw — warn log with err name+message+stack+cause (post-2026-05-19 scheduled-jobs-poller lesson: pass through stack/cause too); clearTimeout in finally', () => {
    expect(body).toMatch(
      /\} catch \(err\) \{\s*this\.logger\.warn\(\s*\{\s*component: 'incident-broadcast',\s*channel,\s*err:\s*err instanceof Error\s*\? \{ name: err\.name, message: err\.message, stack: err\.stack, cause: err\.cause \}\s*: \{ value: err \},\s*\},\s*'broadcast webhook failed',\s*\);\s*\} finally \{\s*clearTimeout\(timer\);/,
    );
  });

  it('Fetcher type seam: (input, init) => Promise<Response> — test-injectable', () => {
    expect(body).toMatch(
      /export type Fetcher = \(input: string, init: RequestInit\) => Promise<Response>;/,
    );
  });

  it('imports: Logger + IncidentRow/IncidentUpdateRow types', () => {
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(
      /import type \{ IncidentRow, IncidentUpdateRow \} from '\.\/incidents\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
