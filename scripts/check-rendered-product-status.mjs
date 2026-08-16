#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const APPS = [
  'marketing-site',
  'docs',
  'customer-dashboard',
  'admin-panel',
  'status-site',
  'errors-site',
];

const FORBIDDEN = [
  /\bcoming soon\b/giu,
  /\bdeferred\b/giu,
  /\bnot yet available\b/giu,
  /\bplanned feature\b/giu,
  /\bon (?:the|our) roadmap\b/giu,
];

const INTERNAL_MARKERS = [
  /\bV-NNN\b/gu,
  /\bV-\d{3,}(?:\.[A-Z]{1,3}|[a-z]\d*)?\b/gu,
  /\bW\d{3,}(?:\.[A-Z]{1,3})?\b/gu,
  /\bv2-#\d+\b/giu,
  /\bsub-slice\b/giu,
  /\bArc\s+\d+\b/gu,
  /\bAgent\s+[123](?:'s)?\b/giu,
  /\buntil\b[^.]{0,120}\blands\b/giu,
];

// Phrases that contain a forbidden WORD in a sense that is not a product-status
// claim. Each needs a reason; the count is pinned by the test so growing this
// list is a deliberate edit rather than a quiet way to silence the guard.
const ALLOWED_PHRASES = [
  // Current request-timing semantics, not an unshipped-product promise.
  'Authentication is deferred to the first request',
  // AUP §billing: invoices for a suspended period are voided, not postponed.
  // "deferred" here describes what does NOT happen to an invoice, and this is
  // the phrase that had the guard failing — which is very likely why nothing
  // was wired to run it.
  'voided rather than deferred',
];
export { ALLOWED_PHRASES, FORBIDDEN, INTERNAL_MARKERS };

async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return htmlFiles(path);
      return entry.isFile() && entry.name.endsWith('.html') ? [path] : [];
    }),
  );
  return nested.flat();
}

function decodeEntities(value) {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/gu, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

export function renderedText(html) {
  let text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<(script|style|noscript|template|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
      .replace(/<[^>]+>/gu, ' '),
  )
    .replace(/\s+/gu, ' ')
    .trim();
  for (const phrase of ALLOWED_PHRASES) text = text.replaceAll(phrase, '');
  return text;
}

export function customerVisibleText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
      .replace(/<[^>]+>/gu, ' '),
  )
    .replace(/\s+/gu, ' ')
    .trim();
}

export function hasForbidden(text) {
  return FORBIDDEN.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function hasInternalMarker(text) {
  return INTERNAL_MARKERS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/* c8 ignore start — CLI wiring; the matchers above are what the tests drive. */
if (process.argv[1]?.endsWith('check-rendered-product-status.mjs') === true) {
  await runScan();
}

async function runScan() {
  const failures = [];
  let fileCount = 0;

  for (const app of APPS) {
    const dist = resolve(ROOT, 'apps', app, 'dist');
    try {
      if (!(await stat(dist)).isDirectory()) throw new Error('not a directory');
    } catch {
      failures.push(`${app}: missing dist/ (build the app before running this guard)`);
      continue;
    }

    const files = await htmlFiles(dist);
    fileCount += files.length;
    for (const file of files) {
      const html = await readFile(file, 'utf8');
      const text = renderedText(html);
      for (const pattern of FORBIDDEN) {
        pattern.lastIndex = 0;
        const match = pattern.exec(text);
        if (match === null) continue;
        const start = Math.max(0, match.index - 80);
        const end = Math.min(text.length, match.index + match[0].length + 80);
        failures.push(`${relative(ROOT, file)}: …${text.slice(start, end)}…`);
      }
      const visible = customerVisibleText(html);
      for (const pattern of INTERNAL_MARKERS) {
        pattern.lastIndex = 0;
        const match = pattern.exec(visible);
        if (match === null) continue;
        const start = Math.max(0, match.index - 80);
        const end = Math.min(visible.length, match.index + match[0].length + 80);
        failures.push(`${relative(ROOT, file)}: …${visible.slice(start, end)}…`);
      }
    }
  }

  if (failures.length > 0) {
    console.error('Rendered product-status guard failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `Rendered product-status guard passed: ${fileCount} HTML files across ${APPS.length} apps.`,
  );
}
/* c8 ignore stop */
