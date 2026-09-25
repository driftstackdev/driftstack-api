import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// @ts-expect-error — jsdom ships no type declarations in this workspace's test config.
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = resolve(HERE, '..', '..', 'src', 'pages');
// Any built page carries the layout's shared confirm dialog and its helper.
const BUILT_PAGE = resolve(HERE, '..', '..', 'dist', 'api-keys', 'index.html');
const CONFIRM_PAGES = [
  'api-keys.astro',
  'webhooks.astro',
  'team.astro',
  'settings.astro',
  'security.astro',
];

describe('customer dashboard destructive-confirm sweep', () => {
  it('marks every consequential shared-modal confirmation as destructive', () => {
    let calls = 0;
    let guarded = 0;
    for (const page of CONFIRM_PAGES) {
      const body = readFileSync(resolve(PAGES, page), 'utf8');
      const pageCalls = body.match(/window\.driftstackConfirm\(/g) ?? [];
      const pageGuards = body.match(/destructive:\s*true/g) ?? [];
      expect(pageGuards.length, `${page}: every confirm must require an explicit OK click`).toBe(
        pageCalls.length,
      );
      calls += pageCalls.length;
      guarded += pageGuards.length;
    }
    // 11 since sign-in audit #5: security.astro's "Remove" for a linked sign-in.
    expect(calls).toBe(11);
    expect(guarded).toBe(11);
  });

  it("draws a destructive confirm's OK as the danger button, and a plain one as the primary (the app's ConfirmProvider)", async () => {
    const html = readFileSync(BUILT_PAGE, 'utf8');
    const scripts: string[] = [];
    const markup = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (_m, body: string) => {
      scripts.push(body);
      return '';
    });
    const helper = scripts.find((body) => body.includes('window.driftstackConfirm = function'));
    if (!helper) throw new Error('the confirm helper is missing from the built page');
    const { window } = new JSDOM(markup, { runScripts: 'dangerously' });
    window.eval(helper);
    const confirm = (
      window as unknown as {
        driftstackConfirm: (m: string, o?: object) => Promise<boolean>;
      }
    ).driftstackConfirm;
    const doc = window.document;
    const ok = doc.querySelector<HTMLButtonElement>('[data-ds-confirm-ok]')!;
    const cancel = doc.querySelector<HTMLButtonElement>('[data-ds-confirm-cancel]')!;

    const revoke = confirm('Revoke the key?', { confirmLabel: 'Revoke', destructive: true });
    expect(ok.textContent).toBe('Revoke');
    expect(ok.className).toBe('btn-danger');
    cancel.click();
    expect(await revoke).toBe(false);

    // One dialog serves both kinds, so a plain confirm after a destructive one
    // must not inherit the danger face.
    const plain = confirm('Continue?');
    expect(ok.className).toBe('btn-primary');
    ok.click();
    expect(await plain).toBe(true);
  });
});
