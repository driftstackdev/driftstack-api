// V-928 — the published proxy body carried no bounds and no formats.
//
// `POST /v1/account/me/proxies` parses with `AccountProxyInputSchema`, whose
// common fields are bounded (label 1–80, host 1–255, port 1–65535, username
// ≤255, password ≤1024) and whose VPN blocks carry regexes: a WireGuard key is a
// 44-character base64 curve25519 value, an endpoint is `host:port`. The request
// body in `openapi.ts` was a hand-written mirror that typed every one of those as
// a bare `z.string()`. The document therefore described a WireGuard key as "any
// string", and the only way to learn its shape was a 400.
//
// The nested blocks now use the REAL `OpenVpnProxyConfigSchema` /
// `WireGuardProxyConfigSchema`, so that half cannot drift again by construction.
// The outer object is still a hand-written flat mirror and CAN drift, which is
// what this file checks.
//
// The outer shape stays flat deliberately. `AccountProxyInputSchema` is a
// discriminatedUnion on `scheme` — `scheme: 'openvpn'` requires the `openvpn`
// block, every branch is `.strict()` — and publishing that union would be a more
// accurate contract. It is not changed here because the Go SDK models this body
// as ONE struct (`AccountProxyInput` in sdk-go/egress.go) and Go has no union
// type, and the Python models are generated from this document. Reshaping a
// published component that two SDKs are built from is a decision, not a
// remediation, so V-928 records it as one.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountProxyInputSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');

interface Published {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

interface SpecShape {
  components: { schemas: Record<string, { properties?: Record<string, Published> }> };
}

function publishedProxyInput(): Record<string, Published> {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
  return spec.components.schemas['AccountProxyInput']?.properties ?? {};
}

/** Bounds the REAL schema enforces, read from its socks5 branch. */
function realCommonBounds(): Record<string, { min?: number; max?: number }> {
  const options = (AccountProxyInputSchema as unknown as { options: unknown[] }).options;
  const socks5 = options[0] as { shape: Record<string, unknown> };
  const out: Record<string, { min?: number; max?: number }> = {};
  for (const field of ['label', 'host', 'port', 'username', 'password']) {
    let node = socks5.shape[field] as { _def?: Record<string, unknown> } | undefined;
    // unwrap default/nullable/optional to reach the string or number node
    for (let i = 0; i < 6 && node?._def; i += 1) {
      const inner = (node._def as { innerType?: typeof node }).innerType;
      if (!inner) break;
      node = inner;
    }
    const checks = (node?._def as { checks?: { kind: string; value: number }[] })?.checks ?? [];
    const min = checks.find((c) => c.kind === 'min')?.value;
    const max = checks.find((c) => c.kind === 'max')?.value;
    out[field] = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  return out;
}

describe('V-928 the proxy body publishes its real bounds', () => {
  it('CRITICAL both sides parse, and the real schema really is bounded. Every arm below compares two numbers; if the schema walk returned nothing the comparisons would agree over empty sets, which is the false green this sweep keeps finding.', () => {
    const real = realCommonBounds();
    expect(real['label']?.max, 'label upper bound read from the schema').toBe(80);
    expect(real['port']?.max, 'port upper bound read from the schema').toBe(65535);
    expect(Object.keys(publishedProxyInput()).length, 'published properties').toBeGreaterThan(4);
  });

  it('CRITICAL the document publishes the bounds the route enforces. The mirror typed these as bare strings, so a request the document called valid — a 300-character label, a port of 70000 — drew a 400 the contract had not predicted.', () => {
    const published = publishedProxyInput();
    const real = realCommonBounds();
    const gaps: string[] = [];
    for (const [field, bounds] of Object.entries(real)) {
      const p = published[field];
      const pubMax = field === 'port' ? p?.maximum : p?.maxLength;
      const pubMin = field === 'port' ? p?.minimum : p?.minLength;
      if (bounds.max !== undefined && pubMax !== bounds.max) {
        gaps.push(`${field}: route max ${String(bounds.max)}, document ${String(pubMax)}`);
      }
      if (bounds.min !== undefined && pubMin !== bounds.min) {
        gaps.push(`${field}: route min ${String(bounds.min)}, document ${String(pubMin)}`);
      }
    }
    expect(gaps, 'the document under-specifies these proxy bounds:').toEqual([]);
  });

  it('CRITICAL the VPN blocks publish their formats. A WireGuard key is a 44-character base64 value and the endpoint is host:port; published as bare strings, the document gave a customer nothing to validate against before sending. These come from the real schemas now, so this arm is a regression check on that wiring rather than on hand-copied patterns.', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape & {
      components: {
        schemas: Record<
          string,
          { properties?: Record<string, { properties?: Record<string, Published> }> }
        >;
      };
    };
    const wg = spec.components.schemas['AccountProxyInput']?.properties?.['wireguard']?.properties;
    expect(wg?.['private_key']?.pattern, 'wireguard private_key format').toBe(
      '^[A-Za-z0-9+/]{43}=$',
    );
    expect(wg?.['peer_public_key']?.pattern, 'wireguard peer_public_key format').toBe(
      '^[A-Za-z0-9+/]{43}=$',
    );
    expect(wg?.['endpoint']?.pattern, 'wireguard endpoint format').toMatch(/A-Za-z0-9/);
    const ovpn = spec.components.schemas['AccountProxyInput']?.properties?.['openvpn']?.properties;
    expect(ovpn?.['config_blob']?.maxLength, 'openvpn config_blob cap').toBe(256 * 1024);
  });
});
