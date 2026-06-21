import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A compact LOCAL build stamp (MM-DD HH:MM:SS) baked in at build time so the
// running build is identifiable at a glance in the simulator's info overlay.
// This ends the stale-build confusion class: relaunching before a rebuild
// finishes installed an OLD binary, which read as "no change". The stamp lines
// up with the rebuild script's "REBUILD DONE <time>" (same local clock). Only
// the vite build defines it; under vitest the token is absent, so consumers
// guard with `typeof`.
const __bd = new Date();
const __p = (n: number): string => String(n).padStart(2, '0');
const BUILD_STAMP = `${__p(__bd.getMonth() + 1)}-${__p(__bd.getDate())} ${__p(__bd.getHours())}:${__p(__bd.getMinutes())}:${__p(__bd.getSeconds())}`;

// https://vitejs.dev/config/
// Tauri integration: https://tauri.app/v2/start/frontend/vite/
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
  },
  // Vite assumes `index.html` is at the project root; Tauri reads from
  // the same directory, so no `root:` override needed.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST ?? false,
  },
  // Tauri builds the frontend to `dist/` and bundles it into the
  // application binary; no need to publish dist to a CDN.
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
