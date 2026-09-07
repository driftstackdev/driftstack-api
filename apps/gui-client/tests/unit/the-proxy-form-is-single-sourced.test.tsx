// T-21 — after deleting the three hand-rolled proxy mini-forms (the two profile
// modals + the first-run wizard) and rendering the ONE canonical ProxyForm in
// their place, these structural arms hold that ground:
//
//   1. Exactly ONE component in gui-client/src renders the proxy scheme <select>
//      (SOCKS5 / HTTP / OpenVPN / WireGuard). More than one means a duplicate has
//      grown back — the very shape of the defect T-21 removed, where the copies
//      drifted (the profile modals never gained the OpenVPN auth fields).
//
//   2. No proxy password field is type="password". The owner set these to plain
//      text on 2026-08-30 deliberately: "proxy password should just be clean
//      visible, not hidden" — a proxy credential is configuration to VERIFY
//      against the provider's dashboard, and masking hides the one typo that
//      reads downstream as an auth failure on a working proxy. The old first-run
//      form had drifted back to type="password"; this arm keeps it from
//      returning anywhere a proxy password is bound.
//
// Both arms DERIVE their set from the source (grep-style, like the other
// single-source guards) rather than hard-listing files, so a new duplicate or a
// re-masked field is caught wherever it appears.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/** Every .tsx under src/views + src/components, as [repoRelPath, source]. */
function sourceFiles(): [string, string][] {
  const out: [string, string][] = [];
  for (const dir of ['views', 'components']) {
    const base = join(SRC, dir);
    for (const name of readdirSync(base)) {
      if (!name.endsWith('.tsx')) continue;
      out.push([`${dir}/${name}`, readFileSync(join(base, name), 'utf8')]);
    }
  }
  return out;
}

// The proxy scheme <select> is the one whose options are the four proxy schemes;
// its first option is the unambiguous marker. A file that only RENDERS ProxyForm
// (e.g. the visual-harness gallery) never contains this markup — only the file
// that writes the <select> does.
const SCHEME_SELECT = /<option value="socks5">/;

// An <input> ELEMENT that binds a PROXY draft's password — draft.password,
// draft.openvpn?.password, or a re-introduced duplicate's newProxy.password /
// proxy.password. Deliberately NOT a bare `.password`: a hypothetical login field
// (`form.password`) is a different concern and must not be swept in here.
const INPUT_ELEMENT = /<input\b[\s\S]*?\/>/g;
const BINDS_A_PROXY_PASSWORD = /value=\{(?:draft|newProxy|proxy)(?:\.openvpn)?\??\.password/;

/** Strip whole-line `//` comments from a JSX element before matching attributes.
 *  ⛔ The proxy password inputs carry a `// ⛔ NOT type="password"` comment
 *  explaining WHY they are plain text; without this, that comment's own
 *  `type="password"` text reads as a masked attribute and the arm fails on the
 *  very field it is meant to bless. */
function withoutComments(el: string): string {
  return el.replace(/^\s*\/\/.*$/gm, '');
}

describe('the proxy form is single-sourced (T-21)', () => {
  it('CRITICAL exactly one component renders the proxy scheme <select>, and it is ProxyForm', () => {
    const renderers = sourceFiles()
      .filter(([, src]) => SCHEME_SELECT.test(src))
      .map(([path]) => path);
    // Exactly one — not "at least one". Zero would mean the canonical select was
    // removed (this whole surface gone); two or more would mean a duplicate grew
    // back. Either way the invariant is broken, so the equality is the control:
    // it fails on an empty match instead of certifying nothing.
    expect(renderers, 'the proxy scheme <select> must live in exactly one file').toEqual([
      'views/ProxiesView.tsx',
    ]);
  });

  it('CRITICAL no proxy password field is type="password" — the owner set these visible on 2026-08-30', () => {
    const passwordInputs: { path: string; el: string }[] = [];
    for (const [path, src] of sourceFiles()) {
      for (const m of src.matchAll(INPUT_ELEMENT)) {
        if (BINDS_A_PROXY_PASSWORD.test(m[0]))
          passwordInputs.push({ path, el: withoutComments(m[0]) });
      }
    }
    // Non-vacuity: the detector must actually find the proxy password fields
    // (ProxyForm's SOCKS5 and OpenVPN ones), or the arm below proves nothing.
    expect(
      passwordInputs.length,
      'found no proxy password inputs — the detector matched nothing',
    ).toBeGreaterThanOrEqual(2);
    const masked = passwordInputs
      .filter(({ el }) => /type="password"/.test(el))
      .map(({ path }) => path);
    expect(masked, 'these proxy password fields are masked, but must be plain text').toEqual([]);
    // And they are affirmatively visible (type="text"), not merely un-masked by
    // omitting a type.
    const notText = passwordInputs
      .filter(({ el }) => !/type="text"/.test(el))
      .map(({ path }) => path);
    expect(notText, 'these proxy password fields are not explicitly type="text"').toEqual([]);
  });
});
