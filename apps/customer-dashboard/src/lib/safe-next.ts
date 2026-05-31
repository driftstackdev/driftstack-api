// Same-origin guard for the `?next=` / `return_to` deep-link params.
//
// The sign-in / sign-up pages honour a `?next=` param to resume a deep link
// after auth (e.g. the /cli/authorize round-trip). Navigating to a RAW `next`
// is an open-redirect: `/login?next=https://evil.com` would bounce a
// freshly-signed-in user off-site (phishing). This helper reduces any `next`
// to a SAME-ORIGIN RELATIVE path, or `/` when it's off-origin / malformed /
// absent.
//
// It uses the WHATWG URL parser (NOT a regex) on purpose — open-redirect
// sanitizers built from string checks are notoriously bypassable
// (`//evil.com`, `https:evil.com`, `/\evil.com`, `%2f%2fevil.com`,
// embedded control chars, …). Letting `new URL()` resolve `next` against the
// real origin and then comparing `.origin` defers all that parsing to the
// browser/runtime, which is the same parser the eventual navigation uses.
//
// `origin` is a parameter (not read from `window` internally) so the function
// is a pure unit — call sites pass `window.location.origin`; tests pass a
// fixed origin and exercise the bypass vectors directly.

export function safeNextPath(next: string | null | undefined, origin: string): string {
  if (typeof next !== 'string' || next.length === 0) return '/';
  let parsed: URL;
  try {
    parsed = new URL(next, origin);
  } catch {
    return '/';
  }
  // Off-origin (absolute, protocol-relative, scheme-relative, or
  // backslash-normalised authority) → refuse, fall back to root.
  if (parsed.origin !== origin) return '/';
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  // Must be a single-slash absolute path. A same-origin URL can still have a
  // `//`-prefixed PATHNAME (e.g. `https://app.x//evil.com` → pathname
  // `//evil.com`); returning that verbatim would let `window.location.href`
  // treat it as a PROTOCOL-RELATIVE url and navigate off-site — so reject the
  // `//` (and `/\`) authority-looking prefixes too.
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  return path;
}
