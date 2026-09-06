// T-2 — "do not confuse a customer that they could add a local proxy and later
// find out it doesn't work" (owner).
//
// The advice was written, was correct, and was rendered at ONE of the five places
// a proxy host can be typed. The first-run wizard and both profile modals showed
// nothing — and the wizard's host field offered `127.0.0.1` as its PLACEHOLDER,
// which suggests the single configuration that can never work, because profiles
// run on Driftstack's servers and cannot reach the customer's own machine.
//
// ⛔ THE HAND-LISTED VERSION OF THIS TEST WOULD BE WORTHLESS. Naming today's four
// call sites pins today's four call sites; the defect was a FIFTH entry point
// nobody thought about. So the roster arm below DERIVES the set — every view that
// binds an input to a proxy host must also render the warning — and fails on a new
// entry point that forgets it, which is the failure that actually happened.

import { render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProxyHostWarning } from '../../src/components/ProxyHostWarning';
import { hostWarningFor } from '../../src/lib/proxies';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/** Every .tsx under src/views + src/components, as [path, source]. */
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

/** An EDITABLE proxy-host field: an `<input>` element that binds `value={x.host}`.
 *
 *  ⛔ It has to be the input ELEMENT, not the file. The first version of this
 *  detector matched `value={....host}` anywhere in the source and flagged
 *  `ProxyChip.tsx`, whose `<DetailRow label="Host" value={proxy.host} />` is a
 *  read-only display row a customer cannot type into. Warning beside a value
 *  nobody can edit is noise, and a guard that cries wolf gets a filename
 *  exception added to it — which is how a derived roster decays into the
 *  hand-list it was written to avoid. */
const INPUT_ELEMENT = /<input\b[\s\S]*?\/>/g;
const BINDS_A_HOST = /value=\{[A-Za-z_$][\w$]*\.host\}/;
function takesAProxyHost(src: string): boolean {
  return [...src.matchAll(INPUT_ELEMENT)].some((m) => BINDS_A_HOST.test(m[0]));
}

describe('a local proxy is warned about everywhere it can be typed', () => {
  it('CRITICAL every view that takes a proxy host renders the warning', () => {
    const entryPoints = sourceFiles().filter(([, src]) => takesAProxyHost(src));
    // Control: if the detector matched nothing, the arm below would pass on an
    // empty set and this whole test would certify the opposite of its name.
    expect(
      entryPoints.length,
      'the host-input detector found no entry points',
    ).toBeGreaterThanOrEqual(3);
    // …and it DISCRIMINATES, rather than matching every file with a `.host` in it:
    // a read-only host row is not somewhere a customer can type a bad value.
    expect(
      entryPoints.map(([path]) => path),
      'a read-only host display is not an entry point',
    ).not.toContain('components/ProxyChip.tsx');
    const unwarned = entryPoints
      .filter(([, src]) => !src.includes('<ProxyHostWarning'))
      .map(([path]) => path);
    expect(unwarned, 'these take a proxy host and show no local-proxy advice').toEqual([]);
  });

  it('CRITICAL no host field offers a loopback or private address as its example', () => {
    // A placeholder reads as a suggestion. `127.0.0.1` was the wizard's, which is
    // worse than silence: it recommends the one host the servers cannot reach.
    const offenders: string[] = [];
    for (const [path, src] of sourceFiles()) {
      for (const m of src.matchAll(/placeholder="([^"]*)"/g)) {
        const value = m[1] ?? '';
        // Only the bare-host shape — "Host (e.g. proxy.example.com)" is fine, and
        // so is prose that happens to contain a dot.
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) && hostWarningFor(value) !== undefined) {
          offenders.push(`${path}: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('renders the advice for a loopback host', () => {
    render(<ProxyHostWarning host="127.0.0.1" />);
    expect(screen.getByRole('note').textContent).toMatch(/your own machine or private network/i);
  });

  it('renders the advice for a private-range host', () => {
    render(<ProxyHostWarning host="192.168.1.50" />);
    expect(screen.getByRole('note')).toBeTruthy();
  });

  it('VACUITY CONTROL — renders NOTHING for a reachable host', () => {
    // Proves the arms above measure the predicate rather than a component that
    // always renders. Without this, gutting `hostWarningFor` to `return WARNING`
    // would leave every arm above green.
    const { container } = render(<ProxyHostWarning host="proxy.example.com" />);
    expect(container.innerHTML).toBe('');
  });
});
