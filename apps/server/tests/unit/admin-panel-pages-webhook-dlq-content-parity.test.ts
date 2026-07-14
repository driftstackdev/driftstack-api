// W488.C — drift guard for apps/admin-panel/src/pages/webhook-dlq.astro.
// V-189 admin webhook DLQ page. Drift here either drops the
// 5×-retry framing (operators lose the documentation of when
// deliveries land in DLQ — could erroneously requeue ones that
// haven't actually exhausted retries) or breaks the
// 'storm-on-recovery' anti-pattern framing (operators might
// reintroduce auto-retry past initial attempts).
//
//   • V-189 framing pinned + 'manual intervention only — auto-
//     retry past the initial attempts is intentionally absent
//     to avoid storm-on-recovery patterns.'
//   • Requeue contract: POST /v1/admin/webhook-dlq/:id/requeue
//     + 'delivery resets to attempt=1 + retry budget refreshes.
//     Audit row records admin id + delivery id + reason.'
//   • ageStr 4-tier: <60min → 'Nm ago' / <48hr → 'Nh ago' /
//     else 'Nd ago' / null → '—'.
//   • Empty-state region: 'DLQ empty' + 'Healthy posture'.
//   • Event delegation on requeue buttons (not per-row binding).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/webhook-dlq.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W488.C apps/admin-panel/src/pages/webhook-dlq.astro content parity', () => {
  const body = read(LIB);

  it('V-189 framing pins an inert SSG shell and the deferred live enrichment contract', () => {
    expect(body).toMatch(
      /\/\/ V-189 — progressive-enhancement against \/v1\/admin\/webhook-dlq\. SSG\s*\n?\s*\/\/ renders an inert unavailable shell; an inline <script> fetches the live\s*\n?\s*\/\/ list, replaces the body, and wires Requeue \(POST/,
    );
  });

  it('ships no sample delivery, count, mutation control, or green live claim before authority', () => {
    expect(body).not.toContain('MOCK_DLQ');
    expect(body).toContain('Live DLQ entries are unavailable until loaded.');
    expect(body).toMatch(/data-live-dot\s*\n?\s*class="[^"]*bg-amber-500"/);
    expect(body).toContain('<span data-live-status>Waiting for live data</span>');
    expect(body).toMatch(/data-live-refresh\s*\n?\s*disabled\s*\n?\s*aria-disabled="true"/);
    expect(body).not.toMatch(/data-action="(?:requeue|discard)"\s*\n?\s*data-id=\{entry\.id\}/);
  });

  it("Retry-budget framing pinned: 'Deliveries that exhausted the retry budget (5×). Manual intervention only — auto-retry past the initial attempts is intentionally absent to avoid storm-on-recovery patterns.' — pinned so the storm-on-recovery anti-pattern documentation survives (operators reading this page understand WHY auto-retry isn't reintroduced even when DLQ looks 'just stuck')", () => {
    expect(body).toMatch(
      /Deliveries that exhausted the retry budget \(5×\)\. Manual intervention\s*\n?\s*only — auto-retry past the initial attempts is intentionally absent\s*\n?\s*to avoid storm-on-recovery patterns\./,
    );
  });

  it("Requeue contract framing pinned: 'Requeue fires POST /v1/admin/webhook-dlq/:id/requeue — delivery resets to attempt=1 + retry budget refreshes. Audit row records admin id + delivery id + reason. Discard hard-deletes the entry; payload is unrecoverable.' — pinned so the destructive-action contract (audit + payload-unrecoverable) stays explicit on the page operators do requeue/discard from", () => {
    expect(body).toMatch(
      /Requeue fires <code class="font-mono">POST \/v1\/admin\/webhook-dlq\/:id\/requeue<\/code> —\s*\n?\s*delivery resets to attempt=1 \+ retry budget refreshes\. Audit row records\s*\n?\s*admin id \+ delivery id \+ reason\. Discard hard-deletes the entry; payload\s*\n?\s*is unrecoverable\./,
    );
  });

  it('Requeue bounded fetch: POST /v1/admin/webhook-dlq/{encodeURIComponent(id)}/requeue + Bearer/JSON/cookie auth + empty {} body', () => {
    expect(body).toMatch(
      /boundedFetch\(apiBaseUrl \+ '\/v1\/admin\/webhook-dlq\/' \+ encodeURIComponent\(id\) \+ '\/requeue', \{\s*\n?\s*method: 'POST',\s*\n?\s*headers: \{\s*\n?\s*authorization: 'Bearer ' \+ token,\s*\n?\s*'content-type': 'application\/json',\s*\n?\s*\},\s*\n?\s*credentials: 'include',\s*\n?\s*body: '\{\}',\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(/const DLQ_TIMEOUT_MS = 15_000;/);
  });

  it("ageStr 4-tier helper: null/empty → '—' / <60min → 'Nm ago' / <48hr → 'Nh ago' / else 'Nd ago' (Math.floor on each tier boundary) — pinned so the age-display stays human-readable (drift to 'X minutes' would overflow the badge slot; drift to dropping the days tier would render '72h ago' for 3-day-old entries instead of '3d ago')", () => {
    expect(body).toMatch(
      /function ageStr\(createdAt\) \{\s*\n?\s*if \(!createdAt\) return '—';\s*\n?\s*const ms = Date\.now\(\) - new Date\(createdAt\)\.getTime\(\);\s*\n?\s*if \(ms < 0\) return '—';\s*\n?\s*const min = Math\.floor\(ms \/ 60000\);\s*\n?\s*if \(min < 60\) return min \+ 'm ago';\s*\n?\s*const hr = Math\.floor\(min \/ 60\);\s*\n?\s*if \(hr < 48\) return hr \+ 'h ago';\s*\n?\s*const days = Math\.floor\(hr \/ 24\);\s*\n?\s*return days \+ 'd ago';\s*\n?\s*\}/,
    );
  });

  it("Empty-state region: data-region='empty' hidden initially + 'DLQ empty' + 'No deliveries have exhausted the retry budget. Healthy posture — customer endpoints are reachable + responding.' framing — pinned so the empty-DLQ state is treated as the HEALTHY default (not a 'something broke' state — drift to red empty-state styling would mislead operators)", () => {
    expect(body).toMatch(/<div class="hidden" data-region="empty">/);
    expect(body).toMatch(/DLQ empty/);
    expect(body).toMatch(
      /No deliveries have exhausted the retry budget\. Healthy posture —\s*\n?\s*customer endpoints are reachable \+ responding\./,
    );
  });

  it("renderEntries region-swap: entries.length === 0 → listRegion.classList.add('hidden') + emptyRegion.classList.remove('hidden') else inverse — pinned so the empty + list regions are mutually exclusive (drift to showing both at once would render the empty-state ABOVE actual entries)", () => {
    expect(body).toMatch(/if \(entries\.length === 0\) \{/);
    expect(body).toMatch(/if \(listRegion\) listRegion\.classList\.add\('hidden'\);/);
    expect(body).toMatch(/if \(emptyRegion\) emptyRegion\.classList\.remove\('hidden'\);/);
    expect(body).toMatch(/if \(listRegion\) listRegion\.classList\.remove\('hidden'\);/);
    expect(body).toMatch(/if \(emptyRegion\) emptyRegion\.classList\.add\('hidden'\);/);
  });

  it('Event delegation pattern: root.addEventListener(\'click\', …) branches on [data-action="requeue"] + [data-action="discard"]. 2026-05-22 — Discard branch added alongside Requeue (17126865). Single delegated listener prevents per-row leaks on live-replacement; the handler dispatches to requeue(id) or discard(id) based on which button was clicked.', () => {
    expect(body).toMatch(/root\.addEventListener\('click', \(ev\) => \{/);
    expect(body).toMatch(/target\.closest\('\[data-action="requeue"\]'\)/);
    expect(body).toMatch(/target\.closest\('\[data-action="discard"\]'\)/);
    expect(body).toMatch(/if \(id\) requeue\(id\);/);
    expect(body).toMatch(/if \(id\) discard\(id\);/);
  });

  it("DLQ row visual treatment: red-200 border + red-50 background + DLQ badge red-100/red-800 'DLQ · {attempts}× tried' + last_error block red-200 border on white bg — pinned so the visual urgency stays consistent (these rows demand operator attention; drift to amber/slate styling would underplay the criticality)", () => {
    expect(body).toMatch(/<li class="rounded-lg border border-red-200 bg-red-50 p-5">/);
    expect(body).toMatch(
      /<span class="rounded-full bg-red-100 px-2 py-0\.5 text-xs font-medium uppercase tracking-wide text-red-800">/,
    );
    expect(body).toMatch(
      /<div class="mt-4 rounded border border-red-200 bg-tk-surface px-3 py-2">\s*\n?\s*<p class="font-mono text-xs text-red-900">/,
    );
  });

  it("Banner state taxonomy: no-token / 403 forbidden / fetch-error on load + 'Requeueing N…' / 'Requeued N. Refreshing list…' / 'Couldn't requeue N (msg).' on action — pinned so the 6-state banner vocabulary stays consistent with the rest of the admin pages (drift to a different forbidden message would inconsistently brand the cross-page admin-scope error)", () => {
    expect(body).toMatch(/showBanner\('Sign in with a staff admin account to see live data\.'\);/);
    expect(body).toMatch(
      /showBanner\(\s*\n?\s*'Access denied — admin scope required\. You are signed in as a customer account\.',\s*\n?\s*\);/,
    );
    expect(body).toMatch(/showBanner\('Requeueing ' \+ id \+ '…'\);/);
    expect(body).toMatch(/showBanner\('Requeued ' \+ id \+ '\. Refreshing list…'\);/);
    expect(body).toMatch(/showBanner\("Couldn't requeue " \+ id \+ ' \(' \+ msg \+ '\)\.'\);/);
  });

  it('signed-out/failed reads reapply unavailable state and success alone turns freshness green', () => {
    expect(body).toContain('function renderUnavailable(message)');
    expect(body).toContain(
      "renderUnavailable('Sign in with a staff admin account to see the DLQ.')",
    );
    expect(body).toContain(
      "'Could not load the DLQ — nothing to act on. Resolve the error above and retry.'",
    );
    expect(body).toMatch(/if \(loaded\) \{[\s\S]*?setLiveState\('ready'\);/);
    expect(body).toMatch(/if \(expectedReq !== inFlight\) return loaded;/);
  });

  it('defers token authority until DOMContentLoaded so the AdminLayout SSO bridge lands first', () => {
    expect(body).toMatch(/let token = null;/);
    expect(body).toMatch(
      /function start\(\) \{\s*\n?\s*token = localStorage\.getItem\('ds_web_session_token'\);/,
    );
    expect(body).toMatch(/document\.addEventListener\('DOMContentLoaded', start\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
