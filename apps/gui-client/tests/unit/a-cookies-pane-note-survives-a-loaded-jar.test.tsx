// A standing note must render even once the jar has loaded.
//
// The Cookies pane had the identical latch to the Network pane's: `cookiesNote`
// rendered ONLY in the `cookies === null` branch, and one successful poll flips
// that to an array permanently. So every message computed afterwards — credential
// expired, device not ready, transient failure — was stored and never shown.
//
// ⛔ The carve-out at the poll site proves it was not theoretical: it read
// `hasCookiesRef.current && !credsExpired ? null : note`, written specifically to
// keep the expired-credential note actionable while suppressing noise once a jar
// had loaded. Since the note could only render while the jar was null, the branch
// it protected could fire only in the exact state where nothing was displayable.
//
// Found by sweeping for the Network pane's defect elsewhere rather than waiting
// for this one to be reported — it had not latched yet only because the Cookies
// pane does not get a successful poll on every session.

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CookiesPane } from '../../src/views/SimulatorWindow';

const AUTH = { kind: 'account' as const, token: 't' } as never;

function renderPane(cookies: unknown, note: string | null) {
  return render(
    <CookiesPane
      cookies={cookies as never}
      cookiesNote={note}
      refreshing={false}
      sessionId="agt_x"
      controlAuth={AUTH}
    />,
  );
}

describe('the Cookies pane note survives a loaded jar', () => {
  it('CRITICAL a note renders WITH a loaded jar — it used to be unreachable', () => {
    const { container, queryByText } = renderPane(
      [{ domain: 'example.com', name: 'sid', value: 'abc' }],
      'Session control credential expired — reopen the session to refresh.',
    );
    expect(container.querySelector('[data-component="simulator-cookies-note"]')).not.toBeNull();
    expect(queryByText(/credential expired/)).not.toBeNull();
  });

  it('CRITICAL a note renders with an EMPTY-but-loaded jar too', () => {
    // [] is the state one successful poll produces, and the one the latch keyed on.
    const { container } = renderPane([], "couldn't load cookies — retrying");
    expect(container.querySelector('[data-component="simulator-cookies-note"]')).not.toBeNull();
  });

  it('no note, no strip — the fix does not add empty chrome', () => {
    // Control: without this the arms above would pass against a pane that always
    // renders the container regardless of whether there is anything to say.
    const { container } = renderPane([{ domain: 'a.com', name: 'n', value: 'v' }], null);
    expect(container.querySelector('[data-component="simulator-cookies-note"]')).toBeNull();
  });

  it('the null-jar branch still shows its note, unchanged', () => {
    const { queryByText } = renderPane(null, 'waiting for the device…');
    expect(queryByText(/waiting for the device/)).not.toBeNull();
  });
});
