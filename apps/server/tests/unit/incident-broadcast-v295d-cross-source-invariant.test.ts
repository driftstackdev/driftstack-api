// W935 — V-295d incident-broadcast Slack/generic cross-source
// invariant. Two-hundred-sixty-first in the drift-guard series.
// Pins the outbound incident broadcast service:
//
//   V-295d anchor — 'outbound incident broadcast service'. Fires
//   when public incident is created or resolved (V-295a admin path
//   OR V-295b auto-poll path).
//
//   2-channel format split:
//     - 'slack' — Slack incoming-webhook payload `{ text, attachments
//       [{ color, fields: [...], actions: [{ type, text, url }] }] }`.
//       Compatible with Slack incoming-webhook URL.
//     - 'generic' — JSON envelope `{ event, generated_at, incident,
//       update }` for arbitrary relays (Twitter via Zapier/IFTTT/N8N,
//       Discord via webhook proxy, custom integrations).
//
//   Co-fired with V-295c3-followup email fan-out from IncidentsService
//   lifecycle. 'one channel failing does not stall the other'.
//
//   Fire-and-forget: errors logged at warn-level, never throw.
//   'Incident writes must never roll back because of a webhook
//   delivery failure'.
//
//   Default timeoutMs = 5000 (5s per-channel HTTP timeout).
//
//   Severity → emoji mapping (3-tier):
//     - outage → ':red_circle:'.
//     - major  → ':warning:'.
//     - other  → ':information_source:'.
//     - resolved override → ':white_check_mark:'.
//
//   Severity → Slack-color mapping (4-tier including resolved):
//     - resolved → '#2ea44f' (green).
//     - outage   → '#d73a4a' (red).
//     - major    → '#f85149' (orange).
//     - other    → '#daaa3f' (yellow).
//
//   Slack payload fields (3): Severity (short) + Status (short)
//     + Update (full-width message).
//
//   Generic payload event discriminator: 'incident.created' |
//     'incident.resolved' (mirrors V-295e IncidentEventBus).
//
//   Incident id prefix 'inc_<id>' (matches V-295c2 status-snapshot +
//     V-295e bus publicIncident projection).
//
//   affected_components defensive spread-copy ([...incident.
//     affectedComponents]).
//
// stays in lockstep across apps/server/src/services/incident-broadcast.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W935 V-295d incident-broadcast cross-source invariant', () => {
  // ─── V-295d anchor + trigger framing ─────────────────────────

  it("CRITICAL apps/server/src/services/incident-broadcast.ts header pins V-295d anchor — 'V-295d — outbound incident broadcast service'. The V-295d anchor is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/V-295d — outbound incident broadcast service/);
  });

  it("CRITICAL trigger framing — 'When a public incident is created or resolved (V-295a admin path OR V-295b auto-poll path), this service POSTs a payload to each configured outbound webhook URL'. The 2-path trigger (admin V-295a + auto-poll V-295b) covers both incident origins.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/When a public incident is created or resolved \(V-295a admin path/);
    expect(p).toMatch(/OR V-295b auto-poll path\), this service POSTs a payload to each/);
    expect(p).toMatch(/configured outbound webhook URL/);
  });

  // ─── 2-channel format split ──────────────────────────────────

  it("CRITICAL 2-channel framing — 'slack — Slack incoming-webhook payload shape { text } plus an attachments block with severity / status / title / link. Compatible with Slack's incoming-webhook URL out of the box'. The Slack-compat is what makes the channel zero-config for customers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/- 'slack' — Slack incoming-webhook payload shape `\{ text \}` plus/);
    expect(p).toMatch(/an attachments block with severity \/ status \/ title \/ link\./);
    expect(p).toMatch(/Compatible with Slack's incoming-webhook URL out of the box/);
  });

  it("CRITICAL 'generic' channel framing — 'JSON envelope { event, incident, generated_at } for arbitrary relays (Twitter via Zapier/IFTTT/N8N, Discord via webhook proxy, custom integrations). Founder bridges to the destination platform'. The arbitrary-relay design avoids per-channel coupling.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/- 'generic' — JSON envelope `\{ event, incident, generated_at \}`/);
    expect(p).toMatch(/for arbitrary relays \(Twitter via Zapier\/IFTTT\/N8N, Discord/);
    expect(p).toMatch(/via webhook proxy, custom integrations\)\. Founder bridges to/);
    expect(p).toMatch(/the destination platform/);
  });

  // ─── Co-fire with V-295c3-followup + isolation ───────────────

  it("CRITICAL co-fire framing — 'dispatched from the IncidentsService lifecycle callbacks alongside V-295c3-followup email fan-out — both fire on the same lifecycle event; one channel failing does not stall the other'. The co-fire + isolation contract is what makes broadcast + email failures independent.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/dispatched from the IncidentsService lifecycle/);
    expect(p).toMatch(/callbacks alongside V-295c3-followup email fan-out — both fire on/);
    expect(p).toMatch(/the same lifecycle event; one channel failing does not stall the/);
    expect(p).toMatch(/other/);
  });

  // ─── Fire-and-forget framing ─────────────────────────────────

  it("CRITICAL fire-and-forget framing — 'All HTTP calls are fire-and-forget: errors are logged at warn-level but never throw to the caller. Incident writes must never roll back because of a webhook delivery failure'. The never-rollback contract is the V-295d uptime guarantee.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/All HTTP calls are fire-and-forget: errors are logged at warn-level/);
    expect(p).toMatch(/but never throw to the caller\. Incident writes must never roll back/);
    expect(p).toMatch(/because of a webhook delivery failure/);
  });

  // ─── BroadcastChannelsConfig 4-field shape ───────────────────

  it('CRITICAL BroadcastChannelsConfig has 4 fields — slackWebhookUrl (optional) + genericWebhookUrl (optional) + statusPageBaseUrl (required) + timeoutMs (optional, default 5000). The 4-field config is the boot-time wiring surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/export interface BroadcastChannelsConfig \{/);
    expect(p).toMatch(
      /Slack incoming-webhook URL \(`https:\/\/hooks\.slack\.com\/services\/\.\.\.`\)/,
    );
    expect(p).toMatch(/slackWebhookUrl\?: string \| null;/);
    expect(p).toMatch(/Generic outbound webhook URL — JSON envelope/);
    expect(p).toMatch(/genericWebhookUrl\?: string \| null;/);
    expect(p).toMatch(/Public origin of the status site, embedded in payloads/);
    expect(p).toMatch(/statusPageBaseUrl: string;/);
    expect(p).toMatch(/Per-channel HTTP timeout in ms\. Default 5000/);
    expect(p).toMatch(/timeoutMs\?: number;/);
  });

  // ─── Severity → emoji mapping ────────────────────────────────

  it("CRITICAL severity emoji 3-tier — 'outage' → ':red_circle:'; 'major' → ':warning:'; other → ':information_source:'. The 3-tier emoji is the customer-facing visual ladder.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(
      /incident\.severity === 'outage'\s*\n\s*\? ':red_circle:'\s*\n\s*: incident\.severity === 'major'\s*\n\s*\? ':warning:'\s*\n\s*: ':information_source:'/,
    );
  });

  it("CRITICAL resolved override — kind === 'resolved' → ':white_check_mark:'. The resolved-emoji overrides severity-derived emoji so 'resolved' always renders as the green check.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(
      /const statusEmoji = kind === 'resolved' \? ':white_check_mark:' : severityEmoji;/,
    );
  });

  // ─── Severity → Slack color mapping ──────────────────────────

  it("CRITICAL 4-tier color mapping — resolved '#2ea44f' (green); outage '#d73a4a' (red); major '#f85149' (orange); other '#daaa3f' (yellow). The 4-tier color is the Slack attachment ladder.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(
      /kind === 'resolved'\s*\n\s*\? '#2ea44f'\s*\n\s*: incident\.severity === 'outage'\s*\n\s*\? '#d73a4a'/,
    );
    expect(p).toMatch(/: incident\.severity === 'major'\s*\n\s*\? '#f85149'\s*\n\s*: '#daaa3f'/);
  });

  // ─── Slack payload 3 fields ──────────────────────────────────

  it("CRITICAL Slack attachment has 3 fields — 'Severity' (short) + 'Status' (short) + 'Update' (full-width). The 2-short + 1-full layout is what Slack's column rendering expects.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/\{ title: 'Severity', value: incident\.severity, short: true \},/);
    expect(p).toMatch(/\{ title: 'Status', value: incident\.status, short: true \},/);
    expect(p).toMatch(/\{ title: 'Update', value: update\.message, short: false \},/);
  });

  // ─── Slack actions button ────────────────────────────────────

  it("CRITICAL Slack action button — { type: 'button', text: 'View status page', url: link }. The single button CTA points to statusPageBaseUrl, not a per-incident deep-link.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/actions: \[\{ type: 'button', text: 'View status page', url: link \}\],/);
    expect(p).toMatch(/const link = `\$\{this\.statusPageBaseUrl\}`;/);
  });

  // ─── Slack text format ───────────────────────────────────────

  it("CRITICAL Slack text format — '${statusEmoji} *${verb} incident:* ${incident.title}'. The 'Posted' (created) vs 'Resolved' verb maps the 2-kind union to natural English.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/const verb = kind === 'created' \? 'Posted' : 'Resolved';/);
    expect(p).toMatch(
      /const text = `\$\{statusEmoji\} \*\$\{verb\} incident:\*  ?\$\{incident\.title\}`;/,
    );
  });

  // ─── Generic payload event discriminator ─────────────────────

  it("CRITICAL generic payload event discriminator — 'incident.created' | 'incident.resolved'. The 2-event string matches V-295e IncidentEventBus event union.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/event: kind === 'created' \? 'incident\.created' : 'incident\.resolved',/);
  });

  // ─── Generic payload incident projection ─────────────────────

  it("CRITICAL generic incident projection has 8 fields — id (prefixed 'inc_') + title + severity + status + public + started_at + resolved_at (nullable) + affected_components + status_page_url. The 8-field projection mirrors V-295c2 status-snapshot + V-295e bus shapes (excluding description which is admin-only).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/id: `inc_\$\{incident\.id\}`,/);
    expect(p).toMatch(/title: incident\.title,/);
    expect(p).toMatch(/severity: incident\.severity,/);
    expect(p).toMatch(/status: incident\.status,/);
    expect(p).toMatch(/public: incident\.public,/);
    expect(p).toMatch(/started_at: incident\.startedAt\.toISOString\(\),/);
    expect(p).toMatch(
      /resolved_at: incident\.resolvedAt \? incident\.resolvedAt\.toISOString\(\) : null,/,
    );
    expect(p).toMatch(/affected_components: \[\.\.\.incident\.affectedComponents\],/);
    expect(p).toMatch(/status_page_url: this\.statusPageBaseUrl,/);
  });

  it('CRITICAL generic update projection has 3 fields — message + status + posted_at (ISO). The 3-field update mirrors V-295e bus publicIncidentUpdate projection.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-broadcast.ts'));
    expect(p).toMatch(/message: update\.message,/);
    expect(p).toMatch(/status: update\.status,/);
    expect(p).toMatch(/posted_at: update\.postedAt\.toISOString\(\),/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/incident-broadcast-v295d-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
