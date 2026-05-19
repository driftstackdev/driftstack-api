// Drift guard for apps/server/src/lib/client-ip.ts. Pins the shared
// readClientIp XFF-aware parser — collapses the 3-admin-route hand-
// rolled drift surface into one source of truth.

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

  it("Module-level framing pinned: 'Shared client-IP extractor for audit logging. Three admin routes (admin-webhooks / admin-force-actions / admin-accounts) hand-rolled near-identical X-Forwarded-For first-hop parsers; each is the source for the actor_ip column on its admin_audit_log row. Extracting collapses the drift surface so the proxy-header contract has one source of truth.' — pinned so the 3-admin-route consolidation history + actor_ip-column anchor + drift-collapse rationale all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Shared client-IP extractor for audit logging\. Three admin routes\s*\n?\s*\/\/ \(admin-webhooks \/ admin-force-actions \/ admin-accounts\) hand-rolled\s*\n?\s*\/\/ near-identical `X-Forwarded-For` first-hop parsers; each is the\s*\n?\s*\/\/ source for the `actor_ip` column on its admin_audit_log row\.\s*\n?\s*\/\/ Extracting collapses the drift surface so the proxy-header contract\s*\n?\s*\/\/ has one source of truth\./,
    );
  });

  it("4-step contract framing pinned: 1. read x-forwarded-for (Fastify lowercases headers before this runs) 2. if present + non-empty string, return the first comma-separated entry trimmed (XFF lists left-to-right; first is the original caller) 3. fall back to request.ip (Fastify's already-trusted-proxy-aware value) 4. ?? null so the return type stays string|null for the audit row's nullable actor_ip column. — pinned so the 4-step parse + XFF-leftmost-is-client + Fastify-trusts-proxy + null-fallback contract all stay documented", () => {
    expect(body).toMatch(
      /\/\/ Contract:\s*\n?\s*\/\/ {3}- read `x-forwarded-for` \(Fastify lowercases headers before this\s*\n?\s*\/\/ {5}runs\);\s*\n?\s*\/\/ {3}- if present \+ non-empty string, return the first comma-separated\s*\n?\s*\/\/ {5}entry trimmed \(XFF lists "client, proxy1, proxy2…" left-to-\s*\n?\s*\/\/ {5}right; first is the original caller\);/,
    );
    expect(body).toMatch(
      /\/\/ {3}- fall back to `request\.ip` \(Fastify's already-trusted-proxy-\s*\n?\s*\/\/ {5}aware value\);\s*\n?\s*\/\/ {3}- `\?\? null` so the return type stays `string \| null` for the\s*\n?\s*\/\/ {5}audit row's nullable `actor_ip` column\./,
    );
  });

  it("readClientIp 4-line implementation pinned: read xff → check string + non-empty → split + trim first → fall back to request.ip ?? null. Drift to using the rightmost (which is the proxy, not the client) or skipping the trim would surface garbage IPs to the audit log; drift to coalescing undefined to '' instead of null would break the nullable-column contract", () => {
    expect(body).toMatch(
      /export function readClientIp\(request: FastifyRequest\): string \| null \{\s*\n?\s*const xff = request\.headers\['x-forwarded-for'\];\s*\n?\s*if \(typeof xff === 'string' && xff\.length > 0\) \{\s*\n?\s*const first = xff\.split\(','\)\[0\]\?\.trim\(\);\s*\n?\s*if \(first\) return first;\s*\n?\s*\}\s*\n?\s*return request\.ip \?\? null;\s*\n?\s*\}/,
    );
  });

  it("Empty-string and first-empty-after-trim fallthrough framing pinned: when xff is empty string (length === 0) OR when split[0].trim() returns empty, the function falls back to request.ip. Drift to returning '' instead would let the audit log store useless empty strings in actor_ip", () => {
    expect(body).toMatch(/if \(typeof xff === 'string' && xff\.length > 0\) \{/);
    expect(body).toMatch(/if \(first\) return first;/);
  });

  it("FastifyRequest type import pinned: 'import type { FastifyRequest } from fastify;' — pinned so the cross-app shared parser stays typed against Fastify's request shape (drift to a different web-framework type would break the lowercased-headers contract)", () => {
    expect(body).toMatch(/import type \{ FastifyRequest \} from 'fastify';/);
  });
});
