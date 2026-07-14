/**
 * Build a bearer-link URL for a static Dashboard page.
 *
 * Astro emits these pages as `path/index.html`, and Cloudflare Pages redirects
 * a slashless request to `path/`. Canonicalizing before the email is sent keeps
 * the one-time token out of that extra query-preserving redirect. Existing
 * non-token query parameters and fragments on an explicit operator URL remain
 * intact.
 */
export function canonicalOneTimeTokenUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  url.searchParams.set('token', token);
  return url.toString();
}
