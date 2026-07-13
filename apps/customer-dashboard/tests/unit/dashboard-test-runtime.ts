import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JSDOM } from 'jsdom';

const DASHBOARD_LAYOUT = resolve(
  process.cwd(),
  'apps/customer-dashboard/src/layouts/DashboardLayout.astro',
);

export function installDashboardDeadline(window: JSDOM['window']): void {
  const source = readFileSync(DASHBOARD_LAYOUT, 'utf8');
  const match = source.match(
    /<script is:inline data-dashboard-fetch-deadline>([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) throw new Error('dashboard deadline inline script not found');
  // @ts-expect-error — jsdom exposes eval for deliberate inline-script execution.
  window.eval(match[1]);
}
