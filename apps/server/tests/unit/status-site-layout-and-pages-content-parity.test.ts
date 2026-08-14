// W790 — apps/status-site src/* (StatusLayout + 4 pages) content
// parity bundle. One-hundred-sixteenth in the cross-SDK drift-guard
// series. Pins the previously-unguarded 5 status-site source files.
//
// /status.driftstack.dev is the public-no-auth incident surface +
// V-657 incident-email-subscription flow + V-657 90-day history.
// Drift to the API_BASE/R2_FALLBACK_URL, severity/status badge maps,
// or the V-540.B-tested double-opt-in subscribe flow would mismatch
// V-295c2/V-295e SSE + V-657 subscription server contracts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const LAYOUT = resolve(REPO_ROOT, 'apps/status-site/src/layouts/StatusLayout.astro');
const PAGE_404 = resolve(REPO_ROOT, 'apps/status-site/src/pages/404.astro');
const PAGE_INDEX = resolve(REPO_ROOT, 'apps/status-site/src/pages/index.astro');
const PAGE_SUB = resolve(REPO_ROOT, 'apps/status-site/src/pages/subscribe.astro');
const PAGE_HIST = resolve(REPO_ROOT, 'apps/status-site/src/pages/history.astro');

function hasStatusMetadataBoundary(source: string): boolean {
  return (
    /interface Props \{\s*title: string;\s*description\?: string;[\s\S]*?noindex\?: boolean;\s*\}/.test(
      source,
    ) &&
    /description = 'Driftstack service status and incident updates\.',\s*noindex = false,/.test(
      source,
    ) &&
    /<meta name="robots" content=\{noindex \? 'noindex,nofollow' : 'index,follow'\} \/>/.test(
      source,
    ) &&
    /\{!noindex && canonicalUrl && <link rel="canonical" href=\{canonicalUrl\} \/>\}/.test(source)
  );
}

function hasSafeStatusFetchBoundary(source: string): boolean {
  return (
    /load\(`\$\{API_BASE\}\/v1\/status\/incidents`, parseIncidentFeed\)/.test(source) &&
    /load\(`\$\{API_BASE\}\/v1\/status`, parseLiveStatus\)/.test(source) &&
    /load\(R2_FALLBACK_URL, parseSnapshot\)/.test(source) &&
    /throw new Error\('status-feed-unavailable'\);/.test(source) &&
    !/throw new Error\(`API \$\{/.test(source)
  );
}

describe('W790 status-site src content parity bundle', () => {
  it('all 5 files exist at canonical paths', () => {
    expect(existsSync(LAYOUT)).toBe(true);
    expect(existsSync(PAGE_404)).toBe(true);
    expect(existsSync(PAGE_INDEX)).toBe(true);
    expect(existsSync(PAGE_SUB)).toBe(true);
    expect(existsSync(PAGE_HIST)).toBe(true);
  });

  // ─── StatusLayout.astro ───────────────────────────────────────

  it('CRITICAL StatusLayout Props and metadata boundary pinned — required title, optional description/noindex, canonical only on indexable pages.', () => {
    const p = read(LAYOUT);

    expect(hasStatusMetadataBoundary(p)).toBe(true);
    expect(p).toMatch(/<meta property="og:title" content=\{title\} \/>/);
    expect(p).toMatch(/<meta name="twitter:description" content=\{description\} \/>/);

    const alwaysIndexedMutant = p.replace(
      "noindex ? 'noindex,nofollow' : 'index,follow'",
      "'index,follow'",
    );
    const utilityCanonicalMutant = p.replace('!noindex && canonicalUrl', 'canonicalUrl');
    expect(alwaysIndexedMutant).not.toBe(p);
    expect(utilityCanonicalMutant).not.toBe(p);
    expect(hasStatusMetadataBoundary(alwaysIndexedMutant)).toBe(false);
    expect(hasStatusMetadataBoundary(utilityCanonicalMutant)).toBe(false);
  });

  it("CRITICAL StatusLayout brand-mark + 'Driftstack · status' header framing pinned. The wordmark + middle-dot + 'status' suffix is the canonical status-site branding.", () => {
    const p = read(LAYOUT);

    expect(p).toMatch(/<img\s*\n\s+src="\/driftstack-mark\.svg\?v=4"\s*\n\s+alt="Driftstack"/);
    expect(p).toMatch(
      /<span class="text-base font-black italic tracking-tight text-ink-primary">DRIFT<span class="text-glow-red">STACK<\/span><\/span>\s*\n\s+<span class="text-ink-muted">·<\/span>\s*\n\s+<span class="text-ink-muted">status<\/span>/,
    );
  });

  it("CRITICAL Dutch-BV + operational-data-only privacy framing pinned. The 'Driftstack is a Dutch BV. Status data is operational only — never customer data' wording is the load-bearing privacy contract for the no-auth public page.", () => {
    const p = read(LAYOUT);

    expect(p).toMatch(
      /<span>Driftstack is a Dutch BV\. Status data is operational only — never customer data\.<\/span>/,
    );
  });

  it('CRITICAL driftstack.dev nav + privacy footer link pinned.', () => {
    const p = read(LAYOUT);

    expect(p).toMatch(
      /<a href="https:\/\/driftstack\.dev" class="text-ink-muted hover:text-ink-primary">\s*\n\s+driftstack\.dev\s*\n\s+<\/a>/,
    );
    expect(p).toMatch(
      /<a href="https:\/\/driftstack\.dev\/legal\/privacy\/" class="hover:text-ink-primary">\s*\n\s+Privacy\s*\n\s+<\/a>/,
    );
  });

  // ─── 404.astro ────────────────────────────────────────────────

  it("CRITICAL 404 single-overview + /incident?id=<id> framing pinned. The 'The status site only hosts a single overview page plus per-incident pages under /incident?id=<id>' wording explains the route surface (incident.astro at /incident with a ?id= query).", () => {
    const p = read(PAGE_404);

    expect(p).toMatch(
      /The status site only hosts a single overview page plus per-incident pages\s*\n\s+under <code class="font-mono text-sm text-ink-secondary">\/incident\?id=&lt;id&gt;<\/code>\./,
    );
    expect(p).toMatch(
      /<a href="\/" class="text-sm text-ink-secondary underline hover:text-ink-primary">\s*\n\s+← Back to overview\s*\n\s+<\/a>/,
    );
  });

  // ─── index.astro ──────────────────────────────────────────────

  it("CRITICAL index API_BASE + PUBLIC_STATUS_R2_URL fallback framing pinned. The 'PUBLIC_API_BASE_URL is the live API origin; PUBLIC_STATUS_R2_URL points at the public-readable R2 snapshot (V-295c2: <r2-public-base>/status/incidents-public.json). The page tries the live API first and falls back to the snapshot if the API is unreachable' wording is the load-bearing fallback contract.", () => {
    const p = read(PAGE_INDEX);

    expect(p).toMatch(
      /const API_BASE = import\.meta\.env\.PUBLIC_API_BASE_URL \?\? 'https:\/\/api\.driftstack\.dev';/,
    );
    expect(p).toMatch(
      /const R2_FALLBACK_URL =\s*\n\s+import\.meta\.env\.PUBLIC_STATUS_R2_URL \?\?\s*\n\s+'https:\/\/r2-public\.driftstack\.dev\/status\/incidents-public\.json';/,
    );
    expect(p).toMatch(/V-295c2: `<r2-public-base>\/status\/incidents-public\.json`/);
    expect(p).toMatch(/combines live readiness \+ incident truth/);
    expect(p).toMatch(/snapshot-only data never proves\s*\n\/\/ an operational all-clear/);
  });

  it('CRITICAL index 3-severity badge map pinned — minor (amber) / major (orange) / outage (red). Drift to a different color taxonomy would mismatch dashboard incident-severity convention.', () => {
    const p = read(PAGE_INDEX);

    expect(p).toMatch(/minor: \['bg-amber-50', 'text-amber-700'\]/);
    expect(p).toMatch(/major: \['bg-orange-50', 'text-orange-700'\]/);
    expect(p).toMatch(/outage: \['bg-red-50', 'text-red-700'\]/);
  });

  it('CRITICAL index 4-status badge map pinned — investigating/identified/monitoring/resolved. Matches W789 admin-panel mocks 4-status enum + incident lifecycle.', () => {
    const p = read(PAGE_INDEX);

    expect(p).toMatch(/investigating: \['bg-amber-50', 'text-amber-700'\]/);
    expect(p).toMatch(/identified: \['bg-blue-50', 'text-blue-700'\]/);
    expect(p).toMatch(/monitoring: \['bg-indigo-50', 'text-indigo-700'\]/);
    expect(p).toMatch(/resolved: \['bg-emerald-50', 'text-emerald-700'\]/);
  });

  it("CRITICAL index 4-state overall STATE_TITLE pinned — operational/degraded/outage/unknown. The 'STATE_TITLE.unknown = Status currently unavailable' is the load-bearing partial-degradation framing.", () => {
    const p = read(PAGE_INDEX);

    expect(p).toMatch(/operational: 'All systems operational'/);
    expect(p).toMatch(/degraded: 'Some systems degraded'/);
    expect(p).toMatch(/outage: 'Major outage in progress'/);
    expect(p).toMatch(/unknown: 'Status currently unavailable'/);
  });

  it('CRITICAL index live-API-first then R2-snapshot fallback is deadline-bounded and exposes only a stable public failure class.', () => {
    const p = read(PAGE_INDEX);

    expect(hasSafeStatusFetchBoundary(p)).toBe(true);
    expect(p).toContain('load(`${API_BASE}/v1/status/incidents`, parseIncidentFeed)');
    expect(p).toContain('load(`${API_BASE}/v1/status`, parseLiveStatus)');
    expect(p).toContain('const snapshot = await load(R2_FALLBACK_URL, parseSnapshot)');
    expect(p).toMatch(/value\.open_count > value\.total/);
    expect(p).toMatch(/value\.open_outage_count > value\.open_count/);

    const rawDiagnosticMutant = p.replace(
      "throw new Error('status-feed-unavailable');",
      'throw new Error(`API ${apiMsg}; R2 fallback ${r2Msg}`);',
    );
    expect(rawDiagnosticMutant).not.toBe(p);
    expect(hasSafeStatusFetchBoundary(rawDiagnosticMutant)).toBe(false);
  });

  it('CRITICAL snapshot age is validated and disclosed without a false cadence ceiling.', () => {
    const p = read(PAGE_INDEX);

    expect(p).toContain(
      "if (!isIso(value.generated_at)) throw new Error('invalid snapshot timestamp');",
    );
    expect(p).toContain('formatSnapshotAge(generatedAt)');
    expect(p).toContain('Current component health is unavailable; all-clear is withheld.');
    expect(p).not.toContain('≤60s old');
  });

  it("CRITICAL V-295e SSE realtime-updates + 60s safety-net poll framing pinned. The 'V-295e — real-time SSE updates' anchor + 'Periodic 60s refetch is kept as a safety net for clients that lose the SSE connection' explains the dual-poll-and-SSE strategy.", () => {
    const p = read(PAGE_INDEX);

    expect(p).toMatch(/V-295e — real-time SSE updates\./);
    expect(p).toMatch(/const sse = new EventSource\(`\$\{API_BASE\}\/v1\/status\/stream`\);/);
    expect(p).toMatch(/sse\.addEventListener\('incident\.created', onIncidentEvent\);/);
    expect(p).toMatch(/sse\.addEventListener\('incident\.resolved', onIncidentEvent\);/);
    expect(p).toMatch(/setInterval\(fetchAndRender, 60_000\);/);
  });

  it("CRITICAL no-cookies-no-visitor-tracking + 30-day-health-history framing pinned. The 'The page itself stores no cookies and does not log visitors. Driftstack records its own health-probe history (timestamp, success, latency) for 30 days; this data does not reference any Customer or visitor' wording is the load-bearing privacy contract.", () => {
    const p = read(PAGE_INDEX);

    expect(p).toMatch(
      /The page itself stores\s*\n\s+no cookies and does not log visitors\. Driftstack records its own\s*\n\s+health-probe history \(timestamp, success, latency\) for 30 days; this\s*\n\s+data does not reference any Customer or visitor\./,
    );
  });

  it('CRITICAL index escapeHtml 5-char XSS guard pinned. Every incident.title/affected_components/u.message field flows through it. Drift would let a malicious incident title inject HTML.', () => {
    const p = read(PAGE_INDEX);

    expect(p).toMatch(/case '&':\s*\n\s+return '&amp;';/);
    expect(p).toMatch(/case '<':\s*\n\s+return '&lt;';/);
    expect(p).toMatch(/case '>':\s*\n\s+return '&gt;';/);
    expect(p).toMatch(/case '"':\s*\n\s+return '&quot;';/);
    expect(p).toMatch(/case "'":\s*\n\s+return '&#39;';/);
  });

  it('CRITICAL index V-657 subscribe + history quick-nav pinned. Drift to dropping would lose the load-bearing /subscribe + /history routes.', () => {
    const p = read(PAGE_INDEX);

    expect(p).toMatch(/V-657 — quick-nav to subscription \+ history views\./);
    expect(p).toMatch(/<a\s*\n\s+href="\/subscribe\/"/);
    expect(p).toMatch(/Subscribe to incident emails/);
    expect(p).toMatch(/<a\s*\n\s+href="\/history\/"/);
    expect(p).toMatch(/Full incident history \(90 days\)/);
  });

  // ─── subscribe.astro ──────────────────────────────────────────

  it("CRITICAL subscribe V-657 + double-opt-in V-540.B-11 framing pinned. The 'V-657 — incident-email subscription handler. Renders a tiny form that POSTs to /v1/status/subscribe; the V-540.B-11-tested double-opt-in flow takes over from there' wording is the load-bearing flow anchor.", () => {
    const p = read(PAGE_SUB);

    expect(p).toMatch(/V-657 — incident-email subscription handler/);
    expect(p).toMatch(
      /POSTs to \/v1\/status\/subscribe; the V-540\.B-11-tested\s*\n\/\/ double-opt-in flow takes over from there/,
    );
  });

  it("CRITICAL subscribe volume-promise framing pinned. V-768 — this pin previously REQUIRED 'Two emails per incident maximum', a cap production does not honour: a third subscriber email kind (status-incident-updated) is wired, throttled to one per hour per subscriber per incident with no total cap. The pin froze the false claim and had to move with it.", () => {
    const p = read(PAGE_SUB);

    expect(p).toMatch(
      /We'll email you when we post a service-status incident, at most\s*\n\s+once an hour while it stays open, and again when it resolves\./,
    );
    expect(p, 'the retired cap must not come back').not.toMatch(/emails per incident maximum/i);
  });

  it('CRITICAL subscribe 202+400+429 status-code branches pinned. 202=confirmation-sent, 400=invalid-email, 429=rate-limit-by-IP. Drift to dropping any would lose customer-facing recoverability. Wave 1119 / Slice 1119.3 C1: 202 branch swaps the form for a dedicated confirm pane with sender hint + spam-folder fallback + "subscribe another address" affordance (replaces the prior single setStatus line). 400 + 429 still surface inline status text.', () => {
    const p = read(PAGE_SUB);

    expect(p).toMatch(/if \(res\.status === 202\) \{/);
    // C1 confirm-pane swap (was: setStatus("Check your inbox…")).
    expect(p).toMatch(/if \(confirmEmail\) confirmEmail\.textContent = email;/);
    expect(p).toMatch(/if \(confirmPane\) confirmPane\.classList\.remove\('hidden'\);/);
    expect(p).toMatch(/if \(form\) form\.classList\.add\('hidden'\);/);
    expect(p).toMatch(/\} else if \(res\.status === 400\) \{/);
    expect(p).toMatch(/"That doesn't look like a valid email address\."/);
    expect(p).toMatch(/\} else if \(res\.status === 429\) \{/);
    expect(p).toMatch(/'Too many subscribe attempts from this IP\. Try again in a minute\.'/);
  });

  it("CRITICAL subscribe double-opt-in + 1-click-unsubscribe + never-marketing framing pinned. The 'Double-opt-in: we send a confirmation email to verify the address before adding it to the notification list. Unsubscribe with one click — every email carries an unsubscribe link in the footer. We never send marketing or promotional email from the status list.' wording matches the V-540.B-11 contract.", () => {
    const p = read(PAGE_SUB);

    expect(p).toMatch(
      /Double-opt-in: we send a confirmation email to verify the address\s*\n\s+before adding it to the notification list\. Unsubscribe with one\s*\n\s+click — every email carries an unsubscribe link in the footer\. We\s*\n\s+never send marketing or promotional email from the status list\./,
    );
  });

  it('CRITICAL subscribe email-regex sanity check pinned — `/^.+@.+\\..+$/.test(email)`. Drift to a more permissive regex would let SDK consumers send malformed addresses to the server.', () => {
    const p = read(PAGE_SUB);

    expect(p).toMatch(/!\/\^\.\+@\.\+\\\.\.\+\$\/\.test\(email\)/);
  });

  // ─── history.astro ────────────────────────────────────────────

  it("CRITICAL history V-657 90-day-window framing pinned. The 'V-657 — incident history view. Reads the same /v1/status/incidents public endpoint as the home page, but widens the window to 90 days and removes the open/resolved split' wording matches the trust-evaluation use-case.", () => {
    const p = read(PAGE_HIST);

    expect(p).toMatch(/V-657 — incident history view\./);
    expect(p).toMatch(
      /widens the window to 90 days\s*\n\/\/ and removes the open\/resolved split \(everything chronological\)/,
    );
  });

  it('CRITICAL history GET ?window=90d query-param pinned. Drift to a different window would mismatch server-side accept set.', () => {
    const p = read(PAGE_HIST);

    expect(p).toMatch(
      /const res = await fetchWithDeadline\(`\$\{API_BASE\}\/v1\/status\/incidents\?window=90d&limit=100`/,
    );
  });

  it('CRITICAL history group-by-month + validated exact empty state are pinned.', () => {
    const p = read(PAGE_HIST);

    expect(p).toMatch(/function groupByMonth\(incidents\) \{/);
    expect(p).toMatch(/const month = new Date\(inc\.started_at\)\.toISOString\(\)\.slice\(0, 7\);/);
    expect(p).toMatch(/Object\.keys\(byMonth\)\s*\n\s+\.sort\(\)\s*\n\s+\.reverse\(\)/);
    expect(p).toMatch(/No open incidents and no resolved incidents in the last 90 days\./);
  });

  it('Wave 1119 / Slice 1119.4 B4 — month-grouping presentation polish: humanized month label (humanizeMonth + MONTH_LABELS lookup, e.g. "May 2026" not "2026-05"); per-month incident-count chip (pluralizeIncidents — singular handled); render as <details> blocks with the newest month open-by-default + older months collapsed (so 90 days does not dump as one wall of cards); group-open chevron rotates via Tailwind group-open: utility.', () => {
    const p = read(PAGE_HIST);

    // Human-readable month + count helpers.
    expect(p).toMatch(
      /const MONTH_LABELS = \[\s*\n\s+'January',\s*\n\s+'February',\s*\n\s+'March',\s*\n\s+'April',\s*\n\s+'May',\s*\n\s+'June',\s*\n\s+'July',\s*\n\s+'August',\s*\n\s+'September',\s*\n\s+'October',\s*\n\s+'November',\s*\n\s+'December',\s*\n\s+\];/,
    );
    expect(p).toMatch(/function humanizeMonth\(monthKey\) \{/);
    expect(p).toMatch(
      /function pluralizeIncidents\(n\) \{\s*\n\s+return n === 1 \? '1 incident' : `\$\{n\} incidents`;/,
    );
    // <details>/<summary> render with newest-open + collapsed-older pattern.
    expect(p).toMatch(/<details \$\{i === 0 \? 'open' : ''\}/);
    expect(p).toMatch(/<summary class="[^"]*cursor-pointer[^"]*"/);
    expect(p).toMatch(/humanizeMonth\(g\.month\)/);
    expect(p).toMatch(/pluralizeIncidents\(g\.items\.length\)/);
    expect(p).toMatch(/group-open:rotate-180/);
  });

  it('CRITICAL history truthfully distinguishes all-time open from 90-day resolved and discloses truncation.', () => {
    const p = read(PAGE_HIST);

    expect(p).toMatch(
      /Resolved incidents started in the last 90 days, plus every incident that\s*\n\s+is still open regardless of age/,
    );
    expect(p).toMatch(
      /<a href="\/" class="text-oxblood-700 underline">live status page<\/a> shows\s*\n\s+every active incident plus the last 30 days of resolved history\./,
    );
    expect(p).toMatch(/if \(feed\.truncated\)/);
    expect(p).not.toMatch(/listed indefinitely|complete record/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/status-site-layout-and-pages-content-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
