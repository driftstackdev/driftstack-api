// OnboardingChecklist — progress render, next-step affordance, all-done = null.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OnboardingChecklist, type ChecklistStep } from '../../src/components/OnboardingChecklist';

afterEach(cleanup);

function steps(overrides: Partial<Record<string, boolean>> = {}): ChecklistStep[] {
  return [
    { id: 'connect', label: 'Connect your account', done: overrides.connect ?? true },
    { id: 'profile', label: 'Create your first profile', done: overrides.profile ?? false },
    { id: 'launch', label: 'Launch a session', done: overrides.launch ?? false },
  ];
}

describe('OnboardingChecklist', () => {
  it('renders progress and marks the next incomplete step', () => {
    render(<OnboardingChecklist steps={steps()} onDismiss={() => {}} />);
    expect(screen.getByText('1/3')).toBeDefined();
    expect(screen.getByText('→')).toBeDefined();
  });

  it('clicking an incomplete step with go runs it', () => {
    const go = vi.fn();
    const list = steps();
    list[1] = { ...list[1]!, go };
    render(<OnboardingChecklist steps={list} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText('Create your first profile'));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when every step is done', () => {
    const { container } = render(
      <OnboardingChecklist
        steps={steps({ connect: true, profile: true, launch: true })}
        onDismiss={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('dismiss emits onDismiss', () => {
    const onDismiss = vi.fn();
    render(<OnboardingChecklist steps={steps()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText('Dismiss checklist'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
