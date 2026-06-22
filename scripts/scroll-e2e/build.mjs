#!/usr/bin/env node
// Bundle the standalone scroll-e2e harness: the REAL useInputCapture wheel->touch converter
// + React + react-dom, as a single IIFE loadable into a plain chromium page.
//
//   node scripts/scroll-e2e/build.mjs
//
// Output: scripts/scroll-e2e/harness.iife.js
//
// The converter imports { sendInputEvent, InputEvent, Room } from '../../src/lib/livekit'
// (resolving to apps/gui-client/src/lib/livekit.ts, which drags in the full livekit-client
// SDK + a real Room). We REWRITE that one import to scripts/scroll-e2e/livekit-shim.ts via
// an esbuild onResolve plugin keyed on the path basename, so the converter runs unchanged
// while sendInputEvent is intercepted (captured to window.__dsTouchLog + forwarded to the
// live box). The @driftstack/sdk import in the hook is a TYPE-ONLY import (CanonicalModifier)
// which TS/esbuild erase, so the SDK is never actually pulled into the bundle.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const realLivekit = path.join(repoRoot, 'apps', 'gui-client', 'src', 'lib', 'livekit.ts');
const shim = path.join(here, 'livekit-shim.ts');
const out = path.join(here, 'harness.iife.js');

/** Redirect the converter's '../../src/lib/livekit' import to our shim. We match on the
 *  resolved real-file path AND on the bare './livekit' / '../../src/lib/livekit' specifier
 *  forms so it works regardless of how esbuild presents the importer. */
const livekitShimPlugin = {
  name: 'livekit-shim',
  setup(b) {
    b.onResolve({ filter: /(^|\/)livekit$/ }, (args) => {
      // Only redirect the gui-client livekit module (NOT 'livekit-client' or unrelated).
      // The hook imports it as '../../src/lib/livekit' from apps/gui-client/src/lib/.
      if (args.path === 'livekit-client') return undefined;
      const resolved = path.resolve(path.dirname(args.importer), args.path);
      if (
        resolved === realLivekit ||
        resolved === realLivekit.replace(/\.ts$/, '') ||
        args.path.endsWith('/src/lib/livekit')
      ) {
        return { path: shim };
      }
      return undefined;
    });
  },
};

await build({
  entryPoints: [path.join(here, 'entry.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: out,
  plugins: [livekitShimPlugin],
  logLevel: 'info',
  // React's jsx-runtime + react-dom/client resolve from the hoisted root node_modules.
  absWorkingDir: repoRoot,
});

console.log('built', path.relative(repoRoot, out));
