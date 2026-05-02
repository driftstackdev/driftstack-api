// Demonstrates catching every documented error class.

/* eslint-disable no-console */
import {
  ConcurrencyLimitError,
  Driftstack,
  DriftstackError,
  ExpiredKeyError,
  InvalidKeyError,
  NotFoundError,
  RateLimitError,
  RevokedKeyError,
  SessionDestroyedError,
  ValidationError,
} from '@driftstack/sdk';

const client = new Driftstack({ apiKey: process.env.DRIFTSTACK_API_KEY ?? 'ds_live_demo' });

async function tryCall(): Promise<void> {
  try {
    await client.sessions.navigate('ses_does-not-exist', {
      url: 'https://example.com',
      wait_until: 'load',
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      console.log('session not found:', err.detail);
    } else if (err instanceof SessionDestroyedError) {
      console.log('session was destroyed; create a new one and retry');
    } else if (err instanceof ConcurrencyLimitError) {
      console.log(`tier limit hit: ${err.currentSessions ?? '?'}/${err.limit ?? '?'} active`);
    } else if (err instanceof RateLimitError) {
      console.log(`rate limited; sleep ${err.retryAfterSeconds.toString()}s before retrying`);
    } else if (err instanceof ValidationError) {
      console.log('validation failed:', err.issues);
    } else if (err instanceof InvalidKeyError) {
      console.log('API key not recognised; check DRIFTSTACK_API_KEY');
    } else if (err instanceof RevokedKeyError) {
      console.log('API key was revoked; rotate to a new one');
    } else if (err instanceof ExpiredKeyError) {
      console.log('API key has expired; rotate to a new one');
    } else if (err instanceof DriftstackError) {
      console.log(`unhandled API error ${err.status.toString()}: ${err.title}`);
    } else {
      throw err;
    }
  }
}

void tryCall();
