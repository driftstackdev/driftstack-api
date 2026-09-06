import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${relativePath}`, import.meta.url)), 'utf8');

describe('customer-facing node diagnostic boundary', () => {
  it('sanitizes every free-form agent-session operation failure', () => {
    const source = readSource('routes/agent-sessions.ts');

    // 7 since P-17's egress swap. This counts SANITIZED sites, so it moving with a
    // new relay route is the pass condition — a route that returned a raw node
    // message would leave this number where it was while the route count grew.
    // 5 since N-COOKIE-ERROR-CONTRACT: the two COOKIE sites no longer forward
    // device text at all. They derive the customer sentence from a closed token
    // set, so there is nothing left to sanitise — a stronger guarantee than
    // redaction, and the reason this count went DOWN rather than up.
    // ⛔ It must never go down for any other reason: a site dropping this call
    // while still forwarding `outcome.message` is exactly the leak this guards.
    expect(source.match(/reason: customerSafeNodeDiagnostic\(outcome\.message\)/g)).toHaveLength(5);
    // The cookie routes now derive copy instead, and that must stay true.
    expect(source.match(/reason:\s*token === null/g) ?? []).toHaveLength(2);
    expect(source).not.toContain('reason: outcome.message');
  });

  it('sanitizes the free-form profile-trim failure', () => {
    const source = readSource('routes/profiles.ts');

    expect(source.match(/reason: customerSafeNodeDiagnostic\(outcome\.message\)/g)).toHaveLength(1);
    expect(source).not.toContain('reason: outcome.message');
  });

  it.each([
    'services/challenge-relay.ts',
    'services/profile-save-failed-relay.ts',
    'services/session-error-event-relay.ts',
    'services/session-page-state-store.ts',
  ])('sanitizes node diagnostics in %s', (relativePath) => {
    expect(readSource(relativePath)).toContain('customerSafeNodeDiagnostic');
  });
});
