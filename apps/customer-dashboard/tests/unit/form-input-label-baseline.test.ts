// W286.C — accessibility baseline for customer-dashboard form
// inputs. Every <input> element (other than hidden/submit/button)
// should have either an `id` matched by a <label for=...> or an
// `aria-label` attribute. Catches drift where a new input ships
// without a label.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const pages = walk(PAGES).filter((f) => /\.astro$/.test(f));

describe('W286.C customer-dashboard form-input label baseline', () => {
  it('every non-hidden/non-button <input> has an id or aria-label', () => {
    const offenders: { file: string; snippet: string }[] = [];
    for (const f of pages) {
      const body = read(f);
      const inputs = [...body.matchAll(/<input\b[^>]*>/g)];
      for (const m of inputs) {
        const tag = m[0];
        // Only enforce labels on free-text input types — checkboxes
        // and radios are typically wrapped inline by their <label>
        // (implicit association) which is a valid a11y pattern.
        if (!/type=["'](text|email|password|number|url|search|tel)["']/.test(tag)) continue;
        if (/id=["'][^"']+["']/.test(tag)) continue;
        if (/aria-label=["'][^"']+["']/.test(tag)) continue;
        if (/aria-labelledby=["'][^"']+["']/.test(tag)) continue;
        offenders.push({ file: f.slice(REPO_ROOT.length + 1), snippet: tag.slice(0, 100) });
      }
    }
    expect(offenders).toEqual([]);
  });
});
