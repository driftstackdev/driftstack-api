// Evaluates a GitHub Actions `${{ … }}` expression against a context object, so
// a guard can test what a workflow's `if:` or `concurrency:` expression DOES for
// a given event rather than how it is spelled. Shared by the deploy and CI
// workflow guards.

/**
 * A small evaluator for the GitHub Actions expressions the workflows use:
 * string/number/boolean/null literals, context paths (`github.event.x.y`), `==`,
 * `!=`, `!`, `&&`, `||`, parentheses and `format()`. Semantics follow GitHub's:
 * `&&`/`||` return an operand rather than a boolean, and string equality ignores
 * case. Anything else throws, so an expression this cannot read fails the test
 * instead of being evaluated wrongly.
 */
export function evaluate(source: string, ctx: Record<string, unknown>): unknown {
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(source);
  const text = m ? m[1]! : source;
  const tokens: string[] = [];
  const re = /\s*('(?:[^']|'')*'|==|!=|&&|\|\||[()!,]|[A-Za-z_][A-Za-z0-9_.-]*|\d+)/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    re.lastIndex = at;
    const t = re.exec(text);
    if (!t) throw new Error(`cannot read expression at: ${text.slice(at, at + 30)}`);
    tokens.push(t[1]!);
    at = re.lastIndex;
  }
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const take = (want?: string): string => {
    const t = tokens[i++];
    if (t === undefined || (want !== undefined && t !== want)) {
      throw new Error(`expected ${want ?? 'a token'}, got ${t ?? 'the end'}`);
    }
    return t;
  };
  const truthy = (v: unknown): boolean => v !== false && v !== 0 && v !== '' && v != null;
  const equal = (a: unknown, b: unknown): boolean =>
    typeof a === 'string' && typeof b === 'string'
      ? a.toLowerCase() === b.toLowerCase()
      : (a ?? null) === (b ?? null);
  const lookup = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : null),
        ctx,
      ) ?? null;
  const primary = (): unknown => {
    const t = take();
    if (t === '(') {
      const v = or();
      take(')');
      return v;
    }
    if (t === '!') return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^\d+$/.test(t)) return Number(t);
    if (t === 'true' || t === 'false') return t === 'true';
    if (t === 'null') return null;
    if (t === 'format' && peek() === '(') {
      take('(');
      const args: unknown[] = [or()];
      while (peek() === ',') {
        take(',');
        args.push(or());
      }
      take(')');
      const text = (v: unknown): string =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? `${v}` : '';
      return text(args[0]).replace(/\{(\d+)\}/g, (_, n: string) => text(args[Number(n) + 1]));
    }
    if (/^[A-Za-z_]/.test(t)) return lookup(t);
    throw new Error(`unexpected token ${t}`);
  };
  const comparison = (): unknown => {
    const left = primary();
    const op = peek();
    if (op === '==' || op === '!=') {
      take();
      const right = primary();
      return op === '==' ? equal(left, right) : !equal(left, right);
    }
    return left;
  };
  const and = (): unknown => {
    let v = comparison();
    while (peek() === '&&') {
      take();
      const r = comparison();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const or = (): unknown => {
    let v = and();
    while (peek() === '||') {
      take();
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  const value = or();
  if (i !== tokens.length) throw new Error(`unread tokens from: ${tokens.slice(i).join(' ')}`);
  return value;
}

/**
 * A workflow value that may mix literal text with `${{ … }}` expressions, as
 * GitHub resolves it: a value that is ONE expression keeps the expression's
 * type; anything else is a string with each expression's result spliced in
 * (null as '', a string, number or boolean as its text). An object result has
 * no text form here, so it throws rather than splicing in "[object Object]".
 */
export function interpolate(source: string, ctx: Record<string, unknown>): unknown {
  if (/^\s*\$\{\{((?:(?!\}\})[\s\S])*)\}\}\s*$/.test(source)) return evaluate(source, ctx);
  return source.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, inner: string) => {
    const v = evaluate(inner, ctx);
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return `${v}`;
    throw new Error(`\${{${inner}}} is an object, which a string cannot hold`);
  });
}
