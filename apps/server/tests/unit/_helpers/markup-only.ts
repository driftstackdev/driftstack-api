// Strip comments from Astro template MARKUP, for guards that search a page as text.
//
// The markup half of an `.astro` page has two comment forms: HTML's `<!-- … -->`
// and the expression comment `{/* … */}`. `codeOnly` (./code-only.ts) cannot
// serve them: it models TypeScript, and in markup an apostrophe in ordinary
// prose ("it's", "you've") opens a string literal that never closes, after which
// nothing further is stripped.
//
// This is a left-to-right scan, not a regex pass, for the reason code-only.ts
// gives: whichever opener comes first wins, so a `{/*` quoted inside an HTML
// comment does not open a second comment. Only the markup is meant to go
// through here — an inline <script> body is TypeScript, and goes through
// codeOnly. Line breaks inside a removed comment are kept, so line numbers hold.

const FORMS = [
  { open: '<!--', close: '-->' },
  { open: '{/*', close: '*/}' },
] as const;

export function markupOnly(markup: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    let next: { index: number; form: (typeof FORMS)[number] } | null = null;
    for (const form of FORMS) {
      const index = markup.indexOf(form.open, at);
      if (index !== -1 && (next === null || index < next.index)) next = { index, form };
    }
    if (next === null) return out + markup.slice(at);
    const end = markup.indexOf(next.form.close, next.index + next.form.open.length);
    // An unclosed comment runs to the end of the page, as it does in a browser.
    const stop = end === -1 ? markup.length : end + next.form.close.length;
    out += markup.slice(at, next.index) + markup.slice(next.index, stop).replace(/[^\n]/g, '');
    at = stop;
  }
}
