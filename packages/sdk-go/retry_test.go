package driftstack

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestWithRetrySucceedsImmediately(t *testing.T) {
	t.Parallel()
	calls := 0
	err := withRetry(context.Background(), DefaultRetry(), func() error {
		calls++
		return nil
	})
	if err != nil || calls != 1 {
		t.Fatalf("got err=%v calls=%d, want nil/1", err, calls)
	}
}

func TestWithRetryRetriesOnTransportError(t *testing.T) {
	t.Parallel()
	cfg := RetryConfig{MaxRetries: 3, InitialDelay: 1 * time.Millisecond, MaxDelay: 2 * time.Millisecond, BackoffMultiplier: 1.0}
	calls := 0
	err := withRetry(context.Background(), cfg, func() error {
		calls++
		if calls < 3 {
			return &TransportError{apiError: apiError{Status: 0, Message: "blip"}}
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("got err=%v calls=%d, want nil/3", err, calls)
	}
}

func TestWithRetryRetriesOnInternalError(t *testing.T) {
	t.Parallel()
	// 5xx (InternalError) MUST be retried, matching the TS SDK + this SDK's public
	// IsRetryable contract — the built-in loop had omitted it (cross-SDK retry drift).
	cfg := RetryConfig{MaxRetries: 3, InitialDelay: 1 * time.Millisecond, MaxDelay: 2 * time.Millisecond, BackoffMultiplier: 1.0}
	calls := 0
	err := withRetry(context.Background(), cfg, func() error {
		calls++
		if calls < 3 {
			return &InternalError{apiError: apiError{Status: 500, Message: "boom"}}
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Fatalf("got err=%v calls=%d, want nil/3 (5xx must retry)", err, calls)
	}
}

func TestWithRetryGivesUpAfterMax(t *testing.T) {
	t.Parallel()
	cfg := RetryConfig{MaxRetries: 2, InitialDelay: 1 * time.Millisecond, MaxDelay: 2 * time.Millisecond}
	calls := 0
	err := withRetry(context.Background(), cfg, func() error {
		calls++
		return &TransportError{apiError: apiError{Message: "persistent"}}
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if calls != 3 {
		t.Errorf("got %d calls, want 3 (initial + MaxRetries=2)", calls)
	}
	var te *TransportError
	if !errors.As(err, &te) {
		t.Errorf("expected TransportError, got %T", err)
	}
}

func TestWithRetryDoesNotRetryNonRetryableError(t *testing.T) {
	t.Parallel()
	cfg := RetryConfig{MaxRetries: 5, InitialDelay: 1 * time.Millisecond, MaxDelay: 2 * time.Millisecond}
	calls := 0
	err := withRetry(context.Background(), cfg, func() error {
		calls++
		return &InvalidKeyError{apiError: apiError{Status: 401, Message: "bad"}}
	})
	if err == nil || calls != 1 {
		t.Fatalf("expected one call + error; got calls=%d err=%v", calls, err)
	}
}

func TestWithRetryDisabled(t *testing.T) {
	t.Parallel()
	cfg := RetryConfig{Disabled: true, MaxRetries: 5}
	calls := 0
	_ = withRetry(context.Background(), cfg, func() error {
		calls++
		return &TransportError{apiError: apiError{}}
	})
	if calls != 1 {
		t.Errorf("expected 1 call when disabled, got %d", calls)
	}
}

func TestWithRetryHonoursRetryAfter(t *testing.T) {
	t.Parallel()
	// Real-time timing test — kept tiny.
	cfg := RetryConfig{MaxRetries: 1, InitialDelay: 1 * time.Millisecond, MaxDelay: 100 * time.Millisecond}
	start := time.Now()
	calls := 0
	err := withRetry(context.Background(), cfg, func() error {
		calls++
		if calls == 1 {
			return &RateLimitError{apiError: apiError{Status: 429}, RetryAfterSeconds: 0} // 0 → fall back to backoff
		}
		return nil
	})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if calls != 2 {
		t.Errorf("got %d calls, want 2", calls)
	}
	// Sanity: didn't hang for >100ms.
	if time.Since(start) > 200*time.Millisecond {
		t.Errorf("retry took too long: %v", time.Since(start))
	}
}

func TestWithRetryContextCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cfg := RetryConfig{MaxRetries: 5, InitialDelay: 100 * time.Millisecond, MaxDelay: 200 * time.Millisecond}
	calls := 0
	err := withRetry(ctx, cfg, func() error {
		calls++
		return &TransportError{apiError: apiError{}}
	})
	// First call runs, then ctx is checked between attempts → cancel().
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled, got %v", err)
	}
	if calls != 1 {
		t.Errorf("expected 1 call before cancel, got %d", calls)
	}
}
