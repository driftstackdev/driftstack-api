import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/live-quality-scan.mjs');

async function runScan(baseUrl: string): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [SCRIPT, baseUrl], {
    env: {
      ...process.env,
      MAX_DEPTH: '2',
      MAX_EXTERNAL: '0',
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
});
