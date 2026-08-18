"""Error handling: catching the right Driftstack exceptions and retrying.

The SDK applies its built-in retry policy automatically, but customers
who want to drive retries themselves (or add observability) can catch
the typed errors and react. This example shows both: the default policy
(no extra code), and a custom catch-and-retry loop for a specific
operation.
"""

from __future__ import annotations

import os
import sys
import time

from driftstack import (
    AuthError,
    ConcurrencyLimitError,
    Driftstack,
    DriftstackError,
    QuotaExceededError,
    RateLimitError,
    ValidationError,
)


def main() -> int:
    api_key = os.environ.get("DRIFTSTACK_API_KEY")
    if not api_key:
        print("DRIFTSTACK_API_KEY required", file=sys.stderr)
        return 1

    with Driftstack(api_key=api_key) as client:
        # 1. The simple catch — granular subclasses for granular reactions.
        try:
            session = client.sessions.create()
        except AuthError:
            print("auth failed — your API key is invalid, expired, or revoked")
            return 2
        except ConcurrencyLimitError as e:
            print(f"hit the concurrent-session ceiling ({e.current_sessions}/{e.limit})")
            return 3
        except QuotaExceededError as e:
            # V-815 — `record_type` carries the capped resource ("profile").
            # It read empty until the SDK was pointed at the key the server
            # actually sends, and "monthly" was wrong besides: the only producer
            # of this error is a profile COUNT cap, which no month resets.
            print(f"{e.record_type} quota exhausted ({e.current}/{e.limit})")
            return 4
        except ValidationError as e:
            print(f"request was malformed: {e.message}")
            return 5
        except DriftstackError as e:
            # Catch-all — every typed error is a DriftstackError subclass.
            print(f"unexpected driftstack error: {e}")
            return 6

        # 2. Custom retry loop for a specific operation. The SDK already
        #    retries TransportError + RateLimitError automatically per
        #    RetryConfig; this is just for the demo.
        for attempt in range(5):
            try:
                client.sessions.navigate(str(session.id), {"url": "https://example.com/"})
                break
            except RateLimitError as e:
                wait = e.retry_after_seconds or (2**attempt)
                print(f"rate limited; sleeping {wait}s before retry {attempt + 1}/5")
                time.sleep(wait)
        else:
            print("gave up after 5 retries")
            client.sessions.destroy(str(session.id))
            return 7

        client.sessions.destroy(str(session.id))
        return 0


if __name__ == "__main__":
    sys.exit(main())
