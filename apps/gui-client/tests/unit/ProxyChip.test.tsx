// 2026-05-21 — ProxyChip (Slice C) — locks the read-only proxy chip
// behavior: click toggles a popover with SOCKS5 host/port/auth/added
// fields; password never renders; "no proxy" affordance when null.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProxyChip } from '../../src/components/ProxyChip';
import type { ProxyConfig } from '../../src/lib/proxies';

afterEach(() => cleanup());

function makeProxy(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    label: 'Residential UK',
    host: 'gw.example.com',
    port: 1080,
    username: 'alice',
    password: 'hunter2',
    createdAt: '2026-04-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('ProxyChip', () => {
  it('renders "no proxy" when proxy is null', () => {
    render(<ProxyChip proxy={null} />);
    expect(screen.getByText('no proxy')).toBeInTheDocument();
  });

  it('renders host:port as a button when a proxy is supplied', () => {
    render(<ProxyChip proxy={makeProxy()} />);
    expect(screen.getByRole('button')).toHaveTextContent('gw.example.com:1080');
  });

  it('shows the (default) suffix when the proxy is the binding-defaulted pick', () => {
    render(<ProxyChip proxy={makeProxy()} defaulted />);
    expect(screen.getByText('(default)')).toBeInTheDocument();
  });

  it('omits (default) when the proxy is an explicit binding', () => {
    render(<ProxyChip proxy={makeProxy()} defaulted={false} />);
    expect(screen.queryByText('(default)')).not.toBeInTheDocument();
  });

  it('opens a popover with proxy detail on click', () => {
    render(<ProxyChip proxy={makeProxy()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    const popover = screen.getByRole('dialog', { name: 'Proxy details' });
    expect(popover).toHaveTextContent('Residential UK');
    expect(popover).toHaveTextContent('gw.example.com');
    expect(popover).toHaveTextContent('1080');
    expect(popover).toHaveTextContent('SOCKS5');
  });

  it('reveals auth "yes" when username is present (and "no" when blank)', () => {
    render(<ProxyChip proxy={makeProxy({ username: 'alice' })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Auth\s*yes/);

    cleanup();
    render(<ProxyChip proxy={makeProxy({ username: null })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Auth\s*no/);
  });

  it('NEVER renders the password (even when set)', () => {
    render(<ProxyChip proxy={makeProxy({ password: 'hunter2' })} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog')).not.toHaveTextContent('hunter2');
  });

  it('renders an 8-char proxy id prefix in the popover header', () => {
    render(<ProxyChip proxy={makeProxy()} />);
    fireEvent.click(screen.getByRole('button'));
    const popover = screen.getByRole('dialog');
    // First 8 chars of the uuid + ellipsis
    expect(popover.textContent).toMatch(/11111111…/);
  });
});
