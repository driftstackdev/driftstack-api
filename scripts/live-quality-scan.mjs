#!/usr/bin/env node
// live-quality-scan.mjs — automated live-experience quality scanner.
//
// Founder directive 2026-07-06 ("find a way to automatically test it +
// improve it; links/titles not from real, too slow, bad quality"): a
// repeatable synthetic crawler that exercises the DEPLOYED customer-facing
// surfaces and flags exactly those defects — dead links (404/5xx), missing
// or placeholder <title>, and slow pages — so quality regressions get
// caught automatically instead of by hand.
//
// Read-only: issues GET/HEAD against public URLs. No auth, no mutation.
// Same-origin BFS from a seed set, bounded by MAX_PAGES + MAX_DEPTH;
// external links are HEAD-checked once (deduped, capped) but not crawled.
//
// Usage:
//   node scripts/live-quality-scan.mjs                 # scan prod surfaces
//   node scripts/live-quality-scan.mjs https://staging.driftstack.dev
//   BASE=http://localhost:4321 node scripts/live-quality-scan.mjs
//   node scripts/live-quality-scan.mjs --json out.json
//
// Exit code: 0 = clean, 1 = defects found (CI/monitoring can gate on it).

const ARGS = process.argv.slice(2);
const jsonIdx = ARGS.indexOf('--json');
const JSON_OUT = jsonIdx !== -1 ? ARGS[jsonIdx + 1] : null;
const seedArgs = ARGS.filter(
  (a, i) => !a.startsWith('--') && !(jsonIdx !== -1 && i === jsonIdx + 1),
);

// Default seed set = every live customer-facing surface + its high-value deep paths.
const DEFAULT_SEEDS = [
  'https://driftstack.io',
  'https://driftstack.io/pricing/',
  'https://driftstack.io/security/',
  'https://driftstack.io/self-hosted/',
  'https://driftstack.io/comparison/',
  'https://driftstack.io/docs/',
  'https://driftstack.io/legal/terms/',
  'https://driftstack.io/legal/privacy/',
  'https://driftstack.io/legal/aup/',
  'https://docs.driftstack.io',
  'https://status.driftstack.io',
];
const SEEDS = seedArgs.length ? seedArgs : process.env.BASE ? [process.env.BASE] : DEFAULT_SEEDS;

const MAX_PAGES = Number(process.env.MAX_PAGES ?? 150);
const MAX_DEPTH = Number(process.env.MAX_DEPTH ?? 3);
const SLOW_MS = Number(process.env.SLOW_MS ?? 1500);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 15000);
const MAX_EXTERNAL = Number(process.env.MAX_EXTERNAL ?? 80);

// A title is "not from real" if it's absent, empty, a known framework/build
// placeholder, or an obvious dev stub. Extend as real stubs are discovered.
const PLACEHOLDER_TITLE = /^(|astro|document|untitled|undefined|null|home|index|new page|title)$/i;

const origins = new Set(SEEDS.map((s) => new URL(s).origin));

/** Fetch with a hard timeout; returns {status, ms, body, err, finalUrl}. */
async function get(url, method = 'GET') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'driftstack-live-quality-scan/1.0' },
    });
    const body = method === 'GET' ? await res.text() : '';
    return {
      status: res.status,
      ms: performance.now() - start,
      body,
      finalUrl: res.url,
      contentType: res.headers.get('content-type') || '',
    };
  } catch (e) {
    return { status: 0, ms: performance.now() - start, body: '', err: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/** Remove <script>/<style>/<template> bodies + HTML comments so we never
 *  mistake a client-side template literal (e.g. an `href="${x}"` inside a
 *  render function) for a real anchor. Without this the crawler reports
 *  phantom dead links that exist only in JS source, not the rendered DOM. */
function stripNonMarkup(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<template\b[\s\S]*?<\/template>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function extractLinks(html, baseUrl) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (
      !raw ||
      raw.startsWith('#') ||
      raw.startsWith('mailto:') ||
      raw.startsWith('tel:') ||
      raw.startsWith('javascript:')
    )
      continue;
    try {
      const resolved = new URL(raw, baseUrl);
      // Cloudflare's "Email Address Obfuscation" rewrites mailto: into
      // /cdn-cgi/l/email-protection#<hash> links that only resolve via CF's edge JS
      // decoder; a raw GET (fragments never reach the server) 404s BY DESIGN, yet a
      // real user with JS gets the decoded mailto and never navigates there. These
      // are CF-managed, not our links — never crawl/report them as broken.
      if (resolved.pathname.startsWith('/cdn-cgi/')) continue;
      out.push(resolved.toString());
    } catch {
      /* malformed href — the crawl reports it via the page it sits on if it 0s */
    }
  }
  return out;
}

const pages = new Map(); // url -> {status, ms, title, depth}
const externalChecked = new Map(); // url -> status
const issues = [];
const warnings = [];
const queue = SEEDS.map((u) => ({ url: u, depth: 0, from: '(seed)' }));

function addIssue(type, url, detail, from) {
  issues.push({ type, url, detail, from });
}

function addWarning(type, url, detail, from) {
  warnings.push({ type, url, detail, from });
}

let externalBudget = MAX_EXTERNAL;

while (queue.length && pages.size < MAX_PAGES) {
  const { url, depth, from } = queue.shift();
  const norm = url.split('#')[0];
  if (pages.has(norm)) continue;

  const isInternal = origins.has(new URL(norm).origin);
  if (!isInternal) {
    if (externalChecked.has(norm) || externalBudget <= 0) continue;
    externalBudget--;
    let r = await get(norm, 'HEAD');
    // HEAD is unreliable — many CDNs/servers 403/404/405 a HEAD but serve the
    // GET fine (e.g. rfc-editor.org 404s HEAD, 302→200 on GET). Never flag an
    // external link on a HEAD error alone; confirm with a real GET first.
    if (r.status === 0 || r.status >= 400) r = await get(norm, 'GET');
    externalChecked.set(norm, r.status);
    // An authenticated or anti-bot external destination can reject this
    // credential-free scanner even though the link is valid in a signed-in
    // browser. Keep it visible for human verification, but do not fail a
    // Driftstack release gate for an access policy we do not control.
    if (r.status === 401 || r.status === 403) {
      addWarning('unverifiable-external-link', norm, `HTTP ${r.status}`, from);
    } else if (r.status === 0 || r.status >= 400) {
      addIssue('broken-external-link', norm, r.err || `HTTP ${r.status}`, from);
    }
    continue;
  }

  const r = await get(norm, 'GET');
  pages.set(norm, { status: r.status, ms: Math.round(r.ms), depth });

  if (r.status === 0) {
    addIssue('unreachable', norm, r.err, from);
    continue;
  }
  if (r.status >= 400) {
    addIssue('broken-page', norm, `HTTP ${r.status}`, from);
    continue;
  }
  // fetch follows redirects, so `r.status` is the FINAL response status and can
  // never reveal an intermediate 301/302/307/308. Compare the requested and
  // final URLs instead; URL serialization avoids a false positive for an origin
  // written without its implicit root slash (`https://example.com`).
  const requestedUrl = new URL(norm).toString();
  const finalUrl = r.finalUrl ? new URL(r.finalUrl).toString() : requestedUrl;
  if (finalUrl !== requestedUrl) {
    addIssue('unexpected-redirect', norm, `followed redirect → ${finalUrl}`, from);
  }
  if (r.ms > SLOW_MS) addIssue('slow-page', norm, `${Math.round(r.ms)}ms (> ${SLOW_MS}ms)`, from);

  // Only HTML documents carry titles + real anchors. A 200 security.txt /
  // sitemap.xml / robots.txt legitimately has neither — don't flag them.
  const isHtml = r.contentType.includes('html') || (!r.contentType && /<html/i.test(r.body));
  if (!isHtml) continue;
  const clean = stripNonMarkup(r.body);

  const title = extractTitle(clean);
  pages.get(norm).title = title;
  if (title === null) addIssue('missing-title', norm, 'no <title> element', from);
  else if (PLACEHOLDER_TITLE.test(title))
    addIssue('placeholder-title', norm, `title="${title}"`, from);

  if (depth < MAX_DEPTH) {
    // Resolve relative hrefs against the FINAL (post-redirect) URL, exactly like a
    // browser does. A page fetched at /legal/privacy that 308s to /legal/privacy/
    // must resolve `dpa.md` to /legal/privacy/dpa.md — resolving against the
    // requested `/legal/privacy` mislocates it to /legal/dpa.md, misreporting the
    // path of an otherwise-real broken link.
    for (const link of extractLinks(clean, r.finalUrl || norm)) {
      const lnorm = link.split('#')[0];
      const linkInternal = origins.has(new URL(lnorm).origin);
      if (linkInternal && !pages.has(lnorm))
        queue.push({ url: lnorm, depth: depth + 1, from: norm });
      else if (!linkInternal && !externalChecked.has(lnorm))
        queue.push({ url: lnorm, depth: depth + 1, from: norm });
    }
  }
}

// ---- report ----
const byType = {};
for (const i of issues) (byType[i.type] ??= []).push(i);
const warningsByType = {};
for (const warning of warnings) (warningsByType[warning.type] ??= []).push(warning);
const slowest = [...pages.entries()]
  .filter(([, p]) => p.status >= 200 && p.status < 300)
  .sort((a, b) => b[1].ms - a[1].ms)
  .slice(0, 5);

console.log(`\nLIVE QUALITY SCAN — ${new Date().toISOString()}`);
console.log(
  `seeds: ${SEEDS.length} | crawled ${pages.size} pages + ${externalChecked.size} external | ${issues.length} issue(s), ${warnings.length} warning(s)\n`,
);
const ORDER = [
  'unreachable',
  'broken-page',
  'broken-external-link',
  'missing-title',
  'placeholder-title',
  'slow-page',
  'unexpected-redirect',
];
for (const type of ORDER) {
  const list = byType[type];
  if (!list?.length) continue;
  console.log(`### ${type} (${list.length})`);
  for (const i of list.slice(0, 40))
    console.log(`  - ${i.url}\n      ${i.detail}   [linked from ${i.from}]`);
  if (list.length > 40) console.log(`  … +${list.length - 40} more`);
  console.log('');
}
for (const [type, list] of Object.entries(warningsByType)) {
  console.log(`### ${type} warning (${list.length})`);
  for (const warning of list.slice(0, 40)) {
    console.log(`  - ${warning.url}\n      ${warning.detail}   [linked from ${warning.from}]`);
  }
  if (list.length > 40) console.log(`  … +${list.length - 40} more`);
  console.log('');
}
console.log('slowest OK pages:');
for (const [u, p] of slowest) console.log(`  ${String(p.ms).padStart(6)}ms  ${u}`);

if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        scannedAt: new Date().toISOString(),
        seeds: SEEDS,
        pages: Object.fromEntries(pages),
        issues,
        warnings,
      },
      null,
      2,
    ),
  );
  console.log(`\njson → ${JSON_OUT}`);
}
console.log(
  `\n${issues.length === 0 ? `✅ clean${warnings.length ? ` (${warnings.length} warning(s))` : ''}` : `❌ ${issues.length} defect(s)`}`,
);
process.exit(issues.length === 0 ? 0 : 1);
