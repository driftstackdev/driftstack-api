import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const tailwind = readFileSync(new URL('../../tailwind.config.mjs', import.meta.url), 'utf8');

function astroSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return astroSources(absolute);
    return entry.name.endsWith('.astro') ? [readFileSync(absolute, 'utf8')] : [];
  });
}

describe('customer dashboard design-token baseline', () => {
  it('defines every tk color utility requested by dashboard templates', () => {
    const namespace = tailwind.match(/tk:\s*\{(?<body>[\s\S]*?)\n\s*\},/)?.groups?.body ?? '';
    const configured = new Set(
      [...namespace.matchAll(/^\s*(?:'([^']+)'|([a-z0-9-]+)):/gm)].map(
        (match) => match[1] ?? match[2]!,
      ),
    );
    const requested = new Set(
      astroSources(new URL('../../src', import.meta.url).pathname).flatMap((source) =>
        [...source.matchAll(/(?:bg|text|border|ring)-tk-([a-z0-9-]+)/g)].map((match) => match[1]!),
      ),
    );

    expect(configured.size).toBeGreaterThan(0);
    expect([...requested].filter((token) => !configured.has(token)).sort()).toEqual([]);
  });
});
