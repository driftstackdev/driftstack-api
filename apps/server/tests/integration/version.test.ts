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
});
