import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/live-quality-scan.mjs');

function needsCanonicalSlash(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.pathname === '/' || parsed.pathname.endsWith('/')) return false;
  return !(parsed.pathname.split('/').at(-1) ?? '').includes('.');
}

function defaultSeeds(source: string): string[] {
  const block = source.match(/const DEFAULT_SEEDS = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  return Array.from(block.matchAll(/'([^']+)'/g), (match) => String(match[1]));
}

async function runScan(
  baseUrl: string,
  options: { maxExternal?: number } = {},
): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [SCRIPT, baseUrl], {
    env: {
      ...process.env,
      MAX_DEPTH: '2',
      MAX_EXTERNAL: String(options.maxExternal ?? 0),
      MAX_PAGES: '5',
      SLOW_MS: '10000',
      TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, output };
}

describe('live-quality-scan redirect detection', () => {
  it('requests canonical default static routes directly', () => {
    const seeds = defaultSeeds(readFileSync(SCRIPT, 'utf8'));
    expect(seeds.length).toBeGreaterThan(8);
    expect(seeds.filter(needsCanonicalSlash)).toEqual([]);

    const mutated = seeds.map((seed) =>
      seed === 'https://driftstack.dev/pricing/' ? seed.slice(0, -1) : seed,
    );
    expect(mutated.filter(needsCanonicalSlash)).toEqual(['https://driftstack.dev/pricing']);
  });

  it('fails when fetch follows an internal redirect to a different final URL', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/redirected') {
        res.writeHead(308, { location: '/redirected/' }).end();
        return;
      }
      if (req.url === '/redirected/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>Canonical</title></head><body>ok</body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><head><title>Root</title></head><body><a href="/redirected">link</a></body></html>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test port');

    try {
      const result = await runScan(`http://127.0.0.1:${address.port}`);
      expect(result.code).toBe(1);
      expect(result.output).toContain('unexpected-redirect (1)');
      expect(result.output).toContain('/redirected/');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('reports a confirmed external 403 as an unverifiable warning without failing', async () => {
    const external = createServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><head><title>Sign in required</title></head></html>');
    });
    external.listen(0, '127.0.0.1');
    await once(external, 'listening');
    const externalAddress = external.address();
    if (externalAddress === null || typeof externalAddress === 'string') {
      throw new Error('missing external test port');
    }

    const internal = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><head><title>Root</title></head><body><a href="http://127.0.0.1:${externalAddress.port}/account">Account</a></body></html>`,
      );
    });
    internal.listen(0, '127.0.0.1');
    await once(internal, 'listening');
    const internalAddress = internal.address();
    if (internalAddress === null || typeof internalAddress === 'string') {
      throw new Error('missing internal test port');
    }

    try {
      const result = await runScan(`http://127.0.0.1:${internalAddress.port}`, {
        maxExternal: 2,
      });
      expect(result.code).toBe(0);
      expect(result.output).toContain('0 issue(s), 1 warning(s)');
      expect(result.output).toContain('unverifiable-external-link warning (1)');
      expect(result.output).toContain('HTTP 403');
      expect(result.output).not.toContain('broken-external-link');
      expect(result.output).toContain('✅ clean (1 warning(s))');
    } finally {
      internal.close();
      external.close();
      await Promise.all([once(internal, 'close'), once(external, 'close')]);
    }
  });

  it('keeps a confirmed external 404 as a release-blocking defect', async () => {
    const external = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><head><title>Missing</title></head></html>');
    });
    external.listen(0, '127.0.0.1');
    await once(external, 'listening');
    const externalAddress = external.address();
    if (externalAddress === null || typeof externalAddress === 'string') {
      throw new Error('missing external test port');
    }

    const internal = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><head><title>Root</title></head><body><a href="http://127.0.0.1:${externalAddress.port}/missing">Missing</a></body></html>`,
      );
    });
    internal.listen(0, '127.0.0.1');
    await once(internal, 'listening');
    const internalAddress = internal.address();
    if (internalAddress === null || typeof internalAddress === 'string') {
      throw new Error('missing internal test port');
    }

    try {
      const result = await runScan(`http://127.0.0.1:${internalAddress.port}`, {
        maxExternal: 2,
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain('broken-external-link (1)');
      expect(result.output).toContain('HTTP 404');
      expect(result.output).toContain('❌ 1 defect(s)');
    } finally {
      internal.close();
      external.close();
      await Promise.all([once(internal, 'close'), once(external, 'close')]);
    }
  });
});
