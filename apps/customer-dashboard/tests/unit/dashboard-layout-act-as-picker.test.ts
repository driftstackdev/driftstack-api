// W334.C — drift guard for DashboardLayout act-as picker. The
// layout drives team-RBAC act-as: a member acting on a team owner's
// account selects via the picker, the choice persists in
// localStorage `ds_act_as_account`, and downstream fetches add
// the canonical `X-Driftstack-Account` header.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const body = read(LAYOUT);
const OWNER = 'acc_11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = 'acc_22222222-2222-4222-8222-222222222222';

function scriptWithAttribute(attribute: string): string {
  const match = body.match(new RegExp(`<script[^>]*${attribute}[^>]*>([\\s\\S]*?)<\\/script>`));
  if (!match?.[1]) throw new Error(`script with ${attribute} not found`);
  return match[1];
}

function scriptContaining(needle: string): string {
  for (const match of body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    if (match[1]?.includes(needle)) return match[1];
  }
  throw new Error(`script containing ${needle} not found`);
}

const PREFLIGHT_SCRIPT = scriptWithAttribute('data-act-as-header-preflight');
const HYDRATION_SCRIPT = scriptContaining('asynchronous "Acting as" picker + authority hydration');

type ActAsHeaders = () => Record<string, string>;
type AuthorityResponse =
  | { kind: 'body'; body: unknown }
  | { kind: 'http-error'; status: number }
  | { kind: 'json-error' }
  | { kind: 'transport-error' };

type TestWindow = JSDOM['window'] & {
  driftstackActAsHeaders: ActAsHeaders;
  driftstackFetchWithDeadline: (
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ) => Promise<{
    status: number;
    ok: boolean;
    json: () => Promise<unknown>;
  }>;
};

interface SetupOptions {
  storedOwner?: string;
  authority?: AuthorityResponse;
}

function team(owner: string, role: 'admin' | 'member'): Record<string, unknown> {
  return {
    owner_account_id: owner,
    owner_name: role === 'admin' ? 'Admin workspace' : 'Member workspace',
    owner_email: `${role}@example.test`,
    owner_slug: null,
    role,
  };
}

function setup(options: SetupOptions = {}): {
  window: TestWindow;
  capturedBeforeHydration: Record<string, string>;
  requests: Array<{ url: string; init: RequestInit; timeoutMs: number }>;
  navigationAttempts: () => number;
} {
  let navigationAttemptCount = 0;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => {
    if (/Not implemented: navigation/.test(error.message)) navigationAttemptCount += 1;
  });
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main id="main-content">
        <div data-act-as-banner class="hidden">
          Acting as <span data-act-as-owner>—</span>.
          <span data-act-as-access></span>
          <button type="button" data-act-as-clear>Switch back to self</button>
        </div>
        <div data-act-as-picker-wrap data-act-as-picker-wrap-reserved class="hidden">
          <select data-act-as-picker></select>
        </div>
      </main>
    </body></html>`,
    {
      url: 'https://app.driftstack.io/billing/',
      runScripts: 'outside-only',
      virtualConsole,
    },
  );
  const window = dom.window as TestWindow;
  window.localStorage.setItem('ds_web_session_token', 'web_session_test');
  if (options.storedOwner !== undefined) {
    window.localStorage.setItem('ds_act_as_account', options.storedOwner);
  }

  window.eval(PREFLIGHT_SCRIPT);
  // Representative slotted page capture. This deliberately happens before
  // body-end picker hydration, matching the source parse order.
  const capturedBeforeHydration = window.driftstackActAsHeaders();

  const requests: Array<{ url: string; init: RequestInit; timeoutMs: number }> = [];
  const authority = options.authority ?? {
    kind: 'body',
    body: { id: 'acc_self', email: 'self@example.test', teams: [] },
  };
  window.driftstackFetchWithDeadline = async (url, init, timeoutMs) => {
    requests.push({ url, init, timeoutMs });
    if (authority.kind === 'transport-error') throw new Error('offline');
    if (authority.kind === 'http-error') {
      return {
        status: authority.status,
        ok: false,
        json: async () => ({}),
      };
    }
    if (authority.kind === 'json-error') {
      return {
        status: 200,
        ok: true,
        json: async () => Promise.reject(new Error('invalid json')),
      };
    }
    return {
      status: 200,
      ok: true,
      json: async () => authority.body,
    };
  };
  window.eval(`var apiBaseUrl = 'https://api.driftstack.dev';\n${HYDRATION_SCRIPT}`);
  return {
    window,
    capturedBeforeHydration,
    requests,
    navigationAttempts: () => navigationAttemptCount,
  };
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('W334.C DashboardLayout act-as picker baseline', () => {
  let openWindow: TestWindow | null = null;

  afterEach(() => {
    openWindow?.close();
    openWindow = null;
  });

  it('renders an act-as picker control', () => {
    expect(body).toMatch(/data-act-as-picker/);
  });

  it('renders an act-as banner when acting as a different account', () => {
    expect(body).toMatch(/data-act-as-banner/);
  });

  it('persists the choice in localStorage key ds_act_as_account', () => {
    expect(body).toContain('ds_act_as_account');
  });

  it('installs the canonical stored-owner helper before <slot /> and the first slotted request captures it', () => {
    expect(body.indexOf('data-act-as-header-preflight')).toBeGreaterThan(-1);
    expect(body.indexOf('data-act-as-header-preflight')).toBeLessThan(body.indexOf('<slot />'));
    const result = setup({
      storedOwner: OWNER,
      authority: {
        kind: 'body',
        body: { id: 'acc_self', email: 'self@example.test', teams: [team(OWNER, 'admin')] },
      },
    });
    openWindow = result.window;
    expect(result.capturedBeforeHydration).toEqual({ 'x-driftstack-account': OWNER });
  });

  it.each([
    ['admin', "Admin access: read + write this team's resources."],
    ['member', "Member access: read-only for this team's resources."],
  ] as const)('locks a valid %s owner and renders exact role truth', async (role, copy) => {
    const result = setup({
      storedOwner: OWNER,
      authority: {
        kind: 'body',
        body: { id: 'acc_self', email: 'self@example.test', teams: [team(OWNER, role)] },
      },
    });
    openWindow = result.window;
    await flush();

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]?.url).toBe('https://api.driftstack.dev/v1/account/me');
    expect(result.requests[0]?.init.headers).toEqual({ authorization: 'Bearer web_session_test' });
    expect(result.window.driftstackActAsHeaders()).toEqual({
      'x-driftstack-account': OWNER,
    });
    expect(result.window.localStorage.getItem('ds_act_as_account')).toBe(OWNER);
    expect(result.window.document.querySelector('[data-act-as-access]')?.textContent?.trim()).toBe(
      copy,
    );
    expect(
      result.window.document
        .querySelector('[data-act-as-banner]')
        ?.getAttribute('data-act-as-role'),
    ).toBe(role);
    expect(result.window.document.querySelector('#main-content')?.hasAttribute('inert')).toBe(
      false,
    );

    // A forced post-validation owner swap cannot change this page's header.
    result.window.localStorage.setItem('ds_act_as_account', OTHER_OWNER);
    expect(result.window.driftstackActAsHeaders()).toEqual({
      'x-driftstack-account': OWNER,
    });
  });

  it.each([
    ['zero teams', { id: 'acc_self', email: 'self@example.test', teams: [] }],
    [
      'removed owner',
      { id: 'acc_self', email: 'self@example.test', teams: [team(OTHER_OWNER, 'admin')] },
    ],
    [
      'duplicate active owner',
      {
        id: 'acc_self',
        email: 'self@example.test',
        teams: [team(OWNER, 'admin'), { ...team(OWNER, 'admin'), role: 'owner' }],
      },
    ],
    [
      'malformed active role',
      {
        id: 'acc_self',
        email: 'self@example.test',
        teams: [{ ...team(OWNER, 'admin'), role: 'owner' }],
      },
    ],
    ['malformed teams envelope', { id: 'acc_self', email: 'self@example.test', teams: null }],
  ])(
    'clears, locks, and reloads a provisionally captured owner for %s',
    async (_name, authorityBody) => {
      const result = setup({
        storedOwner: OWNER,
        authority: { kind: 'body', body: authorityBody },
      });
      openWindow = result.window;
      expect(result.capturedBeforeHydration).toEqual({ 'x-driftstack-account': OWNER });
      await flush();

      expect(result.window.localStorage.getItem('ds_act_as_account')).toBeNull();
      expect(result.window.driftstackActAsHeaders()).toEqual({});
      expect(result.window.document.querySelector('#main-content')?.hasAttribute('inert')).toBe(
        true,
      );
      expect(result.window.document.querySelector('#main-content')?.getAttribute('aria-busy')).toBe(
        'true',
      );
      expect(result.navigationAttempts()).toBe(1);

      // Even a forced stale-owner write after authoritative rejection is inert.
      result.window.localStorage.setItem('ds_act_as_account', OWNER);
      expect(result.window.driftstackActAsHeaders()).toEqual({});
    },
  );

  it('treats an accepted response with unreadable JSON as malformed authority', async () => {
    const result = setup({ storedOwner: OWNER, authority: { kind: 'json-error' } });
    openWindow = result.window;
    await flush();

    expect(result.window.localStorage.getItem('ds_act_as_account')).toBeNull();
    expect(result.window.driftstackActAsHeaders()).toEqual({});
    expect(result.window.document.querySelector('#main-content')?.hasAttribute('inert')).toBe(true);
    expect(result.navigationAttempts()).toBe(1);
  });

  it.each([
    ['transport rejection', { kind: 'transport-error' }],
    ['non-auth HTTP failure', { kind: 'http-error', status: 503 }],
  ] as const)(
    'retains one provisional owner but publishes unverified read-only copy on %s',
    async (_name, authority) => {
      const result = setup({ storedOwner: OWNER, authority });
      openWindow = result.window;
      await flush();

      expect(result.window.localStorage.getItem('ds_act_as_account')).toBe(OWNER);
      expect(result.window.driftstackActAsHeaders()).toEqual({
        'x-driftstack-account': OWNER,
      });
      expect(result.window.document.querySelector('[data-act-as-access]')?.textContent).toMatch(
        /could not be verified.*read-only/i,
      );
      expect(result.window.document.querySelector('#main-content')?.hasAttribute('inert')).toBe(
        false,
      );
      expect(result.navigationAttempts()).toBe(0);
      result.window.localStorage.setItem('ds_act_as_account', OTHER_OWNER);
      expect(result.window.driftstackActAsHeaders()).toEqual({
        'x-driftstack-account': OWNER,
      });
    },
  );

  it('drops a malformed stored owner before a slotted page can capture it', async () => {
    const result = setup({
      storedOwner: 'acc_not-a-uuid',
      authority: {
        kind: 'body',
        body: { id: 'acc_self', email: 'self@example.test', teams: [team(OWNER, 'admin')] },
      },
    });
    openWindow = result.window;
    expect(result.capturedBeforeHydration).toEqual({});
    expect(result.window.localStorage.getItem('ds_act_as_account')).toBeNull();
    await flush();

    result.window.localStorage.setItem('ds_act_as_account', OWNER);
    expect(result.window.driftstackActAsHeaders()).toEqual({});
  });

  it('persists a picker change and immediately requests the existing reload boundary', async () => {
    const result = setup({
      storedOwner: OWNER,
      authority: {
        kind: 'body',
        body: {
          id: 'acc_self',
          email: 'self@example.test',
          teams: [team(OWNER, 'admin'), team(OTHER_OWNER, 'member')],
        },
      },
    });
    openWindow = result.window;
    await flush();
    const picker = result.window.document.querySelector('[data-act-as-picker]');
    if (!(picker instanceof result.window.HTMLSelectElement)) throw new Error('picker missing');
    picker.value = OTHER_OWNER;
    picker.dispatchEvent(new result.window.Event('change', { bubbles: true }));

    expect(result.window.localStorage.getItem('ds_act_as_account')).toBe(OTHER_OWNER);
    expect(result.window.driftstackActAsHeaders()).toEqual({
      'x-driftstack-account': OWNER,
    });
    expect(result.navigationAttempts()).toBe(1);
  });

  it('explains downstream X-Driftstack-Account header forwarding', () => {
    expect(body).toContain('X-Driftstack-Account');
  });

  it('renders a clear-act-as control', () => {
    expect(body).toMatch(/data-act-as-clear/);
  });

  it('picker + banner show a human owner label (name/email/slug) with the UUID as a graceful fallback — not the raw account id alone', () => {
    // Prefer owner_name / owner_email / owner_slug when the API exposes
    // them; fall back to the opaque id only when no label is available.
    expect(body).toMatch(/t\.owner_name \|\| t\.owner_email \|\| t\.owner_slug/);
    expect(body).toMatch(/function ownerLabel\(t\)/);
    // The "Acting as" banner is re-labelled with the same friendly name
    // once /account/me resolves (the early toggle could only show the id).
    expect(body).toMatch(/ownerEl\.textContent = ownerLabelById\[active\]/);
    // The raw-id-only option label is gone.
    expect(body).not.toMatch(/t\.owner_account_id \+ ' \(' \+ t\.role \+ '\)'/);
  });
});
