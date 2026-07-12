import { describe, expect, it } from 'vitest';
import { friendlySettingsActionError } from '../../src/lib/settings-error-copy';

describe('friendlySettingsActionError', () => {
  it('maps permission failures without exposing a raw HTTP response', () => {
    const err = Object.assign(new Error('HTTP 403: forbidden scope account:write'), {
      status: 403,
    });
    const copy = friendlySettingsActionError(err, 'save-ai-billing');
    expect(copy).toContain('does not have permission');
    expect(copy).not.toMatch(/403|scope|HTTP/i);
  });

  it('turns provider authentication jargon into a key-specific correction', () => {
    const copy = friendlySettingsActionError(
      new Error('authentication_error: invalid x-api-key'),
      'test-provider-key',
    );
    expect(copy).toBe('Anthropic did not accept that key. Check the key, then try again.');
    expect(copy).not.toContain('authentication_error');
  });

  it('maps transport failures to an actionable connection message', () => {
    const copy = friendlySettingsActionError(new TypeError('Failed to fetch'), 'save-provider-key');
    expect(copy).toContain('check your connection');
    expect(copy).not.toContain('Failed to fetch');
  });

  it('uses action-specific safe copy for an unknown failure', () => {
    expect(
      friendlySettingsActionError(new Error('-1004 socket exploded'), 'clear-provider-key'),
    ).toBe("Couldn't clear your Anthropic key — please try again.");
  });
});
