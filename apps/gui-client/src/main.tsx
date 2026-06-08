import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConfirmProvider } from './components/ConfirmProvider';
import { DevLogPanel } from './components/DevLogPanel';
import { installLogCapture } from './lib/log-buffer';
import './styles/index.css';

// GUI W232 item (d) — capture console.* + uncaught errors into the in-app dev
// log buffer from the very first line, so startup logs are retained. Idempotent.
installLogCapture();

// ── Fail-visible bootstrap (architectural: the app must NEVER silently
// fail to open). Any startup, render, or async error renders a VISIBLE,
// copyable error panel WITH A CODE instead of a blank/flickering window.
// Uses inline styles + direct DOM so it works even when the CSS bundle or
// React itself failed to load. The panel is a fixed overlay appended to
// <body> (it does NOT clobber #root), so it can't fight React's tree.

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

declare global {
  interface Window {
    __dsFatalShown?: boolean;
  }
}

function renderFatalError(code: string, err: unknown): void {
  // First error wins — shared flag dedupes with the index.html early guard.
  if (window.__dsFatalShown) return;
  window.__dsFatalShown = true;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : '';
  try {
    const box = document.createElement('div');
    box.setAttribute('data-fatal-error', code);
    box.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#0b0b0b;color:#eee;' +
      'font:13px/1.55 -apple-system,system-ui,sans-serif;padding:28px;overflow:auto;';
    box.innerHTML =
      '<div style="max-width:720px;margin:0 auto">' +
      '<h1 style="font-size:16px;color:#ff6b6b;margin:0 0 4px">Driftstack couldn’t start</h1>' +
      '<div style="color:#888;margin:0 0 18px">Error code: <b style="color:#ffb86b">' +
      escapeHtml(code) +
      '</b></div>' +
      '<div style="background:#161616;border:1px solid #333;border-radius:8px;padding:12px 14px;margin:0 0 12px"><b>' +
      escapeHtml(message || '(no message)') +
      '</b></div>' +
      (stack
        ? '<pre style="white-space:pre-wrap;word-break:break-word;color:#9aa;background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:12px;font-size:11px;max-height:45vh;overflow:auto">' +
          escapeHtml(stack) +
          '</pre>'
        : '') +
      '<button id="ds-fatal-reload" style="margin-top:16px;background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:6px;padding:8px 16px;cursor:pointer">Reload</button>' +
      '</div>';
    document.body.appendChild(box);
    document
      .getElementById('ds-fatal-reload')
      ?.addEventListener('click', () => window.location.reload());
  } catch {
    // Absolute last resort if even DOM injection fails.
    document.title = 'Driftstack error ' + code + ': ' + message;
  }
}

// Catch async errors + unhandled promise rejections (e.g. a failed API/keychain
// call that nothing awaited) so they surface instead of leaving a dead UI.
window.addEventListener('error', (e) => renderFatalError('WINDOW_ERROR', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) =>
  renderFatalError('UNHANDLED_REJECTION', e.reason),
);

// Catch render-tree errors so a broken component shows the error, not a blank.
class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    renderFatalError('RENDER_ERROR', error);
  }
  override render(): ReactNode {
    // The fixed overlay owns the screen on failure; render nothing here.
    return this.state.failed ? null : this.props.children;
  }
}

try {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root element missing from index.html');
  createRoot(root).render(
    <StrictMode>
      <RootErrorBoundary>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </RootErrorBoundary>
      {/* Outside the error boundary: the dev-log panel stays available even if
          the App tree throws (so you can read what failed). */}
      <DevLogPanel />
    </StrictMode>,
  );
} catch (err) {
  renderFatalError('BOOT_EXCEPTION', err);
}
