// Owner item 11 (2026-09-24): "AUto on screen keyboard still not always working
// especially on first". The new-tab page (https://driftstack.io/newtab/, the
// app's default start page and every new tab) focused its search field while it
// loaded (`autofocus`), before the app could see focus changes on the phone. The
// customer's first tap was then a re-focus of a field that already had focus: the
// phone reports nothing for that, so no on-screen keyboard appeared, and only
// tapping away and back worked.
//
// Pinned: no element on the page carries `autofocus`, and the page's own script
// never focuses anything when it runs — so the first tap is a real focus. The
// field stays visible and tappable (an input inside the search form).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, '..', '..', 'src', 'pages', 'newtab.astro');
const SOURCE = readFileSync(PAGE, 'utf8');
/** The page's markup and script, without the frontmatter and HTML comments (the
 *  page's own comment explains the rule and names the attribute). */
const BODY = SOURCE.replace(/^---[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '');
const SCRIPT: string = (() => {
  const found = /<script is:inline>([\s\S]*?)<\/script>/.exec(BODY)?.[1];
  if (found === undefined) throw new Error('newtab.astro inline script not found');
  return found;
})();

/** Every opening tag in the markup (script bodies removed first). */
const tags = (html: string): string[] =>
  Array.from(html.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/<[a-z][^>]*>/gi)).map(
    (m) => m[0],
  );

describe('owner item 11 — the new-tab page leaves the first focus to the customer’s tap', () => {
  it('CRITICAL no element carries `autofocus`', () => {
    expect(tags(BODY).filter((t) => /\sautofocus\b/i.test(t))).toEqual([]);
  });

  it('CRITICAL the page’s script focuses nothing when it runs: no focus(), no autofocus property, no focus on load events', () => {
    expect(SCRIPT).not.toMatch(/\.focus\s*\(/);
    expect(SCRIPT).not.toMatch(/\.autofocus\s*=/);
    expect(SCRIPT).not.toMatch(/DOMContentLoaded|addEventListener\(\s*['"]load['"]/);
  });

  it('the search field is still there to tap: a text input inside the search form, with a submit button', () => {
    const form = /<form id="newtab-search"[\s\S]*?<\/form>/.exec(BODY)?.[0] ?? '';
    expect(form).toMatch(/<input[^>]*id="newtab-input"[^>]*type="text"/);
    expect(form).toMatch(/<button[^>]*type="submit"/);
  });

  it('positive control: the checks see the pattern they forbid', () => {
    expect(tags('<input id="x" autofocus />').filter((t) => /\sautofocus\b/i.test(t))).toHaveLength(
      1,
    );
    expect("document.getElementById('newtab-input').focus();").toMatch(/\.focus\s*\(/);
  });
});
