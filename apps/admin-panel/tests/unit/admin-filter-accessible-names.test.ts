import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function readPage(name: string): string {
  return readFileSync(resolve(REPO_ROOT, 'apps/admin-panel/src/pages', name), 'utf8');
}

function controlTag(source: string, field: string): string {
  const match = source.match(
    new RegExp(`<(?:input|select)\\b[^>]*data-field=["']${field}["'][^>]*>`, 's'),
  );
  if (match === null) throw new Error(`control not found: ${field}`);
  return match[0];
}

describe('admin filter accessible names', () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    ['accounts.astro', 'search', 'Search accounts by email'],
    ['accounts.astro', 'status', 'Filter accounts by status'],
    ['accounts.astro', 'tier', 'Filter accounts by tier'],
    ['api-keys.astro', 'account-id', 'Filter API keys by account id'],
    ['audit-log.astro', 'action', 'Filter audit log by action'],
    ['audit-log.astro', 'admin-id', 'Filter audit log by admin id'],
    ['audit-log.astro', 'result', 'Filter audit log by result'],
    ['rate-limit-overrides.astro', 'account-id', 'Filter rate-limit overrides by account id'],
    ['sessions.astro', 'status', 'Filter sessions by status'],
    ['sessions.astro', 'account-id', 'Filter sessions by account id'],
  ];

  it.each(cases)('%s %s has a stable accessible name', (page, field, label) => {
    expect(controlTag(readPage(page), field)).toContain(`aria-label="${label}"`);
  });
});
