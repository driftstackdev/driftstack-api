// (n) N4 — editing a WireGuard row must not show a SENTENCE where the configuration
// goes, and one keystroke must not delete the saved config.
//
// MEASURED: `useState(initial.wireguard ? '(saved WireGuard config)' : '')` put that
// sentence in the textarea's VALUE and the textarea re-parsed its own value on every
// keystroke. So the box read as if "(saved WireGuard config)" were the config; clicking
// into it and pressing any key produced "PrivateKey is not a 44-char base64 key" —
// about text the customer never entered — dropped `draft.wireguard`, and killed Save
// with "Paste a valid wg0.conf configuration.". Cancel or re-pasting the whole conf were
// the only ways out. The OpenVPN editor shows its real blob and has none of this.
//
// The box is a REPLACE field now: empty means keep what is saved (the placeholder says
// so), a failed parse of replacement text reports the text and keeps the saved block,
// and only a clean paste replaces it. Driven through the REAL ProxyForm and the REAL
// parser — the defect was in the state the box binds to, so nothing here is stubbed.

import { describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProxyDraft } from '../../src/lib/proxies';
import { ProxyForm } from '../../src/views/ProxiesView';

const PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PRIV_NEW = 'aB3z5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

const STORED_BLOCK = {
  private_key: PRIV,
  peer_public_key: PUB,
  endpoint: 'wg.example.com:51820',
  allowed_ips: '0.0.0.0/0',
  address: '10.7.0.2/32',
  dns: '10.64.0.1',
};

const STORED: ProxyDraft = {
  label: 'wg-london',
  scheme: 'wireguard',
  host: 'wg.example.com',
  port: 51820,
  username: null,
  password: null,
  wireguard: STORED_BLOCK,
};

function conf(opts: { privateKey?: string; endpoint?: string } = {}): string {
  return [
    '[Interface]',
    `PrivateKey = ${opts.privateKey ?? PRIV_NEW}`,
    'Address = 10.7.0.2/32',
    'DNS = 10.64.0.1',
    '[Peer]',
    `PublicKey = ${PUB}`,
    `Endpoint = ${opts.endpoint ?? 'wg-new.example.com:51820'}`,
    'AllowedIPs = 0.0.0.0/0',
  ].join('\n');
}

type OnSave = Mock<(d: ProxyDraft) => Promise<void>>;

function mount(draft: ProxyDraft, mode: 'add' | 'edit' = 'edit'): { onSave: OnSave } {
  const onSave: OnSave = vi.fn((_d: ProxyDraft) => Promise.resolve());
  render(<ProxyForm initial={draft} mode={mode} onCancel={() => undefined} onSave={onSave} />);
  return { onSave };
}

function box(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: /wg0\.conf/i });
}

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } });
}

function submit(name: string): void {
  const btn = screen.getByRole('button', { name });
  const form = btn.closest('form');
  expect(form, 'the submit button is not inside the proxy form').not.toBeNull();
  fireEvent.submit(form as HTMLFormElement);
}

describe('(n) N4 — the wg0.conf box on an edit is an empty REPLACE field', () => {
  it('CRITICAL the box is EMPTY and the saved-config sentence is only its placeholder — the sentinel is never the value the box re-parses', () => {
    mount(STORED);
    expect(box()).toHaveValue('');
    expect(box().placeholder).toMatch(/replace the saved one/i);
    expect(box().placeholder).toMatch(/leave this empty to keep it/i);
  });

  it('shows what is saved WITHOUT the secrets, so "leave this empty to keep it" names something visible', () => {
    mount(STORED);
    const summary = document.querySelector('[data-component="wg-saved-summary"]');
    expect(summary?.textContent).toContain('wg.example.com:51820');
    expect(summary?.textContent).toContain('10.7.0.2/32');
    // ⛔ the private key is material, not a summary. It must not reach the markup.
    expect(document.body.innerHTML).not.toContain(PRIV);
  });

  it('CRITICAL one keystroke does NOT report a PrivateKey the customer never typed, does NOT block Save, and does NOT drop the saved block', async () => {
    const { onSave } = mount(STORED);
    type('x');
    const hint = await screen.findByRole('alert');
    expect(hint.textContent).not.toMatch(/PrivateKey/);
    expect(hint.textContent).toMatch(/not a complete wg0\.conf yet/i);
    expect(hint.textContent).toMatch(/saved WireGuard config is kept/i);

    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeEnabled();
    submit('Save changes');
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0]?.[0] as ProxyDraft).wireguard).toEqual(STORED_BLOCK);
  });

  it('CRITICAL VACUITY CONTROL — a REAL conf attempt that fails to parse still gets the parser’s own specific reason (the generic sentence is not swallowing every refusal), and the saved block survives that too', async () => {
    const { onSave } = mount(STORED);
    type(conf({ privateKey: 'not-a-key' }));
    const hint = await screen.findByRole('alert');
    expect(hint.textContent).toMatch(/PrivateKey is not a 44-char base64 key/);
    expect(hint.textContent).toMatch(/saved WireGuard config is kept/i);
    submit('Save changes');
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0]?.[0] as ProxyDraft).wireguard).toEqual(STORED_BLOCK);
  });

  it('typing and then clearing the box returns to the quiet "saved config kept" state', async () => {
    const { onSave } = mount(STORED);
    type('x');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    type('');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    submit('Save changes');
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0]?.[0] as ProxyDraft).wireguard).toEqual(STORED_BLOCK);
  });

  it('CRITICAL a clean paste DOES replace the saved block — the keep rule must not make the box read-only', async () => {
    const { onSave } = mount(STORED);
    type(conf({ endpoint: 'wg-new.example.com:51820', privateKey: PRIV_NEW }));
    expect(await screen.findByText('✓ endpoint wg-new.example.com:51820')).toBeInTheDocument();
    submit('Save changes');
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const d = onSave.mock.calls[0]?.[0] as ProxyDraft;
    expect(d.wireguard).toMatchObject({
      private_key: PRIV_NEW,
      endpoint: 'wg-new.example.com:51820',
    });
    expect(d.host).toBe('wg-new.example.com');
  });

  it('CONTROL — in ADD mode there is nothing saved to keep: a failed parse leaves no block and the submit gate says so', async () => {
    const { onSave } = mount(
      {
        label: 'new-wg',
        scheme: 'wireguard',
        host: '',
        port: 51820,
        username: null,
        password: null,
      },
      'add',
    );
    expect(box().placeholder).toContain('[Interface]');
    type('x');
    // The parser's own reason, with no "kept" promise attached — nothing is stored yet.
    const hint = await screen.findByRole('alert');
    expect(hint.textContent).toMatch(/PrivateKey is not a 44-char base64 key/);
    expect(hint.textContent).not.toMatch(/saved WireGuard config is kept/i);
    submit('Add proxy');
    expect(await screen.findByText('Paste a valid wg0.conf configuration.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
