// Founder 2026-06-18 — the simulator's expandable session-control panel: the
// Mode segmented switch (Agent/Pair/Manual), the contextual takeover/handback
// (pair only), and the panel-only "tell the agent" composer (ai/pair).

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionControlSection } from '../../src/views/SimulatorWindow';

const base = {
  pairKind: null,
  action: null,
  composerText: '',
  controlError: null,
  onRetryControl: vi.fn(),
  onSetMode: vi.fn(),
  onTakeover: vi.fn(),
  onHandback: vi.fn(),
  onComposerChange: vi.fn(),
  onSendMessage: vi.fn(),
};

describe('SessionControlSection', () => {
  it('labels manual mode as view-only when the harness reports input unavailable', () => {
    render(<SessionControlSection {...base} mode="manual" manualInputAvailable={false} />);
    expect(screen.getByText('Manual mode — view only (device input unavailable)')).toBeVisible();
  });

  it('renders the Agent/Pair/Manual segments; the active mode is aria-checked', () => {
    render(<SessionControlSection {...base} mode="manual" />);
    expect(screen.getByRole('radio', { name: 'Manual mode' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Agent mode' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('clicking a segment calls onSetMode with that mode', () => {
    const onSetMode = vi.fn();
    render(<SessionControlSection {...base} mode="manual" onSetMode={onSetMode} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Agent mode' }));
    expect(onSetMode).toHaveBeenCalledWith('ai');
  });

  it('the composer is present in ai/pair but NOT in manual', () => {
    const { rerender } = render(<SessionControlSection {...base} mode="ai" />);
    expect(screen.queryByLabelText('Tell the agent')).not.toBeNull();
    rerender(<SessionControlSection {...base} mode="pair" pairKind="ai-driving" />);
    expect(screen.queryByLabelText('Tell the agent')).not.toBeNull();
    rerender(<SessionControlSection {...base} mode="manual" />);
    expect(screen.queryByLabelText('Tell the agent')).toBeNull();
  });

  it('the composer submits via onSendMessage (➤)', () => {
    const onSendMessage = vi.fn();
    render(
      <SessionControlSection
        {...base}
        mode="ai"
        composerText="checkout"
        onSendMessage={onSendMessage}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    expect(onSendMessage).toHaveBeenCalled();
  });

  it('pair mode shows Take control when the agent drives, Hand back when the human drives', () => {
    const onTakeover = vi.fn();
    const onHandback = vi.fn();
    const { rerender } = render(
      <SessionControlSection
        {...base}
        mode="pair"
        pairKind="ai-driving"
        onTakeover={onTakeover}
        onHandback={onHandback}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /take control/i }));
    expect(onTakeover).toHaveBeenCalled();
    rerender(
      <SessionControlSection
        {...base}
        mode="pair"
        pairKind="human-driving"
        onTakeover={onTakeover}
        onHandback={onHandback}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /hand back/i }));
    expect(onHandback).toHaveBeenCalled();
  });

  it('the takeover/handback row is absent in ai and manual modes', () => {
    const { rerender } = render(<SessionControlSection {...base} mode="ai" />);
    expect(screen.queryByRole('button', { name: /take control|hand back/i })).toBeNull();
    rerender(<SessionControlSection {...base} mode="manual" />);
    expect(screen.queryByRole('button', { name: /take control|hand back/i })).toBeNull();
  });

  it('segments are disabled before the mode loads (null) and while a control call is busy', () => {
    const { rerender } = render(<SessionControlSection {...base} mode={null} />);
    expect(screen.getByRole('radio', { name: 'Agent mode' }).disabled).toBe(true);
    rerender(<SessionControlSection {...base} mode="manual" action={{ kind: 'message' }} />);
    expect(screen.getByRole('radio', { name: 'Manual mode' }).disabled).toBe(true);
  });

  it('names the active takeover, handback, mode, and send operations', () => {
    const { rerender } = render(
      <SessionControlSection
        {...base}
        mode="pair"
        pairKind="ai-driving"
        action={{ kind: 'takeover' }}
      />,
    );
    expect(screen.getAllByText('Taking control…')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /taking control/i })).toHaveAttribute(
      'aria-busy',
      'true',
    );

    rerender(
      <SessionControlSection
        {...base}
        mode="pair"
        pairKind="human-driving"
        action={{ kind: 'handback' }}
      />,
    );
    expect(screen.getByRole('button', { name: /handing back/i })).toHaveAttribute(
      'aria-busy',
      'true',
    );

    rerender(
      <SessionControlSection {...base} mode="manual" action={{ kind: 'mode', target: 'ai' }} />,
    );
    expect(screen.getByText('Switching to Agent…')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Agent mode' })).toHaveAttribute('aria-busy', 'true');

    rerender(<SessionControlSection {...base} mode="ai" action={{ kind: 'message' }} />);
    expect(screen.getByRole('button', { name: 'Send to agent' })).toHaveTextContent('Sending…');
  });
});
