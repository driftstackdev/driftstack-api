// V-195 — integration test for the public GET /version endpoint.
// Verifies shape, public-no-auth, and that overriding GIT_SHA via env
// surfaces in the response.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface VersionResponse {
  version: string;
  git_sha: string;
  started_at: string;
  node_version: string;
  driver: 'mock' | 'webkit' | 'playwright';
  playwright_browser?: 'webkit' | 'chromium' | 'firefox';
  agent_execution: 'live' | 'simulated';
}

describe('GET /version', () => {
  it('200 with version + git_sha + started_at + node_version (public, no auth)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    const body = res.json<VersionResponse>();
    expect(typeof body.version).toBe('string');
    expect(typeof body.git_sha).toBe('string');
    expect(typeof body.started_at).toBe('string');
    expect(body.node_version).toMatch(/^v\d+/);
    // started_at must parse as a valid ISO date.
    expect(Number.isNaN(new Date(body.started_at).getTime())).toBe(false);
  });

  it('prefers the deploy-owned APP_VERSION when the service starts outside npm', async () => {
    const previousAppVersion = process.env.APP_VERSION;
    const previousNpmVersion = process.env.npm_package_version;
    process.env.APP_VERSION = '1.2.3-release.4';
    process.env.npm_package_version = '9.9.9';
    try {
      fx = await buildTestApp();
      const res = await fx.app.inject({ method: 'GET', url: '/version' });
      expect(res.json<VersionResponse>().version).toBe('1.2.3-release.4');
    } finally {
      if (previousAppVersion === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = previousAppVersion;
      if (previousNpmVersion === undefined) delete process.env.npm_package_version;
      else process.env.npm_package_version = previousNpmVersion;
    }
  });

  it("reports 'unknown' instead of a fabricated version outside deploy and npm", async () => {
    const previousAppVersion = process.env.APP_VERSION;
    const previousNpmVersion = process.env.npm_package_version;
    delete process.env.APP_VERSION;
    delete process.env.npm_package_version;
    try {
      fx = await buildTestApp();
      const res = await fx.app.inject({ method: 'GET', url: '/version' });
      expect(res.json<VersionResponse>().version).toBe('unknown');
    } finally {
      if (previousAppVersion !== undefined) process.env.APP_VERSION = previousAppVersion;
      if (previousNpmVersion !== undefined) process.env.npm_package_version = previousNpmVersion;
    }
  });

  it('reports GIT_SHA env value when set', async () => {
    const prev = process.env.GIT_SHA;
    process.env.GIT_SHA = 'abc1234';
    try {
      fx = await buildTestApp();
      const res = await fx.app.inject({ method: 'GET', url: '/version' });
      const body = res.json<VersionResponse>();
      expect(body.git_sha).toBe('abc1234');
    } finally {
      if (prev === undefined) delete process.env.GIT_SHA;
      else process.env.GIT_SHA = prev;
    }
  });

  it("returns 'unknown' for git_sha when GIT_SHA env is unset", async () => {
    const prev = process.env.GIT_SHA;
    delete process.env.GIT_SHA;
    try {
      fx = await buildTestApp();
      const res = await fx.app.inject({ method: 'GET', url: '/version' });
      const body = res.json<VersionResponse>();
      expect(body.git_sha).toBe('unknown');
    } finally {
      if (prev !== undefined) process.env.GIT_SHA = prev;
    }
  });

  it('V-337 — surfaces driver name; defaults to mock for tests', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    const body = res.json<VersionResponse>();
    // Test fixture doesn't pass driverName explicitly → defaults to mock.
    expect(body.driver).toBe('mock');
    // playwright_browser only included when driver === 'playwright'.
    expect(body.playwright_browser).toBeUndefined();
  });

  // V-1427 — the arm below covers 'simulated' and asserted the other value in a
  // COMMENT: "Prod (FLEET_CONTROL_PLANE_ENABLED=true) → 'live'". Coverage agreed the
  // string 'live' had never been produced by this expression.
  //
  // It matters because of who reads it. The GUI keys its "actions are simulated"
  // banner on this field and nothing else — `AgentChatView` records that keying on
  // `driver` instead "wrongly showed preview mode", because `driver` is 'mock' in
  // production even when automation is live through the fleet path. So a flag stuck
  // at 'simulated' tells customers their real browser actions are fake, and one stuck
  // at 'live' tells a dev deployment the stubbed ones are real.
  it("#139 CRITICAL agent_execution is 'live' when the fleet control plane IS enabled — the value the GUI uses to drop the simulated-actions banner, and the one production actually serves.", async () => {
    fx = await buildTestApp({ enableFleetControlPlane: true });
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    const body = res.json<VersionResponse>();
    expect(body.agent_execution).toBe('live');
    expect(
      body.driver,
      'and `driver` stays mock in the same breath — the reason this field exists rather than reusing it',
    ).toBe('mock');
  });

  it("#139 — surfaces agent_execution; 'simulated' when the fleet control plane is off (test default)", async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/version' });
    const body = res.json<VersionResponse>();
    // Test fixture doesn't enable the fleet control plane → agentExecutionLive
    // undefined → 'simulated'. Prod (FLEET_CONTROL_PLANE_ENABLED=true) → 'live'.
    expect(body.agent_execution).toBe('simulated');
  });
});
