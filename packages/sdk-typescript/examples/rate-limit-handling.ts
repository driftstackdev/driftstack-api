// The SDK's default retry policy already honours 429 + Retry-After. This
// example shows how to opt OUT of automatic retries and handle 429 yourself
// (useful when you want jitter aligned with your own job scheduler, or when
// you want to surface RateLimitError to a queue).

/* eslint-disable no-console */
import { Driftstack, RateLimitError } from '@driftstack/sdk';

const client = new Driftstack({
  apiKey: process.env.DRIFTSTACK_API_KEY ?? 'ds_live_demo',
  retry: { maxAttempts: 0 }, // disable built-in retries
});

async function createWithCustomRetry(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const session = await client.sessions.create({ label: 'manual-retry' });
      console.log('created', session.id);
      await client.sessions.destroy(session.id);
      return;
    } catch (err) {
      if (err instanceof RateLimitError) {
        const wait = err.retryAfterSeconds * 1000;
        console.log(`rate limited; sleeping ${wait.toString()}ms`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      throw err;
    }
  }
  console.error('gave up after 5 attempts');
}

void createWithCustomRetry();
