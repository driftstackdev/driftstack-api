import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
// Tauri integration: https://tauri.app/v2/start/frontend/vite/
export default defineConfig({
  plugins: [react()],
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
