// DEV-ONLY sample-data mode for the customer dashboard.
//
//   DASHBOARD_DEV_FIXTURES=1 npx astro dev --port 4410 --host 127.0.0.1
//
// then open /__dev-fixture-sign-in once: it stores a sample session token
// in this browser and opens the Overview. Every signed-in page then renders
// against dev-fixtures/fixtures.mjs, answered by the dev server itself under
// /__dev-fixture-api, so no API, database or account is involved and every
// write is accepted and discarded.
//
// Three locks keep it out of anything that ships:
//   1. the integration adds its plugin only when Astro runs `dev` AND the
//      DASHBOARD_DEV_FIXTURES=1 flag is set (never on `build`, `preview`
//      or `sync`);
//   2. the Vite plugin itself is `apply: 'serve'`, so a build ignores it even
//      if it were registered;
//   3. nothing under src/ imports dev-fixtures/, so a production bundle has
//      no path to the sample data —
//      tests/unit/the-dashboard-sample-data-never-reaches-a-production-build.test.ts
//      scans the built dist/ for it.

import { DEV_FIXTURE_PREFIX, DEV_FIXTURE_TOKEN, fixtureResponse } from './fixtures.mjs';

export const DEV_FIXTURE_FLAG = 'DASHBOARD_DEV_FIXTURES';
export const DEV_FIXTURE_SIGN_IN = '/__dev-fixture-sign-in';

/** The Vite plugin: a middleware on the dev server only. */
export function devFixturePlugin() {
  return {
    name: 'driftstack-dashboard-dev-fixtures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://dev.invalid');
        if (url.pathname === DEV_FIXTURE_SIGN_IN) {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(
            '<!doctype html><meta charset="utf-8"><title>Sample account</title>' +
              '<script>try{localStorage.setItem("ds_web_session_token",' +
              JSON.stringify(DEV_FIXTURE_TOKEN) +
              ')}catch(e){}location.replace("/")</script>',
          );
          return;
        }
        if (!url.pathname.startsWith(DEV_FIXTURE_PREFIX + '/')) {
          next();
          return;
        }
        const apiPath = url.pathname.slice(DEV_FIXTURE_PREFIX.length);
        const answer = fixtureResponse(req.method ?? 'GET', apiPath, url.search) ?? {
          status: 404,
          body: { detail: 'No sample data for this request.' },
        };
        res.statusCode = answer.status;
        if (answer.body === null) {
          res.end();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer.body));
      });
    },
  };
}

/**
 * The Astro integration. Adds the plugin, and points the dashboard at the
 * dev server's own sample API, only for `astro dev` with the flag set.
 */
export function devFixtures(env = process.env) {
  return {
    name: 'driftstack-dashboard-dev-fixtures',
    hooks: {
      'astro:config:setup': ({ command, updateConfig, logger }) => {
        if (command !== 'dev' || env[DEV_FIXTURE_FLAG] !== '1') return;
        // Same-origin and relative, so the sample API can never be mistaken
        // for a real one; set before Vite reads the PUBLIC_ variables.
        env.PUBLIC_API_BASE_URL = DEV_FIXTURE_PREFIX;
        updateConfig({ vite: { plugins: [devFixturePlugin()] } });
        logger.info(`sample data on: open ${DEV_FIXTURE_SIGN_IN} to sign in to the sample account`);
      },
    },
  };
}
