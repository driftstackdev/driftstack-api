import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CookiesListSubscriber,
  createCookiesListStore,
} from '../../src/components/CookiesListSubscriber';

describe('CookiesListSubscriber', () => {
  it('updates the cookie pane snapshot without rerendering its simulator parent', () => {
    const store = createCookiesListStore();
    let parentRenders = 0;
    function SimulatorHost(): JSX.Element {
      parentRenders += 1;
      return (
        <CookiesListSubscriber store={store}>
          {(cookies) => <span data-testid="count">{cookies?.length ?? 0}</span>}
        </CookiesListSubscriber>
      );
    }

    render(<SimulatorHost />);
    act(() =>
      store.set([
        {
          name: 'session',
          value: 'sealed',
          domain: '.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
          expires: null,
        },
      ]),
    );
    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(parentRenders).toBe(1);
  });
});
