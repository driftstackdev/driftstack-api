// W1038 — routes/account-web-sessions V-355 cross-source invariant.
// Three-hundred-sixty-fourth in the drift-guard series. Pins the
// apps/server/src/routes/account-web-sessions.ts customer web-session
// list + revoke routes:
//
//   V-355 anchor — 'V-355 — customer-facing web-session list + revoke
//   endpoints'.
//
//   3-endpoint inventory:
//     - GET /v1/account/web-sessions — list active.
//     - DELETE /v1/account/web-sessions/:id — revoke one.
//     - DELETE /v1/account/web-sessions?keep=current — bulk revoke
//       except current.
//
//   Distinction framing — 'Distinct from /v1/sessions (driver
//   sessions running browsers in the fleet) — these are the
//   customer's own dashboard sign-ins'.
//
//   Privacy framing — 'IP and user-agent are surfaced as broad
//   bucket strings rather than the raw values: /settings already
//   comments IP omitted from dashboard for privacy, and the user-
//   agent string is fingerprintable enough that we reduce it to
//   "macOS · Safari" before render'.
//
//   bucketUserAgent — 5-OS ladder (macOS / Windows / Android /
//     iOS / Linux) + 5-browser ladder (Edge / Opera / Firefox /
//     Chrome / Safari) with 'Unknown' default and Safari-last
//     ordering note.
//
//   currentWebSessionIdFromRequest — strips 'wsk_' prefix from
//     ctx.apiKey.id; returns null on non-web-session callers (real
//     API keys have a different prefix).
//
//   uuidFromPublicSessionId — strips 'wsess_' prefix + validates
//     UUID shape /^[0-9a-fA-F-]{36}$/; BadRequestError on miss.
//
//   publicSession 6-field — id (wsess_) + os + browser + last_used_at
//     (ISO) + expires_at (ISO) + current (boolean).
//
//   Bulk revoke ?keep=current required + 'Bulk revoke requires
//     `?keep=current`. Pass it explicitly to confirm intent.' error
//     on missing + 'Bulk revoke is only callable from a dashboard
//     web session.' on non-web-session caller.
//
// stays in lockstep across apps/server/src/routes/account-web-sessions.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bucketUserAgent } from '../../src/routes/account-web-sessions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1038 routes/account-web-sessions V-355 cross-source invariant', () => {
  it('CRITICAL V-355 anchor + 3-endpoint inventory + distinction-from-driver-sessions framing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    expect(p).toMatch(/V-355 — customer-facing web-session list \+ revoke endpoints\./);
    expect(p).toMatch(/\/v1\/account\/web-sessions\s+GET\s+— list the calling account's active/);
    expect(p).toMatch(/\/v1\/account\/web-sessions\/:id DELETE — revoke a specific session\./);
    expect(p).toMatch(/\/v1\/account\/web-sessions\s+DELETE\s+— `\?keep=current` revokes every/);
    expect(p).toMatch(/session EXCEPT the one the caller/);
    expect(p).toMatch(/Distinct from \/v1\/sessions \(driver sessions running browsers in the/);
    expect(p).toMatch(/fleet\) — these are the customer's own dashboard sign-ins\./);
  });

  it("CRITICAL privacy framing — 'IP and user-agent are surfaced as broad bucket strings rather than the raw values: /settings already comments IP omitted from dashboard for privacy, and the user-agent string is fingerprintable enough that we reduce it to macOS · Safari before render'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    expect(p).toMatch(
      /\/\/ IP and user-agent are surfaced as broad bucket strings rather than the/,
    );
    expect(p).toMatch(
      /\/\/ raw values: \/settings already comments "IP omitted from dashboard for/,
    );
    expect(p).toMatch(/\/\/ privacy", and the user-agent string is fingerprintable enough that we/);
    expect(p).toMatch(/\/\/ reduce it to "macOS · Safari" before render\./);
  });

  it('CRITICAL bucketUserAgent 5-OS ladder — macOS + Windows + Android + iOS + Linux.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    expect(p).toMatch(/if \(\/Mac OS X\|macOS\/i\.test\(ua\)\) os = 'macOS';/);
    expect(p).toMatch(/else if \(\/Windows\/i\.test\(ua\)\) os = 'Windows';/);
    expect(p).toMatch(/else if \(\/Android\/i\.test\(ua\)\) os = 'Android';/);
    expect(p).toMatch(/else if \(\/iPhone\|iPad\|iOS\/i\.test\(ua\)\) os = 'iOS';/);
    expect(p).toMatch(/else if \(\/Linux\/i\.test\(ua\)\) os = 'Linux';/);
  });

  it("CRITICAL bucketUserAgent 5-browser ladder — Edge → Opera → Firefox → Chrome → Safari with framing 'Order matters: Edg / OPR / Chrome / Safari (Safari signature is in every WebKit UA so it has to be checked LAST)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    expect(p).toMatch(
      /\/\/ Order matters: Edg \/ OPR \/ Chrome \/ Safari \(Safari signature is in/,
    );
    expect(p).toMatch(/\/\/ every WebKit UA so it has to be checked LAST\)\./);
    expect(p).toMatch(/if \(\/Edg\\\/\/i\.test\(ua\)\) browser = 'Edge';/);
    expect(p).toMatch(/else if \(\/OPR\\\/\/i\.test\(ua\)\) browser = 'Opera';/);
    expect(p).toMatch(/else if \(\/Firefox\\\/\/i\.test\(ua\)\) browser = 'Firefox';/);
    expect(p).toMatch(/else if \(\/Chrome\\\/\/i\.test\(ua\)\) browser = 'Chrome';/);
    expect(p).toMatch(/else if \(\/Safari\\\/\/i\.test\(ua\)\) browser = 'Safari';/);
  });

  it("CRITICAL bucketUserAgent default 'Unknown · Unknown' on null/miss framing — 'Returns Unknown · Unknown on miss rather than empty so the row always renders something'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    expect(p).toMatch(/Returns "Unknown · Unknown" on miss/);
    expect(p).toMatch(/rather than "" so the row always renders something\./);
    expect(p).toMatch(/if \(!ua\) return \{ os: 'Unknown', browser: 'Unknown' \};/);
  });

  it("CRITICAL currentWebSessionIdFromRequest — strips 'wsk_' prefix; returns null on non-web-session callers (real API keys have different prefix).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    expect(p).toMatch(/V-355 — extract the calling web session's id from the AccountContext\./);
    expect(p).toMatch(/auth path stamps the synthetic ApiKeyRow's id as `wsk_<uuid>` for/);
    expect(p).toMatch(/web sessions; non-web-session callers \(a real API key\) have a/);
    expect(p).toMatch(/different prefix and return null here\./);
    expect(p).toMatch(/if \(typeof id !== 'string' \|\| !id\.startsWith\('wsk_'\)\) return null;/);
    expect(p).toMatch(/return id\.slice\('wsk_'\.length\);/);
  });

  it("CRITICAL uuidFromPublicSessionId — strips 'wsess_' prefix + STRICT UUID-shape regex + BadRequestError 'Invalid session id.' on miss.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    expect(p).toMatch(/if \(!input\.startsWith\('wsess_'\)\) \{/);
    expect(p).toMatch(/throw new BadRequestError\('Invalid session id\.'\);/);
    expect(p).toMatch(/const id = input\.slice\('wsess_'\.length\);/);
    // Strict UUID shape. The old `[0-9a-fA-F-]{36}` accepted 36 hex-or-dash characters in any arrangement and passed them to a Postgres uuid column, so a malformed customer id 500'd instead of 400ing.
    expect(p).toMatch(
      /if \(!\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/i\.test\(id\)\) \{/,
    );
  });

  it('CRITICAL publicSession 6-field — id (wsess_ prefix) + os + browser + last_used_at (ISO) + expires_at (ISO) + current boolean.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    expect(p).toMatch(/id: `wsess_\$\{row\.id\}`,/);
    expect(p).toMatch(/os: ua\.os,/);
    expect(p).toMatch(/browser: ua\.browser,/);
    expect(p).toMatch(/last_used_at: row\.lastUsedAt\.toISOString\(\),/);
    expect(p).toMatch(/expires_at: row\.expiresAt\.toISOString\(\),/);
    expect(p).toMatch(/current: row\.id === currentId,/);
  });

  it("CRITICAL bulk revoke ?keep=current required + 'Bulk revoke requires `?keep=current`. Pass it explicitly to confirm intent.' + 'Bulk revoke is only callable from a dashboard web session.' on non-web-session caller.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    // V-1368 — via the querystring schema now; a repeated ?keep used to reach
    // .toLowerCase() as an array and answer 500 instead of this gate's 400.
    expect(p).toMatch(/const keep = \(query\.data\.keep \?\? ''\)\.toLowerCase\(\);/);
    expect(p).toMatch(/if \(keep !== 'current'\) \{/);
    expect(p).toMatch(/throw new BadRequestError\(/);
    expect(p).toMatch(
      /'Bulk revoke requires `\?keep=current`\. Pass it explicitly to confirm intent\.',/,
    );
    expect(p).toMatch(/\/\/ Non-web-session caller can't bulk revoke \+ keep current —/);
    expect(p).toMatch(/\/\/ there is no "current" to keep\. Refuse rather than guess\./);
    expect(p).toMatch(
      /throw new BadRequestError\('Bulk revoke is only callable from a dashboard web session\.'\);/,
    );
  });

  it("CRITICAL single-revoke 204 success + 'Session not found.' 404 on missing.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    expect(p).toMatch(
      /const ok = await service\.revokeWebSessionForAccount\(ctx\.account\.id, sessionId\);/,
    );
    expect(p).toMatch(/if \(!ok\) throw new NotFoundError\('Session not found\.'\);/);
    expect(p).toMatch(/reply\.code\(204\);/);
  });

  it('CRITICAL bulk revoke returns { revoked: n } 200.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-web-sessions.ts'));
    expect(p).toMatch(
      /const n = await service\.revokeAllWebSessionsExceptCurrent\(ctx\.account\.id, currentId\);/,
    );
    expect(p).toMatch(/return \{ revoked: n \};/);
  });

  // Runtime checks for bucketUserAgent.
  it('CRITICAL runtime bucketUserAgent — null → Unknown/Unknown; Mac+Safari UA → macOS/Safari; Windows+Chrome UA → Windows/Chrome.', () => {
    expect(bucketUserAgent(null)).toEqual({ os: 'Unknown', browser: 'Unknown' });
    expect(
      bucketUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      ),
    ).toEqual({ os: 'macOS', browser: 'Safari' });
    expect(
      bucketUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      ),
    ).toEqual({ os: 'Windows', browser: 'Chrome' });
  });

  it("CRITICAL runtime bucketUserAgent Safari-last ordering — Chrome UA contains 'Safari/' but resolves to Chrome (not Safari).", () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    expect(bucketUserAgent(ua).browser).toBe('Chrome');
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-account-web-sessions-v355-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
