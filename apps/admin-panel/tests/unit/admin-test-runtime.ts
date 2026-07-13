import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JSDOM } from 'jsdom';

const ADMIN_LAYOUT = resolve(process.cwd(), 'apps/admin-panel/src/layouts/AdminLayout.astro');

export function installAdminDeadline(window: JSDOM['window']): void {
  const source = readFileSync(ADMIN_LAYOUT, 'utf8');
  const match = source.match(/<script is:inline data-admin-fetch-deadline>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error('admin deadline inline script not found');
  // @ts-expect-error — jsdom exposes eval for deliberate inline-script execution.
  window.eval(match[1]);
}
