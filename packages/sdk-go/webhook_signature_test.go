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
