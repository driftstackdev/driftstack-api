// V-534.I — BillingCostView wires the cycle picker + useAccountCost
// hook + CostPanel together. Tests stub the hook to drive the three
// observable states (loading / error / ready) plus picker behaviour.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type {
  AccountCostState,
  UseAccountCostOpts,
  UseAccountCostResult,
} from '../../src/lib/use-account-cost';

const refetchSpy = vi.fn(() => Promise.resolve());
const useAccountCostMock = vi.fn<(opts?: UseAccountCostOpts) => UseAccountCostResult>();
vi.mock('../../src/lib/use-account-cost', () => ({
  useAccountCost: (opts?: UseAccountCostOpts) => useAccountCostMock(opts),
}));

const { BillingCostView } = await import('../../src/views/BillingCostView');

function setHookState(state: AccountCostState): void {
  useAccountCostMock.mockReturnValue({ state, refetch: refetchSpy });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('V-534.I BillingCostView — state rendering', () => {
  it('shows a loading message while the hook is loading', () => {
    setHookState({ kind: 'loading' });
    const { container } = render(
      <BillingCostView nowFn={() => new Date('2026-05-11T00:00:00Z')} />,
    );
    expect(screen.getByRole('status', { name: 'Loading cost breakdown…' })).toHaveTextContent(
      /loading/i,
    );
    expect(container.querySelector('[data-component="cost-panel-skeleton"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-component="cost-panel-skeleton-row"]')).toHaveLength(
      5,
    );
  });

  it('shows an alert message when the hook errors', () => {
    setHookState({ kind: 'error', message: 'HTTP 500' });
    render(<BillingCostView nowFn={() => new Date('2026-05-11T00:00:00Z')} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);
    expect(alert).toHaveTextContent(/HTTP 500/);
  });

  it('renders the CostPanel when the hook is ready', () => {
    setHookState({
      kind: 'ready',
      data: {
        account_id: 'acc_test',
        billing_cycle: '2026-05',
        tier: 'api_builder',
        breakdown: {
          computeCents: 120,
          storageCents: 20,
          egressCents: 5,
          emailCents: 5,
          llmCents: 180,
          totalCents: 330,
          thresholdState: 'under-soft',
        },
      },
    });
    render(<BillingCostView nowFn={() => new Date('2026-05-11T00:00:00Z')} />);
    // The CostPanel renders a "Billing cycle" label + the cycle value.
    expect(screen.getByRole('region', { name: /cost breakdown for 2026-05/i })).toBeTruthy();
  });
});

describe('V-534.I BillingCostView — billing-cycle picker', () => {
  it('seeds picker with current month + the three preceding months', () => {
    setHookState({ kind: 'loading' });
    render(<BillingCostView nowFn={() => new Date('2026-05-11T00:00:00Z')} />);
    const picker = screen.getByLabelText<HTMLSelectElement>(/billing cycle/i);
    const optionValues = Array.from(picker.options).map((o) => o.value);
    expect(optionValues).toEqual(['2026-05', '2026-04', '2026-03', '2026-02']);
  });

  it('handles year rollover when current month is January', () => {
    setHookState({ kind: 'loading' });
    render(<BillingCostView nowFn={() => new Date('2026-01-15T00:00:00Z')} />);
    const picker = screen.getByLabelText<HTMLSelectElement>(/billing cycle/i);
    const optionValues = Array.from(picker.options).map((o) => o.value);
    expect(optionValues).toEqual(['2026-01', '2025-12', '2025-11', '2025-10']);
  });

  it('calls the hook with the selected billing_cycle on change', () => {
    setHookState({ kind: 'loading' });
    render(<BillingCostView nowFn={() => new Date('2026-05-11T00:00:00Z')} />);
    const picker = screen.getByLabelText<HTMLSelectElement>(/billing cycle/i);
    fireEvent.change(picker, { target: { value: '2026-03' } });
    // The hook is re-invoked with the new cycle on every render.
    const lastCall = useAccountCostMock.mock.calls.at(-1)?.[0];
    expect(lastCall?.billingCycle).toBe('2026-03');
  });
});

describe('V-534.I BillingCostView — refresh button', () => {
  it('invokes the hook refetch when Refresh is clicked', () => {
    setHookState({
      kind: 'ready',
      data: {
        account_id: 'acc_test',
        billing_cycle: '2026-05',
        tier: 'api_builder',
        breakdown: {
          computeCents: 0,
          storageCents: 0,
          egressCents: 0,
          emailCents: 0,
          llmCents: 0,
          totalCents: 0,
          thresholdState: 'under-soft',
        },
      },
    });
    render(<BillingCostView nowFn={() => new Date('2026-05-11T00:00:00Z')} />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });
});
