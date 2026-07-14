#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';

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

// Current request-timing semantics, not an unshipped-product promise.
const ALLOWED_PHRASES = ['Authentication is deferred to the first request'];

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

function renderedText(html) {
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

function hasForbidden(text) {
  return FORBIDDEN.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

// Keep the verifier honest: customer-visible aspirational copy must fail, while
// implementation text and the one current request-timing phrase must not.
assert.equal(hasForbidden(renderedText('<main>Feature coming soon</main>')), true);
assert.equal(hasForbidden(renderedText('<script>"coming soon"</script><main>Live</main>')), false);
assert.equal(hasForbidden(renderedText('<pre>deferred</pre><main>Live</main>')), false);
assert.equal(
  hasForbidden(renderedText('<main>Authentication is deferred to the first request</main>')),
  false,
);

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
    const text = renderedText(await readFile(file, 'utf8'));
    for (const pattern of FORBIDDEN) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match === null) continue;
      const start = Math.max(0, match.index - 80);
      const end = Math.min(text.length, match.index + match[0].length + 80);
      failures.push(`${relative(ROOT, file)}: …${text.slice(start, end)}…`);
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
