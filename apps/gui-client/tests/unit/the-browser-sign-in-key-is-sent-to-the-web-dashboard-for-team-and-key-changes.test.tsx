import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Driftstack } from '@driftstack/sdk';

/**
 * GUI audit #4 (HIGH) — the desktop sign-in key is refused, by design, for Team
 * invite/remove and for the Anthropic key's save/test/clear. The app must say
 * these changes are managed in the web dashboard, link to it, and disable the
 * controls — and must NEVER tell the account owner they are not the owner.
 *
 * ⭐ The requests go through the REAL SDK client over a stubbed `fetch` that
 * answers with the server's exact problem+json, so the error the views see is
 * the one the shipped client builds. The server's refusal sentence is read from
 * the server SOURCE, not copied here: a copy would keep passing after the server
 * changed its words, which is the drift this finding is about.
 */

const SERVER_DENY_GATE = resolve(__dirname, '../../../server/src/middleware/device-key-deny.ts');

/** The sentence the server's device-key gate throws, read from its source. */
function serverDeviceKeyDetail(): string {
  const src = readFileSync(SERVER_DENY_GATE, 'utf8');
  const m = /new ForbiddenError\(\s*'([^']+)'/.exec(src);
  if (m?.[1] === undefined) throw new Error('device-key-deny.ts no longer throws a literal');
  return m[1];
}

const BASE_URL = 'https://api.driftstack.dev';
const DEVICE_KEY = 'ds_live_desktop_signin_key';

function problem(status: number, type: string, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: `https://errors.driftstack.dev/${type}`,
      title: type === 'forbidden' ? 'Forbidden' : 'Error',
      status,
      detail,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Which refusal the stub server gives the write routes. */
let refusal: 'device' | 'scope' = 'device';
let hasByokKey = false;
const calls: string[] = [];

const DEVICE_DENIED = new Set([
  'POST /v1/team/invites',
  'DELETE /v1/team/members/mem_1',
  'PUT /v1/account/me/byok-anthropic-key',
  'DELETE /v1/account/me/byok-anthropic-key',
  'POST /v1/account/me/byok-anthropic-key/test',
]);

function stubServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const method = (init?.method ?? 'GET').toUpperCase();
  const route = `${method} ${url.pathname}`;
  calls.push(route);
  if (DEVICE_DENIED.has(route)) {
    return Promise.resolve(
      refusal === 'device'
        ? problem(403, 'forbidden', serverDeviceKeyDetail())
        : problem(403, 'forbidden', 'This action requires the "account_owner" scope.'),
    );
  }
  switch (route) {
    case 'GET /v1/team/members':
      return Promise.resolve(
        json({
          data: [
            {
              id: 'mem_1',
              owner_account_id: 'acc_owner',
              member_account_id: 'acc_member',
              member_email: 'teammate@example.com',
              role: 'member',
              invited_at: '2026-09-01T00:00:00Z',
              accepted_at: '2026-09-02T00:00:00Z',
              invited_by_account_id: null,
            },
          ],
        }),
      );
    case 'GET /v1/team/invites':
      return Promise.resolve(json({ data: [] }));
    case 'GET /v1/account/me/bundled-llm-settings':
      return Promise.resolve(json({ consent: false, monthly_cap_usd_cents: 0 }));
    case 'GET /v1/account/me/bundled-llm-status':
      return Promise.resolve(
        json({
          consent: false,
          cap_cents: 0,
          used_this_month_cents: 0,
          remaining_cents: 0,
          refused_count_this_month: 0,
          month_started_at: '2026-09-01T00:00:00.000Z',
        }),
      );
    case 'GET /v1/account/me/byok-anthropic-key':
      return Promise.resolve(
        json(
          hasByokKey
            ? { has_key: true, set_at: '2026-09-01T00:00:00Z', last_used_at: null }
            : { has_key: false, set_at: null, last_used_at: null },
        ),
      );
    default:
      return Promise.resolve(problem(404, 'not-found', 'no such route in this stub'));
  }
}

let client: Driftstack;
let apiKey = DEVICE_KEY;

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    client,
    settings: {
      apiKey,
      baseUrl: BASE_URL,
      telemetryOptIn: null,
      startUrl: 'https://driftstack.io',
    },
    loading: false,
    accountMe: null,
    activeWorkspace: null,
    refreshAccountMe: () => Promise.resolve(),
    update: () => Promise.resolve(),
  }),
}));
vi.mock('../../src/lib/browser-sign-in', () => ({
  useBrowserSignIn: () => ({ state: { kind: 'idle' }, start: vi.fn(), cancel: vi.fn() }),
}));

const { TeamView } = await import('../../src/views/TeamView');
const { SettingsView } = await import('../../src/views/SettingsView');
const { ToastProvider } = await import('../../src/lib/toasts');
const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');
const { fixedApiErrorMessage } = await import('../../src/lib/api-errors');

function renderTeam(): void {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <TeamView onGoToSettings={vi.fn()} />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

function renderSettings(): void {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <SettingsView />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

const NOT_THE_OWNER = /only the account owner/i;

async function forgetRefusals(): Promise<void> {
  // The "seen" memory is per app run; each test is a fresh run. Imported lazily
  // so the behaviour arms above it fail on their assertions, not on a missing
  // module, when this runs against a build without the fix.
  try {
    const mod = await import('../../src/lib/device-key-refusal');
    mod.resetDeviceKeyRefusalsForTests();
  } catch {
    /* a build without the memory has nothing to forget */
  }
}

beforeEach(async () => {
  refusal = 'device';
  hasByokKey = false;
  apiKey = DEVICE_KEY;
  calls.length = 0;
  client = new Driftstack({ apiKey, baseUrl: BASE_URL, fetch: stubServer });
  await forgetRefusals();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Team with the browser sign-in key', () => {
  it('CRITICAL Send invite says team changes are managed in the web dashboard, links to it, and never says "not the owner"', async () => {
    renderTeam();
    expect(await screen.findByText('teammate@example.com')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Invitee email'), {
      target: { value: 'newhire@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));

    expect(
      await screen.findByText(/Team changes are managed in the web dashboard/),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /app\.driftstack\.io/ });
    expect(link).toHaveAttribute('href', 'https://app.driftstack.io/team/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(document.body.textContent).not.toMatch(NOT_THE_OWNER);
    expect(calls).toContain('POST /v1/team/invites');
  });

  it('CRITICAL once refused, the invite and remove controls are disabled', async () => {
    renderTeam();
    expect(await screen.findByText('teammate@example.com')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Invitee email'), {
      target: { value: 'newhire@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await screen.findByText(/Team changes are managed in the web dashboard/);

    expect(screen.getByLabelText('Invitee email')).toBeDisabled();
    expect(screen.getByLabelText('Invitee role')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send invite' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('CRITICAL Remove gives the same answer, not "not the owner"', async () => {
    renderTeam();
    expect(await screen.findByText('teammate@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    // The confirm dialog's own "Remove".
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(
      await screen.findByText(/Team changes are managed in the web dashboard/),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(NOT_THE_OWNER);
    expect(calls).toContain('DELETE /v1/team/members/mem_1');
  });

  it('a 403 that is NOT the device-key refusal still never tells the user they are not the owner', async () => {
    refusal = 'scope';
    renderTeam();
    expect(await screen.findByText('teammate@example.com')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Invitee email'), {
      target: { value: 'newhire@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(NOT_THE_OWNER);
    // Not the device-key refusal, so the controls stay usable.
    expect(screen.getByRole('button', { name: 'Send invite' })).not.toBeDisabled();
  });
});

describe('the Anthropic key with the browser sign-in key', () => {
  it('CRITICAL Set key says the Anthropic key is managed in the web dashboard, links to it, and disables the field', async () => {
    renderSettings();
    const input = await screen.findByPlaceholderText('sk-ant-…');
    fireEvent.change(input, { target: { value: 'sk-ant-owner-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set key' }));

    expect(
      await screen.findByText(/Your Anthropic key is managed in the web dashboard/),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /app\.driftstack\.io/ });
    expect(link).toHaveAttribute('href', 'https://app.driftstack.io/settings/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Set key' })).toBeDisabled();
    // Never the old "check the key" advice: checking it cannot help.
    expect(document.body.textContent).not.toMatch(/does not have permission for this setting/);
    expect(calls).toContain('PUT /v1/account/me/byok-anthropic-key');
  });

  it('CRITICAL Test connection on a saved key gives the same answer and disables Test and Clear', async () => {
    hasByokKey = true;
    renderSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Test Anthropic key' }));

    expect(
      await screen.findByText(/Your Anthropic key is managed in the web dashboard/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Anthropic key' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/does not have permission for this setting/);
    expect(calls).toContain('POST /v1/account/me/byok-anthropic-key/test');
  });

  it('a refusal first met in Team already disables the Anthropic key field (it is a fact about the key)', async () => {
    renderTeam();
    expect(await screen.findByText('teammate@example.com')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Invitee email'), {
      target: { value: 'newhire@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await screen.findByText(/Team changes are managed in the web dashboard/);
    document.body.innerHTML = '';

    renderSettings();
    expect(
      await screen.findByText(/Your Anthropic key is managed in the web dashboard/),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('sk-ant-…')).toBeDisabled();
    expect(calls).not.toContain('PUT /v1/account/me/byok-anthropic-key');
  });

  it('a different key starts unknown: the controls are enabled again', async () => {
    renderTeam();
    expect(await screen.findByText('teammate@example.com')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Invitee email'), {
      target: { value: 'newhire@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await screen.findByText(/Team changes are managed in the web dashboard/);
    document.body.innerHTML = '';

    apiKey = 'ds_live_a_different_key';
    client = new Driftstack({ apiKey, baseUrl: BASE_URL, fetch: stubServer });
    renderSettings();
    const input = await screen.findByPlaceholderText('sk-ant-…');
    expect(input).not.toBeDisabled();
    expect(screen.queryByText(/Your Anthropic key is managed in the web dashboard/)).toBeNull();
  });
});

describe('copy that sends the customer to connect a key', () => {
  it('CRITICAL the "your own AI provider key is required" message points to the web dashboard, not Settings', () => {
    const msg = fixedApiErrorMessage('https://errors.driftstack.dev/byok-anthropic-required', 403);
    expect(msg).not.toMatch(/Settings/);
    expect(msg).toMatch(/web dashboard/);
    expect(msg).toMatch(/app\.driftstack\.io/);
  });
});

describe("the app's sentence is the server's sentence", () => {
  it('matches the device-key refusal the server throws, verbatim', async () => {
    const { DEVICE_KEY_REFUSAL_DETAIL, isDeviceKeyRefusalDetail } =
      await import('../../src/lib/device-key-refusal');
    expect(DEVICE_KEY_REFUSAL_DETAIL).toBe(serverDeviceKeyDetail());
    expect(isDeviceKeyRefusalDetail(serverDeviceKeyDetail())).toBe(true);
    // Disjoint from the Free-plan route policy's refusal, which means something else.
    const { DESKTOP_CREDENTIAL_REFUSAL_DETAIL } = await import('../../src/lib/account-proxies');
    expect(isDeviceKeyRefusalDetail(DESKTOP_CREDENTIAL_REFUSAL_DETAIL)).toBe(false);
  });
});
