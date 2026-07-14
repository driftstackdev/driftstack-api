import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const page = readFileSync(resolve(ROOT, 'src/pages/oauth/authorize.astro'), 'utf8');
const helper = readFileSync(resolve(ROOT, 'src/lib/oauth-provider-consent.ts'), 'utf8');

describe('Customer Dashboard OAuth provider consent page', () => {
  it('ships a canonical human consent surface with explicit states and no sidebar', () => {
    expect(page).toMatch(/<DashboardLayout title="Authorize integration" withSidebar=\{false\}>/);
    expect(page).toContain('data-page="oauth-provider-consent"');
    for (const state of ['loading', 'missing', 'needs-signin', 'consent', 'error']) {
      expect(page).toContain(`data-state="${state}"`);
    }
    expect(page).toContain('data-approve');
    expect(page).toContain('data-cancel');
    expect(page).toContain('Approve only if you recognize this app');
  });

  it('captures one bounded S256 request and rejects duplicate parameter pollution', () => {
    expect(helper).toMatch(/function one\(params: URLSearchParams, name: string\)/);
    expect(helper).toMatch(/const values = params\.getAll\(name\);/);
    expect(helper).toMatch(/return values\.length === 1/);
    expect(helper).toContain("method !== 'S256'");
    expect(helper).toMatch(/redirectUri\.length > LIMITS\.redirectUri/);
    expect(helper).toMatch(/scopeValues\.length > 1/);
    expect(page).toMatch(/captureOAuthAuthorizeRequest\(window\.location\.search\)/);
  });

  it('uses storage-safe same-origin sign-in resumption before staging consent', () => {
    expect(page).toMatch(
      /window\.localStorage\.getItem\('ds_web_session_token'\) \?\? null;\s*\n\s*\} catch \{\s*\n\s*return null;/,
    );
    expect(page).toMatch(
      /const resumePath = `\$\{window\.location\.pathname\}\$\{window\.location\.search\}`;/,
    );
    expect(page).toMatch(/`\/login\/\?next=\$\{next\}`/);
    expect(page).toMatch(/`\/signup\/\?next=\$\{next\}`/);
    expect(page.indexOf('if (sessionToken === null)')).toBeLessThan(
      page.indexOf('`${apiBaseUrl}/v1/oauth/authorize?${captured.query}`'),
    );
  });

  it('stages through the public API, binds output to the request, and scrubs the query', () => {
    expect(page).toContain('`${apiBaseUrl}/v1/oauth/authorize?${captured.query}`');
    expect(page).toMatch(/parseOAuthStageResult\(body, captured\)/);
    expect(helper).toMatch(/client\?\.client_id !== request\.clientId/);
    expect(helper).toMatch(/body\.redirect_uri !== request\.redirectUri/);
    expect(helper).toMatch(/body\.state !== request\.state/);
    expect(page).toMatch(/window\.history\.replaceState\(null, '', window\.location\.pathname\);/);
  });

  it('renders untrusted app/scope fields as text and never reflects raw errors', () => {
    expect(page).toMatch(/label\.textContent = result\.clientLabel/);
    expect(page).toMatch(/host\.textContent = oauthCallbackHost\(result\.redirectUri\)/);
    expect(page).toMatch(/code\.textContent = scope/);
    expect(page).toMatch(/list\?\.replaceChildren\(\)/);
    expect(page).not.toContain('.innerHTML');
    expect(page).not.toMatch(/\.detail\b|error\.message|err\.message/);
  });

  it('bounds network and response bodies, clears timers, and aborts on page exit', () => {
    expect(page).toMatch(/window\.setTimeout\(\(\) => controller\.abort\(\), 15_000\)/);
    expect(page).toMatch(/window\.clearTimeout\(timeout\)/);
    expect(page.match(/await readBoundedJson\(response\)/g)).toHaveLength(2);
    expect(helper).toMatch(/response: 64 \* 1024/);
    expect(helper).toMatch(/if \(total > LIMITS\.response\)/);
    expect(page).toMatch(/window\.addEventListener\('pagehide'/);
  });

  it('allows one authenticated approval and uses URL/searchParams for both callback outcomes', () => {
    expect(page).toMatch(
      /if \(actionInFlight \|\| stage === null \|\| sessionToken === null\) return;/,
    );
    expect(page).toContain('`${apiBaseUrl}/v1/oauth/authorize/complete`');
    expect(page).toMatch(/authorization: `Bearer \$\{sessionToken\}`/);
    expect(page).toMatch(/JSON\.stringify\(\{ authorization_id: stage\.authorizationId \}\)/);
    expect(page).toMatch(/parseOAuthApprovalCode\(body, stage\)/);
    expect(page.match(/window\.location\.assign\(destination\)/g)).toHaveLength(2);
    expect(helper).toMatch(/const url = new URL\(redirectUri\)/);
    expect(helper).toMatch(/url\.searchParams\.set\('code', result\.code\)/);
    expect(helper).toMatch(/url\.searchParams\.set\('error', result\.error\)/);
    expect(helper).toMatch(/url\.searchParams\.set\('state', state\)/);
  });
});
