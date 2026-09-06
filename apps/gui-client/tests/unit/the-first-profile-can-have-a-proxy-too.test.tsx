// The first profile was the one profile that could not be given an egress.
//
// The Profiles modal has had an inline "add new proxy" mini-form for a long
// time — SOCKS5/HTTP host:port:user:pass, or a pasted/uploaded .ovpn or
// wg0.conf. The first-run wizard, which is where a new customer creates their
// FIRST profile, called `client.profiles.create({ name, archetype })` and
// nothing else. So the option existed everywhere except the one place every new
// customer passes through.
//
// It is collapsed by default here, deliberately. The wizard's job is to get
// someone to a working app, and a profile with no proxy is still valid — launch
// falls back to the first available one. What matters is that the option is
// REACHABLE, and that every scheme the Profiles modal accepts is reachable.
//
// The parsing is the shared lib (parseWireGuardConfig / validateOpenVpnConfig /
// build*ProxyInput), NOT re-implemented — so these arms deliberately exercise
// the real helpers rather than mocking them. A wireguard blob that the real
// parser rejects must produce an error here, because that is the actual
// contract a customer meets.

import type * as ProxiesModule from '../../src/lib/proxies';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const createProfile = vi.fn(() => Promise.resolve({ id: 'prof_new' }));
const addProxy = vi.fn(() => Promise.resolve({ id: 'aprx_new' }));
const setDefaultProxy = vi.fn(() => Promise.resolve());

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    client: { profiles: { create: createProfile } },
    settings: { apiKey: 'ds_test', baseUrl: 'http://localhost:3000' },
  }),
}));

// ⛔ PARTIAL mock, not a replacement. A factory that enumerates exports breaks the
// moment the module gains one — `hostWarningFor` was added for the local-proxy
// advice and seven suites went red on a module they only wanted two stubs from.
// The spread keeps every real export; the keys below still override the ones this
// suite controls.
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  addProxy: (...args: unknown[]) => addProxy(...(args as [])),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  setDefaultProxy: (...args: unknown[]) => setDefaultProxy(...(args as [])),
}));

const { ProfileStep } = await import('../../src/views/FirstRunWizard');

const WG = [
  '[Interface]',
  'PrivateKey = aGVsbG8td29ybGQtcHJpdmF0ZS1rZXktMzJieXRlcw==',
  'Address = 10.0.0.2/32',
  '[Peer]',
  'PublicKey = aGVsbG8td29ybGQtcHVibGljLWtleS0zMmJ5dGVzISE=',
  'Endpoint = vpn.example.com:51820',
  'AllowedIPs = 0.0.0.0/0',
].join('\n');

function openProxyPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: /attach a proxy/i }));
}

function setScheme(value: string): void {
  fireEvent.change(screen.getByRole('combobox'), { target: { value } });
}

describe('the first profile can have a proxy too', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('CRITICAL every scheme the Profiles modal accepts is offered here, including the two config-file ones', () => {
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);
    openProxyPanel();
    const offered = [...screen.getByRole('combobox').querySelectorAll('option')].map(
      (o) => o.value,
    );
    expect(offered.sort()).toEqual(['http', 'openvpn', 'socks5', 'wireguard']);
  });

  it('CRITICAL a wg0.conf can be UPLOADED, not only pasted — the file is what a customer actually has', async () => {
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);
    openProxyPanel();
    setScheme('wireguard');

    const file = new File([WG], 'wg0.conf', { type: 'text/plain' });
    const input = document.querySelector('input[type="file"]');
    expect(input, 'no file input is rendered for wireguard').not.toBeNull();
    expect(
      (input as HTMLInputElement).accept,
      'the picker does not accept .conf, so the customer cannot select their own file',
    ).toContain('.conf');

    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    // The blob lands in the textarea, so the customer can SEE what was read.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /paste your wg0.conf/i }).value).toContain(
        '[Interface]',
      ),
    );
  });

  it('CRITICAL the proxy is minted and BOUND to the new profile, otherwise attaching it did nothing', async () => {
    const onCreated = vi.fn();
    render(<ProfileStep onSkip={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText('my-recurring-workflow'), {
      target: { value: 'first' },
    });
    openProxyPanel();
    fireEvent.change(screen.getByPlaceholderText('residential-uk'), { target: { value: 'uk1' } });
    fireEvent.change(screen.getByPlaceholderText('proxy.example.com'), {
      target: { value: '10.0.0.9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(addProxy).toHaveBeenCalledTimes(1);
    expect(addProxy.mock.calls[0]![0]).toMatchObject({
      label: 'uk1',
      scheme: 'socks5',
      host: '10.0.0.9',
      port: 1080,
    });
    expect(
      setDefaultProxy,
      'the proxy was created but never bound to the profile',
    ).toHaveBeenCalledWith('prof_new', 'aprx_new');
  });

  it('CRITICAL a malformed config fails BEFORE the profile is created, so a bad paste cannot leave a billed profile behind', async () => {
    render(<ProfileStep onSkip={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('my-recurring-workflow'), {
      target: { value: 'first' },
    });
    openProxyPanel();
    fireEvent.change(screen.getByPlaceholderText('residential-uk'), { target: { value: 'bad' } });
    setScheme('wireguard');
    fireEvent.change(screen.getByRole('textbox', { name: /paste your wg0.conf/i }), {
      target: { value: 'not a wireguard config' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/WireGuard config/i));
    expect(
      createProfile,
      'a profile was created despite an invalid proxy config',
    ).not.toHaveBeenCalled();
    expect(addProxy).not.toHaveBeenCalled();
  });

  it('leaving the panel closed creates the profile exactly as before, with no proxy calls at all', async () => {
    const onCreated = vi.fn();
    render(<ProfileStep onSkip={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByPlaceholderText('my-recurring-workflow'), {
      target: { value: 'plain' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createProfile).toHaveBeenCalledTimes(1);
    const args = createProfile.mock.calls[0]![0] as { name: string; archetype: string };
    expect(args.name).toBe('plain');
    expect(typeof args.archetype).toBe('string');
    // No proxy fields ride along when the panel was never opened.
    expect(Object.keys(args).sort()).toEqual(['archetype', 'name']);
    expect(addProxy).not.toHaveBeenCalled();
    expect(setDefaultProxy).not.toHaveBeenCalled();
  });

  it('a binding failure does NOT fail the wizard — the profile exists and is already billed', async () => {
    setDefaultProxy.mockRejectedValueOnce(new Error('offline'));
    const onCreated = vi.fn();
    render(<ProfileStep onSkip={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText('my-recurring-workflow'), {
      target: { value: 'first' },
    });
    openProxyPanel();
    fireEvent.change(screen.getByPlaceholderText('residential-uk'), { target: { value: 'uk1' } });
    fireEvent.change(screen.getByPlaceholderText('proxy.example.com'), {
      target: { value: '10.0.0.9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});
