// Drift guard for apps/server/src/routes/session-proxy.ts. Pins
// EG-API-1.2 POST + GET /v1/sessions/{id}/proxy — per-session proxy
// config. Activation-gate matches saved-proxies (EG-API-1.3).
// SECURITY: proxy configs carry customer secrets (SOCKS5 password,
// OpenVPN .ovpn including embedded private keys, WireGuard private
// key). The route layer ONLY validates the shape + dispatches to the
// service; never echoes body fields in error responses.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/session-proxy.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('routes/session-proxy content parity', () => {
  // V-823 — the correction block must be present, and the two claims it
  // retires must not return. An operator who reads the original comments goes
  // hunting through deployment config for a backend that is already built.
  it('V-823 CRITICAL the header records that BOTH registrars are stubs, and blames the right thing. bootstrap constructs SocksProxyBackend unconditionally, so the ACTIVE registrar is what runs in every real deployment — and it destructures the service as `_service` and never calls it. applyToSession() has no caller anywhere in the server.', () => {
    const src = read(LIB);
    expect(src).toMatch(/V-823 — READ THIS BEFORE DEBUGGING A 503 HERE\. Both registrars are/);
    expect(src).toMatch(
      /never calls it\. `applyToSession\(\)` and `releaseFromSession\(\)` have no/,
    );
    expect(src, 'the 503 is an unfinished wiring, not a deployment state').toMatch(
      /It\s*\n\/\/ is an unfinished route-to-service edge\./,
    );
    expect(src, 'the POST comment must not blame deployment config').not.toMatch(
      /\/\/ This deployment does not expose a session-egress backend\./,
    );
    expect(src, 'the GET comment must not blame an unwired backend').not.toMatch(
      /has a proxy applied \(no backend wired\)/,
    );

    // DERIVED — the claim the comment block makes, checked rather than
    // trusted. `bootstrap-unwired-optional-deps-are-declared.test.ts` covers
    // the opposite direction (a dep bootstrap never passes); this is a dep
    // bootstrap DOES pass, that the consumer never invokes. If someone wires
    // the edge, this fails and the whole comment block above has to go.
    const SERVER_SRC = resolve(REPO_ROOT, 'apps/server/src');
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'migrations') walk(full);
        } else if (e.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8').replace(/\/\/[^\n]*/g, '');
          if (/\.applyToSession\(/.test(text)) callers.push(full.slice(REPO_ROOT.length + 1));
        }
      }
    };
    walk(SERVER_SRC);
    expect(
      callers,
      'applyToSession() now has a caller — the egress edge is wired, so delete the V-823 block in session-proxy.ts and the note in bootstrap.ts:',
    ).toEqual([]);
  });

  const body = read(LIB);

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("EG-API-1.2 module-level framing pinned: 'POST /v1/sessions/{id}/proxy + GET /v1/sessions/{id}/proxy. Planning 133 §\"Cross-agent split\" Agent 2 scope: POST /v1/sessions/{id}/proxy — set proxy config for a session + GET /v1/sessions/{id}/proxy — fetch current session's proxy config.' — pinned so the EG-API-1.2 anchor + planning-133-cross-agent-split + 2-verb-roster all stay documented", () => {
    expect(body).toMatch(
      /\/\/ EG-API-1\.2 — POST \/v1\/sessions\/\{id\}\/proxy \+ GET \/v1\/sessions\/\{id\}\/proxy\./,
    );
    expect(body).toMatch(
      /\/\/\s+- POST \/v1\/sessions\/\{id\}\/proxy — set proxy config for a session\s*\n?\s*\/\/\s+- GET\s+\/v1\/sessions\/\{id\}\/proxy — fetch current session's proxy config/,
    );
  });

  it('Activation-gate framing pinned — the 3 backend types, the 503-vs-404 split, and the machine-readable-signal contract. V-823 added the correction that follows it: BOTH registrars are stubs today, so the gate describes a distinction the code does not yet make', () => {
    expect(body).toMatch(
      /\/\/ Activation gate: routes register only when `sessionEgressService` is\s*\n?\s*\/\/ wired in AppDeps \(i\.e\., a concrete SOCKS5\/OpenVPN\/WireGuard backend\s*\n?\s*\/\/ is configured\)\. Otherwise `registerSessionProxyDisabledRoutes`\s*\n?\s*\/\/ registers 503 FeatureUnavailable stubs so the customer dashboard \+\s*\n?\s*\/\/ SDK clients get a machine-readable signal instead of bare 404\./,
    );
  });

  it("W495/W509 write:sessions gate pinned: POST /v1/sessions/:id/proxy carries app.requireScope('write:sessions') — granular, consistent with the sibling /v1/sessions/:id/* mutations (navigate/interact/capture). W495 wrongly used broad 'write' (a write:sessions CI key wouldn't satisfy it); W509 corrected to write:sessions.", () => {
    expect(body).toMatch(
      /'\/v1\/sessions\/:id\/proxy',[\s\S]*?\{ preHandler: \[app\.requireAuth, app\.requireScope\('write:sessions'\), app\.rateLimit\('global'\)\] \},/,
    );
  });

  it('GET and both disabled stubs preserve the matching granular scope boundary', () => {
    expect(body).toMatch(
      /app\.get<\{ Params: \{ id: string \} \}>\(\s*'\/v1\/sessions\/:id\/proxy',\s*\{ preHandler: \[app\.requireAuth, app\.requireScope\('read:sessions'\), app\.rateLimit\('global'\)\] \},/,
    );
    expect(body).toMatch(
      /app\.post\('\/v1\/sessions\/:id\/proxy', \{\s*preHandler: \[app\.requireAuth, app\.requireScope\('write:sessions'\), app\.rateLimit\('global'\)\],\s*handler: stub,/,
    );
    expect(body).toMatch(
      /app\.get\('\/v1\/sessions\/:id\/proxy', \{\s*preHandler: \[app\.requireAuth, app\.requireScope\('read:sessions'\), app\.rateLimit\('global'\)\],\s*handler: stub,/,
    );
  });

  it("Cross-agent contract body-shape framing pinned: '@driftstack/api-types/egress (EG-API-1.1)' + 3-field body shape (session_id matching URL :id + proxy + optional egress_safeguard defaulting safeguards-on). Drift to dropping the session_id-matches-URL check would let a body carry a different id than the URL and create an audit-log mismatch", () => {
    expect(body).toMatch(
      /\/\/ The route consumes the cross-agent contract schema from\s*\n?\s*\/\/ `@driftstack\/api-types\/egress` \(EG-API-1\.1\)\. Body shape:/,
    );
    expect(body).toMatch(/\/\/\s+"session_id": "ses_xxx",\s+\/\/ must match URL :id/);
    expect(body).toMatch(
      /\/\/\s+"egress_safeguard": \{ \.\.\. \}\s+\/\/ optional; defaults safeguards-on/,
    );
  });

  it("V-1005 CRITICAL the 4-layer secret protection is pinned as a REQUIREMENT for the unwired service edge, not as a description of what runs. The block used to say the service layer 'is responsible for' tmpfs, an AES-256-GCM envelope, hashing for the audit log and zeroing — and none of the four exists in services/proxy-backends/. That reads to an implementer as already done, which is how a pinned security claim outlives its implementation. The do-not-echo-body contract stays pinned on its own merits: nothing reaches a backend today, but a ValidationError quoting the body would put a SOCKS5 password or WireGuard private key into a client response and its log aggregators.", () => {
    expect(body).toMatch(
      /\/\/ SECURITY: proxy configs carry customer secrets \(SOCKS5 password,\s*\n?\s*\/\/ OpenVPN \.ovpn including embedded private keys, WireGuard private\s*\n?\s*\/\/ key\)\. When the service edge is wired, the service layer MUST provide:\s*\n?\s*\/\/\s+- Storing on tmpfs only for the session lifetime\s*\n?\s*\/\/\s+- AES-256-GCM at-rest envelope\s*\n?\s*\/\/\s+- Hashing the config for the audit log \(never raw\)\s*\n?\s*\/\/\s+- Zeroing on session-end/,
    );
    // The retracted wording, paraphrased in the negative so it cannot return:
    // the block must not present those four as something the service layer
    // already does, nor claim this route dispatches anywhere.
    expect(body).not.toMatch(/The service layer is responsible for:/);
    expect(body).not.toMatch(/dispatches to the\s*\n?\s*\/\/ service/);
    expect(body).toMatch(/Do NOT echo body fields in error responses/);
  });

  it("Body-session_id-must-match-URL-id BadRequestError framing pinned: 'Body session_id must match the URL :id (cross-cutting body/URL mismatch).' + parsed.data.session_id !== id branch. Drift to dropping this check would let body+URL diverge and create audit-log mismatches between the URL'd session id and the proxy applied", () => {
    expect(body).toMatch(
      /if \(parsed\.data\.session_id !== id\) \{\s*\n?\s*throw new BadRequestError\(\s*\n?\s*'Body session_id must match the URL :id \(cross-cutting body\/URL mismatch\)\.',\s*\n?\s*\);/,
    );
  });

  it('POST FeatureUnavailable detail states current availability and default-egress impact without internal identifiers', () => {
    expect(body).toMatch(
      /'Customer-configurable egress \(SOCKS5 \/ OpenVPN \/ WireGuard\) is unavailable on this deployment\. ' \+\s*\n?\s*"Sessions continue through Driftstack's default egress\."/,
    );
    const detailStart = body.indexOf('throw new FeatureUnavailableError');
    expect(detailStart).toBeGreaterThan(-1);
    const detailEnd = body.indexOf(');', detailStart);
    expect(detailEnd).toBeGreaterThan(detailStart);
    const handlerDetail = body.slice(detailStart, detailEnd + 2);
    expect(handlerDetail).not.toMatch(/EG-API-1\.2|EG-API-1\.6|planning 133|not yet|roadmap/);
  });

  it('GET 404-no-proxy-config framing pinned — config_hash-only, never-raw-config, and the reason for the 404. V-823 corrected that reason: it blamed an unwired backend, and one is wired; nothing can have a proxy applied because POST never reaches the service', () => {
    expect(body).toMatch(
      /\/\/ EG-API-1\.6 backs this with a real read from session-egress\s*\n?\s*\/\/ state \(config_hash \+ type \+ safeguard flags only — never raw\s*\n?\s*\/\/ config\)\. For now the route surfaces 404 because no session can\s*\n?\s*\/\/ have a proxy applied: POST above never reaches the backend, so\s*\n?\s*\/\/ nothing ever writes the state this would read/,
    );
    expect(body).toMatch(/throw new NotFoundError\('No proxy config for this session\.'\);/);
  });

  it('Disabled-stub customer-facing detail stays current-state-only', () => {
    expect(body).toMatch(
      /const detail =\s*\n?\s*'Customer-configurable egress \(SOCKS5 \/ OpenVPN \/ WireGuard\) is unavailable on this deployment\. ' \+\s*\n?\s*"Sessions continue through Driftstack's default egress\.";/,
    );
  });

  it("Schema re-export framing pinned: 'Re-export the ProxyConfigSchema for testability — consumers that want to validate a proxy body without the SessionEgressConfig envelope can use this directly. Marked here rather than in egress.ts because the schema's location is API-package, not route-package.' + export { ProxyConfigSchema } — pinned so the route-package-re-export-for-testability + schema-lives-in-api-package contract stays documented", () => {
    expect(body).toMatch(
      /\/\/ Re-export the ProxyConfigSchema for testability — consumers that\s*\n?\s*\/\/ want to validate a proxy body without the SessionEgressConfig\s*\n?\s*\/\/ envelope can use this directly\. Marked here rather than in egress\.ts\s*\n?\s*\/\/ because the schema's location is API-package, not route-package\./,
    );
    expect(body).toMatch(/export \{ ProxyConfigSchema \};/);
  });

  it('V-1005 CRITICAL each of the four secret-protection mechanisms is EITHER implemented in services/proxy-backends/ OR still written as a requirement. This is the check the sweep asked for and nobody built: the block names tmpfs, an AES-256-GCM envelope, audit-log hashing and zeroing, and that directory holds one file with none of them. A pin over prose cannot tell a shipped protection from a promised one, which is how the claim outlived its implementation for months — so the wording is tied to the code here. When a mechanism lands, this arm goes green on the other branch and the MUST-provide framing can become a description again.', () => {
    const backendsDir = resolve(REPO_ROOT, 'apps/server/src/services/proxy-backends');
    const backendSrc = readdirSync(backendsDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(resolve(backendsDir, f), 'utf8'))
      .join('\n');
    expect(
      backendSrc.length,
      'the proxy-backends directory read as empty — the walk, not the code',
    ).toBeGreaterThan(200);

    const mechanisms: ReadonlyArray<readonly [string, RegExp]> = [
      ['tmpfs storage', /tmpfs/i],
      ['AES-256-GCM envelope', /aes-256-gcm/i],
      ['audit-log hashing', /createHash|sha256/i],
      ['zeroing on session-end', /\.fill\(0\)|zeroiz|zeroing/i],
    ];
    const implemented = mechanisms.filter(([, re]) => re.test(backendSrc)).map(([n]) => n);

    if (implemented.length === 0) {
      // Nothing is implemented, so the comment must not describe them as current.
      expect(body, 'no mechanism is implemented, so the block must read as a requirement').toMatch(
        /the service layer MUST provide/,
      );
      expect(body).not.toMatch(/The service layer is responsible for:/);
    } else {
      // Something landed — say so rather than leaving the requirement framing to rot.
      expect(
        implemented,
        'a mechanism is now implemented in proxy-backends/; update the SECURITY block to describe ' +
          'what ships and narrow the MUST-provide list to what is still outstanding',
      ).toEqual([]);
    }
  });

  it('CRITICAL the spec prose and the handler agree about WHEN the 503 happens. V-1047: the openapi comment said a 503 is what deployments without a compatible backend return — which reads as "it works where one exists" — while the handler throws unconditionally and says so, including when a backend IS present. The published spec still advertises a 200 for this path, so an SDK generated from it carries a success shape no caller can reach; that is the intended contract rather than a lie, but only while the prose says which of the two a reader is looking at.', () => {
    const route = read('apps/server/src/routes/session-proxy.ts');
    const spec = read('apps/server/src/lib/openapi.ts');

    // The handler throws with no condition on backend presence. If a wiring
    // change makes the throw conditional, this fails and the paragraph below it
    // has to be rewritten in the same commit.
    expect(route, 'the proxy route no longer throws FeatureUnavailableError').toMatch(
      /throw new FeatureUnavailableError\(/,
    );
    expect(
      route,
      'the route now guards the throw on a backend being present — the spec prose describes an ' +
        'unconditional throw and must be updated with it',
    ).toMatch(/throws[\s\S]{0,24}unconditionally/);

    // The retracted framing must not come back.
    expect(
      spec,
      'the spec comment again implies the 503 is limited to deployments without a backend',
    ).not.toMatch(/Deployments without a compatible backend return FeatureUnavailable/);
    expect(spec, 'the spec no longer records that the throw is unconditional').toMatch(
      /throws FeatureUnavailable[\s\S]{0,24}unconditionally/,
    );
  });
});
