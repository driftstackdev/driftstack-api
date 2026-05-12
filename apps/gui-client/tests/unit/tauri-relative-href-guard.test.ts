// W212 — drift-guard: no Tauri-relative `href="/…"` literals in any
// gui-client component. The Tauri WebView resolves bare absolute
// paths against the app origin (tauri://localhost), which 404s for
// every external resource (API docs, marketing-site pages). All
// outbound links must use a fully-qualified absolute URL or build
// one from SettingsContext / DEFAULT_SETTINGS.baseUrl.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      yield* walk(p);
    } else if (p.endsWith('.tsx') || p.endsWith('.ts')) {
      yield p;
    }
  }
}

describe('W212 tauri-relative href guard', () => {
  it('no source file uses a literal href="/…" path (Tauri 404 trap)', () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    // Match `href="/something"` or `href='/something'` where the next
    // char after the slash is NOT another slash (which would be a
    // protocol-relative URL — also bad, but a separate concern).
    const re = /href=(["'])\/(?!\/)[^"']*\1/;
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Skip lines that are clearly comments mentioning the
        // anti-pattern for context (the doc-comments on the fix).
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (re.test(line)) {
          offenders.push({ file, line: i + 1, text: line.trim() });
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
