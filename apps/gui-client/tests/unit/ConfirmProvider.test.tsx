// Behavioral test for the branded desktop confirm modal (replaces
// native window.confirm, which is flaky in the Tauri WKWebView). The
// ConfirmProvider gates every destructive desktop action (FleetView
// remove, SettingsView sign-out), so its resolve semantics are
// load-bearing: Confirm → true, Cancel / Escape / backdrop → false, and
// — critically — no-provider fails SAFE (false) so a guard can never
// fire a destructive action without a real confirmation.
//
// Uses @testing-library/react (the gui-jsdom project; cleanup() runs via
// tests/setup.ts).

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfirmProvider, useConfirm } from '../../src/components/ConfirmProvider';

// A tiny consumer that fires a confirm() on click and records the result.
function Harness({
  onResult,
  label,
}: {
  onResult: (v: boolean) => void;
  label?: string;
}): JSX.Element {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={() => {
        void (async () => {
          onResult(await confirm('Remove this item?', { confirmLabel: label ?? 'Remove' }));
        })();
      }}
    >
      trigger
    </button>
  );
}

function renderWithProvider(onResult: (v: boolean) => void, label?: string): void {
  render(
    <ConfirmProvider>
      <Harness onResult={onResult} label={label} />
    </ConfirmProvider>,
  );
}

describe('ConfirmProvider / useConfirm (desktop branded confirm)', () => {
  it('opens the modal with the message + the custom confirm label', async () => {
    renderWithProvider(() => {}, 'Delete forever');
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    expect(await screen.findByText('Remove this item?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete forever' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('Confirm resolves the promise true', async () => {
    const results: boolean[] = [];
    renderWithProvider((v) => results.push(v));
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(results).toEqual([true]));
    // Promise/focus semantics settle immediately, while the inert tree remains
    // for the shared 120ms exit paint before it is removed.
    const exitingDialog = screen.getByRole('dialog', { hidden: true });
    expect(exitingDialog).toHaveAttribute('aria-hidden', 'true');
    expect(exitingDialog).toHaveAttribute('inert');
    expect(exitingDialog).toHaveClass('pointer-events-none', 'animate-modal-backdrop-out');
    expect(exitingDialog.firstElementChild).toHaveClass('animate-modal-panel-out');
    await waitFor(() => expect(screen.queryByText('Remove this item?')).not.toBeInTheDocument());
  });

  it('Cancel resolves the promise false', async () => {
    const results: boolean[] = [];
    renderWithProvider((v) => results.push(v));
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(results).toEqual([false]));
  });

  it('Escape resolves the promise false', async () => {
    const results: boolean[] = [];
    renderWithProvider((v) => results.push(v));
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    await screen.findByText('Remove this item?');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(results).toEqual([false]));
  });

  it('backdrop click resolves the promise false (but a click inside the card does not)', async () => {
    const results: boolean[] = [];
    renderWithProvider((v) => results.push(v));
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    const message = await screen.findByText('Remove this item?');
    // Click inside the card (on the message) — must NOT dismiss.
    fireEvent.click(message);
    expect(results).toEqual([]);
    // Click the backdrop (the dialog overlay element itself) — dismisses.
    fireEvent.click(screen.getByRole('dialog'));
    await waitFor(() => expect(results).toEqual([false]));
  });

  it('no provider mounted: useConfirm fails SAFE (resolves false, no modal)', async () => {
    const results: boolean[] = [];
    render(<Harness onResult={(v) => results.push(v)} />);
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    await waitFor(() => expect(results).toEqual([false]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // WCAG 2.4.3 dialog focus management (parity with the web branded modals).
  it('moves focus into the dialog (the Confirm button) when it opens', async () => {
    renderWithProvider(() => {});
    const trigger = screen.getByRole('button', { name: 'trigger' });
    trigger.focus();
    fireEvent.click(trigger);
    const confirmBtn = await screen.findByRole('button', { name: 'Remove' });
    await waitFor(() => expect(document.activeElement).toBe(confirmBtn));
  });

  it('restores focus to the trigger when the dialog closes', async () => {
    renderWithProvider(() => {});
    const trigger = screen.getByRole('button', { name: 'trigger' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('traps Tab within the dialog: Tab from the last control wraps to the first', async () => {
    renderWithProvider(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'trigger' }));
    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
    const confirmBtn = screen.getByRole('button', { name: 'Remove' });
    confirmBtn.focus(); // last focusable
    fireEvent.keyDown(window, { key: 'Tab' });
    await waitFor(() => expect(document.activeElement).toBe(cancelBtn)); // wrapped to first
  });

  it('a second confirm() opened while one is pending resolves the FIRST (false) — no permanent hang', async () => {
    const results: Array<'a' | 'b'> = [];
    function DoubleHarness(): JSX.Element {
      const confirm = useConfirm();
      return (
        <button
          type="button"
          onClick={() => {
            // Fire two confirms back-to-back; the second replaces the first.
            void confirm('First?').then(() => results.push('a'));
            void confirm('Second?').then(() => results.push('b'));
          }}
        >
          go
        </button>
      );
    }
    render(
      <ConfirmProvider>
        <DoubleHarness />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    // The first promise must settle (it used to hang forever) — confirm 'a' resolved.
    await waitFor(() => expect(results).toContain('a'));
    // The SECOND dialog is the one showing now.
    expect(await screen.findByText('Second?')).toBeInTheDocument();
  });
});
