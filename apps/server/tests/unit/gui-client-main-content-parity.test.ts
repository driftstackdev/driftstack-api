// W486.B — drift guard for apps/gui-client/src/main.tsx.
// React bootstrap entry, hardened into a FAIL-VISIBLE bootstrap (the desktop
// app must NEVER silently fail to open — every startup, render, or async
// error must surface a VISIBLE error panel WITH A CODE instead of a blank or
// flickering window). Drift here would re-introduce the silent-blank failure
// mode, so we pin:
//
//   • StrictMode stays at the top of the render tree (surfaces React
//     double-invoke / state-init purity violations).
//   • The render tree is StrictMode > RootErrorBoundary > ConfirmProvider >
//     App — the error boundary catches render-tree throws (RENDER_ERROR) and
//     the branded ConfirmProvider wraps the app (so useConfirm works
//     everywhere, replacing Tauri-flaky window.confirm).
//   • The root-element null-check throws loudly (BOOT_EXCEPTION) rather than
//     silently rendering nothing.
//   • styles import './styles/index.css' is the canonical Tailwind entry —
//     drift to a different path would silently drop all component styling.
//   • The fail-visible primitives stay present: renderFatalError, the
//     window 'error' / 'unhandledrejection' handlers, the createRoot try/catch,
//     and the four error codes. These are the architectural guarantee — if any
//     is dropped, a failure path goes back to a blank window with no code.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/main.tsx');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W486.B apps/gui-client/src/main.tsx content parity', () => {
  const body = read(LIB);

  it("Imports pinned: StrictMode + Component/ReactNode from 'react' + createRoot from 'react-dom/client' + App from './App' + './styles/index.css' Tailwind entry — pinned so the bootstrap can't silently lose StrictMode (which catches double-invoke side-effects), the error-boundary base (Component), or the styles import (which would render an unstyled tree)", () => {
    expect(body).toMatch(/import \{ Component, StrictMode, type ReactNode \} from 'react';/);
    expect(body).toMatch(/import \{ createRoot \} from 'react-dom\/client';/);
    expect(body).toMatch(/import \{ App \} from '\.\/App';/);
    expect(body).toMatch(/import '\.\/styles\/index\.css';/);
  });

  it("Root element invariant: const root = document.getElementById('root') + a throwing null-check — pinned so a missing #root div fails loudly with a stack trace (surfaced as BOOT_EXCEPTION) instead of silently rendering nothing", () => {
    expect(body).toMatch(/const root = document\.getElementById\('root'\);/);
    expect(body).toMatch(
      /if \(!root\) throw new Error\('#root element missing from index\.html'\);/,
    );
  });

  it('Render tree pinned: createRoot(root).render with StrictMode > RootErrorBoundary > ConfirmProvider > App — pinned so StrictMode stays at the top, the error boundary stays wrapping the app (render-tree throws surface as RENDER_ERROR, not a blank), and ConfirmProvider keeps useConfirm working everywhere', () => {
    expect(body).toMatch(/import \{ ConfirmProvider \} from '\.\/components\/ConfirmProvider';/);
    expect(body).toMatch(/createRoot\(root\)\.render\(/);
    // Discrete ordered pins (NOT one long backtracking regex): the four tree
    // levels must appear, in order, with the boundary inside StrictMode and
    // ConfirmProvider inside the boundary.
    expect(body).toMatch(/<StrictMode>\s*<RootErrorBoundary>/);
    expect(body).toMatch(/<RootErrorBoundary>\s*<ConfirmProvider>/);
    expect(body).toMatch(/<ConfirmProvider>\s*<App \/>/);
    // DevLogPanel (GUI W232 d) renders OUTSIDE the error boundary but inside
    // StrictMode, so the dev-log view survives an App-tree throw.
    expect(body).toMatch(/<\/RootErrorBoundary>[\s\S]*?<DevLogPanel \/>\s*<\/StrictMode>/);
  });

  it('Dev-log capture wired (GUI W232 d): imports installLogCapture + DevLogPanel, calls installLogCapture() at module top (so startup logs are retained), renders <DevLogPanel /> — pinned so the in-app log view + console/error capture cannot silently regress', () => {
    expect(body).toMatch(/import \{ DevLogPanel \} from '\.\/components\/DevLogPanel';/);
    expect(body).toMatch(/import \{ installLogCapture \} from '\.\/lib\/log-buffer';/);
    expect(body).toMatch(/installLogCapture\(\);/);
  });

  it('Fail-visible architecture pinned: renderFatalError + RootErrorBoundary + global error/unhandledrejection handlers + createRoot try/catch + the four error codes — pinned so no drift can re-introduce a silent blank/flicker on a startup, render, or async failure', () => {
    // The visible-panel renderer + the boundary that feeds it.
    expect(body).toMatch(/function renderFatalError\(code: string, err: unknown\): void \{/);
    expect(body).toMatch(/class RootErrorBoundary extends Component</);
    expect(body).toMatch(/static getDerivedStateFromError\(\)/);
    // Async + global failure surfaces (a failed keychain/API call that nothing
    // awaited would otherwise leave a dead UI).
    expect(body).toMatch(/window\.addEventListener\('error',/);
    expect(body).toMatch(/window\.addEventListener\('unhandledrejection',/);
    // The render itself is guarded so a synchronous boot throw is visible.
    expect(body).toMatch(/\} catch \(err\) \{\s*\n?\s*renderFatalError\('BOOT_EXCEPTION', err\);/);
    // All four codes must remain present and distinct.
    for (const code of ['WINDOW_ERROR', 'UNHANDLED_REJECTION', 'RENDER_ERROR', 'BOOT_EXCEPTION']) {
      expect(body).toContain(`'${code}'`);
    }
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
