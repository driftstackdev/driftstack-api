// V-534.G — CostPanel component tests.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostPanel } from '../../src/components/CostPanel';

describe('V-534.G CostPanel', () => {
  it('renders the billing cycle label and a row per cost component', () => {
    render(
      <CostPanel
        billingCycle="2026-05"
        breakdown={{
          computeCents: 120,
          storageCents: 20,
          egressCents: 5,
          emailCents: 5,
          llmCents: 180,
          totalCents: 330,
          thresholdState: 'under-soft',
        }}
      />,
    );
    expect(screen.getByText('2026-05')).toBeInTheDocument();
    expect(screen.getByText('Compute (session-minutes)')).toBeInTheDocument();
    expect(screen.getByText('Storage (R2 GB-months)')).toBeInTheDocument();
    expect(screen.getByText('Egress (TURN GB)')).toBeInTheDocument();
    expect(screen.getByText('Email (Postmark sends)')).toBeInTheDocument();
    expect(screen.getByText('LLM tokens')).toBeInTheDocument();
    // Total carries through the formatter (EUR default).
    expect(screen.getByText('€3.30')).toBeInTheDocument();
  });

  it('"On track" chip when thresholdState === under-soft', () => {
    render(
      <CostPanel
        billingCycle="2026-05"
        breakdown={{
          computeCents: 10,
          storageCents: 0,
          egressCents: 0,
          emailCents: 0,
          llmCents: 0,
          totalCents: 10,
          thresholdState: 'under-soft',
        }}
      />,
    );
    expect(screen.getByText('On track')).toBeInTheDocument();
  });

  it('"Approaching limit" chip when between-soft-and-hard', () => {
    render(
      <CostPanel
        billingCycle="2026-05"
        breakdown={{
          computeCents: 150,
          storageCents: 0,
          egressCents: 0,
          emailCents: 0,
          llmCents: 0,
          totalCents: 150,
          thresholdState: 'between-soft-and-hard',
        }}
      />,
    );
    expect(screen.getByText('Approaching limit')).toBeInTheDocument();
  });

  it('"Over hard limit" chip when over-hard', () => {
    render(
      <CostPanel
        billingCycle="2026-05"
        breakdown={{
          computeCents: 999,
          storageCents: 0,
          egressCents: 0,
          emailCents: 0,
          llmCents: 0,
          totalCents: 999,
          thresholdState: 'over-hard',
        }}
      />,
    );
    expect(screen.getByText('Over hard limit')).toBeInTheDocument();
  });

  it('honours USD currency prop', () => {
    render(
      <CostPanel
        billingCycle="2026-05"
        currency="USD"
        breakdown={{
          computeCents: 500,
          storageCents: 0,
          egressCents: 0,
          emailCents: 0,
          llmCents: 0,
          totalCents: 500,
          thresholdState: 'under-soft',
        }}
      />,
    );
    // Both row + total render in USD.
    expect(screen.getAllByText('$5.00').length).toBeGreaterThanOrEqual(1);
  });
});
