import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(
  new URL('../../src/layouts/AdminLayout.astro', import.meta.url),
  'utf8',
);
const css = readFileSync(new URL('../../src/styles/base.css', import.meta.url), 'utf8');
const tailwind = readFileSync(new URL('../../tailwind.config.mjs', import.meta.url), 'utf8');

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

    expect(new Set(required).size).toBe(required.length);
    for (const variable of required) {
      expect(activeTokens, variable).toMatch(new RegExp(`${variable}:\\s*\\d`));
    }
  });

  it('keeps the admin root color-scheme consistent with its active mode', () => {
    expect(css).toMatch(/:root\s*\{\s*color-scheme:\s*light;/);
  });
});
