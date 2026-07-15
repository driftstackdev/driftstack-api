// A small reusable error boundary. When a child subtree throws (e.g. a
// React.lazy chunk that won't load while offline / after an update, or a render
// crash), it renders `fallback(retry)` — a recoverable message scoped to the
// boundary — instead of letting the throw bubble to the app-level
// RootErrorBoundary and blank the whole window. `retry` re-mounts the children.

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Rendered on failure; `retry` re-mounts the children (e.g. re-attempt a
   *  lazy import or a transient render). */
  fallback: (retry: () => void) => ReactNode;
  /** A destination identity change clears a prior failure without replacing the
   *  boundary instance (which would also remount the surrounding panel). */
  resetKey?: unknown;
}

interface State {
  failed: boolean;
  resetKey: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.resetKey)
      ? null
      : { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Pick<State, 'failed'> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.warn('[error-boundary] caught (degraded to fallback):', error);
  }

  private readonly retry = (): void => this.setState({ failed: false });

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}
