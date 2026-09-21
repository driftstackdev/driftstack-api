// Strip comments from TypeScript source, for guards that search code as text.
//
// V-1012 — several drift-guards decide something about a source file by matching
// text in it, and a comment is not code. A guard that cannot tell the two apart
// fails in both directions: a route documenting *why* it opts out of a shared
// helper gets discovered as a consumer of it (V-1011, and twice more since), and
// a negative sentinel can be satisfied by prose quoting the thing it forbids.
//
// The obvious one-liner is wrong here, and wrong in a way that reads as working:
//
//   src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
//
// `routes/agent-sessions.ts` opens with `// AI-D — /v1/agent-sessions/* routes`.
// The `/*` in that route path is inside a LINE comment, but the block-comment
// pass runs first and has no idea — so it opens a comment there and closes it at
// the next `*/`, 7962 characters later, deleting the imports in between. Eighteen
// files under `apps/server/src` carry a `/*` inside a line comment, nearly all of
// them route paths with a wildcard, which is not an exotic shape in this repo.
//
// So this scans left to right and lets whichever token opens FIRST on a line win,
// tracking string literals so a `//` inside `'https://…'` is not a comment.
//
// Regex literals have to be modelled too, which a first version of this file got
// wrong by assuming they were rare enough to ignore. `lib/redact-url.ts` matches
// on character classes like `/['"]/`, and an unmodelled quote inside one opens a
// string that never closes — after which every comment in the rest of the file
// survives stripping and the guard quietly goes back to matching prose. Telling a
// regex opener from a division sign needs the previous token, so that is what the
// `regexAllowedAfter` check below does.
//
// Template literals have to be modelled as well, and as what they are: a string
// that can hold CODE. A first version treated a backtick like any other quote and
// closed the "string" at the next backtick, which is right until a template nests
// one inside `${ … }` — `${ ok ? `yes` : `no` }`. There the inner backtick closed
// the outer template, the template's PROSE was scanned as code, the first
// apostrophe in that prose ("the device's") opened a string that never closed,
// and every comment in the rest of the file survived. `services/fleet-build-drift.ts`
// was the first file to do it. So a template is scanned as text up to `${`, the
// expression inside is scanned as code (comments in it ARE comments, braces are
// counted so an object literal does not end it), and the matching `}` returns to
// the template's text.
//
// `code-only-strips-comments-not-code.test.ts` asserts both directions over every
// server source file: no import statement may be lost, and no whole-line comment
// may survive. Both of those failed against real files during this commit, which
// is the only reason this scanner is shaped the way it is.

/**
 * Whether a `/` at this point opens a regex literal rather than dividing.
 *
 * A regex may only appear where a value may appear, so the previous significant
 * character is enough: after an operator, an opening bracket, a comma or a
 * statement end it is a regex; after an identifier, a closing bracket or a digit
 * it is division.
 */
function regexAllowedAfter(prev: string | null): boolean {
  if (prev === null) return true;
  return '(,=:[!&|?{};+-*%^~<>'.includes(prev);
}

/** Source with comments removed and all other bytes, including newlines, kept. */
export function codeOnly(src: string): string {
  let out = '';
  let inBlock = false;
  let quote: string | null = null;
  // Inside the TEXT of a template literal (between the backticks, outside `${}`).
  let inTemplate = false;
  // One entry per `${` that is still open: the depth of `{` opened inside that
  // expression, so its own closing `}` can be told from an object literal's.
  const templateExpressions: number[] = [];
  let prevSignificant: string | null = null;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string;
    const next = src[i + 1];

    if (inBlock) {
      // V-1254 — emit the newline. A block comment used to be dropped entirely, newlines and
      // all, so the output had fewer lines than the input and every guard that reports a
      // `file:line` named a line that did not contain what it had found. The drift is the
      // height of the comments above the hit, which in this repo is large: nearly every file
      // opens with a block header. Line comments below already emit theirs; this is the half
      // that was missing. Nothing else changes — the characters are still gone.
      if (ch === '\n') out += '\n';
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }

    if (inTemplate) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < src.length) {
          out += src[i + 1] as string;
          i += 1;
        }
        continue;
      }
      if (ch === '`') {
        inTemplate = false;
        prevSignificant = '`';
        continue;
      }
      if (ch === '$' && next === '{') {
        out += '{';
        i += 1;
        inTemplate = false;
        templateExpressions.push(0);
        prevSignificant = '{';
      }
      continue;
    }

    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        // Keep the escaped character so lengths and later matches stay honest.
        if (i + 1 < src.length) {
          out += src[i + 1] as string;
          i += 1;
        }
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '`') {
      inTemplate = true;
      out += ch;
      prevSignificant = ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      prevSignificant = ch;
      continue;
    }

    // Braces only matter inside a template's `${ … }`: the `}` that balances the
    // `${` hands the scan back to the template's text.
    if (templateExpressions.length > 0 && (ch === '{' || ch === '}')) {
      const top = templateExpressions.length - 1;
      const depth = templateExpressions[top] as number;
      out += ch;
      if (ch === '{') {
        templateExpressions[top] = depth + 1;
        prevSignificant = ch;
      } else if (depth === 0) {
        templateExpressions.pop();
        inTemplate = true;
      } else {
        templateExpressions[top] = depth - 1;
        prevSignificant = ch;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }

    // A regex literal: consumed whole, so quotes and comment markers inside it
    // (`/['"]/`, `/\/\*/`) cannot open a string or a comment.
    if (ch === '/' && regexAllowedAfter(prevSignificant)) {
      let inClass = false;
      out += ch;
      i += 1;
      for (; i < src.length; i += 1) {
        const c = src[i] as string;
        out += c;
        if (c === '\\') {
          if (i + 1 < src.length) {
            out += src[i + 1] as string;
            i += 1;
          }
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break; // unterminated: not a regex after all
      }
      prevSignificant = '/';
      continue;
    }

    out += ch;
    if (ch === '!' && next !== '=' && /[\w$)\]]/.test(src[i - 1] ?? '')) {
      // A POSTFIX `!` (non-null assertion) ends a value, so a `/` after it divides:
      // `total! / 12`. A prefix `!` follows an operator, a bracket or a space, and
      // a regex may follow that one: `!/re/.test(x)`.
      prevSignificant = ')';
    } else if (!/\s/.test(ch)) prevSignificant = ch;
  }

  return out;
}
