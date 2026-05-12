// W486.B — drift guard for apps/gui-client/src/main.tsx.
// React bootstrap entry. Drift here either drops StrictMode (which
// surfaces real React anti-patterns — useEffect double-invoke and
// state-init purity violations — that would otherwise ship undetected)
// or breaks the 'root element missing' invariant (a silent body-replace
// instead of throwing would mean a deployment artifact with a missing
// #root div fails by rendering nothing rather than with a stack trace).
//
//   • createRoot(#root) into StrictMode wrapper around <App />.
//   • Defensive null-check throws 'root element missing'.
//   • styles import './styles/index.css' is the canonical Tailwind
//     entry — drift to a different path would silently drop all
//     component styling.

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

  it("Imports pinned: StrictMode from 'react' + createRoot from 'react-dom/client' + App from './App' + './styles/index.css' Tailwind entry — pinned so the bootstrap can't silently lose StrictMode (which catches double-invoke side-effects) or drop the styles import (which would render an unstyled tree)", () => {
    expect(body).toMatch(/import \{ StrictMode \} from 'react';/);
    expect(body).toMatch(/import \{ createRoot \} from 'react-dom\/client';/);
    expect(body).toMatch(/import \{ App \} from '\.\/App';/);
    expect(body).toMatch(/import '\.\/styles\/index\.css';/);
  });

  it("Root element invariant: const root = document.getElementById('root') + if (!root) throw new Error('root element missing') — pinned so a missing #root div fails loudly with a stack trace instead of silently rendering nothing", () => {
    expect(body).toMatch(/const root = document\.getElementById\('root'\);/);
    expect(body).toMatch(/if \(!root\) throw new Error\('root element missing'\);/);
  });

  it("createRoot(root).render wraps <App /> in <StrictMode> — pinned so StrictMode stays at the top of the tree (drift to bare <App /> drops React's double-invoke detection for unsafe lifecycle patterns)", () => {
    expect(body).toMatch(
      /createRoot\(root\)\.render\(\s*\n?\s*<StrictMode>\s*\n?\s*<App \/>\s*\n?\s*<\/StrictMode>,\s*\n?\s*\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
