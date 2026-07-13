import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWS = resolve(HERE, '..', '..', 'src', 'views');
const SDK_BACKED_VIEWS = [
  'TeamView.tsx',
  'AgentChatView.tsx',
  'SessionsHistoryView.tsx',
  'ProfilesView.tsx',
  'RecipesView.tsx',
  'ConnectivityView.tsx',
  'FirstRunWizard.tsx',
  'SessionsView.tsx',
] as const;

describe('SDK problem copy boundary', () => {
  it.each(SDK_BACKED_VIEWS)('%s never reflects remote problem prose', (view) => {
    const body = readFileSync(resolve(VIEWS, view), 'utf8');

    expect(body).not.toMatch(/err\.(?:title|detail)/);
    expect(body).not.toMatch(/DriftstackError[\s\S]{0,160}\?\s*err\.message/);
    expect(body).not.toMatch(
      /if \(err instanceof DriftstackError\)[\s\S]{0,120}return err\.message/,
    );
  });
});
