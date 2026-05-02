package driftstack

import (
	"context"
	"errors"
	"math/rand"
	"time"
)

// RetryConfig tunes the exponential-backoff retry loop.
type RetryConfig struct {
	// MaxRetries is the number of additional attempts after the first
	// failure. 3 means up to 4 total tries.
	MaxRetries int
	// InitialDelay is the base for the exponential backoff. The actual
	// sleep is uniformly random in [0, InitialDelay * 2^attempt],
	// capped at MaxDelay.
	InitialDelay time.Duration
	// MaxDelay caps any single sleep — prevents pathological cases
	// from compounding past a sensible ceiling.
	MaxDelay time.Duration
	// BackoffMultiplier is the exponential-backoff base. Default 2.0.
	BackoffMultiplier float64
	// Disabled turns the retry loop off entirely.
	Disabled bool
}

// DefaultRetry returns the policy used when the caller doesn't pass
// one. Matches the TS + Python SDKs: 3 retries, 200ms-10s window.
func DefaultRetry() RetryConfig {
	return RetryConfig{
		MaxRetries:        3,
		InitialDelay:      200 * time.Millisecond,
		MaxDelay:          10 * time.Second,
		BackoffMultiplier: 2.0,
	}
}

// withRetry runs fn with retries per cfg. Retries TransportError +
// RateLimitError; every other typed Driftstack error propagates
// immediately. Honours Retry-After when the error is a RateLimitError.
//
// ctx cancellation aborts the retry loop between attempts —
// long-running attempts are cancelled by the inner fn.
func withRetry(ctx context.Context, cfg RetryConfig, fn func() error) error {
	if cfg.Disabled {
		return fn()
	}

	bm := cfg.BackoffMultiplier
	if bm <= 0 {
		bm = 2.0
	}

	for attempt := 0; ; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}
		if !isRetryable(err) {
			return err
		}
		if attempt >= cfg.MaxRetries {
			return err
		}

		sleep := nextDelay(cfg, bm, attempt, retryAfterFromErr(err))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(sleep):
		}
	}
}

// isRetryable returns true for transient errors that the loop should
// re-attempt. Other typed Driftstack errors are treated as terminal.
func isRetryable(err error) bool {
	var t *TransportError
	if errors.As(err, &t) {
		return true
	}
	var r *RateLimitError
	return errors.As(err, &r)
}

func retryAfterFromErr(err error) time.Duration {
	var r *RateLimitError
	if errors.As(err, &r) && r.RetryAfterSeconds > 0 {
		return time.Duration(r.RetryAfterSeconds) * time.Second
	}
	return 0
}

func nextDelay(cfg RetryConfig, bm float64, attempt int, retryAfter time.Duration) time.Duration {
	if retryAfter > 0 {
		if retryAfter > cfg.MaxDelay {
			return cfg.MaxDelay
		}
		return retryAfter
	}
	// Exponential backoff with full jitter: rand(0, base * bm^attempt),
	// capped at MaxDelay.
	pow := 1.0
	for i := 0; i < attempt; i++ {
		pow *= bm
	}
	cap := time.Duration(float64(cfg.InitialDelay) * pow)
	if cap > cfg.MaxDelay {
		cap = cfg.MaxDelay
	}
	if cap <= 0 {
		return 0
	}
	// Use rand.Int63n with crypto-safe-enough seed; jitter doesn't
	// need crypto-grade randomness.
	return time.Duration(rand.Int63n(int64(cap)))
}
