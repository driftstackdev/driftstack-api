// The dashboard's DEV-ONLY sample-data mode (dev-fixtures/) lets the owner look
// at every signed-in page with `DASHBOARD_DEV_FIXTURES=1 astro dev`, no API
// needed. This file proves it can never reach a customer:
//   - the integration adds its plugin only for `astro dev` with the flag set;
//   - the plugin is serve-only, and answers only its own path prefix;
//   - nothing under src/ imports dev-fixtures/;
//   - the production dist/ (built by the root `pretest`) holds none of the
//     sample data — with a positive control that the scanner finds it where it
//     does live.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEV_FIXTURE_FLAG,
  DEV_FIXTURE_SIGN_IN,
  devFixturePlugin,
  devFixtures,
} from '../../dev-fixtures/integration.mjs';
import { DEV_FIXTURE_PREFIX, DEV_FIXTURE_TOKEN } from '../../dev-fixtures/fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', '..');
const DIST = resolve(APP, 'dist');
const SRC = resolve(APP, 'src');

/** Strings that exist only in the sample data and its plumbing. */
const SENTINELS = [
  DEV_FIXTURE_PREFIX,
  DEV_FIXTURE_TOKEN,
  DEV_FIXTURE_SIGN_IN,
  'driftstack-dashboard-dev-fixtures',
  'alex.rivera@example.com',
  'ses_8c1f0a2b9d',
  'whk_01J7M2N3P4',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function sentinelsIn(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (/\.(woff2?|png|ico|jpe?g|webp)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const s of SENTINELS)
      if (text.includes(s)) hits.push(`${file.slice(APP.length + 1)}: ${s}`);
  }
  return hits;
}

type SetupArgs = {
  command: string;
  updateConfig: (c: { vite: { plugins: Array<{ name: string; apply: string }> } }) => void;
  logger: { info: (m: string) => void };
};

function runSetup(command: string, env: Record<string, string | undefined>) {
  const updates: Array<{ vite: { plugins: Array<{ name: string; apply: string }> } }> = [];
  const integration = devFixtures(env) as {
    hooks: { 'astro:config:setup': (args: SetupArgs) => void };
  };
  integration.hooks['astro:config:setup']({
    command,
    updateConfig: (c) => updates.push(c),
    logger: { info: () => {} },
  });
  return updates;
}

describe('the dashboard sample data never reaches a production build', () => {
  it('the integration adds nothing to `astro build`, `preview` or `sync`, even with the flag set', () => {
    for (const command of ['build', 'preview', 'sync']) {
      const env: Record<string, string | undefined> = { [DEV_FIXTURE_FLAG]: '1' };
      expect(runSetup(command, env), command).toEqual([]);
      expect(env.PUBLIC_API_BASE_URL, command).toBeUndefined();
    }
  });

  it('the integration adds nothing to `astro dev` unless the flag is exactly 1', () => {
    for (const flag of [undefined, '', '0', 'true']) {
      const env: Record<string, string | undefined> = { [DEV_FIXTURE_FLAG]: flag };
      expect(runSetup('dev', env), String(flag)).toEqual([]);
      expect(env.PUBLIC_API_BASE_URL).toBeUndefined();
    }
  });

  it('with the flag, `astro dev` gets one serve-only plugin and a same-origin sample API', () => {
    const env: Record<string, string | undefined> = {
      [DEV_FIXTURE_FLAG]: '1',
      PUBLIC_API_BASE_URL: 'https://api.driftstack.dev',
    };
    const updates = runSetup('dev', env);
    expect(updates).toHaveLength(1);
    const plugins = updates[0]!.vite.plugins;
    expect(plugins.map((p) => [p.name, p.apply])).toEqual([
      ['driftstack-dashboard-dev-fixtures', 'serve'],
    ]);
    // The real API is never contacted in sample mode.
    expect(env.PUBLIC_API_BASE_URL).toBe(DEV_FIXTURE_PREFIX);
  });

  it('the plugin answers only its own prefix and the sign-in page, and passes every other request on', () => {
    const plugin = devFixturePlugin() as {
      apply: string;
      configureServer: (server: {
        middlewares: { use: (fn: (req: unknown, res: unknown, next: () => void) => void) => void };
      }) => void;
    };
    expect(plugin.apply).toBe('serve');
    let middleware: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
    plugin.configureServer({ middlewares: { use: (fn) => (middleware = fn) } });
    expect(middleware).toBeDefined();

    function call(url: string, method = 'GET') {
      const res = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: '',
        setHeader(k: string, v: string) {
          this.headers[k] = v;
        },
        end(b?: string) {
          this.body = b ?? '';
        },
      };
      let passed = false;
      middleware!({ url, method }, res, () => {
        passed = true;
      });
      return { res, passed };
    }

    const me = call(DEV_FIXTURE_PREFIX + '/v1/account/me');
    expect(me.passed).toBe(false);
    expect(me.res.statusCode).toBe(200);
    expect(JSON.parse(me.res.body).email).toBe('alex.rivera@example.com');

    const write = call(DEV_FIXTURE_PREFIX + '/v1/api-keys', 'POST');
    expect(write.res.statusCode).toBe(204);

    const unknown = call(DEV_FIXTURE_PREFIX + '/v1/nothing-here');
    expect(unknown.res.statusCode).toBe(404);

    const signIn = call(DEV_FIXTURE_SIGN_IN);
    expect(signIn.res.body).toContain(DEV_FIXTURE_TOKEN);

    for (const url of ['/', '/billing/', '/v1/account/me', '/__dev-fixture-apix/v1/account/me']) {
      expect(call(url).passed, url).toBe(true);
    }
  });

  it('the Astro config registers the integration (the only way it runs)', () => {
    const config = readFileSync(resolve(APP, 'astro.config.mjs'), 'utf8');
    expect(config).toMatch(/import \{ devFixtures \} from '\.\/dev-fixtures\/integration\.mjs';/);
    expect(config).toMatch(/integrations: \[\s*devFixtures\(\),/);
  });

  it('nothing under src/ imports the sample data', () => {
    const importers = walk(SRC).filter((f) => /dev-fixtures/.test(readFileSync(f, 'utf8')));
    expect(importers).toEqual([]);
  });

  it('the production dist/ holds none of the sample data', () => {
    const files = walk(DIST);
    // A real build: every signed-in page is there to be scanned.
    expect(files.filter((f) => f.endsWith('index.html')).length).toBeGreaterThanOrEqual(20);
    expect(sentinelsIn(files)).toEqual([]);
  });

  it('positive control: the scanner finds the sample data where it does live', () => {
    const hits = sentinelsIn(walk(resolve(APP, 'dev-fixtures')));
    for (const s of SENTINELS) {
      expect(
        hits.some((h) => h.endsWith(`: ${s}`)),
        s,
      ).toBe(true);
    }
  });
});
