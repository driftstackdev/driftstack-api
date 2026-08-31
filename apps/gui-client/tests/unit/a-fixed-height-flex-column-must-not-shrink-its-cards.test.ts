import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The owner reported the Settings page as "a small bar" with the API-connection
 * block "outside of view". Reproduced in a real browser: the hero <header>
 * rendered **42px tall against 118px of content** and clipped the rest.
 *
 * ⭐ The mechanism is a CSS-spec subtlety, which is why it looked like nothing:
 * these views are a fixed-height flex column (`h-full`) whose content runs far
 * past the viewport, so flex resolves the overflow by SHRINKING its children
 * before the scroll container ever sees it. A flex item is normally protected
 * from that by `min-height: auto` — but **that automatic minimum applies only
 * while the item's own `overflow` is `visible`**. The hero header sets
 * `overflow-hidden` for its rounded corners, which disables the protection. So
 * the one card that clips is the one card that collapses, and every sibling
 * looks fine.
 *
 * It was never Settings-specific: the same hero shipped in five views.
 *
 * ⚠️ jsdom does not do layout, so no render test in this suite can catch it.
 * A source rule is the only automatic guard available, which is why this is one.
 */

const SRC = resolve(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') && !full.includes('.test.')) out.push(full);
  }
  return out;
}

interface Container {
  file: string;
  classes: string;
}

/** Every fixed-height flex column that scrolls its own content. */
function fixedHeightScrollColumns(): Container[] {
  const found: Container[] = [];
  for (const file of walk(SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/className="([^"]*)"/g)) {
      const classes = m[1] ?? '';
      if (
        classes.includes('flex-col') &&
        classes.includes('h-full') &&
        classes.includes('overflow-y-auto')
      ) {
        found.push({ file: file.slice(SRC.length + 1), classes });
      }
    }
  }
  return found;
}

describe('a fixed-height flex column must not shrink its cards', () => {
  const columns = fixedHeightScrollColumns();

  it('finds the containers, or this guard asserts nothing', () => {
    // Non-vacuity: a regex that matched nothing would make the rule below pass
    // over an empty set — the same silent shape as the bug.
    expect(columns.length).toBeGreaterThanOrEqual(5);
  });

  it.each(columns.map((c) => [`${c.file} :: ${c.classes.slice(0, 60)}…`, c] as const))(
    '%s declares [&>*]:shrink-0',
    (_label, container) => {
      expect(
        container.classes,
        `${container.file} is a fixed-height flex column that scrolls. Without [&>*]:shrink-0, any child ` +
          `setting overflow-hidden loses its min-height:auto protection and gets squashed to a fraction of ` +
          `its content — the card renders as a bar and clips its own title.`,
      ).toContain('[&>*]:shrink-0');
    },
  );
});
