// Billing is the web dashboard's job, and the desktop app must not grow a
// second copy of it.
//
// Two surfaces owning billing is how one account reads a different answer
// depending on where the customer looks, and it duplicated the PAYMENT path:
// a checkout started in the app and one started on the web mint two
// independent orders against a single account. Removing the in-app hub is
// only durable if something fails when it comes back, so this pins both
// halves — the hub is gone, and the destination still leads somewhere.
//
// Safe to remove because the web dashboard is a strict SUPERSET, not a
// substitute: /v1/billing/checkout-session, /v1/billing/portal-session,
// /v1/billing/crypto-checkout and /v1/billing/crypto-orders are all wired in
// apps/customer-dashboard. Nothing the app offered went missing.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BillingMovedView } from '../../src/views/BillingMovedView';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI_SRC = resolve(HERE, '..', '..', 'src');
const app = readFileSync(resolve(GUI_SRC, 'App.tsx'), 'utf8');

describe('billing lives on the web dashboard only', () => {
  it('the desktop billing hub and its checkout flow are GONE, not merely unrouted', () => {
    // Unrouting alone leaves the code one import away from returning, and
    // leaves a second payment path in the bundle.
    expect(existsSync(resolve(GUI_SRC, 'views/BillingView.tsx'))).toBe(false);
    expect(existsSync(resolve(GUI_SRC, 'views/CryptoCheckoutFlowView.tsx'))).toBe(false);
    expect(app).not.toMatch(/BillingView\b/);
    expect(app).not.toMatch(/CryptoCheckoutFlowView/);
  });

  it('the billing destination still resolves, so the customer is redirected rather than stranded', () => {
    // Deleting the destination outright would be the other failure mode:
    // a customer looking for billing finds nothing and no explanation.
    expect(app).toMatch(/case 'billing':/);
    expect(app).toMatch(/BillingMovedView/);
  });

  it('names the web dashboard as the one place that owns billing', () => {
    render(<BillingMovedView />);
    const link = screen.getByRole('link', { name: /open billing in the browser/i });
    expect(link).toHaveAttribute('href', 'https://app.driftstack.dev/billing/');
    // External navigation out of a Tauri webview must not hand the opened page
    // a live `window.opener` back into the app shell.
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link).toHaveAttribute('target', '_blank');
  });
});
