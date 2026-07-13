import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(
  new URL('../../src/layouts/AdminLayout.astro', import.meta.url),
  'utf8',
);
const css = readFileSync(new URL('../../src/styles/base.css', import.meta.url), 'utf8');
const tailwind = readFileSync(new URL('../../tailwind.config.mjs', import.meta.url), 'utf8');

function astroSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return astroSources(absolute);
    return entry.name.endsWith('.astro') ? [readFileSync(absolute, 'utf8')] : [];
  });
}

function activeLightModeBlock(): string {
  const match = css.match(/\[data-mode='light'\]\s*\{(?<body>[\s\S]*?)\n\}/);
  expect(match?.groups?.body, 'admin light-mode token block').toBeDefined();
  return match!.groups!.body!;
}

function activeOxbloodAccentBlock(): string {
  const match = css.match(/\[data-accent='oxblood'\]\s*\{(?<body>[\s\S]*?)\n\}/);
  expect(match?.groups?.body, 'admin oxblood accent token block').toBeDefined();
  return match!.groups!.body!;
}

describe('admin design-token baseline', () => {
  it('activates the light operator palette and matching browser chrome', () => {
    expect(layout).toContain('<html lang="en" data-mode="light" data-accent="oxblood">');
    expect(layout).toContain('<meta name="theme-color" content="#f2f3f6" />');
    expect(layout).not.toContain('data-mode="dark"');
  });

  it('defines every rgb variable consumed by the tk Tailwind namespace', () => {
    const required = [...tailwind.matchAll(/var\((--[a-z0-9-]+-rgb)\)/g)].map((match) => match[1]!);
    const activeTokens = `${activeLightModeBlock()}\n${activeOxbloodAccentBlock()}`;

    for (const variable of new Set(required)) {
      expect(activeTokens, variable).toMatch(new RegExp(`${variable}:\\s*\\d`));
    }
  });

  it('keeps the admin root color-scheme consistent with its active mode', () => {
    expect(css).toMatch(/:root\s*\{\s*color-scheme:\s*light;/);
  });

  it('defines every tk color utility requested by admin templates', () => {
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
