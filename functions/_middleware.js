// T-3 step 8 — the `.dev` → `.io` website redirect, as a Cloudflare Pages Function.
//
// WHY THIS EXISTS RATHER THAN A CLOUDFLARE REDIRECT RULE. The plan's step 8 called for a
// zone-level Single Redirect (or a Bulk Redirect) on the driftstack.dev zone. That needs a
// token with `Zone → Dynamic Redirect → Edit`, and no credential on this machine has it —
// measured 2026-09-06 across FOUR surfaces (zone `http_request_dynamic_redirect` entrypoint,
// account rulesets, account bulk-redirect lists, zone page rules) against ALL THREE tokens
// (the repo `CLOUDFLARE_API_TOKEN`, the `~/.cloudflared` cert token, the `.io`-scoped keychain
// token). Every one answers 10000/9109. See ledger T-3.
//
// The five website Pages projects already serve BOTH TLDs — the `.dev` custom domains stayed
// attached so the old hosts keep a valid certificate — so the redirect can be done in the
// thing we already deploy, with no new credential at all.
//
// WHY NOT `_redirects`. It cannot match on host. Wrangler's own parser rejects an absolute
// `from`, verified locally: "Only relative URLs are allowed. Skipping absolute URL
// https://driftstack.dev/*". Path-based rules in each project's `_redirects` are unaffected by
// this file and still run, via `context.next()` below (also verified locally: a `/docs/old-page`
// rule still answers 301 with the middleware in place).
//
// SCOPE — only the six WEBSITE hosts move. `api.`, `errors.`, `fleet.` and `staging.` are not
// Pages projects at all, so they never reach this code; they stay on `.dev` permanently, which
// is what the SDKs and the RFC-9457 problem-type URIs depend on.
//
// FAIL-SAFE. This runs on every request to all five customer-facing sites, so the non-matching
// path must be inert: no response re-wrapping, no header mutation, and any throw falls through
// to `context.next()`. The worst case is that the redirect silently does not happen; it cannot
// take a site down.
//
// Guard: apps/server/tests/unit/the-dev-hosts-redirect-to-io.test.ts.

const MOVED = {
  'driftstack.dev': 'driftstack.io',
  'www.driftstack.dev': 'www.driftstack.io',
  'app.driftstack.dev': 'app.driftstack.io',
  'docs.driftstack.dev': 'docs.driftstack.io',
  'status.driftstack.dev': 'status.driftstack.io',
  'admin.driftstack.dev': 'admin.driftstack.io',
};

export const onRequest = (context) => {
  try {
    const url = new URL(context.request.url);
    const to = MOVED[url.hostname];
    if (to !== undefined) {
      url.hostname = to;
      // Force https: a `.dev` visitor arriving over http must not be 301'd to an http `.io`.
      url.protocol = 'https:';
      // Path and query are carried by URL itself — the desktop CLI-authorize flow
      // (app.driftstack.dev/cli/authorize?code=…&state=…) must survive the hop.
      return Response.redirect(url.toString(), 301);
    }
  } catch {
    /* fall through and serve the site normally */
  }
  return context.next();
};
