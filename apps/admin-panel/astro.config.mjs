// @ts-check
import { defineConfig } from 'astro/config';

// Admin panel — Driftstack-staff-only surface.
// Lives at admin.driftstack.dev (separate subdomain from the customer
// dashboard at app.driftstack.dev) so security boundary is at the DNS
// + TLS layer, not application logic.
//
// Auth: Driftstack-staff API key with `driftstack_internal_admin`
// scope. Routes call /v1/admin/* on the control plane; preHandler
// enforced V-134 + V-174.
//
// Cloudflare Pages serves static output directly. Arbitrary account and
// incident ids use `_redirects` 200 rewrites to deterministic client-fetched
// shells; no Worker/SSR adapter is required.
// A production `astro build` with no PUBLIC_API_BASE_URL used to fail SILENTLY:
// getApiBaseUrl() throws per page during static generation, astro logs the error
// yet exits 0 with a dist holding 404.html + headers but NO page HTML — a
// silent-partial build that ENOENTs every dist-reading test and would ship an
// empty site. Fail LOUD, before any page is generated, so a missing origin is a
// non-zero build error, never a partial artifact. `astro dev`/`check` are
// unaffected (argv gates to `build`); pretest/CI already set the variable.
if (
  process.argv.includes('build') &&
  (process.env.PUBLIC_API_BASE_URL ?? '').length === 0 &&
  process.env.NODE_ENV !== 'development'
) {
  throw new Error(
    'admin-panel: PUBLIC_API_BASE_URL must be set for `astro build`. Set it to the public ' +
      'API origin (e.g. https://api.driftstack.dev); local test builds default it to ' +
      'http://localhost:3000 via the root `pretest`.',
  );
}

export default defineConfig({
  site: 'https://admin.driftstack.dev',
  output: 'static',
  // Preserve Astro 5/6's HTML-aware whitespace semantics under Astro 7.
  compressHTML: true,
  build: {
    inlineStylesheets: 'auto',
  },
});
