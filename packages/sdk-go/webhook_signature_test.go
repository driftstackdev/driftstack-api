package driftstack

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"testing"
	"time"
)

func sign(body []byte, secret string, ts int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10)))
	mac.Write([]byte("."))
	mac.Write(body)
	return "t=" + strconv.FormatInt(ts, 10) + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func TestVerifyWebhookSignature_RoundTrip(t *testing.T) {
	t.Parallel()
	body := []byte(`{"id":"evt-1","type":"session.completed","data":{}}`)
	secret := "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	now := time.Now()
	header := sign(body, secret, now.Unix())
	if !VerifyWebhookSignature(body, header, secret, VerifyWebhookOptions{Now: now}) {
		t.Fatal("expected valid signature to verify")
	}
}

func TestVerifyWebhookSignature_TamperedBody(t *testing.T) {
	t.Parallel()
	body := []byte(`{"id":"evt-1"}`)
	secret := "whsec_xx"
	now := time.Now()
	header := sign(body, secret, now.Unix())
	if VerifyWebhookSignature([]byte(`{"id":"tampered"}`), header, secret, VerifyWebhookOptions{Now: now}) {
		t.Fatal("expected tampered body to fail verification")
	}
}

func TestVerifyWebhookSignature_WrongSecret(t *testing.T) {
	t.Parallel()
	body := []byte("hello")
	now := time.Now()
	header := sign(body, "whsec_correct", now.Unix())
	if VerifyWebhookSignature(body, header, "whsec_wrong", VerifyWebhookOptions{Now: now}) {
		t.Fatal("expected wrong secret to fail")
	}
}

func TestVerifyWebhookSignature_OldTimestamp(t *testing.T) {
	t.Parallel()
	body := []byte("x")
	secret := "whsec_xx"
	now := time.Now()
	tenMinAgo := now.Add(-10 * time.Minute)
	header := sign(body, secret, tenMinAgo.Unix())
	if VerifyWebhookSignature(body, header, secret, VerifyWebhookOptions{Now: now}) {
		t.Fatal("expected old timestamp to fail (default 5min tolerance)")
	}
}

func TestVerifyWebhookSignature_FutureTimestamp(t *testing.T) {
	t.Parallel()
	body := []byte("x")
	secret := "whsec_xx"
	now := time.Now()
	farFuture := now.Add(10 * time.Minute)
	header := sign(body, secret, farFuture.Unix())
	if VerifyWebhookSignature(body, header, secret, VerifyWebhookOptions{Now: now}) {
		t.Fatal("expected future timestamp to fail")
	}
}

func TestVerifyWebhookSignature_FieldOrderIndependent(t *testing.T) {
	t.Parallel()
	body := []byte("x")
	secret := "whsec_xx"
	now := time.Now()
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(now.Unix(), 10)))
	mac.Write([]byte("."))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))

	forward := "t=" + strconv.FormatInt(now.Unix(), 10) + ",v1=" + sig
	reverse := "v1=" + sig + ",t=" + strconv.FormatInt(now.Unix(), 10)
	if !VerifyWebhookSignature(body, forward, secret, VerifyWebhookOptions{Now: now}) {
		t.Error("forward header order failed")
	}
	if !VerifyWebhookSignature(body, reverse, secret, VerifyWebhookOptions{Now: now}) {
		t.Error("reverse header order failed")
	}
}

func TestVerifyWebhookSignature_MalformedHeaders(t *testing.T) {
	t.Parallel()
	for _, h := range []string{
		"",
		"garbage",
		"t=abc,v1=zzz",
		"v1=onlysig",
		"t=123",
	} {
		if VerifyWebhookSignature([]byte("x"), h, "whsec_xx", VerifyWebhookOptions{Now: time.Unix(0, 0)}) {
			t.Errorf("expected malformed header %q to fail", h)
		}
	}
}

func TestVerifyWebhookSignature_CustomTolerance(t *testing.T) {
	t.Parallel()
	body := []byte("x")
	secret := "whsec_xx"
	now := time.Now()
	tenMinAgo := now.Add(-10 * time.Minute)
	header := sign(body, secret, tenMinAgo.Unix())
	// 15-minute tolerance accepts a 10-minute-old signature.
	if !VerifyWebhookSignature(body, header, secret, VerifyWebhookOptions{
		Now:       now,
		Tolerance: 15 * time.Minute,
	}) {
		t.Fatal("expected 10min-old signature to pass with 15min tolerance")
	}
}

// V-359 — rotation-grace: HeaderPrev allows acceptance during the 24h
// dual-sign window when the customer hasn't yet rolled the new secret
// across their verifier.
func TestVerifyWebhookSignature_V359_AcceptsPrevWhenOldSecret(t *testing.T) {
	t.Parallel()
	body := []byte(`{"event":"x"}`)
	now := time.Now()
	ts := now.Unix()
	newSecret := "whsec_new_rotated"
	oldSecret := "whsec_old_pre_rotation"
	header := sign(body, newSecret, ts)
	headerPrev := sign(body, oldSecret, ts)

	// Customer hasn't rolled forward — verifier still uses oldSecret.
	if !VerifyWebhookSignature(body, header, oldSecret, VerifyWebhookOptions{
		Now:        now,
		HeaderPrev: headerPrev,
	}) {
		t.Fatal("expected oldSecret + headerPrev to pass during grace")
	}
}

func TestVerifyWebhookSignature_V359_AcceptsCurrentWhenNewSecret(t *testing.T) {
	t.Parallel()
	body := []byte(`{"event":"x"}`)
	now := time.Now()
	ts := now.Unix()
	newSecret := "whsec_new_rotated"
	oldSecret := "whsec_old_pre_rotation"
	header := sign(body, newSecret, ts)
	headerPrev := sign(body, oldSecret, ts)

	// Customer rolled forward — verifier uses newSecret.
	if !VerifyWebhookSignature(body, header, newSecret, VerifyWebhookOptions{
		Now:        now,
		HeaderPrev: headerPrev,
	}) {
		t.Fatal("expected newSecret + current header to pass during grace")
	}
}

func TestVerifyWebhookSignature_V359_RejectsWhenNeitherMatches(t *testing.T) {
	t.Parallel()
	body := []byte("x")
	now := time.Now()
	ts := now.Unix()
	header := sign(body, "whsec_new_rotated", ts)
	headerPrev := sign(body, "whsec_old_pre_rotation", ts)

	if VerifyWebhookSignature(body, header, "whsec_unrelated", VerifyWebhookOptions{
		Now:        now,
		HeaderPrev: headerPrev,
	}) {
		t.Fatal("expected unrelated secret to reject both headers")
	}
}

func TestVerifyWebhookSignature_V359_HeaderPrevEmptyKeepsSingleHeaderBehavior(t *testing.T) {
	t.Parallel()
	body := []byte("x")
	now := time.Now()
	ts := now.Unix()
	secret := "whsec_xx"
	header := sign(body, secret, ts)

	if !VerifyWebhookSignature(body, header, secret, VerifyWebhookOptions{Now: now}) {
		t.Fatal("expected single-header verify to still work")
	}
}
