// The rendered-site-prose scanner actually finds internal vocabulary in
// customer-facing pages, and actually leaves code alone.
//
// Companion to `scripts/tests/scan-shipped-text.test.ts`: that file's header
// explains why a RATCHET-style "the count did not rise" guard cannot tell a
// working scanner from one whose patterns stopped matching, and the same is
// true here. This file proves the scanner finds real hits (both directions —
// planted violations are found, ordinary customer copy is not), that it
// really strips code rather than merely claiming to (measured against two
// real false positives this scanner produced against this repo before the
// fix — see `stripAstroBodyComments`'s own comment), and that the real repo
// scan is genuinely clean rather than the walk silently finding nothing.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST_PATH,
  applyAllowlist,
  codeOnly,
  readAllowlist,
  REPO_ROOT,
  RULES,
  run,
  scanText,
  siteProseFiles,
  stripAstroNonProse,
  stripMarkdownNonProse,
  stripNonProse,
} from '../scan-site-prose.mjs';
import { RULES as SHIPPED_TEXT_RULES } from '../scan-shipped-text.mjs';
import { CANARY_WORD } from '../personal-names.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('scan-site-prose — the real repo scan', () => {
  it('CRITICAL zero un-allowlisted hits across every scanned site', () => {
    const { files, kept } = run();
    // POSITIVE CONTROL on the walk itself: an empty file set would make the
    // "zero hits" assertion below vacuous.
    expect(files.length, 'the walk found no files at all').toBeGreaterThan(50);
    expect(
      kept.map((f) => `${f.file}:${String(f.line)}:${String(f.column)} ${f.rule} "${f.text}"`),
      'a genuine internal-vocabulary or personal-name hit reached a customer-facing page',
    ).toEqual([]);
  });

  it('CRITICAL every allowlist entry still matches a live finding — a stale entry is a leak nobody is looking through', () => {
    const { stale } = run();
    expect(
      stale.map((e) => `${e.file} ${e.rule} "${e.text}"`),
      'this allowlist entry matched nothing this run',
    ).toEqual([]);
  });

  it('POSITIVE CONTROL — the walk really covers all four surfaces, not just one', () => {
    const files = siteProseFiles().map((f) => f.split('/apps/')[1] ?? f);
    expect(files.some((f) => f?.startsWith('docs/src/pages/') && f.endsWith('.md'))).toBe(true);
    expect(
      files.some((f) => f?.startsWith('marketing-site/src/pages/') && f.endsWith('.astro')),
    ).toBe(true);
    expect(
      files.some((f) => f?.startsWith('marketing-site/src/components/') && f.endsWith('.astro')),
    ).toBe(true);
    expect(
      files.some((f) => f?.startsWith('customer-dashboard/src/pages/') && f.endsWith('.astro')),
    ).toBe(true);
    expect(files.some((f) => f?.includes('gui-client/src/lib/assistant-templates.ts'))).toBe(true);
  });

  it('the allowlist file exists and parses as an array (possibly empty)', () => {
    expect(() => readAllowlist(ALLOWLIST_PATH)).not.toThrow();
    expect(Array.isArray(readAllowlist(ALLOWLIST_PATH))).toBe(true);
  });
});

describe('scan-site-prose — the rule list finds real hits (positive control)', () => {
  it('CRITICAL every banned word is found in ordinary prose, unstripped', () => {
    const prose =
      'Our harness talks to the fleet over the control-plane and the control plane. ' +
      'See observer notes and vantage points from an interpose hook on a macworker host. ' +
      `It is undetectable. Contact ${CANARY_WORD} at ` +
      'someone@gmail.com.';
    const found = scanText(prose, 'fixture.txt');
    const rulesHit = new Set(found.map((f) => f.rule));
    for (const rule of RULES) {
      expect(rulesHit.has(rule.id), `rule '${rule.id}' matched nothing in the fixture`).toBe(true);
    }
  });

  it('does not fire on ordinary customer copy this product actually ships', () => {
    const prose =
      'Your session runs on our infrastructure. Sessions are managed automatically. ' +
      'Node.js and node:crypto are supported by the SDK. The control panel shows your usage.';
    const found = scanText(prose, 'fixture.txt');
    expect(found).toEqual([]);
  });

  it('the observer/vantage rules do not fire on identifiers with no trailing word boundary (same shape scan-shipped-text.mjs already guards)', () => {
    const prose = 'observerEntryTypes and single_host_vantage are wire field names.';
    const found = scanText(prose, 'fixture.txt').map((f) => f.rule);
    expect(found).toEqual([]);
  });
});

describe('scan-site-prose — comment stripping is span-scoped, not file-wide', () => {
  it('CRITICAL a Markdown fenced code block is not scanned, but prose beside it still is', () => {
    const md = [
      'This mentions `fleet` inline and a fenced block:',
      '',
      '```',
      'const fleet = true; // harness',
      '```',
      '',
      'Our fleet is the best.',
    ].join('\n');
    const found = scanText(stripMarkdownNonProse(md), 'fixture.md');
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe('fleet');
    expect(found[0]?.line).toBe(7);
  });

  it('an HTML comment in Markdown is stripped', () => {
    const md = '<!-- internal note: fleet harness -->\n\nCustomer text about nothing banned.';
    expect(scanText(stripMarkdownNonProse(md), 'fixture.md')).toEqual([]);
  });

  it('CRITICAL an Astro frontmatter JS comment is stripped, but a frontmatter STRING LITERAL (real customer copy assembled in code) is still scanned', () => {
    const astro = [
      '---',
      '// fleet harness note',
      "const heading = 'Our fleet dashboard';",
      '---',
      '<h1>{heading}</h1>',
    ].join('\n');
    const found = scanText(stripAstroNonProse(astro), 'fixture.astro');
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  it('CRITICAL an Astro `{/* */}` template comment is stripped — the exact shape that produced a real false positive ("Fleet v2") before this scanner stripped it', () => {
    const astro = [
      '---',
      'const x = 1;',
      '---',
      '<div>',
      '  {/* Fleet v2 — internal design-system note about the fleet harness */}',
      '  <p>Hello customer</p>',
      '</div>',
    ].join('\n');
    expect(scanText(stripAstroNonProse(astro), 'fixture.astro')).toEqual([]);
  });

  it('CRITICAL a `//` comment inside an inline <script> block is stripped, but a string literal inside the SAME script that reaches the DOM is still scanned', () => {
    const astro = [
      '---',
      'const x = 1;',
      '---',
      '<div>',
      '  <script>',
      '    // fleet harness control plane note',
      "    document.title = 'fleet status';",
      '  </script>',
      '</div>',
    ].join('\n');
    const found = scanText(stripAstroNonProse(astro), 'fixture.astro');
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe('fleet');
    expect(found[0]?.line).toBe(7);
  });

  it('an HTML comment in an Astro template body is stripped', () => {
    const astro = ['---', 'const x = 1;', '---', '<!-- fleet harness -->', '<p>Fine.</p>'].join(
      '\n',
    );
    expect(scanText(stripAstroNonProse(astro), 'fixture.astro')).toEqual([]);
  });

  it('a TS comment in a customer-string table is stripped, but the string values are scanned', () => {
    const ts = ['// internal: fleet rollout note', "export const COPY = 'Welcome, fleet!';"].join(
      '\n',
    );
    const found = scanText(stripNonProse(ts, '.ts'), 'fixture.ts');
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
  });

  it('line numbers survive stripping exactly — blanking keeps every newline', () => {
    const md = ['one', '```', 'fleet', '```', 'five has fleet'].join('\n');
    const found = scanText(stripMarkdownNonProse(md), 'fixture.md');
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(5);
  });
});

describe('scan-site-prose — codeOnly is really the code-only.ts port, not a lookalike', () => {
  it('does not open a comment on a `/*` that is inside a `//` line comment (the exact bug code-only.ts documents fixing)', () => {
    const src = "// route path has /* in it\nconst x = 'fleet';";
    const out = codeOnly(src);
    expect(out).toContain("'fleet'");
  });

  it('does not treat a `//` inside a string as a comment opener', () => {
    const src = "const url = 'https://fleet.example/x';";
    expect(codeOnly(src)).toContain('fleet.example');
  });

  it('handles a nested template literal without leaking the rest of the file uncommented', () => {
    const src = 'const t = `${cond ? `yes` : `no`}`;\n// fleet harness\nconst after = 1;';
    const out = codeOnly(src);
    expect(out).not.toContain('fleet harness');
    expect(out).toContain('const after = 1;');
  });
});

describe('scan-site-prose — the shared rules cannot drift from scan-shipped-text.mjs', () => {
  it('CRITICAL harness/fleet/control-plane/observer/vantage are the SAME pattern objects scan-shipped-text.mjs exports, not restated copies', () => {
    const sharedIds = ['harness', 'fleet', 'control-plane', 'observer', 'vantage'];
    const bySourceId = new Map(SHIPPED_TEXT_RULES.map((r) => [r.id, r]));
    for (const id of sharedIds) {
      const mine = RULES.find((r) => r.id === id);
      const theirs = bySourceId.get(id);
      expect(mine, `this scanner has no rule '${id}'`).toBeDefined();
      expect(theirs, `scan-shipped-text.mjs no longer exports '${id}'`).toBeDefined();
      expect(mine?.pattern.source).toBe(theirs?.pattern.source);
    }
  });
});

describe('scan-site-prose — the personal-name rule uses the shared V-211 matcher', () => {
  it("CRITICAL this scanner's personal-name rule is scripts/personal-names.mjs's matcher — imported, not copied, so the scanner, the commit-msg hook and the public-app / SDK sweeps cannot disagree about who is named, and no scanner spells a name out", () => {
    const rule = RULES.find((r) => r.id === 'personal-name') as
      | { find?: (text: string) => { index: number; text: string }[] }
      | undefined;
    expect(rule, "this scanner has no 'personal-name' rule").toBeDefined();
    expect(rule?.find, 'the rule reports hits through the shared matcher').toBeTypeOf('function');
    expect(rule?.find?.(`see ${CANARY_WORD}.`)).toEqual([{ index: 4, text: CANARY_WORD }]);
    expect(rule?.find?.('customer')).toEqual([]);
    const source = read(resolve(HERE, '..', 'scan-site-prose.mjs'));
    expect(source).toMatch(/import \{ personalNameHits \} from '\.\/personal-names\.mjs';/);
  });

  it('CRITICAL finds a listed name in every casing and beside digits or an address — driven through the real matcher by its canary word, which is on the list whether or not a real list is configured', () => {
    const cap = CANARY_WORD[0]!.toUpperCase() + CANARY_WORD.slice(1);
    for (const v of [CANARY_WORD, cap, CANARY_WORD.toUpperCase(), `${CANARY_WORD}89`]) {
      const found = scanText(v, 'fixture.txt').filter((f) => f.rule === 'personal-name');
      expect(found.length, `'${v}' was not matched by the personal-name rule`).toBe(1);
      expect(found[0]?.column).toBe(1);
      expect(found[0]?.text).toBe(v.replace(/89$/, ''));
    }
  });

  it('tolerates compounds the same way the V-211 sweep does — a listed name plus "ine" is another word, not a hit', () => {
    expect(scanText(`${CANARY_WORD}ine`, 'fixture.txt')).toEqual([]);
  });
});

describe('scan-site-prose — allowlist mechanics (synthetic, does not touch the real file)', () => {
  it('CRITICAL a matching entry suppresses exactly that finding and no other on the same file+rule', () => {
    const findings = [
      { file: 'a.md', rule: 'fleet', text: 'fleet', line: 1, column: 1, why: 'x' },
      { file: 'a.md', rule: 'fleet', text: 'Fleet', line: 2, column: 1, why: 'x' },
    ];
    const allowlist = [{ file: 'a.md', rule: 'fleet', text: 'fleet', reason: 'test' }];
    const { kept, suppressed, stale } = applyAllowlist(findings, allowlist);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.line).toBe(2);
    expect(suppressed).toHaveLength(1);
    expect(stale).toEqual([]);
  });

  it('CRITICAL an entry matching nothing is reported STALE', () => {
    const { stale } = applyAllowlist(
      [],
      [{ file: 'nowhere.md', rule: 'fleet', text: 'fleet', reason: 'test' }],
    );
    expect(stale).toHaveLength(1);
  });

  it('an entry is scoped to file+rule+text — it does not suppress the same word on a different file', () => {
    const findings = [{ file: 'b.md', rule: 'fleet', text: 'fleet', line: 1, column: 1, why: 'x' }];
    const allowlist = [{ file: 'a.md', rule: 'fleet', text: 'fleet', reason: 'test' }];
    const { kept, stale } = applyAllowlist(findings, allowlist);
    expect(kept).toHaveLength(1);
    expect(stale).toHaveLength(1);
  });
});
