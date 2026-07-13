// Drift guard for apps/server/src/lib/client-ip.ts. Pins the shared
// trusted-proxy-aware reader and prevents raw XFF trust from returning.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/client-ip.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('lib/client-ip content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('documents Fastify request.ip as the sole configured trust boundary', () => {
    expect(body).toMatch(/Fastify resolves `request\.ip` through its configured `trustProxy`/);
    expect(body).toMatch(/raw leftmost value can be caller-supplied and is not authoritative/);
  });

  it('documents raw forwarding headers as ignored and preserves nullable metadata', () => {
    expect(body).toMatch(/return only Fastify's trusted-proxy-aware `request\.ip` value/);
    expect(body).toMatch(/ignore raw forwarding headers, including spoofed leftmost hops/);
    expect(body).toMatch(/`\?\? null` so the return type stays `string \| null`/);
  });

  it('returns only request.ip and never parses forwarding headers directly', () => {
    expect(body).toMatch(
      /export function readClientIp\(request: FastifyRequest\): string \| null \{\s*return request\.ip \?\? null;\s*\}/,
    );
    expect(body).not.toMatch(/request\.headers\[['"]x-forwarded-for['"]\]/);
    expect(body).not.toMatch(/\.split\(['"],['"]\)/);
  });

  it("FastifyRequest type import pinned: 'import type { FastifyRequest } from fastify;' — the helper stays typed against Fastify's trusted request.ip shape", () => {
    expect(body).toMatch(/import type \{ FastifyRequest \} from 'fastify';/);
  });
});
