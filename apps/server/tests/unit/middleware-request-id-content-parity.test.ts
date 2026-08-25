// W393.C — drift guard for apps/server/src/middleware/request-id.ts.
// Tiny Fastify plugin (one onSend hook) but load-bearing: every
// log line, every Sentry capture, and every customer-facing error
// response carries `request.id` for correlation. The OTel scaffold
// (lib/otel.ts) explicitly anchors trace-id propagation to this
// middleware. Drift here breaks every log↔Sentry↔response join key.
//
//   • Module framing pinned: trust inbound x-request-id else generate;
//     Fastify's genReqId covers generation; this hook surfaces id on
//     response so callers can correlate.
//   • fastify-plugin default-exported, name='request-id'.
//   • onSend hook: reply.header('x-request-id', request.id).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MW = resolve(REPO_ROOT, 'apps/server/src/middleware/request-id.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W393.C apps/server/src/middleware/request-id.ts content parity', () => {
  const body = read(MW);

  it('framing pinned: trust inbound x-request-id else generate (Fastify genReqId), surface on response for correlation', () => {
    expect(body).toMatch(
      /Request ID propagation: trust an inbound `x-request-id` header if present,\s*\/\/\s*otherwise generate one\. Fastify's built-in `genReqId` covers generation;\s*\/\/\s*this hook surfaces the id on the response so callers can correlate/,
    );
  });

  it('plugin signature: (app, _opts, done) — Fastify plugin shape', () => {
    expect(body).toMatch(
      /function requestIdPlugin\(app: FastifyInstance, _opts: unknown, done: \(err\?: Error\) => void\): void \{/,
    );
  });

  it('onSend hook: reply.header("x-request-id", request.id) + hookDone(null, payload)', () => {
    expect(body).toMatch(
      /app\.addHook\('onSend', \(request, reply, payload, hookDone\) => \{\s*reply\.header\('x-request-id', request\.id\);\s*hookDone\(null, payload\);\s*\}\);/,
    );
    expect(body).toMatch(/done\(\);/);
  });

  it('export: default fp(requestIdPlugin, { name: "request-id" }) — fastify-plugin wrapper, named "request-id"', () => {
    expect(body).toMatch(/export default fp\(requestIdPlugin, \{ name: 'request-id' \}\);/);
  });

  it('imports: fastify-plugin default (fp) + FastifyInstance type', () => {
    expect(body).toMatch(/import fp from 'fastify-plugin';/);
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(MW)).toBe(true);
  });
});
